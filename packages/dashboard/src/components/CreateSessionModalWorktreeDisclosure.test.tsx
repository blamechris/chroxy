/** #8221: a collapsed Advanced section must disclose the worktree flag it submits. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const SELECTED = 'worktree isolation'
const PROVIDER = { name: 'claude-tui', capabilities: {}, auth: { ready: true, source: 'static', detail: '' } }
type CheckResult = { path: string; isGitRepo: boolean | null; requestId: string }
let requests: Array<{ path: string; requestId: string }>
let replyCallback: ((result: CheckResult) => void) | null

function mockStore(supportsGitCheck = true) {
  // Stable objects/actions keep submit's dependencies from changing spuriously.
  const state = {
    defaultProvider: 'claude-tui',
    defaultModel: null,
    availableProviders: [PROVIDER],
    permissionModesByProvider: {},
    environments: [],
    requestDirectoryListing: () => {},
    setDirectoryListingCallback: () => {},
    defaultCwd: null,
    ...(supportsGitCheck ? {
      requestGitRepoCheck: (path: string, requestId: string) => { requests.push({ path, requestId }) },
      setGitRepoCheckCallback: (callback: typeof replyCallback) => { replyCallback = callback },
    } : {}),
  }
  vi.doMock('../store/connection', () => ({
    useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(state),
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  requests = []
  replyCallback = null
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetModules()
  vi.doUnmock('../store/connection')
})

async function setup(supportsGitCheck = true) {
  mockStore(supportsGitCheck)
  const { CreateSessionModal } = await import('./CreateSessionModal')
  const props = { open: true, initialCwd: '/repo', onCreate: vi.fn(), onClose: vi.fn() }
  const view = render(<CreateSessionModal {...props} />)
  return { ...view, CreateSessionModal, props }
}

function advanced() { return screen.getByRole('button', { name: /advanced/i }) }
function toggleAdvanced() { fireEvent.click(advanced()) }
function checkbox() { return screen.getByRole('checkbox', { name: 'Isolate filesystem (worktree)' }) }
function typeCwd(value: string) {
  fireEvent.change(screen.getByLabelText('Working directory'), { target: { value } })
}
function expectDisclosure(selected: boolean) {
  expect(advanced()).toBeVisible()
  if (selected) {
    expect(advanced()).toHaveTextContent(SELECTED)
    expect(screen.getByTestId('advanced-summary')).toBeVisible()
  } else expect(advanced()).not.toHaveTextContent(SELECTED)
}
function expectSubmitted(onCreate: ReturnType<typeof vi.fn>, cwd: string, worktree?: boolean) {
  expect(onCreate).toHaveBeenCalledTimes(1)
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd, worktree }))
}
function answerGitCheck(isGitRepo: boolean | null) {
  act(() => { vi.advanceTimersByTime(300) })
  const request = requests[requests.length - 1]!
  expect(request).toBeDefined()
  expect(replyCallback).not.toBeNull()
  act(() => { replyCallback!({ ...request, isGitRepo }) })
}

describe('CreateSessionModal collapsed worktree disclosure (#8221)', () => {
  it.each(['Create button', 'directory Enter', 'name Enter'])('discloses the restored selection before submitting via %s', async (via) => {
    const { props } = await setup()
    toggleAdvanced()
    fireEvent.click(checkbox())
    typeCwd('')
    expect(checkbox()).not.toBeChecked()
    toggleAdvanced()
    expectDisclosure(false)
    typeCwd('/another-repo')
    answerGitCheck(true)

    expect(screen.queryByRole('checkbox', { name: 'Isolate filesystem (worktree)' })).not.toBeInTheDocument()
    expect(advanced()).toHaveAttribute('aria-expanded', 'false')
    expectDisclosure(true)
    expect(props.onCreate).not.toHaveBeenCalled()
    if (via === 'Create button') fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    else fireEvent.keyDown(screen.getByLabelText(via === 'directory Enter' ? 'Working directory' : 'Session name'), { key: 'Enter' })
    expectSubmitted(props.onCreate, '/another-repo', true)
  })

  it('discloses an ordinary selected collapse, preserves it on reopen, and removes disclosure after unticking', async () => {
    const { props } = await setup()
    toggleAdvanced()
    fireEvent.click(checkbox())
    expect(checkbox()).toBeChecked()
    toggleAdvanced()
    expectDisclosure(true)
    toggleAdvanced()
    expect(checkbox()).toBeChecked()
    expectDisclosure(false) // the checkbox now carries the visible selection
    fireEvent.click(checkbox())
    toggleAdvanced()
    expectDisclosure(false)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expectSubmitted(props.onCreate, '/repo')
  })

  it('submits an ordinary collapsed selected worktree unchanged', async () => {
    const { props } = await setup()
    toggleAdvanced()
    fireEvent.click(checkbox())
    toggleAdvanced()
    expectDisclosure(true)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expectSubmitted(props.onCreate, '/repo', true)
  })

  it('does not claim worktree isolation for the default off state', async () => {
    const { props } = await setup()
    expectDisclosure(false)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expectSubmitted(props.onCreate, '/repo')
  })

  it.each(['', '   '])('does not disclose or submit a saved selection for an empty cwd %j', async (cwd) => {
    const { props } = await setup()
    toggleAdvanced()
    fireEvent.click(checkbox())
    toggleAdvanced()
    expectDisclosure(true)
    typeCwd(cwd)
    expectDisclosure(false)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expectSubmitted(props.onCreate, '')
  })

  it('removes disclosure and the submitted flag for a known non-git path, then restores both for a git path', async () => {
    const { props } = await setup()
    toggleAdvanced()
    fireEvent.click(checkbox())
    toggleAdvanced()
    answerGitCheck(false)
    expectDisclosure(false)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expectSubmitted(props.onCreate, '/repo')

    props.onCreate.mockClear()
    typeCwd('/git-repo')
    answerGitCheck(true)
    expectDisclosure(true)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expectSubmitted(props.onCreate, '/git-repo', true)
  })

  it.each(['pending', 'unknown', 'unsupported'])('discloses the selected flag without promising validation when the git check is %s', async (check) => {
    const { props } = await setup(check !== 'unsupported')
    toggleAdvanced()
    fireEvent.click(checkbox())
    toggleAdvanced()
    if (check === 'unknown') answerGitCheck(null)
    expectDisclosure(true)
    expect(advanced()).not.toHaveTextContent(/verified|validated/i)
    if (check === 'unsupported') expect(requests).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expectSubmitted(props.onCreate, '/repo', true)
  })

  it('cancels without creating and resets the selection/disclosure on a fresh open', async () => {
    const { CreateSessionModal, props, rerender } = await setup()
    toggleAdvanced()
    fireEvent.click(checkbox())
    toggleAdvanced()
    expectDisclosure(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onCreate).not.toHaveBeenCalled()
    rerender(<CreateSessionModal {...props} open={false} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    rerender(<CreateSessionModal {...props} />)
    expectDisclosure(false)
    toggleAdvanced()
    expect(checkbox()).not.toBeChecked()
    expect(props.onCreate).not.toHaveBeenCalled()
  })
})
