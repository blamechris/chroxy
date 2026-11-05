/**
 * #8972: the "Isolate filesystem (worktree)" checkbox must be refused up front
 * for a directory that is not a git repository, with the reason rendered where
 * the checkbox's aria-describedby points. The daemon used to refuse only after
 * Create.
 *
 * The modal asks the daemon (`requestGitRepoCheck`) once the cwd settles and
 * reads the reply through the single `setGitRepoCheckCallback` slot. Only a
 * reply that echoes the LATEST request id and belongs to the CURRENT cwd may
 * disable the switch; `null` ("cannot tell") must leave it enabled.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const NOT_GIT_REASON = 'This directory is not a git repository — worktree isolation needs a git repo'

const TUI_PROVIDER = { name: 'claude-tui', capabilities: {}, auth: { ready: true, source: 'static', detail: '' } }

type CheckResult = { path: string | null; isGitRepo: boolean | null; requestId: string | null }
let requests: Array<{ path: string; requestId: string }> = []
let callback: ((r: CheckResult) => void) | null = null

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
        setDirectoryListingCallback: () => {},
        requestGitRepoCheck: (path: string, requestId: string) => { requests.push({ path, requestId }) },
        setGitRepoCheckCallback: (cb: ((r: CheckResult) => void) | null) => { callback = cb },
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

function openAdvanced() {
  fireEvent.click(screen.getByRole('button', { name: /advanced/i }))
}

function worktreeCheckbox(): HTMLInputElement {
  return document.getElementById('worktree-checkbox') as HTMLInputElement
}

function typeCwd(value: string) {
  fireEvent.change(screen.getByLabelText(/working directory/i), { target: { value } })
}

async function settle() {
  await act(async () => { vi.advanceTimersByTime(400) })
}

function reply(isGitRepo: boolean | null, over: Partial<CheckResult> = {}) {
  const last = requests[requests.length - 1]!
  act(() => { callback?.({ path: last.path, isGitRepo, requestId: last.requestId, ...over }) })
}

describe('CreateSessionModal worktree checkbox: non-git directory (#8972)', () => {
  it('disables the checkbox and renders the not-a-repo reason for a non-git directory', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    openAdvanced()
    typeCwd('/tmp/plain')
    expect(worktreeCheckbox().disabled).toBe(false) // nothing known yet
    await settle()
    expect(requests).toEqual([{ path: '/tmp/plain', requestId: expect.any(String) }])
    reply(false)
    expect(worktreeCheckbox().disabled).toBe(true)
    expect(worktreeCheckbox().getAttribute('aria-describedby')).toBe('worktree-hint')
    expect(document.getElementById('worktree-hint')!.textContent).toBe(NOT_GIT_REASON)
  })

  it('keeps the checkbox enabled for a git directory', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    openAdvanced()
    typeCwd('/repo')
    await settle()
    reply(true)
    expect(worktreeCheckbox().disabled).toBe(false)
    expect(document.getElementById('worktree-hint')!.textContent).not.toBe(NOT_GIT_REASON)
  })

  it('keeps the checkbox enabled when the server cannot tell (null)', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    openAdvanced()
    typeCwd('/opt/elsewhere')
    await settle()
    reply(null)
    expect(worktreeCheckbox().disabled).toBe(false)
  })

  it('ignores a reply for a superseded request', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    openAdvanced()
    typeCwd('/tmp/plain')
    await settle()
    const stale = requests[0]!
    typeCwd('/tmp/plain2')
    await settle()
    act(() => { callback?.({ path: stale.path, isGitRepo: false, requestId: stale.requestId }) })
    expect(worktreeCheckbox().disabled).toBe(false)
  })

  it('ignores a reply carrying the right requestId but a different path', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    openAdvanced()
    typeCwd('/tmp/plain')
    await settle()
    reply(false, { path: '/some/other/dir' })
    expect(worktreeCheckbox().disabled).toBe(false)
    reply(false) // the matching path is still accepted
    expect(worktreeCheckbox().disabled).toBe(true)
  })

  it('request ids are unique across mounts: a reply from an earlier mount is ignored', async () => {
    mockStore()
    const Modal = await loadModal()
    const first = render(<Modal {...baseProps} />)
    openAdvanced()
    typeCwd('/tmp/plain')
    await settle()
    const earlier = requests[requests.length - 1]!
    first.unmount()
    render(<Modal {...baseProps} />)
    openAdvanced()
    typeCwd('/tmp/plain')
    await settle()
    const later = requests[requests.length - 1]!
    expect(later.requestId).not.toBe(earlier.requestId)
    act(() => { callback?.({ path: earlier.path, isGitRepo: false, requestId: earlier.requestId }) })
    expect(worktreeCheckbox().disabled).toBe(false)
  })

  it('re-enables the checkbox when the cwd changes to a path that has no answer', async () => {
    mockStore()
    const Modal = await loadModal()
    render(<Modal {...baseProps} />)
    openAdvanced()
    typeCwd('/tmp/plain')
    await settle()
    reply(false)
    expect(worktreeCheckbox().disabled).toBe(true)
    typeCwd('/repo')
    expect(worktreeCheckbox().disabled).toBe(false)
  })

  it('does not submit worktree:true for a non-git directory even if it was ticked first', async () => {
    mockStore()
    const onCreate = vi.fn()
    const Modal = await loadModal()
    render(<Modal {...baseProps} onCreate={onCreate} initialCwd="/tmp/plain" />)
    openAdvanced()
    fireEvent.click(worktreeCheckbox()) // ticked before the answer arrives
    expect(worktreeCheckbox().checked).toBe(true)
    await settle()
    reply(false)
    expect(worktreeCheckbox().checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp/plain' }))
    expect(onCreate.mock.calls[0]![0].worktree).toBeUndefined()
  })
})
