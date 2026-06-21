/**
 * Control Room activity reducer — SELECTOR (query) layer (#5162, epic #5159).
 *
 * Pure read-only selectors over the `ActivityState` produced by
 * `activity-state.ts`: the per-session entry list + renderable activity tree,
 * and the cross-session mission-control aggregate (#6182). No mutation here.
 * `activity-reducer.ts` re-exports this alongside the state layer.
 */

import type { ActivityEntry } from '@chroxy/protocol'
import type { ActivityState } from './activity-state'
import { hasKey } from './activity-internal'

/** A node in the rendered activity tree: an entry plus its ordered children. */
export interface ActivityTreeNode {
  readonly entry: ActivityEntry
  readonly children: readonly ActivityTreeNode[]
}

/** A session's flat, insertion-ordered entry list (selector helper). */
export function selectSessionEntries(state: ActivityState, sessionId: string): readonly ActivityEntry[] {
  const session = state.bySession[sessionId]
  if (session === undefined) return []
  return session.order.map((id) => session.byId[id]!).filter((e): e is ActivityEntry => e !== undefined)
}

/**
 * Build the renderable activity tree for a session: an array of ordered root
 * nodes, each with ordered `children`, reconstructed from `id` / `parentId`.
 *
 * Ordering at every level follows first-seen insertion order (the `order`
 * array), so the tree is deterministic regardless of wire-arrival order. An
 * entry whose `parentId` is unknown (parent not in the tree — e.g. pruned, or a
 * delta arriving before its parent) is treated as a ROOT rather than dropped,
 * per the protocol's forward-compat rule. Self-parenting / cycles are broken by
 * only attaching a child whose parent was already placed via the ordered walk;
 * any entry that can't be attached falls back to a root, so every entry is
 * always reachable exactly once.
 */
export function selectActivityTree(state: ActivityState, sessionId: string): readonly ActivityTreeNode[] {
  const session = state.bySession[sessionId]
  if (session === undefined) return []

  const childrenByParent = new Map<string, ActivityEntry[]>()
  const roots: ActivityEntry[] = []

  for (const id of session.order) {
    const entry = session.byId[id]
    if (entry === undefined) continue
    const parentId = entry.parentId
    if (parentId !== undefined && parentId !== entry.id && hasKey(session.byId, parentId)) {
      const bucket = childrenByParent.get(parentId)
      if (bucket === undefined) childrenByParent.set(parentId, [entry])
      else bucket.push(entry)
    } else {
      // No parent, self-parent, or unknown parent → root.
      roots.push(entry)
    }
  }

  // Guard against cycles (A→B→A): only descend into ids not already on the
  // walk, so a cycle can't infinitely recurse. Any entry trapped in a pure
  // cycle (every member has a known parent, so none is a root) would otherwise
  // be unreachable — after the root walk we promote each still-unvisited entry
  // to its own root so EVERY entry appears exactly once.
  // Iterative (explicit-stack) DFS rather than recursion: a pathological deep
  // parentId chain (n0 ← n1 ← n2 ← …) is fully wire-controlled and would overflow
  // the JS call stack with a recursive descent, throwing RangeError inside the
  // Control Room render that calls this directly (#5248). The heap-backed stack
  // removes that ceiling. Output is identical to the former recursion: nodes are
  // emitted in pre-order visitation order, children in bucket (first-seen) order,
  // every entry visited exactly once; `visited` still breaks cycles (a child
  // already on the walk is skipped).
  const visited = new Set<string>()
  // Post-order build: each frame collects its children into a mutable array and
  // only constructs the (readonly-`children`) node when its subtree is fully
  // drained, appending it to its parent's collector. Children end up in kids
  // (first-seen) order, every entry visited once, cycles broken by `visited`.
  type Frame = { entry: ActivityEntry; kids: readonly ActivityEntry[]; i: number; children: ActivityTreeNode[] }
  function build(rootEntry: ActivityEntry): ActivityTreeNode {
    visited.add(rootEntry.id)
    const stack: Frame[] = [
      { entry: rootEntry, kids: childrenByParent.get(rootEntry.id) ?? [], i: 0, children: [] },
    ]
    for (;;) {
      const frame = stack[stack.length - 1]!
      if (frame.i >= frame.kids.length) {
        stack.pop()
        const node: ActivityTreeNode = { entry: frame.entry, children: frame.children }
        const parent = stack[stack.length - 1]
        if (parent === undefined) return node // root frame finished
        parent.children.push(node)
        continue
      }
      const kid = frame.kids[frame.i]!
      frame.i += 1
      if (visited.has(kid.id)) continue
      visited.add(kid.id)
      stack.push({ entry: kid, kids: childrenByParent.get(kid.id) ?? [], i: 0, children: [] })
    }
  }

  const result = roots.map((entry) => build(entry))
  for (const id of session.order) {
    if (visited.has(id)) continue
    const entry = session.byId[id]
    if (entry === undefined) continue
    result.push(build(entry))
  }
  return result
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-session aggregation (#6182, Control Room v2 phase 2 / #5964)
//
// A selector layer ON TOP of the per-session reducer above: it turns the
// all-sessions activity map into a mission-control rollup — sessions grouped by
// repo+worktree, each group + the whole set carrying running/blocked/failed/idle
// counts. The dashboard aggregate view (#6183) and the Tauri tray badge (#6184)
// both consume THIS one selector so the surfaces can't drift.
//
// Design decisions (documented so consumers don't have to reverse-engineer):
//   - GROUP KEY is the session's `cwd`. Chroxy has no separate repo-root field on
//     SessionInfo, but a worktree always has a distinct cwd from its main
//     checkout, so grouping by cwd is grouping by repo+worktree. A session with
//     no cwd lands in the "" (Ungrouped) bucket, which sorts last.
//   - PER-SESSION STATUS is derived from the session's activity entries with the
//     priority blocked > running > failed > idle: "blocked-on-input" is the
//     highest-attention signal (something needs you NOW), then actively running,
//     then a terminal failure with nothing live, then idle (no/only-done work).
//   - ROLLUPS count SESSIONS by derived status (not entries) — that's what
//     "across sessions" / the tray "N need me" badge means.
//   - ORDERING: groups by key ascending (Ungrouped last) so groups don't jump as
//     sessions come and go; sessions within a group preserve the caller's input
//     order (the tab order), which is deterministic for a stable input.
// ───────────────────────────────────────────────────────────────────────────

/** A session's derived attention status, rolled up from its activity entries. */
export type SessionDerivedStatus = 'running' | 'blocked' | 'failed' | 'idle'

/** Counts of sessions in each derived status (per group, and overall). */
export interface CrossSessionRollup {
  readonly running: number
  readonly blocked: number
  readonly failed: number
  readonly idle: number
}

/** Minimal per-session metadata the selector needs (a SessionInfo subset). */
export interface CrossSessionMeta {
  readonly sessionId: string
  /** Working directory — the repo+worktree group key. Null/empty → Ungrouped. */
  readonly cwd?: string | null
  /** Display name; falls back to the sessionId. */
  readonly name?: string
  /** Whether this session runs in a git worktree (annotates the group). */
  readonly worktree?: boolean
}

/** One session inside an aggregate group. */
export interface CrossSessionGroupSession {
  readonly sessionId: string
  readonly name: string
  readonly status: SessionDerivedStatus
}

/** Sessions sharing a repo+worktree (cwd), with their rollup. */
export interface CrossSessionGroup {
  /** The cwd, or '' for the Ungrouped bucket. */
  readonly key: string
  /** Human label: the last path segment of `key`, or 'Ungrouped'. */
  readonly label: string
  /** True if ANY session in the group is flagged as a worktree. */
  readonly worktree: boolean
  readonly sessions: readonly CrossSessionGroupSession[]
  readonly rollup: CrossSessionRollup
}

/** The cross-session aggregate: ordered groups + the overall rollup. */
export interface CrossSessionActivity {
  readonly groups: readonly CrossSessionGroup[]
  /** Sum across every session (drives the tray badge). */
  readonly total: CrossSessionRollup
}

/**
 * Derive a session's attention status from its activity entries.
 * Priority: blocked > running > failed > idle (see the block comment above).
 * A session with no entries (or only `done` entries) is `idle`.
 */
export function deriveSessionStatus(entries: readonly ActivityEntry[]): SessionDerivedStatus {
  let hasRunning = false
  let hasFailed = false
  for (const e of entries) {
    if (e.status === 'blocked') return 'blocked' // highest-attention; short-circuit
    if (e.status === 'running') hasRunning = true
    else if (e.status === 'failed') hasFailed = true
  }
  if (hasRunning) return 'running'
  if (hasFailed) return 'failed'
  return 'idle'
}

/** Last path segment of a cwd (handles POSIX and Windows separators). */
function labelFromCwd(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : cwd
}

type MutableRollup = { running: number; blocked: number; failed: number; idle: number }
const emptyRollup = (): MutableRollup => ({ running: 0, blocked: 0, failed: 0, idle: 0 })

/**
 * Build the cross-session mission-control aggregate from the activity reducer
 * state + the authoritative session list. The `sessions` list drives membership
 * (activity for a session not in the list is ignored); a session with no
 * activity is included as `idle`. A duplicate `sessionId` is counted ONCE
 * (first occurrence wins) so the rollup that drives the "needs me" badge can't
 * over-count on a malformed list. Pure + deterministic for a stable input.
 */
export function selectCrossSessionActivity(
  state: ActivityState,
  sessions: readonly CrossSessionMeta[],
): CrossSessionActivity {
  type MutableGroup = { worktree: boolean; sessions: CrossSessionGroupSession[]; rollup: MutableRollup }
  const byKey = new Map<string, MutableGroup>()
  const total = emptyRollup()
  const seen = new Set<string>()

  for (const meta of sessions) {
    if (seen.has(meta.sessionId)) continue // dedupe — first occurrence wins
    seen.add(meta.sessionId)
    const status = deriveSessionStatus(selectSessionEntries(state, meta.sessionId))
    const key = typeof meta.cwd === 'string' && meta.cwd.trim() !== '' ? meta.cwd : ''
    let group = byKey.get(key)
    if (group === undefined) {
      group = { worktree: false, sessions: [], rollup: emptyRollup() }
      byKey.set(key, group)
    }
    group.sessions.push({ sessionId: meta.sessionId, name: meta.name ?? meta.sessionId, status })
    if (meta.worktree === true) group.worktree = true
    group.rollup[status] += 1
    total[status] += 1
  }

  // Named groups alpha-ascending; the Ungrouped ('') bucket always last.
  const keys = [...byKey.keys()].sort((a, b) => {
    if (a === b) return 0
    if (a === '') return 1
    if (b === '') return -1
    return a < b ? -1 : 1
  })

  const groups: CrossSessionGroup[] = keys.map((key) => {
    const g = byKey.get(key)!
    return {
      key,
      label: key === '' ? 'Ungrouped' : labelFromCwd(key),
      worktree: g.worktree,
      sessions: g.sessions,
      rollup: g.rollup,
    }
  })

  return { groups, total }
}
