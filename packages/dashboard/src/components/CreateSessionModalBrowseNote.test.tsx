/**
 * #8303: the New Session dialog asks the daemon (`list_directory` with a request
 * id, answered only to that request) whether a typed or prefilled directory can
 * be listed, and shows a one-line informational note only on an explicit
 * "Access denied" refusal for the CURRENT cwd. It never blocks Create, and it
 * never touches the shared listing slot that autocomplete and the picker use.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import {
  registerDirectoryListingRequest,
  routeDirectoryListing,
  pendingDirectoryListingRequestCount,
  clearDirectoryListingRequests,
} from '../store/directory-listing-requests'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const TUI_PROVIDER = { name: 'claude-tui', capabilities: {}, auth: { ready: true, source: 'static', detail: '' } }

type Listing = { path: string | null; parentPath: string | null; entries: unknown[]; error: string | null }
let requests: Array<{ path: string; id: string }> = []
let slot: ((l: Listing) => void) | null = null
let slotWrites = 0
let sharedSlotReceived: Listing[] = []

function mockStore() {
  vi.doMock('../store/connection', () => ({
    useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        defaultProvider: 'claude-tui',
        defaultModel: null,
        availableProviders: [TUI_PROVIDER],
        permissionModesByProvider: {},
        environments: [],
        requestDirectoryListing: () => {},
        setDirectoryListingCallback: (cb: ((l: Listing) => void) | null) => { if (cb) slotWrites += 1; slot = cb },
        // the real registry, as the store's requestDirectoryListingFor uses it
        requestDirectoryListingFor: (path: string, id: string, cb: (l: Listing) => void) => {
          requests.push({ path, id })
          return registerDirectoryListingRequest(id, cb as never)
        },
        defaultCwd: null,
      }),
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  requests = []
  slot = null
  slotWrites = 0
  sharedSlotReceived = []
  clearDirectoryListingRequests()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetModules()
  vi.doUnmock('../store/connection')
})

const baseProps = {
  open: true,
  onClose: vi.fn(),
  onCreate: vi.fn(),
  knownCwds: [] as string[],
  existingNames: [] as string[],
}

async function loadModal() {
  const mod = await import('./CreateSessionModal')
  return mod.CreateSessionModal
}

function typeCwd(value: string) {
  fireEvent.change(screen.getByLabelText(/working directory/i), { target: { value } })
}

async function settle() {
  await act(async () => { vi.advanceTimersByTime(400) })
}

const DENIED = 'Access denied: directory listing is restricted to the home directory'

/** Deliver a reply the way the store's message handler does. */
function deliver(requestId: string | null, over: Partial<Listing> = {}) {
  act(() => {
    routeDirectoryListing(
      requestId,
      { path: null, parentPath: null, entries: [], error: null, ...over } as never,
      ((l: Listing) => { sharedSlotReceived.push(l) }) as never,
    )
  })
}
const lastId = () => requests[requests.length - 1]!.id
const note = () => screen.queryByTestId('cwd-not-browsable')

describe('CreateSessionModal: not-browsable note (#8303)', () => {
  it('shows the note when the daemon refuses to list the directory', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    expect(note()).toBeNull()
    await settle()
    expect(requests).toEqual([{ path: '/tmp/outside', id: expect.any(String) }])
    deliver(lastId(), { path: '/tmp/outside', error: DENIED })
    expect(note()).not.toBeNull()
    expect(note()!.textContent).toMatch(/Browse can't list this directory/)
    expect(note()!.textContent).toMatch(/any workspace roots/)
  })

  it('does not show the note when the directory is listable', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/home/me/proj')
    await settle()
    deliver(lastId(), { path: '/home/me/proj' })
    expect(note()).toBeNull()
  })

  it('says nothing for "not found", other errors, or no reply', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/home/me/new')
    await settle()
    expect(note()).toBeNull() // no reply yet
    deliver(lastId(), { path: '/home/me/new', error: 'Directory not found' })
    expect(note()).toBeNull()
  })

  it('shows the note for a `..` input: matching is by request id, not path text', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/home/me/link/../x')
    await settle()
    // the daemon reports a different path text; the id is what correlates
    deliver(lastId(), { path: '/somewhere/else', error: DENIED })
    expect(note()).not.toBeNull()
  })

  it('a reply for a superseded request never lands, and does not resurface when the cwd returns', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/a')
    await settle()
    const oldId = lastId()
    typeCwd('/tmp/b') // supersedes /tmp/a: its registration is cancelled
    deliver(oldId, { path: '/tmp/a', error: DENIED })
    typeCwd('/tmp/a') // back to the refused path, no new reply yet
    expect(note()).toBeNull()
  })

  it('a reply carrying an id this dialog did not send is ignored', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/current')
    await settle()
    deliver('someone-elses-id', { path: '/tmp/current', error: DENIED })
    expect(note()).toBeNull()
  })

  it('an older daemon does not echo the id: its untagged reply goes to the shared slot, never to the probe', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    await settle()
    deliver(null, { path: '/tmp/outside', error: DENIED })
    expect(note()).toBeNull()
    expect(sharedSlotReceived).toHaveLength(1)
    expect(pendingDirectoryListingRequestCount()).toBe(1) // still waiting, harmlessly
  })

  it('never touches the shared listing slot', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    await settle()
    deliver(lastId(), { path: '/tmp/outside', error: DENIED })
    expect(slotWrites).toBe(0)
    expect(slot).toBeNull()
    expect(sharedSlotReceived).toHaveLength(0)
  })

  it('clears the note once the cwd changes to a path with no refusal', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    await settle()
    deliver(lastId(), { path: '/tmp/outside', error: DENIED })
    expect(note()).not.toBeNull()
    typeCwd('/home/me/proj')
    expect(note()).toBeNull()
  })

  it('sends one request for rapid typing (the earlier edit is debounced away)', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/a')
    await act(async () => { vi.advanceTimersByTime(100) })
    typeCwd('/tmp/ab')
    await settle()
    expect(requests.map((r) => r.path)).toEqual(['/tmp/ab'])
  })

  it('keeps no registration behind: consumed by its reply, dropped on cwd change, on close and on unmount', async () => {
    mockStore()
    const Modal = await loadModal()
    const { rerender, unmount } = render(<Modal {...baseProps} />)
    typeCwd('/tmp/a')
    await settle()
    expect(pendingDirectoryListingRequestCount()).toBe(1)
    deliver(lastId(), { path: '/tmp/a', error: DENIED })
    expect(pendingDirectoryListingRequestCount()).toBe(0) // consumed by its reply
    typeCwd('/tmp/b')
    await settle()
    expect(pendingDirectoryListingRequestCount()).toBe(1)
    typeCwd('/tmp/c') // cancels /tmp/b's registration before /tmp/c is sent
    expect(pendingDirectoryListingRequestCount()).toBe(0)
    await settle()
    expect(pendingDirectoryListingRequestCount()).toBe(1)
    rerender(<Modal {...baseProps} open={false} />) // dialog closed
    expect(pendingDirectoryListingRequestCount()).toBe(0)
    rerender(<Modal {...baseProps} open />)
    typeCwd('/tmp/d')
    await settle()
    expect(pendingDirectoryListingRequestCount()).toBe(1)
    unmount()
    expect(pendingDirectoryListingRequestCount()).toBe(0)
  })

  it('a reply arriving after the dialog unmounts is harmless', async () => {
    mockStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Modal = await loadModal()
    const { unmount } = render(<Modal {...baseProps} />)
    typeCwd('/tmp/a')
    await settle()
    const id = lastId()
    unmount()
    expect(() => deliver(id, { path: '/tmp/a', error: DENIED })).not.toThrow()
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('never blocks Create: the button stays enabled and submits', async () => {
    mockStore()
    const onCreate = vi.fn()
    const Modal = await loadModal()
    render(<Modal {...baseProps} onCreate={onCreate} />)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'outside' } })
    typeCwd('/tmp/outside')
    await settle()
    deliver(lastId(), { path: '/tmp/outside', error: DENIED })
    expect(note()).not.toBeNull()
    const create = screen.getByRole('button', { name: /^create/i }) as HTMLButtonElement
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ cwd: '/tmp/outside' })
  })

  it('renders below the "New directory" hint and not as a .cwd-hint (which pulls itself up 6px and overlapped it)', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    await settle()
    deliver(lastId(), { path: '/tmp/outside', error: DENIED })
    const hint = screen.getByText(/New directory/)
    const n = note()!
    expect(n.classList.contains('cwd-hint')).toBe(false)
    expect(n.classList.contains('cwd-browse-note')).toBe(true)
    expect(hint.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
