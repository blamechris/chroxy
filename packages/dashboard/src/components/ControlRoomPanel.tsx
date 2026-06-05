/**
 * ControlRoomPanel (#5163, epic #5159) — the v1 user-facing surface of the
 * Control Room: a read-only live tree of everything in flight inside the
 * active session (subagents, background shells, long-running tools), each with
 * a status badge, a live-ticking elapsed timer, a kind icon, and an
 * expand-to-output affordance.
 *
 * Slots into the sidebar panel slot (#4303) alongside the token view. It reads
 * the per-session activity state off the connection store (fed by the
 * store-core reducer from `activity_snapshot` / `activity_delta`) and renders
 * the tree via `selectActivityTree` so the dashboard and future mobile parity
 * share one tree-building implementation.
 *
 * v1 is READ-ONLY: no cancel/kill/jump-to-intervene actions. Control actions,
 * the cross-session aggregate view, and mobile parity are tracked phase-2
 * fast-follows on the epic (#5159), not this panel.
 *
 * Blocked-on-input entries are visually prominent and tie into the dashboard's
 * intervention convention (#4891): a blocked entry pulses the same accent the
 * intervention surface uses so the operator's eye lands on "this needs you".
 */
import { useCallback, useEffect, useState } from 'react'
import type { ActivityEntry, ActivityState, ActivityTreeNode } from '@chroxy/store-core'
import { selectActivityTree } from '@chroxy/store-core'

export interface ControlRoomPanelProps {
  /** Whole-store activity state (one tree per session). */
  activity: ActivityState
  /** Active session whose tree is rendered. Null → empty state. */
  activeSessionId: string | null
  /**
   * Injectable clock for deterministic tests. Defaults to `Date.now`. Used by
   * the elapsed timer; production passes nothing.
   */
  now?: () => number
}

// Kind → glyph. Kept ASCII-ish so it renders in the sidebar's small font
// without needing an icon font. Mirrors the kinds in the protocol
// `ActivityKindSchema` (agent / shell / tool).
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
}

function EntryRow({ entry, depth, now, expanded, onToggleExpand }: EntryRowProps) {
  const terminal = isTerminal(entry.status)
  const blocked = entry.status === 'blocked'
  // Terminal entries freeze elapsed at endedAt; live entries tick from `now`.
  const elapsedMs = (terminal && entry.endedAt !== undefined ? entry.endedAt : now) - entry.startedAt

  const rowClass =
    `control-room-entry status-${entry.status}` + (blocked ? ' control-room-entry-blocked' : '')

  return (
    <li
      className="control-room-entry-row"
      data-testid={`control-room-entry-${entry.id}`}
    >
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
}

function EntryTree({ nodes, depth, now, expandedIds, onToggleExpand }: EntryTreeProps) {
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
            />
          </ul>
          {node.children.length > 0 && (
            <EntryTree
              nodes={node.children}
              depth={depth + 1}
              now={now}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

export function ControlRoomPanel({ activity, activeSessionId, now = Date.now }: ControlRoomPanelProps) {
  const tree = selectActivityTree(activity, activeSessionId ?? '')
  const live = hasLiveEntry(tree)
  const tick = useTick(live, now)

  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (activeSessionId === null) {
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
      />
    </div>
  )
}

/**
 * Collapsed-panel header metric for the Control Room (decision #4 in #4303):
 * a one-glance count of live (running/blocked) entries in the active session's
 * tree, so the operator sees in-flight work without expanding the panel.
 * Returns null when nothing is live so the slot can hide the metric.
 */
export function controlRoomCollapsedMetric(
  activity: ActivityState,
  activeSessionId: string | null,
): string | null {
  if (activeSessionId === null) return null
  const tree = selectActivityTree(activity, activeSessionId)
  let live = 0
  let blocked = 0
  function walk(nodes: readonly ActivityTreeNode[]): void {
    for (const node of nodes) {
      if (!isTerminal(node.entry.status)) {
        live += 1
        if (node.entry.status === 'blocked') blocked += 1
      }
      walk(node.children)
    }
  }
  walk(tree)
  if (live === 0) return null
  if (blocked > 0) return `${live} live · ${blocked} blocked`
  return `${live} live`
}
