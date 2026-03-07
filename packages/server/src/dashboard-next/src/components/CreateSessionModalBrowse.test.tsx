/**
 * CreateSessionModal browse mode integration tests (#1585)
 *
 * Tests the Browse... button flow: opening the DirectoryBrowser,
 * navigating directories, selecting a path, canceling, and
 * state reset on modal reopen.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

let capturedCallback: ((listing: Record<string, unknown>) => void) | null = null
const mockRequestDirectoryListing = vi.fn()
const mockSetDirectoryListingCallback = vi.fn((cb: unknown) => {
  capturedCallback = cb as typeof capturedCallback
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
