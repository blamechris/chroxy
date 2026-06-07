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
 *
 * Ported from packages/app/src/store/message-handler.ts for the web dashboard.
 * Connection persistence uses @chroxy/store-core adapters for DI.
 */
import {
  consoleAlert, noopHaptic, noopPush, createStorageAdapter,
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
  // #4653: chroxy-side multi-question deny intervention surfaced to the user
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
  handleError as sharedError,
  handleSessionError as sharedSessionError,
  handleLogEntry as sharedLogEntry,
  handleClientJoined as sharedClientJoined,
  handleClientLeft as sharedClientLeft,
  handlePrimaryChanged as sharedPrimaryChanged,
  handleClientFocusChanged as sharedClientFocusChanged,
  handleConversationId as sharedConversationId,
  handleHistoryReplayStart as sharedHistoryReplayStart,
  handleHistoryReplayEnd as sharedHistoryReplayEnd,
  handlePermissionExpired as sharedPermissionExpired,
  handlePermissionRulesUpdated as sharedPermissionRulesUpdated,
  handleDirectoryListing as sharedDirectoryListing,
  handleFileListing as sharedFileListing,
  handleFileContent as sharedFileContent,
  buildSessionListPatches as sharedBuildSessionListPatches,
  cumulativeUsageEquals as sharedCumulativeUsageEquals,
  handleSessionContext as sharedSessionContext,
  handleSessionTimeout as sharedSessionTimeout,
  handleSessionRestoreFailed as sharedSessionRestoreFailed,
  handleSessionWarning as sharedSessionWarning,
  handleSessionSwitched as sharedSessionSwitched,
  handleSlashCommands as sharedSlashCommands,
  handleAgentList as sharedAgentList,
  handleProviderList as sharedProviderList,
  handleFileList as sharedFileList,
  handleDiffResult as sharedDiffResult,
  handleGitStatusResult as sharedGitStatusResult,
  handleAgentSpawned as sharedAgentSpawned,
  handleAgentCompleted as sharedAgentCompleted,
  // #5016 — Task subagent nested progress (one wire event per child
  // `tool_start` / `tool_result` / `tool_input_delta` / `stream_delta`,
  // attached to the parent Task tool_use bubble's `childAgentEvents[]`).
  handleAgentEvent as sharedAgentEvent,
  handleBackgroundWorkChanged as sharedBackgroundWorkChanged,
  handleEnvironmentList as sharedEnvironmentList,
  handleEnvironmentError as sharedEnvironmentError,
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
  // #5163 (epic #5159): Control Room activity reducer — snapshot replace +
  // self-healing delta upsert + terminal-retention prune. The dashboard
  // panel and future mobile parity both consume this one implementation.
  applyActivitySnapshot,
  applyActivityDelta,
  clearSessionActivity,
  // #5039: pre-formatted partial-cost sub-line used by the `case 'error'`
  // branch so the toast and the mobile Alert share copy.
  formatPartialCostLine,
  type PlatformAdapters, type StorageAdapter,
} from '@chroxy/store-core'
import { PROTOCOL_VERSION } from '@chroxy/protocol'
import { ServerByokCredentialsStatusSchema, ServerNotificationPrefsSchema, ServerCredentialsStatusSchema, ServerCredentialTestResultSchema, ServerActivitySnapshotSchema, ServerActivityDeltaSchema, ServerCancelActivityAckSchema, ServerHostStatusSnapshotSchema, ServerRunnerStatusSnapshotSchema } from '@chroxy/protocol/schemas'
import {
  createKeyPair,
  deriveSharedKey,
  deriveConnectionKey,
  generateConnectionSalt,
  DIRECTION_CLIENT,
  type EncryptionState,
  type KeyPair,
} from './crypto';
import { filterThinking, nextMessageId } from './utils';
import { calculateCost } from '../lib/model-pricing';
import { CLIENT_ESTIMATED_COST_PROVIDERS } from '../lib/client-estimated-cost-providers';
import type {
  ChatMessage,
  ConnectionContext,
  ConnectionState,
  CustomAgent,
  DirectoryEntry,
  EnvironmentInfo,
  EvaluatorRewriteMeta,
  FileEntry,
  McpServer,
  PendingCommunitySkill,
  PendingEvaluatorClarify,
  QueuedMessage,
  SessionInfo,
  SessionNotification,
  SessionState,
  SlashCommand,
  FilePickerItem,
  ConversationSummary,
  ProviderInfo,
  WebTask,
} from './types';
import { createEmptySessionState } from './utils';
import { clearPersistedSession } from './persistence';

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

// ---------------------------------------------------------------------------
// Prompt evaluator pending requests (#3068)
// ---------------------------------------------------------------------------
//
// The evaluator round-trip is request→response with no streaming, so we keep
// a Map of pending entries keyed by requestId. Each entry carries the
// Promise's resolve + reject + the timeout handle so we can both:
//   - resolve when the matching `evaluate_draft_result` arrives, and
//   - reject on disconnect / explicit cancellation, clearing the timeout
//     so it doesn't fire after the request is gone.

import type { EvaluatorResultPayload } from './types';

interface PendingEvaluatorEntry {
  resolve: (result: EvaluatorResultPayload) => void;
  reject: (err: Error) => void;
  timeoutId: number;
}

const _evaluatorPending = new Map<string, PendingEvaluatorEntry>();

export function registerEvaluatorRequest(
  requestId: string,
  entry: PendingEvaluatorEntry,
): void {
  _evaluatorPending.set(requestId, entry);
}

export function cancelEvaluatorRequest(requestId: string): void {
  const entry = _evaluatorPending.get(requestId);
  if (entry) {
    window.clearTimeout(entry.timeoutId);
    _evaluatorPending.delete(requestId);
  }
}

/**
 * Reject every in-flight evaluator request with the given reason and clear
 * their timeouts. Called from the connection store when the WebSocket closes
 * (or the user explicitly disconnects) so callers don't have to wait the
 * 60s timeout to learn the request will never complete (#3068 review).
 */
export function rejectAllEvaluatorRequests(reason: string): void {
  if (_evaluatorPending.size === 0) return;
  const err = new Error(reason);
  for (const entry of _evaluatorPending.values()) {
    window.clearTimeout(entry.timeoutId);
    entry.reject(err);
  }
  _evaluatorPending.clear();
}

// ---------------------------------------------------------------------------
// In-flight skill_trust_grant tracking (#3587)
// ---------------------------------------------------------------------------
//
// The `skill_trust_grant` request carries `{skillName, author, requestId}` but
// the server's INVALID_AUTHOR error response only echoes `{requestId, code,
// message, actualAuthor}` — there is no `skillName` on the wire. To offer a
// one-click "Try as <actualAuthor>" recovery from the resulting toast we
// remember the original request locally, keyed by `requestId`, and pair it up
// when the matching error arrives.
//
// Entries are cleared when a `skill_trust_grant_ok` ack lands, when an
// `error` with a matching `requestId` is processed, or via the cleanup
// helper invoked on disconnect. The map is bounded at TRUST_GRANT_PENDING_CAP
// (32) entries to defend against a buggy server that never replies — the
// oldest entry is evicted FIFO via JS Map insertion order when the cap is
// reached.

interface PendingTrustGrant {
  skillName: string;
  author: string;
}

const _pendingTrustGrants = new Map<string, PendingTrustGrant>();
const TRUST_GRANT_PENDING_CAP = 32;

export function registerTrustGrantRequest(
  requestId: string,
  entry: { skillName: string; author: string },
): void {
  // FIFO eviction when the cap is reached. Map iteration order is insertion
  // order in JS, so the first key is the oldest.
  if (_pendingTrustGrants.size >= TRUST_GRANT_PENDING_CAP) {
    const oldestKey = _pendingTrustGrants.keys().next().value;
    if (oldestKey !== undefined) _pendingTrustGrants.delete(oldestKey);
  }
  _pendingTrustGrants.set(requestId, { ...entry });
}

export function consumePendingTrustGrant(requestId: string): PendingTrustGrant | null {
  const entry = _pendingTrustGrants.get(requestId);
  if (!entry) return null;
  _pendingTrustGrants.delete(requestId);
  return entry;
}

/** Clear all pending trust-grant entries — called on WebSocket close. */
export function clearPendingTrustGrants(): void {
  _pendingTrustGrants.clear();
}

/** @internal Exposed for tests so they can inspect the in-flight map. */
export function _testTrustGrantPendingSize(): number {
  return _pendingTrustGrants.size;
}

// ---------------------------------------------------------------------------
// E2E encryption state — reset on every new connection
// ---------------------------------------------------------------------------
let _encryptionState: EncryptionState | null = null;
let _pendingKeyPair: KeyPair | null = null;
let _pendingSalt: string | null = null;

/**
 * Send a JSON message over WebSocket, encrypting if E2E encryption is active.
 * Use this instead of raw `socket.send(JSON.stringify(...))`.
 */
export function wsSend(socket: WebSocket, payload: Record<string, unknown>): void {
  if (_encryptionState) {
    const envelope = encrypt(JSON.stringify(payload), _encryptionState.sharedKey, _encryptionState.sendNonce, DIRECTION_CLIENT);
    _encryptionState.sendNonce++;
    socket.send(JSON.stringify(envelope));
  } else {
    socket.send(JSON.stringify(payload));
  }
}

// #3671: edge-trigger memo for the dashboard's client_visible send. Initialised
// to true to match the server's per-connection default — a fresh socket sees
// `visible: true` server-side until we say otherwise. Reset on every fresh
// connect (auth_ok / key_exchange_ok) so the post-auth catch-up fires when
// the dashboard reconnects with the tab already hidden.
let _lastSentVisible: boolean = true;

export function resetClientVisibleMemo(): void {
  _lastSentVisible = true;
}

// #3677 (Copilot review): flip the module-level handshake flags from a
// test so we can assert the encryption-pending guard inside
// `sendClientVisible`. Resetting both to false leaves no observable trace
// for downstream tests in the same file. Cast via `unknown` because we only
// touch the truthy/null aspects of these flags here, not their actual
// crypto contents.
export function _testSetEncryptionHandshake(opts: { pending: boolean; established: boolean }): void {
  _pendingKeyPair = opts.pending
    ? ({ publicKey: 'mock-pub', secretKey: 'mock-sec' } as unknown as KeyPair)
    : null;
  _encryptionState = opts.established
    ? ({ sharedKey: new Uint8Array(32), sendNonce: 0, recvNonce: 0 } as unknown as EncryptionState)
    : null;
}

/**
 * Send the dashboard tab's foreground/background state to the server. The
 * server uses this to gate completion push notifications and other "is anyone
 * actually watching this session" decisions — without it, a dashboard tab
 * left open in the background would keep counting as an active viewer and
 * suppress pushes on mobile, defeating #3404.
 *
 * Mirrors the mobile app's `sendClientVisible` (packages/app/src/store/
 * message-handler.ts) including the encryption-pending guard so we don't
 * fire plaintext during the key-exchange handshake window.
 */
export function sendClientVisible(socket: WebSocket | null, visible: boolean): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (_lastSentVisible === visible) return;
  if (_pendingKeyPair !== null && _encryptionState === null) return;
  _lastSentVisible = visible;
  wsSend(socket, { type: 'client_visible', visible });
}

// Re-export encrypt for wsSend (import is used inside the function)
import { encrypt } from './crypto';

// ---------------------------------------------------------------------------
// Platform adapters — web dashboard uses console.warn + no-op haptics
// ---------------------------------------------------------------------------
const _storage: StorageAdapter = createStorageAdapter(localStorage)

const _adapters: PlatformAdapters = {
  alert: consoleAlert,
  haptic: noopHaptic,
  push: noopPush,
  storage: _storage,
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
  return _encryptionState;
}

export function setEncryptionState(state: EncryptionState | null): void {
  _encryptionState = state;
}

export function getPendingKeyPair(): KeyPair | null {
  return _pendingKeyPair;
}

export function setPendingKeyPair(kp: KeyPair | null): void {
  _pendingKeyPair = kp;
}

// ---------------------------------------------------------------------------
// Connection attempt tracking
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

// ---------------------------------------------------------------------------
// History replay flags
// ---------------------------------------------------------------------------
// #4493 — per-session replay tracking. `replayHistory()` on the server chunks
// the replay over `setImmediate` (ws-history.js), which yields the event loop
// between chunks, so live broadcasts from OTHER sessions can interleave with
// session A's replay. A module-level boolean would gate all sessions on A's
// replay state and drop legitimate live activity for sessions B/C/etc.
// Scope the flag per-session id and gate per-target.
const _replayingSessions = new Set<string>();

export function resetReplayFlags(): void {
  _replayingSessions.clear();
}

// ---------------------------------------------------------------------------
// Permission boundary message splitting (#554)
// ---------------------------------------------------------------------------
const _postPermissionSplits = new Set<string>();
const _deltaIdRemaps = new Map<string, string>();

export function clearPermissionSplits(): void {
  _postPermissionSplits.clear();
  _deltaIdRemaps.clear();
}

// ---------------------------------------------------------------------------
// Terminal write batching
// ---------------------------------------------------------------------------
let _pendingTerminalWrites = '';
let _terminalWriteTimer: ReturnType<typeof setTimeout> | null = null;

export function flushTerminalWrites(): void {
  _terminalWriteTimer = null;
  if (_pendingTerminalWrites.length === 0) return;
  const data = _pendingTerminalWrites;
  _pendingTerminalWrites = '';
  const cb = getStore().getState()._terminalWriteCallback;
  if (cb) cb(data);
}

export function appendPendingTerminalWrite(data: string): void {
  _pendingTerminalWrites += data;
  if (!_terminalWriteTimer) {
    _terminalWriteTimer = setTimeout(flushTerminalWrites, 50);
  }
}

export function clearTerminalWriteBatching(): void {
  if (_terminalWriteTimer) {
    clearTimeout(_terminalWriteTimer);
    _terminalWriteTimer = null;
  }
  _pendingTerminalWrites = '';
}

// ---------------------------------------------------------------------------
// Client-side heartbeat
// ---------------------------------------------------------------------------
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _pongTimeout: ReturnType<typeof setTimeout> | null = null;
let _lastPingSentAt = 0;
let _ewmaRtt: number | null = null; // EWMA-smoothed RTT for stable quality display
const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 5_000;
const EWMA_ALPHA = 0.3; // Weight for new samples (higher = more responsive)

export function stopHeartbeat(): void {
  if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
  if (_pongTimeout) { clearTimeout(_pongTimeout); _pongTimeout = null; }
  _lastPingSentAt = 0;
  _ewmaRtt = null; // Reset smoothed RTT on disconnect
}

export function startHeartbeat(socket: WebSocket): void {
  stopHeartbeat();
  _heartbeatInterval = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) { stopHeartbeat(); return; }
    try {
      _lastPingSentAt = Date.now();
      wsSend(socket, { type: 'ping' });
    } catch { stopHeartbeat(); return; }
    _pongTimeout = setTimeout(() => {
      console.warn('[ws] Heartbeat pong timeout — closing dead connection');
      stopHeartbeat();
      try { socket.close(); } catch {}
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function _onPong(): void {
  if (_pongTimeout) { clearTimeout(_pongTimeout); _pongTimeout = null; }
  // Measure RTT and update connection quality using EWMA for stability
  if (_lastPingSentAt > 0) {
    const rttMs = Date.now() - _lastPingSentAt;
    _lastPingSentAt = 0;
    // EWMA: smoothed = alpha * new + (1 - alpha) * prev (first sample bootstraps)
    _ewmaRtt = _ewmaRtt === null ? rttMs : EWMA_ALPHA * rttMs + (1 - EWMA_ALPHA) * _ewmaRtt;
    const smoothed = Math.round(_ewmaRtt);
    const quality: 'good' | 'fair' | 'poor' = smoothed < 200 ? 'good' : smoothed < 500 ? 'fair' : 'poor';
    getStore().setState({ latencyMs: smoothed, connectionQuality: quality });
  }
}

// ---------------------------------------------------------------------------
// Delta batching
// ---------------------------------------------------------------------------
const pendingDeltas = new Map<string, { sessionId: string | null; delta: string }>();
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingDeltas(): void {
  deltaFlushTimer = null;
  if (pendingDeltas.size === 0) return;
  const updates = new Map(pendingDeltas);
  pendingDeltas.clear();

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
      // canonical helper extracted in #3176).
      const finalMessages = updatedMessages;
      applyOrphanDeltas(finalMessages, deltas, matched, _deltaIdRemaps);
      newSessionStates = {
        ...newSessionStates,
        [sessionId]: { ...sessionState, messages: finalMessages },
      };
      if (sessionId === state.activeSessionId) {
        getStore().setState({ sessionStates: newSessionStates, messages: finalMessages });
        flatUpdated = true;
      }
    } else {
      getStore().setState((s) => {
        const matched2 = new Set<string>();
        const updated = s.messages.map((m) => {
          const d = deltas.get(m.id);
          if (d && m.type === 'response') {
            matched2.add(m.id);
            return { ...m, content: m.content + d };
          }
          return m;
        });
        // Safety net: create response messages for orphaned deltas (#2611,
        // canonical helper extracted in #3176).
        applyOrphanDeltas(updated, deltas, matched2, _deltaIdRemaps);
        return { messages: updated };
      });
      flatUpdated = true;
    }
  }

  if (!flatUpdated) {
    getStore().setState({ sessionStates: newSessionStates });
  }
}

export function clearDeltaBuffers(): void {
  if (deltaFlushTimer) {
    clearTimeout(deltaFlushTimer);
    deltaFlushTimer = null;
  }
  pendingDeltas.clear();
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

/**
 * #4148: server error codes whose envelopes are NON-fatal even when the
 * server forgot to set `fatal: false`. Routed to severity='warning'
 * (yellow toast) instead of the destructive red error treatment.
 * Hoisted to module scope so the 'error' case doesn't reallocate the
 * Set every message.
 */
const NON_FATAL_ERROR_CODES = new Set(['MAX_TOOL_ROUNDS_REACHED']);
const messageQueue: QueuedMessage[] = [];

export function enqueueMessage(type: string, payload: unknown): 'queued' | false {
  if (QUEUE_EXCLUDED.has(type)) return false;
  const maxAge = QUEUE_TTLS[type];
  if (!maxAge) return false;
  if (messageQueue.length >= QUEUE_MAX_SIZE) return false;
  messageQueue.push({ type, payload, queuedAt: Date.now(), maxAge });
  console.log(`[queue] Queued ${type} (${messageQueue.length}/${QUEUE_MAX_SIZE})`);
  return 'queued';
}

export function drainMessageQueue(socket: WebSocket): void {
  if (messageQueue.length === 0) return;
  const now = Date.now();
  const valid = messageQueue.filter((m) => now - m.queuedAt < m.maxAge);
  messageQueue.length = 0;
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
  messageQueue.length = 0;
}

/** @internal Exposed for testing only */
export const _testQueueInternals = {
  getQueue: () => messageQueue,
  enqueue: enqueueMessage,
  drain: drainMessageQueue,
  clear: () => { messageQueue.length = 0; },
};

// ---------------------------------------------------------------------------
// Session update helpers
// ---------------------------------------------------------------------------

/**
 * Update any session's state by ID. Syncs to flat state only when the target
 * session is the currently active session (so UI reads remain correct).
 */
export function updateSession(sessionId: string, updater: (session: SessionState) => Partial<SessionState>): void {
  const state = getStore().getState();
  if (!state.sessionStates[sessionId]) return;

  const current = state.sessionStates[sessionId];
  const patch = updater(current);
  if (Object.keys(patch).length === 0) return;
  const updated = { ...current, ...patch };
  const newSessionStates = { ...state.sessionStates, [sessionId]: updated };

  if (sessionId === state.activeSessionId) {
    const flatPatch: Record<string, unknown> = { sessionStates: newSessionStates };
    if ('messages' in patch) flatPatch.messages = patch.messages;
    if ('streamingMessageId' in patch) flatPatch.streamingMessageId = patch.streamingMessageId;
    if ('claudeReady' in patch) flatPatch.claudeReady = patch.claudeReady;
    if ('activeModel' in patch) flatPatch.activeModel = patch.activeModel;
    if ('permissionMode' in patch) flatPatch.permissionMode = patch.permissionMode;
    if ('contextUsage' in patch) flatPatch.contextUsage = patch.contextUsage;
    if ('lastResultCost' in patch) flatPatch.lastResultCost = patch.lastResultCost;
    if ('lastResultDuration' in patch) flatPatch.lastResultDuration = patch.lastResultDuration;
    if ('isIdle' in patch) flatPatch.isIdle = patch.isIdle;
    getStore().setState(flatPatch);
  } else {
    getStore().setState({ sessionStates: newSessionStates });
  }
}

/** Helper to update the active session's state and sync to flat state */
export function updateActiveSession(updater: (session: SessionState) => Partial<SessionState>): void {
  const state = getStore().getState();
  const activeId = state.activeSessionId;
  if (activeId) updateSession(activeId, updater);
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
  };
  getStore().setState((s) => {
    const filtered = s.sessionNotifications.filter(
      (n) => !(n.sessionId === sessionId && n.eventType === eventType),
    );
    return { sessionNotifications: [...filtered, notification] };
  });
}

// ---------------------------------------------------------------------------
// Connection persistence helpers — delegated to @chroxy/store-core adapter
// ---------------------------------------------------------------------------

export function saveConnection(url: string, token: string): void {
  _storage.saveConnection(url, token)
}

export function loadConnection(): { url: string; token: string } | null {
  return _storage.loadConnection() as { url: string; token: string } | null
}

/**
 * Wipe the persisted connection URL + token from localStorage.
 *
 * NOTE: Storage-only. This does NOT close the active WebSocket, reset in-memory
 * store state, or navigate the UI. Use the store-level `clearSavedConnection()`
 * for the full "forget this server" flow, or `disconnect()` to close the live
 * socket.
 */
export function clearSavedCredentials(): void {
  _storage.clearSavedCredentials()
}

// ---------------------------------------------------------------------------
// Map-based handler infrastructure
// ---------------------------------------------------------------------------

/**
 * Signature for a standalone message handler extracted from the switch statement.
 * Receives the raw message, store accessors, and the connection context.
 */
type MsgGet = () => ConnectionState;
type MsgSet = (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void;
type Handler = (msg: Record<string, unknown>, get: MsgGet, set: MsgSet, ctx: ConnectionContext) => void;

// --- Extracted handler functions ---

function handlePong(_msg: Record<string, unknown>, _get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  _onPong();
}

function handleRaw(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  get().appendTerminalData(msg.data as string);
}

function handleRawBackground(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  get().appendTerminalData(msg.data as string);
}

function handleTokenRotated(msg: Record<string, unknown>, _get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const newToken = typeof msg.token === 'string' ? msg.token : null;
  if (newToken) {
    // Server sent the new token — update URL query param for reconnection
    console.log('[ws] Server token rotated — updating stored token');
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('token', newToken);
      window.history.replaceState(null, '', url.toString());
    } catch { /* non-critical */ }
  } else {
    console.log('[ws] Server token rotated — re-authentication required');
  }
}

function handleCheckpointRestored(_msg: Record<string, unknown>, _get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  // Server has created a new session from the checkpoint.
  // The session_list update will follow from the server — nothing to do here.
}

/**
 * Server emits pairing_refreshed whenever the pairing ID changes: after a
 * pairing ID is consumed, on periodic auto-rotation, or on an explicit
 * refresh() call (#2916). Increment the counter so App.tsx can auto-refresh
 * the QR code while the modal is open.
 */
function handlePairingRefreshed(_msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  set(state => ({ pairingRefreshedCount: (state.pairingRefreshedCount ?? 0) + 1 }));
}

function handleWebFeatureStatus(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  set(sharedWebFeatureStatus(msg));
}

function handleWebTaskList(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const { tasks } = sharedWebTaskList(msg);
  set({ webTasks: tasks as WebTask[] });
}

function handleConversationsList(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const conversations = Array.isArray(msg.conversations) ? (msg.conversations as ConversationSummary[]) : [];
  set({ conversationHistory: conversations, conversationHistoryLoading: false });
}

function handleModelChanged(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const { model } = sharedModelChanged(msg);
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => ({ activeModel: model }));
  } else {
    set({ activeModel: model });
  }
}

function handleThinkingLevelChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const { level } = sharedThinkingLevelChanged(msg);
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => ({ thinkingLevel: level }));
  }
}

// #3185: per-session promptEvaluator toggle changed. Update the
// `sessions` array entry for the affected session so the UI reflects
// the new toggle state immediately. Other clients on the same session
// receive the broadcast and stay in sync.
function handlePromptEvaluatorChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const value = typeof msg.value === 'boolean' ? msg.value : null;
  if (value === null) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId) return;
  const sessions = get().sessions.map(s =>
    s.sessionId === targetId ? { ...s, promptEvaluator: value } : s,
  );
  _set({ sessions });
}

// #3805: per-session Chroxy context hint toggle changed. Mirrors
// handlePromptEvaluatorChanged — update the `sessions` array entry so
// every client bound to the session sees the new state immediately.
function handleChroxyContextHintChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const value = typeof msg.value === 'boolean' ? msg.value : null;
  if (value === null) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId) return;
  const sessions = get().sessions.map(s =>
    s.sessionId === targetId ? { ...s, chroxyContextHint: value } : s,
  );
  _set({ sessions });
}

// #4660: server-broadcast confirmation that the per-session preamble
// landed (and what trimmed value it actually stored). Mirrors
// handleChroxyContextHintChanged — accept only string-typed payloads,
// fall back to no-op for malformed events instead of clobbering state.
function handleSessionPreambleChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const value = typeof msg.value === 'string' ? msg.value : null;
  if (value === null) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId) return;
  const sessions = get().sessions.map(s =>
    s.sessionId === targetId ? { ...s, sessionPreamble: value } : s,
  );
  _set({ sessions });
}

// #3209: full skills list response. Replaces the cached list on the
// active (or message-targeted) session. Each entry carries `name`,
// `description`, `source`, `activation`, `active`. The dashboard
// SkillsPanel renders manual-skill toggles from this.
function handleSkillsList(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  if (!Array.isArray(msg.skills)) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  // Strip to the SessionSkillInfo shape — the server validates the
  // wire schema upstream, but a defensive copy keeps the store free
  // of any extra fields a future server might add.
  const skills = (msg.skills as Array<Record<string, unknown>>).map(s => {
    const source = s.source === 'global' || s.source === 'repo' ? s.source : undefined;
    const activation = s.activation === 'auto' || s.activation === 'manual' ? s.activation : undefined;
    const trustState = s.trustState === 'pending' || s.trustState === 'trusted' ? s.trustState : undefined;
    return {
      name: typeof s.name === 'string' ? s.name : '',
      description: typeof s.description === 'string' ? s.description : undefined,
      source: source as 'global' | 'repo' | undefined,
      activation: activation as 'auto' | 'manual' | undefined,
      active: typeof s.active === 'boolean' ? s.active : undefined,
      // #3205: optional audit metadata. The handler stays defensive
      // about types (older servers won't send these; future ones
      // might add fields the dashboard hasn't typed yet).
      version: typeof s.version === 'string' ? s.version : undefined,
      hashPrefix: typeof s.hashPrefix === 'string' ? s.hashPrefix : undefined,
      firstSeen: typeof s.firstSeen === 'string' ? s.firstSeen : undefined,
      lastVerified: typeof s.lastVerified === 'string' ? s.lastVerified : undefined,
      // #3298: community-skill trust fields. Only present on community skills;
      // absent (undefined) for global/repo skills.
      trustState: trustState as 'pending' | 'trusted' | undefined,
      communityAuthor: typeof s.communityAuthor === 'string' ? s.communityAuthor : undefined,
    };
  }).filter(s => s.name);
  updateSession(targetId, () => ({ skills }));
}

// #3205: skill content-hash mismatch event. The trust store detected
// that a skill's body changed since the recorded hash. Track the
// mismatched skill name on the affected session so the SkillsPanel
// can render a red-flag indicator. The wire payload also carries
// `oldHashPrefix` / `newHashPrefix` / `mode`, but the panel just
// needs the name list for the indicator UI.
function handleSkillChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  if (!skillName) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const prev = Array.isArray(state.mismatchedSkillNames) ? state.mismatchedSkillNames : [];
    if (prev.includes(skillName)) return {};
    return { mismatchedSkillNames: [...prev, skillName] };
  });
}

// #3209: runtime manual-skill toggle broadcasts. Update the cached
// skills list for the affected session so the toggle UI re-renders.
// If we don't have a cached list yet (rare — list_skills hasn't been
// requested), the next list_skills response will be authoritative.
function handleSkillActivated(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  if (!skillName) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => ({
    skills: (state.skills || []).map(s =>
      s.name === skillName ? { ...s, active: true } : s,
    ),
  }));
}

function handleSkillDeactivated(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  if (!skillName) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => ({
    skills: (state.skills || []).map(s =>
      s.name === skillName ? { ...s, active: false } : s,
    ),
  }));
}

// #3235: operator re-trusted a skill after a content-hash mismatch. The
// dashboard's job is to clear the SkillsPanel red-flag indicator (the
// `mismatchedSkillNames` entry from #3205) so the skill no longer
// appears as flagged. Pairs with `skill_changed` (the event that ADDED
// the name to that list).
function handleSkillTrustAccepted(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  if (!skillName) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const prev = Array.isArray(state.mismatchedSkillNames) ? state.mismatchedSkillNames : [];
    if (!prev.includes(skillName)) return {};
    return { mismatchedSkillNames: prev.filter((n) => n !== skillName) };
  });
}

// #3188: auto-evaluator rewrite broadcast (#3186 emit, #3208 schema).
// Push a `system` message into the targeted session's history with
// `evaluator` metadata so ChatView's renderMessage can render the
// rewrite-explanation banner. The system message is persisted in the
// per-session localStorage cache (`sessionMessagesKey` in
// packages/dashboard/src/store/persistence.ts), so reconnect/replay
// re-renders the banner from cache without re-firing the transient
// wire event. Dedup'd by `evaluatorIterationId`.
//
// Also clears any matching `pendingEvaluatorClarify` for the session: a
// rewrite verdict supersedes a stale clarify-pending entry the operator
// hadn't answered when the new round-trip kicked in.
function handleEvaluatorRewrite(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const evaluatorIterationId = typeof msg.evaluatorIterationId === 'string' ? msg.evaluatorIterationId : null;
  const originalDraft = typeof msg.originalDraft === 'string' ? msg.originalDraft : null;
  const rewritten = typeof msg.rewritten === 'string' ? msg.rewritten : null;
  if (!evaluatorIterationId || originalDraft === null || rewritten === null) return;
  const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;

  const evaluatorMeta: EvaluatorRewriteMeta = {
    kind: 'rewrite',
    evaluatorIterationId,
    originalDraft,
    rewritten,
    reasoning,
  };

  updateSession(targetId, (state) => {
    // Dedup on `evaluatorIterationId` so a localStorage-cache replay
    // (or duplicate broadcast) doesn't double-insert the banner.
    const alreadyInserted = state.messages.some(
      (m) => m.type === 'system' && m.evaluator?.evaluatorIterationId === evaluatorIterationId,
    );
    if (alreadyInserted) {
      // Still clear any stale clarify-pending state — a new rewrite
      // verdict means the prior clarify question no longer applies.
      if (state.pendingEvaluatorClarify) return { pendingEvaluatorClarify: null };
      return {};
    }
    const systemMessage: ChatMessage = {
      id: `evaluator-rewrite-${evaluatorIterationId}`,
      type: 'system',
      content: 'Your message was rewritten to be clearer — see why',
      timestamp: Date.now(),
      evaluator: evaluatorMeta,
    };
    const patch: Partial<SessionState> = {
      messages: [...state.messages, systemMessage],
    };
    if (state.pendingEvaluatorClarify) {
      patch.pendingEvaluatorClarify = null;
    }
    return patch;
  });
}

// #3188: auto-evaluator clarify broadcast (#3186 emit, #3208 schema).
// Set `pendingEvaluatorClarify` on the targeted session so ChatView
// renders an inline prompt block showing the clarifying question + the
// `Iteration N/3` counter. Cleared on the next user_input echo for this
// session or when a follow-up rewrite verdict supersedes it.
//
// Transient — NOT persisted across reconnects. The server re-fires the
// event on the next user_input cycle, so a reconnect mid-clarify drops
// the inline prompt; the operator re-types and the next round-trip
// reproduces it. Dedup'd by `evaluatorIterationId` so a duplicate
// broadcast doesn't reset state to an older question.
function handleEvaluatorClarify(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const evaluatorIterationId = typeof msg.evaluatorIterationId === 'string' ? msg.evaluatorIterationId : null;
  const evaluatorIteration = typeof msg.evaluatorIteration === 'number' && Number.isInteger(msg.evaluatorIteration) && msg.evaluatorIteration >= 1
    ? msg.evaluatorIteration
    : null;
  const originalDraft = typeof msg.originalDraft === 'string' ? msg.originalDraft : null;
  const clarification = typeof msg.clarification === 'string' ? msg.clarification : null;
  if (!evaluatorIterationId || evaluatorIteration === null || originalDraft === null || clarification === null) return;
  const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;

  const pending: PendingEvaluatorClarify = {
    evaluatorIterationId,
    evaluatorIteration,
    originalDraft,
    clarification,
    reasoning,
  };

  updateSession(targetId, (state) => {
    // Dedup on `evaluatorIterationId` — a duplicate broadcast for the
    // same iteration must NOT clobber state (no-op).
    if (state.pendingEvaluatorClarify?.evaluatorIterationId === evaluatorIterationId) return {};
    return { pendingEvaluatorClarify: pending };
  });
}

// #3298: community skill is awaiting first-activation trust grant. Add
// an entry to `pendingCommunitySkills` on the active (or target) session
// so the SkillsPanel "Pending review" section renders a Trust button.
// Idempotent — duplicate events (e.g. two sessions loading the same
// community author) are collapsed so the list stays de-duped.
function handleSkillTrustRequest(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  const author = typeof msg.author === 'string' ? msg.author : null;
  if (!skillName || !author) return;
  // #3310: capture optional description / path from the wire payload so
  // the SkillsPanel "Pending review" row can surface them for the operator.
  // Defensive typed — absent or non-string values become undefined so the
  // type matches PendingCommunitySkill's optional fields.
  const description = typeof msg.description === 'string' && msg.description ? msg.description : undefined;
  const path = typeof msg.path === 'string' && msg.path ? msg.path : undefined;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const existing: PendingCommunitySkill[] = Array.isArray(state.pendingCommunitySkills)
      ? state.pendingCommunitySkills
      : [];
    if (existing.some(p => p.name === skillName && p.author === author)) return {};
    const entry: PendingCommunitySkill = { name: skillName, author };
    if (description !== undefined) entry.description = description;
    if (path !== undefined) entry.path = path;
    return { pendingCommunitySkills: [...existing, entry] };
  });
}

// #3298: community skill trust was granted (broadcast to all clients
// bound to the session). Remove the matching entry from
// `pendingCommunitySkills` so the "Pending review" row disappears. The
// server will also refresh skills_list to reflect the newly-trusted skill.
function handleSkillTrustGranted(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  const author = typeof msg.author === 'string' ? msg.author : null;
  if (!skillName || !author) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const existing: PendingCommunitySkill[] = Array.isArray(state.pendingCommunitySkills)
      ? state.pendingCommunitySkills
      : [];
    return {
      pendingCommunitySkills: existing.filter(
        p => !(p.name === skillName && p.author === author),
      ),
    };
  });
}

// #3298: ack sent to the requesting client after a successful
// skill_trust_grant. The actual list update flows through
// skill_trust_granted (broadcast) and a subsequent skills_list refresh.
// #3588: clear the matching `pendingTrustGrants` entry so the
// SkillsPanel in-flight state (disabled Trust button + spinner) lifts.
// #3587: also consume the action-toast pending entry so the Map-based
// retry registry doesn't accumulate entries on the success path.
// Idempotent — if the broadcast clears the row before the ack arrives,
// the entry is already gone and this is a no-op.
function handleSkillTrustGrantOk(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  if (!requestId) return;
  // #3587: consume the action-toast Map entry
  consumePendingTrustGrant(requestId);
  // #3588: clear per-session pendingTrustGrants list (SkillsPanel spinner)
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const existing = Array.isArray(state.pendingTrustGrants) ? state.pendingTrustGrants : [];
    const next = existing.filter(g => g.requestId !== requestId);
    if (next.length === existing.length) return {};
    return { pendingTrustGrants: next };
  });
}

// #3588: clear an in-flight `pendingTrustGrants` entry whose requestId
// matches the supplied error envelope. Searches every session's
// pendingTrustGrants list (the requestId is unique across sessions, but
// the error envelope may not always carry sessionId — we don't want a
// missing sessionId to leave the row stuck). Returns true when an entry
// was cleared so the caller can branch on it; otherwise the requestId
// belongs to some other handler's request and is ignored.
function clearPendingTrustGrantByRequestId(requestId: string, get: MsgGet): boolean {
  const sessionStates = get().sessionStates;
  let cleared = false;
  for (const sid of Object.keys(sessionStates)) {
    const ss = sessionStates[sid];
    if (!ss) continue;
    const existing = Array.isArray(ss.pendingTrustGrants) ? ss.pendingTrustGrants : [];
    const next = existing.filter(g => g.requestId !== requestId);
    if (next.length !== existing.length) {
      cleared = true;
      updateSession(sid, () => ({ pendingTrustGrants: next }));
    }
  }
  return cleared;
}

function handlePermissionModeChanged(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const { mode } = sharedPermissionModeChanged(msg);
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => ({ permissionMode: mode }));
  } else {
    set({ permissionMode: mode });
  }
  // Clear pending confirm if mode change arrived (confirmation was accepted)
  set({ pendingPermissionConfirm: null });
}

function handleAvailablePermissionModes(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const modes = sharedAvailablePermissionModes(msg);
  if (modes) {
    set({ availablePermissionModes: modes });
  }
}

function handleSessionUpdated(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const updated = sharedSessionUpdated(msg, get().sessions);
  if (updated) {
    set({ sessions: updated });
  }
}

function handleSessionSwitched(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const switched = sharedSessionSwitched(msg);
  if (!switched) return;
  const { newSessionId: sessionId, conversationId: switchConvId } = switched;
  // Per-id dedup runs on every history replay path (#2901), so we no longer
  // need a "pending-switch" hint to distinguish user-initiated session switches
  // from auth-triggered ones.
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
    const ss = sessionStates[sessionId];
    return {
      activeSessionId: sessionId,
      sessionStates,
      // Sync flat state from the switched-to session
      messages: ss.messages,
      streamingMessageId: ss.streamingMessageId,
      claudeReady: ss.claudeReady,
      activeModel: ss.activeModel,
      permissionMode: ss.permissionMode,
      contextUsage: ss.contextUsage,
      lastResultCost: ss.lastResultCost,
      lastResultDuration: ss.lastResultDuration,
      isIdle: ss.isIdle,
    };
  });
  // Refresh slash commands (project commands may differ per session cwd)
  get().fetchSlashCommands();
  // Refresh agents (project agents may differ per session cwd)
  get().fetchCustomAgents();
}

function handleClaudeReady(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const patch = sharedClaudeReady();
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => patch);
  } else {
    set(patch);
  }
  // Drain queued messages on reconnect
  const readySocket = get().socket;
  if (readySocket && readySocket.readyState === WebSocket.OPEN) {
    drainMessageQueue(readySocket);
  }
}

function handleAgentIdle(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => sharedAgentIdle());
  } else {
    // Legacy/pre-bootstrap path: no session-state yet. The dashboard UI reads
    // the flat `streamingMessageId` directly (App.tsx isStreaming check), and
    // sendInput writes flat 'pending' here too. Without this fallback, an
    // abnormal agent_idle in this state would leave the stop button stuck.
    set(sharedAgentIdle());
  }
}

function handleAgentBusy(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => sharedAgentBusy());
  }
}

function handleStreamStart(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const targetId = (msg.sessionId as string) || get().activeSessionId;
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => {
      const out = sharedStreamStart(msg, get().activeSessionId, ss.messages);
      if (out.remap) {
        _deltaIdRemaps.set(out.remap.from, out.remap.to);
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
  } else {
    set((state: ConnectionState) => {
      const out = sharedStreamStart(msg, get().activeSessionId, state.messages);
      if (out.remap) {
        _deltaIdRemaps.set(out.remap.from, out.remap.to);
      }
      if (!out.isNewMessage) {
        return { streamingMessageId: out.streamingMessageId };
      }
      return {
        streamingMessageId: out.streamingMessageId,
        messages: [...filterThinking(state.messages), out.newMessage!],
      };
    });
  }
}

function handleStreamDelta(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // #4981 — thin wrapper over `sharedStreamDelta`. The platform-neutral hot
  // path (post-permission split, single-hop defensive remap, post-tool
  // continuation split with the #4999/#5014 sentence gate and #4975 mid-word
  // peel, buffered append + 100ms flush) lives in store-core. The dashboard-
  // specific side effects stay here: the terminal-data write, the #4297
  // empty-response-slot reorder, and the flat-`messages` fallbacks (the app
  // has neither — see the StreamDeltaContext doc comment).
  sharedStreamDelta(msg, {
    activeSessionId: get().activeSessionId,
    pendingDeltas,
    deltaIdRemaps: _deltaIdRemaps,
    postPermissionSplits: _postPermissionSplits,
    replayingSessions: _replayingSessions,

    getSessionMessages: (sessionId) =>
      sessionId && get().sessionStates[sessionId]
        ? get().sessionStates[sessionId]!.messages
        : null,
    getFlatMessages: () => get().messages,

    // Forward delta text to terminal view (synthesize raw output in CLI mode).
    // The shared fn already gates on `typeof msg.delta === 'string' && length`.
    appendTerminalDelta: (delta) => {
      get().appendTerminalData(delta);
    },

    // #4297 — TUI fires stream_start at turn-start (#4010), creating an empty
    // response slot. Tool events that follow append AFTER the slot. If the
    // turn ends with a summary stream_delta, the text would otherwise
    // materialize at the early slot position — making claude's wrap-up appear
    // ABOVE the tool groups it summarized. On the first delta for an empty
    // response slot, move it to the current end of the messages array. We gate
    // on content === '' so a reconnect-replayed response (already populated)
    // is never shifted. The shared fn applies the not-split / not-remapped /
    // not-pending guard before calling this.
    reorderEmptyResponseSlot: (deltaId, capturedSessionId) => {
      const targetForReorder = (capturedSessionId && get().sessionStates[capturedSessionId])
        ? capturedSessionId
        : null;
      if (targetForReorder) {
        const ss = get().sessionStates[targetForReorder]!;
        const idx = ss.messages.findIndex((m) => m.id === deltaId);
        if (idx >= 0 && idx < ss.messages.length - 1) {
          const slot = ss.messages[idx]!;
          if (slot.type === 'response' && slot.content === '') {
            updateSession(targetForReorder, (s) => ({
              messages: [
                ...s.messages.slice(0, idx),
                ...s.messages.slice(idx + 1),
                slot,
              ],
            }));
          }
        }
      } else {
        // Flat-messages fallback (pre-session bootstrap)
        const flat = get().messages;
        const idx = flat.findIndex((m) => m.id === deltaId);
        if (idx >= 0 && idx < flat.length - 1) {
          const slot = flat[idx]!;
          if (slot.type === 'response' && slot.content === '') {
            set((state) => ({
              messages: [
                ...state.messages.slice(0, idx),
                ...state.messages.slice(idx + 1),
                slot,
              ],
            }));
          }
        }
      }
    },

    // Append a fresh response slot + set streamingMessageId. A null target (or
    // a target without session state) routes to the flat-messages array —
    // mirroring the dashboard's original session-state-or-flat branches for
    // the permission split, defensive `-response` suffix, and `-cont-` split.
    appendResponseSlot: (targetSessionId, slot, opts) => {
      if (targetSessionId && get().sessionStates[targetSessionId]) {
        if (opts?.onlyIfAbsent
            && get().sessionStates[targetSessionId]!.messages.some((m) => m.id === slot.id)) {
          return;
        }
        updateSession(targetSessionId, (ss) => ({
          streamingMessageId: slot.id,
          messages: [...ss.messages, slot],
        }));
      } else {
        if (opts?.onlyIfAbsent && get().messages.some((m) => m.id === slot.id)) {
          return;
        }
        set((state: ConnectionState) => ({
          streamingMessageId: slot.id,
          messages: [...state.messages, slot],
        }));
      }
    },

    // Peel `count` trailing chars off the flushed content of the response slot
    // at `deltaId`. Null target routes to flat messages.
    peelSlotContent: (targetSessionId, deltaId, count) => {
      const updater = (ss: { messages: ChatMessage[] }) => ({
        messages: ss.messages.map((m) =>
          m.id === deltaId && m.type === 'response'
            ? { ...m, content: m.content.slice(0, m.content.length - count) }
            : m
        ),
      });
      if (targetSessionId && get().sessionStates[targetSessionId]) {
        updateSession(targetSessionId, updater);
      } else {
        set((s) => ({ messages: updater({ messages: s.messages }).messages }));
      }
    },

    scheduleFlush: () => {
      if (!deltaFlushTimer) {
        deltaFlushTimer = setTimeout(flushPendingDeltas, 100);
      }
    },
  });
}

function handleStreamEnd(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // Flush any buffered deltas immediately before clearing streaming state
  if (deltaFlushTimer) {
    clearTimeout(deltaFlushTimer);
  }
  flushPendingDeltas();
  // Add newline separator after response ends for Output view readability
  get().appendTerminalData('\r\n');
  const out = sharedStreamEnd(msg, get().activeSessionId);
  // Clean up permission boundary split tracking. messageId is null for
  // malformed payloads (non-string msg.messageId) — skip cleanup in that case.
  if (out.messageId !== null) {
    _postPermissionSplits.delete(out.messageId);
    _deltaIdRemaps.delete(out.messageId);
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
    set((s) => ({ streamingMessageId: null, messages: [...s.messages] }));
  }
}

function handleToolStart(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  // Forward tool invocation to terminal view (dashboard-only side effect).
  // Performed unconditionally and BEFORE sharedToolStart so a JSON.stringify
  // throw on a non-serialisable msg.input (circular ref) cannot suppress the
  // terminal preview write — matches the prior inline ordering.
  const toolName = typeof msg.tool === 'string' ? msg.tool : 'tool';
  get().appendTerminalData(`\r\n\x1b[36m⏺ ${toolName}\x1b[0m\r\n`);
  const toolStartTargetId = typeof msg.sessionId === 'string' ? msg.sessionId : get().activeSessionId;
  const cached = (() => {
    const targetState = toolStartTargetId ? get().sessionStates[toolStartTargetId] : null;
    return targetState ? targetState.messages : get().messages;
  })();
  // #4493 — per-session replay scoping. Dedup against the cached history
  // only when THIS message's session is currently replaying.
  const toolStartIsReplay = toolStartTargetId ? _replayingSessions.has(toolStartTargetId) : false;
  const result = sharedToolStart(msg, get().activeSessionId, toolStartIsReplay, cached);
  if (!result.shouldDispatch || !result.chatMessage) return;
  const toolMsg = result.chatMessage;
  const targetId = result.sessionId;
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => {
      const patch: Partial<SessionState> = {
        messages: [...ss.messages, toolMsg],
      };
      // If the turn opened with a tool (no preamble text → no stream_start
      // yet), streamingMessageId is still 'pending' from sendInput. The 5-
      // second safety timer in sendInput would clear it, hiding the stop
      // button for the rest of the tool execution. Bump it to the tool
      // bubble's id (already normalized by sharedToolStart — falls back to a
      // synthesized id when msg.messageId is missing) so the timer no-ops;
      // the next stream_start will overwrite with the response id.
      if (ss.streamingMessageId === 'pending') {
        patch.streamingMessageId = toolMsg.id;
      }
      // #4308 — track the in-flight tool in activeTools[]. Same-reference
      // no-op (dedup by toolUseId) is honoured so a duplicate broadcast
      // doesn't churn state.
      const nextActiveTools = result.applyToActiveTools(ss.activeTools);
      if (nextActiveTools !== ss.activeTools) {
        patch.activeTools = nextActiveTools;
      }
      return patch;
    });
  } else {
    get().addMessage(toolMsg);
    // Same bump for the flat-state path (legacy / pre-session bootstrap).
    if (getStore().getState().streamingMessageId === 'pending') {
      getStore().setState({ streamingMessageId: toolMsg.id });
    }
  }
}

function handleToolInputDelta(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // #4081: append the partialJson chunk to the matching tool_use
  // bubble's `toolInputPartial` accumulator. sharedToolInputDelta
  // validates the wire payload (toolUseId + partialJson string types),
  // resolves sessionId, and returns an `applyTo` that no-ops when no
  // matching tool_use is found (mirrors handleToolResult). Permission-
  // pending suppression lives on the server (#4080) — by the time a
  // delta reaches this handler the bubble is guaranteed to be the
  // live target.
  const result = sharedToolInputDelta(msg, get().activeSessionId);
  if (!result) return;
  const targetId = result.sessionId;
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss: SessionState) => {
      const updated = result.applyTo(ss.messages);
      if (updated === ss.messages) return {};
      return { messages: updated };
    });
  } else {
    const updated = result.applyTo(get().messages);
    if (updated !== get().messages) {
      set({ messages: updated });
    }
  }
}

function handleToolResult(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const result = sharedToolResult(msg, get().activeSessionId);
  if (!result) return;
  // Forward tool result to terminal view (dashboard-only side effect).
  if (result.resultText) {
    const preview = result.resultText.length > 500
      ? result.resultText.slice(0, 500) + '...'
      : result.resultText;
    get().appendTerminalData(`\x1b[2m${preview}\x1b[0m\r\n`);
  }
  const targetId = result.sessionId;
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss: SessionState) => {
      const updated = result.applyTo(ss.messages);
      // #4308 — drop the resolved entry from activeTools[]. Same-reference
      // no-op (tool not currently tracked) is honoured to skip the write.
      const nextActiveTools = result.applyToActiveTools(ss.activeTools);
      const patch: Partial<SessionState> = {};
      if (updated !== ss.messages) patch.messages = updated;
      if (nextActiveTools !== ss.activeTools) patch.activeTools = nextActiveTools;
      return patch;
    });
  } else {
    const updated = result.applyTo(get().messages);
    if (updated !== get().messages) {
      set({ messages: updated });
    }
  }
}

function handlePermissionRequest(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // Split streaming response at permission boundary (#554)
  {
    const permTargetId = (msg.sessionId as string) || get().activeSessionId;
    const currentStreamId = permTargetId && get().sessionStates[permTargetId]
      ? get().sessionStates[permTargetId]!.streamingMessageId
      : get().streamingMessageId;
    if (currentStreamId && currentStreamId !== 'pending') {
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer);
      }
      flushPendingDeltas();
      let serverStreamId = currentStreamId;
      for (const [origId, remappedId] of _deltaIdRemaps) {
        if (remappedId === currentStreamId) {
          serverStreamId = origId;
          break;
        }
      }
      _postPermissionSplits.add(serverStreamId);
      if (permTargetId && get().sessionStates[permTargetId]) {
        updateSession(permTargetId, () => ({ streamingMessageId: null }));
      } else {
        set({ streamingMessageId: null });
      }
    }
  }
  const permRequestId = msg.requestId as string;
  // #2853: PermissionPrompt hardcodes its own buttons (Allow / Allow for Session
  // / Deny) and never reads this array; `sendPermissionResponse` only accepts
  // 'allow' | 'deny' | 'allowSession'. Keep only the wire-level allow/deny
  // options in the stored payload for history/debug inspection, without
  // advertising dashboard-only decisions ('allowSession') or unreachable ones
  // ('allowAlways') here.
  const newOptions = [
    { label: 'Allow', value: 'allow' },
    { label: 'Deny', value: 'deny' },
  ];
  const newExpiresAt = typeof msg.remainingMs === 'number' ? Date.now() + msg.remainingMs : undefined;
  const permTargetId = (msg.sessionId as string) || get().activeSessionId;

  const targetMessages = permTargetId && get().sessionStates[permTargetId]
    ? get().sessionStates[permTargetId]!.messages
    : get().messages;
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
    if (permTargetId && get().sessionStates[permTargetId]) {
      updateSession(permTargetId, updater);
    } else {
      set({ messages: updater({ messages: get().messages }).messages });
    }
  } else {
    // Validate string fields up front so the prompt content and tool slot
    // are guaranteed strings — non-string `msg.tool`/`msg.description` could
    // otherwise leak through `as string` casts and violate ChatMessage.content.
    const tool = typeof msg.tool === 'string' ? msg.tool : null;
    const description = typeof msg.description === 'string' ? msg.description : null;
    const permMsg: ChatMessage = {
      id: nextMessageId('perm'),
      type: 'prompt',
      // Render only the tool name when description is missing; otherwise
      // combine `"<tool>: <description>"`. Fallback to a generic label when
      // neither is available. Fixes the "Tool: undefined" string that the
      // prior `${tool}: ${description}` template produced (#3122).
      content: tool
        ? (description ? `${tool}: ${description}` : tool)
        : (description || 'Permission required'),
      tool: tool ?? undefined,
      requestId: permRequestId,
      // Reject arrays — match the tightened guard in handlePermissionRequest (#3123)
      toolInput: msg.input && typeof msg.input === 'object' && !Array.isArray(msg.input) ? msg.input as Record<string, unknown> : undefined,
      options: newOptions,
      expiresAt: newExpiresAt,
      timestamp: Date.now(),
    };
    if (permTargetId && get().sessionStates[permTargetId]) {
      updateSession(permTargetId, (ss) => ({
        messages: [...ss.messages, permMsg],
      }));
    } else {
      get().addMessage(permMsg);
    }
  }
  if (permTargetId) {
    const toolDesc = msg.tool ? `${msg.tool}` : 'Permission needed';
    pushSessionNotification(permTargetId, 'permission', toolDesc, permRequestId);
  }
}

function handlePermissionResolved(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // Another client resolved this permission — dismiss the prompt on this client.
  // The permission_request may have been stored in ANY session state (whichever tab
  // was active when it arrived), so search all session states for the matching requestId.
  const resolvedRequestId = msg.requestId as string;
  const resolvedDecision = msg.decision as string;
  if (resolvedRequestId) {
    const updater = (ss: { messages: ChatMessage[] }) => ({
      messages: ss.messages.map((m) =>
        m.requestId === resolvedRequestId && m.type === 'prompt'
          ? { ...m, answered: resolvedDecision, answeredAt: Date.now(), options: undefined }
          : m
      ),
    });
    // Search all session states for the permission prompt
    const states = get().sessionStates;
    let found = false;
    for (const sid of Object.keys(states)) {
      if (states[sid]?.messages.some((m) => m.requestId === resolvedRequestId)) {
        updateSession(sid, updater);
        found = true;
        break;
      }
    }
    // Also check flat messages (fallback for sessions not in sessionStates)
    if (!found) {
      set({ messages: updater({ messages: get().messages }).messages });
    }
    // #5008 — drain the banner stack (which filters by `readAt === undefined`)
    // without dropping the entry from `sessionNotifications`. Pre-#5008 we
    // hard-removed the row, which silently drained every resolved alert from
    // the NotificationsWidget's "durable history" view. Stamping `readAt`
    // instead keeps the row visible in the widget (read row treatment) while
    // the banner stack still vanishes.
    //
    // Idempotent — only stamp entries that have not already been acked, so a
    // server-driven resolution arriving after the operator already marked the
    // row read via the widget can't clobber the original ack timestamp.
    //
    // Hoist `Date.now()` out of the `.map(...)` so every matching row in this
    // mutation shares a single timestamp. Matches the existing pattern at
    // connection.ts:2167 (`switchReadStamp`) and connection.ts:2461
    // (`markAllSessionNotificationsRead`).
    const readStamp = Date.now();
    set((s) => ({
      sessionNotifications: s.sessionNotifications.map((n) =>
        n.requestId === resolvedRequestId && n.readAt === undefined
          ? { ...n, readAt: readStamp }
          : n
      ),
    }));
  }
}

function handleBudgetWarning(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const { warningMessage, systemMessage } = sharedBudgetWarning(msg);
  _adapters.alert.alert('Budget Warning', warningMessage);
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => ({
      messages: [...ss.messages, systemMessage],
    }));
  } else {
    get().addMessage(systemMessage);
  }
}

function handleBudgetExceeded(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const { exceededMessage, systemMessage } = sharedBudgetExceeded(msg);
  const targetId = resolveSessionId(msg, get().activeSessionId);
  // Dashboard auto-resumes — append note to the system message
  const dashboardMsg: ChatMessage = {
    ...systemMessage,
    content: `${systemMessage.content}. Budget will auto-resume.`,
  };
  // Add system message BEFORE auto-resume so it's visible in the UI
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => ({
      messages: [...ss.messages, dashboardMsg],
    }));
  } else {
    get().addMessage(dashboardMsg);
  }
  // Show toast notification
  _adapters.alert.alert('Budget Exceeded', `${exceededMessage}\n\nNew messages are paused.`);
  // Auto-resume budget
  const socket = get().socket;
  if (socket && targetId) {
    wsSend(socket, { type: 'resume_budget', sessionId: targetId });
  }
}

function handleBudgetResumed(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const { systemMessage } = sharedBudgetResumed();
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => ({
      messages: [...ss.messages, systemMessage],
    }));
  } else {
    get().addMessage(systemMessage);
  }
}

function handleServerError(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const { serverError, chatMessage: errorMsg } = sharedServerError(msg);
  set((state: ConnectionState) => ({
    serverErrors: [...state.serverErrors, serverError].slice(-10),
  }));
  const errSessionId = serverError.sessionId;
  if (errSessionId && get().sessionStates[errSessionId]) {
    // Scoped error — route to the specific session only
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
    } else {
      set({ streamingMessageId: null });
      get().addMessage(errorMsg);
    }
  }
  if (!serverError.recoverable) {
    _adapters.alert.alert('Server Error', serverError.message);
  }
}

function handleServerShutdown(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  set(sharedServerShutdown(msg));
}

/**
 * #5163 (epic #5159) — Control Room `activity_snapshot`: REPLACE the target
 * session's activity tree with the snapshot's entries via the store-core
 * reducer. Emitted on subscribe / resync so a late-joining or reconnecting
 * client reaches canonical state in one message.
 *
 * The wire shape is validated with the protocol Zod schema (same defensive
 * pattern as the credential-status handlers) so a malformed payload is dropped
 * rather than crashing the reducer. `applyActivityDelta`/`applyActivitySnapshot`
 * return the SAME state reference on a no-op, so the equality short-circuit
 * below skips a needless re-render.
 */
function handleActivitySnapshot(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerActivitySnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  const prev = get().activity;
  const next = applyActivitySnapshot(prev, parsed.data);
  if (next === prev) return;
  set({ activity: next });
}

/**
 * #5163 (epic #5159) — Control Room `activity_delta`: upsert the carried entry
 * into its session by id. `op` is advisory — the full entry drives the result,
 * so a dropped earlier delta is self-healed by the next one. Validated +
 * no-op-short-circuited like the snapshot handler above.
 *
 * Copilot review: an `activity_delta` is a genuine live state change (a
 * background shell / subagent / tool started, progressed, or ended), so it
 * also counts as activity-bearing — bump `lastClientActivityAt` and clear any
 * outstanding `inactivityWarning` for the delta's session so the "Working… last
 * activity Ns ago" indicator and the inactivity chip don't go stale while only
 * Control Room traffic is flowing. Gated on `_replayingSessions` exactly like
 * the dispatch-level bump (#4466) so a session switch's history replay doesn't
 * reset the timestamp. NOTE: `activity_snapshot` deliberately does NOT bump —
 * it's a full-state resync emitted on subscribe / reconnect, not fresh work.
 */
function handleActivityDelta(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerActivityDeltaSchema.safeParse(msg);
  if (!parsed.success) return;
  const prev = get().activity;
  const next = applyActivityDelta(prev, parsed.data);
  if (next === prev) return;
  set({ activity: next });

  // #5277: if a node we were cancelling just went terminal (whether from the
  // cancel itself or natural completion racing it), drop its pending state so
  // the id can't leak in cancellingActivityIds after the row is gone/finished.
  if (parsed.data.op === 'ended') {
    clearCancellingActivity(get, set, parsed.data.entry.id);
  }

  const sessionId = parsed.data.sessionId;
  if (get().sessionStates[sessionId] && !_replayingSessions.has(sessionId)) {
    updateSession(sessionId, (ss) => {
      const patch: Partial<SessionState> = { lastClientActivityAt: Date.now() };
      if (ss.inactivityWarning) patch.inactivityWarning = null;
      return patch;
    });
  }
}

/**
 * #5277 — Control Room `cancel_activity_ack`: positive confirmation that a
 * cancel_activity request was actioned. Clears the node's "cancelling" pending
 * state (the terminal activity_delta separately updates the tree itself).
 */
function handleCancelActivityAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerCancelActivityAckSchema.safeParse(msg);
  if (!parsed.success) return;
  clearCancellingActivity(get, set, parsed.data.activityId);
}

/**
 * #5277 — drop an activity id from the in-flight cancel set (shared by the
 * success ack and the CANCEL_ACTIVITY_FAILED session_error). No-op if absent.
 */
function clearCancellingActivity(get: MsgGet, set: MsgSet, activityId: string | undefined): void {
  if (!activityId) return;
  const prev = get().cancellingActivityIds;
  if (!prev || !prev.has(activityId)) return;
  const next = new Set(prev);
  next.delete(activityId);
  set({ cancellingActivityIds: next });
}

/**
 * #5175 (epic #5170) — Host/Repo Status Control Room `host_status_snapshot`:
 * REPLACE the stored survey with the carried snapshot and clear the in-flight
 * loading flag. The survey is a full picture (no delta stream), so each
 * snapshot wholesale-replaces the previous one — the Control Room section
 * re-renders the fleet table from `hostStatus`.
 *
 * The wire shape is validated with the protocol Zod schema (same defensive
 * pattern as the activity / credential-status handlers) so a malformed payload
 * is dropped rather than crashing the renderer. `hostStatusLoading` is cleared
 * even on a successful parse only — a malformed payload leaves the spinner up
 * so a buggy server doesn't make the Refresh button silently lie.
 */
function handleHostStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerHostStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ hostStatus: parsed.data, hostStatusLoading: false });
}

/**
 * #5253 — self-hosted runner survey `runner_status_snapshot`: REPLACE the
 * stored runner survey and clear the loading flag. Same defensive,
 * full-replace, clear-loading-only-on-valid-parse contract as the host survey
 * handler above.
 */
function handleRunnerStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerRunnerStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ runnerStatus: parsed.data, runnerStatusLoading: false });
}

/**
 * Map of message type → handler function for the simplest, most self-contained
 * cases. handleMessage() dispatches to this map first; unmatched types fall
 * through to the legacy switch statement below.
 */
const HANDLERS: Record<string, Handler> = {
  pong: handlePong,
  raw: handleRaw,
  raw_background: handleRawBackground,
  token_rotated: handleTokenRotated,
  pairing_refreshed: handlePairingRefreshed,
  checkpoint_restored: handleCheckpointRestored,
  web_feature_status: handleWebFeatureStatus,
  web_task_list: handleWebTaskList,
  conversations_list: handleConversationsList,
  model_changed: handleModelChanged,
  thinking_level_changed: handleThinkingLevelChanged,
  prompt_evaluator_changed: handlePromptEvaluatorChanged,
  chroxy_context_hint_changed: handleChroxyContextHintChanged,
  session_preamble_changed: handleSessionPreambleChanged,
  // #3188: auto-evaluator broadcast events (#3186 emit, #3208 schema)
  evaluator_rewrite: handleEvaluatorRewrite,
  evaluator_clarify: handleEvaluatorClarify,
  skills_list: handleSkillsList,
  skill_changed: handleSkillChanged,
  skill_activated: handleSkillActivated,
  skill_trust_accepted: handleSkillTrustAccepted,
  skill_deactivated: handleSkillDeactivated,
  skill_trust_request: handleSkillTrustRequest,
  skill_trust_granted: handleSkillTrustGranted,
  skill_trust_grant_ok: handleSkillTrustGrantOk,
  permission_mode_changed: handlePermissionModeChanged,
  available_permission_modes: handleAvailablePermissionModes,
  session_updated: handleSessionUpdated,
  session_switched: handleSessionSwitched,
  claude_ready: handleClaudeReady,
  agent_idle: handleAgentIdle,
  agent_busy: handleAgentBusy,
  stream_start: handleStreamStart,
  stream_delta: handleStreamDelta,
  stream_end: handleStreamEnd,
  tool_start: handleToolStart,
  tool_input_delta: handleToolInputDelta,
  tool_result: handleToolResult,
  permission_request: handlePermissionRequest,
  permission_resolved: handlePermissionResolved,
  budget_warning: handleBudgetWarning,
  budget_exceeded: handleBudgetExceeded,
  budget_resumed: handleBudgetResumed,
  server_error: handleServerError,
  server_shutdown: handleServerShutdown,
  // #5163 (epic #5159): Control Room live activity tree.
  activity_snapshot: handleActivitySnapshot,
  activity_delta: handleActivityDelta,
  // #5277: positive ack correlating a cancel_activity request to its outcome.
  cancel_activity_ack: handleCancelActivityAck,
  // #5175 (epic #5170): Host/Repo Status Control Room survey snapshot.
  host_status_snapshot: handleHostStatusSnapshot,
  // #5253: self-hosted runner Control Room survey snapshot.
  runner_status_snapshot: handleRunnerStatusSnapshot,
};

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

  // #3758 — bump lastClientActivityAt for activity-bearing events BEFORE
  // any per-case handler runs. Doing it here keeps the bump in one place
  // instead of threading it through every stream_*/tool_*/message handler.
  // Mirrors the logic in packages/app/src/store/message-handler.ts.
  //
  // #3899 — any activity event also dismisses an outstanding inactivity
  // warning: by definition the silence has ended, so the chip should
  // disappear without waiting for the user to dismiss it manually.
  //
  // #4466 — gate on the replay set. switch_session on the server replays
  // every past event in the target session through this handler, and a
  // replayed tool_start / message / result is NOT fresh activity. Without
  // this gate the act of switching tabs:
  //   1) bumps lastClientActivityAt to Date.now(), so "Working… last
  //      activity Ns ago" resets to 1s no matter how idle the session was;
  //   2) wipes inactivityWarning, so the "Agent quiet for 46m 32s · Status
  //      update?" chip disappears without the user ever seeing it again.
  // The live activity events that arrive AFTER history_replay_end removes
  // the session from the set still bump correctly — verified by the
  // regression-guard tests in message-handler.test.ts.
  //
  // #4493 — gate per target session id (Set membership), not a module flag.
  // `replayHistory()` chunks over setImmediate, so live broadcasts from
  // session B can interleave with A's replay. A module-wide boolean would
  // wrongly suppress B's live activity bump for the duration of A's replay.
  if (isActivityEvent(msg.type)) {
    const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || get().activeSessionId;
    if (targetId && get().sessionStates[targetId] && !_replayingSessions.has(targetId)) {
      updateSession(targetId, (ss) => {
        const patch: Partial<SessionState> = { lastClientActivityAt: Date.now() };
        if (ss.inactivityWarning) patch.inactivityWarning = null;
        return patch;
      });
    }
  }

  // Dispatch to the handler map first — extracted, self-contained cases.
  const handler = HANDLERS[msg.type];
  if (handler) {
    handler(msg, get, set, ctx);
    return;
  }

  switch (msg.type) {

    case 'auth_ok': {
      // Reset replay flags — fresh auth means clean slate (#4493: clear the
      // per-session replaying set so a reconnect doesn't leave stale ids
      // gating future activity bumps).
      _replayingSessions.clear();
      // Track this URL as successfully connected
      lastConnectedUrl = ctx.url;
      // #4766: full wire-shape decode lives in the shared parser
      // (handleAuthOk + parseConnectedClients). The dashboard assembles the
      // platform-specific `set()` patch from the parsed payload below.
      const auth = sharedAuthOk(msg);
      const clients = sharedParseConnectedClients(msg.connectedClients, auth.myClientId);

      // On reconnect, preserve messages and terminal buffer
      const connectedState = {
        connectionPhase: 'connected' as const,
        viewingCachedSession: false,
        wsUrl: ctx.url,
        apiToken: ctx.token,
        socket: ctx.socket,
        claudeReady: false,
        serverMode: auth.serverMode,
        sessionCwd: auth.sessionCwd,
        defaultCwd: auth.defaultCwd,
        serverVersion: auth.serverVersion,
        latestVersion: auth.latestVersion,
        serverCommit: auth.serverCommit,
        serverProtocolVersion: auth.protocolVersion,
        serverResultTimeoutMs: auth.resultTimeoutMs,
        streamStallTimeoutMs: auth.streamStallTimeoutMs,
        streamingMessageId: null,
        myClientId: auth.myClientId,
        connectedClients: clients,
        connectionError: null as string | null,
        connectionRetryCount: 0,
        // Clear shutdown / startup state on successful connect
        serverPhase: null,
        tunnelProgress: null,
        shutdownReason: null,
        restartEtaMs: null,
        restartingSince: null,
        webFeatures: auth.webFeatures,
        serverCapabilities: auth.serverCapabilities,
      };
      if (ctx.isReconnect) {
        set(connectedState);
      } else {
        set({
          ...connectedState,
          messages: [],
          terminalBuffer: '',
          terminalRawBuffer: '',
          sessions: [],
          activeSessionId: null,
          sessionStates: {},
          customAgents: [],
        });
      }
      // Start client-side heartbeat for dead connection detection
      startHeartbeat(ctx.socket);

      // Initiate key exchange if server requires encryption
      if (auth.encryption === 'required') {
        _pendingKeyPair = createKeyPair();
        _pendingSalt = generateConnectionSalt();
        // Send key_exchange plaintext (before encryption is active)
        ctx.socket.send(JSON.stringify({ type: 'key_exchange', publicKey: _pendingKeyPair.publicKey, salt: _pendingSalt }));
        // Post-auth messages will be sent after key_exchange_ok arrives
      } else {
        // No encryption — send post-auth messages immediately
        wsSend(ctx.socket, { type: 'list_providers' });
        wsSend(ctx.socket, { type: 'list_slash_commands' });
        wsSend(ctx.socket, { type: 'list_agents' });
        // #3671: server defaults visible=true on a fresh connect; sync if we
        // reconnected while the tab was hidden so completion pushes fire.
        resetClientVisibleMemo();
        if (typeof document !== 'undefined') {
          sendClientVisible(ctx.socket, document.visibilityState === 'visible');
        }
      }
      // Save for quick reconnect
      saveConnection(ctx.url, ctx.token);
      set({ savedConnection: { url: ctx.url, token: ctx.token } });
      break;
    }

    case 'key_exchange_ok': {
      if (_pendingKeyPair) {
        const { publicKey: serverPublicKey } = sharedKeyExchangeOk(msg);
        if (!serverPublicKey) {
          console.error('[crypto] Invalid publicKey in key_exchange_ok message', msg.publicKey);
          ctx.socket.close();
          set({ connectionPhase: 'disconnected', socket: null });
          _pendingKeyPair = null;
          _pendingSalt = null;
          break;
        }
        const rawSharedKey = deriveSharedKey(serverPublicKey, _pendingKeyPair.secretKey);
        const encryptionKey = _pendingSalt
          ? deriveConnectionKey(rawSharedKey, _pendingSalt)
          : rawSharedKey;
        _encryptionState = { sharedKey: encryptionKey, sendNonce: 0, recvNonce: 0 };
        _pendingKeyPair = null;
        _pendingSalt = null;
        console.log('[crypto] E2E encryption established');
        // Now send the post-auth messages that were deferred
        wsSend(ctx.socket, { type: 'list_providers' });
        wsSend(ctx.socket, { type: 'list_slash_commands' });
        wsSend(ctx.socket, { type: 'list_agents' });
        // #3671: sync visibility once encryption is established (mirrors the
        // unencrypted auth_ok path above).
        resetClientVisibleMemo();
        if (typeof document !== 'undefined') {
          sendClientVisible(ctx.socket, document.visibilityState === 'visible');
        }
      }
      break;
    }

    case 'auth_fail': {
      ctx.socket.close();
      set({ connectionPhase: 'disconnected', socket: null });
      if (!ctx.silent) {
        const { reason } = sharedAuthFail(msg);
        _adapters.alert.alert('Auth Failed', reason);
      }
      break;
    }

    case 'server_mode': {
      const { mode } = sharedServerMode(msg);
      if (mode) {
        set({ serverMode: mode });
      } else {
        _adapters.alert.alert('Invalid Server Mode', `Ignoring invalid server_mode value: ${msg.mode}`);
      }
      break;
    }

    // --- Multi-session messages ---

    case 'session_list': {
      // #4767: centralised dispatch — store-core precomputes GC + new-session
      // ids + conversationId / cumulativeUsage / pendingShells patch maps;
      // the consumer applies them with platform-specific side-effects
      // (dashboard's activeModel lookup + isBusy → isIdle resync stay here).
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
      } = patches;
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
        // #5163: drop the Control Room activity tree for any session that
        // dropped out of the list so a closed session's tree doesn't linger.
        let nextActivity = get().activity;
        for (const id of removedIds) {
          nextActivity = clearSessionActivity(nextActivity, id);
        }
        if (nextActivity !== get().activity) patch.activity = nextActivity;
        // If the active session was removed, switch to next available
        if (initialActiveId && removedIds.includes(initialActiveId)) {
          const remaining = Object.keys(newStates);
          const nextId = remaining.length > 0 ? remaining[0] : null;
          patch.activeSessionId = nextId;
          if (nextId && newStates[nextId]) {
            const ss = newStates[nextId];
            patch.messages = ss.messages;
            patch.streamingMessageId = ss.streamingMessageId;
            patch.claudeReady = ss.claudeReady;
            patch.activeModel = ss.activeModel;
            patch.permissionMode = ss.permissionMode;
            patch.contextUsage = ss.contextUsage;
            patch.lastResultCost = ss.lastResultCost;
            patch.lastResultDuration = ss.lastResultDuration;
            patch.isIdle = ss.isIdle;
          } else {
            patch.messages = [];
            patch.streamingMessageId = null;
            patch.claudeReady = false;
            patch.activeModel = null;
            patch.permissionMode = null;
            patch.contextUsage = null;
            patch.lastResultCost = null;
            patch.lastResultDuration = null;
            patch.isIdle = true;
          }
        }
        set(patch);
      }
      set({ sessions: sessionList });
      // Sync activeModel from session list to prevent dropdown reset.
      // session_list sends full model IDs (e.g. claude-sonnet-4-5-20250929) but the
      // dropdown uses short IDs (e.g. sonnet). Resolve via availableModels lookup.
      const activeSessionId = get().activeSessionId;
      if (activeSessionId) {
        const activeSessionInfo = sessionList.find((s: { sessionId?: string }) => s.sessionId === activeSessionId);
        if (activeSessionInfo?.model) {
          const fullId = activeSessionInfo.model as string;
          const models = get().availableModels;
          const matched = models.find((m) => m.fullId === fullId || m.id === fullId);
          set({ activeModel: matched ? matched.id : fullId });
        }
      }
      // Initialize session state for any new sessions not yet tracked.
      // #4639: seed `isIdle` from the server's authoritative `isBusy` so a
      // fresh tab / new-session entry reflects the real working state
      // instead of defaulting to `isIdle: true` and silently dropping the
      // Working banner until the next live event arrives.
      if (newSessionIds.length > 0) {
        const currentStates = get().sessionStates;
        const newInitStates = { ...currentStates };
        const sessionsBySid = new Map(sessionList.map((s) => [s.sessionId, s]));
        for (const sid of newSessionIds) {
          if (!newInitStates[sid]) {
            const fresh = createEmptySessionState();
            const s = sessionsBySid.get(sid);
            if (s && typeof s.isBusy === 'boolean') fresh.isIdle = !s.isBusy;
            newInitStates[sid] = fresh;
          }
        }
        set({ sessionStates: newInitStates });
      }
      // #4639: resync `isIdle` on EXISTING session states against the
      // snapshot's `isBusy`. Without this, a session that became busy on
      // the server while the dashboard's local handlers missed the flip
      // (tab swap during a long turn, peer-tab triggered the work, race
      // between agent_busy and history_replay) shows the wrong banner and
      // the wrong Send/Stop button. The snapshot is the source of truth.
      for (const s of sessionList) {
        if (typeof s.isBusy !== 'boolean') continue;
        if (!get().sessionStates[s.sessionId]) continue;
        const desiredIsIdle = !s.isBusy;
        updateSession(s.sessionId, (ss) =>
          ss.isIdle === desiredIsIdle ? {} : { isIdle: desiredIsIdle }
        );
      }
      // Sync conversationId from session list into session states
      for (const [sid, cid] of conversationIdPatches) {
        if (!get().sessionStates[sid]) continue;
        updateSession(sid, (ss) =>
          ss.conversationId !== cid ? { conversationId: cid } : {}
        );
      }
      // #4073: seed cumulativeUsage from the snapshot so refreshing the
      // dashboard mid-session shows the running total without waiting
      // for the next session_usage event to land. listSessions on the
      // server emits the field with zero defaults when no result has
      // landed yet — `cumulativeUsage` is undefined only when an older
      // server omits it entirely. Six-field equality short-circuit lives
      // in store-core via {@link sharedCumulativeUsageEquals} (#4767).
      for (const [sid, snapshot] of cumulativeUsagePatches) {
        if (!get().sessionStates[sid]) continue;
        updateSession(sid, (ss) =>
          sharedCumulativeUsageEquals(ss.cumulativeUsage, snapshot)
            ? {}
            : { cumulativeUsage: snapshot }
        );
      }
      // #4307: seed pendingBackgroundShells from the snapshot so a
      // fresh tab / reconnect catches up to any sessions already
      // waiting on background work without needing the next
      // background_work_changed event to arrive. The
      // `handleBackgroundWorkChanged` builder does the
      // same-reference short-circuit so duplicate seeds don't
      // re-render. The field is optional on `SessionInfo` because
      // older servers omit it; treat `undefined` as "no waiting
      // work" (empty array passthrough).
      for (const [sid, builder] of backgroundShellBuilders) {
        if (!get().sessionStates[sid]) continue;
        updateSession(sid, (ss) => {
          const next = builder.applyTo(ss.pendingBackgroundShells);
          return next === ss.pendingBackgroundShells
            ? {}
            : { pendingBackgroundShells: next };
        });
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

    case 'session_activity': {
      // #4639: server-emitted busy/idle broadcast (ws-forwarding.js fires it
      // on stream_start and result for every session, to every authenticated
      // client). Pre-fix the dashboard had no handler, so a peer tab driving
      // the session — or this tab's own session_list snapshot — was the only
      // way to learn about busy state changes for non-active sessions. That
      // gap is what made the Working banner desync after a tab swap.
      //
      // Defensive: ignore if either field is missing/wrong type, and skip
      // unknown sessions (session_list is responsible for seeding new
      // entries — we don't want session_activity racing it).
      const activitySessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      const activityIsBusy = typeof msg.isBusy === 'boolean' ? msg.isBusy : null;
      if (activitySessionId && activityIsBusy !== null && get().sessionStates[activitySessionId]) {
        const desiredIsIdle = !activityIsBusy;
        updateSession(activitySessionId, (ss) =>
          ss.isIdle === desiredIsIdle ? {} : { isIdle: desiredIsIdle }
        );
      }
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

    case 'evaluate_draft_result': {
      // #3068: route to the resolver registered by the matching evaluateDraft()
      // call. Drop on the floor if there's no waiter — the request was
      // cancelled or already timed out, so the late-arriving result is moot.
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      if (requestId) {
        const entry = _evaluatorPending.get(requestId);
        if (entry) {
          _evaluatorPending.delete(requestId);
          window.clearTimeout(entry.timeoutId);
          entry.resolve({
            verdict: msg.verdict as 'forward' | 'rewrite' | 'clarify' | undefined,
            rewritten: typeof msg.rewritten === 'string' ? msg.rewritten : null,
            clarification: typeof msg.clarification === 'string' ? msg.clarification : null,
            reasoning: typeof msg.reasoning === 'string' ? msg.reasoning : '',
            // #3100: forward optional `status` so the InputBar can branch on
            // 401 (auth) / 429 (rate-limit) / 5xx (service down) for the
            // recovery hint without parsing message text.
            error: msg.error as { code: string; message: string; status?: number } | undefined,
          });
        }
      }
      break;
    }

    case 'session_error': {
      // Crash branch: flip session health + notify; non-crash branch: rewrite
      // SESSION_TOKEN_MISMATCH into the actionable bound-session hint (#2904)
      // and surface via toast/banner. Parser is shared via store-core; the
      // platform-specific surfaces (notification, alert, server error banner)
      // stay here.
      const parsed = sharedSessionError(msg, get().activeSessionId);
      // #5277: a CANCEL_ACTIVITY_FAILED echoes the activityId — clear its
      // pending "cancelling" state so the ActivityTree button recovers.
      if (parsed.code === 'CANCEL_ACTIVITY_FAILED' && typeof msg.activityId === 'string') {
        clearCancellingActivity(get, set, msg.activityId);
      }
      if (parsed.category === 'crash' && parsed.sessionPatch) {
        const crashedId = parsed.sessionPatch.sessionId;
        if (crashedId && get().sessionStates[crashedId]) {
          updateSession(crashedId, () => ({ health: 'crashed' as const }));
          pushSessionNotification(crashedId, 'error', 'Session crashed');
        }
      } else if (parsed.code === 'SESSION_NOT_FOUND') {
        // #4982 — dashboard's persisted `activeSessionId` points at a
        // pre-restart session id that no longer exists after
        // `session-manager.restoreState()` regenerated ids on the daemon
        // side (#4979). Without clearing the stale id, the next user send
        // trips the same error in a loop and the operator stays wedged.
        //
        // The SessionNotFoundChip reads `sessionNotFoundError` from the
        // store and renders an actionable banner over the empty-state
        // pane. The toast still fires so the operator sees the immediate
        // signal too, but the loop stops because activeSessionId is gone
        // and the next send addresses a different (operator-picked) id.
        get().setSessionNotFoundError({
          attemptedSessionId: parsed.attemptedSessionId ?? null,
          message: parsed.message ?? 'Session not found.',
        });
        set({ activeSessionId: null });
        if (parsed.message) {
          _adapters.alert.alert('Session Restarted', parsed.message);
          get().addServerError(parsed.message);
        }
      } else if (parsed.message) {
        _adapters.alert.alert('Session Error', parsed.message);
        get().addServerError(parsed.message);
      }
      break;
    }

    case 'session_stopped': {
      // #4878: quiet, informational confirmation when CliSession exits
      // cleanly after a user-initiated Stop. The wire path was wired in
      // #4868 (CliSession 'stopped' → SessionManager → ws-forwarding →
      // ServerSessionStoppedSchema). Routed through `addInfoNotification`
      // (info-level toast, not the red `addServerError` reserved for
      // crashes / STREAM_ERROR / ABORT) so the operator gets a positive
      // "you clicked Stop and the session did indeed stop" confirmation.
      //
      // A non-zero exit code is surfaced as a small diagnostic suffix
      // (e.g. "Session stopped. (exit 143)" for SIGTERM). Code 0 is the
      // common clean-exit case and gets no decoration — the bare
      // "Session stopped." carries the full signal there. Missing code
      // (future in-process providers per the #4756 follow-up) is also
      // bare; surfacing "(exit undefined)" would be noisier than useful.
      const stoppedCode = typeof msg.code === 'number' ? msg.code : null;
      const stoppedMessage = stoppedCode != null && stoppedCode !== 0
        ? `Session stopped. (exit ${stoppedCode})`
        : 'Session stopped.';
      get().addInfoNotification(stoppedMessage);
      break;
    }

    // --- History replay ---

    case 'history_replay_start': {
      // Parser is shared via store-core; flag mutation stays at this call
      // site (module-level state, not store state).
      const { fullHistory, sessionId: replayTargetId } = sharedHistoryReplayStart(
        msg,
        get().activeSessionId,
      );
      // #4493 — track per-session. Falls back to activeSessionId via
      // sharedHistoryReplayStart, matching the gate's targetId resolution.
      if (replayTargetId) _replayingSessions.add(replayTargetId);
      // Full history replay (from request_full_history): clear messages before replay
      if (fullHistory) {
        if (replayTargetId && get().sessionStates[replayTargetId]) {
          updateSession(replayTargetId, () => ({ messages: [] }));
        }
      }
      // Clear transient state — these events are not replayed from history,
      // so any surviving entries are stale from pre-disconnect
      updateActiveSession((ss) => {
        const patch: Partial<SessionState> = {};
        if (ss.activeAgents.length > 0) patch.activeAgents = [];
        // #4466: preserve activeTools through the replay boundary. The
        // earlier #4308 wipe rebuilt entries from replayed tool_start
        // events with startedAt = Date.now(), so the "Running <tool> · Ns"
        // pill restarted at 1s every time the user switched tabs. The
        // in-flight set is authoritative (carried in-memory, not derivable
        // from history), so keeping it intact preserves the elapsed-time
        // clock. tool_result events that fire during replay still
        // correctly drop resolved entries via sharedToolResult, and the
        // dedup logic in sharedToolStart prevents replayed tool_start
        // events from re-adding tools already in activeTools.
        if (ss.isPlanPending) {
          patch.isPlanPending = false;
          patch.planAllowedPrompts = [];
        }
        return Object.keys(patch).length > 0 ? patch : {};
      });
      break;
    }

    case 'history_replay_end':
      // Parser is shared via store-core; flag mutation stays here.
      sharedHistoryReplayEnd();
      // #4493 — remove this session id from the replaying set. Falls back
      // to activeSessionId to mirror sharedHistoryReplayStart's resolution.
      {
        const endTargetId =
          (typeof msg.sessionId === 'string' && msg.sessionId) || get().activeSessionId;
        if (endTargetId) _replayingSessions.delete(endTargetId);
      }
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
      // Server broadcasts user_input to all OTHER clients when someone sends a message.
      // Skip if it came from this client (we already show it via optimistic UI).
      const userInput = sharedUserInput(msg, get().myClientId, get().activeSessionId);
      if (!userInput) break;
      // Write user message to terminal buffer for Output view
      if (userInput.content) {
        get().appendTerminalData(`\r\n\x1b[33m> ${userInput.content}\x1b[0m\r\n\r\n`);
      }
      // #3188: a remote client just answered (or otherwise sent a fresh
      // user_input for this session). Any locally-rendered evaluator
      // clarify prompt is now stale — clear it so two paired clients
      // don't both keep showing the question after one has responded.
      updateSession(userInput.sessionId, (ss) => {
        const patch: Partial<SessionState> = {
          messages: [...ss.messages, userInput.chatMessage],
        };
        if (ss.pendingEvaluatorClarify) patch.pendingEvaluatorClarify = null;
        return patch;
      });
      break;
    }

    // --- Existing message handlers (now session-aware) ---

    case 'message': {
      // Use the shared resolver so trim / empty-string normalization stays
      // consistent with sharedMessageHandler and the rest of store-core.
      const targetId = resolveSessionId(msg, get().activeSessionId);
      // Resolve the cache used for replay-dedup (target session if known,
      // else the global message log).
      const targetState = targetId ? get().sessionStates[targetId] : null;
      const cached = targetState ? targetState.messages : get().messages;
      // #4493 — dedup against history only when THIS message's session is
      // currently replaying. A module-wide boolean would suppress live
      // messages for session B while A replays.
      const messageIsReplay = targetId ? _replayingSessions.has(targetId) : false;
      const result = sharedMessageHandler(msg, get().activeSessionId, messageIsReplay, cached);
      if (!result.shouldDispatch) break;
      const newMsg = result.chatMessage;
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, (ss) => ({
          messages: [
            ...ss.messages.filter((m) => m.id !== 'thinking' || newMsg.id === 'thinking'),
            newMsg,
          ],
        }));
      } else {
        get().addMessage(newMsg);
      }
      // Surface rate limit / usage limit errors prominently (#616)
      if (result.isRateLimitError && result.errorContent) {
        _adapters.alert.alert('Usage Limit', result.errorContent);
      }
      break;
    }

    case 'result': {
      // Flush any buffered deltas before clearing streaming state
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer);
      }
      flushPendingDeltas();
      // Clean up permission boundary split tracking
      _postPermissionSplits.clear();
      _deltaIdRemaps.clear();
      const normalized = sharedResultUsage(msg, get().activeSessionId);
      const targetId = normalized.sessionId;
      // Resolve cost: server provides it for Claude; compute client-side for
      // sessions whose provider really cannot return a cost number (Codex,
      // Gemini). The provider gate is intentionally narrow — see
      // CLIENT_ESTIMATED_COST_PROVIDERS — so a new server-side priced
      // provider that just happens to emit `cost: null` momentarily (race,
      // edge case) doesn't get a wrong client-side estimate written into
      // its session state. The shared helper returns null when msg.cost
      // is missing/non-numeric; we fall back to client-side pricing only
      // when we have a usage payload AND the provider is on the list.
      // #4206: this list is also imported by status-tooltips.ts so the
      // "estimated client-side" tooltip wording can only diverge with an
      // explicit double edit.
      let resolvedCost: number | null = normalized.lastResultCost;
      if (resolvedCost === null && normalized.contextUsage) {
        const session = get().sessions.find(
          (s: SessionInfo) => s.sessionId === targetId,
        );
        const sessionModel = session?.model ?? null;
        const sessionProvider = session?.provider ?? null;
        if (sessionModel && sessionProvider && CLIENT_ESTIMATED_COST_PROVIDERS.has(sessionProvider)) {
          resolvedCost = calculateCost(
            sessionModel,
            normalized.contextUsage.inputTokens,
            normalized.contextUsage.outputTokens,
          );
        }
      }
      const resultPatch = {
        streamingMessageId: null as string | null,
        contextUsage: normalized.contextUsage,
        lastResultCost: resolvedCost,
        lastResultDuration: normalized.lastResultDuration,
      };
      // Notify if a background session just finished (was streaming)
      if (targetId && get().sessionStates[targetId]?.streamingMessageId) {
        pushSessionNotification(targetId, 'completed', 'Task completed');
      }
      if (targetId && get().sessionStates[targetId]) {
        // Force a new messages array reference so selectors detect the change,
        // even when flushPendingDeltas() was a no-op (timer already flushed).
        updateSession(targetId, (ss) => {
          // #4308 — `result` is a guaranteed turn boundary; any still-tracked
          // activeTools are a missed tool_result (server crash, dropped
          // broadcast) and must be dropped so the activity indicator can't
          // get stuck on a phantom "Running X". Mirror in agent_idle.
          //
          // #4466 — but ONLY for live result events. `result` events are
          // recorded in the server's per-session history ring buffer
          // (session-message-history.js) and replayed on switch_session via
          // PROXIED_EVENTS (session-manager.js). Without this gate, every
          // tab switch on a session that's completed at least one prior
          // turn fires a replayed `result` that wipes the activeTools the
          // history_replay_start guard is trying to preserve — the
          // replayed in-flight tool_start then re-adds the entry with a
          // fresh Date.now() startedAt, restoring the exact "Running X · 1s"
          // clock-reset symptom #4466 set out to fix.
          const patch: Partial<SessionState> = {
            ...resultPatch,
            messages: [...ss.messages],
          };
          // #4493 — gate per target session id. A live `result` for
          // session B during A's replay must still sweep B's activeTools.
          if (ss.activeTools.length > 0 && !_replayingSessions.has(targetId)) patch.activeTools = [];
          return patch;
        });
      } else {
        set((s) => ({ ...resultPatch, messages: [...s.messages] }));
      }
      break;
    }

    case 'available_models': {
      if (Array.isArray(msg.models)) {
        const { models, defaultModelId } = sharedAvailableModels(msg);
        const availableModelsProvider = typeof msg.provider === 'string' ? msg.provider : null;
        set({ availableModels: models, availableModelsProvider, defaultModelId });
      }
      break;
    }

    case 'confirm_permission_mode': {
      const pending = sharedConfirmPermissionMode(msg);
      if (pending) {
        set({ pendingPermissionConfirm: pending });
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
      // #5016 — Task subagent intermediate progress. Builder appends one
      // entry to the parent Task tool_use bubble's `childAgentEvents[]`.
      // Same-reference no-op when the parent bubble isn't found (event
      // arrived before tool_start, which should not happen given the
      // server's ordering guarantee but is defended).
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
      // session. Full-snapshot protocol, so the builder replaces the
      // slot wholesale; the shared handler returns the same reference
      // when next == current to suppress no-op renders.
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
      break;
    }

    case 'inactivity_warning': {
      // #3899 — server fired the soft check-in prompt. Store on the
      // targeted session so the CheckInChip can render the prefab
      // button. Activity event handler above clears this on the next
      // stream_*/tool_*/result/message; sendInput clears it locally
      // when the user actually sends a follow-up.
      const warning = sharedInactivityWarning(msg, get().activeSessionId);
      if (warning && warning.sessionId && get().sessionStates[warning.sessionId]) {
        updateSession(warning.sessionId, () => warning.patch);
      }
      break;
    }

    case 'multi_question_intervention': {
      // #4653 — chroxy's permission-hook (#4648) just denied a multi-question
      // AskUserQuestion. Append a SessionIntervention entry so the
      // FooterBar counter ticks, and on the FIRST such intervention per
      // session push a one-time system ChatMessage explaining what
      // happened (without it the deny is invisible — see v0.9.24
      // dogfood feedback on #4653).
      //
      // applyInterventionBuilder dedups by toolUseId (a stuck model
      // re-emitting the same payload won't double-count) and tells us
      // whether this was the session's first intervention so the inline
      // notice only fires once.
      const builder = sharedMultiQuestionIntervention(msg, get().activeSessionId);
      if (!builder) break;
      const targetId = builder.sessionId;
      if (!targetId) break;
      const targetState = get().sessionStates[targetId];
      if (!targetState) break;
      const { interventions: nextInterventions, isFirst } = applyInterventionBuilder(
        builder,
        targetState.interventions,
      );
      // Skip the state mutation if nothing changed (dedup'd repeat) so React
      // doesn't re-render the footer counter on every stuck-model re-emit.
      if (nextInterventions === targetState.interventions) break;
      updateSession(targetId, (ss) => {
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

    case 'permission_expired': {
      const { requestId: expiredRequestId, systemMessage: expiredSystemMsg } =
        sharedPermissionExpired(msg);
      if (expiredRequestId) {
        // If the user already resolved this request (via Allow/Deny/AllowSession),
        // this is the race condition from #2833 — the server expired the prompt
        // after we answered. Suppress the "Expired — already handled" message
        // append so the UI does not surface this as an error to the user.
        const alreadyResolved = Boolean(get().resolvedPermissions?.[expiredRequestId]);
        if (alreadyResolved) {
          // #5008 — drain the banner stack without dropping the row from the
          // widget's durable history. See handlePermissionResolved for the
          // full rationale; this branch handles the #2833 race where expiry
          // arrives after we already resolved locally. Single timestamp per
          // mutation — see handlePermissionResolved for the pattern source.
          const readStamp = Date.now();
          set((s) => ({
            sessionNotifications: s.sessionNotifications.map((n) =>
              n.requestId === expiredRequestId && n.readAt === undefined
                ? { ...n, readAt: readStamp }
                : n
            ),
          }));
          // #2839: surface a user-centric info toast confirming the
          // response was already recorded, without exposing the underlying
          // server-side expiration race as an error-like message.
          get().addInfoNotification('Already answered — your response was already recorded');
          break;
        }
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
        // #5008 — drain banner without dropping widget history. Mark the
        // matching row read; the banner filter (`readAt === undefined`)
        // drops it and the widget keeps the entry as part of its durable
        // intervention history. Updates the original #1580 auto-dismiss
        // contract from "remove" to "mark-read-and-keep". Single timestamp
        // per mutation — see handlePermissionResolved for the pattern source.
        const readStamp = Date.now();
        set((s) => ({
          sessionNotifications: s.sessionNotifications.map((n) =>
            n.requestId === expiredRequestId && n.readAt === undefined
              ? { ...n, readAt: readStamp }
              : n
          ),
        }));
      }
      break;
    }

    case 'permission_rules_updated': {
      // Server broadcasts the full rule set for a session after a successful
      // set_permission_rules call. Store it on the session so "Allow for
      // Session" (#2834) can append new rules without clobbering existing ones.
      const { sessionId: rulesExplicitSessionId, rules } = sharedPermissionRulesUpdated(msg);
      const rulesSessionId = rulesExplicitSessionId || get().activeSessionId;
      if (rulesSessionId && get().sessionStates[rulesSessionId]) {
        updateSession(rulesSessionId, () => ({ sessionRules: rules }));
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
      // Handle structured startup phase events (phase field present)
      const phase = msg.phase as string | undefined;
      // #2836: 'tunnel_warming' is the current phase name. 'tunnel_verifying'
      // is accepted as a legacy alias — older servers may still emit it.
      if (phase === 'tunnel_warming' || phase === 'tunnel_verifying') {
        const attempt = typeof msg.attempt === 'number' ? msg.attempt : null;
        const maxAttempts = typeof msg.maxAttempts === 'number' ? msg.maxAttempts : null;
        set({
          serverPhase: 'tunnel_warming',
          tunnelProgress: attempt != null && maxAttempts != null ? { attempt, maxAttempts } : null,
        } as Partial<ConnectionState>);
        break;
      }
      if (phase === 'ready') {
        set({
          serverPhase: 'ready',
          tunnelProgress: null,
        } as Partial<ConnectionState>);
        break;
      }

      // Legacy plain-message server_status (no phase field, or unknown phase)
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

    // --- Multi-client awareness ---

    case 'client_joined': {
      const joined = sharedClientJoined(msg, get().connectedClients);
      if (!joined) break;
      set({ connectedClients: joined.roster });
      const deviceLabel = joined.client.deviceName || 'A device';
      const joinMsg: ChatMessage = {
        id: nextMessageId('client'),
        type: 'system',
        content: `${deviceLabel} connected`,
        timestamp: Date.now(),
      };
      // Global event — broadcast to all sessions so any tab shows it (single setState)
      const joinSessionIds = Object.keys(get().sessionStates);
      if (joinSessionIds.length > 0) {
        set((state: ConnectionState) => {
          const newSessionStates: typeof state.sessionStates = {};
          for (const sid in state.sessionStates) {
            const ss = state.sessionStates[sid]!;
            newSessionStates[sid] = { ...ss, messages: [...ss.messages, joinMsg] };
          }
          const activeId = state.activeSessionId;
          const patch: Partial<ConnectionState> = { sessionStates: newSessionStates };
          if (activeId && newSessionStates[activeId]) {
            patch.messages = newSessionStates[activeId].messages;
          }
          return patch;
        });
      } else {
        get().addMessage(joinMsg);
      }
      break;
    }

    case 'client_left': {
      const left = sharedClientLeft(msg, get().connectedClients);
      if (!left) break;
      set({ connectedClients: left.roster });
      const leftLabel = left.departingClient?.deviceName || 'A device';
      const leftMsg: ChatMessage = {
        id: nextMessageId('client'),
        type: 'system',
        content: `${leftLabel} disconnected`,
        timestamp: Date.now(),
      };
      // Global event — broadcast to all sessions so any tab shows it (single setState)
      const leftSessionIds = Object.keys(get().sessionStates);
      if (leftSessionIds.length > 0) {
        set((state: ConnectionState) => {
          const newSessionStates: typeof state.sessionStates = {};
          for (const sid in state.sessionStates) {
            const ss = state.sessionStates[sid]!;
            newSessionStates[sid] = { ...ss, messages: [...ss.messages, leftMsg] };
          }
          const activeId = state.activeSessionId;
          const patch: Partial<ConnectionState> = { sessionStates: newSessionStates };
          if (activeId && newSessionStates[activeId]) {
            patch.messages = newSessionStates[activeId].messages;
          }
          return patch;
        });
      } else {
        get().addMessage(leftMsg);
      }
      break;
    }

    case 'primary_changed': {
      const { sessionId: primarySessionId, primaryClientId } = sharedPrimaryChanged(msg);
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
      const { followMode, myClientId, activeSessionId, sessionStates } = get();
      if (followMode && focus.clientId !== myClientId && focus.sessionId !== activeSessionId && sessionStates[focus.sessionId]) {
        get().switchSession(focus.sessionId);
      }
      break;
    }

    case 'directory_listing': {
      const cb = get()._directoryListingCallback;
      if (cb) {
        const payload = sharedDirectoryListing(msg);
        cb({ ...payload, entries: payload.entries as DirectoryEntry[] });
      }
      break;
    }

    case 'file_listing': {
      const fileBrowserCb = get()._fileBrowserCallback;
      if (fileBrowserCb) {
        const payload = sharedFileListing(msg);
        fileBrowserCb({ ...payload, entries: payload.entries as FileEntry[] });
      }
      break;
    }

    case 'file_content': {
      const fileContentCb = get()._fileContentCallback;
      if (fileContentCb) {
        fileContentCb(sharedFileContent(msg));
      }
      break;
    }

    case 'diff_result': {
      const diffCb = get()._diffCallback;
      if (diffCb) {
        const payload = sharedDiffResult(msg);
        // payload.files is now typed as DiffFile[] from store-core (#3132).
        diffCb({
          files: payload.files,
          error: payload.error,
        });
      }
      break;
    }

    case 'git_status_result': {
      const gitStatusCb = get()._gitStatusCallback;
      if (gitStatusCb) {
        const payload = sharedGitStatusResult(msg);
        // payload arrays are now strongly typed from store-core (#3132).
        gitStatusCb({
          branch: payload.branch,
          staged: payload.staged,
          unstaged: payload.unstaged,
          untracked: payload.untracked,
          error: payload.error,
        });
      }
      break;
    }

    case 'slash_commands': {
      const slashResult = sharedSlashCommands(msg, get().activeSessionId);
      if (!slashResult) break;
      set({ slashCommands: slashResult.commands as SlashCommand[] });
      break;
    }

    case 'file_list': {
      const fileResult = sharedFileList(msg);
      set({ filePickerFiles: fileResult.files as FilePickerItem[] });
      break;
    }

    case 'agent_list': {
      const agentResult = sharedAgentList(msg, get().activeSessionId);
      if (!agentResult) break;
      set({ customAgents: agentResult.agents as CustomAgent[] });
      break;
    }

    case 'provider_list': {
      const providerResult = sharedProviderList(msg);
      if (!providerResult) break;
      set({ availableProviders: providerResult.providers as ProviderInfo[] });
      break;
    }

    case 'byok_credentials_status': {
      // #4052: server replies after refresh / set / clear. The masked
      // form is intentionally the only key-shaped string we ever store —
      // never the raw value, even transiently.
      // #4144: fileExists must flow through too — the stale-file notice
      // and the Remove button are both gated on it. Hand-picking fields
      // here silently dropped it before (caught by agent-review on
      // PR #4174).
      // #4141: validate the wire payload via the protocol Zod schema
      // instead of raw `as` casts. A malformed server can no longer
      // store `status: 'unknown'` into the store; safeParse failure
      // logs a warn and leaves the store unchanged.
      const parsed = ServerByokCredentialsStatusSchema.safeParse(msg);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.warn('byok_credentials_status: invalid payload from server', parsed.error.issues);
        break;
      }
      const payload = parsed.data;
      set({
        byokCredentialsStatus: {
          status: payload.status,
          source: payload.source,
          masked: payload.masked,
          reason: payload.reason,
          fileExists: payload.fileExists,
        },
      });
      break;
    }

    case 'credentials_status': {
      // #3855: generalized provider-credential snapshot. Emitted in reply to
      // get_credentials_status and broadcast after every set/delete. The
      // masked previews are the only key-shaped strings we ever store — never
      // a raw value. Validate the wire payload via the protocol Zod schema so
      // a malformed server can't poison the store.
      const parsed = ServerCredentialsStatusSchema.safeParse(msg);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.warn('credentials_status: invalid payload from server', parsed.error.issues);
        break;
      }
      const payload = parsed.data;
      set({
        credentialsStatus: {
          credentials: payload.credentials.map((c) => ({
            key: c.key,
            provider: c.provider,
            label: c.label,
            kind: c.kind,
            status: c.status,
            source: c.source,
            masked: c.masked,
            oauth: c.oauth,
          })),
          fileExists: payload.fileExists,
          fileError: payload.fileError ?? null,
        },
      });
      break;
    }

    case 'credential_test_result': {
      // #3855: per-key test outcome. Store keyed by credential key so each row
      // renders its own inline result.
      const parsed = ServerCredentialTestResultSchema.safeParse(msg);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.warn('credential_test_result: invalid payload from server', parsed.error.issues);
        break;
      }
      const payload = parsed.data;
      set((state) => ({
        credentialTestResults: {
          ...state.credentialTestResults,
          [payload.key]: {
            ok: payload.ok,
            error: payload.error,
            model: payload.model,
            latencyMs: payload.latencyMs,
          },
        },
      }));
      break;
    }

    case 'notification_prefs': {
      // #4542: notification-prefs snapshot. Emitted in response to
      // `notification_prefs_get` and broadcast after every
      // `notification_prefs_set`. The wire schema is permissive
      // (z.record(string, boolean) for categories) — adding a category
      // server-side does not require a client rebuild.
      const parsed = ServerNotificationPrefsSchema.safeParse(msg);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.warn('notification_prefs: invalid payload from server', parsed.error.issues);
        break;
      }
      const prefs = parsed.data.prefs;
      // #4544: the wire snapshot now carries an optional `bypassCategories`
      // array (categories that fire even during quiet hours). Older servers
      // omit it — clients fall back to the documented defaults
      // (permission + activity_error). The quiet-hours window's
      // `timezone` field is also new in #4544; the schema requires it
      // when present, so per-device timezone-less windows from an
      // intermediate state simply won't validate.
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

    case 'checkpoint_created': {
      const next = sharedCheckpointCreated(msg, get().checkpoints, get().activeSessionId);
      if (next) set({ checkpoints: next });
      break;
    }

    case 'checkpoint_list': {
      const next = sharedCheckpointList(msg, get().activeSessionId);
      if (next) set({ checkpoints: next });
      break;
    }

    case 'session_restore_failed': {
      // Server couldn't restart a persisted session (e.g. missing API key).
      // History is preserved on disk; surface this visibly instead of making
      // the saved session look like it silently disappeared after restart.
      const restoreFailed = sharedSessionRestoreFailed(msg);
      get().addServerError(restoreFailed.systemMessage.content);
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
      if (result.sessionId && get().sessionStates[result.sessionId]) {
        updateSession(result.sessionId, () => result.patch);
      }
      break;
    }

    case 'session_usage': {
      // #4073: per-session cumulative tokens + cost. Drives the sidebar
      // badge + hover breakdown. Emitted after every result event.
      const result = sharedSessionUsage(msg, get().activeSessionId);
      if (result.sessionId && get().sessionStates[result.sessionId]) {
        updateSession(result.sessionId, () => result.patch);
      }
      break;
    }

    case 'session_cost_threshold_crossed': {
      // #4075: soft "you've spent $X" warning. Fires ONCE per session.
      // The dashboard owns the dismissible banner state per-session; the
      // server doesn't re-fire even if costs continue rising, so a
      // missed banner stays missed (don't store-and-replay).
      const sid = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      const costUsd = typeof msg.costUsd === 'number' && Number.isFinite(msg.costUsd) ? msg.costUsd : 0;
      const thresholdUsd = typeof msg.thresholdUsd === 'number' && Number.isFinite(msg.thresholdUsd) ? msg.thresholdUsd : 0;
      if (sid && get().sessionStates[sid]) {
        updateSession(sid, () => ({
          costThresholdWarning: { costUsd, thresholdUsd, dismissedAt: null },
        }));
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
      const { taskId: errTaskId, errorMessage, chatMessageContent } = sharedWebTaskError(msg);
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
      // Show error as system message in chat. Build the ChatMessage here so
      // its id + timestamp are allocated after the task state update above.
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

    case 'search_results': {
      const currentQuery = (get() as ConnectionState).searchQuery;
      const { results, shouldApply } = sharedSearchResults(msg, currentQuery);
      if (!shouldApply) break; // Stale response for an older query — ignore
      set({ searchResults: results, searchLoading: false });
      break;
    }

    case 'log_entry': {
      const { entry } = sharedLogEntry(msg);
      set((state: ConnectionState) => ({
        logEntries: [...state.logEntries, entry].slice(-500),
      }));
      break;
    }

    case 'session_warning': {
      const { sessionId: warnSessionId, message, systemMessage: warningMsg } =
        sharedSessionWarning(msg);
      if (warnSessionId && get().sessionStates[warnSessionId]) {
        const prevActiveId = get().activeSessionId;
        // Add warning to the target session's messages
        set((state: ConnectionState) => {
          const sess = state.sessionStates[warnSessionId]!;
          return {
            sessionStates: {
              ...state.sessionStates,
              [warnSessionId]: {
                ...sess,
                messages: [...sess.messages, warningMsg],
              },
            },
          };
        });
        // Also show console warning if the session isn't currently active
        if (prevActiveId !== warnSessionId) {
          _adapters.alert.alert('Session Warning', message);
        }
      } else {
        get().addMessage(warningMsg);
      }
      break;
    }

    case 'session_timeout': {
      const { sessionId: timeoutSessionId, name } = sharedSessionTimeout(msg);
      _adapters.alert.alert('Session Closed', `Session "${name}" was closed due to inactivity.`);
      if (timeoutSessionId) {
        // Clean up sessionStates entry for the destroyed session (#816)
        const { sessionStates, sessions } = get();
        const newStates = { ...sessionStates };
        delete newStates[timeoutSessionId];
        const newSessions = sessions.filter((s) => s.sessionId !== timeoutSessionId);
        const patch: Partial<ConnectionState> = { sessionStates: newStates, sessions: newSessions };
        // If the timed-out session was active, switch to next and sync flat fields (#816)
        if (get().activeSessionId === timeoutSessionId) {
          const remaining = Object.keys(newStates);
          const nextId = remaining.length > 0 ? remaining[0] : null;
          patch.activeSessionId = nextId;
          if (nextId && newStates[nextId]) {
            const ss = newStates[nextId];
            patch.messages = ss.messages;
            patch.streamingMessageId = ss.streamingMessageId;
            patch.claudeReady = ss.claudeReady;
            patch.activeModel = ss.activeModel;
            patch.permissionMode = ss.permissionMode;
            patch.contextUsage = ss.contextUsage;
            patch.lastResultCost = ss.lastResultCost;
            patch.lastResultDuration = ss.lastResultDuration;
            patch.isIdle = ss.isIdle;
          } else {
            // No sessions remain — clear flat fields
            patch.messages = [];
            patch.streamingMessageId = null;
            patch.claudeReady = false;
            patch.activeModel = null;
            patch.permissionMode = null;
            patch.contextUsage = null;
            patch.lastResultCost = null;
            patch.lastResultDuration = null;
            patch.isIdle = true;
          }
        }
        set(patch);
        // Garbage-collect persisted messages for the deleted session (#797)
        void clearPersistedSession(timeoutSessionId);
      }
      break;
    }

    // -- Environment messages --
    case 'environment_list': {
      const { environments } = sharedEnvironmentList(msg);
      set({ environments: environments as EnvironmentInfo[] });
      break;
    }
    case 'environment_created':
    case 'environment_destroyed':
    case 'environment_info':
      // Handled implicitly via the environment_list broadcast that follows
      break;
    case 'environment_error': {
      const { error } = sharedEnvironmentError(msg);
      console.error('[ws] Environment error:', error);
      break;
    }

    case 'error': {
      // Structured error response from a handler catch block.
      // Log it and surface it as a server error notification.
      // #4178: `fatal` is read off the typed parser return so dashboard
      // + app share a single normalised shape (no `msg.fatal` reach-in,
      // no per-client type guard, and a typo'd value can't silently
      // degrade severity).
      // #5039: `partialCost` carries the optional PR #5037 fold of
      // parent + Task subagent rounds completed before the error fired.
      // Pre-formatted with the shared helper so the dashboard toast and
      // mobile alert show identical wording.
      const { code: errCode, message: errMsg, fatal: errFatal, partialCost } = sharedError(msg);
      const partialCostLine = partialCost ? formatPartialCostLine(partialCost) : undefined;
      console.error(`[ws] Server handler error [${errCode}]: ${errMsg}`);
      // #3588: clear any in-flight skill_trust_grant whose requestId
      // matches this error envelope so the SkillsPanel "Pending review"
      // row's disabled state lifts. Without this, an INVALID_AUTHOR /
      // TRUST_NOT_ENABLED / TRUST_FLUSH_FAILED response would leave the
      // Trust button stuck "approving" forever and the operator would
      // have no way to retry. The helper is a no-op when the requestId
      // belongs to some other handler's request.
      const errReqId = typeof msg.requestId === 'string' ? msg.requestId : null;
      if (errReqId) {
        clearPendingTrustGrantByRequestId(errReqId, get);
      }
      // #3570: skill_trust_grant INVALID_AUTHOR carries a structured
      // `actualAuthor` field (#3568, locked by
      // ServerSkillTrustGrantInvalidAuthorSchema) when the per-author
      // resolve landed on a different community author than the caller
      // claimed. Branch on the structured field instead of regex-parsing
      // the (intentionally unstable) human-readable `message`, so the
      // user sees a concrete "owned by alice" hint rather than the bare
      // server text. Other INVALID_AUTHOR variants (empty `author`
      // validation) do not include `actualAuthor` and fall through to
      // the plain message — see schema comment.
      const actualAuthor = typeof msg.actualAuthor === 'string' && msg.actualAuthor.length > 0
        ? msg.actualAuthor
        : null;
      // #3587: when the original `skill_trust_grant` request is still
      // tracked client-side (#3587 registerTrustGrantRequest), pair the
      // `requestId` with its remembered `skillName` so we can offer a
      // one-click recovery. The error wire shape carries `requestId` but
      // NOT `skillName` (per ServerSkillTrustGrantInvalidAuthorSchema),
      // so this is the only correlation path. Always consume the entry
      // even if we don't end up rendering an action — the request is
      // resolved either way and we don't want stale entries piling up.
      // `requestId` may be null on the wire (per protocol nullable), so
      // be defensive about the type.
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const pending = requestId !== null ? consumePendingTrustGrant(requestId) : null;
      let surfaced: string;
      let action: { label: string; onClick: () => void } | undefined;
      if (errCode === 'INVALID_AUTHOR' && actualAuthor !== null) {
        if (pending) {
          // We know the skillName and the corrected author — render an
          // actionable toast that re-issues skill_trust_grant on click.
          // The pending row for the real owner is still on the panel,
          // but a one-click retry is faster than scanning the list.
          const skillName = pending.skillName;
          surfaced = `Skill is owned by '${actualAuthor}', not '${pending.author}'. Try as ${actualAuthor}?`;
          action = {
            label: `Try as ${actualAuthor}`,
            onClick: () => {
              get().grantCommunitySkillTrust(skillName, actualAuthor);
            },
          };
        } else {
          // No tracked request (e.g. disconnect+reconnect dropped the
          // map, or a duplicate error fires after first consume). Fall
          // back to the #3570 text-only hint.
          surfaced = `Skill is owned by '${actualAuthor}'. Use the 'Trust ${actualAuthor}' button on the pending entry instead.`;
        }
      } else {
        surfaced = errMsg;
      }
      // #4148: non-fatal server signals (MAX_TOOL_ROUNDS_REACHED and any
      // future error envelope that sets fatal: false) render as warnings
      // — yellow toast, role=status, less alarming — instead of the
      // destructive red toast used for STREAM_ERROR / ABORT. The session
      // remains usable; the toast is informational. errCode-list lets us
      // keep the fatal: false check for future-proofing while still
      // catching codes that don't carry the flag.
      // #4178: `errFatal` is the typed (boolean | undefined) value from
      // sharedError. A typo on the wire ('fatal': 'false') resolves to
      // undefined, which falls back to the errCode-list — preserving
      // the loud red toast instead of silently degrading.
      const isNonFatal = errFatal === false || NON_FATAL_ERROR_CODES.has(errCode);
      const severity: 'error' | 'warning' = isNonFatal ? 'warning' : 'error';
      // #5039: thread the optional partial-cost sub-line through to the
      // store. addServerError keeps it undefined for every pre-#5037
      // error path so the existing toast layout is unchanged.
      get().addServerError(surfaced, action, severity, partialCostLine);
      break;
    }

    default: {
      // Log unknown message types when server protocol is newer (likely new features)
      const serverPV = getStore().getState().serverProtocolVersion;
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
