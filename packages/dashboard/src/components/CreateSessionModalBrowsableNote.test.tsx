/**
 * #8303 — New Session says when the directory it will start from is one Browse
 * cannot list, instead of letting Browse fail on it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'
import type { DirectoryListing } from '../store/types'

const mockStoreState: Record<string, unknown> = {}
let listingCallback: ((l: DirectoryListing) => void) | null = null
const requestDirectoryListing = vi.fn()

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState),
}))

import { CreateSessionModal } from './CreateSessionModal'

const DENIED = 'Access denied: directory listing is restricted to the home directory'

beforeEach(() => {
  listingCallback = null
  requestDirectoryListing.mockReset()
  for (const k of Object.keys(mockStoreState)) delete mockStoreState[k]
  Object.assign(mockStoreState, {
    defaultProvider: 'claude-sdk',
    defaultProviderSource: 'server',
    sessionDefaultsNotice: null,
    dismissSessionDefaultsNotice: vi.fn(),
    defaultModel: '',
    modelsByProvider: {},
    availableProviders: [],
    permissionModesByProvider: {},
    environments: [],
    requestDirectoryListing,
    setDirectoryListingCallback: (cb: ((l: DirectoryListing) => void) | null) => { listingCallback = cb },
    defaultCwd: null,
  })
})

afterEach(cleanup)

function renderModal(props: { initialCwd?: string } = {}) {
  return render(<CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} knownCwds={[]} existingNames={[]} {...props} />)
}

const reply = (listing: Partial<DirectoryListing>) => act(() => {
  listingCallback?.({ path: '', parentPath: null, entries: [], error: null, ...listing } as DirectoryListing)
})

describe('CreateSessionModal not-browsable note (#8303)', () => {
  it('probes the prefilled project directory once on open', () => {
    renderModal({ initialCwd: '/srv/work/proj' })
    expect(requestDirectoryListing).toHaveBeenCalledTimes(1)
    expect(requestDirectoryListing).toHaveBeenCalledWith('/srv/work/proj')
  })

  it('shows a one-line note when Browse refuses the prefilled directory', () => {
    renderModal({ initialCwd: '/srv/work/proj' })
    reply({ path: '/srv/work/proj', error: DENIED })
    const note = screen.getByTestId('cwd-not-browsable-note')
    expect(note.textContent).toContain('/srv/work/proj')
    expect(note.textContent).toMatch(/Browse can't list/)
  })

  it('probes the daemon default cwd when no project directory was passed (the blank-cwd case)', () => {
    mockStoreState.defaultCwd = '/tmp/preview'
    renderModal()
    expect(requestDirectoryListing).toHaveBeenCalledWith('/tmp/preview')
    reply({ path: '/tmp/preview', error: DENIED })
    expect(screen.getByTestId('cwd-not-browsable-note').textContent).toContain('/tmp/preview')
  })

  it('shows no note when the directory is browsable', () => {
    renderModal({ initialCwd: '/home/u/proj' })
    reply({ path: '/home/u/proj', entries: [{ name: 'src', isDirectory: true }] })
    expect(screen.queryByTestId('cwd-not-browsable-note')).not.toBeInTheDocument()
  })

  it('shows no note for an unrelated error (not found is not "outside the roots")', () => {
    renderModal({ initialCwd: '/home/u/gone' })
    reply({ path: '/home/u/gone', error: 'Directory not found' })
    expect(screen.queryByTestId('cwd-not-browsable-note')).not.toBeInTheDocument()
  })

  it('ignores a stale reply for a different path', () => {
    renderModal({ initialCwd: '/srv/work/proj' })
    reply({ path: '/somewhere/else', error: DENIED })
    expect(screen.queryByTestId('cwd-not-browsable-note')).not.toBeInTheDocument()
  })

  it('hides the note once the user types a different directory', () => {
    renderModal({ initialCwd: '/srv/work/proj' })
    reply({ path: '/srv/work/proj', error: DENIED })
    expect(screen.getByTestId('cwd-not-browsable-note')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/home/u/other' } })
    expect(screen.queryByTestId('cwd-not-browsable-note')).not.toBeInTheDocument()
  })

  it('does not probe, or show a note, with no directory to start from', () => {
    renderModal()
    expect(requestDirectoryListing).not.toHaveBeenCalled()
    expect(screen.queryByTestId('cwd-not-browsable-note')).not.toBeInTheDocument()
  })
})
