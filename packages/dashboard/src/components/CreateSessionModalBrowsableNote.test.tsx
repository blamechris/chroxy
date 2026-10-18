/**
 * Issue 8303 — New Session used to prefill a working directory that Browse
 * could not open (it was outside $HOME and every workspace root) and said
 * nothing: Browse just failed. The modal now probes the prefilled directory
 * with a directory listing when it opens and, on an access-denied answer,
 * shows a one-line note.
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
  return render(
    <CreateSessionModal
      open
      onClose={vi.fn()}
      onCreate={vi.fn()}
      initialCwd="/srv/outside"
      knownCwds={[]}
      existingNames={[]}
      {...props}
    />,
  )
}

function reply(listing: Record<string, unknown>) {
  expect(capturedCallback).not.toBeNull()
  act(() => {
    capturedCallback!(listing)
  })
}

const NOTE = /outside the browsable roots/i

describe('CreateSessionModal: prefilled cwd that Browse cannot open (issue 8303)', () => {
  it('probes the prefilled directory itself when the modal opens', () => {
    renderModal()
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/srv/outside')
  })

  it('shows a one-line note when the probe is refused with Access denied', () => {
    renderModal()
    reply({
      path: '/srv/outside',
      parentPath: null,
      entries: [],
      error: 'Access denied: directory listing is restricted to the home directory and configured workspace roots',
    })
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })

  it('shows no note when the prefilled directory lists fine', () => {
    renderModal()
    reply({ path: '/srv/outside', parentPath: '/srv', entries: [], error: null })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('shows no note for an error that is not an access denial (a missing directory is a different problem)', () => {
    renderModal()
    reply({ path: '/srv/outside', parentPath: null, entries: [], error: 'Directory not found' })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('ignores a listing for some other path (a stale or autocomplete reply)', () => {
    renderModal()
    reply({
      path: '/srv',
      parentPath: null,
      entries: [],
      error: 'Access denied: directory listing is restricted to the home directory and configured workspace roots',
    })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('drops the note once the user edits the working directory', () => {
    renderModal()
    reply({
      path: '/srv/outside',
      parentPath: null,
      entries: [],
      error: 'Access denied: directory listing is restricted to the home directory and configured workspace roots',
    })
    expect(screen.getByText(NOTE)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/home/me/proj' } })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('does not probe, and shows no note, when there is no prefilled directory', () => {
    renderModal({ initialCwd: '' })
    expect(mockRequestDirectoryListing).not.toHaveBeenCalled()
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })
})
