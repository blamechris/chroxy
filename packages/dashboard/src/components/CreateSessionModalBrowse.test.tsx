/**
 * CreateSessionModal browse mode integration tests (#1585)
 *
 * Tests the Browse... button flow: opening the DirectoryBrowser,
 * navigating directories, selecting a path, canceling, and
 * state reset on modal reopen.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { dispatchDirectoryListingProbes } from '../store/directory-listing-probes'
import type { DirectoryListing } from '../store/types'

let capturedCallback: ((listing: Record<string, unknown>) => void) | null = null
const mockRequestDirectoryListing = vi.fn()
const mockSetDirectoryListingCallback = vi.fn((cb: unknown) => {
  capturedCallback = cb as typeof capturedCallback
})

const probeUnsubscribed = vi.fn()
vi.mock('../store/directory-listing-probes', async (orig) => {
  const real = await orig<typeof import('../store/directory-listing-probes')>()
  return {
    ...real,
    addDirectoryListingProbe: (path: string, cb: Parameters<typeof real.addDirectoryListingProbe>[1]) => {
      const unsub = real.addDirectoryListingProbe(path, cb)
      return () => { probeUnsubscribed(); unsub() }
    },
  }
})

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      defaultProvider: 'claude-sdk',
      availableProviders: [],
      requestDirectoryListing: mockRequestDirectoryListing,
      setDirectoryListingCallback: mockSetDirectoryListingCallback,
      defaultCwd: null,
    }),
}))

import { CreateSessionModal, type CreateSessionModalProps } from './CreateSessionModal'

afterEach(() => {
  cleanup()
  capturedCallback = null
  mockRequestDirectoryListing.mockClear()
  mockSetDirectoryListingCallback.mockClear()
  probeUnsubscribed.mockClear()
})

function renderModal(props: Partial<CreateSessionModalProps> = {}) {
  const onCreate = vi.fn()
  const onClose = vi.fn()
  const defaultProps: CreateSessionModalProps = {
    open: true,
    onClose,
    onCreate,
    initialCwd: '/home/user',
    knownCwds: [],
    existingNames: [],
    ...props,
  }
  const result = render(<CreateSessionModal {...defaultProps} />)
  return { ...result, onCreate, onClose }
}

/** Simulate a directory listing response arriving via the captured callback. */
function simulateListing(path: string, entries: { name: string; isDirectory: boolean }[]) {
  expect(capturedCallback).not.toBeNull()
  act(() => {
    capturedCallback!({ path, entries })
  })
}

describe('CreateSessionModal browse mode (#1585)', () => {
  it('clicking Browse opens DirectoryBrowser', () => {
    renderModal()
    // CWD input should be visible initially
    expect(screen.getByLabelText('Working directory')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Browse...'))

    // DirectoryBrowser should now be visible (has breadcrumb nav + Select/Cancel buttons)
    expect(screen.getByRole('navigation', { name: /breadcrumb/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Select')).toBeInTheDocument()
    expect(screen.getByLabelText('Cancel')).toBeInTheDocument()
    // CWD input should be hidden
    expect(screen.queryByLabelText('Working directory')).not.toBeInTheDocument()
  })

  it('requests directory listing when browse opens', () => {
    renderModal({ initialCwd: '/home/user/projects' })
    fireEvent.click(screen.getByText('Browse...'))

    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/home/user/projects')
    expect(mockSetDirectoryListingCallback).toHaveBeenCalled()
  })

  it('shows loading state before listing arrives', () => {
    renderModal()
    fireEvent.click(screen.getByText('Browse...'))

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('displays directory entries when listing arrives', () => {
    renderModal()
    fireEvent.click(screen.getByText('Browse...'))

    simulateListing('/home/user', [
      { name: 'projects', isDirectory: true },
      { name: 'documents', isDirectory: true },
      { name: 'file.txt', isDirectory: false },
    ])

    // Should show directories only
    expect(screen.getByText('projects')).toBeInTheDocument()
    expect(screen.getByText('documents')).toBeInTheDocument()
    // Files should be filtered out
    expect(screen.queryByText('file.txt')).not.toBeInTheDocument()
    // Loading should be gone
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('selecting a path populates CWD input and closes browser', () => {
    renderModal()
    fireEvent.click(screen.getByText('Browse...'))

    simulateListing('/home/user', [
      { name: 'projects', isDirectory: true },
    ])

    // Click Select to choose current path
    fireEvent.click(screen.getByLabelText('Select'))

    // Browser should close, CWD input should reappear with the selected path
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).not.toBeInTheDocument()
    const cwdInput = screen.getByLabelText('Working directory') as HTMLInputElement
    expect(cwdInput.value).toBe('/home/user')
  })

  it('selecting a path auto-generates session name', () => {
    renderModal({ initialCwd: '' })
    fireEvent.click(screen.getByText('Browse...'))

    simulateListing('/', [
      { name: 'home', isDirectory: true },
    ])

    // Navigate into /home
    fireEvent.click(screen.getByText('home'))

    simulateListing('/home', [
      { name: 'user', isDirectory: true },
    ])

    // Select /home as the path
    fireEvent.click(screen.getByLabelText('Select'))

    const nameInput = screen.getByLabelText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('home')
  })

  it('canceling browse returns to combobox view', () => {
    renderModal()
    fireEvent.click(screen.getByText('Browse...'))

    // Browser should be visible
    expect(screen.getByLabelText('Select')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Cancel'))

    // Browser should close, CWD input should reappear
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Working directory')).toBeInTheDocument()
  })

  it('canceling clears directory listing callback', () => {
    renderModal()
    fireEvent.click(screen.getByText('Browse...'))
    fireEvent.click(screen.getByLabelText('Cancel'))

    // setDirectoryListingCallback should be called with null on cancel
    const calls = mockSetDirectoryListingCallback.mock.calls
    const lastCall = calls[calls.length - 1]!
    expect(lastCall[0]).toBeNull()
  })

  it('browse state resets when modal reopens', () => {
    const { rerender, onClose, onCreate } = renderModal()

    // Open browse mode
    fireEvent.click(screen.getByText('Browse...'))
    expect(screen.getByLabelText('Select')).toBeInTheDocument()

    // Close and reopen modal
    rerender(
      <CreateSessionModal
        open={false}
        onClose={onClose}
        onCreate={onCreate}
        initialCwd="/home/user"
        knownCwds={[]}
        existingNames={[]}
      />
    )
    rerender(
      <CreateSessionModal
        open={true}
        onClose={onClose}
        onCreate={onCreate}
        initialCwd="/home/user"
        knownCwds={[]}
        existingNames={[]}
      />
    )

    // Should be back to combobox view, not browse mode
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Working directory')).toBeInTheDocument()
  })

  it('navigating into a subdirectory requests new listing', () => {
    renderModal()
    fireEvent.click(screen.getByText('Browse...'))

    simulateListing('/home/user', [
      { name: 'projects', isDirectory: true },
      { name: 'documents', isDirectory: true },
    ])

    mockRequestDirectoryListing.mockClear()

    // Click on a directory entry to navigate into it
    fireEvent.click(screen.getByText('projects'))

    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/home/user/projects')
  })

  it('does not auto-rename when user manually edited name before browsing', () => {
    renderModal({ initialCwd: '/home/user' })

    // Manually edit the name
    const nameInput = screen.getByLabelText('Session name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'My Custom Name' } })

    // Open browse and select a path
    fireEvent.click(screen.getByText('Browse...'))

    simulateListing('/home/user', [
      { name: 'projects', isDirectory: true },
    ])

    fireEvent.click(screen.getByLabelText('Select'))

    // Name should NOT change because it was manually edited
    expect(nameInput.value).toBe('My Custom Name')
  })
})

/**
 * Mirror the store's `directory_listing` dispatch: the single-slot callback (whoever
 * installed last) AND the path-matched probes. The real wiring is covered against
 * the actual store in store/dispatch-directory-listing-probe.test.ts.
 */
function deliver(listing: Partial<DirectoryListing>) {
  act(() => {
    capturedCallback?.(listing as Record<string, unknown>)
    dispatchDirectoryListingProbes({ parentPath: null, entries: [], error: null, ...listing } as DirectoryListing)
  })
}

describe('CreateSessionModal not-browsable note (#8303)', () => {
  const DENIED = 'Access denied: directory listing is restricted to the home directory'

  it('shows the note on open, without a Browse click, when the prefilled cwd cannot be listed', () => {
    renderModal({ initialCwd: '/srv/work' })
    expect(mockRequestDirectoryListing).toHaveBeenCalledTimes(1)
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/srv/work')
    expect(screen.queryByTestId('cwd-browse-note')).not.toBeInTheDocument()

    deliver({ path: '/srv/work', error: DENIED })

    const note = screen.getByTestId('cwd-browse-note')
    expect(note.textContent).toContain("Browse can't open this directory on this server.")
    expect(note.querySelector('[title]')?.getAttribute('title')).toContain('restricted to the home directory')
  })

  it('does not occupy the store single-slot callback', () => {
    renderModal({ initialCwd: '/srv/work' })
    expect(capturedCallback).toBeNull()
  })

  it('still shows the note when another consumer (autocomplete) installs the slot callback before the response', () => {
    renderModal({ initialCwd: '/srv/work' })
    // usePathAutocomplete's debounce fires between the probe request and its response
    const autocompleteCb = vi.fn()
    mockSetDirectoryListingCallback(autocompleteCb)
    deliver({ path: '/srv/work', error: DENIED })
    expect(autocompleteCb).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('cwd-browse-note')).toBeInTheDocument()
  })

  it('shows no note when the probe lists fine', () => {
    renderModal({ initialCwd: '/srv/work' })
    deliver({ path: '/srv/work', entries: [{ name: 'a', isDirectory: true }] })
    expect(screen.queryByTestId('cwd-browse-note')).not.toBeInTheDocument()
  })

  it('ignores a response for a different path', () => {
    renderModal({ initialCwd: '/srv/work' })
    deliver({ path: '/elsewhere', error: DENIED })
    expect(screen.queryByTestId('cwd-browse-note')).not.toBeInTheDocument()
  })

  it('does not probe a ~ cwd (the server does not echo the request)', () => {
    renderModal({ initialCwd: '~/code' })
    expect(mockRequestDirectoryListing).not.toHaveBeenCalled()
  })

  it('removes the probe listener on close', () => {
    const { rerender, onClose, onCreate } = renderModal({ initialCwd: '/srv/work' })
    rerender(<CreateSessionModal open={false} onClose={onClose} onCreate={onCreate} initialCwd="/srv/work" knownCwds={[]} existingNames={[]} />)
    expect(probeUnsubscribed).toHaveBeenCalledTimes(1)
  })

  it('does not probe when there is no prefilled cwd', () => {
    renderModal({ initialCwd: '' })
    expect(mockRequestDirectoryListing).not.toHaveBeenCalled()
  })

  it('a user Browse after the probe works normally', () => {
    renderModal({ initialCwd: '/srv/work' })
    fireEvent.click(screen.getByText('Browse...'))
    simulateListing('/srv/work', [{ name: 'projects', isDirectory: true }])
    expect(screen.getByText('projects')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Cancel'))
    expect(screen.queryByTestId('cwd-browse-note')).not.toBeInTheDocument()
  })

  it('does not show the note when the prefilled cwd lists fine', () => {
    renderModal({ initialCwd: '/home/user' })
    fireEvent.click(screen.getByText('Browse...'))
    simulateListing('/home/user', [{ name: 'projects', isDirectory: true }])
    fireEvent.click(screen.getByLabelText('Cancel'))
    expect(screen.queryByTestId('cwd-browse-note')).not.toBeInTheDocument()
  })

  it('hides the note once the cwd is edited to a different path', () => {
    renderModal({ initialCwd: '/srv/work' })
    deliver({ path: '/srv/work', error: DENIED })
    expect(screen.getByTestId('cwd-browse-note')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/home/user' } })
    expect(screen.queryByTestId('cwd-browse-note')).not.toBeInTheDocument()
  })
})
