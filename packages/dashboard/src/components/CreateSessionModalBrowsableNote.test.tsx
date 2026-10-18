/**
 * Issue 8303 — New Session used to prefill a working directory that Browse
 * could not open (outside $HOME and every workspace root) and said nothing.
 * The modal now probes the prefilled directory with a directory listing when it
 * opens and, on an access-denied answer, shows a one-line note.
 *
 * The REAL usePathAutocomplete hook is used on purpose: it shares the store's
 * single directory-listing callback slot with the probe and takes it over after
 * its 200 ms debounce, so a probe reply slower than that (normal over a tunnel)
 * must still reach the modal. The store double below delivers a reply the way
 * the real message handler does: to every registered listener, then to whoever
 * holds the single slot.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

type Listing = Record<string, unknown>
let slot: ((listing: Listing) => void) | null = null
const listeners = new Set<(listing: Listing) => void>()
const mockRequestDirectoryListing = vi.fn()
const mockSetDirectoryListingCallback = vi.fn((cb: unknown) => {
  slot = cb as typeof slot
})
const mockAddDirectoryListingListener = vi.fn((cb: (listing: Listing) => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
})

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      defaultProvider: 'claude-sdk',
      availableProviders: [],
      requestDirectoryListing: mockRequestDirectoryListing,
      setDirectoryListingCallback: mockSetDirectoryListingCallback,
      addDirectoryListingListener: mockAddDirectoryListingListener,
      defaultCwd: null,
    }),
}))

import { CreateSessionModal, type CreateSessionModalProps } from './CreateSessionModal'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  slot = null
  listeners.clear()
  mockRequestDirectoryListing.mockClear()
  mockSetDirectoryListingCallback.mockClear()
  mockAddDirectoryListingListener.mockClear()
})

function renderModal(props: Partial<CreateSessionModalProps> = {}) {
  const base: CreateSessionModalProps = {
    open: true,
    onClose: vi.fn(),
    onCreate: vi.fn(),
    initialCwd: '/srv/outside',
    knownCwds: [],
    existingNames: [],
  }
  const ui = (p: Partial<CreateSessionModalProps>) => <CreateSessionModal {...base} {...props} {...p} />
  const result = render(ui({}))
  return { ...result, rerenderWith: (p: Partial<CreateSessionModalProps>) => result.rerender(ui(p)) }
}

/** Deliver a reply the way the store's message handler does. */
function deliver(listing: Listing) {
  act(() => {
    for (const l of [...listeners]) l(listing)
    slot?.(listing)
  })
}

const DENIED =
  'Access denied: directory listing is restricted to the home directory and configured workspace roots'
const NOTE = /outside the browsable roots/i

describe('CreateSessionModal: prefilled cwd that Browse cannot open (issue 8303)', () => {
  it('probes the prefilled directory itself when the modal opens', () => {
    renderModal()
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/srv/outside')
  })

  it('shows a one-line note when the probe is refused with Access denied', () => {
    renderModal()
    deliver({ path: '/srv/outside', parentPath: null, entries: [], error: DENIED })
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })

  it('still shows the note when the reply arrives after the autocomplete debounce took over the callback slot', () => {
    renderModal()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    // Autocomplete has now requested the PARENT and replaced the single slot.
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/srv')
    deliver({ path: '/srv/outside', parentPath: null, entries: [], error: DENIED })
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })

  it('shows no note when the prefilled directory lists fine', () => {
    renderModal()
    deliver({ path: '/srv/outside', parentPath: '/srv', entries: [], error: null })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('shows no note for an error that is not an access denial (a missing directory is a different problem)', () => {
    renderModal()
    deliver({ path: '/srv/outside', parentPath: null, entries: [], error: 'Directory not found' })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('ignores a denial for some other path (a stale or autocomplete reply)', () => {
    renderModal()
    deliver({ path: '/srv', parentPath: null, entries: [], error: DENIED })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('treats a trailing slash or backslash as the same directory (Windows paths)', () => {
    renderModal({ initialCwd: 'C:\\repo\\' })
    deliver({ path: 'C:\\repo', parentPath: null, entries: [], error: DENIED })
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })

  it('a reply with no path sets no note', () => {
    renderModal()
    deliver({ parentPath: null, entries: [], error: DENIED })
    deliver({ path: '', parentPath: null, entries: [], error: DENIED })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('does not treat a trailing backslash as a separator on a POSIX path', () => {
    renderModal({ initialCwd: '/srv/project\\' })
    deliver({ path: '/srv/project', parentPath: null, entries: [], error: DENIED })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('does not treat a reply with a trailing backslash as the same POSIX directory either', () => {
    renderModal({ initialCwd: '/srv/project' })
    deliver({ path: '/srv/project\\', parentPath: null, entries: [], error: DENIED })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it.each([
    ['a path with .. segments', '/srv/root/../outside'],
    ['a relative path', 'rel/dir'],
    ['a Windows path with .. segments', 'C:\\repo\\..\\other'],
  ])('does not probe %s, so no listener is left waiting', (_label, cwd) => {
    renderModal({ initialCwd: cwd })
    expect(mockRequestDirectoryListing).not.toHaveBeenCalledWith(cwd)
    expect(listeners.size).toBe(0)
  })

  it('still probes an absolute Windows path', () => {
    renderModal({ initialCwd: 'C:\\repo' })
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('C:\\repo')
  })

  it('does not probe a ~ path, and a stray denial cannot set the note for it', () => {
    renderModal({ initialCwd: '~/proj' })
    expect(mockRequestDirectoryListing).not.toHaveBeenCalledWith('~/proj')
    expect(mockAddDirectoryListingListener).not.toHaveBeenCalled()
    deliver({ path: '/anywhere', parentPath: null, entries: [], error: DENIED })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('drops the note once the user edits the working directory', () => {
    renderModal()
    deliver({ path: '/srv/outside', parentPath: null, entries: [], error: DENIED })
    expect(screen.getByText(NOTE)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/home/me/proj' } })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('removes its listener once answered', () => {
    renderModal()
    expect(listeners.size).toBe(1)
    deliver({ path: '/srv/outside', parentPath: null, entries: [], error: null })
    expect(listeners.size).toBe(0)
  })

  it('removes its listener when the modal closes before a reply arrives', () => {
    const { rerenderWith } = renderModal()
    expect(listeners.size).toBe(1)
    rerenderWith({ open: false })
    expect(listeners.size).toBe(0)
  })

  it('removes its listener when the modal unmounts', () => {
    const { unmount } = renderModal()
    expect(listeners.size).toBe(1)
    unmount()
    expect(listeners.size).toBe(0)
  })

  it('does not probe, and shows no note, when there is no prefilled directory', () => {
    renderModal({ initialCwd: '' })
    expect(mockRequestDirectoryListing).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })
})
