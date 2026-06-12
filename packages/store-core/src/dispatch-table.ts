/**
 * Shared message dispatch table (epic #5556, sub-item 3, first slice).
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

import type {
  ChatMessage,
  SessionInfo,
  AgentInfo,
  DevPreview,
  PendingBackgroundShell,
  WebTask,
} from './types'
import {
  handleAvailablePermissionModes,
  handleSessionUpdated,
  handleAgentBusy,
  handleBudgetResumed,
  handleConversationId,
  handlePermissionRulesUpdated,
  handleConfirmPermissionMode,
  // --- slice 2 (epic #5556) — next batch of byte-identical pure cases ---
  handleAgentSpawned,
  handleAgentCompleted,
  handleAgentEvent,
  handleBackgroundWorkChanged,
  handlePlanStarted,
  handleInactivityWarning,
  handleMcpServers,
  handleSessionUsage,
  handleSessionCostThresholdCrossed,
  handleDevPreview,
  handleDevPreviewStopped,
  handleWebFeatureStatus,
  handleWebTaskList,
  // notification_prefs (slice 2 reconcile — app dropped its inline copy)
  handleNotificationPrefs,
  resolveSessionId,
  type PermissionMode,
  type PermissionRule,
  type PendingPermissionConfirm,
  type NotificationPrefsState,
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
  sessionRules?: PermissionRule[]
  isIdle?: boolean
  // --- slice 2 reads (epic #5556) ---
  // `activeAgents` — read+rewritten by agent_spawned / agent_completed
  // `pendingBackgroundShells` — read+rewritten by background_work_changed
  // `devPreviews` — read+rewritten by dev_preview / dev_preview_stopped
  // Both clients' real `SessionState` carry these exact arrays.
  activeAgents?: AgentInfo[]
  pendingBackgroundShells?: PendingBackgroundShell[]
  devPreviews?: DevPreview[]
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
  // --- slice 2 (epic #5556) ---
  agent_spawned: {
    type: 'agent_spawned'
    sessionId?: string
    toolUseId?: string
    description?: string
    startedAt?: number
  }
  agent_completed: {
    type: 'agent_completed'
    sessionId?: string
    toolUseId?: string
  }
  agent_event: {
    type: 'agent_event'
    sessionId?: string
    parentToolUseId?: string
    eventType?: string
    payload?: unknown
  }
  background_work_changed: {
    type: 'background_work_changed'
    sessionId?: string
    pending?: unknown[]
  }
  plan_started: {
    type: 'plan_started'
    sessionId?: string
  }
  inactivity_warning: {
    type: 'inactivity_warning'
    sessionId?: string
    idleMs?: number
    prefab?: string
  }
  mcp_servers: {
    type: 'mcp_servers'
    sessionId?: string
    servers?: unknown[]
  }
  session_usage: {
    type: 'session_usage'
    sessionId?: string
    cumulativeUsage?: Record<string, unknown>
  }
  session_cost_threshold_crossed: {
    type: 'session_cost_threshold_crossed'
    sessionId?: string
    costUsd?: number
    thresholdUsd?: number
  }
  dev_preview: {
    type: 'dev_preview'
    sessionId?: string
    port?: number
    url?: string
  }
  dev_preview_stopped: {
    type: 'dev_preview_stopped'
    sessionId?: string
    port?: number
  }
  web_feature_status: {
    type: 'web_feature_status'
    available?: unknown
    remote?: unknown
    teleport?: unknown
  }
  web_task_list: {
    type: 'web_task_list'
    tasks?: unknown[]
  }
  notification_prefs: {
    type: 'notification_prefs'
    prefs?: unknown
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
// (see the PR body's per-case diff verdicts). Genuinely-divergent cases
// (model_changed, permission_mode_changed, agent_idle — all carry a dashboard
// flat-state fallback the app lacks; budget_warning/exceeded — platform alert
// APIs; primary_changed, client_joined/left/focus_changed — the app's
// dedicated multi-client store; available_models — dashboard-only
// `availableModelsProvider`; permission_expired — divergent notification
// lifecycle + the dashboard's #2833 already-resolved branch) are deliberately
// NOT here — they stay platform-local and visible as such.
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
          messages: [...ss.messages, systemMessage],
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
      () => ({ sessionRules: rules } as Partial<S>),
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
// Slice 2 — next batch of byte-identical pure-delegation cases (epic #5556)
//
// Each below was diffed app-vs-dashboard and was byte-identical in BOTH
// switches (modulo comment text). The builder-pattern cases resolve a
// `{ sessionId, applyTo }` builder, then patch the target session only when it
// exists locally — none of them carry a flat-`messages`/flat-state fallback in
// either client, which is exactly why they were safe to share (the divergent
// cases that DO have a dashboard flat fallback stay platform-local).
//
// `notification_prefs` is the one slice-2 RECONCILE: the dashboard already
// routed through `handleNotificationPrefs`; the app hand-maintained a
// byte-identical inline Zod parse (same `ServerNotificationPrefsSchema`, same
// `bypassCategories` conditional spread, same warn-on-invalid). Unifying both
// on the shared handler kills that drift — behaviour is preserved for the app
// (the #4542/#4544 source-shape contract is the schema, which is unchanged).
// ---------------------------------------------------------------------------

/** `agent_spawned` — add the spawned background-agent entry to its session. */
function dispatchAgentSpawned<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['agent_spawned'],
  adapter: ClientStoreAdapter<S>,
): void {
  const builder = handleAgentSpawned(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (builder.sessionId && adapter.hasSession(builder.sessionId)) {
    adapter.updateSession(builder.sessionId, (ss) => {
      const next = builder.applyTo(ss.activeAgents ?? [])
      return next === ss.activeAgents ? ({} as Partial<S>) : ({ activeAgents: next } as Partial<S>)
    })
  }
}

/** `agent_completed` — remove the completed background-agent entry. */
function dispatchAgentCompleted<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['agent_completed'],
  adapter: ClientStoreAdapter<S>,
): void {
  const builder = handleAgentCompleted(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (builder.sessionId && adapter.hasSession(builder.sessionId)) {
    adapter.updateSession(builder.sessionId, (ss) => {
      const next = builder.applyTo(ss.activeAgents ?? [])
      return next === ss.activeAgents ? ({} as Partial<S>) : ({ activeAgents: next } as Partial<S>)
    })
  }
}

/** `agent_event` — append a nested child event to the parent Task bubble. */
function dispatchAgentEvent<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['agent_event'],
  adapter: ClientStoreAdapter<S>,
): void {
  const builder = handleAgentEvent(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (builder.sessionId && adapter.hasSession(builder.sessionId)) {
    adapter.updateSession(builder.sessionId, (ss) => {
      const next = builder.applyTo(ss.messages)
      return next === ss.messages ? ({} as Partial<S>) : ({ messages: next } as Partial<S>)
    })
  }
}

/** `background_work_changed` — replace the session's pending-shells snapshot. */
function dispatchBackgroundWorkChanged<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['background_work_changed'],
  adapter: ClientStoreAdapter<S>,
): void {
  const builder = handleBackgroundWorkChanged(
    msg as Record<string, unknown>,
    adapter.getActiveSessionId(),
  )
  if (builder.sessionId && adapter.hasSession(builder.sessionId)) {
    adapter.updateSession(builder.sessionId, (ss) => {
      const next = builder.applyTo(ss.pendingBackgroundShells ?? [])
      return next === ss.pendingBackgroundShells
        ? ({} as Partial<S>)
        : ({ pendingBackgroundShells: next } as Partial<S>)
    })
  }
}

/** `plan_started` — clear pending-plan state on the target session. */
function dispatchPlanStarted<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['plan_started'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { sessionId, patch } = handlePlanStarted(
    msg as Record<string, unknown>,
    adapter.getActiveSessionId(),
  )
  if (sessionId && adapter.hasSession(sessionId)) {
    adapter.updateSession(sessionId, () => patch as Partial<S>)
  }
}

/** `inactivity_warning` — stamp the soft check-in prompt onto its session. */
function dispatchInactivityWarning<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['inactivity_warning'],
  adapter: ClientStoreAdapter<S>,
): void {
  const warning = handleInactivityWarning(
    msg as Record<string, unknown>,
    adapter.getActiveSessionId(),
  )
  if (warning && warning.sessionId && adapter.hasSession(warning.sessionId)) {
    adapter.updateSession(warning.sessionId, () => warning.patch as Partial<S>)
  }
}

/** `mcp_servers` — replace the target session's MCP-server list. */
function dispatchMcpServers<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['mcp_servers'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { sessionId, patch } = handleMcpServers(
    msg as Record<string, unknown>,
    adapter.getActiveSessionId(),
  )
  if (sessionId && adapter.hasSession(sessionId)) {
    adapter.updateSession(sessionId, () => patch as Partial<S>)
  }
}

/** `session_usage` — store the session's cumulative token/cost usage. */
function dispatchSessionUsage<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['session_usage'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { sessionId, patch } = handleSessionUsage(
    msg as Record<string, unknown>,
    adapter.getActiveSessionId(),
  )
  if (sessionId && adapter.hasSession(sessionId)) {
    adapter.updateSession(sessionId, () => patch as Partial<S>)
  }
}

/** `session_cost_threshold_crossed` — store the one-shot cost-warning banner. */
function dispatchSessionCostThresholdCrossed<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['session_cost_threshold_crossed'],
  adapter: ClientStoreAdapter<S>,
): void {
  // Explicit sessionId only — no active-session fallback (matches both clients).
  const { sessionId, patch } = handleSessionCostThresholdCrossed(msg as Record<string, unknown>)
  if (sessionId && adapter.hasSession(sessionId)) {
    adapter.updateSession(sessionId, () => patch as unknown as Partial<S>)
  }
}

/** `dev_preview` — add/replace a dev-preview entry (deduped by port). */
function dispatchDevPreview<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['dev_preview'],
  adapter: ClientStoreAdapter<S>,
): void {
  const builder = handleDevPreview(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (builder.sessionId && adapter.hasSession(builder.sessionId)) {
    adapter.updateSession(builder.sessionId, (ss) => builder.applyTo(ss.devPreviews ?? []) as Partial<S>)
  }
}

/** `dev_preview_stopped` — remove the dev-preview entry matching `port`. */
function dispatchDevPreviewStopped<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['dev_preview_stopped'],
  adapter: ClientStoreAdapter<S>,
): void {
  const builder = handleDevPreviewStopped(
    msg as Record<string, unknown>,
    adapter.getActiveSessionId(),
  )
  if (builder.sessionId && adapter.hasSession(builder.sessionId)) {
    adapter.updateSession(builder.sessionId, (ss) => builder.applyTo(ss.devPreviews ?? []) as Partial<S>)
  }
}

/** `web_feature_status` — replace the flat Claude-Code-Web availability flags. */
function dispatchWebFeatureStatus<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['web_feature_status'],
  adapter: ClientStoreAdapter<S>,
): void {
  adapter.setState(
    handleWebFeatureStatus(msg as Record<string, unknown>) as unknown as Record<string, unknown>,
  )
}

/** `web_task_list` — replace the flat web-task list. */
function dispatchWebTaskList<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['web_task_list'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { tasks } = handleWebTaskList(msg as Record<string, unknown>)
  adapter.setState({ webTasks: tasks as WebTask[] } as Record<string, WebTask[]>)
}

/**
 * `notification_prefs` — validate + store the notification-prefs snapshot.
 * Slice-2 RECONCILE: both clients now share `handleNotificationPrefs`. A failed
 * parse logs a warning and leaves existing state untouched (prior behaviour on
 * both sides). The dashboard already did exactly this; the app's previously
 * inline Zod parse was byte-identical and is now retired.
 */
function dispatchNotificationPrefs<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['notification_prefs'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { notificationPrefs, issues } = handleNotificationPrefs(msg as Record<string, unknown>)
  if (!notificationPrefs) {
    // eslint-disable-next-line no-console
    console.warn('notification_prefs: invalid payload from server', issues)
    return
  }
  adapter.setState({ notificationPrefs } as Record<string, NotificationPrefsState>)
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
    // --- slice 2 (epic #5556) ---
    agent_spawned: dispatchAgentSpawned,
    agent_completed: dispatchAgentCompleted,
    agent_event: dispatchAgentEvent,
    background_work_changed: dispatchBackgroundWorkChanged,
    plan_started: dispatchPlanStarted,
    inactivity_warning: dispatchInactivityWarning,
    mcp_servers: dispatchMcpServers,
    session_usage: dispatchSessionUsage,
    session_cost_threshold_crossed: dispatchSessionCostThresholdCrossed,
    dev_preview: dispatchDevPreview,
    dev_preview_stopped: dispatchDevPreviewStopped,
    web_feature_status: dispatchWebFeatureStatus,
    web_task_list: dispatchWebTaskList,
    notification_prefs: dispatchNotificationPrefs,
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
  // --- slice 2 (epic #5556) ---
  'agent_spawned',
  'agent_completed',
  'agent_event',
  'background_work_changed',
  'plan_started',
  'inactivity_warning',
  'mcp_servers',
  'session_usage',
  'session_cost_threshold_crossed',
  'dev_preview',
  'dev_preview_stopped',
  'web_feature_status',
  'web_task_list',
  'notification_prefs',
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
