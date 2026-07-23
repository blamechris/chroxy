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
 * Branch SWITCHING (checkout) and PR creation are NOT implemented here — no
 * wire message exists for either today (the server's createGitOps only
 * exposes status/branches/stage/unstage/commit), and the mobile app's own
 * Branches tab is read-only too. Both are follow-up work.
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
          <button type="button" className="git-refresh-btn" onClick={refreshStatus} title="Refresh git status">
            Refresh
          </button>
        </div>
      </div>

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
    </div>
  )
}
