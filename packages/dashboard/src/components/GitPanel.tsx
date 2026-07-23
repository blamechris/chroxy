/**
 * GitPanel — dashboard git stage/commit UI (#6780).
 *
 * Mirrors the mobile app's GitView (packages/app/src/components/GitView.tsx):
 * a "Changes" tab (staged/unstaged/untracked file lists with stage/unstage
 * checkboxes + a commit-message box) and a read-only "Branches" tab (local +
 * remote, current branch marked). The wire messages (git_status / git_branches
 * / git_stage / git_unstage / git_commit) and their server-side handlers
 * (packages/server/src/ws-file-ops/git.js, packages/server/src/handlers/file-handlers.js)
 * already existed and are provider-agnostic — this is purely the dashboard's
 * store wiring (packages/dashboard/src/store/connection.ts + message-handler.ts)
 * and UI, following the same request/callback shape as the existing
 * DiffViewerPanel / FileBrowserPanel git-status wiring.
 *
 * In-app PR creation (#6876) IS implemented here: the "Create PR" toolbar
 * action opens a title/body/base form, confirmation-gates it, and fires the
 * git_create_pr wire message — the server pushes the current branch and shells
 * out to `gh pr create`, returning the PR URL (or a clear error) via
 * git_create_pr_result. Branch SWITCHING (checkout) is still follow-up work (no
 * wire message exists for it, and the mobile app's Branches tab is read-only).
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useConnectionStore } from '../store/connection'
import { ConfirmDialog } from './ConfirmDialog'
import type {
  GitFileStatus,
  GitStatusResult,
  GitBranchesResult,
  GitStageResult,
  GitCommitResult,
  GitCreatePrResult,
} from '../store/types'

type TabId = 'changes' | 'branches'

function statusLabel(status: GitFileStatus['status']): string {
  switch (status) {
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'unknown': return '?'
    default: return 'M'
  }
}

function statusClass(status: GitFileStatus['status']): string {
  switch (status) {
    case 'added': return 'git-status-added'
    case 'deleted': return 'git-status-deleted'
    case 'renamed': return 'git-status-renamed'
    case 'copied': return 'git-status-renamed'
    case 'unknown': return 'git-status-unknown'
    default: return 'git-status-modified'
  }
}

function FileRow({
  path, status, selected, onToggle,
}: {
  path: string
  status: GitFileStatus['status'] | 'untracked'
  selected: boolean
  onToggle: () => void
}) {
  const name = path.includes('/') ? path.split('/').pop()! : path
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  const cls = status === 'untracked' ? 'git-status-untracked' : statusClass(status)
  const label = status === 'untracked' ? 'U' : statusLabel(status)
  return (
    <label className="git-file-row" data-testid={`git-file-row-${path}`}>
      <input
        type="checkbox"
        className="git-file-checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`${selected ? 'Deselect' : 'Select'} ${path}`}
      />
      <span className={`git-status-badge ${cls}`}>{label}</span>
      <span className="git-file-path" title={path}>
        {dir && <span className="git-file-dir">{dir}</span>}
        <span className="git-file-name">{name}</span>
      </span>
    </label>
  )
}

export function GitPanel() {
  const setGitStatusCallback = useConnectionStore(s => s.setGitStatusCallback)
  const requestGitStatus = useConnectionStore(s => s.requestGitStatus)
  const setGitBranchesCallback = useConnectionStore(s => s.setGitBranchesCallback)
  const requestGitBranches = useConnectionStore(s => s.requestGitBranches)
  const setGitStageCallback = useConnectionStore(s => s.setGitStageCallback)
  const requestGitStage = useConnectionStore(s => s.requestGitStage)
  const requestGitUnstage = useConnectionStore(s => s.requestGitUnstage)
  const setGitCommitCallback = useConnectionStore(s => s.setGitCommitCallback)
  const requestGitCommit = useConnectionStore(s => s.requestGitCommit)
  const setGitCreatePrCallback = useConnectionStore(s => s.setGitCreatePrCallback)
  const requestGitCreatePr = useConnectionStore(s => s.requestGitCreatePr)
  const connectionPhase = useConnectionStore(s => s.connectionPhase)

  const [activeTab, setActiveTab] = useState<TabId>('changes')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [staged, setStaged] = useState<GitFileStatus[]>([])
  const [unstaged, setUnstaged] = useState<GitFileStatus[]>([])
  const [untracked, setUntracked] = useState<string[]>([])
  const [branches, setBranches] = useState<{ name: string; isCurrent: boolean; isRemote: boolean }[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [stagingInProgress, setStagingInProgress] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // #6875 review — commit is irreversible-ish; gate it behind a confirm dialog
  // for parity with the mobile app's GitView.handleCommit (which shows an
  // Alert "Commit N staged file(s)?" before committing).
  const [commitConfirmOpen, setCommitConfirmOpen] = useState(false)
  // #6876 — in-app PR creation form + confirmation + result state.
  const [prFormOpen, setPrFormOpen] = useState(false)
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [prBase, setPrBase] = useState('')
  const [prDraft, setPrDraft] = useState(false)
  const [prSubmitting, setPrSubmitting] = useState(false)
  const [prError, setPrError] = useState<string | null>(null)
  const [prCreatedUrl, setPrCreatedUrl] = useState<string | null>(null)
  const [prConfirmOpen, setPrConfirmOpen] = useState(false)

  // The single, DURABLE git_status_result handler. Stable identity (empty deps)
  // so the mount effect installs it exactly once, and — critically — so the
  // stage/commit success paths can re-fire `requestGitStatus()` WITHOUT ever
  // swapping this slot for a one-shot callback. The earlier version installed a
  // temporary status callback ending in `setGitStatusCallback(null)` after each
  // mutation, which tore down the durable handler with nothing to re-arm it: the
  // next Refresh (or a reconnect refresh) produced a git_status_result no
  // callback consumed, wedging the panel on "Loading git status…" until remount.
  const applyStatusResult = useCallback((result: GitStatusResult) => {
    setLoading(false)
    setStagingInProgress(false)
    setError(result.error)
    if (!result.error) {
      setBranch(result.branch)
      setStaged(result.staged)
      setUnstaged(result.unstaged)
      setUntracked(result.untracked)
    }
  }, [])

  const refreshStatus = useCallback(() => {
    setLoading(true)
    requestGitStatus()
  }, [requestGitStatus])

  // Wire the durable git_status_result callback (installed once; never swapped
  // out by a mutation — see applyStatusResult).
  useEffect(() => {
    setGitStatusCallback(applyStatusResult)
    return () => setGitStatusCallback(null)
  }, [setGitStatusCallback, applyStatusResult])

  // Wire the git_branches_result callback
  useEffect(() => {
    setGitBranchesCallback((result: GitBranchesResult) => {
      if (!result.error) setBranches(result.branches)
    })
    return () => setGitBranchesCallback(null)
  }, [setGitBranchesCallback])

  // Request status + branches once connected
  useEffect(() => {
    if (connectionPhase !== 'connected') return
    refreshStatus()
    requestGitBranches()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionPhase])

  const toggleSelection = useCallback((path: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const stagedPaths = useMemo(() => new Set(staged.map(f => f.path)), [staged])
  const unstagedPaths = useMemo(() => new Set(unstaged.map(f => f.path)), [unstaged])
  const untrackedSet = useMemo(() => new Set(untracked), [untracked])

  const hasUnstagedSelected = useMemo(
    () => Array.from(selectedPaths).some(p => unstagedPaths.has(p) || untrackedSet.has(p)),
    [selectedPaths, unstagedPaths, untrackedSet],
  )
  const hasStagedSelected = useMemo(
    () => Array.from(selectedPaths).some(p => stagedPaths.has(p)),
    [selectedPaths, stagedPaths],
  )

  // Shared stage/unstage mutation runner: arms the (one-shot) git_stage_result
  // callback, fires the request, and on success re-fetches git_status. The
  // refresh is consumed by the DURABLE status handler (applyStatusResult) —
  // this path only ever touches the stage slot, never the status slot, so the
  // durable handler survives every mutation (the wedge fix). `request` is
  // requestGitStage or requestGitUnstage (both return false when the socket
  // is closed, mirroring the app's #6288 not-connected guard).
  const performMutation = useCallback((
    paths: string[],
    request: (paths: string[]) => boolean,
    notConnectedMessage: string,
  ) => {
    if (paths.length === 0) return
    setActionError(null)
    setStagingInProgress(true)
    setGitStageCallback((result: GitStageResult) => {
      setGitStageCallback(null)
      if (result.error) {
        setStagingInProgress(false)
        setActionError(result.error)
        return
      }
      setSelectedPaths(new Set())
      // The durable status handler consumes this refresh and clears
      // stagingInProgress once the fresh file lists land.
      requestGitStatus()
    })
    if (!request(paths)) {
      setGitStageCallback(null)
      setStagingInProgress(false)
      setActionError(notConnectedMessage)
    }
  }, [setGitStageCallback, requestGitStatus])

  const handleStageSelected = useCallback(() => {
    const paths = Array.from(selectedPaths).filter(p => unstagedPaths.has(p) || untrackedSet.has(p))
    performMutation(paths, requestGitStage, 'Stage not sent — reconnect and try again')
  }, [selectedPaths, unstagedPaths, untrackedSet, performMutation, requestGitStage])

  const handleUnstageSelected = useCallback(() => {
    const paths = Array.from(selectedPaths).filter(p => stagedPaths.has(p))
    performMutation(paths, requestGitUnstage, 'Unstage not sent — reconnect and try again')
  }, [selectedPaths, stagedPaths, performMutation, requestGitUnstage])

  const handleStageAll = useCallback(() => {
    const paths = [...unstaged.map(f => f.path), ...untracked]
    performMutation(paths, requestGitStage, 'Stage not sent — reconnect and try again')
  }, [unstaged, untracked, performMutation, requestGitStage])

  const handleUnstageAll = useCallback(() => {
    performMutation(staged.map(f => f.path), requestGitUnstage, 'Unstage not sent — reconnect and try again')
  }, [staged, performMutation, requestGitUnstage])

  // Commit-button click: empty-message + nothing-staged guard, then open the
  // confirmation dialog (#6875 review — parity with the mobile app's
  // "Commit N staged file(s)?" gate; commit is irreversible-ish).
  const handleCommitClick = useCallback(() => {
    const msg = commitMessage.trim()
    // Empty-message guard: the server rejects an empty commit message too
    // (packages/server/src/ws-file-ops/git.js gitCommit), but guarding here
    // avoids a round-trip and matches the app's disabled-button behavior.
    if (!msg || staged.length === 0) return
    setCommitConfirmOpen(true)
  }, [commitMessage, staged.length])

  // Confirmed commit: fires git_commit; on success clears the message and
  // re-fetches status via the DURABLE handler (never swaps the status slot).
  const handleCommitConfirmed = useCallback(() => {
    setCommitConfirmOpen(false)
    const msg = commitMessage.trim()
    if (!msg || staged.length === 0) return
    setActionError(null)
    setCommitting(true)
    setGitCommitCallback((result: GitCommitResult) => {
      setGitCommitCallback(null)
      setCommitting(false)
      if (result.error) {
        setActionError(result.error)
        return
      }
      setCommitMessage('')
      // The durable status handler consumes this refresh.
      requestGitStatus()
    })
    if (!requestGitCommit(msg)) {
      setGitCommitCallback(null)
      setCommitting(false)
      setActionError('Commit not sent — reconnect and try again')
    }
  }, [commitMessage, staged.length, setGitCommitCallback, requestGitCommit, requestGitStatus])

  // #6876 — open the Create-PR form. Prefill the title with the current branch
  // name (a sensible default the operator can edit) and clear any prior result.
  const openPrForm = useCallback(() => {
    setPrError(null)
    setPrCreatedUrl(null)
    setPrTitle(prev => prev || branch || '')
    setPrFormOpen(true)
  }, [branch])

  const closePrForm = useCallback(() => {
    setPrFormOpen(false)
    setPrConfirmOpen(false)
  }, [])

  // Create-PR submit: empty-title guard, then open the confirmation dialog
  // (AC: the action must be confirmation-gated).
  const handleCreatePrClick = useCallback(() => {
    if (!prTitle.trim() || prSubmitting) return
    setPrConfirmOpen(true)
  }, [prTitle, prSubmitting])

  // Confirmed PR creation: arms the one-shot git_create_pr_result callback,
  // fires git_create_pr, and on success shows the PR URL. Mirrors the commit
  // flow's not-connected guard (requestGitCreatePr returns false on a closed
  // socket).
  const handleCreatePrConfirmed = useCallback(() => {
    setPrConfirmOpen(false)
    const title = prTitle.trim()
    if (!title) return
    setPrError(null)
    setPrCreatedUrl(null)
    setPrSubmitting(true)
    setGitCreatePrCallback((result: GitCreatePrResult) => {
      setGitCreatePrCallback(null)
      setPrSubmitting(false)
      if (result.error || !result.url) {
        setPrError(result.error || 'PR creation failed')
        return
      }
      setPrCreatedUrl(result.url)
      // Refresh branches so the just-pushed branch's remote tracking shows.
      requestGitBranches()
    })
    const sent = requestGitCreatePr({
      title,
      body: prBody.trim() || undefined,
      base: prBase.trim() || undefined,
      draft: prDraft || undefined,
    })
    if (!sent) {
      setGitCreatePrCallback(null)
      setPrSubmitting(false)
      setPrError('PR not sent — reconnect and try again')
    }
  }, [prTitle, prBody, prBase, prDraft, setGitCreatePrCallback, requestGitCreatePr, requestGitBranches])

  const hasChanges = staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  const localBranches = useMemo(() => branches.filter(b => !b.isRemote), [branches])
  const remoteBranches = useMemo(() => branches.filter(b => b.isRemote), [branches])

  return (
    <div className="git-panel" data-testid="git-panel">
      <div className="git-toolbar">
        <div className="git-tabs">
          <button
            type="button"
            className={`git-tab${activeTab === 'changes' ? ' active' : ''}`}
            onClick={() => setActiveTab('changes')}
          >
            Changes
          </button>
          <button
            type="button"
            className={`git-tab${activeTab === 'branches' ? ' active' : ''}`}
            onClick={() => setActiveTab('branches')}
          >
            Branches
          </button>
        </div>
        <div className="git-toolbar-right">
          {branch && (
            <span className="git-branch-badge" title={`Branch: ${branch}`}>{branch}</span>
          )}
          {branch && (
            <button
              type="button"
              className="git-refresh-btn git-create-pr-btn"
              onClick={() => (prFormOpen ? closePrForm() : openPrForm())}
              title="Open a pull request for the current branch"
              data-testid="git-create-pr-open-btn"
            >
              Create PR
            </button>
          )}
          <button type="button" className="git-refresh-btn" onClick={refreshStatus} title="Refresh git status">
            Refresh
          </button>
        </div>
      </div>

      {/* #6876 — in-app PR creation form. Independent of the Changes/Branches
          tab (it acts on the whole branch). Confirmation-gated via ConfirmDialog. */}
      {prFormOpen && (
        <div className="git-pr-form" data-testid="git-pr-form">
          <div className="git-pr-form-header">
            <span className="git-pr-form-title">Open pull request</span>
            <span className="git-pr-form-branchline" data-testid="git-pr-headline">
              {branch}{prBase.trim() ? ` → ${prBase.trim()}` : ''}
            </span>
          </div>
          {prCreatedUrl ? (
            <div className="git-pr-success" data-testid="git-pr-success">
              <span>Pull request opened:</span>
              <a href={prCreatedUrl} target="_blank" rel="noreferrer" data-testid="git-pr-url">{prCreatedUrl}</a>
              <button type="button" className="git-section-action" onClick={closePrForm} data-testid="git-pr-done-btn">
                Done
              </button>
            </div>
          ) : (
            <>
              {prError && <div className="git-action-error" data-testid="git-pr-error">{prError}</div>}
              <input
                type="text"
                className="git-pr-input"
                placeholder="Pull request title"
                value={prTitle}
                onChange={e => setPrTitle(e.target.value)}
                maxLength={500}
                disabled={prSubmitting}
                data-testid="git-pr-title-input"
              />
              <textarea
                className="git-pr-input git-pr-body"
                placeholder="Description (optional)"
                value={prBody}
                onChange={e => setPrBody(e.target.value)}
                maxLength={50000}
                disabled={prSubmitting}
                data-testid="git-pr-body-input"
              />
              <input
                type="text"
                className="git-pr-input"
                placeholder="Base branch (optional — defaults to the repo default)"
                value={prBase}
                onChange={e => setPrBase(e.target.value)}
                maxLength={255}
                disabled={prSubmitting}
                data-testid="git-pr-base-input"
              />
              <label className="git-pr-draft">
                <input
                  type="checkbox"
                  checked={prDraft}
                  onChange={e => setPrDraft(e.target.checked)}
                  disabled={prSubmitting}
                  data-testid="git-pr-draft-checkbox"
                />
                Create as draft
              </label>
              <div className="git-pr-actions">
                <button
                  type="button"
                  className="git-commit-btn git-pr-submit"
                  onClick={handleCreatePrClick}
                  disabled={!prTitle.trim() || prSubmitting}
                  data-testid="git-pr-submit-btn"
                >
                  {prSubmitting ? 'Opening…' : 'Create pull request'}
                </button>
                <button
                  type="button"
                  className="git-section-action"
                  onClick={closePrForm}
                  disabled={prSubmitting}
                  data-testid="git-pr-cancel-btn"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {loading && <div className="git-loading">Loading git status...</div>}
      {!loading && error && <div className="git-error">{error}</div>}

      {!loading && !error && activeTab === 'changes' && (
        <div className="git-changes" data-testid="git-changes-tab">
          {actionError && <div className="git-action-error" data-testid="git-action-error">{actionError}</div>}

          {staged.length > 0 && (
            <div className="git-section" data-testid="git-staged-section">
              <div className="git-section-header">
                <span className="git-section-title">Staged ({staged.length})</span>
                <button type="button" className="git-section-action" onClick={handleUnstageAll} disabled={stagingInProgress}>
                  Unstage all
                </button>
              </div>
              {staged.map(f => (
                <FileRow
                  key={`staged-${f.path}`}
                  path={f.path}
                  status={f.status}
                  selected={selectedPaths.has(f.path)}
                  onToggle={() => toggleSelection(f.path)}
                />
              ))}
            </div>
          )}

          {unstaged.length > 0 && (
            <div className="git-section" data-testid="git-unstaged-section">
              <div className="git-section-header">
                <span className="git-section-title">Changes ({unstaged.length})</span>
                <button type="button" className="git-section-action" onClick={handleStageAll} disabled={stagingInProgress}>
                  Stage all
                </button>
              </div>
              {unstaged.map(f => (
                <FileRow
                  key={`unstaged-${f.path}`}
                  path={f.path}
                  status={f.status}
                  selected={selectedPaths.has(f.path)}
                  onToggle={() => toggleSelection(f.path)}
                />
              ))}
            </div>
          )}

          {untracked.length > 0 && (
            <div className="git-section" data-testid="git-untracked-section">
              <div className="git-section-header">
                <span className="git-section-title">Untracked ({untracked.length})</span>
                <button type="button" className="git-section-action" onClick={handleStageAll} disabled={stagingInProgress}>
                  Stage all
                </button>
              </div>
              {untracked.map(p => (
                <FileRow
                  key={`untracked-${p}`}
                  path={p}
                  status="untracked"
                  selected={selectedPaths.has(p)}
                  onToggle={() => toggleSelection(p)}
                />
              ))}
            </div>
          )}

          {!hasChanges && <div className="git-empty">Working tree clean</div>}

          {selectedPaths.size > 0 && (
            <div className="git-action-bar">
              {hasUnstagedSelected && (
                <button
                  type="button"
                  className="git-action-btn git-action-stage"
                  onClick={handleStageSelected}
                  disabled={stagingInProgress}
                  data-testid="git-stage-selected-btn"
                >
                  {stagingInProgress ? 'Staging…' : 'Stage selected'}
                </button>
              )}
              {hasStagedSelected && (
                <button
                  type="button"
                  className="git-action-btn git-action-unstage"
                  onClick={handleUnstageSelected}
                  disabled={stagingInProgress}
                  data-testid="git-unstage-selected-btn"
                >
                  {stagingInProgress ? 'Unstaging…' : 'Unstage selected'}
                </button>
              )}
            </div>
          )}

          {staged.length > 0 && (
            <div className="git-commit-area">
              <textarea
                className="git-commit-input"
                placeholder="Commit message..."
                value={commitMessage}
                onChange={e => setCommitMessage(e.target.value)}
                maxLength={2000}
                disabled={committing}
                data-testid="git-commit-input"
              />
              <button
                type="button"
                className="git-commit-btn"
                onClick={handleCommitClick}
                disabled={!commitMessage.trim() || committing}
                data-testid="git-commit-btn"
              >
                {committing ? 'Committing…' : `Commit ${staged.length} file${staged.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}
        </div>
      )}

      {!loading && !error && activeTab === 'branches' && (
        <div className="git-branches" data-testid="git-branches-tab">
          {localBranches.length > 0 && (
            <div className="git-section">
              <span className="git-section-title">Local ({localBranches.length})</span>
              {localBranches.map(b => (
                <div key={b.name} className={`git-branch-row${b.isCurrent ? ' is-current' : ''}`}>
                  {b.isCurrent && <span className="git-branch-current-mark">✓</span>}
                  <span className="git-branch-name">{b.name}</span>
                </div>
              ))}
            </div>
          )}
          {remoteBranches.length > 0 && (
            <div className="git-section">
              <span className="git-section-title">Remote ({remoteBranches.length})</span>
              {remoteBranches.map(b => (
                <div key={b.name} className="git-branch-row git-branch-row--remote">
                  <span className="git-branch-name">{b.name}</span>
                </div>
              ))}
            </div>
          )}
          {branches.length === 0 && <div className="git-empty">No branches found</div>}
        </div>
      )}

      {/* #6875 review — commit confirmation (parity with the mobile app's
          "Commit N staged file(s)?" gate). Reuses the dashboard's shared
          ConfirmDialog, the same primitive other destructive actions use. */}
      <ConfirmDialog
        open={commitConfirmOpen}
        title="Commit staged changes?"
        confirmLabel="Commit"
        message={
          <>
            Commit {staged.length} staged file{staged.length !== 1 ? 's' : ''}
            {branch ? <> on <b>{branch}</b></> : null}?
          </>
        }
        onConfirm={handleCommitConfirmed}
        onCancel={() => setCommitConfirmOpen(false)}
      />

      {/* #6876 — PR-creation confirmation (AC: the action must be
          confirmation-gated). Pushes the branch + opens the PR on confirm. */}
      <ConfirmDialog
        open={prConfirmOpen}
        title="Open a pull request?"
        confirmLabel="Create PR"
        message={
          <>
            Push <b>{branch}</b> and open a pull request
            {prBase.trim() ? <> into <b>{prBase.trim()}</b></> : <> into the default branch</>}?
          </>
        }
        onConfirm={handleCreatePrConfirmed}
        onCancel={() => setPrConfirmOpen(false)}
      />
    </div>
  )
}
