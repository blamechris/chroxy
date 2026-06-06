/**
 * ActivityTree (#5176, epic #5170) — the reusable, read-only live tree of a
 * single session's in-flight work (subagents, background shells, long-running
 * tools), each with a kind icon, status badge, a live-ticking elapsed timer,
 * and an expand-to-output affordance.
 *
 * This is the presentational core extracted from the retired Control Room v1
 * sidebar panel (`ControlRoomPanel`, #5163). The same tree now drills down
 * inside the main-tab `ControlRoomSection` (#5176): when an operator expands a
 * repo row, the repo's active chroxy session is mapped to its activity tree and
 * rendered here. Keeping one implementation means the v1 reducer / protocol /
 * `selectActivityTree` stay the single source of truth for the tree shape.
 *
 * Control actions (#5272, epic #5159 Phase 2a): when an `onCancelActivity`
 * callback is supplied, a Cancel button appears on running SUBAGENT nodes only.
 * Background shells and tool calls are NOT individually cancellable (chroxy
 * doesn't own those processes — see activity-registry.js / the #5269 server
 * work), so they get no cancel affordance; whole-turn interruption lives on the
 * section heading, not here. Without the callback the tree stays read-only.
 *
 * Blocked-on-input entries are visually prominent and tie into the dashboard's
 * intervention convention (#4891): a blocked entry pulses the same accent the
 * intervention surface uses so the operator's eye lands on "this needs you".
 */
import { useCallback, useEffect, useState } from 'react'
import type { ActivityEntry, ActivityState, ActivityTreeNode } from '@chroxy/store-core'
import { selectActivityTree } from '@chroxy/store-core'

export interface ActivityTreeProps {
  /** Whole-store activity state (one tree per session). */
  activity: ActivityState
  /** Session whose tree is rendered. Null → renders the empty state. */
  sessionId: string | null
  /**
   * Injectable clock for deterministic tests. Defaults to `Date.now`. Used by
   * the elapsed timer; production passes nothing.
   */
  now?: () => number
  /**
   * #5272: cancel a non-terminal subagent node by its entry id. When omitted the
   * tree is read-only (no cancel buttons). Only ever invoked for `agent` nodes
   * that are still live — i.e. `running` OR `blocked` (a blocked/waiting subagent
   * is exactly the kind an operator wants to abort). Terminal agents (done /
   * failed) and non-agent nodes (shells / tools) never get a cancel affordance.
   */
  onCancelActivity?: (activityId: string) => void
}

// Stable empty tree for the null-session case so we don't allocate a new array
// each render (keeps the `hasLiveEntry` / render path referentially cheap).
const EMPTY_TREE: readonly ActivityTreeNode[] = []

// Kind → glyph. Kept ASCII-ish so it renders in a small font without needing
// an icon font. Mirrors the kinds in the protocol `ActivityKindSchema`
// (agent / shell / tool).
const KIND_ICON: Record<ActivityEntry['kind'], string> = {
  agent: '◆',
  shell: '$',
  tool: '⚙',
}

const KIND_LABEL: Record<ActivityEntry['kind'], string> = {
  agent: 'Subagent',
  shell: 'Background shell',
  tool: 'Tool',
}

const STATUS_LABEL: Record<ActivityEntry['status'], string> = {
  running: 'Running',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
}

function isTerminal(status: ActivityEntry['status']): boolean {
  return status === 'done' || status === 'failed'
}

/**
 * Format an elapsed duration (ms) as a compact `h:mm:ss` / `m:ss` / `Ns`
 * string. Negative input (clock skew between server `startedAt` and the client
 * clock) clamps to 0 so the timer never shows a negative value.
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const sec = totalSec % 60
  const min = Math.floor(totalSec / 60) % 60
  const hr = Math.floor(totalSec / 3600)
  if (hr > 0) return `${hr}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  if (min > 0) return `${min}:${String(sec).padStart(2, '0')}`
  return `${sec}s`
}

/**
 * Whether ANY entry in the tree is still live (running/blocked). Drives the
 * shared ticking interval: we only run a timer while something is in flight, so
 * a tree of only-terminal entries doesn't keep a 1s interval alive (no
 * memory-leaking interval — #4304 panel convention).
 */
function hasLiveEntry(nodes: readonly ActivityTreeNode[]): boolean {
  for (const node of nodes) {
    if (!isTerminal(node.entry.status)) return true
    if (hasLiveEntry(node.children)) return true
  }
  return false
}

/**
 * Live-ticking "now" that only runs an interval while `enabled`. Returns the
 * current clock value, refreshed every second. When disabled (no live
 * entries), no interval is created and the last value is held — terminal
 * entries freeze their elapsed at `endedAt` anyway, so the held value is
 * irrelevant to them. The interval is always cleared on unmount / dep change,
 * so it can't leak.
 */
function useTick(enabled: boolean, now: () => number): number {
  const [tick, setTick] = useState(() => now())
  useEffect(() => {
    if (!enabled) return
    // Refresh immediately so a freshly-enabled timer doesn't show a stale
    // value for up to a second, then tick every second.
    setTick(now())
    const id = window.setInterval(() => setTick(now()), 1000)
    return () => window.clearInterval(id)
  }, [enabled, now])
  return tick
}

interface EntryRowProps {
  entry: ActivityEntry
  depth: number
  now: number
  expanded: boolean
  onToggleExpand: (id: string) => void
  onCancelActivity?: (activityId: string) => void
}

function EntryRow({ entry, depth, now, expanded, onToggleExpand, onCancelActivity }: EntryRowProps) {
  const terminal = isTerminal(entry.status)
  const blocked = entry.status === 'blocked'
  // Terminal entries freeze elapsed at endedAt; live entries tick from `now`.
  const elapsedMs = (terminal && entry.endedAt !== undefined ? entry.endedAt : now) - entry.startedAt

  const rowClass =
    `control-room-entry status-${entry.status}` + (blocked ? ' control-room-entry-blocked' : '')

  // #5272: only non-terminal SUBAGENTS are individually cancellable — i.e.
  // `running` OR `blocked` (a blocked subagent is stuck/waiting and is exactly
  // what an operator wants to abort, so it stays cancellable). Shells/tools
  // aren't cancellable (chroxy doesn't own them) and terminal nodes (done /
  // failed) are already finished, so they get no button. The cancel button is a
  // SIBLING of the toggle button (not nested — that would be invalid HTML and
  // swallow its own click).
  const canCancel = onCancelActivity !== undefined && entry.kind === 'agent' && !terminal

  return (
    <li
      className="control-room-entry-row"
      data-testid={`control-room-entry-${entry.id}`}
    >
      <div className="control-room-entry-rowline">
        <button
          type="button"
          className={rowClass}
          // Indent children by depth. paddingLeft keeps the whole row clickable
          // (vs a margin that would leave dead gutter).
          style={{ paddingLeft: 6 + depth * 14 }}
          aria-expanded={expanded}
          data-status={entry.status}
          data-testid={`control-room-entry-toggle-${entry.id}`}
          onClick={() => onToggleExpand(entry.id)}
          title={`${KIND_LABEL[entry.kind]} · ${STATUS_LABEL[entry.status]}`}
        >
          <span className="control-room-entry-icon" aria-hidden="true">
            {KIND_ICON[entry.kind]}
          </span>
          <span className="control-room-entry-label" data-testid={`control-room-entry-label-${entry.id}`}>
            {entry.label || KIND_LABEL[entry.kind]}
          </span>
          <span
            className={`control-room-status-badge status-${entry.status}`}
            data-testid={`control-room-status-${entry.id}`}
            // The badge's colour is the only signal of status; an explicit label
            // keeps it accessible to screen readers and colour-blind users.
            role="status"
            aria-label={`Status: ${STATUS_LABEL[entry.status]}`}
          >
            {STATUS_LABEL[entry.status]}
          </span>
          <span
            className="control-room-entry-elapsed"
            data-testid={`control-room-elapsed-${entry.id}`}
            // Elapsed is decorative against the label; give SR users context.
            aria-label={`Elapsed ${formatElapsed(elapsedMs)}`}
          >
            {formatElapsed(elapsedMs)}
          </span>
        </button>
        {canCancel && (
          <button
            type="button"
            className="control-room-cancel-btn"
            data-testid={`control-room-cancel-${entry.id}`}
            onClick={() => onCancelActivity!(entry.id)}
            title={`Cancel ${entry.label || KIND_LABEL[entry.kind]}`}
            aria-label={`Cancel subagent ${entry.label || ''}`.trim()}
          >
            Cancel
          </button>
        )}
      </div>
      {expanded && (
        <div
          className="control-room-entry-output"
          data-testid={`control-room-output-${entry.id}`}
        >
          <div className="control-room-output-row">
            <span className="control-room-output-key">Kind</span>
            <span className="control-room-output-val">{KIND_LABEL[entry.kind]}</span>
          </div>
          <div className="control-room-output-row">
            <span className="control-room-output-key">Status</span>
            <span className="control-room-output-val">{STATUS_LABEL[entry.status]}</span>
          </div>
          {entry.outputRef ? (
            <div className="control-room-output-row">
              <span className="control-room-output-key">Output</span>
              <span
                className="control-room-output-val control-room-output-ref"
                data-testid={`control-room-output-ref-${entry.id}`}
              >
                {entry.outputRef.kind}: {entry.outputRef.id}
              </span>
            </div>
          ) : (
            <div className="control-room-output-empty" data-testid={`control-room-output-empty-${entry.id}`}>
              No linked output yet
            </div>
          )}
        </div>
      )}
    </li>
  )
}

interface EntryTreeProps {
  nodes: readonly ActivityTreeNode[]
  depth: number
  now: number
  expandedIds: ReadonlySet<string>
  onToggleExpand: (id: string) => void
  onCancelActivity?: (activityId: string) => void
}

function EntryTree({ nodes, depth, now, expandedIds, onToggleExpand, onCancelActivity }: EntryTreeProps) {
  return (
    <ul className="control-room-entry-list" data-testid={depth === 0 ? 'control-room-tree' : undefined}>
      {nodes.map((node) => (
        <li key={node.entry.id} className="control-room-entry-group">
          <ul className="control-room-entry-list-inner">
            <EntryRow
              entry={node.entry}
              depth={depth}
              now={now}
              expanded={expandedIds.has(node.entry.id)}
              onToggleExpand={onToggleExpand}
              onCancelActivity={onCancelActivity}
            />
          </ul>
          {node.children.length > 0 && (
            <EntryTree
              nodes={node.children}
              depth={depth + 1}
              now={now}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onCancelActivity={onCancelActivity}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

export function ActivityTree({ activity, sessionId, now = Date.now, onCancelActivity }: ActivityTreeProps) {
  // Only query the reducer for a real session — a null id has no tree, and
  // selecting with an empty-string id would do pointless work (and could match
  // a degenerate "" session key). The empty-state branch below renders for null.
  const tree = sessionId !== null ? selectActivityTree(activity, sessionId) : EMPTY_TREE
  const live = hasLiveEntry(tree)
  const tick = useTick(live, now)

  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())
  // `ActivityEntry.id` is only unique WITHIN a session, so the expansion set
  // must be scoped to the rendered session — otherwise switching sessions could
  // auto-expand a colliding id in the new session or carry UI state across
  // unrelated sessions. Reset on every session change.
  useEffect(() => {
    setExpandedIds(new Set())
  }, [sessionId])
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (sessionId === null) {
    return (
      <div className="control-room-panel" data-testid="control-room-panel">
        <div className="control-room-empty" data-testid="control-room-empty">
          No active session
        </div>
      </div>
    )
  }

  if (tree.length === 0) {
    return (
      <div className="control-room-panel" data-testid="control-room-panel">
        <div className="control-room-empty" data-testid="control-room-empty">
          No activity in flight
        </div>
      </div>
    )
  }

  return (
    <div className="control-room-panel" data-testid="control-room-panel">
      <EntryTree
        nodes={tree}
        depth={0}
        now={tick}
        expandedIds={expandedIds}
        onToggleExpand={handleToggleExpand}
        onCancelActivity={onCancelActivity}
      />
    </div>
  )
}
