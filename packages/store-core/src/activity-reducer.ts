/**
 * Control Room activity reducer (#5162, epic #5159).
 *
 * Platform-agnostic reducer that builds and maintains the per-session
 * "activity tree" — the live map of in-flight subagents (`agent`),
 * background shells (`shell`), and long-running tool calls (`tool`) — from the
 * `activity_snapshot` + `activity_delta` wire contract (#5161). The dashboard
 * Control Room panel (#5163) and future mobile parity both consume THIS one
 * implementation so the two surfaces can't drift apart.
 *
 * Wire contract recap (see `@chroxy/protocol` `schemas/server.ts`):
 *   - `activity_snapshot` carries the FULL current entry list for a session.
 *     Applying it REPLACES that session's activity state (canonical resync).
 *   - `activity_delta` carries the FULL entry on every op (`started` / `updated`
 *     / `ended`) — never a partial patch — so each delta is self-healing: the
 *     reducer is a pure upsert-by-id and a dropped earlier delta is recovered by
 *     the next one. `op` is advisory; correctness comes from `entry`.
 *
 * State shape is normalized (`byId`) plus a flat `order` array recording
 * first-seen insertion order, so the selector can reconstruct a deterministically
 * ordered tree from `id` / `parentId` without depending on wire order (which the
 * protocol explicitly says consumers MUST NOT rely on).
 */

import type {
  ActivityEntry,
  ServerActivitySnapshotMessage,
  ServerActivityDeltaMessage,
} from '@chroxy/protocol'

/**
 * Default retention cap for ended (terminal) entries kept per session. Running /
 * blocked entries are never pruned — they're the live tree. Once an entry
 * reaches `done` / `failed` it becomes a candidate for pruning; we keep only the
 * `MAX_TERMINAL_ENTRIES_PER_SESSION` most-recently-ended ones (by `endedAt`,
 * tie-broken by insertion order) so a long-lived session's tree doesn't grow
 * unbounded as work completes. A child whose parent was pruned re-roots
 * gracefully (the selector treats an unknown `parentId` as top-level), matching
 * the protocol's "unknown parentId → top-level, never drop" rule.
 */
export const MAX_TERMINAL_ENTRIES_PER_SESSION = 50

/** One session's normalized activity state. */
export interface SessionActivityState {
  /** Entries keyed by `ActivityEntry.id`. */
  readonly byId: Readonly<Record<string, ActivityEntry>>
  /**
   * First-seen insertion order of ids. Used as the stable ordering key for the
   * selector's tree (and tie-breaker for terminal pruning) so the rendered tree
   * is deterministic regardless of wire-arrival order. Pruned ids are removed.
   */
  readonly order: readonly string[]
}

/** The full reducer state: one `SessionActivityState` per session id. */
export interface ActivityState {
  readonly bySession: Readonly<Record<string, SessionActivityState>>
}

/** A node in the rendered activity tree: an entry plus its ordered children. */
export interface ActivityTreeNode {
  readonly entry: ActivityEntry
  readonly children: readonly ActivityTreeNode[]
}

/**
 * All dictionaries keyed off WIRE-controlled strings (`bySession` by
 * `sessionId`, `byId` by `ActivityEntry.id`) use a null-prototype map so a
 * malicious / accidental key like `"__proto__"`, `"toString"`, or
 * `"constructor"` can't collide with an inherited `Object.prototype` member.
 * On a plain `{}`, `"toString" in obj` is `true` even when unset (breaking
 * upsert/order bookkeeping) and `obj["__proto__"] = entry` mutates the
 * prototype rather than storing a value — both are closed off here. This
 * matches the existing store-core hardening (`freeform-answer.ts`,
 * `types.ts`'s `hasOwnProperty.call` guards). `hasKey` is the matching
 * own-property check used instead of the `in` operator on these maps.
 */
function emptyRecord<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

const EMPTY_SESSION: SessionActivityState = Object.freeze({
  byId: Object.freeze(emptyRecord<ActivityEntry>()),
  order: Object.freeze([]),
})

/** Fresh, empty reducer state. */
export function createEmptyActivityState(): ActivityState {
  return { bySession: emptyRecord<SessionActivityState>() }
}

function isTerminal(entry: ActivityEntry): boolean {
  return entry.status === 'done' || entry.status === 'failed'
}

/**
 * Decide whether `incoming` should replace `existing` for the same id.
 *
 * Pure upsert would let a delayed/duplicate non-terminal `updated` arriving
 * AFTER an `ended` un-terminate the entry. Guard against that:
 *   - An already-terminal entry is NOT overwritten by a non-terminal incoming
 *     entry (a stale `running`/`blocked` after `done`/`failed`). The terminal
 *     state wins — the entry stays ended.
 *   - Two terminal entries: keep the later one (by `endedAt`); a duplicate /
 *     out-of-order terminal with an older `endedAt` is ignored. Equal `endedAt`
 *     takes the incoming (last-writer-wins for an identical terminal restate).
 *   - Otherwise (no existing, or a forward non-terminal→non-terminal /
 *     non-terminal→terminal transition) the incoming entry wins.
 */
function shouldReplace(existing: ActivityEntry | undefined, incoming: ActivityEntry): boolean {
  if (existing === undefined) return true

  const existingTerminal = isTerminal(existing)
  const incomingTerminal = isTerminal(incoming)

  if (existingTerminal && !incomingTerminal) {
    // Stale non-terminal update after the entry already ended — ignore it.
    return false
  }

  if (existingTerminal && incomingTerminal) {
    // Both terminal: keep whichever ended later; ignore an older duplicate.
    const existingEnd = existing.endedAt ?? 0
    const incomingEnd = incoming.endedAt ?? 0
    return incomingEnd >= existingEnd
  }

  // existing is non-terminal: any incoming (newer running/blocked, or the
  // terminal transition) wins.
  return true
}

/**
 * Upsert `entry` into a session state, applying the {@link shouldReplace} guard
 * and the terminal-retention prune. Returns a NEW `SessionActivityState`
 * (immutable update) — or the SAME reference if nothing changed (so callers can
 * cheaply skip re-renders).
 */
function upsertEntry(
  session: SessionActivityState,
  entry: ActivityEntry,
  maxTerminal: number,
): SessionActivityState {
  const existing = session.byId[entry.id]
  if (!shouldReplace(existing, entry)) return session

  const byId = emptyRecord<ActivityEntry>()
  Object.assign(byId, session.byId)
  byId[entry.id] = entry
  const order = existing === undefined ? [...session.order, entry.id] : session.order

  return pruneTerminal({ byId, order }, maxTerminal)
}

/**
 * Enforce the terminal-retention rule: keep at most `maxTerminal` ended entries
 * per session, evicting the oldest-ended first. Running / blocked entries are
 * always kept. A negative / non-finite `maxTerminal` disables pruning. Returns
 * the SAME reference if nothing was pruned.
 */
function pruneTerminal(session: SessionActivityState, maxTerminal: number): SessionActivityState {
  if (!Number.isFinite(maxTerminal) || maxTerminal < 0) return session

  const terminalIds: string[] = []
  for (const id of session.order) {
    const e = session.byId[id]
    if (e !== undefined && isTerminal(e)) terminalIds.push(id)
  }
  if (terminalIds.length <= maxTerminal) return session

  // Oldest-ended-first ordering. `endedAt` is guaranteed present on terminal
  // entries by the protocol schema; fall back to insertion order on ties.
  const orderIndex = new Map(session.order.map((id, idx) => [id, idx]))
  const sorted = [...terminalIds].sort((a, b) => {
    const ea = session.byId[a]!.endedAt ?? 0
    const eb = session.byId[b]!.endedAt ?? 0
    if (ea !== eb) return ea - eb
    return (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0)
  })

  const evictCount = terminalIds.length - maxTerminal
  const evicted = new Set(sorted.slice(0, evictCount))

  const byId = emptyRecord<ActivityEntry>()
  for (const id of session.order) {
    if (!evicted.has(id)) byId[id] = session.byId[id]!
  }
  const order = session.order.filter((id) => !evicted.has(id))

  return { byId, order }
}

/**
 * Apply an `activity_snapshot`: REPLACE the target session's activity state with
 * the snapshot's entries (normalized by id, first-seen order = wire order, then
 * pruned to the retention cap). Other sessions are untouched.
 *
 * Duplicate ids within one snapshot resolve last-writer-wins (a malformed
 * server snapshot shouldn't crash the reducer).
 */
export function applyActivitySnapshot(
  state: ActivityState,
  message: ServerActivitySnapshotMessage,
  maxTerminal: number = MAX_TERMINAL_ENTRIES_PER_SESSION,
): ActivityState {
  const byId = emptyRecord<ActivityEntry>()
  const order: string[] = []
  for (const entry of message.entries) {
    if (!hasKey(byId, entry.id)) order.push(entry.id)
    byId[entry.id] = entry
  }

  const session = pruneTerminal({ byId, order }, maxTerminal)
  const bySession = emptyRecord<SessionActivityState>()
  Object.assign(bySession, state.bySession)
  bySession[message.sessionId] = session
  return { bySession }
}

/**
 * Apply an `activity_delta`: upsert the carried entry into its session by id.
 * `op` is advisory — the FULL entry drives the result, so a `started` for a
 * known id, an `updated` for an unknown id, and a re-sent `ended` all converge.
 * Out-of-order / duplicate deltas are idempotent via {@link shouldReplace}.
 * Returns the SAME state reference if the upsert was a no-op.
 */
export function applyActivityDelta(
  state: ActivityState,
  message: ServerActivityDeltaMessage,
  maxTerminal: number = MAX_TERMINAL_ENTRIES_PER_SESSION,
): ActivityState {
  const current = state.bySession[message.sessionId] ?? EMPTY_SESSION
  const next = upsertEntry(current, message.entry, maxTerminal)
  if (next === current) return state
  const bySession = emptyRecord<SessionActivityState>()
  Object.assign(bySession, state.bySession)
  bySession[message.sessionId] = next
  return { bySession }
}

/**
 * Drop a session's activity state entirely (e.g. on session close / unsubscribe).
 * Returns the SAME state reference if the session wasn't present.
 */
export function clearSessionActivity(state: ActivityState, sessionId: string): ActivityState {
  if (!hasKey(state.bySession, sessionId)) return state
  const bySession = emptyRecord<SessionActivityState>()
  Object.assign(bySession, state.bySession)
  delete bySession[sessionId]
  return { bySession }
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
