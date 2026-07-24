/**
 * MemoryPanel (#6867, epic #6760) — dashboard memory panel.
 *
 * Renders the effective merged CLAUDE.md stack (global → project → local,
 * Claude Code's own load/precedence order, with recursively-resolved
 * @imports inlined depth-first right after the file that referenced them) in
 * the order the server returns it — so the list itself IS the precedence
 * order: earlier entries are loaded first, a later scope (local) overrides an
 * earlier one (global/project). Also surfaces the project's auto-generated
 * MEMORY.md as a browsable read view.
 *
 * Wiring: consumes the `memory_read` / `memory_stack_result` wire pair
 * (#6864, PR #6969) via the dashboard store — requestMemoryRead() sends the
 * request, handleMemoryStackResult (store/message-handler.ts) writes the
 * reply into memoryStackEntries/memoryStackFile/memoryStackError
 * (store/connection.ts). Mirrors the request/state-field shape
 * requestHostStatus + hostStatus already use (not the one-shot-callback shape
 * GitPanel's mutations use, since this is a plain read-and-display survey).
 *
 * READ-ONLY for v1. The parent issue's AC also asks for edit+save parity
 * with the mobile app's full-screen FileEditor (reusing the existing
 * write_file endpoint, gated by rejectMutationIfBound). That's deferred to a
 * follow-up: the dashboard has ZERO client-side write plumbing today
 * (write_file_result is an app-only wire type per the store-core contract
 * fixtures, #5653 — FileBrowserPanel is read-only, confirmed by the IDE epic
 * #6469), and the issue itself calls for reconciling the write path with the
 * overlapping #6478 IDE P3 editable-file-browser slice first, to avoid
 * shipping two divergent dashboard write paths. See the PR body for the
 * follow-up issue link.
 *
 * Render safety: CLAUDE.md content is arbitrary, untrusted text. Every
 * entry's content renders through MarkdownBody — the same sanitized
 * renderMarkdown() + DOMPurify pipeline chat messages use (including the
 * #6986 link-scheme allowlist) — never a raw dangerouslySetInnerHTML of file
 * content.
 */
import { useCallback, useEffect, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import { MarkdownBody } from './MarkdownBody'
import type { MemoryFileDescriptor, MemoryStackEntry } from '../store/types'

const SCOPE_LABEL: Record<MemoryStackEntry['scope'], string> = {
  global: 'Global',
  project: 'Project',
  local: 'Local',
  import: '@import',
}

function entryState(d: MemoryFileDescriptor): { label: string; cls: string } {
  if (d.skipped) return { label: 'Skipped', cls: 'skipped' }
  if (d.error) return { label: 'Error', cls: 'error' }
  if (d.exists) return { label: 'Present', cls: 'exists' }
  return { label: 'Not present', cls: 'missing' }
}

function DescriptorHeader({
  descriptor, canExpand, expanded, onToggle, testId, children,
}: {
  descriptor: MemoryFileDescriptor
  canExpand: boolean
  expanded: boolean
  onToggle: () => void
  testId: string
  children?: React.ReactNode
}) {
  const state = entryState(descriptor)
  return (
    <button
      type="button"
      className="memory-entry-header"
      onClick={onToggle}
      disabled={!canExpand}
      data-testid={testId}
    >
      {children}
      <span className="memory-entry-path" title={descriptor.path ?? undefined}>
        {descriptor.path ?? '(unresolved)'}
      </span>
      <span className={`memory-entry-state memory-entry-state-${state.cls}`}>{state.label}</span>
      {descriptor.truncated && <span className="memory-entry-truncated">Truncated</span>}
      {canExpand && <span className="memory-entry-caret">{expanded ? '▾' : '▸'}</span>}
    </button>
  )
}

function EntryRow({ entry, index }: { entry: MemoryStackEntry; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const canExpand = entry.exists && !entry.skipped && !entry.error && !!entry.content
  return (
    <div className={`memory-entry memory-entry-scope-${entry.scope}`} data-testid={`memory-entry-${index}`}>
      <DescriptorHeader
        descriptor={entry}
        canExpand={canExpand}
        expanded={expanded}
        onToggle={() => canExpand && setExpanded((e) => !e)}
        testId={`memory-entry-toggle-${index}`}
      >
        <span
          className="memory-entry-precedence"
          title="Load order — later entries take precedence over earlier ones"
        >
          {index + 1}
        </span>
        <span className={`memory-scope-badge memory-scope-${entry.scope}`}>{SCOPE_LABEL[entry.scope]}</span>
        {entry.importedFrom && (
          <span className="memory-entry-imported-from" title={`Imported from ${entry.importedFrom}`}>
            via {entry.importedFrom.split('/').pop()}
          </span>
        )}
      </DescriptorHeader>
      {entry.error && (
        <div
          className={entry.skipped ? 'memory-entry-skip-reason' : 'memory-entry-error'}
          data-testid={`memory-entry-error-${index}`}
        >
          {entry.error}
        </div>
      )}
      {expanded && canExpand && (
        <div className="memory-entry-content" data-testid={`memory-entry-content-${index}`}>
          <MarkdownBody content={entry.content!} />
        </div>
      )}
    </div>
  )
}

function MemoryFileSection({ file }: { file: MemoryFileDescriptor }) {
  const [expanded, setExpanded] = useState(false)
  const canExpand = file.exists && !file.skipped && !file.error && !!file.content
  return (
    <div className="memory-file-section" data-testid="memory-file-section">
      <div className="memory-section-title">Auto-generated memory (MEMORY.md)</div>
      <DescriptorHeader
        descriptor={file}
        canExpand={canExpand}
        expanded={expanded}
        onToggle={() => canExpand && setExpanded((e) => !e)}
        testId="memory-file-toggle"
      />
      {file.error && (
        <div
          className={file.skipped ? 'memory-entry-skip-reason' : 'memory-entry-error'}
          data-testid="memory-file-error"
        >
          {file.error}
        </div>
      )}
      {expanded && canExpand && (
        <div className="memory-entry-content" data-testid="memory-file-content">
          <MarkdownBody content={file.content!} />
        </div>
      )}
    </div>
  )
}

export function MemoryPanel() {
  const connectionPhase = useConnectionStore((s) => s.connectionPhase)
  const requestMemoryRead = useConnectionStore((s) => s.requestMemoryRead)
  const entries = useConnectionStore((s) => s.memoryStackEntries)
  const memoryFile = useConnectionStore((s) => s.memoryStackFile)
  const stackError = useConnectionStore((s) => s.memoryStackError)
  const loading = useConnectionStore((s) => s.memoryStackLoading)
  // #6996 review — memory_read has no client-supplied sessionId; the server
  // scopes the CLAUDE.md stack to the caller's *active* session cwd, so a
  // reply is only valid for whichever session was active when the request
  // went out. switchSession() resets memoryStackEntries to null on every
  // switch so a stale stack is never rendered against the new session, but
  // that reset alone only re-triggers a fetch if this effect re-runs. Keying
  // the effect on activeSessionId (not just connectionPhase) guarantees the
  // refetch fires on a switch even if App.tsx ever stops unmounting this
  // panel across a session change (App.tsx's chat/terminal/system panes
  // already use a kept-alive display:none pattern instead of unmount/remount
  // — #4305/#4397 — so this panel should not depend on staying unmounted).
  const activeSessionId = useConnectionStore((s) => s.activeSessionId)

  const refresh = useCallback(() => {
    requestMemoryRead()
  }, [requestMemoryRead])

  // Request on mount / reconnect / session switch if nothing has loaded yet
  // for the current session — mirrors GitPanel's "request status once
  // connected" effect, plus the activeSessionId key described above.
  useEffect(() => {
    if (connectionPhase !== 'connected') return
    if (entries === null && !loading) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionPhase, activeSessionId])

  return (
    <div className="memory-panel" data-testid="memory-panel">
      <div className="memory-toolbar">
        <span className="memory-toolbar-title">Memory</span>
        <button
          type="button"
          className="memory-refresh-btn"
          onClick={refresh}
          disabled={loading}
          data-testid="memory-refresh-btn"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {loading && entries === null && (
        <div className="memory-loading" data-testid="memory-loading">Loading memory stack…</div>
      )}

      {!loading && stackError && (
        <div className="memory-error" data-testid="memory-stack-error">{stackError}</div>
      )}

      {!stackError && entries !== null && (
        <div className="memory-stack" data-testid="memory-stack">
          <div className="memory-section-title">
            Effective CLAUDE.md stack — later entries override earlier ones
          </div>
          {entries.length === 0 && (
            <div className="memory-empty" data-testid="memory-stack-empty">No memory files found</div>
          )}
          {entries.map((entry, i) => (
            <EntryRow key={`${entry.scope}-${entry.path ?? 'unresolved'}-${i}`} entry={entry} index={i} />
          ))}
        </div>
      )}

      {!stackError && memoryFile && <MemoryFileSection file={memoryFile} />}
    </div>
  )
}
