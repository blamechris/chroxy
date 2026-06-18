/**
 * WebSocket message handler — processes all incoming server messages.
 *
 * Extracted from connection.ts to reduce file size. This module contains:
 * - handleMessage() — the main message dispatch (~1100 lines)
 * - Module-level state (delta buffers, replay flags, heartbeat, message queue)
 * - Session update helpers (updateSession, updateActiveSession)
 *
 * Depends on the Zustand store via a late-bound reference (setStore) to
 * avoid circular imports.
 */
import { Alert, AppState, Platform } from 'react-native';
import {
  createKeyPair,
  deriveSharedKey,
  deriveConnectionKey,
  generateConnectionSalt,
  DIRECTION_CLIENT,
  DIRECTION_SERVER,
  type EncryptionState,
  type KeyPair,
  type EncryptedEnvelope,
} from '../utils/crypto';
import { registerForPushNotifications } from '../notifications';
import { stripAnsi, filterThinking, nextMessageId } from './utils';
import {
  resolveSessionId,
  handleUserInput as sharedUserInput,
  handleMessage as sharedMessageHandler,
  handleModelChanged as sharedModelChanged,
  handlePermissionModeChanged as sharedPermissionModeChanged,
  // available_permission_modes / session_updated / confirm_permission_mode /
  // agent_busy / budget_resumed migrated to the shared dispatch table (#5556)
  handleClaudeReady as sharedClaudeReady,
  handleAgentIdle as sharedAgentIdle,
  handleThinkingLevelChanged as sharedThinkingLevelChanged,
  handleBudgetWarning as sharedBudgetWarning,
  handleBudgetExceeded as sharedBudgetExceeded,
  // plan_started / inactivity_warning / dev_preview / dev_preview_stopped
  // migrated to the shared dispatch table (#5556 slice 2)
  handlePlanReady as sharedPlanReady,
  handleMultiQuestionIntervention as sharedMultiQuestionIntervention,
  applyInterventionBuilder,
  handleToolStart as sharedToolStart,
  handleToolResult as sharedToolResult,
  handleToolInputDelta as sharedToolInputDelta,
  handleStreamStart as sharedStreamStart,
  sharedStreamDelta,
  handleStreamEnd as sharedStreamEnd,
  handleAuthOk as sharedAuthOk,
  parseConnectedClients as sharedParseConnectedClients,
  handleAuthFail as sharedAuthFail,
  handleKeyExchangeOk as sharedKeyExchangeOk,
  handleServerMode as sharedServerMode,
  handleCheckpointCreated as sharedCheckpointCreated,
  handleCheckpointList as sharedCheckpointList,
  handleCheckpointRestored as sharedCheckpointRestored,
  handleError as sharedError,
  handleSessionError as sharedSessionError,
  // #4879: quiet user-initiated Stop confirmation handler
  handleSessionStopped as sharedSessionStopped,
  handleClientJoined as sharedClientJoined,
  handleClientLeft as sharedClientLeft,
  handlePrimaryChanged as sharedPrimaryChanged,
  handleSessionRole as sharedSessionRole,
  handleClientFocusChanged as sharedClientFocusChanged,
  // conversation_id migrated to the shared dispatch table (#5556)
  handleConversationsList as sharedConversationsList,
  handleHistoryReplayStart as sharedHistoryReplayStart,
  handleHistoryReplayEnd as sharedHistoryReplayEnd,
  // #5555.3 / #5555.4 — lastSeq cursor + no-blank-flash reconcile.
  recordHistorySeq,
  reconcileReplayStart,
  reconcileReplayEnd,
  replayDedupCache,
  resetReplayReconcile,
  handlePermissionRequest as sharedPermissionRequest,
  handlePermissionResolved as sharedPermissionResolved,
  handlePermissionExpired as sharedPermissionExpired,
  handlePermissionTimeout as sharedPermissionTimeout,
  // permission_rules_updated migrated to the shared dispatch table (#5556)
  // #5454 — remaining both-sides duplicates extracted into store-core
  handleRawOutput as sharedRawOutput,
  handleTokenRotated as sharedTokenRotated,
  handlePairFail as sharedPairFail,
  // session_cost_threshold_crossed + notification_prefs migrated to the shared
  // dispatch table (#5556 slice 2) — notification_prefs's previously-inline
  // Zod parse now routes through the shared handleNotificationPrefs.
  // #5454 — pure core of the #554 stream-split block (permission_request)
  resolvePermissionStreamSplit,
  // directory_listing / file_listing / file_content / write_file_result —
  // migrated to the shared dispatch table (#5556 slice 3 / #5653).
  buildSessionListPatches as sharedBuildSessionListPatches,
  cumulativeUsageEquals as sharedCumulativeUsageEquals,
  chunkSubscribeSessionIds as sharedChunkSubscribeSessionIds,
  SESSION_LIST_SUBSCRIBE_CHUNK_SIZE,
  handleSessionTimeout as sharedSessionTimeout,
  handleSessionRestoreFailed as sharedSessionRestoreFailed,
  handleSessionWarning as sharedSessionWarning,
  handleSessionSwitched as sharedSessionSwitched,
  handleSlashCommands as sharedSlashCommands,
  handleAgentList as sharedAgentList,
  handleProviderList as sharedProviderList,
  handleAuthBootstrap as sharedAuthBootstrap,
  handleTunnelUrlChanged as sharedTunnelUrlChanged,
  // diff_result / git_status_result / git_branches_result / git_stage_result /
  // git_unstage_result / git_commit_result — migrated to the shared dispatch
  // table (#5556 slice 3 / #5653).
  // agent_spawned / agent_completed / agent_event / background_work_changed /
  // mcp_servers / session_usage / web_task_list / web_feature_status migrated
  // to the shared dispatch table (#5556 slice 2)
  handleAvailableModels as sharedAvailableModels,
  handleCostUpdate as sharedCostUpdate,
  handleResultUsage as sharedResultUsage,
  handleServerError as sharedServerError,
  handleServerShutdown as sharedServerShutdown,
  handleServerStatusLegacy as sharedServerStatusLegacy,
  // web_task_created / web_task_updated — migrated to the shared dispatch table
  // (#5556 slice 4); the app no longer imports the upsert helper directly.
  handleWebTaskError as sharedWebTaskError,
  handleSearchResults as sharedSearchResults,
  handleUserQuestion as sharedUserQuestion,
  applyOrphanDeltas,
  isActivityEvent,
  // #5039: shared partial-cost line helper — the same one the dashboard
  // toast uses, so the mobile Alert and the dashboard sub-line can't
  // drift apart on copy/format.
  formatPartialCostLine,
  // #5515 (epic #5514): latency instrumentation primitives.
  RollingPercentiles,
  // #5556 (epic #5514): shared stateful EWMA RTT smoother.
  RttSmoother,
  // #5556 (epic #5514): shared delta-flusher wiring (accumulator + timer +
  // override) — the client supplies only its `applyDeltas` store mutation.
  createDeltaFlusher,
  // #6035: shared connection runtime — the heartbeat ping loop, pong-timeout
  // reaper, handshake-window timer, and pong RTT measurement (formerly the
  // byte-identical copy shared with the dashboard). The app injects its wsSend /
  // quality-write sink / owned RttSmoother / latency-log hook. Constants aliased
  // so the local `HEARTBEAT_INTERVAL_MS` / `HANDSHAKE_TIMEOUT_MS` exports
  // re-source them.
  createHeartbeatController,
  HEARTBEAT_INTERVAL_MS as SC_HEARTBEAT_INTERVAL_MS,
  HANDSHAKE_TIMEOUT_MS as SC_HANDSHAKE_TIMEOUT_MS,
  LATENCY_LOG_INTERVAL_MS as SC_LATENCY_LOG_INTERVAL_MS,
  // epic #5556, sub-item 3: shared client message dispatch table.
  // Pure-delegation cases that were byte-identical with the dashboard route
  // through this table; a miss falls through to the switch below unchanged.
  createDispatchTable,
  runDispatch,
} from '@chroxy/store-core';
import type {
  DeltaFlusher,
  HeartbeatController,
  ClientStoreAdapter,
  DispatchCallbackName,
  DispatchCallbackPayload,
} from '@chroxy/store-core';
import { PROTOCOL_VERSION } from '@chroxy/protocol';
import { hapticSuccess } from '../utils/haptics';
import type {
  ChatMessage,
  Checkpoint,
  ConnectionContext,
  ConnectionState,
  CustomAgent,
  QueuedMessage,
  ServerError,
  SessionInfo,
  SessionNotification,
  SessionState,
  SlashCommand,
  ProviderInfo,
  ConversationSummary,
  PermissionRule,
} from './types';
import { createEmptySessionState } from './utils';
import { deriveActivityState } from './session-activity';
import { clearPersistedSession, persistLastConversationId, loadLastConversationId } from './persistence';
import { getCallback } from './imperative-callbacks';
import type { CallbackName } from './imperative-callbacks';
import { useMultiClientStore } from './multi-client';
import { useWebStore } from './web';
import { useCostStore } from './cost';
import { useTerminalStore } from './terminal';
import { useNotificationStore } from './notifications';
import { useConversationStore } from './conversations';
import { useConnectionLifecycleStore } from './connection-lifecycle';
import { recordVerifiedLanCandidate } from '../utils/endpoint-selector';

// ---------------------------------------------------------------------------
// Protocol version — bumped when the WS message set changes
// ---------------------------------------------------------------------------
export const CLIENT_PROTOCOL_VERSION = PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Late-bound store reference — set once by connection.ts after store creation
// ---------------------------------------------------------------------------
type StoreApi = {
  getState: () => ConnectionState;
  setState: (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void;
};
let _store: StoreApi | null = null;

export function setStore(store: StoreApi): void {
  _store = store;
}

/** @internal Exposed for testing only — resets the store reference to null. */
export function _testResetStore(): void {
  _store = null;
}

function getStore(): StoreApi {
  if (!_store) throw new Error('Store not initialized — call setStore() first');
  return _store;
}

// Re-export encrypt for wsSend (import is used inside the function)
import { encrypt, decrypt } from '../utils/crypto';

// ---------------------------------------------------------------------------
// EncryptionContext — E2E encryption state grouped into a sub-interface so
// it's reusable, discoverable, and resettable as a unit (#3049, phase 2 of
// #2662). Combines the post-handshake `EncryptionState` (sharedKey + nonces,
// imported via `../utils/crypto`, which re-exports the type from
// `@chroxy/store-core`) with the in-flight key-exchange fields
// (`pendingKeyPair`, `pendingSalt`) that the handshake produces and then
// drops once a shared key is derived.
// ---------------------------------------------------------------------------

export interface EncryptionContext {
  /** Post-handshake state: shared key + send/recv nonce counters. Null until handshake completes. */
  encryptionState: EncryptionState | null;
  /** Ephemeral X25519 keypair for the in-flight handshake. Cleared once the shared key is derived. */
  pendingKeyPair: KeyPair | null;
  /** Connection salt sent with the public key during the handshake. Cleared once the shared key is derived. */
  pendingSalt: string | null;
}

const INITIAL_ENCRYPTION_CONTEXT: EncryptionContext = {
  encryptionState: null,
  pendingKeyPair: null,
  pendingSalt: null,
};

// ---------------------------------------------------------------------------
// MessageHandlerContext — all resettable per-connection mutable state
//
// Grouping these here makes it possible to reset the entire handler state
// in one call (resetAllHandlerState) and paves the way for per-handler
// extraction in future refactoring steps.
// ---------------------------------------------------------------------------

interface MessageHandlerContext extends EncryptionContext {
  // History replay
  //
  // #4512 — per-session replay tracking (mirror of dashboard #4493). The
  // server's `replayHistory()` chunks over `setImmediate` (ws-history.js),
  // which yields the event loop between chunks, so live broadcasts from
  // OTHER sessions can interleave with session A's replay. A per-connection
  // boolean would gate all sessions on A's replay state and drop legitimate
  // live activity for sessions B/C/etc. Scope the flag per-session id and
  // gate per-target.
  replayingSessions: Set<string>;
  isSessionSwitchReplay: boolean;
  pendingSwitchSessionId: string | null;

  // Permission boundary message splitting (#554)
  postPermissionSplits: Set<string>;
  deltaIdRemaps: Map<string, string>;

  // Terminal write batching
  pendingTerminalWrites: string;
  terminalWriteTimer: ReturnType<typeof setTimeout> | null;

  // Client-side heartbeat + handshake timeout (#6035): the ping loop, the
  // pong-timeout reaper, the handshake-window timer, and the pong RTT
  // measurement now live in the shared `createHeartbeatController`
  // (store-core/connection-runtime), lifted from the byte-identical copy this
  // file shared with the dashboard. Lives on the context (one per connection)
  // so `resetAllHandlerState` tears it down by replacing the context, exactly
  // like the heartbeat fields it replaces.
  heartbeat: HeartbeatController<WebSocket>;
  // #5556: EWMA-smoothed RTT (replaces the inlined `ewmaRtt` accumulator).
  // Declared here (not inside the controller) because the delta-flusher also
  // reads `rttSmoother.value` for its adaptive interval.
  rttSmoother: RttSmoother;

  // Delta batching (#5556): the accumulator map + coalescing timer + adaptive
  // window now live inside the shared `createDeltaFlusher`. The hot path writes
  // into `deltaFlusher.pendingDeltas`; `applyDeltas` (the store mutation) is
  // the only platform-specific piece — see `createDefaultContext`.
  deltaFlusher: DeltaFlusher;

  // #5515 (epic #5514): latency instrumentation. `deltaServerTs` records the
  // server-stamped serverTs (and local recv time) of the OLDEST un-rendered
  // delta per messageId; on flush we measure serverTs→render (token-to-render)
  // and recv→render (client-side render cost) into the rolling buffers. See
  // store-core/latency-stats for the clock discipline.
  deltaServerTs: Map<string, { serverTs: number; recvAt: number }>;
  tokenToRender: RollingPercentiles;
  clientRender: RollingPercentiles;
  lastLatencyLogAt: number;

  // Message queue
  messageQueue: QueuedMessage[];

  // #5555 (auth_bootstrap) — set from auth_ok's `capabilities.authBootstrap`.
  // When true, the server pushes an `auth_bootstrap` burst frame carrying the
  // provider / slash-command / agent lists, so the connect-time list_* request
  // round trip is skipped (in BOTH the eager and discrete key-exchange paths).
  serverWillBootstrap: boolean;
}

function createDefaultContext(): MessageHandlerContext {
  const rttSmoother = new RttSmoother();
  const ctx: MessageHandlerContext = {
    ...INITIAL_ENCRYPTION_CONTEXT,
    replayingSessions: new Set<string>(),
    isSessionSwitchReplay: false,
    pendingSwitchSessionId: null,
    postPermissionSplits: new Set<string>(),
    deltaIdRemaps: new Map<string, string>(),
    pendingTerminalWrites: '',
    terminalWriteTimer: null,
    // #6035: the shared heartbeat + handshake controller, injected with the
    // app's platform-specific effects. Built below (after `ctx` exists) so its
    // `onLatencyLog` can gate on THIS context's shared `lastLatencyLogAt`
    // throttle cursor (the same cursor the delta-flush latency path uses).
    heartbeat: null as unknown as HeartbeatController<WebSocket>,
    rttSmoother,
    // #5556: the flusher owns the accumulator + coalescing timer + adaptive
    // window, sizing it off this context's own RttSmoother. `applyDeltas` is
    // the app's session-only store mutation (no flat-`messages` fallback).
    deltaFlusher: createDeltaFlusher({
      getEwmaRtt: () => rttSmoother.value,
      applyDeltas: applyDeltaBatch,
    }),
    deltaServerTs: new Map<string, { serverTs: number; recvAt: number }>(),
    tokenToRender: new RollingPercentiles(200),
    clientRender: new RollingPercentiles(200),
    lastLatencyLogAt: 0,
    messageQueue: [],
    serverWillBootstrap: false,
  };
  ctx.heartbeat = createHeartbeatController({
    wsSend,
    rttSmoother,
    onPongQuality: (latencyMs, quality) => {
      useConnectionLifecycleStore.getState().setConnectionQuality(latencyMs, quality);
    },
    onLatencyLog: (line, pongRecvAt) => {
      // #5515: throttle the dev split log on the shared cursor (also used by
      // recordLatencySamples), so a streaming turn can't spam the console.
      if (pongRecvAt - ctx.lastLatencyLogAt >= LATENCY_LOG_INTERVAL_MS) {
        ctx.lastLatencyLogAt = pongRecvAt;
        console.log(line);
      }
    },
  });
  return ctx;
}

let _ctx: MessageHandlerContext = createDefaultContext();

/**
 * Reset all resettable handler state to defaults.
 * Clears timers, drains buffers, and resets all per-connection flags.
 * Also resets the connection attempt tracking variables.
 */
export function resetAllHandlerState(): void {
  // Clear pending timers before overwriting
  if (_ctx.terminalWriteTimer) clearTimeout(_ctx.terminalWriteTimer);
  // #6035: the controller owns the heartbeat/pong/handshake timers — tear them
  // down through it (stopHeartbeat clears the interval + pong timeout; the
  // handshake clear cancels the handshake-window timer) before replacing ctx.
  _ctx.heartbeat.stopHeartbeat();
  _ctx.heartbeat.clearHandshakeTimer();
  _ctx.deltaFlusher.dispose();
  _ctx = createDefaultContext();
  _pendingPermissionModeRequests.clear();
  // Reset connection-attempt tracking (kept as export let for live-binding semantics)
  connectionAttemptId = 0;
  disconnectedAttemptId = -1;
  lastConnectedUrl = null;
  pendingPairingId = null;
}

/**
 * #5555 — normalize a raw provider list (from either the `provider_list`
 * response or the `auth_bootstrap` burst) into validated `ProviderInfo[]`.
 * Guards against misbehaving servers / malicious endpoints that might send
 * non-objects or objects without a string `name`, and preserves the
 * capabilities + auth/billing summary (#3404). Shared so the discrete and
 * bootstrap paths apply identical element validation.
 */
function mapProviderList(rawProviders: unknown[]): ProviderInfo[] {
  return rawProviders
    .filter(
      (p): p is { name: string; capabilities?: unknown; auth?: unknown } =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as { name?: unknown }).name === 'string',
    )
    .map((p) => {
      const entry: ProviderInfo = { name: p.name };
      if (p.capabilities && typeof p.capabilities === 'object' && !Array.isArray(p.capabilities)) {
        entry.capabilities = p.capabilities as ProviderInfo['capabilities'];
      }
      if (p.auth && typeof p.auth === 'object' && !Array.isArray(p.auth)) {
        entry.auth = p.auth as ProviderInfo['auth'];
      }
      return entry;
    });
}

// ---------------------------------------------------------------------------
// E2E encryption state — reset on every new connection
// ---------------------------------------------------------------------------

/**
 * Send a JSON message over WebSocket, encrypting if E2E encryption is active.
 * Use this instead of raw `socket.send(JSON.stringify(...))`.
 */
export function wsSend(socket: WebSocket, payload: Record<string, unknown>): void {
  if (_ctx.encryptionState) {
    const envelope = encrypt(JSON.stringify(payload), _ctx.encryptionState.sharedKey, _ctx.encryptionState.sendNonce, DIRECTION_CLIENT);
    _ctx.encryptionState.sendNonce++;
    socket.send(JSON.stringify(envelope));
  } else {
    socket.send(JSON.stringify(payload));
  }
}

/**
 * Canonical "send a WS frame iff the socket is open" helper.
 *
 * Collapses the `const { socket } = get(); if (socket && socket.readyState ===
 * WebSocket.OPEN) { wsSend(socket, payload) }` boilerplate repeated across the
 * connection store and file-operations store into one place (#5652). Reads the
 * live socket from the connection store (set via setStore), so callers never
 * have to thread it through.
 *
 * Returns `true` when the frame was sent (socket open), `false` when it was a
 * no-op (no socket / not OPEN). Most callers ignore the result (a silent no-op
 * on a closed socket is the existing behavior); the few that surface an error or
 * return a status on the closed path read the boolean.
 */
export function sendIfOpen(payload: Record<string, unknown>): boolean {
  // Treat an uninitialized store the same as "socket not open": the store
  // hasn't been wired yet (file-operations.ts imports this directly, so it
  // can be called before setStore() runs).  Return false — no send, no throw.
  if (!_store) return false;
  const socket = getStore().getState().socket;
  if (socket && socket.readyState === WebSocket.OPEN) {
    wsSend(socket, payload);
    return true;
  }
  return false;
}

// #3672: treat iOS `inactive` as visible. `inactive` is a transient state for
// app-switcher gesture, control-center pulldown, biometric prompt, incoming
// call, and the brief moment between unlock and foreground promotion — the
// user is still right there with the phone. Treating it as not-visible flips
// the server to visible=false and arms a completion push notification, so
// the user gets a phantom buzz for a session they were just watching.
// Android never emits `inactive` (only `active` / `background`), so the
// platform check is belt-and-braces rather than load-bearing.
export function isVisibleAppState(state: string): boolean {
  if (state === 'active') return true;
  if (state === 'inactive' && Platform.OS === 'ios') return true;
  return false;
}

// #3404: edge-trigger memoisation for client_visible. Initialised to true to
// match the server's per-connection default — a freshly authenticated socket
// sees visible=true server-side until the app says otherwise, so the memo
// starts there and we only emit when the local state diverges. Reset by
// resetClientVisibleMemo() on every fresh connect.
let _lastSentVisible: boolean = true;

export function resetClientVisibleMemo(): void {
  _lastSentVisible = true;
}

/**
 * Send the current app foreground/background state to the server. The server
 * uses this to gate completion push notifications: a backgrounded client whose
 * WS socket is still alive must not be treated as an active viewer
 * (otherwise the OS keepalive grace period suppresses the push).
 *
 * Skipped when:
 *   - socket isn't open
 *   - desired state matches the last value we sent (idempotent)
 *   - E2E key exchange is mid-handshake (pendingKeyPair set, encryptionState
 *     not yet established) — sending plaintext during that window would be
 *     rejected by the server with code 1008 (Key exchange required) and
 *     trigger a reconnect loop on flaky networks.
 */
export function sendClientVisible(socket: WebSocket | null, visible: boolean): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (_lastSentVisible === visible) return;
  if (_ctx.pendingKeyPair !== null && _ctx.encryptionState === null) return;
  _lastSentVisible = visible;
  wsSend(socket, { type: 'client_visible', visible });
}

// ---------------------------------------------------------------------------
// Bound-session mismatch Alert helper
//
// Both `session_error` (#2904) and `web_task_error` (#2944) surface the same
// actionable Alert when the server reports a SESSION_TOKEN_MISMATCH with a
// bound session name attached. The body copy differs slightly between the two
// surfaces (chat vs. web tasks) but the title, button layout, and the
// disconnect/clearSavedConnection side-effects are identical. Centralising
// here keeps the Disconnect behaviour in lockstep across surfaces (#3022).
// ---------------------------------------------------------------------------
function showBoundSessionMismatchAlert(bodyText: string): void {
  Alert.alert(
    'Device paired to one session',
    bodyText,
    [
      { text: 'OK', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          // Close the active socket, reset in-memory state AND
          // forget the stored credentials — otherwise ConnectScreen
          // auto-reconnects with the same bound token and the user
          // is stuck. `clearSavedCredentials` alone is a SecureStore
          // wipe; it doesn't touch the live socket. `disconnect()`
          // handles the socket + in-memory state;
          // `clearSavedConnection()` wipes storage + state.
          const s = getStore().getState();
          try { s.disconnect(); } catch { /* best-effort */ }
          const clearSaved = (s as unknown as { clearSavedConnection?: () => Promise<void> }).clearSavedConnection;
          if (typeof clearSaved === 'function') {
            clearSaved.call(s).catch(() => {});
          }
        },
      },
    ],
  );
}

// ---------------------------------------------------------------------------
// Pending set_permission_mode requests
//
// Tracks in-flight `set_permission_mode` requests by `requestId` so that a
// `CAPABILITY_NOT_SUPPORTED` rejection from the server can be matched back to
// the originating call and used to revert the optimistic UI state. Entries
// are cleared when the matching `permission_mode_changed` broadcast arrives
// or when the rejection is processed in the `error` case below.
// ---------------------------------------------------------------------------
interface PendingPermissionModeRequest {
  sessionId: string | null;
  previousMode: string | null;
  requestedMode: string;
}
const _pendingPermissionModeRequests = new Map<string, PendingPermissionModeRequest>();

export function registerPendingPermissionModeRequest(
  requestId: string,
  entry: PendingPermissionModeRequest,
): void {
  _pendingPermissionModeRequests.set(requestId, entry);
}

export function takePendingPermissionModeRequest(
  requestId: string,
): PendingPermissionModeRequest | undefined {
  const entry = _pendingPermissionModeRequests.get(requestId);
  if (entry) _pendingPermissionModeRequests.delete(requestId);
  return entry;
}

export function clearPendingPermissionModeRequestsForSession(sessionId: string | null): void {
  for (const [reqId, entry] of _pendingPermissionModeRequests) {
    if (entry.sessionId === sessionId) _pendingPermissionModeRequests.delete(reqId);
  }
}

/** @internal Exposed for testing only */
export function _testClearPendingPermissionModeRequests(): void {
  _pendingPermissionModeRequests.clear();
}

// ---------------------------------------------------------------------------
// Connection context (set by connect(), read by handleMessage)
// ---------------------------------------------------------------------------
let _connectionContext: ConnectionContext | null = null;

export function setConnectionContext(ctx: ConnectionContext | null): void {
  _connectionContext = ctx;
}

export function getConnectionContext(): ConnectionContext | null {
  return _connectionContext;
}

// ---------------------------------------------------------------------------
// Encryption state accessors
// ---------------------------------------------------------------------------
export function getEncryptionState(): EncryptionState | null {
  return _ctx.encryptionState;
}

export function setEncryptionState(state: EncryptionState | null): void {
  _ctx.encryptionState = state;
}

export function getPendingKeyPair(): KeyPair | null {
  return _ctx.pendingKeyPair;
}

export function setPendingKeyPair(kp: KeyPair | null): void {
  _ctx.pendingKeyPair = kp;
}

/**
 * #5555 (eager key exchange) — generate this connection's ephemeral X25519
 * keypair + per-connection salt and stash them on the handler context so they
 * can be sent WITH the `auth` message (in `socket.onopen`). Returns the public
 * key + salt to inline into auth.
 *
 * The discrete `key_exchange_ok` / fallback handler reads the same
 * `_ctx.pendingKeyPair` + `_ctx.pendingSalt`, so if the server omits
 * `serverPublicKey` from auth_ok (old server, encryption disabled, eager
 * derivation failed) the client still has everything it needs to fall back to
 * the discrete handshake without regenerating keys. Crypto is identical to the
 * discrete path — only the send timing changes.
 */
export function prepareEagerKeyExchange(): { publicKey: string; salt: string } {
  _ctx.pendingKeyPair = createKeyPair();
  _ctx.pendingSalt = generateConnectionSalt();
  return { publicKey: _ctx.pendingKeyPair.publicKey, salt: _ctx.pendingSalt };
}

// ---------------------------------------------------------------------------
// Connection attempt tracking
// These are kept as export let (not in _ctx) to preserve ES module live-binding
// semantics: connection.ts snapshots the value and later compares against the
// live export to detect stale connection attempts.
// ---------------------------------------------------------------------------
export let connectionAttemptId = 0;
export let disconnectedAttemptId = -1;
export let lastConnectedUrl: string | null = null;

// #5555.5 — consecutive close/error-path reconnect counter, used to index the
// RETRY_DELAYS backoff ladder so a flapping tunnel escalates its retry spacing
// (1s → 2s → 3s → 5s → 8s) instead of hammering the handshake at a fixed delay.
// Reset to 0 on `auth_ok` (a *successful* connect — proof the link is healthy),
// NOT on mere socket-open, so a socket that opens but never authenticates keeps
// climbing the ladder. Lives here (not a connect() closure) because the count
// must survive the connect() → drop → connect() cycle and be cleared from the
// auth_ok handler.
export let reconnectAttempt = 0;

export function bumpConnectionAttemptId(): number {
  return ++connectionAttemptId;
}

/** Advance the backoff ladder, returning the pre-increment attempt index. */
export function nextReconnectAttempt(): number {
  return reconnectAttempt++;
}

/** Reset the backoff ladder — called from the `auth_ok` handler on a clean connect. */
export function resetReconnectAttempt(): void {
  reconnectAttempt = 0;
}

export function setDisconnectedAttemptId(id: number): void {
  disconnectedAttemptId = id;
}

export function setLastConnectedUrl(url: string | null): void {
  lastConnectedUrl = url;
}

// Pending pairing ID — set when connecting via QR pairing flow, cleared after auth_ok
export let pendingPairingId: string | null = null;

export function setPendingPairingId(id: string | null): void {
  pendingPairingId = id;
}

// #5536 — the daemon's E2E identity public key captured from the trusted pairing
// channel (QR / pairing-code `idk=`) for THIS connection attempt, not yet
// committed as the pin. The key-exchange handler verifies the server's signed
// exchange key against it and pins it on first successful connect. Cleared once
// consumed (a successful pin / auth_ok) so it never leaks into the next dial.
export let pendingPairingIdentityKey: string | null = null;

export function setPendingPairingIdentityKey(key: string | null): void {
  pendingPairingIdentityKey = key;
}

// ---------------------------------------------------------------------------
// History replay flags
// ---------------------------------------------------------------------------
export function setPendingSwitchSessionId(id: string | null): void {
  _ctx.pendingSwitchSessionId = id;
}

export function resetReplayFlags(): void {
  _ctx.replayingSessions.clear();
  _ctx.isSessionSwitchReplay = false;
  _ctx.pendingSwitchSessionId = null;
}

// ---------------------------------------------------------------------------
// Permission boundary message splitting (#554)
// ---------------------------------------------------------------------------
export function clearPermissionSplits(): void {
  _ctx.postPermissionSplits.clear();
  _ctx.deltaIdRemaps.clear();
}

// ---------------------------------------------------------------------------
// Terminal write batching
// ---------------------------------------------------------------------------
export function flushTerminalWrites(): void {
  _ctx.terminalWriteTimer = null;
  if (_ctx.pendingTerminalWrites.length === 0) return;
  const data = _ctx.pendingTerminalWrites;
  _ctx.pendingTerminalWrites = '';
  const cb = getCallback('terminalWrite');
  if (cb) cb(data);
}

export function appendPendingTerminalWrite(data: string): void {
  _ctx.pendingTerminalWrites += data;
  if (!_ctx.terminalWriteTimer) {
    _ctx.terminalWriteTimer = setTimeout(flushTerminalWrites, 50);
  }
}

export function clearTerminalWriteBatching(): void {
  if (_ctx.terminalWriteTimer) {
    clearTimeout(_ctx.terminalWriteTimer);
    _ctx.terminalWriteTimer = null;
  }
  _ctx.pendingTerminalWrites = '';
}

// ---------------------------------------------------------------------------
// Client-side heartbeat
// ---------------------------------------------------------------------------
/**
 * Max session IDs per subscribe_sessions message (must match server
 * SubscribeSessionsSchema .max(20)). Re-exported from
 * `@chroxy/store-core`'s {@link SESSION_LIST_SUBSCRIBE_CHUNK_SIZE} so the
 * app and dashboard can't drift apart (#4767).
 */
export const SUBSCRIBE_SESSIONS_CHUNK_SIZE = SESSION_LIST_SUBSCRIBE_CHUNK_SIZE;
// Exported (#5633) so the AppState resume handler can use the real heartbeat
// cadence as its "was the app backgrounded long enough for the socket to have
// silently died?" threshold, rather than hardcoding a separate magic number
// that could drift from this one. #6035: re-sourced from store-core so the app
// and dashboard can't drift.
export const HEARTBEAT_INTERVAL_MS = SC_HEARTBEAT_INTERVAL_MS;
// #5515 (epic #5514): throttle the dev latency readout so a streaming turn
// can't spam the console — one line every few seconds is enough to watch the
// numbers move when flush intervals are tuned. Shared with recordLatencySamples
// (the delta-flush latency path) via the same throttle window (#6035).
const LATENCY_LOG_INTERVAL_MS = SC_LATENCY_LOG_INTERVAL_MS;

// #5516 (epic #5514): adaptive delta-flush interval. Production reads the
// current EWMA RTT and adapts (16-33ms cheap → 100ms poor) via
// `resolveDeltaFlushMs` inside the shared flusher. Tests pin it to a constant by
// calling `setDeltaFlushIntervalOverride(N)`; `null` (the default) restores
// adaptive behavior. #5556: now delegates to the flusher's own override.
export function setDeltaFlushIntervalOverride(ms: number | null): void {
  _ctx.deltaFlusher.setIntervalOverride(ms);
}

// #6035: the heartbeat ping loop, the pong-timeout reaper, the handshake-window
// timer, and the pong RTT measurement live in the shared
// `createHeartbeatController` on the context. These exported wrappers delegate
// to it so connection.ts's call sites and the test suites keep the same
// `startHeartbeat`/`stopHeartbeat`/`armHandshakeTimer`/`clearHandshakeTimer`
// contract.
export function stopHeartbeat(): void {
  _ctx.heartbeat.stopHeartbeat();
}

export function startHeartbeat(socket: WebSocket): void {
  _ctx.heartbeat.startHeartbeat(socket);
}

// #5962 (#5721 parity) — client-side handshake timeout budget (re-exported from
// store-core so connection.ts and the tests can read it). The heartbeat does
// NOT start until auth_ok is processed, so the handshake window had no liveness
// coverage before this timer; it hands off to the reconnect ladder ("Handshake
// failed — reconnecting") instead of a silent stall.
export const HANDSHAKE_TIMEOUT_MS = SC_HANDSHAKE_TIMEOUT_MS;

export function armHandshakeTimer(onTimeout: () => void): void {
  _ctx.heartbeat.armHandshakeTimer(onTimeout);
}

export function clearHandshakeTimer(): void {
  _ctx.heartbeat.clearHandshakeTimer();
}

function _onPong(serverTs?: number): void {
  _ctx.heartbeat.handlePong(serverTs);
}

// ---------------------------------------------------------------------------
// Delta batching
// ---------------------------------------------------------------------------
// #5556: the store-mutation half of the old `flushPendingDeltas`. The shared
// flusher owns the accumulator/timer and snapshots+clears `pendingDeltas`, then
// hands us the batch. App-side this writes session state only (no flat-
// `messages` fallback). `flushNow()`/`schedule()` invoke this via the flusher.
function applyDeltaBatch(updates: Map<string, { sessionId: string | null; delta: string }>): void {
  const state = getStore().getState();

  const bySession = new Map<string | null, Map<string, string>>();
  for (const [msgId, { sessionId, delta }] of updates) {
    if (!bySession.has(sessionId)) bySession.set(sessionId, new Map());
    bySession.get(sessionId)!.set(msgId, delta);
  }

  let newSessionStates = { ...state.sessionStates };
  let flatUpdated = false;

  for (const [sessionId, deltas] of bySession) {
    if (sessionId && newSessionStates[sessionId]) {
      const sessionState = newSessionStates[sessionId];
      const matched = new Set<string>();
      // Type guard: never apply deltas to non-response messages, even if id
      // matches. Defense against future server regressions that reintroduce
      // id collisions across tool_start and stream_start.
      const updatedMessages = sessionState.messages.map((m) => {
        const d = deltas.get(m.id);
        if (d && m.type === 'response') {
          matched.add(m.id);
          return { ...m, content: m.content + d };
        }
        return m;
      });
      // Safety net: create response messages for orphaned deltas (#2611,
      // ported to app in #3168, extracted to canonical helper in #3176).
      const finalMessages = updatedMessages;
      applyOrphanDeltas(finalMessages, deltas, matched, _ctx.deltaIdRemaps);
      newSessionStates = {
        ...newSessionStates,
        [sessionId]: { ...sessionState, messages: finalMessages },
      };
      if (sessionId === state.activeSessionId) {
        getStore().setState({ sessionStates: newSessionStates });
        flatUpdated = true;
      }
    } else {
      // No session context — apply to active session
      const activeId = state.activeSessionId;
      if (activeId && newSessionStates[activeId]) {
        const ss = newSessionStates[activeId];
        const matched = new Set<string>();
        const updatedMessages = ss.messages.map((m) => {
          const d = deltas.get(m.id);
          if (d && m.type === 'response') {
            matched.add(m.id);
            return { ...m, content: m.content + d };
          }
          return m;
        });
        // Same orphan-create safety net as the sessionStates branch above
        // (canonical helper extracted in #3176).
        const finalMessages = updatedMessages;
        applyOrphanDeltas(finalMessages, deltas, matched, _ctx.deltaIdRemaps);
        newSessionStates = {
          ...newSessionStates,
          [activeId]: { ...ss, messages: finalMessages },
        };
        getStore().setState({ sessionStates: newSessionStates });
        flatUpdated = true;
      }
    }
  }

  if (!flatUpdated) {
    getStore().setState({ sessionStates: newSessionStates });
  }

  // #5515 (epic #5514): the store write above is the render trigger; sample
  // latency for the message ids we just flushed. serverTs→render is the
  // headline token-to-render number (wall-clock both ends but measured as one
  // delta against the local recv, see below); recv→render is the pure client
  // cost. Each id's stamp is consumed once so the next flush window restamps.
  recordLatencySamples(updates.keys());
}

// #5515: measure token-to-render for the flushed message ids and feed the
// rolling p50/p95 buffers, emitting a throttled dev log. Pulled out of
// flushPendingDeltas so the hot path stays readable and it can be unit-tested.
//
// Clock note: `serverTs` is the server's wall-clock stamp and `now`/`recvAt`
// are the client's. A raw serverTs→now subtraction is skew-prone, so we report
// it as APPROXIMATE token-to-render and pair it with recv→render (same client
// clock, skew-free) as the trustworthy client-render cost. We do NOT derive
// one-way transport numbers from this subtraction — those come from the
// RTT-split path in _onPong.
function recordLatencySamples(messageIds: Iterable<string>): void {
  const now = Date.now();
  let sampled = false;
  for (const id of messageIds) {
    const stamp = _ctx.deltaServerTs.get(id);
    if (!stamp) continue;
    _ctx.deltaServerTs.delete(id);
    _ctx.tokenToRender.add(now - stamp.serverTs);
    _ctx.clientRender.add(now - stamp.recvAt);
    sampled = true;
  }
  if (!sampled) return;
  if (now - _ctx.lastLatencyLogAt < LATENCY_LOG_INTERVAL_MS) return;
  _ctx.lastLatencyLogAt = now;
  const ttr = _ctx.tokenToRender.summary();
  const cr = _ctx.clientRender.summary();
  console.log(
    `[latency] token→render(~approx, wall-clock) n=${ttr.count} p50=${ttr.p50}ms p95=${ttr.p95}ms | ` +
    `client-render n=${cr.count} p50=${cr.p50}ms p95=${cr.p95}ms`
  );
}

export function clearDeltaBuffers(): void {
  // #5556: the flusher cancels its timer and drops the accumulator (teardown,
  // not flush — these deltas belong to a connection that's going away).
  _ctx.deltaFlusher.clear();
  // #5515: drop any un-flushed latency stamps so they can't survive a reset
  // and pollute the next session's token-to-render window.
  _ctx.deltaServerTs.clear();
}

// ---------------------------------------------------------------------------
// Message queue: buffer messages while disconnected, drain on reconnect
// ---------------------------------------------------------------------------
const QUEUE_TTLS: Record<string, number> = {
  input: 60_000,
  interrupt: 5_000,
};
const QUEUE_MAX_SIZE = 10;
// #5699: permission_response / user_question_response are NOT queueable — the
// server expires the pending request the moment the socket drops, so a queued
// answer would drain into the void on reconnect while the UI could appear to
// have answered. They are refused at the call sites (sendPermissionResponse /
// sendUserQuestionResponse return false when disconnected); excluding them here
// is the defense-in-depth backstop so no future enqueue path can re-introduce
// the silent-loss bug.
const QUEUE_EXCLUDED = new Set([
  'set_model',
  'set_permission_mode',
  'mode',
  'resize',
  'permission_response',
  'user_question_response',
]);

/**
 * #5633: surface a queue failure to the user as a system message in the
 * transcript, matching how the existing "Message queued — waiting for
 * reconnection..." feedback is rendered in SessionScreen. Silently dropping
 * input/interrupts here is exactly the "I sent it and nothing happened" class
 * of bug we're fixing — the user must see that the action did not land.
 *
 * The notice is routed to the session the dropped action belonged to
 * (`targetSessionId`, read off the queued payload's `sessionId`) rather than
 * whatever session happens to be active now. If the user switched sessions
 * while disconnected, the notice must land in the transcript they were typing
 * into — not the one they're looking at. Falls back to the active session
 * (`addMessage`) only when the payload carried no usable `sessionId`.
 */
function notifyQueueFailure(content: string, targetSessionId?: string | null): void {
  try {
    const noticeMsg: ChatMessage = {
      id: nextMessageId('queue-drop'),
      type: 'system',
      content,
      timestamp: Date.now(),
    };
    if (targetSessionId && getStore().getState().sessionStates[targetSessionId]) {
      updateSession(targetSessionId, (ss) => ({
        messages: [...ss.messages, noticeMsg],
      }));
    } else {
      // No (live) target session — fall back to the active session. addMessage
      // targets the active session; if there's no active session the failure
      // can't be surfaced inline, but never let feedback throw into the
      // send/drain path.
      getStore().getState().addMessage(noticeMsg);
    }
  } catch {
    // Never let feedback throw into the send/drain path.
  }
}

/** Read the `sessionId` off a queued payload, if it carries one (#5633). */
function payloadSessionId(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const sid = (payload as Record<string, unknown>).sessionId;
    if (typeof sid === 'string' && sid.length > 0) return sid;
  }
  return null;
}

/**
 * #5699 — mirror the count of queued *user input* into the store so the
 * reconnect banner + manual-disconnect warning can react to it. Counts only
 * `input` entries, not `interrupt`: an interrupt is an ephemeral control signal
 * (5s TTL, see QUEUE_TTLS) the user never typed as a "message", so including it
 * would make the banner say "1 unsent message queued" — and the discard-warning
 * copy lie — when nothing the user authored is actually pending. No-op when the
 * store isn't wired yet (early enqueue / unit fixtures).
 */
function syncQueueCount(): void {
  if (!_store) return;
  const count = _ctx.messageQueue.reduce((n, m) => (m.type === 'input' ? n + 1 : n), 0);
  _store.setState({ queuedMessageCount: count });
}

export function enqueueMessage(type: string, payload: unknown): 'queued' | false {
  if (QUEUE_EXCLUDED.has(type)) return false;
  const maxAge = QUEUE_TTLS[type];
  if (!maxAge) return false;
  if (_ctx.messageQueue.length >= QUEUE_MAX_SIZE) {
    // #5633: the queue is full — the 11th+ message would otherwise be dropped
    // silently with sendInput still reporting nothing actionable. Tell the user,
    // in the transcript the dropped action belonged to (not just whatever's
    // active now), and with action-aware copy so an overflowed `interrupt`
    // isn't called a "message".
    console.warn(`[queue] Queue full (${QUEUE_MAX_SIZE}) — dropping ${type}`);
    const noun = type === 'interrupt' ? 'interrupt' : 'message';
    notifyQueueFailure(
      `Couldn't ${type === 'interrupt' ? 'deliver' : 'queue'} your ${noun} — too many pending while disconnected (max ${QUEUE_MAX_SIZE}). Please resend after reconnecting.`,
      payloadSessionId(payload),
    );
    return false;
  }
  _ctx.messageQueue.push({ type, payload, queuedAt: Date.now(), maxAge });
  console.log(`[queue] Queued ${type} (${_ctx.messageQueue.length}/${QUEUE_MAX_SIZE})`);
  syncQueueCount();
  return 'queued';
}

export function drainMessageQueue(socket: WebSocket): void {
  if (_ctx.messageQueue.length === 0) return;
  const now = Date.now();
  const valid: QueuedMessage[] = [];
  const expired: QueuedMessage[] = [];
  for (const m of _ctx.messageQueue) {
    if (now - m.queuedAt < m.maxAge) valid.push(m);
    else expired.push(m);
  }
  _ctx.messageQueue.length = 0;
  syncQueueCount(); // queue emptied on drain — clear the reactive count (#5699)

  // #5633: a queued message can expire before a longer backoff completes —
  // notably an `interrupt` with its 5s TTL. That drop was invisible: the user
  // tapped Stop, the reconnect took >5s, and the interrupt silently evaporated.
  // Surface any expired entry so the user knows it didn't land.
  if (expired.length > 0) {
    console.warn(`[queue] Dropping ${expired.length} expired queued message(s) on drain`);
    // #5633: route each expiry notice to the session the dropped action
    // belonged to (the queued payload's `sessionId`) — if the user switched
    // sessions while reconnecting, the notice must land in the transcript they
    // were typing into, not the one now active.
    const expiredInterrupt = expired.find((m) => m.type === 'interrupt');
    if (expiredInterrupt) {
      notifyQueueFailure(
        'Your interrupt expired before reconnecting and was not sent — tap Stop again if still needed.',
        payloadSessionId(expiredInterrupt.payload),
      );
    }
    const expiredOther = expired.find((m) => m.type !== 'interrupt');
    if (expiredOther) {
      notifyQueueFailure(
        'A queued message expired before reconnecting and was not sent — please resend.',
        payloadSessionId(expiredOther.payload),
      );
    }
  }

  if (valid.length === 0) return;
  console.log(`[queue] Draining ${valid.length} queued message(s)`);
  for (const m of valid) {
    try {
      wsSend(socket, m.payload as Record<string, unknown>);
    } catch (err) {
      console.warn(`[queue] Failed to send queued ${m.type}:`, err);
    }
  }
}

export function clearMessageQueue(): void {
  _ctx.messageQueue.length = 0;
  syncQueueCount(); // #5699
}

/** @internal Exposed for testing only */
export const _testQueueInternals = {
  getQueue: () => _ctx.messageQueue,
  enqueue: enqueueMessage,
  drain: drainMessageQueue,
  clear: () => { _ctx.messageQueue.length = 0; },
};

// ---------------------------------------------------------------------------
// Session update helpers
// ---------------------------------------------------------------------------

/**
 * Update any session's state by ID. sessionStates is the single source of truth.
 */
export function updateSession(sessionId: string, updater: (session: SessionState) => Partial<SessionState>): void {
  const state = getStore().getState();
  if (!state.sessionStates[sessionId]) return;

  const current = state.sessionStates[sessionId];
  const patch = updater(current);
  if (Object.keys(patch).length === 0) return;
  const updated = { ...current, ...patch };
  // Auto-derive activity state from session state changes
  const newActivity = deriveActivityState(
    {
      isIdle: updated.isIdle,
      streamingMessageId: updated.streamingMessageId,
      isPlanPending: updated.isPlanPending,
    },
    current.activityState,
  );
  if (newActivity.state !== updated.activityState?.state || newActivity.startedAt !== updated.activityState?.startedAt) {
    updated.activityState = newActivity;
  }
  const newSessionStates = { ...state.sessionStates, [sessionId]: updated };
  getStore().setState({ sessionStates: newSessionStates });
}

/** Get messages for a target session (or active session if no target). */
function getSessionMessages(targetId: string | null | undefined): ChatMessage[] {
  const state = getStore().getState();
  const id = targetId || state.activeSessionId;
  if (id && state.sessionStates[id]) return state.sessionStates[id].messages;
  return [];
}

/** Helper to update the active session's state. */
export function updateActiveSession(updater: (session: SessionState) => Partial<SessionState>): void {
  const state = getStore().getState();
  const activeId = state.activeSessionId;
  if (activeId) updateSession(activeId, updater);
}

// ---------------------------------------------------------------------------
// Shared dispatch table (epic #5556, sub-item 3)
//
// Pure-delegation message cases that were byte-identical with the dashboard's
// handler are owned by the store-core table. `handleMessage` runs the table
// first; a miss falls through to the switch below, so the remaining (and
// genuinely divergent) cases stay exactly where they were.
// ---------------------------------------------------------------------------

const _dispatchAdapter: ClientStoreAdapter<SessionState> = {
  getActiveSessionId: () => getStore().getState().activeSessionId,
  hasSession: (id) => !!getStore().getState().sessionStates[id],
  updateSession: (id, updater) => updateSession(id, updater),
  setState: (patch) => getStore().setState(patch as Partial<ConnectionState>),
  // #5556 slice 4 — functional flat-state update for the web-task upsert cases.
  // Mirrors the prior inline `set((state) => …)` exactly (Zustand merges the
  // returned partial). The loose record in/out is cast to the store's
  // ConnectionState shape, same as `setState` above.
  updateState: (updater) =>
    getStore().setState((state) =>
      updater(state as unknown as Record<string, unknown>) as Partial<ConnectionState>,
    ),
  addMessage: (m) => getStore().getState().addMessage(m),
  getSessions: () => getStore().getState().sessions,
  // #5653 — file-ops / git wrapper cases route through the shared dispatch
  // table; the app supplies its module-level imperative-callback registry so
  // the parsed payload reaches the UI's registered callback exactly as the
  // prior `getCallback(name) → shared*(msg) → cb(...)` switch arms did. The
  // store-core handler narrows to a loose `(payload) => void`; the registered
  // callback's concrete type (e.g. `(listing: DirectoryListing) => void`) is
  // structurally compatible since the parsed payload is a superset.
  getCallback: (name: DispatchCallbackName) =>
    getCallback(name as CallbackName) as
      | ((payload: DispatchCallbackPayload) => void)
      | null,
};

const _dispatchTable = createDispatchTable<SessionState>();

// ---------------------------------------------------------------------------
// Input preview helper
// ---------------------------------------------------------------------------

/** Build a short preview string from a tool input object (max 120 chars). */
function truncateInput(input: Record<string, unknown>): string {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v ? v : undefined;
  // For common tools, pick the most informative field
  const preview =
    str(input.command) ??
    str(input.file_path) ??
    str(input.pattern) ??
    str(input.content) ??
    str(input.query) ??
    '';
  if (preview.length > 120) return preview.slice(0, 117) + '...';
  return preview || JSON.stringify(input).slice(0, 120);
}

// ---------------------------------------------------------------------------
// Session notification helper
// ---------------------------------------------------------------------------

/**
 * Push a notification for a background session event.
 * Deduplicates by (sessionId, eventType) — replaces existing rather than stacking.
 */
function pushSessionNotification(
  sessionId: string,
  eventType: SessionNotification['eventType'],
  message: string,
  requestId?: string,
  extra?: { tool?: string; description?: string; inputPreview?: string },
): void {
  const state = getStore().getState();
  if (sessionId === state.activeSessionId) return;
  const sessionInfo = state.sessions.find((s) => s.sessionId === sessionId);
  const sessionName = sessionInfo?.name || sessionId;
  const notification: SessionNotification = {
    id: `${sessionId}-${eventType}-${Date.now()}`,
    sessionId,
    sessionName,
    eventType,
    message,
    timestamp: Date.now(),
    ...(requestId ? { requestId } : {}),
    ...(extra?.tool ? { tool: extra.tool } : {}),
    ...(extra?.description ? { description: extra.description } : {}),
    ...(extra?.inputPreview ? { inputPreview: extra.inputPreview } : {}),
  };
  getStore().setState((s) => {
    const filtered = s.sessionNotifications.filter(
      (n) => !(n.sessionId === sessionId && n.eventType === eventType),
    );
    return { sessionNotifications: [...filtered, notification] };
  });
  useNotificationStore.getState().addSessionNotification(notification);
}

// ---------------------------------------------------------------------------
// Push token registration
// ---------------------------------------------------------------------------

async function registerPushToken(socket: WebSocket): Promise<void> {
  try {
    const token = await registerForPushNotifications();
    if (token && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'register_push_token', token });
      // #4543: mirror the resolved token into the store so the
      // SettingsScreen can address THIS device's entry in the
      // `notification_prefs.devices` map. Without this mirror the
      // per-device toggle row would never know which key to patch and
      // would have to render disabled forever.
      getStore().setState({ pushToken: token });
      console.log('[push] Registered push token with server');
    }
  } catch (err) {
    console.log('[push] Push registration skipped:', err);
  }
}

// ---------------------------------------------------------------------------
// Connection persistence helpers
// ---------------------------------------------------------------------------
import * as SecureStore from 'expo-secure-store';
import type { SavedConnection } from '@chroxy/store-core';
import {
  decideKeyPinWithPairingIdentity,
  decodeEncryptionGate,
} from '@chroxy/store-core';

const STORAGE_KEY_URL = 'chroxy_last_url';
const STORAGE_KEY_TOKEN = 'chroxy_last_token';
// #5518 — dual-endpoint metadata (LAN candidate + verification + tunnel URL)
// kept in a separate JSON blob so the legacy url/token keys stay byte-for-byte
// compatible with pre-#5518 builds.
const STORAGE_KEY_LAN_META = 'chroxy_last_lan_meta';

/** Optional dual-endpoint fields persisted alongside the legacy url+token. */
export type SavedConnectionExtras = Pick<
  SavedConnection,
  'lanUrl' | 'lanVerified' | 'tunnelUrl' | 'pinnedIdentityKey'
>;

export async function saveConnection(
  url: string,
  token: string,
  extras?: SavedConnectionExtras,
): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_URL, url);
    await SecureStore.setItemAsync(STORAGE_KEY_TOKEN, token);
    // Only persist a metadata blob when there's something to store; otherwise
    // delete any stale one so a fresh server (no LAN) can't inherit old fields.
    const meta: SavedConnectionExtras = {};
    if (extras?.lanUrl) meta.lanUrl = extras.lanUrl;
    if (extras?.lanVerified) meta.lanVerified = true;
    if (extras?.tunnelUrl) meta.tunnelUrl = extras.tunnelUrl;
    // #5536 — the pinned E2E identity travels in the same metadata blob.
    if (extras?.pinnedIdentityKey) meta.pinnedIdentityKey = extras.pinnedIdentityKey;
    if (Object.keys(meta).length > 0) {
      await SecureStore.setItemAsync(STORAGE_KEY_LAN_META, JSON.stringify(meta));
    } else {
      await SecureStore.deleteItemAsync(STORAGE_KEY_LAN_META);
    }
  } catch {
    // Storage not available (e.g. Expo Go limitations)
  }
}

export async function loadConnection(): Promise<SavedConnection | null> {
  try {
    const url = await SecureStore.getItemAsync(STORAGE_KEY_URL);
    const token = await SecureStore.getItemAsync(STORAGE_KEY_TOKEN);
    if (!url || !token) return null;
    const conn: SavedConnection = { url, token };
    try {
      const rawMeta = await SecureStore.getItemAsync(STORAGE_KEY_LAN_META);
      if (rawMeta) {
        const meta = JSON.parse(rawMeta) as SavedConnectionExtras;
        // Validate types defensively — a tampered/stale blob must not flow
        // unverified LAN state through to the endpoint selector.
        if (typeof meta.lanUrl === 'string' && /^ws:\/\//i.test(meta.lanUrl)) {
          conn.lanUrl = meta.lanUrl;
        }
        if (meta.lanVerified === true && conn.lanUrl) conn.lanVerified = true;
        if (typeof meta.tunnelUrl === 'string') conn.tunnelUrl = meta.tunnelUrl;
        // #5536 — restore the pinned identity (base64 string) if present.
        if (typeof meta.pinnedIdentityKey === 'string' && meta.pinnedIdentityKey) {
          conn.pinnedIdentityKey = meta.pinnedIdentityKey;
        }
      }
    } catch {
      // Corrupt metadata — drop it, keep the legacy url+token.
    }
    return conn;
  } catch {
    // Storage not available
  }
  return null;
}

/**
 * #5518 — persist the connection record after a SUCCESSFUL auth handshake.
 *
 * Folds the just-connected URL into the dual-endpoint record via
 * `recordVerifiedLanCandidate` (which sets `lanVerified` only for ws:// LAN URLs
 * and clears stale verification on token change), then writes it to both
 * SecureStore and the in-memory lifecycle store. Centralised so the auth_ok and
 * token_rotated sites share identical semantics.
 */
export function persistVerifiedConnection(
  connectedUrl: string,
  token: string,
  // #5536 — the pinned identity to persist with this record. Pass the newly
  // pinned key on a pin-on-first-use; omit to preserve whatever the prior
  // record carried (every reconnect re-runs this and must not drop the pin).
  pinnedIdentityKey?: string | null,
): void {
  const prev = useConnectionLifecycleStore.getState().savedConnection;
  const base: SavedConnection = prev?.token === token && prev
    ? prev
    : { url: connectedUrl, token };
  const next = recordVerifiedLanCandidate(base, connectedUrl, token);
  // `url` tracks the last-dialed endpoint for backward compat / manual flows.
  next.url = connectedUrl;
  // #5536 — a freshly pinned key wins; otherwise keep the prior record's pin.
  // recordVerifiedLanCandidate clears verification on token change but does not
  // touch pinnedIdentityKey, so an explicit token change does not silently drop
  // the pin — the identity is per-daemon, not per-token.
  if (pinnedIdentityKey) {
    next.pinnedIdentityKey = pinnedIdentityKey;
  }
  void saveConnection(next.url, next.token, {
    lanUrl: next.lanUrl,
    lanVerified: next.lanVerified,
    tunnelUrl: next.tunnelUrl,
    pinnedIdentityKey: next.pinnedIdentityKey,
  });
  useConnectionLifecycleStore.getState().setSavedConnection(next);
}

/**
 * #5555 (sub-item 7) — apply a rotated tunnel URL to the persisted connection.
 *
 * A quick-tunnel recovery rotated the public URL; the server pushed it (live,
 * via `tunnel_url_changed`) or re-advertised it (on reconnect, via the
 * `auth_bootstrap` burst's `tunnelUrl`). We repoint the saved record's
 * `tunnelUrl` to the new endpoint so the next reconnect dials it instead of the
 * dead URL — and because the record is SecureStore-backed, the fix survives an
 * app restart.
 *
 * `url` (the canonical "what to dial" field) is also repointed when it was the
 * old tunnel URL, so a tunnel-only record (no separate LAN endpoint) keeps
 * working. A `ws://` LAN `url` is left untouched — the rotation only concerns
 * the `wss://` tunnel endpoint.
 *
 * No-op when there is no saved connection, when the new URL equals the stored
 * one (idempotent re-advertisement on every reconnect), or when the new URL is
 * not a `wss://` URL (defensive — the server only rotates the tunnel endpoint).
 *
 * @param newTunnelUrl the rotated `wss://` endpoint
 * @returns true when the persisted record changed, false on a no-op
 */
export function applyRotatedTunnelUrl(newTunnelUrl: string): boolean {
  if (!newTunnelUrl || !/^wss:\/\//i.test(newTunnelUrl)) return false;
  const prev = useConnectionLifecycleStore.getState().savedConnection;
  if (!prev) return false;
  // A legacy record predating the `tunnelUrl` field carries its tunnel endpoint
  // only in `url` (a non-LAN `wss://` URL). Treat that as the implicit old
  // tunnel URL so the gates below still recognise + repoint it.
  const oldTunnelUrl =
    prev.tunnelUrl ?? (prev.url && /^wss:\/\//i.test(prev.url) ? prev.url : null);
  // Idempotent: the auth_bootstrap path re-advertises the URL on every connect,
  // so skip when nothing changed.
  if (oldTunnelUrl === newTunnelUrl && prev.url !== oldTunnelUrl) return false;
  const next: SavedConnection = { ...prev, tunnelUrl: newTunnelUrl };
  // Repoint the canonical dial URL only when it WAS the old tunnel endpoint
  // (a tunnel-only record, including a legacy `wss://` url). Never clobber a
  // verified ws:// LAN `url`.
  if (prev.url === oldTunnelUrl) {
    next.url = newTunnelUrl;
  }
  if (next.url === prev.url && next.tunnelUrl === prev.tunnelUrl) return false;
  void saveConnection(next.url, next.token, {
    lanUrl: next.lanUrl,
    lanVerified: next.lanVerified,
    tunnelUrl: next.tunnelUrl,
  });
  useConnectionLifecycleStore.getState().setSavedConnection(next);
  return true;
}

/**
 * Wipe the persisted connection URL + token from SecureStore.
 *
 * NOTE: Storage-only. This does NOT close the active WebSocket, reset in-memory
 * store state, or navigate the UI. Use the store-level `clearSavedConnection()`
 * for the full "forget this server" flow (storage + state), or `disconnect()`
 * to close the live socket + reset in-memory state.
 */
export async function clearSavedCredentials(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY_URL);
    await SecureStore.deleteItemAsync(STORAGE_KEY_TOKEN);
    await SecureStore.deleteItemAsync(STORAGE_KEY_LAN_META);
  } catch {
    // Storage not available
  }
}

/**
 * #5536 — verify the server's signed ephemeral exchange key against the pinned
 * (or pairing-time) E2E identity before keying off it. Shared by BOTH handshake
 * paths (eager auth_ok and discrete key_exchange_ok).
 *
 * On REFUSE (server identity changed / MITM / pinned-but-unsigned downgrade) it
 * tears the socket down and writes a distinct, specific error so the UI shows a
 * "server identity changed" state — NOT a silent retry loop. Returns
 * `{ refused: true }` so the caller aborts the handshake without deriving a key.
 *
 * On CONNECT it returns the identity to PERSIST (`pinToPersist`): the
 * pairing-time key on a pin-on-first-use, or null to leave the existing record's
 * pin untouched. The caller passes that to `persistVerifiedConnection`.
 *
 * @returns `{ refused: false, pinToPersist }` to proceed, or `{ refused: true }`.
 */
function verifyServerIdentityOrRefuse(
  ctx: ConnectionContext,
  exchangePublicKey: string,
  serverKeySig: string | null,
): { refused: false; pinToPersist: string | null } | { refused: true } {
  const saved = useConnectionLifecycleStore.getState().savedConnection;
  const pinnedIdentityKey = saved?.pinnedIdentityKey ?? null;
  const decision = decideKeyPinWithPairingIdentity({
    pinnedIdentityKey,
    pairingIdentityKey: pendingPairingIdentityKey,
    exchangePublicKey,
    serverKeySig,
  });
  if (decision.action === 'refuse') {
    applyIdentityRefusal(ctx, decision.reason, decision.message);
    return { refused: true };
  }
  // Connect — capture the pin to persist on first use; clear the pairing
  // identity once it's been adopted (or wasn't needed).
  const pinToPersist = decision.action === 'pin-and-connect' ? decision.identityKey : null;
  pendingPairingIdentityKey = null;
  return { refused: false, pinToPersist };
}

/**
 * #5614/#5536 — apply the loud, terminal "server identity refused" effects.
 * Shared by the signature/unsigned mismatch path and the plaintext-downgrade
 * gate so both surface identically (no silent retry, no fall-through to an
 * unencrypted session). setConnectionError(…, 0) clears the retry countdown so
 * the banner reads as a hard refusal. We do NOT clear the saved connection — the
 * user re-pairs to adopt the new identity, which overwrites the pin.
 */
function applyIdentityRefusal(ctx: ConnectionContext, reason: string, message: string): void {
  console.error(`[crypto] Server identity verification failed (${reason}) — refusing connection`);
  useConnectionLifecycleStore.getState().setConnectionPhase('disconnected');
  useConnectionLifecycleStore.getState().setConnectionError(message, 0);
  useConnectionLifecycleStore.getState().setUserDisconnected(true);
  if (!ctx.silent) {
    Alert.alert('Server Identity Changed', message);
  }
  try { ctx.socket.close(); } catch { /* already closing */ }
  getStore().setState({ socket: null });
  // Consume the pairing identity so a subsequent dial doesn't reuse it.
  pendingPairingIdentityKey = null;
}

/**
 * #5614 — the plaintext-downgrade gate, run at the TOP of the `auth_ok` handler
 * BEFORE the `encryption === 'required'` branch (where the pin check lives). If
 * this connection is pinned (committed pin or pairing-time identity) and the
 * server did not negotiate encryption, refuse — a MITM cannot otherwise be
 * stopped from forging a plaintext `auth_ok` that skips verification entirely.
 *
 * @returns true to PROCEED, false when the connection was refused (caller breaks).
 */
function enforceEncryptionGateOrRefuse(ctx: ConnectionContext, encryptionMode: string | null | undefined): boolean {
  const saved = useConnectionLifecycleStore.getState().savedConnection;
  const gate = decodeEncryptionGate({
    pinnedIdentityKey: saved?.pinnedIdentityKey ?? null,
    pairingIdentityKey: pendingPairingIdentityKey,
    encryptionMode,
  });
  if (gate.action === 'refuse') {
    applyIdentityRefusal(ctx, gate.reason, gate.message);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// handleMessage — main message dispatch
// ---------------------------------------------------------------------------

/**
 * Handles a parsed WebSocket message. Extracted from the socket.onmessage
 * closure so it can be tested directly with raw JSON payloads.
 *
 * Reads/writes store via getStore().getState()/setState() and
 * module-level helpers (updateSession, updateActiveSession, nextMessageId, etc).
 * The few variables that were closured in connect() are accessed via _connectionContext.
 */
export function handleMessage(raw: unknown, ctxOverride?: ConnectionContext): void {
  const ctx = ctxOverride ?? _connectionContext;
  if (!ctx) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string') return;

  const get = () => getStore().getState();
  const set: (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void =
    (s) => getStore().setState(s as ConnectionState);

  // #3758 — bump lastClientActivityAt for activity-bearing events BEFORE the
  // per-case handler runs. Doing it here keeps the bump in one place instead
  // of threading it through every stream_*/tool_*/message handler below.
  // Resolves the target session the same way the case handlers do: explicit
  // msg.sessionId wins, otherwise activeSessionId.
  //
  // #3899 — same branch also dismisses an outstanding inactivity warning:
  // by definition the silence has ended, so the chip should disappear
  // without waiting for the user to dismiss it manually. Mirrors the
  // equivalent clear in packages/dashboard/src/store/message-handler.ts.
  //
  // #4492 — gate on the replay set (mobile's per-connection equivalent of
  // the dashboard's `_receivingHistoryReplay` module flag — see #4466 /
  // PR #4490). switch_session and reconnect both replay past events through
  // this handler via history_replay_start → events → history_replay_end,
  // and replayed tool_start / message / result is NOT fresh activity.
  // Without this gate, every reconnect or session switch:
  //   1) bumps lastClientActivityAt to Date.now(), so "Working… last
  //      activity Ns ago" resets to 1s no matter how idle the session was;
  //   2) wipes inactivityWarning, so the "Agent quiet for 46m 32s · Status
  //      update?" chip disappears without the user ever seeing it again.
  // Live activity events arriving AFTER history_replay_end clears the flag
  // still bump correctly — verified by the regression-guard test in
  // message-handler.test.ts.
  //
  // #4512 — gate per target session id (Set membership), not a connection
  // flag. `replayHistory()` chunks over setImmediate, so live broadcasts
  // from session B can interleave with A's replay. A per-connection boolean
  // would wrongly suppress B's live activity bump for the duration of A's
  // replay.
  if (isActivityEvent(msg.type)) {
    const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || get().activeSessionId;
    if (targetId && get().sessionStates[targetId] && !_ctx.replayingSessions.has(targetId)) {
      updateSession(targetId, (ss) => {
        const patch: Partial<SessionState> = { lastClientActivityAt: Date.now() };
        if (ss.inactivityWarning) patch.inactivityWarning = null;
        return patch;
      });
    }
  }

  // #5556 — shared dispatch table first. A hit handles the message and returns;
  // a miss falls through to the switch below, keeping migration incremental.
  if (runDispatch(_dispatchTable, msg, _dispatchAdapter)) return;

  switch (msg.type) {
    case 'pong':
      _onPong(typeof msg.serverTs === 'number' ? msg.serverTs : undefined);
      return;

    case 'auth_ok': {
      // #5962 (#5721 parity) — auth_ok is the authoritative handshake-complete
      // signal; clear the handshake timer so a completed handshake can't fire it.
      // Eager-encryption and no-encryption connects never send key_exchange, so
      // this is the single authoritative clear (key_exchange_ok clears defensively).
      clearHandshakeTimer();
      // Reset replay flags — fresh auth means clean slate (#4512: clear the
      // per-session replaying set so a reconnect doesn't leave stale ids
      // gating future activity bumps).
      _ctx.replayingSessions.clear();
      // #5555.4 — clear any in-progress replay BASELINE (a rebuild that never
      // saw history_replay_end before the socket dropped). Cursors are RETAINED
      // so this reconnect's replay can be incremental.
      resetReplayReconcile();
      _ctx.isSessionSwitchReplay = false;
      _ctx.pendingSwitchSessionId = null;
      // #5555.5 — a successful auth is the ONLY proof the link is healthy, so
      // reset the close/error-path backoff ladder here (not on socket-open). A
      // socket that opens but never authenticates keeps climbing the ladder.
      resetReconnectAttempt();
      if (!ctx.isReconnect) hapticSuccess();
      // Track this URL as successfully connected
      lastConnectedUrl = ctx.url;
      // #4766: full wire-shape decode lives in the shared parser
      // (handleAuthOk + parseConnectedClients). The shared handler narrows
      // serverMode to `'cli' | null` (#4810: the wire protocol only emits
      // `'cli'`; the `'terminal'` branch was removed).
      const auth = sharedAuthOk(msg);
      const authServerMode: 'cli' | null = auth.serverMode;
      const clients = sharedParseConnectedClients(msg.connectedClients, auth.myClientId);

      // If server provided a sessionToken (via pairing), use it for future auth
      const effectiveToken = auth.sessionToken ?? ctx.token;
      const connectedState = {
        viewingCachedSession: false,
        socket: ctx.socket,
        claudeReady: false,
        streamingMessageId: null,
        myClientId: auth.myClientId, // kept for backward compat; canonical source is useMultiClientStore
        connectedClients: clients, // kept for backward compat; canonical source is useMultiClientStore
        // Clear shutdown state on successful connect
        shutdownReason: null,
        restartEtaMs: null,
        restartingSince: null,
        webFeatures: auth.webFeatures,
      };
      if (ctx.isReconnect) {
        set(connectedState);
      } else {
        set({
          ...connectedState,
          terminalBuffer: '',
          terminalRawBuffer: '',
          sessions: [],
          activeSessionId: null,
          sessionStates: {},
          customAgents: [],
        });
      }
      // Sync multi-client store (canonical source for multi-client state)
      useMultiClientStore.getState().setMyClientId(auth.myClientId);
      useMultiClientStore.getState().setConnectedClients(clients);
      // Sync connection lifecycle store
      useConnectionLifecycleStore.getState().setConnectionPhase('connected');
      useConnectionLifecycleStore.getState().setConnectionDetails(ctx.url, effectiveToken);
      // #5518 — surface the active transport on the connection-quality badge.
      // ws:// is the direct LAN path; wss:// is the tunnel.
      useConnectionLifecycleStore.getState().setActivePath(
        /^ws:\/\//i.test(ctx.url) ? 'lan' : 'tunnel',
      );
      useConnectionLifecycleStore.getState().setServerInfo({
        serverMode: authServerMode,
        serverVersion: auth.serverVersion,
        latestVersion: auth.latestVersion,
        serverCommit: auth.serverCommit,
        serverProtocolVersion: auth.protocolVersion,
        serverResultTimeoutMs: auth.resultTimeoutMs,
        // #4766: previously dropped on mobile — StreamStallChip couldn't
        // humanise the headline phrase without this. Dashboard already
        // threaded it; now the shared parser exposes it to both.
        streamStallTimeoutMs: auth.streamStallTimeoutMs,
        sessionCwd: auth.sessionCwd,
        // #4560: overwrite stale capabilities from a previous connection on
        // every auth_ok so a reconnect against a different (or older) server
        // can't have UI gates left enabled by previously-advertised flags.
        serverCapabilities: auth.serverCapabilities,
      });
      useConnectionLifecycleStore.getState().setConnectionError(null, 0);
      useConnectionLifecycleStore.getState().setUserDisconnected(false);

      // #5555 — fold the static permission-mode enum out of auth_ok when the
      // server provided it, so we don't have to wait for the discrete
      // `available_permission_modes` burst frame. Older servers omit the field
      // (null) and the discrete frame still lands; new servers send both and
      // this just wins the race harmlessly (idempotent set).
      if (auth.availablePermissionModes) {
        set({ availablePermissionModes: auth.availablePermissionModes });
      }

      // #5555 (auth_bootstrap) — when the server advertises the bootstrap
      // capability it pushes an `auth_bootstrap` burst frame carrying the
      // provider / slash-command / agent lists right after auth_ok. In that
      // case we SKIP the 3 connect-time list requests (they arrive unsolicited
      // in the burst). Older servers don't set the flag, so we request as
      // before. The list_* request paths stay live for post-connect refreshes.
      _ctx.serverWillBootstrap = auth.serverCapabilities.authBootstrap === true;
      const sendConnectListRequests = () => {
        if (_ctx.serverWillBootstrap) return;
        wsSend(ctx.socket, { type: 'list_providers' });
        wsSend(ctx.socket, { type: 'list_slash_commands' });
        wsSend(ctx.socket, { type: 'list_agents' });
      };

      // Start client-side heartbeat for dead connection detection
      startHeartbeat(ctx.socket);

      // #5536 — pin to persist with the connection record on a successful eager
      // handshake (pin-on-first-use). Declared at case scope so the
      // persistVerifiedConnection call below (outside the encryption branch) can
      // read it. null = keep the existing record's pin (discrete path / reconnect).
      let eagerPinToPersist: string | null = null;
      // #5614 — close the plaintext-auth_ok downgrade cell. If this connection is
      // PINNED, a non-`required` auth_ok is a downgrade attempt (a MITM forging a
      // plaintext auth_ok would otherwise skip the pin check that lives inside the
      // encryption branch below). Refuse BEFORE that branch — fail closed, same
      // terminal "identity refused" path as a signature mismatch. Unpinned
      // connections fall through and keep TOFU (encryption optional) as before.
      if (!enforceEncryptionGateOrRefuse(ctx, auth.encryption)) {
        _ctx.pendingKeyPair = null;
        _ctx.pendingSalt = null;
        break;
      }
      // Initiate key exchange if server requires encryption
      if (auth.encryption === 'required') {
        useConnectionLifecycleStore.getState().setServerInfo({ isEncrypted: true });
        // #5555 (eager key exchange) — the ephemeral keypair + salt were
        // already generated and sent WITH the auth message (socket.onopen →
        // prepareEagerKeyExchange), stashed on _ctx.pendingKeyPair /
        // _ctx.pendingSalt. If the server honoured the eager path it returns
        // its public key in auth_ok; derive the shared key immediately and
        // start the burst a full RTT earlier than the discrete handshake.
        //
        // #5555 follow-up (hardening) — `auth.serverPublicKey` is shared-parser
        // normalized (empty/non-string → null) but a non-empty MALFORMED value
        // (bad base64 / wrong length) still passes that filter and makes
        // `deriveSharedKey` throw. The discrete `key_exchange_ok` handler
        // guards against a bad key; mirror that here by wrapping the eager
        // derivation in try/catch and FALLING BACK to the discrete handshake
        // on any failure instead of letting the throw tear down the connection.
        let eagerEstablished = false;
        if (auth.serverPublicKey && _ctx.pendingKeyPair) {
          // #5536 — verify the server's signed exchange key against the pinned
          // (or pairing-time) identity BEFORE deriving the shared key. On a
          // mismatch this closes the socket and surfaces the refusal; we abort
          // the handshake entirely (no key derived, no post-auth burst).
          const verdict = verifyServerIdentityOrRefuse(ctx, auth.serverPublicKey, auth.serverKeySig);
          if (verdict.refused) {
            _ctx.pendingKeyPair = null;
            _ctx.pendingSalt = null;
            break;
          }
          eagerPinToPersist = verdict.pinToPersist;
          try {
            const rawSharedKey = deriveSharedKey(auth.serverPublicKey, _ctx.pendingKeyPair.secretKey);
            const encryptionKey = _ctx.pendingSalt
              ? deriveConnectionKey(rawSharedKey, _ctx.pendingSalt)
              : rawSharedKey;
            _ctx.encryptionState = { sharedKey: encryptionKey, sendNonce: 0, recvNonce: 0 };
            _ctx.pendingKeyPair = null;
            _ctx.pendingSalt = null;
            eagerEstablished = true;
            console.log('[crypto] E2E encryption established (eager)');
            // Burst un-gated: server already activated encryption after auth_ok.
            sendConnectListRequests();
            resetClientVisibleMemo();
            sendClientVisible(ctx.socket, isVisibleAppState(AppState.currentState));
          } catch (err) {
            // Malformed eager key — discard any partial state and fall through
            // to the discrete handshake below (regenerating the keypair if the
            // eager attempt consumed it).
            console.warn('[crypto] Eager key derivation failed, falling back to discrete key_exchange', err);
            _ctx.encryptionState = null;
          }
        }
        if (!eagerEstablished) {
          // Fallback (old server / no eager key / eager derivation failed): the
          // keypair is still stashed from onopen — send the discrete
          // key_exchange so the server replies key_exchange_ok. If onopen never
          // ran (defensive) or the eager attempt nulled it, regenerate so we
          // never send an empty handshake.
          if (!_ctx.pendingKeyPair) {
            _ctx.pendingKeyPair = createKeyPair();
            _ctx.pendingSalt = generateConnectionSalt();
          }
          // Send key_exchange plaintext (before encryption is active)
          ctx.socket.send(JSON.stringify({ type: 'key_exchange', publicKey: _ctx.pendingKeyPair.publicKey, salt: _ctx.pendingSalt }));
          // Post-auth messages will be sent after key_exchange_ok arrives
        }
      } else {
        // No encryption — send post-auth messages immediately
        sendConnectListRequests();
        useConnectionLifecycleStore.getState().setServerInfo({ isEncrypted: false });
        // #3404: server defaults visible=true on fresh connect; sync if we
        // reconnected while backgrounded so completion pushes still fire.
        resetClientVisibleMemo();
        sendClientVisible(ctx.socket, isVisibleAppState(AppState.currentState));
      }
      // Save for quick reconnect (use effectiveToken for pairing flow).
      // #5518: fold the just-completed handshake into the dual-endpoint record.
      // A successful auth against ctx.url with effectiveToken proves identity,
      // so if ctx.url is a ws:// LAN URL it becomes the *verified* LAN candidate
      // (the only kind we ever auto-prefer — see endpoint-selector.ts).
      // #5536: eagerPinToPersist carries a pin-on-first-use captured this
      // handshake (null on the discrete path / reconnect — that pin is written
      // in key_exchange_ok). Null leaves the existing record's pin intact.
      persistVerifiedConnection(ctx.url, effectiveToken, eagerPinToPersist);
      // Register push token (async, non-blocking)
      void registerPushToken(ctx.socket);
      break;
    }

    case 'key_exchange_ok': {
      // #5962 (#5721 parity) — defensive: auth_ok already cleared the handshake
      // timer (it precedes the discrete key-exchange round-trip), but clear again
      // so a future reordering that makes the encryption sub-handshake the real
      // completion point can't leave a timer to fire spuriously. Idempotent.
      clearHandshakeTimer();
      if (_ctx.pendingKeyPair) {
        const { publicKey: serverPublicKey, serverKeySig } = sharedKeyExchangeOk(msg);
        if (!serverPublicKey) {
          console.error('[crypto] Invalid publicKey in key_exchange_ok message', msg.publicKey);
          ctx.socket.close();
          set({ socket: null });
          useConnectionLifecycleStore.getState().setConnectionPhase('disconnected');
          _ctx.pendingKeyPair = null;
          _ctx.pendingSalt = null;
          break;
        }
        // #5536 — verify the server's signed exchange key against the pinned (or
        // pairing-time) identity BEFORE deriving the shared key. On a mismatch
        // this closes the socket + surfaces the refusal; abort the handshake.
        const verdict = verifyServerIdentityOrRefuse(ctx, serverPublicKey, serverKeySig);
        if (verdict.refused) {
          _ctx.pendingKeyPair = null;
          _ctx.pendingSalt = null;
          break;
        }
        const rawSharedKey = deriveSharedKey(serverPublicKey, _ctx.pendingKeyPair.secretKey);
        const encryptionKey = _ctx.pendingSalt
          ? deriveConnectionKey(rawSharedKey, _ctx.pendingSalt)
          : rawSharedKey;
        _ctx.encryptionState = { sharedKey: encryptionKey, sendNonce: 0, recvNonce: 0 };
        _ctx.pendingKeyPair = null;
        _ctx.pendingSalt = null;
        console.log('[crypto] E2E encryption established');
        // #5536 — persist a pin-on-first-use captured this discrete handshake.
        // The auth_ok handler already wrote the verified connection (unpinned on
        // this path); re-persist now to add the pin. Use the token the auth_ok
        // handler saved (the effectiveToken — a pairing-issued session token may
        // differ from the dial token), falling back to the dial ctx.token.
        if (verdict.pinToPersist) {
          const savedToken =
            useConnectionLifecycleStore.getState().savedConnection?.token ?? ctx.token;
          persistVerifiedConnection(ctx.url, savedToken, verdict.pinToPersist);
        }
        // Now send the post-auth messages that were deferred. #5555: skip the
        // 3 list requests when the server advertised the auth_bootstrap
        // capability (the burst frame already carries that data, queued behind
        // encryption and decrypted once this handshake completes).
        if (!_ctx.serverWillBootstrap) {
          wsSend(ctx.socket, { type: 'list_providers' });
          wsSend(ctx.socket, { type: 'list_slash_commands' });
          wsSend(ctx.socket, { type: 'list_agents' });
        }
        // #3404: sync visibility once encryption is established (mirrors the
        // unencrypted auth_ok path above).
        resetClientVisibleMemo();
        sendClientVisible(ctx.socket, isVisibleAppState(AppState.currentState));
      }
      break;
    }

    case 'auth_fail': {
      ctx.socket.close();
      set({ socket: null });
      useConnectionLifecycleStore.getState().setConnectionPhase('disconnected');
      // Surface the failure reason so the banner appears even on silent
      // (auto-)reconnect attempts where no Alert is shown (#2770).
      const { reason: authFailReason } = sharedAuthFail(msg);
      useConnectionLifecycleStore.getState().setConnectionError(`Auth failed: ${authFailReason}`, 0);
      if (!ctx.silent) {
        Alert.alert('Auth Failed', authFailReason);
      }
      break;
    }

    case 'pair_fail': {
      ctx.socket.close();
      set({ socket: null });
      useConnectionLifecycleStore.getState().setConnectionPhase('disconnected');
      if (!ctx.silent) {
        // Reason parse + friendly QR-flow copy shared via store-core (#5454).
        const { alertMessage } = sharedPairFail(msg, 'pairing_failed');
        Alert.alert('Pairing Failed', alertMessage);
      }
      break;
    }

    case 'server_mode': {
      // #4810: shared handler narrows `mode` to `'cli' | null` (the wire
      // protocol only ever emits `'cli'`; previously the handler also
      // accepted `'terminal'` but that branch was unreachable).
      const { mode } = sharedServerMode(msg);
      useConnectionLifecycleStore.getState().setServerInfo({ serverMode: mode });
      // Force chat view in CLI mode (no terminal available)
      if (mode === 'cli' && get().viewMode === 'terminal') {
        set({ viewMode: 'chat' });
      }
      break;
    }

    // --- Multi-session messages ---

    case 'session_list': {
      // #4767: centralised dispatch — store-core precomputes GC + new-session
      // ids + conversationId / cumulativeUsage / pendingShells patch maps;
      // the consumer applies them with platform-specific side-effects
      // (clearPersistedSession, loadLastConversationId auto-resume, etc.).
      const initialActiveId = get().activeSessionId;
      const patches = sharedBuildSessionListPatches(
        msg,
        Object.keys(get().sessionStates),
        initialActiveId,
      );
      if (!patches) break;
      const {
        sessionList,
        removedIds,
        newSessionIds,
        conversationIdPatches,
        cumulativeUsagePatches,
        backgroundShellBuilders,
        subscribeChunks,
      } = patches;
      // Auto-resume on server restart: if reconnecting and server has no sessions,
      // restore the last active conversation so user doesn't have to navigate History.
      if (sessionList.length === 0 && ctx.isReconnect) {
        void (async () => {
          const snapSocket = ctx.socket;
          const lastId = await loadLastConversationId();
          if (!lastId) return;
          if (snapSocket && snapSocket.readyState === WebSocket.OPEN) {
            console.log('[ws] Server restarted with no sessions — auto-resuming last conversation');
            wsSend(snapSocket, { type: 'resume_conversation', conversationId: lastId });
          }
        })();
        break;
      }
      // GC persisted messages for sessions that dropped out of the list
      for (const prevId of removedIds) {
        void clearPersistedSession(prevId);
      }
      // Batch in-memory cleanup into a single state update
      if (removedIds.length > 0) {
        const patch: Partial<ConnectionState> = {};
        const newStates = { ...get().sessionStates };
        for (const id of removedIds) {
          delete newStates[id];
        }
        patch.sessionStates = newStates;
        // If the active session was removed, switch to next available
        if (initialActiveId && removedIds.includes(initialActiveId)) {
          const remaining = Object.keys(newStates);
          const nextId = remaining.length > 0 ? remaining[0] : null;
          patch.activeSessionId = nextId;
        }
        set(patch);
      }
      set({ sessions: sessionList });
      // Initialize session state for any new sessions not yet tracked
      if (newSessionIds.length > 0) {
        const currentStates = get().sessionStates;
        const newStates = { ...currentStates };
        for (const sid of newSessionIds) {
          if (!newStates[sid]) {
            newStates[sid] = createEmptySessionState();
          }
        }
        set({ sessionStates: newStates });
      }
      // Sync conversationId from session list into session states
      for (const [sid, cid] of conversationIdPatches) {
        if (!get().sessionStates[sid]) continue;
        updateSession(sid, (ss) =>
          ss.conversationId !== cid ? { conversationId: cid } : {}
        );
      }
      // #4074: seed cumulativeUsage from the snapshot so re-opening the
      // mobile app mid-session shows the running cost in the header
      // without waiting for the next session_usage event. Same pattern
      // as the dashboard (#4073). Six-field equality short-circuit lives
      // in store-core via {@link sharedCumulativeUsageEquals} (#4767).
      for (const [sid, snapshot] of cumulativeUsagePatches) {
        if (!get().sessionStates[sid]) continue;
        updateSession(sid, (ss) =>
          sharedCumulativeUsageEquals(ss.cumulativeUsage, snapshot)
            ? {}
            : { cumulativeUsage: snapshot }
        );
      }
      // #4307: seed pendingBackgroundShells from the snapshot so the
      // app catches up on any sessions already waiting on background
      // work without waiting for the next `background_work_changed`
      // event. The shared handler's reference-equality short-circuit
      // suppresses no-op re-renders.
      for (const [sid, builder] of backgroundShellBuilders) {
        if (!get().sessionStates[sid]) continue;
        updateSession(sid, (ss) => {
          const next = builder.applyTo(ss.pendingBackgroundShells);
          return next === ss.pendingBackgroundShells
            ? {}
            : { pendingBackgroundShells: next };
        });
      }
      // Persist the active session's conversationId for auto-resume on server restart.
      // Use the activeSessionId if set, otherwise fall back to the first session in the list.
      const resolvedActiveId = get().activeSessionId ?? (sessionList[0]?.sessionId ?? null);
      const activeSessionEntry = resolvedActiveId
        ? sessionList.find((s) => s.sessionId === resolvedActiveId)
        : null;
      const activeConversationId = activeSessionEntry?.conversationId ?? null;
      if (activeConversationId) {
        void persistLastConversationId(activeConversationId);
      }
      // Subscribe to all non-active sessions so we receive their events
      // (permissions, plan approvals, errors) in real-time. Use the
      // precomputed chunks when the active id didn't change; otherwise
      // (active was removed and reassigned above) recompute against the
      // final active id via the shared chunk helper.
      const finalActiveId = get().activeSessionId;
      const effectiveChunks =
        finalActiveId === initialActiveId
          ? subscribeChunks
          : sharedChunkSubscribeSessionIds(sessionList, finalActiveId);
      if (effectiveChunks.length > 0) {
        const sock = get().socket;
        if (sock && sock.readyState === WebSocket.OPEN) {
          for (const chunk of effectiveChunks) {
            wsSend(sock, { type: 'subscribe_sessions', sessionIds: chunk });
          }
        }
      }
      break;
    }

    // session_updated — migrated to the shared dispatch table (#5556)


    case 'subscriptions_updated': {
      // Server confirms which sessions we're subscribed to — log for debugging
      const subIds = Array.isArray(msg.subscribedSessionIds) ? msg.subscribedSessionIds : [];
      if (__DEV__) {
        console.log('[ws] subscriptions_updated:', subIds.length, 'sessions');
      }
      break;
    }

    // session_context — migrated to the shared store-core dispatch table (#5618)

    case 'session_switched': {
      const switched = sharedSessionSwitched(msg);
      // Defensive: clear the pending hint regardless of validity (#3121).
      // A malformed `session_switched` arriving between a user-initiated
      // switch and the real follow-up could otherwise leave a stale
      // `pendingSwitchSessionId` and falsely flip the replay-dedup flag on
      // the next valid switch. Run the replay-dedup check before clearing.
      if (
        switched &&
        _ctx.pendingSwitchSessionId &&
        _ctx.pendingSwitchSessionId === switched.newSessionId
      ) {
        _ctx.isSessionSwitchReplay = true;
      }
      _ctx.pendingSwitchSessionId = null;
      if (!switched) break;
      const { newSessionId: sessionId, conversationId: switchConvId } = switched;
      set((state: ConnectionState) => {
        // Initialize session state if it doesn't exist
        const sessionStates = { ...state.sessionStates };
        if (!sessionStates[sessionId]) {
          sessionStates[sessionId] = createEmptySessionState();
        }
        // Update conversationId if provided
        if (switchConvId) {
          sessionStates[sessionId] = { ...sessionStates[sessionId], conversationId: switchConvId };
        }
        return {
          activeSessionId: sessionId,
          sessionStates,
        };
      });
      // Refresh slash commands (project commands may differ per session cwd)
      get().fetchSlashCommands();
      // Refresh agents (project agents may differ per session cwd)
      get().fetchCustomAgents();
      break;
    }

    // conversation_id — migrated to the shared dispatch table (#5556)


    case 'session_error': {
      // Crash branch: flip session health + notify; non-crash branch: special-
      // case SESSION_TOKEN_MISMATCH with the platform-native disconnect flow,
      // otherwise show a generic Alert. Parser is shared via store-core; the
      // shared `message` field uses the dashboard's wording, but the app's
      // disconnect modal phrases the bound-session hint slightly differently
      // (mentions "from the desktop") — keep that wording at the call site.
      const parsed = sharedSessionError(msg, get().activeSessionId);
      if (parsed.category === 'crash' && parsed.sessionPatch) {
        const crashedId = parsed.sessionPatch.sessionId;
        if (crashedId && get().sessionStates[crashedId]) {
          updateSession(crashedId, () => ({ health: 'crashed' as const }));
          pushSessionNotification(crashedId, 'error', 'Session crashed');
        }
      } else if (parsed.category === 'input_conflict') {
        // #5281 ①.3 / #5589 — an expected "can't send / can't claim right now"
        // event, NOT a failure: either another device's request is mid-flight,
        // this session is still evaluating a previous draft, or a `claim_primary`
        // was rejected because another device holds it (code PRIMARY_HELD). The
        // generic Alert below would be the wrong register (loud modal). Instead:
        // drop the stranded optimistic user message (its send was rejected) +
        // its thinking spinner, and append a calm inline system notice.
        const conflictSessionId =
          typeof msg.sessionId === 'string' ? msg.sessionId : get().activeSessionId;
        const rejectedId =
          typeof msg.clientMessageId === 'string' && msg.clientMessageId.length > 0
            ? msg.clientMessageId
            : null;
        const noticeText =
          parsed.message ||
          'Your message wasn’t sent — the session is busy. Wait for it to finish, or interrupt the current run.';
        const noticeMsg: ChatMessage = {
          id: nextMessageId('input-conflict'),
          type: 'system',
          content: noticeText,
          timestamp: Date.now(),
        };
        const dropGhost = (messages: ChatMessage[]) =>
          filterThinking(messages).filter(
            (m) => !(rejectedId && m.id === rejectedId && m.type === 'user_input'),
          );
        if (conflictSessionId && get().sessionStates[conflictSessionId]) {
          updateSession(conflictSessionId, (ss) => ({
            messages: [...dropGhost(ss.messages), noticeMsg],
            streamingMessageId:
              ss.streamingMessageId === 'pending' ? null : ss.streamingMessageId,
          }));
        } else {
          get().addMessage(noticeMsg);
        }
      } else if (parsed.category !== 'crash') {
        if (parsed.code === 'SESSION_TOKEN_MISMATCH' && parsed.boundSessionName) {
          showBoundSessionMismatchAlert(
            `This device is paired to session "${parsed.boundSessionName}" and can only talk to that session. To create or open other sessions, disconnect and scan a fresh QR code from the desktop.`,
          );
        } else {
          Alert.alert('Session Error', parsed.message ?? 'Unknown error');
        }
      }
      break;
    }

    case 'session_stopped': {
      // #4879: quiet, informational confirmation when CliSession exits
      // cleanly after a user-initiated Stop. The wire path was wired in
      // #4868 (CliSession 'stopped' → SessionManager → ws-forwarding →
      // ServerSessionStoppedSchema). Distinct from `session_error` (which
      // flips `health: 'crashed'` and surfaces a loud red banner): the
      // operator tapped Stop, the child process did indeed stop.
      //
      // Sets `stoppedAt` + `stoppedCode` on the target session — the
      // SessionScreen reads those fields to render a subtle, info-styled
      // status strip ("Session stopped." / "Session stopped. (exit N)").
      // Both fields are cleared automatically by `handleClaudeReady`
      // (which returns `stoppedAt: null, stoppedCode: null`) when the
      // server restarts the child after the operator's next input.
      //
      // NO Alert / push notification — this is intentionally NOT an
      // error UX. The active session's inline banner carries the full
      // signal; for inactive sessions the absence of a session_error
      // already conveys "no crash, clean stop" and adding a notification
      // here would just be noise.
      const stoppedPatch = sharedSessionStopped(msg, get().activeSessionId);
      const stoppedTarget = stoppedPatch.sessionId;
      if (stoppedTarget && get().sessionStates[stoppedTarget]) {
        updateSession(stoppedTarget, () => stoppedPatch.patch);
      }
      break;
    }

    // --- History replay ---

    case 'history_replay_start': {
      // Parser is shared via store-core; flag mutation stays at this call
      // site (module-level _ctx state, not store state).
      const { fullHistory, sessionId: replayTargetId, latestSeq } = sharedHistoryReplayStart(
        msg,
        get().activeSessionId,
      );
      // #4512 — track per-session. Falls back to activeSessionId via
      // sharedHistoryReplayStart, matching the gate's targetId resolution.
      if (replayTargetId) _ctx.replayingSessions.add(replayTargetId);
      // #5555.4 — DO NOT wipe messages here. Full rebuild keeps the existing
      // messages visible and records a baseline; the authoritative replayed set
      // is appended and swapped in atomically at history_replay_end (no blank
      // flash). Delta replay (cursor honoured) is purely append-only.
      // `isSessionSwitchReplay` still gates the same UX paths as before.
      if (fullHistory) {
        _ctx.isSessionSwitchReplay = true;
      }
      {
        const curLen =
          (replayTargetId && get().sessionStates[replayTargetId]?.messages.length) || 0;
        reconcileReplayStart(replayTargetId, fullHistory, curLen, latestSeq);
      }
      // Clear transient state — these events are not replayed from history,
      // so any surviving entries are stale from pre-disconnect
      updateActiveSession((ss) => {
        const patch: Partial<SessionState> = {};
        if (ss.activeAgents.length > 0) patch.activeAgents = [];
        if (ss.isPlanPending) {
          patch.isPlanPending = false;
          patch.planAllowedPrompts = [];
        }
        return Object.keys(patch).length > 0 ? patch : {};
      });
      // #4909 — `session_stopped` is a transient event NOT recorded into
      // per-session history (#4868 wire path), so it isn't replayed on
      // reconnect. But the client-side `stoppedAt`/`stoppedCode` derived
      // state survives the WebSocket teardown in Zustand store memory and
      // the strip flashes back into view until activity resumes. Clear
      // it on history replay (the canonical "reconnect handshake" event)
      // for the same reason the transient `activeAgents`/`isPlanPending`
      // are cleared above. Targets `replayTargetId` (per-session) rather
      // than activeSessionId so a background session reconnecting also
      // sheds its stale marker.
      if (replayTargetId && get().sessionStates[replayTargetId]) {
        updateSession(replayTargetId, (ss) => {
          if (ss.stoppedAt == null && ss.stoppedCode == null) return {};
          return { stoppedAt: null, stoppedCode: null };
        });
      }
      break;
    }

    case 'history_replay_end':
      // Parser is shared via store-core; flag mutation stays here.
      // #4512 — remove this session id from the replaying set. Falls back
      // to activeSessionId to mirror sharedHistoryReplayStart's resolution.
      sharedHistoryReplayEnd();
      {
        const endTargetId =
          (typeof msg.sessionId === 'string' && msg.sessionId) || get().activeSessionId;
        if (endTargetId) _ctx.replayingSessions.delete(endTargetId);
        // #5555.4 — atomic swap for a full rebuild: replace messages with the
        // appended replayed tail in ONE update (no blank flash). reconcileReplayEnd
        // also advances the cursor from `latestSeq`; returns null for delta replay.
        const endLatestSeq =
          typeof msg.latestSeq === 'number' && Number.isFinite(msg.latestSeq)
            ? msg.latestSeq
            : undefined;
        if (endTargetId && get().sessionStates[endTargetId]) {
          const { swappedMessages } = reconcileReplayEnd(
            endTargetId,
            get().sessionStates[endTargetId]!.messages,
            endLatestSeq,
          );
          if (swappedMessages) {
            updateSession(endTargetId, () => ({
              messages: swappedMessages as SessionState['messages'],
            }));
          }
        } else {
          reconcileReplayEnd(endTargetId, [], endLatestSeq);
        }
      }
      _ctx.isSessionSwitchReplay = false;
      // Mark all replayed prompts as answered — any prompt in history
      // has already been resolved by the server.
      updateActiveSession((ss) => {
        const hasUnansweredPrompts = ss.messages.some(
          (m) => m.type === 'prompt' && !m.answered
        );
        if (!hasUnansweredPrompts) return {};
        return {
          messages: ss.messages.map((m) =>
            m.type === 'prompt' && !m.answered
              ? { ...m, answered: '(resolved)' }
              : m
          ),
        };
      });
      break;

    // --- User input echoed from other clients ---

    case 'user_input': {
      const userInput = sharedUserInput(msg, get().myClientId, get().activeSessionId);
      if (!userInput) break;
      updateSession(userInput.sessionId, (ss) => ({
        messages: [...ss.messages, userInput.chatMessage],
      }));
      break;
    }

    // --- Existing message handlers (now session-aware) ---

    case 'message': {
      // Use the shared resolver so trim / empty-string normalization stays
      // consistent with sharedMessageHandler and the rest of store-core.
      const targetId = resolveSessionId(msg, get().activeSessionId);
      // #5555.4 — during a full rebuild, dedup only against the appended replay
      // tail so a replayed entry isn't suppressed by an id in the discarded
      // prefix and lost in the swap. Delta replay / no rebuild → whole array.
      const cached = replayDedupCache(targetId, getSessionMessages(targetId));
      // #4512 — dedup against history only when THIS message's session is
      // currently replaying. A per-connection boolean would suppress live
      // messages for session B while A replays.
      const messageIsReplay = targetId ? _ctx.replayingSessions.has(targetId) : false;
      // #5555.3 — advance the cursor for replayed entries.
      if (messageIsReplay) recordHistorySeq(targetId, (msg as { historySeq?: unknown }).historySeq);
      const result = sharedMessageHandler(msg, get().activeSessionId, messageIsReplay, cached);
      if (!result.shouldDispatch) break;
      const newMsg = result.chatMessage;
      const effectiveId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
      if (effectiveId && get().sessionStates[effectiveId]) {
        updateSession(effectiveId, (ss) => ({
          messages: [
            ...ss.messages.filter((m) => m.id !== 'thinking' || newMsg.id === 'thinking'),
            newMsg,
          ],
        }));
      }
      // Surface rate limit / usage limit errors prominently (#616)
      if (result.isRateLimitError && result.errorContent) {
        Alert.alert('Usage Limit', result.errorContent);
      }
      break;
    }

    case 'stream_start': {
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, (ss) => {
          const out = sharedStreamStart(msg, get().activeSessionId, ss.messages);
          if (out.remap) {
            _ctx.deltaIdRemaps.set(out.remap.from, out.remap.to);
          }
          if (!out.isNewMessage) {
            // Reuse existing response message (reconnect replay dedup)
            return { streamingMessageId: out.streamingMessageId };
          }
          return {
            streamingMessageId: out.streamingMessageId,
            messages: [...filterThinking(ss.messages), out.newMessage!],
          };
        });
      }
      break;
    }

    case 'stream_delta': {
      // #5515 (epic #5514): record the server-stamped serverTs and the local
      // recv time of the OLDEST un-rendered delta for this messageId, so
      // flushPendingDeltas can measure token-to-render. First-write-wins until
      // the next flush clears it (mirrors the server's per-flush emit stamp).
      if (typeof msg.messageId === 'string') {
        const sTs = typeof msg.serverTs === 'number' ? msg.serverTs : null;
        if (sTs !== null && !_ctx.deltaServerTs.has(msg.messageId)) {
          _ctx.deltaServerTs.set(msg.messageId, { serverTs: sTs, recvAt: Date.now() });
        }
      }
      // #4981 — thin wrapper over `sharedStreamDelta`. The platform-neutral
      // hot path (post-permission split, single-hop defensive remap, post-tool
      // continuation split with the #4999/#5014 sentence gate and #4975
      // mid-word peel, buffered append + 100ms flush) lives in store-core.
      // The app has no terminal-data write, no #4297 reorder, and no flat-
      // `messages` fallback (it only operates on `sessionStates`), so those
      // context hooks are no-ops / session-only here.
      sharedStreamDelta(msg, {
        activeSessionId: get().activeSessionId,
        pendingDeltas: _ctx.deltaFlusher.pendingDeltas,
        deltaIdRemaps: _ctx.deltaIdRemaps,
        postPermissionSplits: _ctx.postPermissionSplits,
        replayingSessions: _ctx.replayingSessions,

        getSessionMessages: (sessionId) =>
          sessionId && get().sessionStates[sessionId]
            ? get().sessionStates[sessionId].messages
            : null,
        // The app has no flat-messages fallback in this handler; an empty
        // array keeps the shared fn's flat branches inert.
        getFlatMessages: () => [],

        // No terminal view on the app side.
        appendTerminalDelta: () => {},
        // The app never reordered the empty response slot (#4297 is dashboard-
        // only) — no-op.
        reorderEmptyResponseSlot: () => {},

        // Append a fresh response slot + set streamingMessageId. Resolve the
        // effective session the way the app originally did: prefer the passed
        // target when it has state, else fall back to the active session
        // (matches the permission-split `effectiveSplitId` / defensive-suffix
        // `effectiveDeltaId` resolution). Only writes when a session-backed
        // target exists — the app has no flat fallback.
        appendResponseSlot: (targetSessionId, slot, opts) => {
          const eff = (targetSessionId && get().sessionStates[targetSessionId])
            ? targetSessionId
            : get().activeSessionId;
          if (!eff || !get().sessionStates[eff]) return;
          if (opts?.onlyIfAbsent
              && get().sessionStates[eff].messages.some((m) => m.id === slot.id)) {
            return;
          }
          updateSession(eff, (ss) => ({
            streamingMessageId: slot.id,
            messages: [...ss.messages, slot],
          }));
        },

        // Peel `count` trailing chars off the flushed content of the response
        // slot at `deltaId`. Session-only (the cont-split only fires for the
        // app when session state backs the resolved messages).
        peelSlotContent: (targetSessionId, deltaId, count) => {
          if (!targetSessionId || !get().sessionStates[targetSessionId]) return;
          updateSession(targetSessionId, (ss) => ({
            messages: ss.messages.map((m) =>
              m.id === deltaId && m.type === 'response'
                ? { ...m, content: m.content.slice(0, m.content.length - count) }
                : m
            ),
          }));
        },

        // #5556 — arm the shared coalescing window (adaptive interval; was a
        // fixed 100ms). Memoized bubbles (step 1) make the tighter flush cheap:
        // only the tail re-renders. First-arm-wins inside the flusher.
        scheduleFlush: () => {
          _ctx.deltaFlusher.schedule();
        },
      });
      break;
    }

    case 'stream_end':
      // Flush any buffered deltas immediately before clearing streaming state
      _ctx.deltaFlusher.flushNow();
      {
        const out = sharedStreamEnd(msg, get().activeSessionId);
        // Clean up permission boundary split tracking. messageId is null for
        // malformed payloads (non-string msg.messageId) — skip cleanup then.
        if (out.messageId !== null) {
          _ctx.postPermissionSplits.delete(out.messageId);
          _ctx.deltaIdRemaps.delete(out.messageId);
        }
        const targetId = out.sessionId;
        if (targetId && get().sessionStates[targetId]) {
          // Force a new messages array reference so selectors detect the change,
          // even when flushPendingDeltas() was a no-op (timer already flushed).
          updateSession(targetId, (ss) => ({
            streamingMessageId: null,
            messages: [...ss.messages],
          }));
        } else {
          updateActiveSession((ss) => ({ streamingMessageId: null, messages: [...ss.messages] }));
        }
      }
      break;

    case 'tool_start': {
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      // #5555.4 — scope dedup to the appended replay tail during a full rebuild
      // (see the `message` case for rationale).
      const cached = replayDedupCache(targetId, getSessionMessages(targetId));
      // #4512 — dedup against the cached history only when THIS message's
      // session is currently replaying. A per-connection boolean would
      // wrongly suppress live tool_start broadcasts for session B while A
      // is replaying.
      const toolStartIsReplay = targetId ? _ctx.replayingSessions.has(targetId) : false;
      // #5555.3 — advance the cursor for replayed tool_start entries.
      if (toolStartIsReplay) recordHistorySeq(targetId, (msg as { historySeq?: unknown }).historySeq);
      const result = sharedToolStart(
        msg,
        get().activeSessionId,
        toolStartIsReplay,
        cached,
      );
      if (!result.shouldDispatch || !result.chatMessage) break;
      const toolMsg = result.chatMessage;
      const effectiveId = (result.sessionId && get().sessionStates[result.sessionId])
        ? result.sessionId
        : get().activeSessionId;
      if (effectiveId && get().sessionStates[effectiveId]) {
        updateSession(effectiveId, (ss) => {
          const patch: Partial<SessionState> = {
            messages: [...ss.messages, toolMsg],
          };
          // If the turn opened with a tool (no preamble text → no stream_start),
          // streamingMessageId is still 'pending' from sendInput. The 5-second
          // safety timer in sendInput would clear it, hiding the stop button
          // for the rest of the tool execution. Bump it to the tool bubble's
          // id (already normalized by sharedToolStart — falls back to a
          // synthesized id when msg.messageId is missing) so the timer
          // no-ops; the next stream_start will overwrite with the response id.
          if (ss.streamingMessageId === 'pending') {
            patch.streamingMessageId = toolMsg.id;
          }
          return patch;
        });
      }
      break;
    }

    case 'tool_input_delta': {
      // #4081: accumulate the partialJson chunk onto the matching
      // tool_use bubble's `toolInputPartial`. sharedToolInputDelta
      // validates the wire payload, resolves sessionId, and returns an
      // applyTo that no-ops when the tool_use can't be found (mirrors
      // tool_result below). Permission-pending suppression lives on the
      // server (#4080) — by the time a delta reaches the client the
      // bubble is the live target.
      const result = sharedToolInputDelta(msg, get().activeSessionId);
      if (!result) break;
      const effectiveId = (result.sessionId && get().sessionStates[result.sessionId])
        ? result.sessionId
        : get().activeSessionId;
      if (effectiveId && get().sessionStates[effectiveId]) {
        updateSession(effectiveId, (ss: SessionState) => {
          const updated = result.applyTo(ss.messages);
          if (updated === ss.messages) return {};
          return { messages: updated };
        });
      }
      break;
    }

    case 'tool_result': {
      const result = sharedToolResult(msg, get().activeSessionId);
      if (!result) break;
      const effectiveId = (result.sessionId && get().sessionStates[result.sessionId])
        ? result.sessionId
        : get().activeSessionId;
      if (effectiveId && get().sessionStates[effectiveId]) {
        updateSession(effectiveId, (ss: SessionState) => {
          const updated = result.applyTo(ss.messages);
          if (updated === ss.messages) return {};
          return { messages: updated };
        });
      }
      break;
    }

    case 'result': {
      hapticSuccess();
      // Flush any buffered deltas before clearing streaming state
      _ctx.deltaFlusher.flushNow();
      // Clean up permission boundary split tracking
      _ctx.postPermissionSplits.clear();
      _ctx.deltaIdRemaps.clear();
      const normalized = sharedResultUsage(msg, get().activeSessionId);
      const resultPatch = {
        streamingMessageId: null as string | null,
        contextUsage: normalized.contextUsage,
        lastResultCost: normalized.lastResultCost,
        lastResultDuration: normalized.lastResultDuration,
      };
      const targetId = normalized.sessionId;
      // Notify if a background session just finished (was streaming)
      if (targetId && get().sessionStates[targetId]?.streamingMessageId) {
        pushSessionNotification(targetId, 'completed', 'Task completed');
      }
      {
        const effectiveId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
        if (effectiveId && get().sessionStates[effectiveId]) {
          // Force a new messages array reference so selectors detect the change,
          // even when flushPendingDeltas() was a no-op (timer already flushed).
          updateSession(effectiveId, (ss) => ({
            ...resultPatch,
            messages: [...ss.messages],
          }));
        }
      }
      break;
    }

    case 'model_changed': {
      const { model } = sharedModelChanged(msg);
      const targetId = resolveSessionId(msg, get().activeSessionId);
      {
        const effectiveId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
        if (effectiveId && get().sessionStates[effectiveId]) {
          updateSession(effectiveId, () => ({ activeModel: model }));
        }
      }
      break;
    }

    case 'available_models': {
      if (Array.isArray(msg.models)) {
        const { models, defaultModelId } = sharedAvailableModels(msg);
        set({ availableModels: models, defaultModelId });
      }
      break;
    }

    case 'permission_mode_changed': {
      const { mode } = sharedPermissionModeChanged(msg);
      const targetId = resolveSessionId(msg, get().activeSessionId);
      {
        const effectiveId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
        if (effectiveId && get().sessionStates[effectiveId]) {
          updateSession(effectiveId, () => ({ permissionMode: mode }));
        }
        // Server doesn't echo back the originating requestId on
        // permission_mode_changed broadcasts (multi-client safe), so clear any
        // pending tracker entries for the message's resolved target. Use
        // `targetId` (the session the broadcast is *for*) rather than
        // `effectiveId`, which can fall back to `activeSessionId` and would
        // wrongly clear pending entries on a different session if the broadcast
        // arrived for a session that isn't currently in `sessionStates`.
        if (targetId) {
          clearPendingPermissionModeRequestsForSession(targetId);
        }
      }
      // Clear pending confirm if mode change arrived (confirmation was accepted)
      set({ pendingPermissionConfirm: null });
      break;
    }

    // confirm_permission_mode — migrated to the shared dispatch table (#5556)


    // available_permission_modes — migrated to the shared dispatch table (#5556)


    case 'raw': {
      const { data: rawData } = sharedRawOutput(msg);
      get().appendTerminalData(rawData);
      useTerminalStore.getState().appendTerminalData(rawData);
      break;
    }

    // #5835 / #5987 — live PTY mirror channel. Unlike legacy 'raw' (claude-tui's
    // headless output), terminal_output is the opt-in mirror stream for a
    // user-shell ($SHELL) session subscribed via terminal_subscribe. Render it
    // through the exact same write-callback → xterm path as 'raw' so user-shell
    // output appears in TerminalView with no TerminalView changes. Read-only in
    // PR1; interactive stdin (terminal_input) is deferred — see #6003.
    case 'terminal_output': {
      const data = msg.data;
      if (typeof data !== 'string') break;
      // Guard on the active session id (mirrors the dashboard handler): between
      // an unsubscribe(old) and subscribe(new) during a session switch, a stale
      // frame for the old session can still arrive — without this guard it would
      // bleed into the new session's terminal (mobile renders one global
      // terminalRawBuffer, so a mis-targeted frame paints the wrong shell).
      if (typeof msg.sessionId !== 'string' || msg.sessionId !== get().activeSessionId) break;
      get().appendTerminalData(data);
      useTerminalStore.getState().appendTerminalData(data);
      break;
    }

    case 'claude_ready': {
      const patch = sharedClaudeReady();
      const targetId = resolveSessionId(msg, get().activeSessionId);
      {
        const effectiveId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
        if (effectiveId && get().sessionStates[effectiveId]) {
          updateSession(effectiveId, () => patch);
        }
      }
      // Drain queued messages on reconnect
      const readySocket = get().socket;
      if (readySocket && readySocket.readyState === WebSocket.OPEN) {
        drainMessageQueue(readySocket);
      }
      break;
    }

    case 'agent_idle': {
      const targetId = resolveSessionId(msg, get().activeSessionId);
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, () => sharedAgentIdle());
      }
      break;
    }

    // agent_busy — migrated to the shared dispatch table (#5556)


    // agent_spawned / agent_completed / agent_event / background_work_changed /
    // plan_started — migrated to the shared dispatch table (#5556 slice 2)

    case 'plan_ready': {
      const planReady = sharedPlanReady(msg, get().activeSessionId);
      if (planReady.sessionId && get().sessionStates[planReady.sessionId]) {
        updateSession(planReady.sessionId, () => planReady.patch);
      }
      // Platform-specific UX: app surfaces a session notification on
      // plan-ready (the dashboard has no equivalent surface). Kept at the
      // call site so the shared handler stays free of platform concerns.
      if (planReady.sessionId) {
        pushSessionNotification(planReady.sessionId, 'plan', 'Plan ready for approval');
      }
      break;
    }

    // inactivity_warning — migrated to the shared dispatch table (#5556 slice 2)

    case 'multi_question_intervention': {
      // #4764 — chroxy's permission-hook (#4648) just denied a multi-question
      // AskUserQuestion. Mirrors the dashboard's #4758 handler: append a
      // SessionIntervention entry so the session-header counter ticks, and on
      // the FIRST such intervention per session push a one-time system
      // ChatMessage explaining what happened (without it the deny is invisible
      // on the chat surface).
      //
      // applyInterventionBuilder dedups by toolUseId (a stuck model re-emitting
      // the same payload won't double-count) and tells us whether this was the
      // session's first intervention so the inline notice only fires once.
      const builder = sharedMultiQuestionIntervention(msg, get().activeSessionId);
      if (!builder) break;
      const interventionTargetId = builder.sessionId;
      if (!interventionTargetId) break;
      const targetState = get().sessionStates[interventionTargetId];
      if (!targetState) break;
      const { interventions: nextInterventions, isFirst } = applyInterventionBuilder(
        builder,
        targetState.interventions,
      );
      // Skip the state mutation if nothing changed (dedup'd repeat) so React
      // doesn't re-render the header counter on every stuck-model re-emit.
      if (nextInterventions === targetState.interventions) break;
      updateSession(interventionTargetId, (ss) => {
        if (isFirst) {
          return {
            interventions: nextInterventions,
            messages: [
              ...ss.messages,
              {
                id: nextMessageId('system'),
                type: 'system',
                content:
                  "chroxy intercepted a multi-question form and asked the agent to break it into single questions.",
                timestamp: Date.now(),
              },
            ],
          };
        }
        return { interventions: nextInterventions };
      });
      break;
    }

    case 'raw_background': {
      const { data: rawBgData } = sharedRawOutput(msg);
      get().appendTerminalData(rawBgData);
      useTerminalStore.getState().appendTerminalData(rawBgData);
      break;
    }

    case 'permission_request': {
      const permPayload = sharedPermissionRequest(msg);
      // Skip malformed messages with missing/non-string requestId — without
      // this, we'd insert a prompt with `requestId === null` (the handler
      // contract) and the cast on the next line would mask the issue.
      if (!permPayload.requestId) break;
      // Split streaming response at permission boundary (#554). The pure
      // split/remap-resolution core is shared via store-core (#5454); the
      // side effects below keep their original order.
      {
        const permTargetId = permPayload.sessionId || get().activeSessionId;
        const permSs = permTargetId ? get().sessionStates[permTargetId] : null;
        const currentStreamId = permSs ? permSs.streamingMessageId : null;
        const split = resolvePermissionStreamSplit(currentStreamId, _ctx.deltaIdRemaps);
        if (split) {
          _ctx.deltaFlusher.flushNow();
          _ctx.postPermissionSplits.add(split.serverStreamId);
          const clearTarget = permTargetId || get().activeSessionId;
          if (clearTarget && get().sessionStates[clearTarget]) {
            updateSession(clearTarget, () => ({ streamingMessageId: null }));
          }
        }
      }
      const permRequestId = permPayload.requestId;
      // #3072: only expose "Allow for Session" when the active session's
      // provider supports session-scoped permission rules. Without this gate,
      // tapping the option on codex/gemini/claude-cli sessions hits a server
      // "not supported" error.
      const permTargetId = permPayload.sessionId || get().activeSessionId;
      // #5693 containment: a permission MAPPED to a session must surface in THAT
      // session's transcript, never whatever tab is focused. If the owning
      // session isn't loaded on this client yet, create its empty state — which
      // is tab-invisible (tabs come from `sessions`, not `sessionStates`) — so
      // the prompt routes home instead of being dropped or injected into the
      // active session. Unmapped prompts (no wire sessionId) intentionally stay
      // in the active session (still answerable, not mislabeled — originSessionId
      // stays undefined).
      const ownerSessionId = permPayload.sessionId;
      if (ownerSessionId && !get().sessionStates[ownerSessionId]) {
        set((state) => ({
          sessionStates: { ...state.sessionStates, [ownerSessionId]: createEmptySessionState() },
        }));
      }
      const permSession = permTargetId
        ? get().sessions.find((s) => s.sessionId === permTargetId)
        : null;
      const permProvider = permSession?.provider ?? null;
      const providerSupportsRules =
        !!permProvider &&
        get().availableProviders.find((p) => p.name === permProvider)?.capabilities?.sessionRules === true;
      const newOptions = [
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' },
        ...(providerSupportsRules ? [{ label: 'Allow for Session', value: 'allowSession' }] : []),
      ];
      const newExpiresAt = permPayload.remainingMs !== null ? Date.now() + permPayload.remainingMs : undefined;

      const targetMessages = getSessionMessages(permTargetId);
      const existingIdx = targetMessages.findIndex(
        (m) => m.requestId === permRequestId && m.type === 'prompt'
      );

      if (existingIdx !== -1) {
        const updater = (ss: { messages: ChatMessage[] }) => ({
          messages: ss.messages.map((m) =>
            m.requestId === permRequestId && m.type === 'prompt'
              ? { ...m, answered: undefined, options: newOptions, expiresAt: newExpiresAt }
              : m
          ),
        });
        {
          const effectiveId = (permTargetId && get().sessionStates[permTargetId]) ? permTargetId : get().activeSessionId;
          if (effectiveId && get().sessionStates[effectiveId]) {
            updateSession(effectiveId, updater);
          }
        }
      } else {
        const permMsg: ChatMessage = {
          id: nextMessageId('perm'),
          type: 'prompt',
          // Render only the tool name when description is missing; otherwise
          // combine `"<tool>: <description>"`. Falls back to a generic label
          // when neither is available. Fixes the "Tool: undefined" string
          // that the prior `${tool}: ${description}` template produced (#3122).
          content: permPayload.tool
            ? (permPayload.description
                ? `${permPayload.tool}: ${permPayload.description}`
                : permPayload.tool)
            : (permPayload.description || 'Permission required'),
          tool: permPayload.tool ?? undefined,
          requestId: permRequestId,
          toolInput: permPayload.input ?? undefined,
          options: newOptions,
          expiresAt: newExpiresAt,
          timestamp: Date.now(),
          // #5667 — record the OWNING session (the wire sessionId) so the
          // prompt can be labelled. Not `permTargetId`: that falls back to the
          // active session for unmapped/legacy requests and would mislabel them.
          // Undefined when the request maps to no session.
          originSessionId: permPayload.sessionId ?? undefined,
        };
        {
          const effectiveId = (permTargetId && get().sessionStates[permTargetId]) ? permTargetId : get().activeSessionId;
          if (effectiveId && get().sessionStates[effectiveId]) {
            updateSession(effectiveId, (ss) => ({
              messages: [...ss.messages, permMsg],
            }));
          }
        }
      }
      if (permTargetId) {
        const toolName = permPayload.tool ?? undefined;
        const toolDesc = toolName ?? 'Permission needed';
        const toolDescription = permPayload.description ?? undefined;
        const inputPreview = permPayload.input
          ? truncateInput(permPayload.input)
          : undefined;
        pushSessionNotification(permTargetId, 'permission', toolDesc, permRequestId, {
          tool: toolName,
          description: toolDescription,
          inputPreview,
        });
      }
      break;
    }

    case 'permission_resolved': {
      // Another client resolved this permission — dismiss the prompt on this client.
      // The permission_request may have been stored in ANY session state (whichever tab
      // was active when it arrived), so search all session states for the matching requestId.
      const { requestId: resolvedRequestId, decision: resolvedDecision } =
        sharedPermissionResolved(msg);
      if (resolvedRequestId) {
        const updater = (ss: { messages: ChatMessage[] }) => ({
          messages: ss.messages.map((m) =>
            m.requestId === resolvedRequestId && m.type === 'prompt'
              ? { ...m, answered: resolvedDecision ?? undefined, answeredAt: Date.now(), options: undefined }
              : m
          ),
        });
        // Search all session states for the permission prompt
        const states = get().sessionStates;
        for (const sid of Object.keys(states)) {
          if (states[sid]?.messages.some((m) => m.requestId === resolvedRequestId)) {
            updateSession(sid, updater);
            break;
          }
        }
        // Auto-dismiss matching notification banner
        set((s) => ({
          sessionNotifications: (s.sessionNotifications ?? []).filter(
            (n) => n.requestId !== resolvedRequestId
          ),
        }));
      }
      break;
    }

    case 'permission_expired': {
      const { requestId: expiredRequestId, systemMessage: expiredSystemMsg } =
        sharedPermissionExpired(msg);
      if (expiredRequestId) {
        console.warn(`[ws] Permission ${expiredRequestId} expired: ${msg.message}`);
        const expTargetId = (msg.sessionId as string) || get().activeSessionId;
        if (expTargetId && get().sessionStates[expTargetId]) {
          updateSession(expTargetId, (ss) => ({
            messages: ss.messages.map((m) =>
              m.requestId === expiredRequestId && m.type === 'prompt'
                ? { ...m, content: `${m.content}\n${expiredSystemMsg.content}`, options: undefined }
                : m
            ),
          }));
        }
        // Auto-dismiss matching notification banner
        set((s) => ({
          sessionNotifications: (s.sessionNotifications ?? []).filter(
            (n) => n.requestId !== expiredRequestId
          ),
        }));
      }
      break;
    }

    case 'permission_timeout': {
      const { requestId: timeoutRequestId, systemMessage: timeoutSystemMsg } =
        sharedPermissionTimeout(msg);
      // Mark matching prompt as timed-out — scan all session states (the prompt may have
      // been stored in any session, mirroring the permission_resolved all-sessions search)
      if (timeoutRequestId) {
        const timeoutUpdater = (ss: { messages: ChatMessage[] }) => ({
          messages: ss.messages.map((m) =>
            m.requestId === timeoutRequestId && m.type === 'prompt'
              ? { ...m, content: `${m.content}\n(Auto-denied — permission timed out)`, options: undefined }
              : m
          ),
        });
        const allStates = get().sessionStates;
        for (const sid of Object.keys(allStates)) {
          if (allStates[sid]?.messages.some((m) => m.requestId === timeoutRequestId)) {
            updateSession(sid, timeoutUpdater);
            break;
          }
        }
        // Auto-dismiss matching notification banner from both stores
        set((s) => ({
          sessionNotifications: (s.sessionNotifications ?? []).filter(
            (n) => n.requestId !== timeoutRequestId
          ),
        }));
        const notifState = useNotificationStore.getState();
        notifState.sessionNotifications
          .filter((n) => n.requestId === timeoutRequestId)
          .forEach((n) => notifState.dismissSessionNotification(n.id));
      }
      // Show a dismissible server error banner so users know the permission was auto-denied
      // (system message text comes from the shared handler so wording stays in sync)
      const timeoutError: ServerError = {
        id: nextMessageId('permission_timeout'),
        category: 'permission',
        message: timeoutSystemMsg.content,
        recoverable: true,
        timestamp: Date.now(),
      };
      set((state: ConnectionState) => ({
        serverErrors: [...state.serverErrors, timeoutError].slice(-10),
      }));
      useNotificationStore.getState().addServerError(timeoutError);
      break;
    }

    // permission_rules_updated — migrated to the shared dispatch table (#5556)


    case 'user_question': {
      const parsed = sharedUserQuestion(msg, get().activeSessionId);
      if (!parsed) break;
      const { sessionId: questionTargetId, chatMessage: questionMsg, questionText } = parsed;
      if (questionTargetId && get().sessionStates[questionTargetId]) {
        updateSession(questionTargetId, (ss) => ({
          messages: [...ss.messages, questionMsg],
        }));
      } else {
        get().addMessage(questionMsg);
      }
      if (questionTargetId) {
        pushSessionNotification(questionTargetId, 'question', questionText);
      }
      break;
    }

    case 'server_status': {
      // Ignore structured startup phase events (phase field) — only the dashboard uses these
      if (typeof msg.phase === 'string') break;

      const { chatMessage: statusMsg } = sharedServerStatusLegacy(msg);
      const activeStatusId = get().activeSessionId;
      if (activeStatusId && get().sessionStates[activeStatusId]) {
        updateActiveSession((ss) => ({
          messages: [...ss.messages, statusMsg],
        }));
      } else {
        get().addMessage(statusMsg);
      }
      break;
    }

    case 'server_shutdown': {
      const shutdownPatch = sharedServerShutdown(msg);
      set(shutdownPatch);
      useNotificationStore
        .getState()
        .setShutdown(
          shutdownPatch.shutdownReason,
          shutdownPatch.restartEtaMs,
          shutdownPatch.restartingSince,
        );
      break;
    }

    // --- Multi-client awareness ---

    case 'client_joined': {
      const joined = sharedClientJoined(msg, get().connectedClients);
      if (!joined) break;
      useMultiClientStore.getState().addClient(joined.client);
      set({ connectedClients: joined.roster });
      const deviceLabel = joined.client.deviceName || 'A device';
      const joinMsg: ChatMessage = {
        id: nextMessageId('client'),
        type: 'system',
        content: `${deviceLabel} connected`,
        timestamp: Date.now(),
      };
      const joinActiveId = get().activeSessionId;
      if (joinActiveId && get().sessionStates[joinActiveId]) {
        updateActiveSession((ss) => ({
          messages: [...ss.messages, joinMsg],
        }));
      } else {
        get().addMessage(joinMsg);
      }
      break;
    }

    case 'client_left': {
      const left = sharedClientLeft(msg, get().connectedClients);
      if (!left) break;
      // Keep the multi-client side store in sync (its removeClient also returns
      // the departing entry, but we trust the shared handler's lookup).
      useMultiClientStore.getState().removeClient(left.clientId);
      set({ connectedClients: left.roster });
      const leftLabel = left.departingClient?.deviceName || 'A device';
      const leftMsg: ChatMessage = {
        id: nextMessageId('client'),
        type: 'system',
        content: `${leftLabel} disconnected`,
        timestamp: Date.now(),
      };
      const leftActiveId = get().activeSessionId;
      if (leftActiveId && get().sessionStates[leftActiveId]) {
        updateActiveSession((ss) => ({
          messages: [...ss.messages, leftMsg],
        }));
      } else {
        get().addMessage(leftMsg);
      }
      break;
    }

    case 'primary_changed': {
      const { sessionId: primarySessionId, primaryClientId } = sharedPrimaryChanged(msg);
      useMultiClientStore.getState().setPrimaryClientId(primaryClientId);
      if (primarySessionId && get().sessionStates[primarySessionId]) {
        updateSession(primarySessionId, () => ({
          primaryClientId,
        }));
      } else if (!primarySessionId || primarySessionId === 'default') {
        set({ primaryClientId });
      }
      break;
    }

    case 'session_role': {
      // #5589 / #5281 — explicit primary-ownership. The server names the
      // primary; we derive THIS client's role by comparing it to our own id
      // (learned from auth_ok, canonical source: useMultiClientStore.myClientId).
      // Stored per-session on `sessionRole` so the SessionScreen can surface an
      // observer banner / claim affordance. We also mirror `primaryClientId`
      // (the raw pointer) so the existing presence UI stays in sync without
      // depending on a separate legacy `primary_changed` arriving.
      const myClientId = useMultiClientStore.getState().myClientId;
      const role = sharedSessionRole(msg, myClientId);
      if (role.sessionId && get().sessionStates[role.sessionId]) {
        updateSession(role.sessionId, () => ({
          sessionRole: role.role,
          primaryClientId: role.primaryClientId,
        }));
      }
      break;
    }

    case 'client_focus_changed': {
      const focus = sharedClientFocusChanged(msg);
      if (!focus) break;
      // Auto-switch if follow mode is on, event is from another client, target session exists locally, and not already on it
      const mcState = useMultiClientStore.getState();
      const { activeSessionId, sessionStates } = get();
      if (mcState.followMode && focus.clientId !== mcState.myClientId && focus.sessionId !== activeSessionId && sessionStates[focus.sessionId]) {
        get().switchSession(focus.sessionId);
      }
      break;
    }

    // directory_listing / file_listing / file_content / write_file_result /
    // diff_result / git_status_result / git_branches_result / git_stage_result /
    // git_unstage_result / git_commit_result — migrated to the shared dispatch
    // table (#5556 slice 3 / #5653). Each was the same `getCallback(name) →
    // shared*(msg) → cb(payload)` wrapper; the table now parses and invokes the
    // imperative callback via `_dispatchAdapter.getCallback`.

    case 'slash_commands': {
      const slashResult = sharedSlashCommands(msg, get().activeSessionId);
      if (!slashResult) break;
      const slashCommands = slashResult.commands as SlashCommand[];
      set({ slashCommands });
      useConversationStore.getState().setSlashCommands(slashCommands);
      break;
    }

    case 'provider_list': {
      const providerResult = sharedProviderList(msg);
      if (!providerResult) break;
      set({ availableProviders: mapProviderList(providerResult.providers) });
      break;
    }

    case 'agent_list': {
      const agentResult = sharedAgentList(msg, get().activeSessionId);
      if (!agentResult) break;
      const customAgents = agentResult.agents as CustomAgent[];
      set({ customAgents });
      useConversationStore.getState().setCustomAgents(customAgents);
      break;
    }

    case 'auth_bootstrap': {
      // #5555 — connect-time bootstrap burst folds the provider / slash-command
      // / agent lists into one server-initiated frame so the client skips its
      // 3-request connect-time round trip. Apply each list through the SAME
      // store mutations + element validation the discrete responses use, so the
      // bootstrap and refresh paths are behaviourally identical.
      const boot = sharedAuthBootstrap(msg);
      // #5555 (sub-item 7): re-learn the live tunnel URL on every connect. If a
      // quick-tunnel rotation happened while the app was offline (so it missed
      // the live `tunnel_url_changed` push), this repoints the persisted record
      // to the working endpoint. Applied before the session-scope guard below
      // so a stale-session burst still refreshes the URL.
      if (boot.tunnelUrl) applyRotatedTunnelUrl(boot.tunnelUrl);
      // Providers (server-wide, no session guard).
      set({ availableProviders: mapProviderList(boot.providers) });
      // Slash commands + agents are scoped to the connect-time active session.
      // Guard against a stale burst: if a session switch already moved the
      // active id off the burst's `sessionId`, skip the session-scoped lists
      // (the post-switch session_switched flow re-requests them) but keep the
      // server-wide provider list applied above.
      const activeId = get().activeSessionId;
      if (boot.sessionId && activeId && boot.sessionId !== activeId) break;
      const slashCommands = boot.slashCommands as SlashCommand[];
      set({ slashCommands });
      useConversationStore.getState().setSlashCommands(slashCommands);
      const customAgents = boot.agents as CustomAgent[];
      set({ customAgents });
      useConversationStore.getState().setCustomAgents(customAgents);
      break;
    }

    case 'tunnel_url_changed': {
      // #5555 (sub-item 7): a quick-tunnel recovery rotated the public URL.
      // Repoint the persisted tunnel endpoint so the next reconnect dials the
      // working URL instead of hammering the dead one (and survives an app
      // restart — the record is SecureStore-backed).
      //
      // BEST-EFFORT for us: this client is connected THROUGH the tunnel, so the
      // socket carrying this frame rode the now-dead old tunnel — we often will
      // NOT receive it. The durable recovery is the `tunnelUrl` re-advertised in
      // the `auth_bootstrap` burst on the next reconnect (handled above).
      const rotated = sharedTunnelUrlChanged(msg);
      if (rotated) applyRotatedTunnelUrl(rotated.url);
      break;
    }

    case 'session_restore_failed': {
      // Server couldn't restart a persisted session (e.g. missing API key).
      // History is preserved on disk; surface this visibly instead of making
      // the saved session look like it silently disappeared after restart.
      const restoreFailed = sharedSessionRestoreFailed(msg);
      const serverError: ServerError = {
        id: nextMessageId('restore'),
        category: 'session',
        message: restoreFailed.systemMessage.content,
        recoverable: true,
        timestamp: Date.now(),
        ...(restoreFailed.sessionId ? { sessionId: restoreFailed.sessionId } : {}),
      };
      set((state: ConnectionState) => ({
        serverErrors: [...state.serverErrors, serverError].slice(-10),
      }));
      useNotificationStore.getState().addServerError(serverError);
      // eslint-disable-next-line no-console
      console.warn('[session_restore_failed]', {
        sessionId: restoreFailed.sessionId,
        name: restoreFailed.name,
        provider: restoreFailed.provider,
        cwd: restoreFailed.cwd,
        model: restoreFailed.model,
        permissionMode: restoreFailed.permissionMode,
        errorCode: restoreFailed.errorCode,
        errorMessage: restoreFailed.errorMessage,
        historyLength: restoreFailed.historyLength,
      });
      break;
    }

    case 'session_persist_failed': {
      // #5714/#5701: a session-list mutation (create/rename/destroy) could not be
      // flushed to disk and will be lost on restart. The write is atomic so
      // on-disk state isn't corrupted — surface a recoverable error so the user
      // isn't left silently believing the change persisted.
      const persistSid = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      const persistName = typeof msg.name === 'string' ? msg.name : null;
      const label = persistName ? `"${persistName}"` : (persistSid ? `session ${persistSid}` : 'your session change');
      const persistError: ServerError = {
        id: nextMessageId('persist'),
        category: 'session',
        message: `Couldn't save ${label} — the change may be lost on restart. Check the daemon's disk space and write permissions.`,
        recoverable: true,
        timestamp: Date.now(),
        ...(persistSid ? { sessionId: persistSid } : {}),
      };
      set((state: ConnectionState) => ({
        serverErrors: [...state.serverErrors, persistError].slice(-10),
      }));
      useNotificationStore.getState().addServerError(persistError);
      // eslint-disable-next-line no-console
      console.warn('[session_persist_failed]', { sessionId: persistSid, name: persistName });
      break;
    }

    case 'checkpoint_created': {
      const next = sharedCheckpointCreated(msg, get().checkpoints, get().activeSessionId);
      if (next) {
        set({ checkpoints: next });
        // Side effect: dual-write into the conversation store. The shared
        // handler validated the payload, so we can safely treat the appended
        // entry as the message's `checkpoint` field.
        useConversationStore.getState().addCheckpoint(msg.checkpoint as Checkpoint);
      }
      break;
    }

    case 'checkpoint_list': {
      const next = sharedCheckpointList(msg, get().activeSessionId);
      if (next) {
        set({ checkpoints: next });
        useConversationStore.getState().setCheckpoints(next);
      }
      break;
    }

    case 'checkpoint_restored': {
      // Server created a new session at the checkpoint state.
      // Auto-switch to it; session_list update follows from server.
      const restored = sharedCheckpointRestored(msg);
      if (restored) {
        get().switchSession(restored.newSessionId, { serverNotify: false, haptic: false });
      }
      break;
    }

    // mcp_servers — migrated to the shared dispatch table (#5556 slice 2)

    case 'cost_update': {
      const result = sharedCostUpdate(msg, get().activeSessionId);
      const totalCost = typeof msg.totalCost === 'number' ? msg.totalCost : null;
      const budget = typeof msg.budget === 'number' ? msg.budget : null;
      if (result.sessionId && get().sessionStates[result.sessionId]) {
        updateSession(result.sessionId, () => result.patch);
      }
      set({ totalCost, costBudget: budget });
      // dual-write: remove after consumers migrate to CostStore
      useCostStore.getState().setCostUpdate(totalCost, budget);
      break;
    }

    // session_usage / session_cost_threshold_crossed — migrated to the shared
    // dispatch table (#5556 slice 2)

    case 'budget_warning': {
      const { warningMessage, systemMessage } = sharedBudgetWarning(msg);
      Alert.alert('Budget Warning', warningMessage);
      const targetId = resolveSessionId(msg, get().activeSessionId);
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, (ss) => ({
          messages: [...ss.messages, systemMessage],
        }));
      } else {
        get().addMessage(systemMessage);
      }
      break;
    }

    case 'budget_exceeded': {
      const { exceededMessage, systemMessage } = sharedBudgetExceeded(msg);
      const targetId = resolveSessionId(msg, get().activeSessionId);
      // Show alert with "Resume" option to override the pause
      Alert.alert('Budget Exceeded', `${exceededMessage}\n\nNew messages are paused.`, [
        { text: 'OK', style: 'cancel' },
        {
          text: 'Resume',
          onPress: () => {
            const socket = get().socket;
            if (socket && targetId) {
              wsSend(socket, { type: 'resume_budget', sessionId: targetId });
            }
          },
        },
      ]);
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, (ss) => ({
          messages: [...ss.messages, systemMessage],
        }));
      } else {
        get().addMessage(systemMessage);
      }
      break;
    }

    // budget_resumed — migrated to the shared dispatch table (#5556)


    // dev_preview / dev_preview_stopped — migrated to the shared dispatch
    // table (#5556 slice 2)

    // -- Web tasks (Claude Code Web) --

    // web_feature_status — migrated to the shared dispatch table (#5556 slice 2)

    // web_task_created / web_task_updated — migrated to the shared dispatch
    // table (#5556 slice 4). Both were the byte-identical `sharedWebTaskUpsert`
    // → filter-and-append upsert; the table now runs it via
    // `_dispatchAdapter.updateState` (functional flat-state update).

    case 'web_task_error': {
      const {
        taskId: errTaskId,
        errorMessage,
        chatMessageContent,
        code,
        boundSessionName,
      } = sharedWebTaskError(msg);
      if (errTaskId) {
        // Update task status to failed
        set((state: ConnectionState) => ({
          webTasks: state.webTasks.map((t) =>
            t.taskId === errTaskId
              ? { ...t, status: 'failed' as const, error: errorMessage, updatedAt: Date.now() }
              : t,
          ),
        }));
      }
      // For bound-session mismatches, surface the same actionable Alert used
      // by session_error (#2944). When boundSessionName is present the user
      // needs to know why the action was rejected and how to fix it. We
      // short-circuit BEFORE building the ChatMessage so no message id /
      // timestamp is allocated for an event that won't be dispatched.
      if (code === 'SESSION_TOKEN_MISMATCH' && boundSessionName) {
        showBoundSessionMismatchAlert(
          `This device is paired to session "${boundSessionName}" and can only perform web tasks in that session. To use other sessions, disconnect and scan a fresh QR code from the desktop.`,
        );
        break;
      }
      // Otherwise show the error as a system message in chat. Build the
      // ChatMessage here so its id + timestamp are allocated after the task
      // state update above.
      const errorMsg: ChatMessage = {
        id: nextMessageId('web'),
        type: 'system',
        content: chatMessageContent,
        timestamp: Date.now(),
      };
      const activeSid = get().activeSessionId;
      if (activeSid && get().sessionStates[activeSid]) {
        updateActiveSession((ss) => ({
          messages: [...ss.messages, errorMsg],
        }));
      } else {
        get().addMessage(errorMsg);
      }
      break;
    }

    // web_task_list — migrated to the shared dispatch table (#5556 slice 2)

    case 'conversations_list': {
      // Parser shared via store-core; app-only state mirroring (loading/error
      // flags + useConversationStore) stays here.
      const { conversations } = sharedConversationsList(msg);
      set({ conversationHistory: conversations, conversationHistoryLoading: false, conversationHistoryError: null });
      useConversationStore.getState().setConversationHistory(conversations);
      break;
    }

    case 'search_results': {
      const currentQuery = (get() as ConnectionState).searchQuery;
      const { results, shouldApply } = sharedSearchResults(msg, currentQuery);
      if (!shouldApply) break; // Stale response for an older query — ignore
      // results is already typed as SearchResult[] from store-core (#3146).
      set({ searchResults: results, searchLoading: false, searchError: null });
      useConversationStore.getState().setSearchResults(results, currentQuery);
      break;
    }

    // notification_prefs — migrated to the shared dispatch table (#5556 slice
    // 2). The app previously hand-maintained a byte-identical inline Zod parse
    // (same ServerNotificationPrefsSchema + bypassCategories spread); it now
    // routes through the shared handleNotificationPrefs like the dashboard.

    case 'server_error': {
      const { serverError, chatMessage: errorMsg } = sharedServerError(msg);
      set((state: ConnectionState) => ({
        serverErrors: [...state.serverErrors, serverError].slice(-10),
      }));
      useNotificationStore.getState().addServerError(serverError);
      // #3141: scoped routing for session-tagged server errors. Mirrors the
      // dashboard's handler. Order: explicit `serverError.sessionId` →
      // active session → notification-only fallback.
      const errSessionId = serverError.sessionId;
      if (errSessionId && get().sessionStates[errSessionId]) {
        updateSession(errSessionId, (ss) => ({
          messages: filterThinking([...ss.messages, errorMsg]),
          streamingMessageId: null,
        }));
      } else {
        const activeErrId = get().activeSessionId;
        if (activeErrId && get().sessionStates[activeErrId]) {
          updateActiveSession((ss) => ({
            messages: filterThinking([...ss.messages, errorMsg]),
            streamingMessageId: null,
          }));
        }
        // No session context on app — the error is already surfaced via
        // `useNotificationStore.addServerError` and the unrecoverable Alert
        // below. App's ConnectionState has no top-level `messages` array
        // to fall back to (unlike the dashboard).
      }
      if (!serverError.recoverable) {
        Alert.alert('Server Error', serverError.message);
      }
      break;
    }

    case 'push_token_error': {
      const rawPushError = typeof msg.message === 'string' ? stripAnsi(msg.message as string) : '';
      const errMessage = rawPushError.trim().length > 0 ? rawPushError.trim() : 'Push token registration failed';
      console.warn('[push] Push token error from server:', errMessage);
      break;
    }

    case 'token_rotated': {
      // Token parse shared via store-core (#5454); persistence/re-auth side
      // effects stay platform-specific.
      const { token: newToken } = sharedTokenRotated(msg);
      if (newToken) {
        // Server sent the new token — update stored credentials seamlessly.
        // #5518: a token change invalidates any prior LAN verification (it was
        // earned by the old credential), so persistVerifiedConnection clears it.
        console.log('[ws] Server token rotated — updating stored token');
        persistVerifiedConnection(ctx.url, newToken);
      } else {
        // Legacy: server didn't include new token — disconnect and prompt re-auth
        console.log('[ws] Server token rotated — re-authentication required');
        void get().clearSavedConnection();
        get().disconnect();
        setTimeout(() => {
          Alert.alert(
            'Token Rotated',
            'The server API token has been rotated. Please re-scan the QR code or re-enter the new token to reconnect.',
            [{ text: 'OK' }],
          );
        }, 100);
      }
      break;
    }

    case 'session_warning': {
      const { sessionId: warnSessionId, sessionName, remainingMs } = sharedSessionWarning(msg);

      // Set timeout warning state for the banner UI
      const warningData = {
        sessionId: warnSessionId || '',
        sessionName,
        remainingMs,
        receivedAt: Date.now(),
      };
      set({ timeoutWarning: warningData });
      useNotificationStore.getState().setTimeoutWarning(warningData);
      break;
    }

    case 'session_timeout': {
      const { sessionId: timeoutSessionId, name } = sharedSessionTimeout(msg);
      Alert.alert('Session Closed', `Session "${name}" was closed due to inactivity.`);
      if (timeoutSessionId) {
        // Clean up sessionStates entry for the destroyed session (#816)
        const { sessionStates, sessions } = get();
        const newStates = { ...sessionStates };
        delete newStates[timeoutSessionId];
        const newSessions = sessions.filter((s) => s.sessionId !== timeoutSessionId);
        const patch: Partial<ConnectionState> = { sessionStates: newStates, sessions: newSessions };
        // If the timed-out session was active, switch to next available
        if (get().activeSessionId === timeoutSessionId) {
          const remaining = Object.keys(newStates);
          patch.activeSessionId = remaining.length > 0 ? remaining[0] : null;
        }
        set(patch);
        // Garbage-collect persisted messages for the deleted session (#797)
        void clearPersistedSession(timeoutSessionId);
      }
      break;
    }

    case 'error': {
      // Structured error response from a handler catch block.
      // Log it and surface a modal alert so the user knows something failed.
      // #5039: `partialCost` carries the optional PR #5037 fold of parent
      // + Task subagent rounds completed before the error fired. When
      // present, append the pre-formatted sub-line to the Alert body so
      // the user sees what the failed turn cost — same wording as the
      // dashboard toast sub-line.
      const {
        code: errCode,
        message: errMsg,
        requestId: errRequestId,
        partialCost,
      } = sharedError(msg);
      const partialCostLine = partialCost ? formatPartialCostLine(partialCost) : null;
      // Build the Alert body once so the permission-mode branch below and
      // the generic fallback both surface the partial-cost line.
      const alertBody = partialCostLine ? `${errMsg}\n\n${partialCostLine}` : errMsg;
      console.error(`[ws] Server handler error [${errCode}]: ${errMsg}`);

      // Match against an in-flight set_permission_mode request — if the
      // requestId lines up, revert the optimistic UI state and show a
      // targeted message instead of the generic "Server Error" alert.
      if (errRequestId) {
        const pending = takePendingPermissionModeRequest(errRequestId);
        if (pending) {
          // Only revert when the current mode still matches what THIS
          // request optimistically applied. Guards against out-of-order
          // rejections clobbering a newer optimistic selection (e.g. user
          // taps A→B→C, A's rejection arrives after C's optimistic apply —
          // we must not revert C's state to A's previousMode).
          if (pending.sessionId) {
            const currentSession = get().sessionStates[pending.sessionId];
            if (
              currentSession &&
              currentSession.permissionMode === pending.requestedMode
            ) {
              updateSession(pending.sessionId, () => ({ permissionMode: pending.previousMode }));
            }
          }
          // Always clear any visible confirmation prompt so the UI doesn't
          // leave an orphaned "Are you sure?" sheet open after rejection.
          set({ pendingPermissionConfirm: null });

          if (errCode === 'CAPABILITY_NOT_SUPPORTED') {
            // The targeted "Permission Mode Unavailable" alert uses its
            // own fallback copy when errMsg is empty; the partial-cost
            // line stays appended either way.
            const permissionBody = errMsg || 'This provider does not support permission mode switching.';
            Alert.alert(
              'Permission Mode Unavailable',
              partialCostLine ? `${permissionBody}\n\n${partialCostLine}` : permissionBody,
            );
            break;
          }
          // Other error codes targeting the same in-flight request still
          // need to surface — fall through to the generic alert below so
          // the user knows the mode change failed.
        }
      }

      Alert.alert('Server Error', alertBody);
      break;
    }

    default: {
      // Log unknown message types when server protocol is newer (likely new features)
      const serverPV = useConnectionLifecycleStore.getState().serverProtocolVersion;
      if (serverPV != null && serverPV > CLIENT_PROTOCOL_VERSION) {
        console.warn(`[ws] Unknown message type "${msg.type}" (server protocol v${serverPV}, client v${CLIENT_PROTOCOL_VERSION})`);
      }
      break;
    }
  }
}

/** @internal Exposed for testing only — same pattern as _testQueueInternals */
export const _testMessageHandler = {
  handle: handleMessage,
  setContext: (ctx: ConnectionContext) => { _connectionContext = ctx; },
  clearContext: () => { _connectionContext = null; },
};
