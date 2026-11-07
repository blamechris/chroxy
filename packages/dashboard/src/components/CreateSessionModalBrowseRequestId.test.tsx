/**
 * #9065: the Browse picker routes `list_directory` replies by the echoed request
 * id (with a daemon that advertises `directoryListingRequestIdV1`) instead of
 * comparing the reply's `path` with the requested one. The server answers with
 * the RESOLVED directory, so a path such as `/home/u/proj/..` came back as
 * `/home/u` and the old comparison dropped it, leaving "Loading..." forever.
 * Without the capability the path-matching fallback is unchanged.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import {
  registerDirectoryListingRequest,
  routeDirectoryListing,
  pendingDirectoryListingRequestCount,
  clearDirectoryListingRequests,
} from '../store/directory-listing-requests'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

type Listing = { path: string | null; parentPath: string | null; entries: unknown[]; error: string | null }
let sent: Array<{ path: string; id: string }> = []
let legacyRequests: string[] = []
let slot: ((l: Listing) => void) | null = null
let capable = true

function mockStore() {
  vi.doMock('../store/connection', () => ({
    useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        defaultProvider: 'claude-sdk',
        availableProviders: [],
        serverCapabilities: capable ? { directoryListingRequestIdV1: true } : {},
        requestDirectoryListing: (p: string) => { legacyRequests.push(p) },
        setDirectoryListingCallback: (cb: ((l: Listing) => void) | null) => { slot = cb },
        requestDirectoryListingFor: (path: string, id: string, cb: (l: Listing) => void) => {
          sent.push({ path, id })
          return registerDirectoryListingRequest(id, cb as never)
        },
        defaultCwd: null,
      }),
  }))
}

beforeEach(() => {
  sent = []
  legacyRequests = []
  slot = null
  capable = true
  clearDirectoryListingRequests()
})

afterEach(() => {
  cleanup()
  vi.resetModules()
  vi.doUnmock('../store/connection')
})

async function openBrowse(initialCwd: string) {
  mockStore()
  const { CreateSessionModal } = await import('./CreateSessionModal')
  render(
    <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} initialCwd={initialCwd} knownCwds={[]} existingNames={[]} />,
  )
  fireEvent.click(screen.getByText('Browse...'))
}

function reply(id: string | null, listing: Partial<Listing>) {
  act(() => {
    routeDirectoryListing(id, { path: null, parentPath: null, entries: [], error: null, ...listing } as never, slot as never)
  })
}

const dir = (name: string) => ({ name, isDirectory: true })

describe('Browse picker request-id routing (#9065)', () => {
  it('lists the resolved directory for a requested path ending in ..', async () => {
    await openBrowse('/home/u/proj/..')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.path).toBe('/home/u/proj/..')
    expect(screen.getByText(/loading/i)).toBeInTheDocument()

    reply(sent[0]!.id, { path: '/home/u', parentPath: '/home', entries: [dir('alpha')] })

    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
    expect(screen.getByText('alpha')).toBeInTheDocument()
  })

  it('shows an error reply whose path differs, instead of Loading', async () => {
    await openBrowse('/home/u/nope/..')
    reply(sent[0]!.id, { path: '/home/u', entries: [], error: 'Access denied' })
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
    expect(screen.getByText(/access denied/i)).toBeInTheDocument()
  })

  it('ignores a reply for an earlier request after navigating', async () => {
    await openBrowse('/home/u/proj')
    const first = sent[0]!
    // navigate away (breadcrumb) while the first request is still unanswered
    fireEvent.click(screen.getByText('u'))
    expect(sent).toHaveLength(2)
    const second = sent[1]!
    expect(second.path).toBe('/home/u')

    // A late reply to the first request is not routed anywhere
    reply(first.id, { path: '/home/u/proj', entries: [dir('stale-entry')] })
    expect(screen.queryByText('stale-entry')).not.toBeInTheDocument()
    expect(screen.getByText(/loading/i)).toBeInTheDocument()

    reply(second.id, { path: '/home/u', entries: [dir('proj')] })
    expect(screen.getByText('proj')).toBeInTheDocument()
    fireEvent.click(screen.getByText('proj'))
    expect(sent[2]!.path).toBe('/home/u/proj')
  })

  it('does not take an untagged reply (autocomplete / older daemon) as its own', async () => {
    await openBrowse('/home/u')
    reply(null, { path: '/home/u', entries: [dir('untagged')] })
    expect(screen.queryByText('untagged')).not.toBeInTheDocument()
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('cancel drops the registration, so a reply after reopen has nowhere to go', async () => {
    await openBrowse('/home/u')
    const first = sent[0]!
    expect(pendingDirectoryListingRequestCount()).toBeGreaterThan(0)
    fireEvent.click(screen.getByLabelText('Cancel'))
    expect(pendingDirectoryListingRequestCount()).toBe(0)
    fireEvent.click(screen.getByText('Browse...'))
    reply(first.id, { path: '/home/u', entries: [dir('ghost')] })
    expect(screen.queryByText('ghost')).not.toBeInTheDocument()
  })

  it('up-navigation sends a fresh request and applies its reply', async () => {
    await openBrowse('/home/u/proj')
    reply(sent[0]!.id, { path: '/home/u/proj', parentPath: '/home/u', entries: [dir('src')] })
    fireEvent.click(screen.getByText('u'))
    expect(sent).toHaveLength(2)
    expect(sent[1]!.path).toBe('/home/u')
    reply(sent[1]!.id, { path: '/home/u', parentPath: '/home', entries: [dir('proj')] })
    expect(screen.getByText('proj')).toBeInTheDocument()
  })

  it('Select drops the registration', async () => {
    await openBrowse('/home/u')
    expect(pendingDirectoryListingRequestCount()).toBe(1)
    fireEvent.click(screen.getByLabelText('Select'))
    expect(pendingDirectoryListingRequestCount()).toBe(0)
  })

  it('unmounting while a request is pending drops the registration', async () => {
    mockStore()
    const { CreateSessionModal } = await import('./CreateSessionModal')
    const view = render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} initialCwd="/home/u" knownCwds={[]} existingNames={[]} />,
    )
    fireEvent.click(screen.getByText('Browse...'))
    expect(pendingDirectoryListingRequestCount()).toBe(1)
    view.unmount()
    expect(pendingDirectoryListingRequestCount()).toBe(0)
  })

  it('closing the modal while browsing drops the registration', async () => {
    mockStore()
    const { CreateSessionModal } = await import('./CreateSessionModal')
    const props = { onClose: vi.fn(), onCreate: vi.fn(), initialCwd: '/home/u', knownCwds: [], existingNames: [] }
    const view = render(<CreateSessionModal open {...props} />)
    fireEvent.click(screen.getByText('Browse...'))
    expect(pendingDirectoryListingRequestCount()).toBe(1)
    view.rerender(<CreateSessionModal open={false} {...props} />)
    view.rerender(<CreateSessionModal open {...props} />)
    expect(pendingDirectoryListingRequestCount()).toBe(0)
  })

  it('without the capability keeps the path-matching callback', async () => {
    capable = false
    await openBrowse('/home/u')
    expect(sent).toHaveLength(0)
    expect(legacyRequests).toEqual(['/home/u'])
    act(() => { slot!({ path: '/elsewhere', parentPath: null, entries: [dir('wrong')], error: null } as never) })
    expect(screen.queryByText('wrong')).not.toBeInTheDocument()
    act(() => { slot!({ path: '/home/u', parentPath: null, entries: [dir('right')], error: null } as never) })
    expect(screen.getByText('right')).toBeInTheDocument()
  })
})
