/**
 * #8303: the New Session browsability probe and the REAL `usePathAutocomplete`
 * run side by side. Both used the one `_directoryListingCallback` slot, so the
 * probe (sent 300 ms after a keystroke) replaced autocomplete's callback (200 ms)
 * and dropped its slow reply, and a probe reply fed autocomplete's handler, which
 * wipes its suggestions on any error. The probe now correlates by request id and
 * never touches the slot. The store here is a faithful stand-in: the slot is one
 * variable, the id registry and routing are the real ones.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import {
  registerDirectoryListingRequest,
  routeDirectoryListing,
  clearDirectoryListingRequests,
} from '../store/directory-listing-requests'

const TUI_PROVIDER = { name: 'claude-tui', capabilities: {}, auth: { ready: true, source: 'static', detail: '' } }

type Listing = { path: string | null; parentPath: string | null; entries: unknown[]; error: string | null }
let sent: Array<{ path: string; id: string | null }> = []
let slot: ((l: Listing) => void) | null = null

const stableSetSlot = (cb: ((l: Listing) => void) | null) => { slot = cb }
const stableRequest = (path?: string) => { sent.push({ path: path ?? '', id: null }) }
const stableRequestFor = (path: string, id: string, cb: (l: Listing) => void) => {
  sent.push({ path, id })
  return registerDirectoryListingRequest(id, cb as never)
}

function mockStore() {
  vi.doMock('../store/connection', () => ({
    useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        defaultProvider: 'claude-tui',
        defaultModel: null,
        availableProviders: [TUI_PROVIDER],
        permissionModesByProvider: {},
        environments: [],
        requestDirectoryListing: stableRequest,
        setDirectoryListingCallback: stableSetSlot,
        requestDirectoryListingFor: stableRequestFor,
        defaultCwd: null,
      }),
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  slot = null
  clearDirectoryListingRequests()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetModules()
  vi.doUnmock('../store/connection')
})

const DENIED = 'Access denied: directory listing is restricted to the home directory'

function deliver(requestId: string | null, listing: Partial<Listing>) {
  act(() => {
    routeDirectoryListing(requestId, { path: null, parentPath: null, entries: [], error: null, ...listing } as never, slot as never)
  })
}

async function openWithTypedCwd(value: string) {
  mockStore()
  const { CreateSessionModal } = await import('./CreateSessionModal')
  render(<CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} knownCwds={[]} existingNames={[]} />)
  fireEvent.change(screen.getByLabelText(/working directory/i), { target: { value } })
}

const options = () => screen.queryAllByRole('option').map((o) => o.textContent)

describe('probe alongside real path autocomplete (#8303)', () => {
  it('autocomplete\'s slow reply, arriving after the probe was sent, still fills the suggestions', async () => {
    await openWithTypedCwd('/home/me/pr')
    await act(async () => { vi.advanceTimersByTime(250) })
    expect(sent.map((r) => r.id)).toEqual([null]) // autocomplete asked first (200 ms)
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(sent.map((r) => r.id !== null)).toEqual([false, true]) // then the probe (300 ms)
    // the tunnel is slow: autocomplete's reply lands only now
    deliver(null, { path: '/home/me', entries: [{ name: 'proj', isDirectory: true }, { name: 'other', isDirectory: true }] })
    expect(options().join(' ')).toMatch(/proj/)
    expect(options().join(' ')).not.toMatch(/other/) // filtered by the typed prefix
  })

  it('a probe reply that is an error does not clear the suggestions autocomplete filled', async () => {
    await openWithTypedCwd('/home/me/pr')
    await act(async () => { vi.advanceTimersByTime(400) })
    deliver(null, { path: '/home/me', entries: [{ name: 'proj', isDirectory: true }] })
    expect(options().join(' ')).toMatch(/proj/)
    const probe = sent.find((r) => r.id !== null)!
    deliver(probe.id, { path: '/home/me/pr', error: DENIED })
    expect(options().join(' ')).toMatch(/proj/) // autocomplete untouched
    expect(screen.queryByTestId('cwd-not-browsable')).not.toBeNull() // and the note is shown
  })

  it('for a ~ input the probe cannot take autocomplete\'s reply as its answer', async () => {
    await openWithTypedCwd('~/pr')
    await act(async () => { vi.advanceTimersByTime(400) })
    deliver(null, { path: '/home/me', error: DENIED }) // autocomplete's reply, untagged
    expect(screen.queryByTestId('cwd-not-browsable')).toBeNull()
  })
})
