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
  handleAvailablePermissionModes as sharedAvailablePermissionModes,
  handleSessionUpdated as sharedSessionUpdated,
  handleConfirmPermissionMode as sharedConfirmPermissionMode,
  handleClaudeReady as sharedClaudeReady,
  handleAgentIdle as sharedAgentIdle,
  handleAgentBusy as sharedAgentBusy,
  handleThinkingLevelChanged as sharedThinkingLevelChanged,
  handleBudgetWarning as sharedBudgetWarning,
  handleBudgetExceeded as sharedBudgetExceeded,
  handleBudgetResumed as sharedBudgetResumed,
  handlePlanStarted as sharedPlanStarted,
  handlePlanReady as sharedPlanReady,
  handleInactivityWarning as sharedInactivityWarning,
  handleMultiQuestionIntervention as sharedMultiQuestionIntervention,
  applyInterventionBuilder,
  handleDevPreview as sharedDevPreview,
  handleDevPreviewStopped as sharedDevPreviewStopped,
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
  handleClientFocusChanged as sharedClientFocusChanged,
  handleConversationId as sharedConversationId,
  handleConversationsList as sharedConversationsList,
  handleHistoryReplayStart as sharedHistoryReplayStart,
  handleHistoryReplayEnd as sharedHistoryReplayEnd,
  handlePermissionRequest as sharedPermissionRequest,
  handlePermissionResolved as sharedPermissionResolved,
  handlePermissionExpired as sharedPermissionExpired,
  handlePermissionTimeout as sharedPermissionTimeout,
  handlePermissionRulesUpdated as sharedPermissionRulesUpdated,
  // #5454 — remaining both-sides duplicates extracted into store-core
  handleRawOutput as sharedRawOutput,
  handleTokenRotated as sharedTokenRotated,
  handlePairFail as sharedPairFail,
  handleSessionCostThresholdCrossed as sharedSessionCostThresholdCrossed,
  // (no handleNotificationPrefs import — the app keeps notification_prefs
  // inline; the #4542/#4544 source-shape tests pin that implementation)
  // #5454 — pure core of the #554 stream-split block (permission_request)
  resolvePermissionStreamSplit,
  handleDirectoryListing as sharedDirectoryListing,
  handleFileListing as sharedFileListing,
  handleFileContent as sharedFileContent,
  handleWriteFileResult as sharedWriteFileResult,
  buildSessionListPatches as sharedBuildSessionListPatches,
  cumulativeUsageEquals as sharedCumulativeUsageEquals,
  chunkSubscribeSessionIds as sharedChunkSubscribeSessionIds,
  SESSION_LIST_SUBSCRIBE_CHUNK_SIZE,
  handleSessionContext as sharedSessionContext,
  handleSessionTimeout as sharedSessionTimeout,
  handleSessionRestoreFailed as sharedSessionRestoreFailed,
  handleSessionWarning as sharedSessionWarning,
  handleSessionSwitched as sharedSessionSwitched,
  handleSlashCommands as sharedSlashCommands,
  handleAgentList as sharedAgentList,
  handleProviderList as sharedProviderList,
  handleDiffResult as sharedDiffResult,
  handleGitStatusResult as sharedGitStatusResult,
  handleGitBranchesResult as sharedGitBranchesResult,
  handleGitStageResult as sharedGitStageResult,
  handleGitCommitResult as sharedGitCommitResult,
  handleAgentSpawned as sharedAgentSpawned,
  handleAgentCompleted as sharedAgentCompleted,
  handleBackgroundWorkChanged as sharedBackgroundWorkChanged,
  // #5060 — Task subagent intermediate progress. Appends one entry to
  // the parent Task tool_use bubble's `childAgentEvents[]`; the shared
  // builder is the same one the dashboard uses so the two platforms
  // can't drift on routing.
  handleAgentEvent as sharedAgentEvent,
  handleAvailableModels as sharedAvailableModels,
  handleMcpServers as sharedMcpServers,
  handleCostUpdate as sharedCostUpdate,
  handleSessionUsage as sharedSessionUsage,
  handleResultUsage as sharedResultUsage,
  handleServerError as sharedServerError,
  handleServerShutdown as sharedServerShutdown,
  handleServerStatusLegacy as sharedServerStatusLegacy,
  handleWebTaskUpsert as sharedWebTaskUpsert,
  handleWebTaskError as sharedWebTaskError,
  handleWebTaskList as sharedWebTaskList,
  handleWebFeatureStatus as sharedWebFeatureStatus,
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
  splitRtt,
  // #5516 (epic #5514): adaptive client delta-flush interval.
  resolveDeltaFlushMs,
} from '@chroxy/store-core';
import { PROTOCOL_VERSION } from '@chroxy/protocol';
import { ServerNotificationPrefsSchema } from '@chroxy/protocol/schemas';
import { hapticSuccess } from '../utils/haptics';
import type {
  ChatMessage,
  Checkpoint,
  ConnectionContext,
  ConnectionState,
  CustomAgent,
  DirectoryEntry,
  FileEntry,
  McpServer,
  QueuedMessage,
  ServerError,
  SessionInfo,
  SessionNotification,
  SessionState,
  SlashCommand,
  ProviderInfo,
  ConversationSummary,
  WebTask,
  PermissionRule,
} from './types';
import { createEmptySessionState } from './utils';
import { deriveActivityState } from './session-activity';
import { clearPersistedSession, persistLastConversationId, loadLastConversationId } from './persistence';
import { getCallback } from './imperative-callbacks';
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

  // Client-side heartbeat
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  pongTimeout: ReturnType<typeof setTimeout> | null;
  lastPingSentAt: number;
  ewmaRtt: number | null;

  // Delta batching
  pendingDeltas: Map<string, { sessionId: string | null; delta: string }>;
  deltaFlushTimer: ReturnType<typeof setTimeout> | null;

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
}

function createDefaultContext(): MessageHandlerContext {
  return {
    ...INITIAL_ENCRYPTION_CONTEXT,
    replayingSessions: new Set<string>(),
    isSessionSwitchReplay: false,
    pendingSwitchSessionId: null,
    postPermissionSplits: new Set<string>(),
    deltaIdRemaps: new Map<string, string>(),
    pendingTerminalWrites: '',
    terminalWriteTimer: null,
    heartbeatInterval: null,
    pongTimeout: null,
    lastPingSentAt: 0,
    ewmaRtt: null,
    pendingDeltas: new Map<string, { sessionId: string | null; delta: string }>(),
    deltaFlushTimer: null,
    deltaServerTs: new Map<string, { serverTs: number; recvAt: number }>(),
    tokenToRender: new RollingPercentiles(200),
    clientRender: new RollingPercentiles(200),
    lastLatencyLogAt: 0,
    messageQueue: [],
  };
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
  if (_ctx.heartbeatInterval) clearInterval(_ctx.heartbeatInterval);
  if (_ctx.pongTimeout) clearTimeout(_ctx.pongTimeout);
  if (_ctx.deltaFlushTimer) clearTimeout(_ctx.deltaFlushTimer);
  _ctx = createDefaultContext();
  _pendingPermissionModeRequests.clear();
  // Reset connection-attempt tracking (kept as export let for live-binding semantics)
  connectionAttemptId = 0;
  disconnectedAttemptId = -1;
  lastConnectedUrl = null;
  pendingPairingId = null;
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

// ---------------------------------------------------------------------------
// Connection attempt tracking
// These are kept as export let (not in _ctx) to preserve ES module live-binding
// semantics: connection.ts snapshots the value and later compares against the
// live export to detect stale connection attempts.
// ---------------------------------------------------------------------------
export let connectionAttemptId = 0;
export let disconnectedAttemptId = -1;
export let lastConnectedUrl: string | null = null;

export function bumpConnectionAttemptId(): number {
  return ++connectionAttemptId;
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
const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 5_000;
const EWMA_ALPHA = 0.3; // Weight for new samples (higher = more responsive)
// #5515 (epic #5514): throttle the dev latency readout so a streaming turn
// can't spam the console — one line every few seconds is enough to watch the
// numbers move when flush intervals are tuned.
const LATENCY_LOG_INTERVAL_MS = 3_000;

// #5516 (epic #5514): adaptive delta-flush interval. Production reads the
// current EWMA RTT and adapts (16-33ms cheap → 100ms poor) via
// `resolveDeltaFlushMs`. Tests pin it to a constant by calling
// `setDeltaFlushIntervalOverride(N)`; `null` (the default) restores adaptive
// behavior. Kept testable per the issue's "constant override testable" ask.
let _deltaFlushOverrideMs: number | null = null;
export function setDeltaFlushIntervalOverride(ms: number | null): void {
  _deltaFlushOverrideMs = ms;
}
function currentDeltaFlushMs(): number {
  return _deltaFlushOverrideMs != null
    ? _deltaFlushOverrideMs
    : resolveDeltaFlushMs(_ctx.ewmaRtt);
}

export function stopHeartbeat(): void {
  if (_ctx.heartbeatInterval) { clearInterval(_ctx.heartbeatInterval); _ctx.heartbeatInterval = null; }
  if (_ctx.pongTimeout) { clearTimeout(_ctx.pongTimeout); _ctx.pongTimeout = null; }
  _ctx.lastPingSentAt = 0;
  _ctx.ewmaRtt = null; // Reset smoothed RTT on disconnect
}

export function startHeartbeat(socket: WebSocket): void {
  stopHeartbeat();
  _ctx.heartbeatInterval = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) { stopHeartbeat(); return; }
    try {
      _ctx.lastPingSentAt = Date.now();
      wsSend(socket, { type: 'ping' });
    } catch { stopHeartbeat(); return; }
    _ctx.pongTimeout = setTimeout(() => {
      console.warn('[ws] Heartbeat pong timeout — closing dead connection');
      stopHeartbeat();
      try { socket.close(); } catch {}
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function _onPong(serverTs?: number): void {
  if (_ctx.pongTimeout) { clearTimeout(_ctx.pongTimeout); _ctx.pongTimeout = null; }
  // Measure RTT and update connection quality using EWMA for stability
  if (_ctx.lastPingSentAt > 0) {
    const pongRecvAt = Date.now();
    const rttMs = pongRecvAt - _ctx.lastPingSentAt;
    // EWMA: smoothed = alpha * new + (1 - alpha) * prev (first sample bootstraps)
    _ctx.ewmaRtt = _ctx.ewmaRtt === null ? rttMs : EWMA_ALPHA * rttMs + (1 - EWMA_ALPHA) * _ctx.ewmaRtt;
    const smoothed = Math.round(_ctx.ewmaRtt);
    const quality: 'good' | 'fair' | 'poor' = smoothed < 200 ? 'good' : smoothed < 500 ? 'fair' : 'poor';
    useConnectionLifecycleStore.getState().setConnectionQuality(smoothed, quality);

    // #5515 (epic #5514): split this RTT into approximate uplink/downlink
    // halves using the server-stamped serverTs. The split is positioned within
    // the locally-measured [ping,pong] interval (skew-clamped), so it stays
    // sane even with clock skew — see store-core/latency-stats. Dev-only log,
    // throttled by the same window as token-to-render.
    const split = splitRtt({ pingSentAt: _ctx.lastPingSentAt, pongRecvAt, serverTs });
    if (split.uplinkMs !== null && pongRecvAt - _ctx.lastLatencyLogAt >= LATENCY_LOG_INTERVAL_MS) {
      _ctx.lastLatencyLogAt = pongRecvAt;
      console.log(`[latency] rtt=${split.rttMs}ms split≈ up ${split.uplinkMs}ms / down ${split.downlinkMs}ms (approx, clock-skew)`);
    }
    _ctx.lastPingSentAt = 0;
  }
}

// ---------------------------------------------------------------------------
// Delta batching
// ---------------------------------------------------------------------------
function flushPendingDeltas(): void {
  _ctx.deltaFlushTimer = null;
  if (_ctx.pendingDeltas.size === 0) return;
  const updates = new Map(_ctx.pendingDeltas);
  _ctx.pendingDeltas.clear();

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
  if (_ctx.deltaFlushTimer) {
    clearTimeout(_ctx.deltaFlushTimer);
    _ctx.deltaFlushTimer = null;
  }
  _ctx.pendingDeltas.clear();
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
  permission_response: 300_000,
  user_question_response: 60_000,
};
const QUEUE_MAX_SIZE = 10;
const QUEUE_EXCLUDED = new Set(['set_model', 'set_permission_mode', 'mode', 'resize']);

export function enqueueMessage(type: string, payload: unknown): 'queued' | false {
  if (QUEUE_EXCLUDED.has(type)) return false;
  const maxAge = QUEUE_TTLS[type];
  if (!maxAge) return false;
  if (_ctx.messageQueue.length >= QUEUE_MAX_SIZE) return false;
  _ctx.messageQueue.push({ type, payload, queuedAt: Date.now(), maxAge });
  console.log(`[queue] Queued ${type} (${_ctx.messageQueue.length}/${QUEUE_MAX_SIZE})`);
  return 'queued';
}

export function drainMessageQueue(socket: WebSocket): void {
  if (_ctx.messageQueue.length === 0) return;
  const now = Date.now();
  const valid = _ctx.messageQueue.filter((m) => now - m.queuedAt < m.maxAge);
  _ctx.messageQueue.length = 0;
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

const STORAGE_KEY_URL = 'chroxy_last_url';
const STORAGE_KEY_TOKEN = 'chroxy_last_token';
// #5518 — dual-endpoint metadata (LAN candidate + verification + tunnel URL)
// kept in a separate JSON blob so the legacy url/token keys stay byte-for-byte
// compatible with pre-#5518 builds.
const STORAGE_KEY_LAN_META = 'chroxy_last_lan_meta';

/** Optional dual-endpoint fields persisted alongside the legacy url+token. */
export type SavedConnectionExtras = Pick<SavedConnection, 'lanUrl' | 'lanVerified' | 'tunnelUrl'>;

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
export function persistVerifiedConnection(connectedUrl: string, token: string): void {
  const prev = useConnectionLifecycleStore.getState().savedConnection;
  const base: SavedConnection = prev?.token === token && prev
    ? prev
    : { url: connectedUrl, token };
  const next = recordVerifiedLanCandidate(base, connectedUrl, token);
  // `url` tracks the last-dialed endpoint for backward compat / manual flows.
  next.url = connectedUrl;
  void saveConnection(next.url, next.token, {
    lanUrl: next.lanUrl,
    lanVerified: next.lanVerified,
    tunnelUrl: next.tunnelUrl,
  });
  useConnectionLifecycleStore.getState().setSavedConnection(next);
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

  switch (msg.type) {
    case 'pong':
      _onPong(typeof msg.serverTs === 'number' ? msg.serverTs : undefined);
      return;

    case 'auth_ok': {
      // Reset replay flags — fresh auth means clean slate (#4512: clear the
      // per-session replaying set so a reconnect doesn't leave stale ids
      // gating future activity bumps).
      _ctx.replayingSessions.clear();
      _ctx.isSessionSwitchReplay = false;
      _ctx.pendingSwitchSessionId = null;
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

      // Start client-side heartbeat for dead connection detection
      startHeartbeat(ctx.socket);

      // Initiate key exchange if server requires encryption
      if (auth.encryption === 'required') {
        _ctx.pendingKeyPair = createKeyPair();
        _ctx.pendingSalt = generateConnectionSalt();
        // Send key_exchange plaintext (before encryption is active)
        ctx.socket.send(JSON.stringify({ type: 'key_exchange', publicKey: _ctx.pendingKeyPair.publicKey, salt: _ctx.pendingSalt }));
        // Post-auth messages will be sent after key_exchange_ok arrives
        useConnectionLifecycleStore.getState().setServerInfo({ isEncrypted: true });
      } else {
        // No encryption — send post-auth messages immediately
        wsSend(ctx.socket, { type: 'list_providers' });
        wsSend(ctx.socket, { type: 'list_slash_commands' });
        wsSend(ctx.socket, { type: 'list_agents' });
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
      persistVerifiedConnection(ctx.url, effectiveToken);
      // Register push token (async, non-blocking)
      void registerPushToken(ctx.socket);
      break;
    }

    case 'key_exchange_ok': {
      if (_ctx.pendingKeyPair) {
        const { publicKey: serverPublicKey } = sharedKeyExchangeOk(msg);
        if (!serverPublicKey) {
          console.error('[crypto] Invalid publicKey in key_exchange_ok message', msg.publicKey);
          ctx.socket.close();
          set({ socket: null });
          useConnectionLifecycleStore.getState().setConnectionPhase('disconnected');
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
        // Now send the post-auth messages that were deferred
        wsSend(ctx.socket, { type: 'list_providers' });
        wsSend(ctx.socket, { type: 'list_slash_commands' });
        wsSend(ctx.socket, { type: 'list_agents' });
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

    case 'session_updated': {
      const updated = sharedSessionUpdated(msg, get().sessions);
      if (updated) {
        set({ sessions: updated });
      }
      break;
    }

    case 'subscriptions_updated': {
      // Server confirms which sessions we're subscribed to — log for debugging
      const subIds = Array.isArray(msg.subscribedSessionIds) ? msg.subscribedSessionIds : [];
      if (__DEV__) {
        console.log('[ws] subscriptions_updated:', subIds.length, 'sessions');
      }
      break;
    }

    case 'session_context': {
      const { sessionId: ctxSessionId, patch } = sharedSessionContext(msg, get().activeSessionId);
      if (ctxSessionId && get().sessionStates[ctxSessionId]) {
        updateSession(ctxSessionId, () => patch);
      }
      break;
    }

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

    case 'conversation_id': {
      // Parser is shared via store-core; the session-existence guard and the
      // updateSession call stay here. Note: this handler does NOT fall back
      // to activeSessionId — a missing sessionId skips the patch entirely.
      const { sessionId: convSessionId, conversationId } = sharedConversationId(msg);
      if (convSessionId && get().sessionStates[convSessionId]) {
        updateSession(convSessionId, () => ({ conversationId }));
      }
      break;
    }

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
      const { fullHistory, sessionId: replayTargetId } = sharedHistoryReplayStart(
        msg,
        get().activeSessionId,
      );
      // #4512 — track per-session. Falls back to activeSessionId via
      // sharedHistoryReplayStart, matching the gate's targetId resolution.
      if (replayTargetId) _ctx.replayingSessions.add(replayTargetId);
      // Full history replay (from request_full_history): clear messages before replay
      if (fullHistory) {
        _ctx.isSessionSwitchReplay = true;
        if (replayTargetId && get().sessionStates[replayTargetId]) {
          updateSession(replayTargetId, () => ({ messages: [] }));
        }
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
      const cached = getSessionMessages(targetId);
      // #4512 — dedup against history only when THIS message's session is
      // currently replaying. A per-connection boolean would suppress live
      // messages for session B while A replays.
      const messageIsReplay = targetId ? _ctx.replayingSessions.has(targetId) : false;
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
        pendingDeltas: _ctx.pendingDeltas,
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

        scheduleFlush: () => {
          if (!_ctx.deltaFlushTimer) {
            // #5516 — adaptive interval (was a fixed 100ms). Memoized bubbles
            // (step 1) make the tighter flush cheap: only the tail re-renders.
            _ctx.deltaFlushTimer = setTimeout(flushPendingDeltas, currentDeltaFlushMs());
          }
        },
      });
      break;
    }

    case 'stream_end':
      // Flush any buffered deltas immediately before clearing streaming state
      if (_ctx.deltaFlushTimer) {
        clearTimeout(_ctx.deltaFlushTimer);
      }
      flushPendingDeltas();
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
      const cached = getSessionMessages(targetId);
      // #4512 — dedup against the cached history only when THIS message's
      // session is currently replaying. A per-connection boolean would
      // wrongly suppress live tool_start broadcasts for session B while A
      // is replaying.
      const toolStartIsReplay = targetId ? _ctx.replayingSessions.has(targetId) : false;
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
      if (_ctx.deltaFlushTimer) {
        clearTimeout(_ctx.deltaFlushTimer);
      }
      flushPendingDeltas();
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

    case 'confirm_permission_mode': {
      const pending = sharedConfirmPermissionMode(msg);
      if (pending) {
        set({ pendingPermissionConfirm: pending });
      }
      break;
    }

    case 'available_permission_modes': {
      const modes = sharedAvailablePermissionModes(msg);
      if (modes) {
        set({ availablePermissionModes: modes });
      }
      break;
    }

    case 'raw': {
      const { data: rawData } = sharedRawOutput(msg);
      get().appendTerminalData(rawData);
      useTerminalStore.getState().appendTerminalData(rawData);
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

    case 'agent_busy': {
      const targetId = resolveSessionId(msg, get().activeSessionId);
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, () => sharedAgentBusy());
      }
      break;
    }

    case 'agent_spawned': {
      const builder = sharedAgentSpawned(msg, get().activeSessionId);
      if (builder.sessionId && get().sessionStates[builder.sessionId]) {
        updateSession(builder.sessionId, (ss) => {
          const next = builder.applyTo(ss.activeAgents);
          return next === ss.activeAgents ? {} : { activeAgents: next };
        });
      }
      break;
    }

    case 'agent_completed': {
      const builder = sharedAgentCompleted(msg, get().activeSessionId);
      if (builder.sessionId && get().sessionStates[builder.sessionId]) {
        updateSession(builder.sessionId, (ss) => {
          const next = builder.applyTo(ss.activeAgents);
          return next === ss.activeAgents ? {} : { activeAgents: next };
        });
      }
      break;
    }

    case 'agent_event': {
      // #5060 — Task subagent intermediate progress. The shared builder
      // appends one entry to the parent Task tool_use bubble's
      // `childAgentEvents[]`. Same-reference no-op when the parent
      // bubble isn't found (event arrived before tool_start, which the
      // server's ordering guarantee prevents but is defended).
      const builder = sharedAgentEvent(msg, get().activeSessionId);
      if (builder.sessionId && get().sessionStates[builder.sessionId]) {
        updateSession(builder.sessionId, (ss) => {
          const next = builder.applyTo(ss.messages);
          return next === ss.messages ? {} : { messages: next };
        });
      }
      break;
    }

    case 'background_work_changed': {
      // #4307 — pending-background-shells snapshot updated for a
      // session. Full-snapshot protocol; the shared handler returns
      // the same reference when next === current to skip re-renders.
      const builder = sharedBackgroundWorkChanged(msg, get().activeSessionId);
      if (builder.sessionId && get().sessionStates[builder.sessionId]) {
        updateSession(builder.sessionId, (ss) => {
          const next = builder.applyTo(ss.pendingBackgroundShells);
          return next === ss.pendingBackgroundShells
            ? {}
            : { pendingBackgroundShells: next };
        });
      }
      break;
    }

    case 'plan_started': {
      const planStarted = sharedPlanStarted(msg, get().activeSessionId);
      if (planStarted.sessionId && get().sessionStates[planStarted.sessionId]) {
        updateSession(planStarted.sessionId, () => planStarted.patch);
      }
      break;
    }

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

    case 'inactivity_warning': {
      // #3899 — server fired the soft check-in prompt. Store on the
      // targeted session so the CheckInChip can render the prefab
      // button. The activity-event branch above clears this on the
      // next stream_*/tool_*/result/message; sendInput clears it
      // locally when the user actually sends a follow-up. Mirrors the
      // dashboard handler shape; no push-notification side-effect here
      // because server-cli sends the device-level push directly off
      // the `inactivity_warning` event emit.
      const warning = sharedInactivityWarning(msg, get().activeSessionId);
      if (warning && warning.sessionId && get().sessionStates[warning.sessionId]) {
        updateSession(warning.sessionId, () => warning.patch);
      }
      break;
    }

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
          if (_ctx.deltaFlushTimer) {
            clearTimeout(_ctx.deltaFlushTimer);
          }
          flushPendingDeltas();
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

    case 'permission_rules_updated': {
      const { sessionId: rulesExplicitSessionId, rules } =
        sharedPermissionRulesUpdated(msg);
      const rulesSessionId = rulesExplicitSessionId || get().activeSessionId;
      if (rulesSessionId && get().sessionStates[rulesSessionId]) {
        updateSession(rulesSessionId, () => ({ sessionRules: rules as PermissionRule[] }));
      }
      break;
    }

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

    case 'directory_listing': {
      const cb = getCallback('directoryListing');
      if (cb) {
        const payload = sharedDirectoryListing(msg);
        cb({ ...payload, entries: payload.entries as DirectoryEntry[] });
      }
      break;
    }

    case 'file_listing': {
      const fileBrowserCb = getCallback('fileBrowser');
      if (fileBrowserCb) {
        const payload = sharedFileListing(msg);
        fileBrowserCb({ ...payload, entries: payload.entries as FileEntry[] });
      }
      break;
    }

    case 'file_content': {
      const fileContentCb = getCallback('fileContent');
      if (fileContentCb) {
        fileContentCb(sharedFileContent(msg));
      }
      break;
    }

    case 'write_file_result': {
      const fileWriteCb = getCallback('fileWrite');
      if (fileWriteCb) {
        fileWriteCb(sharedWriteFileResult(msg));
      }
      break;
    }

    case 'diff_result': {
      const diffCb = getCallback('diff');
      if (diffCb) {
        const payload = sharedDiffResult(msg);
        // payload arrays are now strongly typed from store-core (#3132).
        diffCb({
          files: payload.files,
          error: payload.error,
        });
      }
      break;
    }

    case 'git_status_result': {
      const cb = getCallback('gitStatus');
      if (cb) {
        const payload = sharedGitStatusResult(msg);
        cb({
          branch: payload.branch,
          staged: payload.staged,
          unstaged: payload.unstaged,
          untracked: payload.untracked,
          error: payload.error,
        });
      }
      break;
    }

    case 'git_branches_result': {
      const cb = getCallback('gitBranches');
      if (cb) {
        const payload = sharedGitBranchesResult(msg);
        cb({
          branches: payload.branches,
          currentBranch: payload.currentBranch,
          error: payload.error,
        });
      }
      break;
    }

    case 'git_stage_result':
    case 'git_unstage_result': {
      const cb = getCallback('gitStage');
      if (cb) {
        cb(sharedGitStageResult(msg));
      }
      break;
    }

    case 'git_commit_result': {
      const cb = getCallback('gitCommit');
      if (cb) {
        cb(sharedGitCommitResult(msg));
      }
      break;
    }

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
      // Validate element shape before storing — guard against misbehaving
      // servers / malicious endpoints that might send non-objects or
      // objects without a string `name`.
      const providers: ProviderInfo[] = providerResult.providers
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
          // #3404 audit (F1+F5): preserve the server's auth/billing summary so
          // the create-session modal can disable unready chips and show the
          // billing identity. Earlier code dropped the field, breaking the
          // entire mobile UI surface for these features.
          if (p.auth && typeof p.auth === 'object' && !Array.isArray(p.auth)) {
            entry.auth = p.auth as ProviderInfo['auth'];
          }
          return entry;
        });
      set({ availableProviders: providers });
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

    case 'mcp_servers': {
      const result = sharedMcpServers(msg, get().activeSessionId);
      if (result.sessionId && get().sessionStates[result.sessionId]) {
        updateSession(result.sessionId, () => ({
          mcpServers: result.patch.mcpServers as McpServer[],
        }));
      }
      break;
    }

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

    case 'session_usage': {
      // #4074: per-session cumulative tokens + cost. Drives the
      // SessionScreen header cost badge + tap-to-expand breakdown.
      // Emitted after every result event.
      const result = sharedSessionUsage(msg, get().activeSessionId);
      if (result.sessionId && get().sessionStates[result.sessionId]) {
        updateSession(result.sessionId, () => result.patch);
      }
      break;
    }

    case 'session_cost_threshold_crossed': {
      // #4075: soft "you've spent $X" warning. Fires ONCE per session.
      // Mobile mirrors dashboard semantics: the server doesn't replay so
      // a missed banner stays missed (no store-and-replay). Parse shared
      // via store-core (#5454) — explicit sessionId only, no fallback.
      const { sessionId: thresholdSid, patch: thresholdPatch } =
        sharedSessionCostThresholdCrossed(msg);
      if (thresholdSid && get().sessionStates[thresholdSid]) {
        updateSession(thresholdSid, () => thresholdPatch);
      }
      break;
    }

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

    case 'budget_resumed': {
      const { systemMessage } = sharedBudgetResumed();
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

    case 'dev_preview': {
      const builder = sharedDevPreview(msg, get().activeSessionId);
      const target = builder.sessionId ? get().sessionStates[builder.sessionId] : undefined;
      if (builder.sessionId && target) {
        updateSession(builder.sessionId, (s) => builder.applyTo(s.devPreviews));
      }
      break;
    }

    case 'dev_preview_stopped': {
      const builder = sharedDevPreviewStopped(msg, get().activeSessionId);
      const target = builder.sessionId ? get().sessionStates[builder.sessionId] : undefined;
      if (builder.sessionId && target) {
        updateSession(builder.sessionId, (s) => builder.applyTo(s.devPreviews));
      }
      break;
    }

    // -- Web tasks (Claude Code Web) --

    case 'web_feature_status': {
      set(sharedWebFeatureStatus(msg));
      break;
    }

    case 'web_task_created':
    case 'web_task_updated': {
      const { task } = sharedWebTaskUpsert(msg);
      if (!task) break;
      set((state: ConnectionState) => {
        const existing = state.webTasks.filter((t) => t.taskId !== task.taskId);
        return { webTasks: [...existing, task] };
      });
      break;
    }

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

    case 'web_task_list': {
      const { tasks } = sharedWebTaskList(msg);
      set({ webTasks: tasks as WebTask[] });
      break;
    }

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

    case 'notification_prefs': {
      // #4542: notification-prefs snapshot. Emitted in response to
      // `notification_prefs_get` and broadcast after every
      // `notification_prefs_set` so multiple connected clients stay in
      // lockstep. Validated against the protocol Zod schema before storing.
      // #5454: kept inline (store-core's handleNotificationPrefs has the
      // same logic; the #4542/#4544 source-shape tests pin this impl).
      const parsed = ServerNotificationPrefsSchema.safeParse(msg);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.warn('notification_prefs: invalid payload from server', parsed.error.issues);
        break;
      }
      const prefs = parsed.data.prefs;
      // #4544: wire snapshot now carries an optional `bypassCategories`
      // (categories that fire even during quiet hours). Older servers
      // omit it — clients fall back to the documented defaults
      // (permission + activity_error). The quiet-hours window's
      // `timezone` field is required by the schema when the window is
      // present, so we forward it verbatim.
      const bypassCategories = (prefs as { bypassCategories?: string[] }).bypassCategories;
      set({
        notificationPrefs: {
          categories: prefs.categories,
          devices: prefs.devices,
          quietHours: prefs.quietHours,
          ...(Array.isArray(bypassCategories) ? { bypassCategories } : {}),
        },
      });
      break;
    }

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
