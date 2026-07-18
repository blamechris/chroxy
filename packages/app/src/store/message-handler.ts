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
  // available_permission_modes / session_updated / confirm_permission_mode /
  // agent_busy / budget_resumed migrated to the shared dispatch table (#5556)
  handleClaudeReady as sharedClaudeReady,
  handleThinkingLevelChanged as sharedThinkingLevelChanged,
  handleBudgetExceeded as sharedBudgetExceeded,
  // plan_started / inactivity_warning / dev_preview / dev_preview_stopped
  // migrated to the shared dispatch table (#5556 slice 2)
  handleToolStart as sharedToolStart,
  handleToolResult as sharedToolResult,
  handleToolInputDelta as sharedToolInputDelta,
  handleStreamStart as sharedStreamStart,
  sharedStreamDelta,
  handleStreamEnd as sharedStreamEnd,
  // #6756 — extended-thinking (reasoning) content stream.
  handleThinkingStreamStart as sharedThinkingStart,
  handleThinkingDelta as sharedThinkingDelta,
  handleThinkingStreamEnd as sharedThinkingEnd,
  finalizeThinkingStreams,
  handleAuthOk as sharedAuthOk,
  parseConnectedClients as sharedParseConnectedClients,
  handleAuthFail as sharedAuthFail,
  handleKeyExchangeOk as sharedKeyExchangeOk,
  handleServerMode as sharedServerMode,
  // checkpoint_created / checkpoint_list migrated to the shared dispatch table
  // (#5618 Batch 6); checkpoint_restored is not migrated in this batch — it
  // stays platform-local (here as a switch case; the dashboard via its
  // HANDLERS map), so this shared import remains.
  handleError as sharedError,
  handleSessionError as sharedSessionError,
  handleClientJoined as sharedClientJoined,
  handleClientLeft as sharedClientLeft,
  // conversation_id migrated to the shared dispatch table (#5556)
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
  handleSessionWarning as sharedSessionWarning,
  handleSessionSwitched as sharedSessionSwitched,
  // diff_result / git_status_result / git_branches_result / git_stage_result /
  // git_unstage_result / git_commit_result — migrated to the shared dispatch
  // table (#5556 slice 3 / #5653).
  // agent_spawned / agent_completed / agent_event / background_work_changed /
  // mcp_servers / session_usage / web_task_list / web_feature_status migrated
  // to the shared dispatch table (#5556 slice 2)
  handleResultUsage as sharedResultUsage,
  handleResultQueueReconcile,
  handleServerError as sharedServerError,
  handleServerStatusLegacy as sharedServerStatusLegacy,
  // web_task_created / web_task_updated — migrated to the shared dispatch table
  // (#5556 slice 4); the app no longer imports the upsert helper directly.
  handleWebTaskError as sharedWebTaskError,
  applyOrphanDeltas,
  isActivityEvent,
  // #5163 (epic #5159) — Control Room cross-session activity reducer:
  // snapshot replace + self-healing delta upsert + terminal-retention prune.
  // The mobile MissionControlScreen (#5968 / #6245) and the dashboard panel
  // both consume this one implementation; #6246 wires the feeder here.
  applyActivitySnapshot,
  applyActivityDelta,
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
// #6246 — Control Room activity wire schemas. Validated defensively before the
// store-core reducer so a malformed payload is dropped, not crashed on (same
// pattern the dashboard feeder uses). Resolved via the jest moduleNameMapper
// `^@chroxy/protocol/schemas$` and the protocol package's `./schemas` export.
import { ServerActivitySnapshotSchema, ServerActivityDeltaSchema, ServerPermissionInputSchema } from '@chroxy/protocol/schemas';
import { hapticSuccess } from '../utils/haptics';
import type {
  ChatMessage,
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
  SearchResult,
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
 *
 * Returns `true` when the frame was handed to `socket.send` without throwing,
 * `false` when the send threw. #6283: the caller checks `readyState === OPEN`,
 * but the socket can flip to CLOSING before this synchronous send and throw
 * `InvalidStateError` — a flaky-tunnel TOCTOU window. Swallowing the throw and
 * signalling failure lets delivery-critical callers (`sendInput`) fall back to
 * the offline queue instead of leaving a permanently 'sent'-looking bubble that
 * never reached the server. Mirrors the server-side sender (#5721, see
 * `packages/server/src/ws-client-sender.js`: catch → log → return false).
 * Most callers ignore the result (a closed socket was already a silent no-op).
 */
export function wsSend(socket: WebSocket, payload: Record<string, unknown>): boolean {
  // Serialize/encrypt OUTSIDE the try so a JSON/crypto bug still throws loudly
  // (it's a real defect, not a transient send failure) rather than being
  // swallowed, logged as a "send threw", and re-queued forever. The nonce is
  // consumed for THIS frame here but only advanced after a successful send. (#6283)
  const data = _ctx.encryptionState
    ? JSON.stringify(
        encrypt(
          JSON.stringify(payload),
          _ctx.encryptionState.sharedKey,
          _ctx.encryptionState.sendNonce,
          DIRECTION_CLIENT,
        ),
      )
    : JSON.stringify(payload);
  try {
    socket.send(data);
  } catch (err) {
    // #6283 — the socket flipped to CLOSING after the readyState check (flaky
    // tunnel TOCTOU). Don't advance sendNonce: the frame never went out, so the
    // next send must reuse this nonce (reconnect forces a fresh key exchange,
    // but a same-socket retry must not desync).
    console.warn('[wsSend] socket.send threw — frame not delivered:', err);
    return false;
  }
  if (_ctx.encryptionState) _ctx.encryptionState.sendNonce++;
  return true;
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
    // #6288 — propagate wsSend's boolean rather than assuming OPEN ⇒ sent. The
    // socket can flip to CLOSING between the readyState check and the synchronous
    // send (the TOCTOU window wsSend guards), so wsSend may swallow an
    // InvalidStateError and return false. Callers that gate on this result
    // (Git/File ops) must see that false, or they arm a callback/spinner that
    // never resolves.
    return wsSend(socket, payload);
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

/** #6446 — read the in-flight handshake salt, so a reset can be asserted directly. */
export function getPendingSalt(): string | null {
  return _ctx.pendingSalt;
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

/**
 * Reset the E2E encryption context (post-handshake `encryptionState` AND the
 * in-flight handshake material `pendingKeyPair` + `pendingSalt`) to its initial
 * state, as a UNIT — for forward secrecy on every new connection.
 *
 * #6446: callers previously reset `encryptionState` + `pendingKeyPair`
 * field-by-field and MISSED `pendingSalt`. Resetting through the grouped
 * `INITIAL_ENCRYPTION_CONTEXT` (the same object `createDefaultContext` spreads)
 * clears every field — and any field a future handshake adds to
 * `EncryptionContext` — so nothing can silently survive a reconnect or a server
 * switch. This is deliberately narrow: it does NOT tear down timers / heartbeat
 * / connection-attempt counters (that is the heavier `resetAllHandlerState`).
 */
export function resetEncryptionContext(): void {
  Object.assign(_ctx, INITIAL_ENCRYPTION_CONTEXT);
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
  // #6449 slice 1 — terminal-mirror cases (raw/raw_background/terminal_output)
  // migrated to the shared dispatch table. The app writes to BOTH the connection
  // store and its secondary useTerminalStore (the dashboard omits the latter) —
  // folding the prior switch cases' two writes into this one adapter primitive.
  appendTerminalData: (data) => {
    getStore().getState().appendTerminalData(data);
    useTerminalStore.getState().appendTerminalData(data);
  },
  getSessions: () => getStore().getState().sessions,
  // #5618 Batch 6 — checkpoint_created reads the prior flat list to append.
  getCheckpoints: () => getStore().getState().checkpoints,
  // #5618 — user_question raises a background-session notification via the
  // app's own helper (which also mirrors the row into the mobile push store).
  pushSessionNotification: (sessionId, eventType, message) =>
    pushSessionNotification(sessionId, eventType, message),
  // #5618 — permission_mode_changed clears the app's pending optimistic-revert
  // tracker for the broadcast's target session (the dashboard has no equivalent
  // per-session tracker and omits this hook).
  clearPendingPermissionModeRequests: (sessionId) =>
    clearPendingPermissionModeRequestsForSession(sessionId),
  // #5618 — budget_warning (and future notice types) surface a transient alert
  // via the app's React-Native Alert.
  alert: (title, message) => Alert.alert(title, message),
  // #5618 — plan_ready raises the app's 'plan' background-session notification
  // (the dashboard has no equivalent surface and omits this hook).
  notifyPlanReady: (sessionId) =>
    pushSessionNotification(sessionId, 'plan', 'Plan ready for approval'),
  // #5618 — server_shutdown mirrors the shutdown patch into the app's mobile
  // notification store (the dashboard omits this hook).
  applyShutdownNotification: (payload) =>
    useNotificationStore
      .getState()
      .setShutdown(payload.shutdownReason, payload.restartEtaMs, payload.restartingSince),
  // #5618 — checkpoint_restored auto-switches with the app's no-notify/no-haptic
  // options (the server already re-homed this client; an auto-switch shouldn't buzz).
  switchToRestoredSession: (sessionId) =>
    getStore().getState().switchSession(sessionId, { serverNotify: false, haptic: false }),
  // #5618 — conversations_list clears the app-only conversationHistoryError flag and
  // mirrors the list into the secondary conversation store (the dashboard omits this).
  applyConversationsListExtras: (conversations) => {
    getStore().setState({ conversationHistoryError: null });
    useConversationStore.getState().setConversationHistory(conversations as ConversationSummary[]);
  },
  // #5618 — search_results staleness gate reads the live flat searchQuery.
  getSearchQuery: () => getStore().getState().searchQuery,
  // #5618 — search_results clears the app-only searchError flag and mirrors the
  // results (with the live query) into the secondary conversation store (dashboard omits).
  applySearchResultsExtras: (results) => {
    getStore().setState({ searchError: null });
    useConversationStore
      .getState()
      .setSearchResults(results as SearchResult[], getStore().getState().searchQuery);
  },
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
  // #5618 Batch 2 — slash_commands / agent_list also mirror into the app's
  // secondary conversation store for the composer UI, exactly as the prior
  // inline `useConversationStore.getState().setSlashCommands(...)` /
  // `setCustomAgents(...)` did. The dashboard omits this hook (no secondary store).
  syncSecondaryInventory: (kind, list) => {
    if (kind === 'slashCommands') {
      useConversationStore.getState().setSlashCommands(list as SlashCommand[]);
    } else {
      useConversationStore.getState().setCustomAgents(list as CustomAgent[]);
    }
  },
  // #5618 Batch 6 — checkpoint_created / checkpoint_list also mirror into the
  // app's secondary conversation store (its checkpoint timeline UI), exactly as
  // the prior inline `useConversationStore.getState().addCheckpoint(...)` /
  // `setCheckpoints(...)` did. The dashboard omits this hook (no secondary store).
  syncSecondaryCheckpoints: (op) => {
    if (op.kind === 'append') {
      useConversationStore.getState().addCheckpoint(op.checkpoint);
    } else {
      useConversationStore.getState().setCheckpoints(op.checkpoints);
    }
  },
  // #5618 Batch 2 — the app tightens provider_list elements via mapProviderList
  // before the flat-state write (drops nameless/non-object entries). The
  // dashboard omits this hook and writes the server payload verbatim.
  mapProviderList: (providers) => mapProviderList(providers),
  // #5618 Batch 3 — error-sink for session_restore_failed / session_persist_failed.
  // The app builds a structured ServerError, ring-caps the flat `serverErrors`
  // list, and mirrors into the mobile notification store. (The id prefix is now a
  // unified server-error prefix rather than the prior per-case restore/persist
  // prefixes — ids stay unique; the prefix is cosmetic, not used for render/dedup.)
  addServerError: (message, opts) => {
    const serverError: ServerError = {
      id: nextMessageId('server-error'),
      // opts.category is the closed ServerErrorCategory union (typed at the hook),
      // so no cast is needed — fall back to 'general' when the caller omits it.
      category: opts?.category ?? 'general',
      message,
      recoverable: opts?.recoverable ?? true,
      timestamp: Date.now(),
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    };
    getStore().setState((state: ConnectionState) => ({
      serverErrors: [...state.serverErrors, serverError].slice(-10),
    }));
    useNotificationStore.getState().addServerError(serverError);
  },
  // #5618 Batch 3 — the app deliberately shows NO info toast for session_stopped
  // (#4879 — the inline session banner carries the signal), so `addInfoNotification`
  // is OMITTED. The dashboard supplies it (its #4878 info toast).
  // #5618 Batch 4 — multi-client accessors for primary_changed / session_role /
  // client_focus_changed. The app reads presence state from its dedicated
  // useMultiClientStore (the dashboard reads flat state); these accessors hide
  // that divergence so the three cases are fully shared.
  getMyClientId: () => useMultiClientStore.getState().myClientId,
  getFollowMode: () => useMultiClientStore.getState().followMode,
  switchSession: (sessionId) => getStore().getState().switchSession(sessionId),
  setPrimaryClientId: (clientId) => useMultiClientStore.getState().setPrimaryClientId(clientId),
  // #5618 Batch 5a — cost_update's app-only mirror: flat totalCost/costBudget +
  // the useCostStore dual-write. (The shared per-session sessionCost patch is
  // applied by the dispatch handler.) The app omits extendModelsPatch — it does
  // not track availableModelsProvider (dashboard-only).
  setCostUpdate: (totalCost, budget) => {
    getStore().setState({ totalCost, costBudget: budget } as Partial<ConnectionState>);
    useCostStore.getState().setCostUpdate(totalCost, budget);
  },
  // #5618 Batch 5b — repoint the persisted (SecureStore) tunnel endpoint after a
  // quick-tunnel rotation (tunnel_url_changed / auth_bootstrap). The app's apply
  // ignores previousUrl (the dashboard uses it to match the right registry entry).
  applyRotatedTunnelUrl: (url) => { applyRotatedTunnelUrl(url); },
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
  // #5616 — identity-rotation continuity cert from the handshake (auth_ok /
  // key_exchange_ok). When the daemon rotated its identity, `newIdentityKey` is
  // its current key and `rotationCert` is the old-signed-new cert; a pinned
  // client whose pin no longer verifies chains forward instead of refusing.
  // Both null on un-rotated daemons / older servers (refusal path unchanged).
  newIdentityKey: string | null = null,
  rotationCert: string | null = null,
): { refused: false; pinToPersist: string | null } | { refused: true } {
  const saved = useConnectionLifecycleStore.getState().savedConnection;
  const pinnedIdentityKey = saved?.pinnedIdentityKey ?? null;
  const decision = decideKeyPinWithPairingIdentity({
    pinnedIdentityKey,
    pairingIdentityKey: pendingPairingIdentityKey,
    exchangePublicKey,
    serverKeySig,
    newIdentityKey,
    rotationCert,
  });
  if (decision.action === 'refuse') {
    applyIdentityRefusal(ctx, decision.reason, decision.message);
    return { refused: true };
  }
  // Proceed — clear the pairing identity once it's been adopted (or wasn't
  // needed) and capture the pin to persist.
  //
  // NB: an if/else chain, NOT a switch — the protocol handler-coverage contract
  // (packages/protocol/tests/handler-coverage.test.js) statically greps this
  // file for `case '<x>':` and asserts every <x> is a ServerMessageType. A
  // switch over `decision.action` would surface 'connect'/'rotate-pin'/... as
  // bogus "uncovered message types". Same exhaustiveness, no false case hits.
  pendingPairingIdentityKey = null;
  if (decision.action === 'connect') {
    // Verified against an existing pin, or an old/unpinned daemon — leave the
    // stored record's pin untouched.
    return { refused: false, pinToPersist: null };
  }
  if (decision.action === 'pin-and-connect' || decision.action === 'rotate-pin') {
    // #5616 — TOFU first-use ('pin-and-connect') AND a forward-chained identity
    // rotation ('rotate-pin', where the old pinned identity signed the new one)
    // both persist the offered identity as the new pin. Without the explicit
    // 'rotate-pin' arm a rotation would connect but drop the new pin
    // (pinToPersist=null), silently failing to chain it forward (#5978).
    return { refused: false, pinToPersist: decision.identityKey };
  }
  // Exhaustiveness guard (#5978): adding a KeyPinDecision variant without
  // handling it above is a compile error here. At runtime (e.g. a version-skew
  // discriminator that bypasses the compiler) fail CLOSED — refuse rather than
  // return the raw object, which has no `refused` field and would make callers
  // silently proceed without a pin.
  const _exhaustive: never = decision;
  void _exhaustive;
  return { refused: true };
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
        // #6543 (feature B): the server's advertised capability map (`{ ide, … }`),
        // parsed from `msg.capabilities` by the shared handleAuthOk. Gates the
        // mobile pre-write-diff review, mirroring the dashboard's serverCapabilities.
        serverCapabilities: auth.serverCapabilities,
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
          const verdict = verifyServerIdentityOrRefuse(ctx, auth.serverPublicKey, auth.serverKeySig, auth.newIdentityKey, auth.rotationCert);
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
        const { publicKey: serverPublicKey, serverKeySig, newIdentityKey, rotationCert } = sharedKeyExchangeOk(msg);
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
        const verdict = verifyServerIdentityOrRefuse(ctx, serverPublicKey, serverKeySig, newIdentityKey, rotationCert);
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
            // #6302 — clear the pending-turn owner alongside the sentinel so a
            // stale owner can't mis-gate a later reconcile (parity with the
            // dashboard's input_conflict teardown).
            pendingClientMessageId:
              ss.streamingMessageId === 'pending' ? null : ss.pendingClientMessageId,
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

    // session_stopped — migrated to the shared dispatch table (#5618 Batch 3;
    // handled by runDispatch before this switch). Sets stoppedAt/stoppedCode on
    // the target session; the app deliberately shows NO toast (#4879), so it
    // omits the `addInfoNotification` adapter hook the dashboard supplies.

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
      // #6756 — a thinking stream_start opens a reasoning bubble on a distinct
      // id. Route to the thinking handler (does NOT touch streamingMessageId —
      // the 'pending' sentinel / response stream own the turn's busy state).
      if (msg.thinking === true) {
        const thinkingTargetId = (msg.sessionId as string) || get().activeSessionId;
        if (thinkingTargetId && get().sessionStates[thinkingTargetId]) {
          updateSession(thinkingTargetId, (ss) => {
            const out = sharedThinkingStart(msg, get().activeSessionId, ss.messages);
            if (!out.isNewMessage || !out.newMessage) return {};
            return { messages: [...filterThinking(ss.messages), out.newMessage] };
          });
        }
        break;
      }
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, (ss) => {
          const out = sharedStreamStart(msg, get().activeSessionId, ss.messages);
          if (out.remap) {
            _ctx.deltaIdRemaps.set(out.remap.from, out.remap.to);
          }
          if (!out.isNewMessage) {
            // Reuse existing response message (reconnect replay dedup). #6302 —
            // the 'pending' sentinel has now been adopted by a real stream id, so
            // null the faked-fresh-turn owner to keep the invariant (owner is
            // non-null only while streamingMessageId === 'pending').
            return { streamingMessageId: out.streamingMessageId, pendingClientMessageId: null };
          }
          // #5938 — insert the new assistant message BEFORE any trailing queued
          // follow-up bubbles. A message queued during the pending window (before
          // this stream_start) was appended at the end; without this it would sit
          // ABOVE the response it precedes (wrong chronology) and stay there after
          // flush. Queue-aware only: with no queued bubbles the index is the array
          // end, so the result is byte-identical to the plain append.
          const base = filterThinking(ss.messages);
          const queuedIdSet = new Set(
            (ss.queuedMessages ?? [])
              .map((q) => q.clientMessageId)
              .filter((id): id is string => !!id),
          );
          let insertAt = base.length;
          while (insertAt > 0 && queuedIdSet.has(base[insertAt - 1].id)) insertAt--;
          return {
            streamingMessageId: out.streamingMessageId,
            // #6302 — real id adopts the turn; clear the faked-fresh-turn owner.
            pendingClientMessageId: null,
            messages: [...base.slice(0, insertAt), out.newMessage!, ...base.slice(insertAt)],
          };
        });
      }
      break;
    }

    case 'stream_delta': {
      // #6756 — a thinking stream_delta accumulates reasoning content onto the
      // thinking bubble (lazy-created if its stream_start was missed).
      if (msg.thinking === true) {
        const payload = sharedThinkingDelta(msg, get().activeSessionId);
        if (payload) {
          const thinkingTargetId = payload.sessionId;
          if (thinkingTargetId && get().sessionStates[thinkingTargetId]) {
            updateSession(thinkingTargetId, (ss) => {
              const next = payload.applyTo(ss.messages);
              return next === ss.messages ? {} : { messages: next };
            });
          }
        }
        break;
      }
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
      // #6756 — a thinking stream_end finalises the reasoning bubble's label
      // ("Thinking…" → "Thought") without touching the response stream state.
      if (msg.thinking === true) {
        const payload = sharedThinkingEnd(msg, get().activeSessionId);
        const thinkingTargetId = payload.sessionId;
        if (thinkingTargetId && get().sessionStates[thinkingTargetId]) {
          updateSession(thinkingTargetId, (ss) => {
            const next = payload.applyTo(ss.messages);
            return next === ss.messages ? {} : { messages: next };
          });
        }
        break;
      }
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
          // #6756 — turn-boundary backstop: finalise any thinking bubble whose
          // own thinking stream_end was dropped so it can't be stuck on
          // "Thinking…".
          updateSession(targetId, (ss) => ({
            streamingMessageId: null,
            messages: finalizeThinkingStreams([...ss.messages]),
          }));
        } else {
          updateActiveSession((ss) => ({
            streamingMessageId: null,
            messages: finalizeThinkingStreams([...ss.messages]),
          }));
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
            // #6302 — a tool-led turn just adopted the 'pending' sentinel with a
            // real id, so clear the faked-fresh-turn owner (it never queued).
            patch.pendingClientMessageId = null;
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
        // #6769: the occupancy snapshot PERSISTS across turns — only a result
        // that carries a new snapshot moves it (including DOWN after a
        // compaction). A result without one keeps the last value rather than
        // blanking the meter.
        ...(normalized.contextOccupancy
          ? { contextOccupancy: normalized.contextOccupancy }
          : {}),
        lastResultCost: normalized.lastResultCost,
        lastResultDuration: normalized.lastResultDuration,
      };
      const targetId = normalized.sessionId;
      // #6627 — reconcile the queue against the result's authoritative queueLength
      // so a stale "Queued" bubble (from a dropped/late message_dequeued) self-heals
      // on this turn boundary. Null when the server sent no queueLength (older).
      const queueReconcile = handleResultQueueReconcile(msg, get().activeSessionId);
      // Notify if a background session just finished (was streaming)
      if (targetId && get().sessionStates[targetId]?.streamingMessageId) {
        pushSessionNotification(targetId, 'completed', 'Task completed');
      }
      {
        const effectiveId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
        if (effectiveId && get().sessionStates[effectiveId]) {
          // Force a new messages array reference so selectors detect the change,
          // even when flushPendingDeltas() was a no-op (timer already flushed).
          updateSession(effectiveId, (ss) => {
            // #6627 — reconcile the queue on the turn boundary so a stale "Queued"
            // bubble (dropped/late message_dequeued) self-heals. Apply only for a
            // LIVE, OWN-session result: skip during replay (stale queueLength) and
            // when effectiveId fell back to the active session (effectiveId !==
            // targetId → the queueLength is from a different session) — matching
            // the dashboard's targetId-scoped gate. Only patch queuedMessages when
            // the reconcile actually trimmed an orphan (referential no-op otherwise
            // → no needless write/rerender every turn).
            const currentQueue = ss.queuedMessages ?? [];
            const reconciledQueue =
              queueReconcile && effectiveId === targetId && !_ctx.replayingSessions.has(effectiveId)
                ? queueReconcile.applyTo(currentQueue).queuedMessages
                : currentQueue;
            return {
              ...resultPatch,
              // #6756 — `result` is the guaranteed turn boundary; finalise any
              // thinking bubble whose own stream_end was dropped.
              messages: finalizeThinkingStreams([...ss.messages]),
              ...(reconciledQueue !== currentQueue ? { queuedMessages: reconciledQueue } : {}),
            };
          });
        }
      }
      break;
    }

    // #5618 — model_changed migrated to the shared store-core dispatch table
    // (runDispatch handles it before this switch). Removed from here.

    // available_models — migrated to the shared dispatch table (#5618 Batch 5a;
    // handled by runDispatch before this switch). Non-array payloads are a no-op
    // that preserves the existing list. The app omits the dashboard-only
    // availableModelsProvider extension.


    // permission_mode_changed — migrated to the shared dispatch table (#5618;
    // runDispatch). Now uses targetId-direct resolution (Decision A) instead of the
    // app's prior effectiveId-retry; the app's clearPendingPermissionModeRequests is
    // preserved via the _dispatchAdapter hook, and pendingPermissionConfirm is cleared
    // via setState. Behaviour is unchanged in normal operation (sessionStates always
    // holds the target session) — see dispatchPermissionModeChanged for the rationale.

    // confirm_permission_mode — migrated to the shared dispatch table (#5556)


    // available_permission_modes — migrated to the shared dispatch table (#5556)


    // raw — migrated to the shared dispatch table (#6449 slice 1; runDispatch
    // handles it before this switch, via the appendTerminalData adapter hook).

    // terminal_output — migrated to the shared dispatch table (#6449 slice 1).
    // The live-PTY active-session guard (drop a stale frame whose sessionId isn't
    // the active session) now lives in dispatchTerminalOutput, byte-identical.

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

    // agent_idle — migrated to the shared dispatch table (#5618; handled by
    // runDispatch before this switch). The app has no flat idle fallback (it
    // derives isIdle from the active session), so it omits the
    // applyNoSessionFallback adapter hook — behaviour unchanged.

    // agent_busy — migrated to the shared dispatch table (#5556)


    // agent_spawned / agent_completed / agent_event / background_work_changed /
    // plan_started — migrated to the shared dispatch table (#5556 slice 2)

    // plan_ready — migrated to the shared dispatch table (#5618; runDispatch). The
    // app's plan session-notification rides the optional notifyPlanReady adapter hook.

    // inactivity_warning — migrated to the shared dispatch table (#5556 slice 2)

    // raw_background — migrated to the shared dispatch table (#6449 slice 1).

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
        // #6771 — "Always allow (project)" persists a durable per-project rule
        // (server-side), gated on the same session-rule provider support.
        ...(providerSupportsRules ? [{ label: 'Always allow (project)', value: 'allowAlways' }] : []),
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
        // #6559 — prune the pulled pre-write-diff input for this now-resolved
        // prompt. permissionInputs is append-only otherwise and grows unbounded
        // over a long session. Guard the copy-delete so a prompt that never
        // pulled input (the common case) doesn't churn a new object.
        set((s) => {
          if (!s.permissionInputs || !Object.prototype.hasOwnProperty.call(s.permissionInputs, resolvedRequestId)) return {};
          const next = { ...s.permissionInputs };
          delete next[resolvedRequestId];
          return { permissionInputs: next };
        });
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
        // #6559 — prune the pulled input for an expired prompt too.
        set((s) => {
          if (!s.permissionInputs || !Object.prototype.hasOwnProperty.call(s.permissionInputs, expiredRequestId)) return {};
          const next = { ...s.permissionInputs };
          delete next[expiredRequestId];
          return { permissionInputs: next };
        });
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
        // #6559 — prune the pulled input for a timed-out prompt too.
        set((s) => {
          if (!s.permissionInputs || !Object.prototype.hasOwnProperty.call(s.permissionInputs, timeoutRequestId)) return {};
          const next = { ...s.permissionInputs };
          delete next[timeoutRequestId];
          return { permissionInputs: next };
        });
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


    // user_question — migrated to the shared dispatch table (#5618)

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

    // rate_limited (#6334) — migrated to the shared dispatch table (#5618;
    // runDispatch). Byte-identical active-session notice; no per-client hook.

    // server_shutdown — migrated to the shared dispatch table (#5618; runDispatch).
    // The app's setShutdown notification rides the optional applyShutdownNotification hook.

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

    // primary_changed / session_role / client_focus_changed — migrated to the
    // shared dispatch table (#5618 Batch 4; handled by runDispatch before this
    // switch). The app's multi-client presence state (useMultiClientStore) is
    // reached through the getMyClientId / getFollowMode / switchSession /
    // setPrimaryClientId adapter hooks, so the three cases are now fully shared.

    // directory_listing / file_listing / file_content / write_file_result /
    // diff_result / git_status_result / git_branches_result / git_stage_result /
    // git_unstage_result / git_commit_result — migrated to the shared dispatch
    // table (#5556 slice 3 / #5653). Each was the same `getCallback(name) →
    // shared*(msg) → cb(payload)` wrapper; the table now parses and invokes the
    // imperative callback via `_dispatchAdapter.getCallback`.

    // slash_commands / agent_list / provider_list — migrated to the shared
    // dispatch table (#5618 Batch 2; handled by runDispatch before this switch).
    // The app's secondary-conversation-store mirror (slash/agents) and
    // mapProviderList tightening now ride on the `syncSecondaryInventory` /
    // `mapProviderList` adapter hooks (auth_bootstrap, which folds the same lists
    // into one connect-time frame, was migrated in #5618 Batch 5b — see below).

    // auth_bootstrap / tunnel_url_changed — migrated to the shared dispatch table
    // (#5618 Batch 5b; handled by runDispatch before this switch). auth_bootstrap
    // reuses the Batch 2 mapProviderList + syncSecondaryInventory hooks and the
    // new applyRotatedTunnelUrl hook (session-scope guard preserved);
    // tunnel_url_changed's apply rides on applyRotatedTunnelUrl alone.

    // session_restore_failed / session_persist_failed — migrated to the shared
    // dispatch table (#5618 Batch 3; handled by runDispatch before this switch).
    // Both surface a recoverable error via the `addServerError` adapter hook (the
    // app builds the structured ServerError + ring + notification-store mirror);
    // the shared handlers own the message construction + console.warn.

    // checkpoint_created / checkpoint_list — migrated to the shared dispatch
    // table (#5618 Batch 6; handled by runDispatch before this switch). The
    // app's secondary conversation-store mirror (addCheckpoint / setCheckpoints)
    // now rides on the `syncSecondaryCheckpoints` adapter hook below; the
    // dashboard omits that hook (no secondary checkpoint store).

    // checkpoint_restored — migrated to the shared dispatch table (#5618; runDispatch).
    // The auto-switch (with the app's no-notify/no-haptic opts) rides the required
    // switchToRestoredSession adapter hook.

    // mcp_servers — migrated to the shared dispatch table (#5556 slice 2)

    // cost_update — migrated to the shared dispatch table (#5618 Batch 5a;
    // handled by runDispatch before this switch). The shared per-session
    // sessionCost patch runs in the table; the app's flat totalCost/costBudget +
    // useCostStore dual-write ride on the `setCostUpdate` adapter hook.

    // session_usage / session_cost_threshold_crossed — migrated to the shared
    // dispatch table (#5556 slice 2)

    // budget_warning — migrated to the shared dispatch table (#5618; runDispatch).
    // The alert rides the new adapter.alert primitive; routing is byte-identical.

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

    // conversations_list — migrated to the shared dispatch table (#5618; runDispatch).
    // The app's error-clear + useConversationStore mirror ride the optional
    // applyConversationsListExtras adapter hook.

    // search_results — migrated to the shared dispatch table (#5618; runDispatch).
    // The staleness gate reads searchQuery via getSearchQuery; the app's searchError
    // clear + useConversationStore mirror ride the optional applySearchResultsExtras hook.

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
          // #6302 — clearing the stream tears down any faked-fresh turn; drop its
          // owner so a stale id can't linger past the 'pending' window.
          pendingClientMessageId: null,
        }));
      } else {
        const activeErrId = get().activeSessionId;
        if (activeErrId && get().sessionStates[activeErrId]) {
          updateActiveSession((ss) => ({
            messages: filterThinking([...ss.messages, errorMsg]),
            streamingMessageId: null,
            pendingClientMessageId: null,
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

    // #5163 (epic #5159) / #6246 — Control Room `activity_snapshot`: REPLACE the
    // target session's activity tree with the snapshot's entries via the
    // store-core reducer. Emitted on subscribe / resync so a late-joining or
    // reconnecting client reaches canonical state in one message. The wire shape
    // is validated with the protocol Zod schema (same defensive pattern as the
    // dashboard feeder) so a malformed payload is dropped rather than crashing
    // the reducer. `applyActivitySnapshot` always builds a fresh state, so the
    // `next === prev` guard below is a harmless defensive no-op here (it's the
    // live short-circuit for activity_delta, whose reducer returns the SAME ref
    // on a no-op); kept for symmetry with the delta case + the dashboard feeder.
    // This makes #6245's read-only MissionControlScreen go live.
    // #6543 (IDE P3 feature B) — `permission_input`: store the pulled full
    // (secret-redacted) tool input keyed by requestId so the mobile permission
    // prompt can build a per-hunk pre-write diff. Zod-validated (drop-on-
    // malformed). Both `found:true` (carries `input`/`tool`) and `found:false`
    // (carries `error`) are stored — the UI distinguishes "not fetched" (absent)
    // from "unavailable" (found:false). Mirrors the dashboard handler.
    case 'permission_input': {
      const parsed = ServerPermissionInputSchema.safeParse(msg);
      if (!parsed.success) return;
      set({ permissionInputs: { ...get().permissionInputs, [parsed.data.requestId]: parsed.data } });
      return;
    }

    case 'activity_snapshot': {
      const parsed = ServerActivitySnapshotSchema.safeParse(msg);
      if (!parsed.success) return;
      const prev = get().activity;
      const next = applyActivitySnapshot(prev, parsed.data);
      if (next === prev) return;
      set({ activity: next });
      return;
    }

    // #5163 (epic #5159) / #6246 — Control Room `activity_delta`: upsert the
    // carried entry into its session by id. `op` is advisory — the full entry
    // drives the result, so a dropped earlier delta is self-healed by the next
    // one. Validated + `next === prev` no-op-short-circuited like the snapshot
    // case above.
    case 'activity_delta': {
      const parsed = ServerActivityDeltaSchema.safeParse(msg);
      if (!parsed.success) return;
      const prev = get().activity;
      const next = applyActivityDelta(prev, parsed.data);
      if (next === prev) return;
      set({ activity: next });
      // #6248 — a delta is a genuine live state change (a background shell /
      // subagent / tool started, progressed, or ended), so it counts as
      // activity: bump `lastClientActivityAt` and clear any `inactivityWarning`
      // for the delta's session, mirroring the dashboard feeder + the app's
      // `isActivityEvent` bump (activity_delta isn't in ACTIVITY_EVENT_TYPES, so
      // it's done here). Gated on `replayingSessions` exactly like that bump so a
      // session-switch history replay doesn't reset the "Working… last activity
      // Ns ago" timestamp (#4512). activity_snapshot deliberately does NOT bump —
      // it's a full-state resync on subscribe/reconnect, not fresh work.
      const deltaSid = parsed.data.sessionId;
      if (get().sessionStates[deltaSid] && !_ctx.replayingSessions.has(deltaSid)) {
        updateSession(deltaSid, (ss) => {
          const patch: Partial<SessionState> = { lastClientActivityAt: Date.now() };
          if (ss.inactivityWarning) patch.inactivityWarning = null;
          return patch;
        });
      }
      return;
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
