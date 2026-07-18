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
  QueuedSessionMessage,
  SessionIntervention,
  ServerErrorCategory,
  SessionRole,
  WebTask,
  Checkpoint,
} from './types'
import { nextMessageId } from './utils'
import {
  handleAvailablePermissionModes,
  handleSessionUpdated,
  handleAgentBusy,
  handleAgentIdle,
  handlePermissionModeChanged,
  handleBudgetResumed,
  handleBudgetWarning,
  handlePlanReady,
  handleRateLimited,
  handleServerShutdown,
  handleBudgetResumeAck,
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
  // --- inventory list-replacement cases (#5618 Batch 2) ---
  handleSlashCommands,
  handleAgentList,
  handleProviderList,
  // --- error-sink / session-status cases (#5618 Batch 3) ---
  handleSessionStopped,
  handleSessionRestoreFailed,
  handleSessionPersistFailed,
  // --- multi-client cases (#5618 Batch 4) ---
  handlePrimaryChanged,
  handleSessionRole,
  handleClientFocusChanged,
  // --- models / cost cases (#5618 Batch 5a) ---
  handleAvailableModels,
  handleCostUpdate,
  // --- connect-time burst / tunnel cases (#5618 Batch 5b) ---
  handleAuthBootstrap,
  handleTunnelUrlChanged,
  handleSessionUsage,
  handleSessionContext,
  handleModelChangedPatch,
  handleSessionCostThresholdCrossed,
  handleDevPreview,
  handleDevPreviewStopped,
  handleWebFeatureStatus,
  handleWebTaskList,
  // notification_prefs (slice 2 reconcile — app dropped its inline copy)
  handleNotificationPrefs,
  // --- slice 3 (epic #5556) — file-ops / git wrapper cases (#5653) ---
  handleDirectoryListing,
  handleFileListing,
  handleFileContent,
  handleWriteFileResult,
  handleDiffResult,
  handleGitStatusResult,
  handleGitBranchesResult,
  handleGitStageResult,
  handleGitCommitResult,
  // --- slice 4 (epic #5556) — web-task upsert (#5653 follow-on) ---
  handleWebTaskUpsert,
  applyWebTaskUpsert,
  // --- outgoing-message queue mirror (#5937, epic #5935 part ②) ---
  handleMessageQueued,
  handleMessageDequeued,
  type QueuedMessagesBuilder,
  // --- user_question (#5618) — byte-identical parse + append + notify ---
  handleUserQuestion,
  // --- multi_question_intervention (#5618) — byte-identical builder + append ---
  handleMultiQuestionIntervention,
  applyInterventionBuilder,
  // --- checkpoint cases (#5618 Batch 6) ---
  handleCheckpointCreated,
  handleCheckpointRestored,
  handleCheckpointFilesRestored,
  handleConversationsList,
  handleSearchResults,
  handleCheckpointList,
  resolveSessionId,
  type PermissionMode,
  type PermissionRule,
  type PendingPermissionConfirm,
  type NotificationPrefsState,
  type DirectoryListingPayload,
  type FileListingPayload,
  type FileContentPayload,
  type WriteFileResultPayload,
  type DiffResultPayload,
  type GitStatusResultPayload,
  type GitBranchesResultPayload,
  type GitStageResultPayload,
  type GitCommitResultPayload,
} from './handlers'
// #6449 slice 1 — shared raw-output parse for the terminal-mirror cases. The
// './handlers' barrel doesn't re-export stream.ts, so import it directly.
import { handleRawOutput } from './handlers/stream'

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
  // `streamingMessageId` — read+cleared by message_queued's faked-fresh-turn
  // reconcile (#6291). Both clients' real `SessionState` carry it
  // (BaseSessionState).
  streamingMessageId?: string | null
  // `pendingClientMessageId` — read+cleared alongside streamingMessageId by the
  // faked-fresh-turn reconcile (#6302): the queued echo only retires the
  // optimistic turn when its clientMessageId matches this owner. Both clients'
  // real `SessionState` carry it (BaseSessionState).
  pendingClientMessageId?: string | null
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
  // --- outgoing-message queue mirror (#5937) ---
  // `queuedMessages` — read+rewritten by message_queued / message_dequeued.
  // Both clients' real `SessionState` carry this array (BaseSessionState).
  queuedMessages?: QueuedSessionMessage[]
  // --- reconciled divergent case (#5618) ---
  // `activeModel` — written by model_changed. Both clients' real `SessionState`
  // carry it (the dashboard also mirrors the active session's value to flat
  // top-level state via its adapter).
  activeModel?: string | null
  // --- multi_question_intervention (#5618) ---
  // `interventions` — read+rewritten by multi_question_intervention (dedup +
  // ring-cap). Both clients' real `SessionState` carry it (BaseSessionState).
  interventions?: SessionIntervention[]
  // --- multi-client cases (#5618 Batch 4) ---
  // `primaryClientId` — written by primary_changed / session_role.
  // `sessionRole` — written by session_role (this client's derived role).
  // Both clients' real `SessionState` carry these (multi-client presence, #5281).
  primaryClientId?: string | null
  sessionRole?: SessionRole | null
  // --- cost_update (#5618 Batch 5a) ---
  // `sessionCost` — written by cost_update (the per-session running cost).
  // Both clients' real `SessionState` carry it (BaseSessionState).
  sessionCost?: number | null
}

/**
 * The session-notification event kinds the dispatch handlers may raise (#5618).
 * Deliberately the INTERSECTION both clients' `SessionNotification['eventType']`
 * accept — the app's union also has `'plan'`, the dashboard's does not — so a
 * value of this type is assignable to either client's real
 * `pushSessionNotification` without a cast. `user_question` only ever passes
 * `'question'`; widen this only to a kind BOTH clients accept.
 */
export type SessionNotificationEventType = 'permission' | 'question' | 'completed' | 'error'

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
  /**
   * Functional flat-state update (#5556 slice 4). The updater receives the
   * current flat state and returns the partial patch to shallow-merge. Needed
   * by the read-modify-write cases (`web_task_created` / `web_task_updated`),
   * whose upsert filters the existing `webTasks` list before appending — the
   * plain `setState(patch)` form cannot read prior state. Both clients back
   * this with their Zustand `set((state) => patch)`, which is byte-identical to
   * the inline `set((state) => …)` the migrated cases used.
   */
  updateState(updater: (flat: Flat) => Flat): void
  /** Append a chat message via the client's own add-message path. */
  addMessage(message: ChatMessage): void
  /**
   * Append raw bytes to the client's terminal view (#6449 slice 1). Backs the
   * terminal-mirror cases (`raw` / `raw_background` / `terminal_output`). Both
   * clients expose an `appendTerminalData(data)` store action; the APP impl ALSO
   * mirrors into its secondary `useTerminalStore` — a platform side-effect folded
   * into the adapter, in the same spirit as the push-store mirror in
   * {@link ClientStoreAdapter.pushSessionNotification}.
   */
  appendTerminalData(data: string): void
  /**
   * Surface a transient alert/toast to the user (#5618). Both clients back this
   * with their own alert primitive (the app's React-Native `Alert.alert`, the
   * dashboard's `_adapters.alert.alert`). Used by `budget_warning` and other
   * notice-bearing types whose body is otherwise byte-identical across clients.
   */
  alert(title: string, message: string): void
  /** Read the current session list (for `session_updated`). */
  getSessions(): SessionInfo[]
  /**
   * Read the current flat checkpoint list (#5618 Batch 6). `checkpoint_created`
   * is a read-modify-write (append to the existing list), so the dispatch
   * handler needs the prior array — mirrors the inline `get().checkpoints` both
   * clients read before this migration. Both back it with their flat connection
   * state's `checkpoints` field.
   */
  getCheckpoints(): Checkpoint[]
  /**
   * Push a per-session notification for a BACKGROUND session event (#5618).
   * Used by the `user_question` case to surface a question raised in a session
   * that is not the active one. Each client backs this with its own
   * `pushSessionNotification` — both dedup by `(sessionId, eventType)` and
   * early-return when the target IS the active session; the APP additionally
   * mirrors the row into its mobile push-notification store. That extra
   * side-effect is platform-specific and lives in the app's impl, exactly like
   * the app's `activityState` derivation — it is OUTSIDE the shared store-state
   * contract, so the dispatch handler stays platform-agnostic.
   */
  pushSessionNotification(sessionId: string, eventType: SessionNotificationEventType, message: string): void
  /**
   * Resolve a one-shot imperative callback by name (#5653). Used by the
   * file-ops / git wrapper cases, whose only effect is to invoke a callback the
   * UI registered out-of-band with the parsed payload — there is NO store
   * mutation. Returns the registered callback, or null when none is set.
   *
   * OPTIONAL: a client that does NOT plug an imperative-callback registry into
   * the table (e.g. the dashboard, which reads its callbacks straight off the
   * Zustand store) simply omits this. When it is absent, the file-ops / git
   * dispatch handlers DECLINE (return `false`) so {@link runDispatch} falls
   * through to that client's own switch — keeping migration per-client and
   * behaviour-preserving for clients that have not opted in.
   *
   * The payload type is the union of all parsed file-ops / git payloads; the
   * caller (which knows the concrete callback signature for `name`) narrows it.
   */
  getCallback?(name: DispatchCallbackName): ((payload: DispatchCallbackPayload) => void) | null | undefined
  /**
   * Mirror a server-wide inventory list into a SECONDARY client store (#5618
   * Batch 2). The mobile app keeps a separate `useConversationStore` that also
   * tracks the slash-command / custom-agent lists for its composer UI; after the
   * `slash_commands` / `agent_list` dispatch handlers write the list into flat
   * connection state, they call this to keep the secondary store in sync —
   * exactly the app's prior inline
   * `useConversationStore.getState().setSlashCommands(...)` / `setCustomAgents(...)`.
   *
   * OPTIONAL: a client without a secondary inventory store (the dashboard) omits
   * it; the dispatch handler then performs only the flat-state write. This is a
   * platform-specific side-effect OUTSIDE the shared store-state contract, in the
   * same spirit as the app's extra push-store mirror in
   * {@link ClientStoreAdapter.pushSessionNotification}.
   */
  syncSecondaryInventory?(kind: 'slashCommands' | 'customAgents', list: unknown[]): void
  /**
   * Apply a no-session FALLBACK patch to the FLAT connection state (#5618). When a
   * session-targeted message (`agent_idle`, `permission_mode_changed`, …) arrives for
   * a session that isn't in `sessionStates`, the DASHBOARD writes the patch into its
   * flat state — its UI reads flat fields directly (`streamingMessageId`/`isIdle` for
   * the stop button, App.tsx isStreaming; `permissionMode` for the mode pill) and its
   * pre-bootstrap `sendInput` writes flat `pending`, so without this an abnormal
   * broadcast leaves that flat UI stale (#5760). The APP has no flat mirror for these
   * (it derives them from the active session) and OMITS this hook — a faithful
   * per-client preservation of the prior switch behaviour, like {@link syncSecondaryInventory}.
   */
  applyNoSessionFallback?(patch: Flat): void
  /**
   * Clear the APP's pending permission-mode optimistic-revert tracker for a session
   * (#5618). On a `permission_mode_changed` broadcast the app drops any in-flight
   * optimistic revert for `sessionId` so a late rejection can't undo the confirmed
   * mode; the DASHBOARD has no equivalent per-session tracker and OMITS this hook.
   * A null sessionId is a no-op.
   */
  clearPendingPermissionModeRequests?(sessionId: string | null): void
  /**
   * Surface the APP's `plan_ready` session notification (#5618). On `plan_ready`
   * the app pushes a 'plan' background-session notification ("Plan ready for
   * approval"); the DASHBOARD has no equivalent surface and OMITS this hook.
   */
  notifyPlanReady?(sessionId: string): void
  /**
   * Apply the APP's `server_shutdown` notification side-effect (#5618). After the
   * shared shutdown patch is written to flat state, the app mirrors it into its
   * mobile notification store (`setShutdown`); the DASHBOARD omits this hook.
   */
  applyShutdownNotification?(payload: { shutdownReason: 'restart' | 'shutdown' | 'crash'; restartEtaMs: number; restartingSince: number }): void
  /**
   * Auto-switch to the session a checkpoint restore created (#5618). BOTH clients
   * switch, so this is required (not optional) — the only divergence is the options:
   * the APP passes `{ serverNotify: false, haptic: false }` (the server already
   * re-homed this client, and an auto-switch shouldn't buzz), the DASHBOARD passes
   * none. Each client backs it with its store's `switchSession`.
   */
  switchToRestoredSession(sessionId: string): void
  /**
   * Apply the APP's `conversations_list` extras (#5618): clear the app-only
   * `conversationHistoryError` flag and mirror the list into its secondary
   * `useConversationStore`. The DASHBOARD has neither and OMITS this hook (the
   * shared `conversationHistory` / `conversationHistoryLoading` write is enough).
   */
  applyConversationsListExtras?(conversations: unknown[]): void
  /**
   * Read the current flat `searchQuery` (#5618). `search_results` needs it for the
   * staleness gate — a late response for an older query is dropped. Both clients
   * back it with their flat connection state's `searchQuery`.
   */
  getSearchQuery(): string | null
  /**
   * Apply the APP's `search_results` extras (#5618): clear the app-only `searchError`
   * flag and mirror the results into its secondary `useConversationStore`. The
   * DASHBOARD has neither and OMITS this hook (the shared `searchResults` /
   * `searchLoading` write is enough).
   */
  applySearchResultsExtras?(results: unknown[]): void
  /**
   * Mirror checkpoint changes into a SECONDARY client store (#5618 Batch 6).
   * The mobile app keeps a separate `useConversationStore` whose checkpoint list
   * powers its timeline UI; after the `checkpoint_created` / `checkpoint_list`
   * dispatch handlers write the flat connection-state list, they call this to
   * keep that store in sync — exactly the app's prior inline
   * `useConversationStore.getState().addCheckpoint(...)` (append) /
   * `setCheckpoints(...)` (replace). The `kind` discriminates which call.
   *
   * OPTIONAL: a client without a secondary checkpoint store (the dashboard)
   * omits it; the dispatch handler then performs only the flat-state write. A
   * platform-specific side-effect OUTSIDE the shared store-state contract, in
   * the same spirit as {@link ClientStoreAdapter.syncSecondaryInventory}.
   */
  syncSecondaryCheckpoints?(
    op: { kind: 'append'; checkpoint: Checkpoint } | { kind: 'replace'; checkpoints: Checkpoint[] },
  ): void
  /**
   * Map/validate the raw `provider_list` element array before it is written to
   * flat state (#5618 Batch 2). The mobile app tightens each entry (drops
   * non-object / nameless entries, copies only `name`/`capabilities`/`auth`) via
   * its `mapProviderList`; the dashboard trusts the server payload and writes it
   * verbatim.
   *
   * OPTIONAL: when omitted, the raw array is written unchanged (the dashboard's
   * prior `set({ availableProviders: providers as ProviderInfo[] })`). When
   * present, the returned array is written instead (the app's prior
   * `set({ availableProviders: mapProviderList(providers) })`). For the
   * well-formed payloads the server actually sends, the two are field-identical;
   * the hook only diverges on malformed input, preserving each client's existing
   * robustness behaviour.
   */
  mapProviderList?(providers: unknown[]): unknown[]
  /**
   * Surface a recoverable server-side error to the user (#5618 Batch 3). Used by
   * the `session_restore_failed` / `session_persist_failed` cases, whose ONLY
   * effect is to surface the error — there is no shared store mutation. Each
   * client renders it its own way: the app builds a structured `ServerError`
   * (ring-capped flat `serverErrors` list + mobile `useNotificationStore`); the
   * dashboard calls its connection-store `addServerError(message)` (string
   * banner, which builds its own envelope). The shared handler passes the
   * already-constructed human-readable `message` plus structured metadata; a
   * client uses whatever subset it needs (the dashboard ignores `opts`).
   *
   * OPTIONAL — and DECLINE-capable: when a client's adapter does NOT supply it,
   * the restore/persist dispatch handlers return `false` so {@link runDispatch}
   * falls through to that client's own switch (matching the
   * imperative-callback / `getCallback` pattern — the error-sink IS the whole
   * effect, so a client that hasn't wired it must keep handling the case
   * locally). Both real clients supply it, so both OWN these cases.
   */
  addServerError?(
    message: string,
    opts?: { category?: ServerErrorCategory; sessionId?: string; recoverable?: boolean },
  ): void
  /**
   * Surface a low-priority INFO notification (#5618 Batch 3). Used by
   * `session_stopped` for the dashboard's "Session stopped." info toast
   * (`addInfoNotification`). The app deliberately shows NO toast here (#4879 —
   * the inline session banner carries the signal), so it OMITS this hook.
   *
   * OPTIONAL and out-of-contract: unlike `addServerError`, `session_stopped`
   * ALSO performs a shared session patch (`stoppedAt`/`stoppedCode`), so its
   * handler always OWNS the message and never declines — it just skips the toast
   * when the hook is absent. This is a platform-specific side-effect like
   * {@link ClientStoreAdapter.pushSessionNotification}.
   */
  addInfoNotification?(message: string): void
  /**
   * Read THIS client's own client id (#5618 Batch 4) — learned from `auth_ok`.
   * Used by session_role (to derive this client's role) and client_focus_changed
   * (to ignore self-focus events). The app reads it from its dedicated
   * `useMultiClientStore`; the dashboard from flat state — the SOLE divergence
   * these cases had, now hidden behind this accessor.
   *
   * OPTIONAL and DECLINE-capable: the session_role / client_focus_changed
   * handlers return `false` when it is absent so a client that hasn't wired the
   * multi-client accessors falls through to its own switch. Both real clients
   * supply it, so both own those cases.
   */
  getMyClientId?(): string | null
  /**
   * Read the "follow mode" flag (#5618 Batch 4) — when on, this client
   * auto-switches to whatever session another client focuses. Used only by
   * client_focus_changed. App: `useMultiClientStore`; dashboard: flat state.
   * OPTIONAL/DECLINE-capable (see {@link ClientStoreAdapter.getMyClientId}).
   */
  getFollowMode?(): boolean
  /**
   * Switch the active session (#5618 Batch 4) — the client's own
   * session-switch action, invoked by client_focus_changed's follow-mode
   * auto-switch. Both clients back it with their store's `switchSession`.
   * OPTIONAL/DECLINE-capable (see {@link ClientStoreAdapter.getMyClientId}).
   */
  switchSession?(sessionId: string): void
  /**
   * Mirror the primary client id into a SECONDARY client store (#5618 Batch 4).
   * The app keeps a dedicated `useMultiClientStore` whose `primaryClientId` the
   * presence UI reads; primary_changed updates it in addition to the shared
   * session/flat write. The dashboard has no such store and OMITS this hook.
   * A platform-specific side-effect OUTSIDE the shared store-state contract,
   * like {@link ClientStoreAdapter.pushSessionNotification}; primary_changed
   * always OWNS the message (it never declines — the shared write applies
   * regardless).
   */
  setPrimaryClientId?(clientId: string | null): void
  /**
   * Contribute extra flat fields to the `available_models` patch (#5618 Batch 5a).
   * The dashboard tracks which provider the model list is for
   * (`availableModelsProvider`, parsed from `msg.provider`) and writes it in the
   * SAME `set` as the models; the app store has no such field. The dispatcher
   * spreads the returned object into the single `setState` patch, preserving the
   * single-write behaviour.
   *
   * OPTIONAL: when omitted (the app), no extra fields are added. Returns the
   * patch fragment (e.g. `{ availableModelsProvider }`); receives the raw wire
   * message so the client parses only the fields it needs.
   */
  extendModelsPatch?(msg: Record<string, unknown>): Record<string, unknown>
  /**
   * Mirror a cost update into the client's flat state + cost store (#5618 Batch 5a).
   * `cost_update`'s shared effect is the per-session `sessionCost` patch; the app
   * ADDITIONALLY writes flat `totalCost`/`costBudget` and dual-writes the
   * `useCostStore`. The dashboard does neither. A platform-specific side-effect
   * OUTSIDE the shared store-state contract; cost_update always OWNS the message
   * (the session patch applies regardless), so it never declines.
   */
  setCostUpdate?(totalCost: number | null, budget: number | null): void
  /**
   * Repoint the client's persisted tunnel endpoint after a quick-tunnel URL
   * rotation (#5618 Batch 5b). Used by `tunnel_url_changed` and the
   * `auth_bootstrap` connect-time burst. The STORAGE is platform-local (mobile:
   * the SecureStore-backed `SavedConnection.tunnelUrl`; dashboard: the
   * localStorage server-registry entry's wsUrl), so each client wraps its own
   * apply — the dashboard additionally consults `previousUrl` to match the right
   * entry; the app ignores it.
   *
   * OPTIONAL: `tunnel_url_changed`'s ONLY effect is this apply, so that handler
   * DECLINES when the hook is absent (the file-ops / getCallback pattern).
   * `auth_bootstrap` calls it best-effort (optional-chained) and still OWNS the
   * message via its shared list writes.
   */
  applyRotatedTunnelUrl?(url: string, previousUrl: string | null): void
}

/**
 * Names of the imperative callbacks the file-ops / git dispatch cases invoke
 * (#5653). Mirrors the app's `CallbackName` union for the migrated subset;
 * `terminalWrite` is NOT here because the terminal case is not table-migrated.
 */
export type DispatchCallbackName =
  | 'directoryListing'
  | 'fileBrowser'
  | 'fileContent'
  | 'fileWrite'
  | 'diff'
  | 'gitStatus'
  | 'gitBranches'
  | 'gitStage'
  | 'gitCommit'

/**
 * Union of the parsed payloads the file-ops / git callbacks receive. Each
 * dispatch handler invokes its callback with exactly the payload the prior
 * inline `case` arm passed (entries cast to the concrete `DirectoryEntry[]` /
 * `FileEntry[]` happens client-side via the registered callback's own type).
 */
export type DispatchCallbackPayload =
  | DirectoryListingPayload
  | FileListingPayload
  | FileContentPayload
  | WriteFileResultPayload
  | DiffResultPayload
  | GitStatusResultPayload
  | GitBranchesResultPayload
  | GitStageResultPayload
  | GitCommitResultPayload

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
  agent_idle: {
    type: 'agent_idle'
    sessionId?: string
  }
  permission_mode_changed: {
    type: 'permission_mode_changed'
    sessionId?: string
    mode?: string | null
  }
  budget_warning: {
    type: 'budget_warning'
    sessionId?: string
    message?: string
  }
  plan_ready: {
    type: 'plan_ready'
    sessionId?: string
    allowedPrompts?: unknown[]
  }
  rate_limited: {
    type: 'rate_limited'
    message?: string
    retryAfterMs?: number
  }
  server_shutdown: {
    type: 'server_shutdown'
    reason?: string
    restartEtaMs?: number
  }
  conversations_list: {
    type: 'conversations_list'
    conversations?: unknown[]
  }
  checkpoint_restored: {
    type: 'checkpoint_restored'
    newSessionId?: string
    // #6766: true when only files were restored (conversation NOT branched).
    filesOnly?: boolean
    // #6767: selective-restore mode the server ran. 'files' omits newSessionId
    // (current session kept — no switch); 'conversation'/'both' carry it.
    mode?: 'files' | 'conversation' | 'both'
    // #6827: the rewound session's name ('conversation'/'both') or the
    // CHECKPOINT's name ('files' — used in the files-restored confirmation).
    name?: string
  }
  search_results: {
    type: 'search_results'
    query?: string
    results?: unknown[]
  }
  budget_resumed: {
    type: 'budget_resumed'
    sessionId?: string
  }
  budget_resume_ack: {
    type: 'budget_resume_ack'
    sessionId?: string
    // Required, matching ServerBudgetResumeAckSchema — the server always sends it.
    wasPaused: boolean
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
  // --- inventory list-replacement cases (#5618 Batch 2) ---
  // slash_commands / agent_list carry the broadcast-guard `sessionId`; the
  // parser drops the message when it targets a non-active session. Element shape
  // is validated downstream (the cast stays at the flat-state write).
  slash_commands: {
    type: 'slash_commands'
    sessionId?: string
    commands?: unknown[]
  }
  agent_list: {
    type: 'agent_list'
    sessionId?: string
    agents?: unknown[]
  }
  provider_list: {
    type: 'provider_list'
    providers?: unknown[]
  }
  // --- error-sink / session-status cases (#5618 Batch 3) ---
  // The parsers read the raw fields; the map only needs `type` (+ the optional
  // wire fields the handlers narrow themselves).
  session_stopped: {
    type: 'session_stopped'
    sessionId?: string
    code?: number
  }
  session_restore_failed: {
    type: 'session_restore_failed'
    sessionId?: string
    name?: string
  }
  session_persist_failed: {
    type: 'session_persist_failed'
    sessionId?: string
    name?: string
  }
  // --- multi-client cases (#5618 Batch 4) ---
  primary_changed: {
    type: 'primary_changed'
    sessionId?: string
    // null on the wire when the session is unclaimed (handlePrimaryChanged
    // parses it via parseRawStringField → string | null).
    clientId?: string | null
  }
  session_role: {
    type: 'session_role'
    sessionId?: string
    // null when the session is unclaimed (handleSessionRole derives 'unclaimed').
    primaryClientId?: string | null
  }
  client_focus_changed: {
    type: 'client_focus_changed'
    clientId?: string
    sessionId?: string
  }
  // --- models / cost cases (#5618 Batch 5a) ---
  available_models: {
    type: 'available_models'
    models?: unknown[]
    defaultModel?: string
    // dashboard-only: which provider the list is for (parsed at the call site).
    provider?: string
  }
  cost_update: {
    type: 'cost_update'
    sessionId?: string
    sessionCost?: number
    // app-only flat/cost-store mirror fields (parsed at the call site).
    totalCost?: number
    budget?: number
  }
  // --- connect-time burst / tunnel cases (#5618 Batch 5b) ---
  // The handlers parse the raw fields defensively; the map only needs `type`
  // (+ the optional wire fields each parser reads).
  tunnel_url_changed: {
    type: 'tunnel_url_changed'
    url?: string
    previousUrl?: string
  }
  auth_bootstrap: {
    type: 'auth_bootstrap'
    sessionId?: string
    providers?: unknown[]
    slashCommands?: unknown[]
    agents?: unknown[]
    tunnelUrl?: string
  }
  session_usage: {
    type: 'session_usage'
    sessionId?: string
    cumulativeUsage?: Record<string, unknown>
  }
  session_context: {
    type: 'session_context'
    sessionId?: string
    gitBranch?: unknown
    gitDirty?: unknown
    gitAhead?: unknown
    projectName?: unknown
  }
  model_changed: {
    type: 'model_changed'
    sessionId?: string
    model?: string
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
  // --- slice 3 (epic #5556) — file-ops / git wrapper cases (#5653) ---
  // These all carry the raw fields the corresponding `handle*` parser reads;
  // the parser does the per-field narrowing, so the map only needs `type`.
  directory_listing: { type: 'directory_listing' }
  file_listing: { type: 'file_listing' }
  file_content: { type: 'file_content' }
  write_file_result: { type: 'write_file_result' }
  diff_result: { type: 'diff_result' }
  git_status_result: { type: 'git_status_result' }
  git_branches_result: { type: 'git_branches_result' }
  git_stage_result: { type: 'git_stage_result' }
  git_unstage_result: { type: 'git_unstage_result' }
  git_commit_result: { type: 'git_commit_result' }
  // --- slice 4 (epic #5556) — web-task upsert ---
  // Both carry a single `task` payload; `handleWebTaskUpsert` validates it and
  // the dispatch handler filter-and-appends against the flat `webTasks` list.
  web_task_created: { type: 'web_task_created'; task?: unknown }
  web_task_updated: { type: 'web_task_updated'; task?: unknown }
  // --- outgoing-message queue mirror (#5937, epic #5935 part ②) ---
  // Field optionality mirrors the protocol wire contract exactly
  // (ServerMessageQueuedSchema / ServerMessageDequeuedSchema in
  // packages/protocol/src/schemas/server.ts): the server ALWAYS emits
  // sessionId/text/queueLength/reason, so they are required here to catch
  // producer/normalizer drift at compile time; only clientMessageId is
  // genuinely optional (echoed only when the sender supplied one). The pure
  // handlers still re-validate defensively at runtime.
  message_queued: {
    type: 'message_queued'
    sessionId: string
    clientMessageId?: string
    text: string
    queueLength: number
  }
  message_dequeued: {
    type: 'message_dequeued'
    sessionId: string
    clientMessageId?: string
    queueLength: number
    // #5943 adds 'cancelled' (per-item cancel via cancel_queued) alongside the
    // slice-① 'flush'/'interrupted'. Mirrors ServerMessageDequeuedSchema.reason.
    reason: 'flush' | 'interrupted' | 'cancelled'
  }
  // --- user_question (#5618) — the question payload the shared parser reads ---
  user_question: {
    type: 'user_question'
    sessionId?: string
    toolUseId?: string
    questions?: unknown[]
    // #4613 — `handleUserQuestion` honours a wire `timestamp` (when a finite
    // number) for history-replay ordering, falling back to append-time
    // Date.now(). Documented here so the message shape matches the parser.
    timestamp?: number
  }
  // --- multi_question_intervention (#5618) — the deny-event the builder reads ---
  multi_question_intervention: {
    type: 'multi_question_intervention'
    sessionId?: string
    toolUseId?: string
    questionCount?: number
    reason?: string
    timestamp?: number
  }
  // --- checkpoint cases (#5618 Batch 6) ---
  // Both carry the broadcast-guard `sessionId`; the active-session gate +
  // payload validation live in handleCheckpointCreated / handleCheckpointList.
  checkpoint_created: {
    type: 'checkpoint_created'
    sessionId?: string
    checkpoint?: unknown
  }
  checkpoint_list: {
    type: 'checkpoint_list'
    sessionId?: string
    checkpoints?: unknown[]
  }
  // #6449 slice 1 — terminal-mirror pass-through cases (wire-shape optionality:
  // raw_background carries no sessionId; the handlers guard defensively anyway).
  raw: {
    type: 'raw'
    sessionId?: string
    data?: string
  }
  raw_background: {
    type: 'raw_background'
    data?: string
  }
  terminal_output: {
    type: 'terminal_output'
    sessionId?: string
    data?: string
  }
}

/** Union of message types this table currently handles. */
export type DispatchMessageType = keyof DispatchMessageMap

/**
 * A single dispatch-table entry: a pure delegation into a store-core handler.
 *
 * Returns `void` (handled — the common case) or `false` to DECLINE, signalling
 * {@link runDispatch} to fall through to the caller's own switch. Only the
 * file-ops / git wrapper cases (#5653) decline — they need the client's
 * imperative-callback registry via {@link ClientStoreAdapter.getCallback}, and
 * a client that does not supply one (e.g. the dashboard) must keep handling
 * those types in its local switch.
 */
export type DispatchHandler<K extends DispatchMessageType, S extends DispatchSessionBase> = (
  msg: DispatchMessageMap[K],
  adapter: ClientStoreAdapter<S>,
) => void | false

/** The full dispatch table — every migrated type maps to its handler. */
export type DispatchTable<S extends DispatchSessionBase> = {
  [K in DispatchMessageType]: DispatchHandler<K, S>
}

// ---------------------------------------------------------------------------
// Handlers — one pure delegation per migrated case
//
// Each was byte-for-byte identical between the app and dashboard switches
// (see the PR body's per-case diff verdicts). model_changed (#5618) was
// RECONCILED into the table — its only divergence was a stray-unknown-session
// edge fallback (app → active session; dashboard → flat write), now a clean
// no-op; every known-target case (incl. the dashboard's flat mirror) is
// preserved. Genuinely-divergent cases still left out:
// (permission_mode_changed, agent_idle — carry a dashboard
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

/**
 * `agent_idle` — flip the target session to idle (#5618). Byte-identical to the
 * prior switch case for a SEEDED session: `updateSession(target, () => handleAgentIdle())`
 * ({ isIdle, streamingMessageId: null, activeTools: [] }). The no-session FALLBACK
 * (the dashboard mirrors the patch into flat state; the app no-ops) is preserved
 * per-client via the optional {@link ClientStoreAdapter.applyNoSessionFallback} hook
 * — no behaviour change on either client.
 */
function dispatchAgentIdle<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['agent_idle'],
  adapter: ClientStoreAdapter<S>,
): void {
  const targetId = resolveSessionId(msg as Record<string, unknown>, adapter.getActiveSessionId())
  const idlePatch = handleAgentIdle()
  if (targetId && adapter.hasSession(targetId)) {
    adapter.updateSession(targetId, () => idlePatch as unknown as Partial<S>)
  } else {
    adapter.applyNoSessionFallback?.(idlePatch as unknown as Record<string, unknown>)
  }
}

/**
 * `permission_mode_changed` — apply the new permission mode to the target session
 * (#5618). Reconciliation of the two prior switch cases:
 *  - **Session resolution = targetId-direct** (Decision A): apply when the target is
 *    local, else the dashboard's flat fallback via {@link ClientStoreAdapter.applyNoSessionFallback}.
 *    This drops the APP's prior `effectiveId` retry-to-active-session, which only
 *    diverged when the target wasn't in `sessionStates` — unreachable in normal use
 *    (`session_list` seeds a shell for every session) and a latent multi-client bug
 *    when it did fire (it applied another session's broadcast to the active one).
 *  - **clearPending** (app-only optimistic-revert tracker) is preserved via
 *    {@link ClientStoreAdapter.clearPendingPermissionModeRequests} — the app implements
 *    it, the dashboard omits it. Keyed on `targetId` (the session the broadcast is
 *    *for*), matching the app's prior multi-client-safe clear.
 *  - **`pendingPermissionConfirm: null`** (both clients) via `setState`.
 */
function dispatchPermissionModeChanged<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['permission_mode_changed'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { mode } = handlePermissionModeChanged(msg as Record<string, unknown>)
  const targetId = resolveSessionId(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (targetId && adapter.hasSession(targetId)) {
    adapter.updateSession(targetId, () => ({ permissionMode: mode }) as unknown as Partial<S>)
  } else {
    adapter.applyNoSessionFallback?.({ permissionMode: mode })
  }
  // Guard on targetId (matches the app's prior `if (targetId)`): never clear the
  // tracker with a null key — clearing the app's pending entries is keyed on the
  // session the broadcast is *for*.
  if (targetId) {
    adapter.clearPendingPermissionModeRequests?.(targetId)
  }
  adapter.setState({ pendingPermissionConfirm: null })
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

/**
 * `budget_warning` (#5618) — alert the user and append a system message to the
 * target session (or the flat add-message path when it isn't local). Byte-identical
 * across clients except the alert primitive, which is the required `adapter.alert`.
 */
function dispatchBudgetWarning<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['budget_warning'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { warningMessage, systemMessage } = handleBudgetWarning(msg as Record<string, unknown>)
  adapter.alert('Budget Warning', warningMessage)
  const targetId = resolveSessionId(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (targetId && adapter.hasSession(targetId)) {
    adapter.updateSession(targetId, (ss) => ({ messages: [...ss.messages, systemMessage] } as Partial<S>))
  } else {
    adapter.addMessage(systemMessage)
  }
}

/**
 * `rate_limited` (#6334, #5618) — surface the server-side throttle as a brief
 * system notice on the ACTIVE session (or the flat add-message path). Byte-identical
 * across both clients.
 */
function dispatchRateLimited<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['rate_limited'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { chatMessage } = handleRateLimited(msg as Record<string, unknown>)
  const activeId = adapter.getActiveSessionId()
  if (activeId && adapter.hasSession(activeId)) {
    adapter.updateSession(activeId, (ss) => ({ messages: [...ss.messages, chatMessage] } as Partial<S>))
  } else {
    adapter.addMessage(chatMessage)
  }
}

/**
 * `plan_ready` (#5618) — flip the target session into plan-pending. The APP also
 * raises a 'plan' background-session notification via the optional
 * {@link ClientStoreAdapter.notifyPlanReady} hook (the dashboard omits it).
 */
function dispatchPlanReady<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['plan_ready'],
  adapter: ClientStoreAdapter<S>,
): void {
  const planReady = handlePlanReady(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (planReady.sessionId && adapter.hasSession(planReady.sessionId)) {
    adapter.updateSession(planReady.sessionId, () => planReady.patch as unknown as Partial<S>)
  }
  if (planReady.sessionId) {
    adapter.notifyPlanReady?.(planReady.sessionId)
  }
}

/**
 * `server_shutdown` (#5618) — write the shared shutdown patch to flat state. The
 * APP additionally mirrors it into its mobile notification store via the optional
 * {@link ClientStoreAdapter.applyShutdownNotification} hook (the dashboard omits it).
 */
function dispatchServerShutdown<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['server_shutdown'],
  adapter: ClientStoreAdapter<S>,
): void {
  const payload = handleServerShutdown(msg as Record<string, unknown>)
  adapter.setState(payload as unknown as Record<string, unknown>)
  adapter.applyShutdownNotification?.(payload)
}

/**
 * `conversations_list` (#5618) — replace the flat conversation-history list. Both
 * clients write `conversationHistory` + `conversationHistoryLoading: false`
 * identically; the APP's extra error-clear + secondary-store mirror ride the
 * optional {@link ClientStoreAdapter.applyConversationsListExtras} hook.
 */
function dispatchConversationsList<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['conversations_list'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { conversations } = handleConversationsList(msg as Record<string, unknown>)
  adapter.setState({ conversationHistory: conversations, conversationHistoryLoading: false })
  adapter.applyConversationsListExtras?.(conversations)
}

/**
 * `checkpoint_restored` (#5618) — the server created a new session at the restored
 * checkpoint and re-homed this client onto it; auto-switch to it. Both clients
 * switch via the required {@link ClientStoreAdapter.switchToRestoredSession} hook
 * (the app passes its no-notify/no-haptic options, the dashboard plain).
 *
 * #6767/#6827: a 'files'-mode restore keeps the CURRENT session — no
 * `newSessionId`, so the re-home path is a no-op. Confirm the revert visibly
 * instead with a `system` message on the active session's transcript (the
 * `budget_resumed` pattern; byte-identical across both clients) so a files-only
 * rewind is never silent.
 */
function dispatchCheckpointRestored<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['checkpoint_restored'],
  adapter: ClientStoreAdapter<S>,
): void {
  const restored = handleCheckpointRestored(msg as Record<string, unknown>)
  if (restored) {
    adapter.switchToRestoredSession(restored.newSessionId)
    return
  }
  const filesRestored = handleCheckpointFilesRestored(msg as Record<string, unknown>)
  if (!filesRestored) return
  const activeId = adapter.getActiveSessionId()
  if (activeId && adapter.hasSession(activeId)) {
    adapter.updateSession(
      activeId,
      (ss) => ({ messages: [...ss.messages, filesRestored.systemMessage] } as Partial<S>),
    )
  } else {
    adapter.addMessage(filesRestored.systemMessage)
  }
}

/**
 * `search_results` (#5618) — apply conversation-search results, dropping a stale
 * response for an older query (the staleness gate reads the live `searchQuery` via
 * the adapter). Both clients write the flat `searchResults` + `searchLoading: false`
 * identically; the APP's extra `searchError` clear + secondary-store mirror ride the
 * optional {@link ClientStoreAdapter.applySearchResultsExtras} hook.
 */
function dispatchSearchResults<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['search_results'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { results, shouldApply } = handleSearchResults(msg as Record<string, unknown>, adapter.getSearchQuery())
  if (!shouldApply) return
  adapter.setState({ searchResults: results, searchLoading: false })
  adapter.applySearchResultsExtras?.(results)
}

/**
 * `budget_resume_ack` (#5752) — acknowledge an actioned `resume_budget`. A
 * no-op when the session was actually paused (the accompanying `budget_resumed`
 * broadcast already showed the "resumed" note); appends a quiet "nothing to
 * resume" note otherwise, so the resume control is never silently dead.
 */
function dispatchBudgetResumeAck<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['budget_resume_ack'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { systemMessage } = handleBudgetResumeAck(msg as Record<string, unknown>)
  if (!systemMessage) return
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

/**
 * `message_queued` / `message_dequeued` (#5937) — reconcile / remove the
 * dequeued entry in the session's `queuedMessages`. Same builder-on-a-list shape
 * as `background_work_changed`: apply against the current array, and skip the
 * write (referential equality) when the builder returned the same array (a
 * duplicate `message_queued` or an unknown-id `message_dequeued`).
 */
function dispatchQueuedMessages<S extends DispatchSessionBase>(
  handle: (
    msg: Record<string, unknown>,
    activeSessionId: string | null,
  ) => QueuedMessagesBuilder | null,
): (msg: Record<string, unknown>, adapter: ClientStoreAdapter<S>) => void {
  return (msg, adapter) => {
    const builder = handle(msg, adapter.getActiveSessionId())
    if (builder && builder.sessionId && adapter.hasSession(builder.sessionId)) {
      adapter.updateSession(builder.sessionId, (ss) => {
        const next = builder.applyTo(ss.queuedMessages ?? []).queuedMessages
        // Compare against the ORIGINAL field (mirrors dispatchBackgroundWorkChanged):
        // when the builder returned the same array AND the field already held it,
        // skip the write so React's referential check elides a re-render. When the
        // field was undefined, `next` is a fresh array (!== undefined) → write.
        const patch: Partial<S> =
          next === ss.queuedMessages ? ({} as Partial<S>) : ({ queuedMessages: next } as Partial<S>)
        // #6291 — in the SAME update, retire a client-faked optimistic "working"
        // turn (streamingMessageId: 'pending' + 'thinking' bubble) when this
        // message_queued confirms the send the server actually queued. This makes
        // the spinner→badge swap happen in one step immediately instead of waiting
        // for the client's 5s stream-stall safety net.
        // #6302 — thread the pending-turn OWNER so the reconcile fires only for
        // this client's own optimistic send (queued echo's clientMessageId ===
        // pendingClientMessageId), not another client's broadcast queued send.
        const turnPatch = builder.reconcileFakedFreshTurn?.({
          streamingMessageId: ss.streamingMessageId ?? null,
          messages: ss.messages,
          pendingClientMessageId: ss.pendingClientMessageId ?? null,
        })
        if (turnPatch) {
          if ('streamingMessageId' in turnPatch) {
            ;(patch as { streamingMessageId?: string | null }).streamingMessageId =
              turnPatch.streamingMessageId
          }
          if ('pendingClientMessageId' in turnPatch) {
            ;(patch as { pendingClientMessageId?: string | null }).pendingClientMessageId =
              turnPatch.pendingClientMessageId
          }
          if (turnPatch.messages) {
            ;(patch as { messages?: ChatMessage[] }).messages = turnPatch.messages
          }
        }
        return patch
      })
    }
  }
}

/**
 * Factory (audit P2-10) for the `{sessionId, patch} → hasSession → updateSession`
 * dispatchers that were byte-identical modulo handler name (plan_started,
 * mcp_servers, session_usage, session_context). A missed copy silently misroutes
 * a session patch, so the shape lives here once. `handle` parses the wire message
 * (with the active-session fallback) and returns the target id + patch; the
 * dispatcher applies it only when the session exists.
 * `session_cost_threshold_crossed` stays a one-off (no active-session fallback,
 * different cast) and `inactivity_warning` stays separate (nullable result).
 */
function sessionPatchDispatcher<S extends DispatchSessionBase>(
  handle: (msg: Record<string, unknown>, activeSessionId: string | null) => { sessionId: string | null; patch: unknown },
): (msg: Record<string, unknown>, adapter: ClientStoreAdapter<S>) => void {
  return (msg, adapter) => {
    const { sessionId, patch } = handle(msg, adapter.getActiveSessionId())
    if (sessionId && adapter.hasSession(sessionId)) {
      adapter.updateSession(sessionId, () => patch as Partial<S>)
    }
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

// ---------------------------------------------------------------------------
// Inventory list-replacement cases (#5618 Batch 2)
//
// slash_commands / agent_list / provider_list each replace a single flat
// connection-state list. They share the base flat-state write across both
// clients; the only divergences are platform-specific side-effects handled by
// the OPTIONAL adapter hooks above (the app mirrors slash/agent lists into its
// secondary `useConversationStore`, and tightens provider elements via
// `mapProviderList`). With both hooks omitted, the dashboard's prior verbatim
// behaviour is preserved exactly.
// ---------------------------------------------------------------------------

/** `slash_commands` — replace the flat slash-command list (broadcast-guarded). */
function dispatchSlashCommands<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['slash_commands'],
  adapter: ClientStoreAdapter<S>,
): void {
  const result = handleSlashCommands(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (!result) return
  adapter.setState({ slashCommands: result.commands } as Record<string, unknown[]>)
  adapter.syncSecondaryInventory?.('slashCommands', result.commands)
}

/** `agent_list` — replace the flat custom-agent list (broadcast-guarded). */
function dispatchAgentList<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['agent_list'],
  adapter: ClientStoreAdapter<S>,
): void {
  const result = handleAgentList(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (!result) return
  adapter.setState({ customAgents: result.agents } as Record<string, unknown[]>)
  adapter.syncSecondaryInventory?.('customAgents', result.agents)
}

/** `provider_list` — replace the flat provider list (server-wide; app tightens). */
function dispatchProviderList<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['provider_list'],
  adapter: ClientStoreAdapter<S>,
): void {
  const result = handleProviderList(msg as Record<string, unknown>)
  if (!result) return
  const providers = adapter.mapProviderList
    ? adapter.mapProviderList(result.providers)
    : result.providers
  adapter.setState({ availableProviders: providers } as Record<string, unknown[]>)
}

// ---------------------------------------------------------------------------
// Error-sink / session-status cases (#5618 Batch 3)
//
// session_restore_failed / session_persist_failed surface a recoverable error
// via the `addServerError` hook (their ONLY effect — no shared store mutation),
// so they DECLINE when the adapter has no `addServerError` (matching the
// file-ops / git `getCallback` pattern). session_stopped performs a shared
// session patch (`stoppedAt`/`stoppedCode`) and ALSO fires the dashboard's
// optional info toast, so it always OWNS the message.
// ---------------------------------------------------------------------------

/** `session_restore_failed` — surface the failure (app structured / dashboard banner). */
function dispatchSessionRestoreFailed<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['session_restore_failed'],
  adapter: ClientStoreAdapter<S>,
): void | false {
  if (!adapter.addServerError) return false
  const r = handleSessionRestoreFailed(msg as Record<string, unknown>)
  adapter.addServerError(r.systemMessage.content, {
    category: 'session',
    recoverable: true,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
  })
  // eslint-disable-next-line no-console
  console.warn('[session_restore_failed]', {
    sessionId: r.sessionId,
    name: r.name,
    provider: r.provider,
    cwd: r.cwd,
    model: r.model,
    permissionMode: r.permissionMode,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    historyLength: r.historyLength,
  })
}

/** `session_persist_failed` — surface the "change not saved" error (#5714/#5701). */
function dispatchSessionPersistFailed<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['session_persist_failed'],
  adapter: ClientStoreAdapter<S>,
): void | false {
  if (!adapter.addServerError) return false
  const r = handleSessionPersistFailed(msg as Record<string, unknown>)
  adapter.addServerError(r.message, {
    category: 'session',
    recoverable: true,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
  })
  // eslint-disable-next-line no-console
  console.warn('[session_persist_failed]', { sessionId: r.sessionId, name: r.name })
}

/** `session_stopped` — set stoppedAt/stoppedCode + optional dashboard info toast. */
function dispatchSessionStopped<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['session_stopped'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { sessionId, patch } = handleSessionStopped(
    msg as Record<string, unknown>,
    adapter.getActiveSessionId(),
  )
  if (sessionId && adapter.hasSession(sessionId)) {
    adapter.updateSession(sessionId, () => patch as Partial<S>)
  }
  // Dashboard-only info toast (#4878). The app omits the hook (#4879 — the
  // inline session banner already carries the signal). Computed identically to
  // the dashboard's prior inline message; fires regardless of session existence,
  // matching the dashboard's prior unconditional `addInfoNotification`.
  const code = (patch as { stoppedCode?: number | null }).stoppedCode
  const message = code != null && code !== 0 ? `Session stopped. (exit ${code})` : 'Session stopped.'
  adapter.addInfoNotification?.(message)
}

// ---------------------------------------------------------------------------
// Multi-client cases (#5618 Batch 4)
//
// primary_changed / session_role / client_focus_changed differed between the
// clients ONLY in where the multi-client state lives (the app's dedicated
// `useMultiClientStore` vs the dashboard's flat store) — the mutations were
// identical. The `getMyClientId` / `getFollowMode` / `switchSession` accessors
// hide that, so all three are now fully shared. primary_changed additionally
// mirrors into the app's secondary store via the optional `setPrimaryClientId`
// hook (out-of-contract). session_role / client_focus_changed DECLINE when the
// multi-client accessors are absent (a client that hasn't opted in keeps its
// local switch).
// ---------------------------------------------------------------------------

/** `primary_changed` — update the per-session / flat primary pointer (+ app mirror). */
function dispatchPrimaryChanged<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['primary_changed'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { sessionId, primaryClientId } = handlePrimaryChanged(msg as Record<string, unknown>)
  // App mirrors the raw pointer into its multi-client presence store first
  // (matches the prior inline order); the dashboard omits this hook.
  adapter.setPrimaryClientId?.(primaryClientId)
  if (sessionId && adapter.hasSession(sessionId)) {
    adapter.updateSession(sessionId, () => ({ primaryClientId } as Partial<S>))
  } else if (!sessionId || sessionId === 'default') {
    adapter.setState({ primaryClientId } as Record<string, unknown>)
  }
}

/** `session_role` — store this client's derived role + primary on the session. */
function dispatchSessionRole<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['session_role'],
  adapter: ClientStoreAdapter<S>,
): void | false {
  if (!adapter.getMyClientId) return false
  const role = handleSessionRole(msg as Record<string, unknown>, adapter.getMyClientId())
  if (role.sessionId && adapter.hasSession(role.sessionId)) {
    adapter.updateSession(
      role.sessionId,
      () => ({ sessionRole: role.role, primaryClientId: role.primaryClientId } as Partial<S>),
    )
  }
}

/** `client_focus_changed` — follow-mode auto-switch to another client's session. */
function dispatchClientFocusChanged<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['client_focus_changed'],
  adapter: ClientStoreAdapter<S>,
): void | false {
  if (!adapter.getFollowMode || !adapter.getMyClientId || !adapter.switchSession) return false
  const focus = handleClientFocusChanged(msg as Record<string, unknown>)
  if (!focus) return
  if (
    adapter.getFollowMode() &&
    focus.clientId !== adapter.getMyClientId() &&
    focus.sessionId !== adapter.getActiveSessionId() &&
    adapter.hasSession(focus.sessionId)
  ) {
    adapter.switchSession(focus.sessionId)
  }
}

// ---------------------------------------------------------------------------
// Models / cost cases (#5618 Batch 5a)
//
// available_models replaces the flat model list (+ the dashboard's extra
// `availableModelsProvider` via `extendModelsPatch`). cost_update applies the
// shared per-session `sessionCost` patch (+ the app's flat/cost-store mirror via
// `setCostUpdate`). Both ALWAYS own the message — the optional hooks only carry
// the platform-specific extra, never gate ownership.
// ---------------------------------------------------------------------------

/** `available_models` — replace the flat model list (skip entirely if not an array). */
function dispatchAvailableModels<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['available_models'],
  adapter: ClientStoreAdapter<S>,
): void {
  // Both clients guard on Array.isArray BEFORE writing — a non-array payload is a
  // no-op that PRESERVES the existing list (NOT a clobber to []).
  if (!Array.isArray(msg.models)) return
  const { models, defaultModelId } = handleAvailableModels(msg as Record<string, unknown>)
  const extra = adapter.extendModelsPatch ? adapter.extendModelsPatch(msg as Record<string, unknown>) : {}
  // Spread `extra` FIRST so the shared fields always win — the hook is for EXTRA
  // flat fields only and must never override availableModels/defaultModelId.
  adapter.setState({ ...extra, availableModels: models, defaultModelId } as Record<string, unknown>)
}

/** `cost_update` — per-session sessionCost patch (+ app flat/cost-store mirror). */
function dispatchCostUpdate<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['cost_update'],
  adapter: ClientStoreAdapter<S>,
): void {
  const result = handleCostUpdate(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (result.sessionId && adapter.hasSession(result.sessionId)) {
    adapter.updateSession(result.sessionId, () => result.patch as Partial<S>)
  }
  // App-only: flat totalCost/costBudget + the useCostStore dual-write.
  const totalCost = typeof msg.totalCost === 'number' ? msg.totalCost : null
  const budget = typeof msg.budget === 'number' ? msg.budget : null
  adapter.setCostUpdate?.(totalCost, budget)
}

// ---------------------------------------------------------------------------
// Connect-time burst / tunnel cases (#5618 Batch 5b)
//
// tunnel_url_changed's ONLY effect is repointing the persisted tunnel endpoint
// (platform-local storage) — so it DECLINES without `applyRotatedTunnelUrl`.
// auth_bootstrap folds the connect-time provider/slash/agent lists into one
// frame; it reuses the Batch 2 `mapProviderList` / `syncSecondaryInventory` hooks
// and applies the tunnel URL best-effort, so it always OWNS the message via its
// shared flat writes.
// ---------------------------------------------------------------------------

/** `tunnel_url_changed` — repoint the persisted tunnel endpoint (platform-local apply). */
function dispatchTunnelUrlChanged<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['tunnel_url_changed'],
  adapter: ClientStoreAdapter<S>,
): void | false {
  if (!adapter.applyRotatedTunnelUrl) return false
  const rotated = handleTunnelUrlChanged(msg as Record<string, unknown>)
  if (rotated) adapter.applyRotatedTunnelUrl(rotated.url, rotated.previousUrl)
}

/** `auth_bootstrap` — connect-time burst: tunnel URL + provider/slash/agent lists. */
function dispatchAuthBootstrap<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['auth_bootstrap'],
  adapter: ClientStoreAdapter<S>,
): void {
  const boot = handleAuthBootstrap(msg as Record<string, unknown>)
  // Re-learn a tunnel URL that may have rotated while offline. Applied BEFORE the
  // session-scope guard so a stale-session burst still refreshes the URL.
  if (boot.tunnelUrl) adapter.applyRotatedTunnelUrl?.(boot.tunnelUrl, null)
  // Providers — server-wide, no session guard. The app tightens elements via
  // mapProviderList; the dashboard writes verbatim (the Batch 2 divergence).
  const providers = adapter.mapProviderList ? adapter.mapProviderList(boot.providers) : boot.providers
  adapter.setState({ availableProviders: providers } as Record<string, unknown>)
  // Slash commands + agents are scoped to the connect-time active session: skip
  // them (but keep providers) when a session switch already moved off the burst's
  // sessionId — the post-switch flow re-requests them.
  const activeId = adapter.getActiveSessionId()
  if (boot.sessionId && activeId && boot.sessionId !== activeId) return
  adapter.setState({ slashCommands: boot.slashCommands } as Record<string, unknown>)
  adapter.syncSecondaryInventory?.('slashCommands', boot.slashCommands)
  adapter.setState({ customAgents: boot.agents } as Record<string, unknown>)
  adapter.syncSecondaryInventory?.('customAgents', boot.agents)
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
// Slice 3 — file-ops / git wrapper cases (epic #5556, #5653)
//
// Each was the SAME `getCallback(name) → shared*(msg) → cb(payload)` shape in
// the app switch: parse the wire message with an existing store-core handler,
// then invoke a one-shot imperative callback the UI registered out-of-band.
// There is NO store mutation — the only effect is the callback invocation — so
// these route through `adapter.getCallback` instead of the session/flat-state
// methods the other cases use.
//
// Each handler DECLINES (returns `false`) when the adapter has no
// `getCallback`, so a client that has not opted its imperative-callback
// registry into the table (the dashboard) falls through to its own switch
// unchanged. A client that DID opt in (the app) always OWNS the message: it
// invokes the callback when one is registered and no-ops otherwise — exactly
// the prior inline `if (cb) cb(...)` behaviour.
// ---------------------------------------------------------------------------

/**
 * Resolve the imperative callback for `name` through the adapter. Returns the
 * special `DECLINE` sentinel when the adapter does not implement `getCallback`
 * at all (client not opted in), or the (possibly null) callback otherwise.
 */
const DECLINE = Symbol('dispatch-decline')

function resolveCallback<S extends DispatchSessionBase>(
  adapter: ClientStoreAdapter<S>,
  name: DispatchCallbackName,
): ((payload: DispatchCallbackPayload) => void) | null | undefined | typeof DECLINE {
  if (typeof adapter.getCallback !== 'function') return DECLINE
  return adapter.getCallback(name)
}

/**
 * Factory (audit P2-10) for the file-ops / git DECLINE handlers, which were an
 * identical `resolveCallback(name) → cb === DECLINE ? false : cb(transform(msg))`
 * template (six bare + three payload-reshaping variants). The `cb === DECLINE`
 * guard is the load-bearing part — a copy that forgot it would silently take
 * ownership of a message on a client (e.g. the dashboard) that never registered
 * the callback, so it lives here once. `transform` parses the wire message into
 * the callback payload (identity-ish for the bare cases, a reshape for diff /
 * git-status / git-branches).
 */
function callbackDispatcher<S extends DispatchSessionBase>(
  name: DispatchCallbackName,
  transform: (msg: Record<string, unknown>) => DispatchCallbackPayload,
): (msg: Record<string, unknown>, adapter: ClientStoreAdapter<S>) => void | false {
  return (msg, adapter) => {
    const cb = resolveCallback(adapter, name)
    if (cb === DECLINE) return false
    if (cb) cb(transform(msg))
  }
}

// ---------------------------------------------------------------------------
// Slice 4 — web-task upsert (epic #5556)
//
// `web_task_created` and `web_task_updated` were BYTE-IDENTICAL in both the app
// and dashboard switches: validate the `task` payload via `handleWebTaskUpsert`,
// then filter the flat `webTasks` list by `taskId` and append the new task. The
// only reason they were not in slices 1-3 is the read-modify-write upsert needs
// to read the prior `webTasks` list — hence the new `adapter.updateState`
// functional-flat-update primitive (both clients back it with their Zustand
// `set((state) => …)`, which is exactly what the inline cases used). A malformed
// payload (`task: null`) is a no-op on both clients — same guard as before.
// ---------------------------------------------------------------------------

/** `web_task_created` / `web_task_updated` — upsert the task into the flat list. */
function dispatchWebTaskUpsert<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['web_task_created'] | DispatchMessageMap['web_task_updated'],
  adapter: ClientStoreAdapter<S>,
): void {
  const { task } = handleWebTaskUpsert(msg as Record<string, unknown>)
  if (!task) return
  adapter.updateState((flat) => {
    const existing = (flat as { webTasks?: WebTask[] }).webTasks ?? []
    return { webTasks: applyWebTaskUpsert(existing, task) } as unknown as typeof flat
  })
}

/**
 * `checkpoint_created` (#5618 Batch 6) — append the new checkpoint to the
 * active-session list. Byte-identical between the clients' switches modulo the
 * app's extra mirror into its `useConversationStore` (abstracted behind
 * `syncSecondaryCheckpoints`, which the dashboard omits). Reads the prior list
 * via `getCheckpoints()` and only writes on a non-null handler result — matching
 * each client's prior `if (next) { set(...) }` guard (no no-op state churn).
 */
function dispatchCheckpointCreated<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['checkpoint_created'],
  adapter: ClientStoreAdapter<S>,
): void {
  const next = handleCheckpointCreated(
    msg as Record<string, unknown>,
    adapter.getCheckpoints(),
    adapter.getActiveSessionId(),
  )
  if (!next) return
  adapter.setState({ checkpoints: next } as Record<string, Checkpoint[]>)
  adapter.syncSecondaryCheckpoints?.({ kind: 'append', checkpoint: msg.checkpoint as Checkpoint })
}

/**
 * `checkpoint_list` (#5618 Batch 6) — replace the active-session checkpoint list
 * with the server array. Pure flat write (no prior state needed); the app also
 * mirrors the replacement into its secondary store via `syncSecondaryCheckpoints`.
 */
function dispatchCheckpointList<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['checkpoint_list'],
  adapter: ClientStoreAdapter<S>,
): void {
  const next = handleCheckpointList(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (!next) return
  adapter.setState({ checkpoints: next } as Record<string, Checkpoint[]>)
  adapter.syncSecondaryCheckpoints?.({ kind: 'replace', checkpoints: next })
}

/**
 * `user_question` (#5618) — append the question prompt to its (resolved)
 * session, falling back to the global log, then raise a background-session
 * notification. Byte-identical between the two clients' switches: both parsed
 * via the shared `handleUserQuestion`, appended the prompt, and called
 * `pushSessionNotification(sessionId, 'question', questionText)`. The only
 * divergence was inside each client's own `pushSessionNotification` (the app
 * also hits its mobile push-notification store) — abstracted behind the
 * adapter method, so this handler stays platform-agnostic.
 */
function dispatchUserQuestion<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['user_question'],
  adapter: ClientStoreAdapter<S>,
): void {
  const parsed = handleUserQuestion(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (!parsed) return
  const { sessionId, chatMessage, questionText } = parsed
  if (sessionId && adapter.hasSession(sessionId)) {
    adapter.updateSession(
      sessionId,
      (ss) =>
        ({
          messages: [...ss.messages, chatMessage],
        } as Partial<S>),
    )
  } else {
    adapter.addMessage(chatMessage)
  }
  if (sessionId) adapter.pushSessionNotification(sessionId, 'question', questionText)
}

/**
 * `multi_question_intervention` (#5618/#4653) — chroxy's permission-hook denied a
 * multi-question AskUserQuestion; append a {@link SessionIntervention} so the
 * session-header/footer counter ticks, and on the FIRST intervention per session
 * push a one-time system ChatMessage explaining the interception. Byte-identical
 * between the two clients' switches (only a local var name + comment wording
 * differed): both built the dedup-by-toolUseId, ring-capped builder via the
 * shared `handleMultiQuestionIntervention`, ran `applyInterventionBuilder`, and
 * skipped the write on a reference-equal (dedup'd repeat) result. The
 * reference-equality skip is expressed as a `{}` no-op patch inside the updater
 * (the same idiom the agent_* handlers use) so a stuck-model re-emit doesn't
 * re-render the counter.
 */
function dispatchMultiQuestionIntervention<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['multi_question_intervention'],
  adapter: ClientStoreAdapter<S>,
): void {
  const builder = handleMultiQuestionIntervention(msg as Record<string, unknown>, adapter.getActiveSessionId())
  if (!builder) return
  const targetId = builder.sessionId
  if (!targetId || !adapter.hasSession(targetId)) return
  adapter.updateSession(targetId, (ss) => {
    const current = ss.interventions ?? []
    const { interventions: nextInterventions, isFirst } = applyInterventionBuilder(builder, current)
    // Dedup'd repeat — nothing changed; return a no-op patch so React doesn't
    // re-render the intervention counter on every stuck-model re-emit.
    if (nextInterventions === current) return {} as Partial<S>
    if (isFirst) {
      return {
        interventions: nextInterventions,
        messages: [
          ...ss.messages,
          {
            id: nextMessageId('system'),
            type: 'system',
            content:
              'chroxy intercepted a multi-question form and asked the agent to break it into single questions.',
            timestamp: Date.now(),
          },
        ],
      } as Partial<S>
    }
    return { interventions: nextInterventions } as Partial<S>
  })
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
// ---------------------------------------------------------------------------
// slice 1 (#6449) — terminal-mirror pass-through (raw / raw_background /
// terminal_output). All three are verbatim writes to the client's terminal view
// via the single `appendTerminalData` adapter primitive; their both-clients
// equivalence is gated by the #6345 SWITCH_FIXTURES the contract harness drives.
// ---------------------------------------------------------------------------

/** `raw` — claude-tui headless output → terminal view (verbatim pass-through). */
function dispatchRaw<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['raw'],
  adapter: ClientStoreAdapter<S>,
): void {
  adapter.appendTerminalData(handleRawOutput(msg as Record<string, unknown>).data)
}

/** `raw_background` — background-agent output → terminal view (verbatim pass-through). */
function dispatchRawBackground<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['raw_background'],
  adapter: ClientStoreAdapter<S>,
): void {
  adapter.appendTerminalData(handleRawOutput(msg as Record<string, unknown>).data)
}

/**
 * `terminal_output` — live PTY mirror for the ACTIVE session. Replicates both
 * clients' guard exactly: drop a frame whose `data` isn't a string, or whose
 * `sessionId` is missing / not the active session (a stale frame arriving across
 * a session switch must not bleed into the new session's terminal). OWNS the
 * message either way — the prior switch `break`/`return`ed without falling through.
 */
function dispatchTerminalOutput<S extends DispatchSessionBase>(
  msg: DispatchMessageMap['terminal_output'],
  adapter: ClientStoreAdapter<S>,
): void {
  const m = msg as Record<string, unknown>
  if (typeof m.data !== 'string') return
  if (typeof m.sessionId !== 'string' || m.sessionId !== adapter.getActiveSessionId()) return
  adapter.appendTerminalData(m.data)
}

export function createDispatchTable<S extends DispatchSessionBase>(): DispatchTable<S> {
  return {
    available_permission_modes: dispatchAvailablePermissionModes,
    session_updated: dispatchSessionUpdated,
    agent_busy: dispatchAgentBusy,
    agent_idle: dispatchAgentIdle,
    permission_mode_changed: dispatchPermissionModeChanged,
    budget_warning: dispatchBudgetWarning,
    plan_ready: dispatchPlanReady,
    rate_limited: dispatchRateLimited,
    server_shutdown: dispatchServerShutdown,
    conversations_list: dispatchConversationsList,
    checkpoint_restored: dispatchCheckpointRestored,
    search_results: dispatchSearchResults,
    budget_resumed: dispatchBudgetResumed,
    budget_resume_ack: dispatchBudgetResumeAck,
    conversation_id: dispatchConversationId,
    permission_rules_updated: dispatchPermissionRulesUpdated,
    confirm_permission_mode: dispatchConfirmPermissionMode,
    // --- slice 2 (epic #5556) ---
    agent_spawned: dispatchAgentSpawned,
    agent_completed: dispatchAgentCompleted,
    agent_event: dispatchAgentEvent,
    background_work_changed: dispatchBackgroundWorkChanged,
    plan_started: sessionPatchDispatcher<S>(handlePlanStarted),
    inactivity_warning: dispatchInactivityWarning,
    mcp_servers: sessionPatchDispatcher<S>(handleMcpServers),
    // --- inventory list-replacement cases (#5618 Batch 2) ---
    slash_commands: dispatchSlashCommands,
    agent_list: dispatchAgentList,
    provider_list: dispatchProviderList,
    // --- error-sink / session-status cases (#5618 Batch 3) ---
    session_stopped: dispatchSessionStopped,
    session_restore_failed: dispatchSessionRestoreFailed,
    session_persist_failed: dispatchSessionPersistFailed,
    // --- multi-client cases (#5618 Batch 4) ---
    primary_changed: dispatchPrimaryChanged,
    session_role: dispatchSessionRole,
    client_focus_changed: dispatchClientFocusChanged,
    // --- models / cost cases (#5618 Batch 5a) ---
    available_models: dispatchAvailableModels,
    cost_update: dispatchCostUpdate,
    // --- connect-time burst / tunnel cases (#5618 Batch 5b) ---
    tunnel_url_changed: dispatchTunnelUrlChanged,
    auth_bootstrap: dispatchAuthBootstrap,
    session_usage: sessionPatchDispatcher<S>(handleSessionUsage),
    session_context: sessionPatchDispatcher<S>(handleSessionContext),
    model_changed: sessionPatchDispatcher<S>(handleModelChangedPatch),
    session_cost_threshold_crossed: dispatchSessionCostThresholdCrossed,
    dev_preview: dispatchDevPreview,
    dev_preview_stopped: dispatchDevPreviewStopped,
    web_feature_status: dispatchWebFeatureStatus,
    web_task_list: dispatchWebTaskList,
    notification_prefs: dispatchNotificationPrefs,
    // --- slice 3 (epic #5556) — file-ops / git wrapper cases (#5653) ---
    directory_listing: callbackDispatcher<S>('directoryListing', (msg) => handleDirectoryListing(msg)),
    file_listing: callbackDispatcher<S>('fileBrowser', (msg) => handleFileListing(msg)),
    file_content: callbackDispatcher<S>('fileContent', (msg) => handleFileContent(msg)),
    write_file_result: callbackDispatcher<S>('fileWrite', (msg) => handleWriteFileResult(msg)),
    diff_result: callbackDispatcher<S>('diff', (msg) => {
      const payload = handleDiffResult(msg)
      return { files: payload.files, error: payload.error }
    }),
    git_status_result: callbackDispatcher<S>('gitStatus', (msg) => {
      const payload = handleGitStatusResult(msg)
      return {
        branch: payload.branch,
        staged: payload.staged,
        unstaged: payload.unstaged,
        untracked: payload.untracked,
        error: payload.error,
      }
    }),
    git_branches_result: callbackDispatcher<S>('gitBranches', (msg) => {
      const payload = handleGitBranchesResult(msg)
      return { branches: payload.branches, currentBranch: payload.currentBranch, error: payload.error }
    }),
    git_stage_result: callbackDispatcher<S>('gitStage', (msg) => handleGitStageResult(msg)),
    git_unstage_result: callbackDispatcher<S>('gitStage', (msg) => handleGitStageResult(msg)),
    git_commit_result: callbackDispatcher<S>('gitCommit', (msg) => handleGitCommitResult(msg)),
    // --- slice 4 (epic #5556) — web-task upsert ---
    web_task_created: dispatchWebTaskUpsert,
    web_task_updated: dispatchWebTaskUpsert,
    // --- outgoing-message queue mirror (#5937, epic #5935 part ②) ---
    message_queued: dispatchQueuedMessages<S>(handleMessageQueued),
    message_dequeued: dispatchQueuedMessages<S>(handleMessageDequeued),
    // --- user_question (#5618) — byte-identical append + notify ---
    user_question: dispatchUserQuestion,
    // --- multi_question_intervention (#5618) — byte-identical builder + append ---
    multi_question_intervention: dispatchMultiQuestionIntervention,
    // --- checkpoint cases (#5618 Batch 6) ---
    checkpoint_created: dispatchCheckpointCreated,
    checkpoint_list: dispatchCheckpointList,
    // --- slice 1 (#6449) — terminal-mirror pass-through ---
    raw: dispatchRaw,
    raw_background: dispatchRawBackground,
    terminal_output: dispatchTerminalOutput,
  }
}

/** The message types the shared table currently owns (for coverage tooling). */
export const DISPATCH_TABLE_TYPES: readonly DispatchMessageType[] = [
  'available_permission_modes',
  'session_updated',
  'agent_busy',
  'agent_idle',
  'permission_mode_changed',
  'budget_warning',
  'plan_ready',
  'rate_limited',
  'server_shutdown',
  'conversations_list',
  'checkpoint_restored',
  'search_results',
  'budget_resumed',
  'budget_resume_ack',
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
  // --- inventory list-replacement cases (#5618 Batch 2) ---
  'slash_commands',
  'agent_list',
  'provider_list',
  // --- error-sink / session-status cases (#5618 Batch 3) ---
  'session_stopped',
  'session_restore_failed',
  'session_persist_failed',
  // --- multi-client cases (#5618 Batch 4) ---
  'primary_changed',
  'session_role',
  'client_focus_changed',
  // --- models / cost cases (#5618 Batch 5a) ---
  'available_models',
  'cost_update',
  // --- connect-time burst / tunnel cases (#5618 Batch 5b) ---
  'tunnel_url_changed',
  'auth_bootstrap',
  'session_usage',
  'session_context',
  'session_cost_threshold_crossed',
  'dev_preview',
  'dev_preview_stopped',
  'web_feature_status',
  'web_task_list',
  'notification_prefs',
  // --- slice 3 (epic #5556) — file-ops / git wrapper cases (#5653) ---
  'directory_listing',
  'file_listing',
  'file_content',
  'write_file_result',
  'diff_result',
  'git_status_result',
  'git_branches_result',
  'git_stage_result',
  'git_unstage_result',
  'git_commit_result',
  // --- slice 4 (epic #5556) — web-task upsert ---
  'web_task_created',
  'web_task_updated',
  // --- outgoing-message queue mirror (#5937, epic #5935 part ②) ---
  'message_queued',
  'message_dequeued',
  // --- reconciled divergent case (#5618) ---
  'model_changed',
  // --- user_question (#5618) — byte-identical append + notify ---
  'user_question',
  // --- multi_question_intervention (#5618) — byte-identical builder + append ---
  'multi_question_intervention',
  // --- checkpoint cases (#5618 Batch 6) ---
  'checkpoint_created',
  'checkpoint_list',
  // --- slice 1 (#6449) — terminal-mirror pass-through ---
  'raw',
  'raw_background',
  'terminal_output',
]

/**
 * Run a message through the shared table.
 *
 * @returns `true` when the table owned (and handled) the message — the caller
 *   should stop. `false` on a table MISS, OR when the matched handler DECLINED
 *   (returned `false`, e.g. a file-ops / git case on a client whose adapter has
 *   no `getCallback`) — the caller falls through to its own switch, keeping
 *   incremental, per-client migration possible.
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
  // A handler returning `false` DECLINES — fall through to the caller's switch.
  return handler(msg as DispatchMessageMap[DispatchMessageType], adapter) !== false
}
