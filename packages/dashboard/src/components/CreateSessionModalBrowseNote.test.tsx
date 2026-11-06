/**
 * #8303: the New Session dialog asks the daemon (the same `list_directory`
 * request the Browse picker sends) whether a typed or prefilled directory can be
 * listed, and shows a one-line informational note only on an explicit
 * "Access denied" refusal for the CURRENT path. It never blocks Create.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const TUI_PROVIDER = { name: 'claude-tui', capabilities: {}, auth: { ready: true, source: 'static', detail: '' } }

type Listing = { path: string | null; parentPath: string | null; entries: unknown[]; error: string | null }
let requests: Array<string | undefined> = []
let callback: ((l: Listing) => void) | null = null

function mockStore() {
  vi.doMock('../store/connection', () => ({
    useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        defaultProvider: 'claude-tui',
        defaultModel: null,
        availableProviders: [TUI_PROVIDER],
        permissionModesByProvider: {},
        environments: [],
        requestDirectoryListing: (path?: string) => { requests.push(path) },
        setDirectoryListingCallback: (cb: ((l: Listing) => void) | null) => { callback = cb },
        defaultCwd: null,
      }),
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  requests = []
  callback = null
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

function reply(listing: Partial<Listing>) {
  act(() => { callback?.({ path: null, parentPath: null, entries: [], error: null, ...listing }) })
}

const DENIED = 'Access denied: directory listing is restricted to the home directory'
const note = () => screen.queryByTestId('cwd-not-browsable')

describe('CreateSessionModal: not-browsable note (#8303)', () => {
  it('shows the note when the daemon refuses to list the directory', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    expect(note()).toBeNull()
    await settle()
    expect(requests).toEqual(['/tmp/outside'])
    reply({ path: '/tmp/outside', error: DENIED })
    expect(note()).not.toBeNull()
    expect(note()!.textContent).toMatch(/Browse can't list this directory/)
  })

  it('does not show the note when the directory is listable', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/home/me/proj')
    await settle()
    reply({ path: '/home/me/proj', entries: [] })
    expect(note()).toBeNull()
  })

  it('says nothing for "not found", other errors, or no reply', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/home/me/new')
    await settle()
    expect(note()).toBeNull() // no reply yet
    reply({ path: '/home/me/new', error: 'Directory not found' })
    expect(note()).toBeNull()
    reply({ path: '/home/me/new', error: 'Permission denied' })
    expect(note()).toBeNull()
  })

  it('ignores a refusal that belongs to an earlier cwd', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    await settle()
    typeCwd('/home/me/proj')
    // a late refusal for the superseded path must neither show nor stick
    reply({ path: '/tmp/outside', error: DENIED })
    expect(note()).toBeNull()
    await settle()
    reply({ path: '/home/me/proj' })
    expect(note()).toBeNull()
  })

  it('clears the note once the cwd changes to a path with no refusal', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    await settle()
    reply({ path: '/tmp/outside', error: DENIED })
    expect(note()).not.toBeNull()
    typeCwd('/home/me/proj')
    expect(note()).toBeNull()
  })

  it('does not install its listener while the Browse picker is open', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /browse directories/i }))
    // the probe's debounce would fire now if it had not stood down
    await settle()
    // the picker's own callback now owns the slot; a refusal it receives
    // must not raise the dialog note
    reply({ path: '/tmp/outside', error: DENIED })
    expect(screen.getByRole('alert').textContent).toBe(DENIED) // the picker got it
    fireEvent.click(document.querySelector('.directory-browser-actions .btn-modal-cancel')!)
    expect(note()).toBeNull()
  })

  it('never blocks Create: the button stays enabled and submits', async () => {
    mockStore()
    const onCreate = vi.fn()
    const Modal = await loadModal()
    render(<Modal {...baseProps} onCreate={onCreate} />)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'outside' } })
    typeCwd('/tmp/outside')
    await settle()
    reply({ path: '/tmp/outside', error: DENIED })
    expect(note()).not.toBeNull()
    const create = screen.getByRole('button', { name: /^create/i }) as HTMLButtonElement
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ cwd: '/tmp/outside' })
  })

  it('sends one request for rapid typing (the earlier edit is debounced away)', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/a')
    await act(async () => { vi.advanceTimersByTime(100) })
    typeCwd('/tmp/ab')
    await settle()
    expect(requests).toEqual(['/tmp/ab'])
  })

  it('a reply for a different path than the current cwd neither shows nor sets the note', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/current')
    await settle()
    reply({ path: '/tmp/another', error: DENIED })
    expect(note()).toBeNull()
    // and it left no state behind: a plain listable reply keeps it clear
    reply({ path: '/tmp/current' })
    expect(note()).toBeNull()
  })

  it('a superseded listener cannot act: its late refusal does not resurface when the cwd returns', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/a')
    await settle()
    const oldListener = callback!
    typeCwd('/tmp/b') // supersedes /tmp/a (cleanup runs, no new request yet)
    act(() => { oldListener({ path: '/tmp/a', parentPath: null, entries: [], error: DENIED }) })
    typeCwd('/tmp/a') // back to the refused path, no new reply yet
    expect(note()).toBeNull()
  })

  it('a reply arriving after the dialog unmounts is harmless', async () => {
    mockStore()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Modal = await loadModal()
    const { unmount } = render(<Modal {...baseProps} />)
    typeCwd('/tmp/a')
    await settle()
    const listener = callback!
    unmount()
    expect(() => listener({ path: '/tmp/a', parentPath: null, entries: [], error: DENIED })).not.toThrow()
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('renders below the "New directory" hint and not as a .cwd-hint (which pulls itself up 6px and overlapped it)', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    typeCwd('/tmp/outside')
    await settle()
    reply({ path: '/tmp/outside', error: DENIED })
    const hint = screen.getByText(/New directory/)
    const n = note()!
    expect(n.classList.contains('cwd-hint')).toBe(false)
    expect(n.classList.contains('cwd-browse-note')).toBe(true)
    expect(hint.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
