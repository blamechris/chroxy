/**
 * GitPanel — tests for the dashboard git stage/commit UI (#6780).
 *
 * Mirrors the DiffViewerPanel.test.tsx mocking idiom: the store is mocked
 * entirely, callbacks passed to setGit*Callback are captured so tests can
 * simulate a *_result reply landing on the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { GitPanel } from './GitPanel'

const mockRequestGitStatus = vi.fn()
const mockRequestGitBranches = vi.fn()
const mockRequestGitStage = vi.fn(() => true)
const mockRequestGitUnstage = vi.fn(() => true)
const mockRequestGitCommit = vi.fn(() => true)
const mockRequestGitCreatePr = vi.fn(() => true)

let storeState: Record<string, unknown> = {}
let capturedStatusCallback: ((result: any) => void) | null = null
let capturedBranchesCallback: ((result: any) => void) | null = null
let capturedStageCallback: ((result: any) => void) | null = null
let capturedCommitCallback: ((result: any) => void) | null = null
let capturedCreatePrCallback: ((result: any) => void) | null = null

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: any) => {
    const store = {
      setGitStatusCallback: (cb: any) => { capturedStatusCallback = cb },
      requestGitStatus: mockRequestGitStatus,
      setGitBranchesCallback: (cb: any) => { capturedBranchesCallback = cb },
      requestGitBranches: mockRequestGitBranches,
      setGitStageCallback: (cb: any) => { capturedStageCallback = cb },
      requestGitStage: mockRequestGitStage,
      requestGitUnstage: mockRequestGitUnstage,
      setGitCommitCallback: (cb: any) => { capturedCommitCallback = cb },
      requestGitCommit: mockRequestGitCommit,
      setGitCreatePrCallback: (cb: any) => { capturedCreatePrCallback = cb },
      requestGitCreatePr: mockRequestGitCreatePr,
      connectionPhase: storeState.connectionPhase ?? 'connected',
    }
    return selector(store)
  },
}))

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  mockRequestGitStage.mockReturnValue(true)
  mockRequestGitUnstage.mockReturnValue(true)
  mockRequestGitCommit.mockReturnValue(true)
  mockRequestGitCreatePr.mockReturnValue(true)
  storeState = { connectionPhase: 'connected' }
  capturedStatusCallback = null
  capturedBranchesCallback = null
  capturedStageCallback = null
  capturedCommitCallback = null
  capturedCreatePrCallback = null
})

const GIT_STATUS_WITH_CHANGES = {
  branch: 'feat/git-panel',
  staged: [{ path: 'src/staged.ts', status: 'modified' as const }],
  unstaged: [{ path: 'src/unstaged.ts', status: 'modified' as const }],
  untracked: ['src/new-file.ts'],
  error: null,
}

const GIT_BRANCHES = {
  branches: [
    { name: 'main', isCurrent: false, isRemote: false },
    { name: 'feat/git-panel', isCurrent: true, isRemote: false },
    { name: 'origin/main', isCurrent: false, isRemote: true },
  ],
  currentBranch: 'feat/git-panel',
  error: null,
}

describe('GitPanel', () => {
  it('requests git status and branches on mount', () => {
    render(<GitPanel />)
    expect(mockRequestGitStatus).toHaveBeenCalledOnce()
    expect(mockRequestGitBranches).toHaveBeenCalledOnce()
  })

  it('shows loading state initially', () => {
    render(<GitPanel />)
    expect(screen.getByText('Loading git status...')).toBeInTheDocument()
  })

  it('shows working tree clean when there are no changes', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!({ branch: 'main', staged: [], unstaged: [], untracked: [], error: null }))
    expect(screen.getByText('Working tree clean')).toBeInTheDocument()
  })

  it('shows error state', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!({ branch: null, staged: [], unstaged: [], untracked: [], error: 'Git status is not available in this mode' }))
    expect(screen.getByText('Git status is not available in this mode')).toBeInTheDocument()
  })

  it('renders staged, unstaged, and untracked file lists', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    expect(screen.getByTestId('git-staged-section').textContent).toContain('staged.ts')
    expect(screen.getByTestId('git-unstaged-section').textContent).toContain('unstaged.ts')
    expect(screen.getByTestId('git-untracked-section').textContent).toContain('new-file.ts')
  })

  it('shows the current branch badge', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))
    expect(screen.getByTitle('Branch: feat/git-panel')).toHaveTextContent('feat/git-panel')
  })

  it('sends requestGitStage with the selected unstaged path (per-file stage)', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.click(screen.getByLabelText('Select src/unstaged.ts'))
    fireEvent.click(screen.getByTestId('git-stage-selected-btn'))

    expect(mockRequestGitStage).toHaveBeenCalledWith(['src/unstaged.ts'])
  })

  it('sends requestGitStage with all unstaged + untracked paths (stage all)', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.click(screen.getAllByText('Stage all')[0]!)

    expect(mockRequestGitStage).toHaveBeenCalledWith(['src/unstaged.ts', 'src/new-file.ts'])
  })

  it('sends requestGitUnstage with the selected staged path (per-file unstage)', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.click(screen.getByLabelText('Select src/staged.ts'))
    fireEvent.click(screen.getByTestId('git-unstage-selected-btn'))

    expect(mockRequestGitUnstage).toHaveBeenCalledWith(['src/staged.ts'])
  })

  it('sends requestGitUnstage with all staged paths (unstage all)', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.click(screen.getByText('Unstage all'))

    expect(mockRequestGitUnstage).toHaveBeenCalledWith(['src/staged.ts'])
  })

  it('re-fetches git status after a successful stage', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))
    mockRequestGitStatus.mockClear()

    fireEvent.click(screen.getByLabelText('Select src/unstaged.ts'))
    fireEvent.click(screen.getByTestId('git-stage-selected-btn'))
    act(() => capturedStageCallback!({ error: null }))

    expect(mockRequestGitStatus).toHaveBeenCalledOnce()
  })

  it('surfaces a stage error without clearing the selection state forever', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.click(screen.getByLabelText('Select src/unstaged.ts'))
    fireEvent.click(screen.getByTestId('git-stage-selected-btn'))
    act(() => capturedStageCallback!({ error: 'fatal: not a git repository' }))

    expect(screen.getByTestId('git-action-error')).toHaveTextContent('fatal: not a git repository')
  })

  it('surfaces a "not connected" error when requestGitStage returns false (#6288-style guard)', () => {
    mockRequestGitStage.mockReturnValue(false)
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.click(screen.getByLabelText('Select src/unstaged.ts'))
    fireEvent.click(screen.getByTestId('git-stage-selected-btn'))

    expect(screen.getByTestId('git-action-error')).toHaveTextContent('Stage not sent — reconnect and try again')
    // The button must not be stuck disabled forever.
    expect(screen.getByTestId('git-stage-selected-btn')).not.toBeDisabled()
  })

  it('disables the commit button when the message is empty (empty-message guard)', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    const commitBtn = screen.getByTestId('git-commit-btn')
    expect(commitBtn).toBeDisabled()

    fireEvent.click(commitBtn)
    expect(mockRequestGitCommit).not.toHaveBeenCalled()
  })

  it('does not call requestGitCommit for a whitespace-only message', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    const input = screen.getByTestId('git-commit-input')
    fireEvent.change(input, { target: { value: '   ' } })

    expect(screen.getByTestId('git-commit-btn')).toBeDisabled()
  })

  it('opens a confirmation dialog before committing (does not commit on the first click)', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.change(screen.getByTestId('git-commit-input'), { target: { value: 'fix: typo' } })
    fireEvent.click(screen.getByTestId('git-commit-btn'))

    // The confirm dialog is shown and nothing has been committed yet.
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument()
    expect(mockRequestGitCommit).not.toHaveBeenCalled()
  })

  it('does not commit when the confirmation is cancelled', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.change(screen.getByTestId('git-commit-input'), { target: { value: 'fix: typo' } })
    fireEvent.click(screen.getByTestId('git-commit-btn'))
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))

    expect(mockRequestGitCommit).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })

  it('sends requestGitCommit with the trimmed message after confirming', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.change(screen.getByTestId('git-commit-input'), { target: { value: '  fix: typo  ' } })
    fireEvent.click(screen.getByTestId('git-commit-btn'))
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))

    expect(mockRequestGitCommit).toHaveBeenCalledWith('fix: typo')
  })

  it('clears the commit message and re-fetches status after a successful commit', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))
    mockRequestGitStatus.mockClear()

    const input = screen.getByTestId('git-commit-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'fix: typo' } })
    fireEvent.click(screen.getByTestId('git-commit-btn'))
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    act(() => capturedCommitCallback!({ hash: 'abc1234', message: 'fix: typo', error: null }))

    expect((screen.getByTestId('git-commit-input') as HTMLTextAreaElement).value).toBe('')
    expect(mockRequestGitStatus).toHaveBeenCalledOnce()
  })

  it('surfaces a commit error and keeps the message so the user can retry', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    const input = screen.getByTestId('git-commit-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'fix: typo' } })
    fireEvent.click(screen.getByTestId('git-commit-btn'))
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    act(() => capturedCommitCallback!({ hash: null, message: null, error: 'Commit message cannot be empty' }))

    expect(screen.getByTestId('git-action-error')).toHaveTextContent('Commit message cannot be empty')
    expect(input.value).toBe('fix: typo')
  })

  // Regression: the durable git_status_result handler must survive a mutation.
  // The earlier version swapped in a one-shot status callback that nulled the
  // slot after each stage/commit — so a subsequent Refresh produced a
  // git_status_result no callback consumed, wedging the panel on the spinner.
  it('keeps consuming git_status_result (Refresh works) after a stage', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    // Stage a file and let the post-stage refresh land.
    fireEvent.click(screen.getByLabelText('Select src/unstaged.ts'))
    fireEvent.click(screen.getByTestId('git-stage-selected-btn'))
    act(() => capturedStageCallback!({ error: null }))
    act(() => capturedStatusCallback!({ branch: 'feat/git-panel', staged: [{ path: 'src/unstaged.ts', status: 'modified' }], unstaged: [], untracked: [], error: null }))

    // Now Refresh: its git_status_result must still be consumed (status updates,
    // no stuck "Loading git status…" spinner).
    fireEvent.click(screen.getByText('Refresh'))
    act(() => capturedStatusCallback!({ branch: 'main', staged: [], unstaged: [{ path: 'other.ts', status: 'modified' }], untracked: [], error: null }))

    expect(screen.queryByText('Loading git status...')).not.toBeInTheDocument()
    expect(screen.getByTestId('git-unstaged-section').textContent).toContain('other.ts')
    expect(screen.getByTitle('Branch: main')).toBeInTheDocument()
  })

  it('keeps consuming git_status_result (Refresh works) after a commit', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    fireEvent.change(screen.getByTestId('git-commit-input'), { target: { value: 'fix: typo' } })
    fireEvent.click(screen.getByTestId('git-commit-btn'))
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    act(() => capturedCommitCallback!({ hash: 'abc1234', message: 'fix: typo', error: null }))
    act(() => capturedStatusCallback!({ branch: 'feat/git-panel', staged: [], unstaged: [], untracked: [], error: null }))

    // Refresh after the commit must still be consumed.
    fireEvent.click(screen.getByText('Refresh'))
    act(() => capturedStatusCallback!({ branch: 'feat/git-panel', staged: [], unstaged: [{ path: 'again.ts', status: 'modified' }], untracked: [], error: null }))

    expect(screen.queryByText('Loading git status...')).not.toBeInTheDocument()
    expect(screen.getByTestId('git-unstaged-section').textContent).toContain('again.ts')
  })

  it('renders the branches tab with local and remote branches, current marked', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))
    act(() => capturedBranchesCallback!(GIT_BRANCHES))

    fireEvent.click(screen.getByRole('button', { name: 'Branches' }))

    const branchesTab = screen.getByTestId('git-branches-tab')
    expect(branchesTab.textContent).toContain('main')
    expect(branchesTab.textContent).toContain('feat/git-panel')
    expect(branchesTab.textContent).toContain('origin/main')
  })

  it('does not render the commit form when nothing is staged', () => {
    render(<GitPanel />)
    act(() => capturedStatusCallback!({ branch: 'main', staged: [], unstaged: [{ path: 'a.ts', status: 'modified' }], untracked: [], error: null }))

    expect(screen.queryByTestId('git-commit-input')).not.toBeInTheDocument()
  })

  // #6876 — in-app PR creation.
  describe('Create PR', () => {
    const seedBranch = () =>
      act(() => capturedStatusCallback!(GIT_STATUS_WITH_CHANGES))

    it('shows the Create PR button once a branch is known', () => {
      render(<GitPanel />)
      expect(screen.queryByTestId('git-create-pr-open-btn')).not.toBeInTheDocument()
      seedBranch()
      expect(screen.getByTestId('git-create-pr-open-btn')).toBeInTheDocument()
    })

    it('opens the PR form (prefilled with the branch name) on click', () => {
      render(<GitPanel />)
      seedBranch()
      fireEvent.click(screen.getByTestId('git-create-pr-open-btn'))

      expect(screen.getByTestId('git-pr-form')).toBeInTheDocument()
      expect((screen.getByTestId('git-pr-title-input') as HTMLInputElement).value).toBe('feat/git-panel')
    })

    it('is confirmation-gated: submitting opens the confirm dialog without firing the request', () => {
      render(<GitPanel />)
      seedBranch()
      fireEvent.click(screen.getByTestId('git-create-pr-open-btn'))
      fireEvent.click(screen.getByTestId('git-pr-submit-btn'))

      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument()
      expect(mockRequestGitCreatePr).not.toHaveBeenCalled()
    })

    it('fires requestGitCreatePr with title/body/base/draft after confirming', () => {
      render(<GitPanel />)
      seedBranch()
      fireEvent.click(screen.getByTestId('git-create-pr-open-btn'))

      fireEvent.change(screen.getByTestId('git-pr-title-input'), { target: { value: 'feat: cool' } })
      fireEvent.change(screen.getByTestId('git-pr-body-input'), { target: { value: 'body text' } })
      fireEvent.change(screen.getByTestId('git-pr-base-input'), { target: { value: 'develop' } })
      fireEvent.click(screen.getByTestId('git-pr-draft-checkbox'))
      fireEvent.click(screen.getByTestId('git-pr-submit-btn'))
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))

      expect(mockRequestGitCreatePr).toHaveBeenCalledWith({
        title: 'feat: cool',
        body: 'body text',
        base: 'develop',
        draft: true,
      })
    })

    it('shows the created PR URL on success', () => {
      render(<GitPanel />)
      seedBranch()
      fireEvent.click(screen.getByTestId('git-create-pr-open-btn'))
      fireEvent.click(screen.getByTestId('git-pr-submit-btn'))
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
      act(() => capturedCreatePrCallback!({ url: 'https://github.com/o/r/pull/42', number: 42, branch: 'feat/git-panel', base: 'main', error: null }))

      const link = screen.getByTestId('git-pr-url') as HTMLAnchorElement
      expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/42')
    })

    it('surfaces the server error on failure and keeps the form open', () => {
      render(<GitPanel />)
      seedBranch()
      fireEvent.click(screen.getByTestId('git-create-pr-open-btn'))
      fireEvent.click(screen.getByTestId('git-pr-submit-btn'))
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
      act(() => capturedCreatePrCallback!({ url: null, number: null, branch: 'feat/git-panel', base: 'main', error: 'GitHub CLI is not authenticated — run `gh auth login` on the daemon host to enable PR creation' }))

      expect(screen.getByTestId('git-pr-error')).toHaveTextContent('not authenticated')
      // Form still open (title input present), so the operator can retry.
      expect(screen.getByTestId('git-pr-title-input')).toBeInTheDocument()
    })

    it('surfaces a "not connected" error when requestGitCreatePr returns false', () => {
      mockRequestGitCreatePr.mockReturnValue(false)
      render(<GitPanel />)
      seedBranch()
      fireEvent.click(screen.getByTestId('git-create-pr-open-btn'))
      fireEvent.click(screen.getByTestId('git-pr-submit-btn'))
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))

      expect(screen.getByTestId('git-pr-error')).toHaveTextContent('PR not sent — reconnect and try again')
    })

    it('closes the form on cancel', () => {
      render(<GitPanel />)
      seedBranch()
      fireEvent.click(screen.getByTestId('git-create-pr-open-btn'))
      expect(screen.getByTestId('git-pr-form')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('git-pr-cancel-btn'))
      expect(screen.queryByTestId('git-pr-form')).not.toBeInTheDocument()
    })
  })
})
