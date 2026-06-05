/**
 * #5160 — per-session activity registry (Control Room phase 1).
 *
 * A thin UNIFYING layer over the in-flight signals BaseSession already
 * emits. It does NOT track anything the session doesn't already know — it
 * maps the existing lifecycle events into the `ActivityEntry` wire shape
 * (#5161, `@chroxy/protocol`) and emits two events the WS layer forwards
 * verbatim:
 *
 *   - `activity_snapshot { sessionId, schemaVersion, entries }` — the full
 *     current tree. Served to a fresh subscriber (snapshot-on-subscribe via
 *     `getSnapshotMessage()`) and on resync, mirroring the
 *     `background_work_changed` full-snapshot philosophy so a late joiner
 *     never reconciles deltas against a separate snapshot.
 *   - `activity_delta { sessionId, schemaVersion, op, entry }` — one
 *     upsert/end per change. `op` is `started` / `updated` / `ended`; the
 *     FULL entry rides every op so the downstream reducer (#5162) is a pure
 *     upsert-by-id and self-heals a dropped delta.
 *
 * The signals it unifies (all already emitted by BaseSession / providers):
 *   - `tool_start` / `tool_result`     → long-running tool calls (#4628)
 *   - `agent_spawned` / `agent_completed` → Task subagents (#5016/#5060)
 *   - `background_work_changed`        → backgrounded Bash shells (#4307)
 *   - `permission_request` / `user_question` / `permission_resolved`
 *                                      → the `blocked` status (waiting on
 *                                        the user)
 *
 * Dedup note: a `Task` tool fires BOTH `tool_start` (kind `tool`) AND
 * `agent_spawned` (kind `agent`) on the SAME toolUseId. The registry treats
 * `agent_spawned` as authoritative and upgrades the `tool` node to an
 * `agent` node in place (same id) rather than carrying two nodes for one
 * unit of work. The matching `tool_result` (or `agent_completed`) then
 * terminates the agent node.
 *
 * Lifetime: one registry per session, owned by BaseSession. It holds NO
 * timers and NO external refs; `reset()` (turn-end) and `clear()` (destroy)
 * empty the map. Nothing here is persisted — the underlying signals are all
 * transient/in-memory (see #4307/#4417), so a server restart starts with an
 * empty tree, which is correct (the OS-level work is owned by claude, not
 * chroxy).
 */

import { ACTIVITY_SCHEMA_VERSION } from '@chroxy/protocol'

// Prefix for shell entry ids so a shell token (e.g. `brk57kt6pm`) can never
// collide with a tool_use id in the flat entry map.
const SHELL_ID_PREFIX = 'shell:'
// Prefix for permission / question (blocked) entry ids — keyed by the
// permission requestId or the AskUserQuestion synthetic toolUseId.
const BLOCKED_ID_PREFIX = 'blocked:'

/**
 * @typedef {import('@chroxy/protocol').ActivityEntry} ActivityEntry
 */

export class ActivityRegistry {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId — the session this registry tracks. Carried
   *   on every emitted message. May be empty at construction (SDK sessions
   *   learn their id on `init`); `setSessionId` updates it later.
   * @param {(event: string, payload: object) => void} opts.emit — bound emitter
   *   (the owning session's `this.emit`). Kept as an injected function so the
   *   registry is unit-testable without a real session.
   */
  constructor({ sessionId = '', emit } = {}) {
    if (typeof emit !== 'function') {
      throw new TypeError('ActivityRegistry requires an emit function')
    }
    this._sessionId = typeof sessionId === 'string' ? sessionId : ''
    this._emit = emit
    /** @type {Map<string, ActivityEntry>} */
    this._entries = new Map()
  }

  /**
   * Update the session id (SDK sessions only learn it on `init`). Existing
   * entries are unaffected; only future emitted messages carry the new id.
   * @param {string} sessionId
   */
  setSessionId(sessionId) {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this._sessionId = sessionId
    }
  }

  /**
   * Current entries as a plain array (flat list; the tree is reconstructed
   * client-side from `parentId`). Returned in insertion order so the most
   * recently started work sorts last, but consumers MUST NOT depend on order.
   * @returns {ActivityEntry[]}
   */
  getEntries() {
    return Array.from(this._entries.values()).map((e) => ({ ...e }))
  }

  /**
   * Build the `activity_snapshot` message for a fresh subscriber / resync.
   * Always returns a valid message (empty `entries` is the legitimate
   * "no in-flight activity" state, never omitted).
   * @returns {{ type: 'activity_snapshot', sessionId: string, schemaVersion: number, entries: ActivityEntry[] }}
   */
  getSnapshotMessage() {
    return {
      type: 'activity_snapshot',
      sessionId: this._sessionId,
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      entries: this.getEntries(),
    }
  }

  // --- signal handlers ------------------------------------------------------

  /**
   * A tool_use began streaming. Creates a `running` `tool` node unless the
   * id is already an `agent` node (a Task — `agent_spawned` is authoritative
   * and may land before or after `tool_start` depending on the provider).
   * @param {{ toolUseId?: string, tool?: string }} data
   */
  onToolStart(data) {
    const toolUseId = data?.toolUseId
    if (!isNonEmptyString(toolUseId)) return
    const existing = this._entries.get(toolUseId)
    // Already an agent node for this id → the Task signal wins, leave it.
    if (existing && existing.kind === 'agent') return
    const label = isNonEmptyString(data.tool) ? data.tool : ''
    this._upsert({
      id: toolUseId,
      kind: 'tool',
      label,
      status: 'running',
      startedAt: Date.now(),
      outputRef: { kind: 'tool_use', id: toolUseId },
    })
  }

  /**
   * A tool_use returned a result. Terminates the matching node (tool OR the
   * upgraded agent node sharing the toolUseId). `isError` → `failed`, else
   * `done`. Unknown ids are a no-op (e.g. a result for a tool whose start we
   * never saw).
   * @param {{ toolUseId?: string, isError?: boolean }} data
   */
  onToolResult(data) {
    const toolUseId = data?.toolUseId
    if (!isNonEmptyString(toolUseId)) return
    // If this id is an agent node, drain its child tools first so the tree
    // never strands a child beneath a terminated parent.
    const existing = this._entries.get(toolUseId)
    if (existing && existing.kind === 'agent') {
      this._endChildrenOf(toolUseId)
    }
    this._end(toolUseId, data?.isError === true ? 'failed' : 'done')
  }

  /**
   * A Task subagent was spawned. Authoritative for the toolUseId: if a `tool`
   * node already exists for it (the Task's own tool_start), upgrade it to an
   * `agent` node in place; otherwise create a fresh `agent` node.
   * @param {{ toolUseId?: string, description?: string, startedAt?: number }} data
   */
  onAgentSpawned(data) {
    const toolUseId = data?.toolUseId
    if (!isNonEmptyString(toolUseId)) return
    const existing = this._entries.get(toolUseId)
    // Preserve the original start time if the tool_start landed first.
    const startedAt = sanitizeTimestamp(data.startedAt)
      ?? existing?.startedAt
      ?? Date.now()
    this._upsert({
      id: toolUseId,
      kind: 'agent',
      label: isNonEmptyString(data.description) ? data.description : (existing?.label ?? ''),
      status: 'running',
      startedAt,
      outputRef: { kind: 'tool_use', id: toolUseId },
    })
  }

  /**
   * A Task subagent finished. Terminates the agent node as `done` (the
   * subagent's own failure surfaces separately via the Task tool_result;
   * `agent_completed` is the lifecycle-clear signal, not an error signal).
   * @param {{ toolUseId?: string }} data
   */
  onAgentCompleted(data) {
    const toolUseId = data?.toolUseId
    if (!isNonEmptyString(toolUseId)) return
    // End any child tool nodes still open under this agent first, so the
    // tree drains leaf-up and no orphaned child outlives its parent.
    this._endChildrenOf(toolUseId)
    this._end(toolUseId, 'done')
  }

  /**
   * #5016 — a Task subagent's intermediate wire event, relayed by the parent
   * under `agent_event` and tagged with the parent's `parentToolUseId`. This
   * is the session→agent→tool hierarchy signal: a child `tool_start` /
   * `tool_result` nested inside the parent agent. We surface only the
   * tool lifecycle (the structural nodes); `stream_delta` / `tool_input_delta`
   * are output noise, not activity nodes.
   *
   * Child ids are namespaced by the parent (`<parentId>::<childToolUseId>`)
   * so two subagents running the same tool can't collide, and a child node
   * is dropped if its parent agent isn't (or is no longer) tracked — a child
   * tool only makes sense under a live agent.
   *
   * @param {{ parentToolUseId?: string, type?: string, payload?: object }} data
   */
  onAgentEvent(data) {
    const parentId = data?.parentToolUseId
    if (!isNonEmptyString(parentId)) return
    const childType = data?.type
    const payload = (data?.payload && typeof data.payload === 'object') ? data.payload : {}
    if (childType === 'tool_start') {
      const childToolUseId = payload.toolUseId
      if (!isNonEmptyString(childToolUseId)) return
      // Only nest under a parent agent we're actually tracking — a child
      // tool with no live parent would be an orphan in the tree.
      if (!this._entries.has(parentId)) return
      const id = childActivityId(parentId, childToolUseId)
      this._upsert({
        id,
        kind: 'tool',
        label: isNonEmptyString(payload.tool) ? payload.tool : '',
        status: 'running',
        startedAt: Date.now(),
        parentId,
        outputRef: { kind: 'tool_use', id: childToolUseId },
      })
    } else if (childType === 'tool_result') {
      const childToolUseId = payload.toolUseId
      if (!isNonEmptyString(childToolUseId)) return
      this._end(childActivityId(parentId, childToolUseId), payload.isError === true ? 'failed' : 'done')
    }
  }

  /**
   * Reconcile backgrounded-shell entries against the full pending snapshot
   * BaseSession emits on `background_work_changed`. Adds entries for newly
   * pending shells (started delta) and ends entries for shells no longer
   * pending (ended/done delta). The snapshot is authoritative — this is a
   * set-reconciliation, not an incremental diff, so a dropped event self-heals
   * on the next snapshot.
   * @param {{ pending?: Array<{ shellId?: string, startedAt?: number, command?: string }> }} data
   */
  onBackgroundWorkChanged(data) {
    const pending = Array.isArray(data?.pending) ? data.pending : []
    const seen = new Set()
    for (const shell of pending) {
      const shellId = shell?.shellId
      if (!isNonEmptyString(shellId)) continue
      const id = SHELL_ID_PREFIX + shellId
      seen.add(id)
      if (this._entries.has(id)) continue // already tracked; preserve startedAt
      this._upsert({
        id,
        kind: 'shell',
        label: isNonEmptyString(shell.command) ? shell.command : '',
        status: 'running',
        startedAt: sanitizeTimestamp(shell.startedAt) ?? Date.now(),
        outputRef: { kind: 'shell', id: shellId },
      })
    }
    // End any shell entry that's no longer in the pending snapshot.
    for (const [id, entry] of this._entries) {
      if (entry.kind !== 'shell') continue
      if (seen.has(id)) continue
      this._end(id, 'done')
    }
  }

  /**
   * A tool is blocked waiting on a user permission decision. Creates a
   * `blocked` node keyed by the requestId so the Control Room can flag
   * "needs attention" without inferring it from elapsed time. Resolved via
   * `onPermissionResolved`.
   * @param {{ requestId?: string, tool?: string, description?: string }} data
   */
  onPermissionRequest(data) {
    const requestId = data?.requestId
    if (!isNonEmptyString(requestId)) return
    const label = isNonEmptyString(data.description)
      ? data.description
      : (isNonEmptyString(data.tool) ? data.tool : '')
    this._upsert({
      id: BLOCKED_ID_PREFIX + requestId,
      kind: 'tool',
      label,
      status: 'blocked',
      startedAt: Date.now(),
    })
  }

  /**
   * An AskUserQuestion is blocked waiting on the user. Same `blocked` model
   * as a permission request, keyed by the synthetic question toolUseId.
   * @param {{ toolUseId?: string }} data
   */
  onUserQuestion(data) {
    const toolUseId = data?.toolUseId
    if (!isNonEmptyString(toolUseId)) return
    this._upsert({
      id: BLOCKED_ID_PREFIX + toolUseId,
      kind: 'tool',
      label: 'Waiting for your answer',
      status: 'blocked',
      startedAt: Date.now(),
    })
  }

  /**
   * A pending permission / question was resolved (approved, denied, timed
   * out, or aborted). Ends the matching blocked node. A `deny`/`timeout`/
   * `aborted` resolution is `failed`; an approval is `done` (the subsequent
   * tool_start, if any, creates its own running node). The payload carries
   * EITHER `requestId` (permission) OR `toolUseId` (question).
   * @param {{ requestId?: string, toolUseId?: string, decision?: string, reason?: string }} data
   */
  onPermissionResolved(data) {
    const key = isNonEmptyString(data?.requestId)
      ? data.requestId
      : (isNonEmptyString(data?.toolUseId) ? data.toolUseId : null)
    if (!key) return
    const denied = data?.decision === 'deny'
      || data?.reason === 'timeout'
      || data?.reason === 'aborted'
    this._end(BLOCKED_ID_PREFIX + key, denied ? 'failed' : 'done')
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Turn-end reconciliation. Ends any non-shell entry still marked
   * `running`/`blocked` as `done` — at turn end the model has stopped, so a
   * lingering tool/agent/blocked node is an orphan (mirrors BaseSession's
   * `_sweepUnresolvedToolStarts`). Shell entries SURVIVE turn-end on purpose
   * (#4307: a backgrounded shell outlives the turn that spawned it; it clears
   * via `onBackgroundWorkChanged`).
   */
  reset() {
    for (const [id, entry] of this._entries) {
      if (entry.kind === 'shell') continue
      this._end(id, 'done')
    }
  }

  /**
   * Session destroy. Ends EVERY remaining entry (including shells — the
   * session is gone, so nothing is still in flight) and empties the map.
   */
  clear() {
    for (const id of Array.from(this._entries.keys())) {
      this._end(id, 'done')
    }
    this._entries.clear()
  }

  // --- internals ------------------------------------------------------------

  /**
   * Insert or replace an entry and emit the matching delta. A brand-new id
   * emits `op: 'started'`; an existing id emits `op: 'updated'`. The full
   * entry rides the delta so the downstream reducer is a pure upsert-by-id.
   * @param {ActivityEntry} entry
   * @private
   */
  _upsert(entry) {
    const op = this._entries.has(entry.id) ? 'updated' : 'started'
    this._entries.set(entry.id, entry)
    this._emitDelta(op, entry)
  }

  /**
   * Terminate an entry by id with the given terminal status, set `endedAt`,
   * emit an `ended` delta, and drop it from the map. No-op for an unknown id
   * or an already-terminated entry.
   * @param {string} id
   * @param {'done'|'failed'} status
   * @private
   */
  _end(id, status) {
    const existing = this._entries.get(id)
    if (!existing) return
    // endedAt must be >= startedAt (schema invariant); clamp against a
    // clock that ticked backwards between start and end.
    const endedAt = Math.max(Date.now(), existing.startedAt)
    const ended = { ...existing, status, endedAt }
    // Drop it BEFORE emitting so a re-entrant handler observing the emit
    // can't double-end the same node.
    this._entries.delete(id)
    this._emitDelta('ended', ended)
  }

  /**
   * End every entry whose `parentId` matches the given id (one level — child
   * tools don't themselves have children today). Snapshot the keys first so
   * the delete-during-iterate inside `_end` is safe.
   * @param {string} parentId
   * @private
   */
  _endChildrenOf(parentId) {
    const children = []
    for (const [id, entry] of this._entries) {
      if (entry.parentId === parentId) children.push(id)
    }
    for (const id of children) {
      this._end(id, 'done')
    }
  }

  /**
   * Emit one `activity_delta`. Carries the session id + schema version so the
   * WS layer forwards it verbatim.
   * @param {'started'|'updated'|'ended'} op
   * @param {ActivityEntry} entry
   * @private
   */
  _emitDelta(op, entry) {
    this._emit('activity_delta', {
      sessionId: this._sessionId,
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      op,
      entry,
    })
  }
}

/**
 * Build a parent-namespaced child entry id so two subagents running the same
 * tool can't collide on a shared child toolUseId.
 * @param {string} parentId
 * @param {string} childToolUseId
 * @returns {string}
 */
function childActivityId(parentId, childToolUseId) {
  return `${parentId}::${childToolUseId}`
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

/**
 * Coerce a timestamp opt to a non-negative finite integer, or null when it's
 * not a usable number (so callers fall back to `Date.now()`).
 * @param {unknown} v
 * @returns {number | null}
 */
function sanitizeTimestamp(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  return Math.floor(v)
}
