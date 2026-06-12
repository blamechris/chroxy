/**
 * Shared message dispatch table (#5556 sub-item 3, first slice).
 *
 * The mobile app and web dashboard each maintained a hand-copied `switch
 * (msg.type)` wrapping the SAME store-core handler functions with the SAME
 * glue. Every new wire message cost ~5 edits across 3 files, and the two
 * copies drifted (the static handler-coverage guard only asserts a case
 * EXISTS, not that behaviour matches).
 *
 * This module mirrors the server's `ws-message-handlers.js` registry pattern
 * on the client side: a `Record<msgType, handler>` where each entry is a pure
 * delegation into an existing store-core handler, driven through a thin,
 * platform-supplied {@link ClientStoreAdapter}. Cases where the two clients
 * genuinely diverge stay platform-local (in each client's own switch) and are
 * NOT registered here — they become VISIBLE as divergent by their absence.
 *
 * Migration is incremental: a client dispatches through {@link runDispatch}
 * first; a table MISS falls through to its existing switch unchanged. This
 * lets us migrate 5-10 pure-delegation cases per PR without a big-bang rewrite.
 *
 * --- Adapter design rationale ---
 *
 * The pure-delegation cases need only a tiny, platform-agnostic surface:
 *   - read the active session id (`getActiveSessionId`)
 *   - test whether a session exists locally (`hasSession`)
 *   - patch a specific session's state (`updateSession`)
 *   - patch the flat connection state (`setState`)
 *   - append a chat message (`addMessage`)
 *   - read the session list (`getSessions`)
 *
 * Both clients already expose exactly these (app: `updateSession` /
 * `getStore().setState` / `addMessage` / `get().sessions`; dashboard: the
 * `Handler = (msg, get, set, ctx)` map's `get`/`set`/`updateSession`). The
 * adapter is the narrowest interface that covers the migrated cases — it does
 * NOT leak either client's `ConnectionState`/`SessionState` shape into
 * store-core. The table is generic over the client's session-state type `S`
 * so `updateSession`'s updater stays correctly typed per platform.
 *
 * --- Typing against the protocol union ---
 *
 * Each entry's `msg` param is narrowed to that type's wire shape via
 * {@link DispatchMessageMap} — a local map from the migrated `type` literal to
 * its message shape (derived from the protocol's per-type schemas). There is
 * no single `ServerMessageSchema` discriminated union to infer from (the
 * server schemas are individual objects), and store-core deliberately keeps a
 * minimal `@chroxy/protocol` surface for mobile build size; the map gives the
 * same per-entry narrowing without pulling the whole protocol in.
 */

import type { ChatMessage, SessionInfo } from './types'
import {
  handleAvailablePermissionModes,
  handleSessionUpdated,
  handleAgentBusy,
  handleBudgetResumed,
  handleConversationId,
  handlePermissionRulesUpdated,
  handleConfirmPermissionMode,
  resolveSessionId,
  type PermissionMode,
  type PermissionRule,
  type PendingPermissionConfirm,
} from './handlers'

// ---------------------------------------------------------------------------
// Client adapter
// ---------------------------------------------------------------------------

/**
 * The minimal session-state shape the migrated handlers read or write. Each
 * client's real session-state type (app `SessionState`, dashboard
 * `SessionState`) is a structural superset, so it satisfies this constraint
 * without store-core importing either client's type. The fields are exactly
 * those the current table touches:
 *   - `messages` — read+rewritten by `budget_resumed`
 *   - `conversationId` — written by `conversation_id`
 *   - `sessionRules` — written by `permission_rules_updated`
 *   - `isIdle` — written by `agent_busy`
 * No index signature: both clients' real `SessionState` carry these exact
 * fields (plus many more), so they satisfy the constraint structurally. A
 * future pure case that writes a NEW session field adds it here (and both
 * clients already have it).
 */
export interface DispatchSessionBase {
  messages: ChatMessage[]
  conversationId?: string | null
  sessionRules?: unknown[]
  isIdle?: boolean
}

/**
 * The minimal store surface a dispatch-table handler needs. Each client
 * supplies an implementation backed by its own Zustand store. Generic over the
 * client's session-state type `S` so {@link ClientStoreAdapter.updateSession}'s
 * updater is typed against the platform's real session shape.
 *
 * `Flat` is the flat (top-level) connection-state slice each client merges via
 * `setState`. Defaults to a loose record so a client can pass a precise type
 * (its `Partial<ConnectionState>`) or fall back to the structural default.
 */
export interface ClientStoreAdapter<S extends DispatchSessionBase, Flat = Record<string, unknown>> {
  /** Active session id, or null when none is selected. */
  getActiveSessionId(): string | null
  /** True when a session with this id exists in the client's local store. */
  hasSession(sessionId: string): boolean
  /**
   * Shallow-merge a partial patch into a specific session's state. The updater
   * receives the current session and returns the fields to merge. No-ops when
   * the session does not exist (matches both clients' `updateSession`).
   */
  updateSession(sessionId: string, updater: (session: S) => Partial<S>): void
  /** Shallow-merge a patch into the flat connection state. */
  setState(patch: Flat): void
  /** Append a chat message via the client's own add-message path. */
  addMessage(message: ChatMessage): void
  /** Read the current session list (for `session_updated`). */
  getSessions(): SessionInfo[]
}

// ---------------------------------------------------------------------------
// Per-entry message shapes (protocol-derived narrowing)
// ---------------------------------------------------------------------------

/**
 * Wire shapes for the migrated message types, keyed by `type`. Each entry's
 * handler narrows its `msg` param to the corresponding shape. Mirrors the
 * protocol's per-type server schemas; fields not consumed by the pure handler
 * are intentionally omitted.
 */
export interface DispatchMessageMap {
  available_permission_modes: {
    type: 'available_permission_modes'
    modes?: unknown[]
  }
  session_updated: {
    type: 'session_updated'
    sessionId: string
    name: string
  }
  agent_busy: {
    type: 'agent_busy'
    sessionId?: string
  }
  budget_resumed: {
    type: 'budget_resumed'
    sessionId?: string
  }
  conversation_id: {
    type: 'conversation_id'
    sessionId?: string
    conversationId?: string
  }
  permission_rules_updated: {
    type: 'permission_rules_updated'
    sessionId?: string
    rules?: unknown[]
  }
  confirm_permission_mode: {
    type: 'confirm_permission_mode'
    mode?: string
    warning?: string
  }
}

/** Union of message types this table currently handles. */
export type DispatchMessageType = keyof DispatchMessageMap

/** A single dispatch-table entry: a pure delegation into a store-core handler. */
export type DispatchHandler<K extends DispatchMessageType, S extends DispatchSessionBase> = (
  msg: DispatchMessageMap[K],
  adapter: ClientStoreAdapter<S>,
) => void

/** The full dispatch table — every migrated type maps to its handler. */
export type DispatchTable<S extends DispatchSessionBase> = {
  [K in DispatchMessageType]: DispatchHandler<K, S>
}

// ---------------------------------------------------------------------------
// Handlers — one pure delegation per migrated case
//
// Each was byte-for-byte identical between the app and dashboard switches
// (see the PR body's per-case diff verdicts). Divergent cases (model_changed,
// permission_mode_changed, agent_idle, budget_warning/exceeded, primary_changed,
// available_models, notification_prefs, client_joined/left/focus_changed,
// permission_expired) are deliberately NOT here — they stay platform-local.
// ---------------------------------------------------------------------------

/** `available_permission_modes` — replace the flat list when the payload parses. */
function dispatchAvailablePermissionModes<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['available_permission_modes'],
  adapter: ClientStoreAdapter<S>,
): void {
  const modes = handleAvailablePermissionModes(msg as Record<string, unknown>)
  if (modes) {
    adapter.setState({ availablePermissionModes: modes } as Record<string, PermissionMode[]>)
  }
}

/** `session_updated` — rename the matching session in the list. */
function dispatchSessionUpdated<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['session_updated'],
  adapter: ClientStoreAdapter<S>,
): void {
  const updated = handleSessionUpdated(msg as Record<string, unknown>, adapter.getSessions())
  if (updated) {
    adapter.setState({ sessions: updated } as Record<string, SessionInfo[]>)
  }
}

/** `agent_busy` — flip the target session to non-idle when it exists locally. */
function dispatchAgentBusy<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['agent_busy'],
  adapter: ClientStoreAdapter<S>,
): void {
  const targetId = resolveSessionId(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (targetId && adapter.hasSession(targetId)) {
    adapter.updateSession(targetId, () => handleAgentBusy() as Partial<S>)
  }
}

/** `budget_resumed` — append the "budget resumed" system message. */
function dispatchBudgetResumed<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['budget_resumed'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { systemMessage } = handleBudgetResumed()
  const targetId = resolveSessionId(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (targetId && adapter.hasSession(targetId)) {
    adapter.updateSession(
      targetId,
      (ss) =>
        ({
          messages: [...(ss as { messages: ChatMessage[] }).messages, systemMessage],
        } as Partial<S>),
    )
  } else {
    adapter.addMessage(systemMessage)
  }
}

/** `conversation_id` — stamp the conversation id onto its (explicit) session. */
function dispatchConversationId<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['conversation_id'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { sessionId, conversationId } = handleConversationId(msg as Record<string, unknown>)
  // Intentionally does NOT fall back to activeSessionId — a missing sessionId
  // skips the patch entirely (matches both clients' prior inline behaviour).
  if (sessionId && adapter.hasSession(sessionId)) {
    adapter.updateSession(sessionId, () => ({ conversationId } as Partial<S>))
  }
}

/** `permission_rules_updated` — replace the target session's rule set. */
function dispatchPermissionRulesUpdated<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['permission_rules_updated'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { sessionId: explicitId, rules } = handlePermissionRulesUpdated(
    msg as Record<string, unknown>,
  )
  const rulesSessionId = explicitId || adapter.getActiveSessionId()
  if (rulesSessionId && adapter.hasSession(rulesSessionId)) {
    adapter.updateSession(
      rulesSessionId,
      () => ({ sessionRules: rules as PermissionRule[] } as Partial<S>),
    )
  }
}

/** `confirm_permission_mode` — store the pending mode-change confirmation. */
function dispatchConfirmPermissionMode<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['confirm_permission_mode'],
  adapter: ClientStoreAdapter<S>,
): void {
  const pending = handleConfirmPermissionMode(msg as Record<string, unknown>)
  if (pending) {
    adapter.setState({
      pendingPermissionConfirm: pending,
    } as Record<string, PendingPermissionConfirm>)
  }
}

// ---------------------------------------------------------------------------
// Table + runner
// ---------------------------------------------------------------------------

/**
 * Build the shared dispatch table bound to a client's session-state type `S`.
 *
 * Returns a fresh, fully-typed table. Generic over `S` so each client gets an
 * `updateSession` updater typed against its own session shape; the underlying
 * handlers are shared and identical.
 */
export function createDispatchTable<S extends DispatchSessionBase>(): DispatchTable<S> {
  return {
    available_permission_modes: dispatchAvailablePermissionModes,
    session_updated: dispatchSessionUpdated,
    agent_busy: dispatchAgentBusy,
    budget_resumed: dispatchBudgetResumed,
    conversation_id: dispatchConversationId,
    permission_rules_updated: dispatchPermissionRulesUpdated,
    confirm_permission_mode: dispatchConfirmPermissionMode,
  }
}

/** The message types the shared table currently owns (for coverage tooling). */
export const DISPATCH_TABLE_TYPES: readonly DispatchMessageType[] = [
  'available_permission_modes',
  'session_updated',
  'agent_busy',
  'budget_resumed',
  'conversation_id',
  'permission_rules_updated',
  'confirm_permission_mode',
]

/**
 * Run a message through the shared table.
 *
 * @returns `true` when the table owned (and handled) the message — the caller
 *   should stop. `false` on a table MISS — the caller falls through to its own
 *   switch, keeping incremental migration possible.
 */
export function runDispatch<S extends DispatchSessionBase>(
  table: DispatchTable<S>,
  msg: { type?: unknown } & Record<string, unknown>,
  adapter: ClientStoreAdapter<S>,
): boolean {
  const type = msg.type
  if (typeof type !== 'string') return false
  if (!Object.prototype.hasOwnProperty.call(table, type)) return false
  const handler = table[type as DispatchMessageType] as DispatchHandler<DispatchMessageType, S>
  handler(msg as DispatchMessageMap[DispatchMessageType], adapter)
  return true
}
