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
  resolveStreamId,
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
  handleDevPreview as sharedDevPreview,
  handleDevPreviewStopped as sharedDevPreviewStopped,
  handleAuthOk as sharedAuthOk,
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
  handleSessionList as sharedSessionList,
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
  handleEnvironmentList as sharedEnvironmentList,
  handleEnvironmentError as sharedEnvironmentError,
  handleAvailableModels as sharedAvailableModels,
  handleMcpServers as sharedMcpServers,
  handleCostUpdate as sharedCostUpdate,
  handleServerError as sharedServerError,
  handleServerShutdown as sharedServerShutdown,
  handleServerStatusLegacy as sharedServerStatusLegacy,
  handleWebTaskUpsert as sharedWebTaskUpsert,
  handleWebTaskError as sharedWebTaskError,
  handleWebTaskList as sharedWebTaskList,
  handleWebFeatureStatus as sharedWebFeatureStatus,
  handleSearchResults as sharedSearchResults,
  handleUserQuestion as sharedUserQuestion,
  type PlatformAdapters, type StorageAdapter,
} from '@chroxy/store-core'
import { PROTOCOL_VERSION } from '@chroxy/protocol'
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
import type {
  ChatMessage,
  ConnectedClient,
  ConnectionContext,
  ConnectionState,
  CustomAgent,
  DiffFile,
  DirectoryEntry,
  EnvironmentInfo,
  FileEntry,
  GitStatusEntry,
  McpServer,
  QueuedMessage,
  SessionInfo,
  SessionNotification,
  SessionState,
  SlashCommand,
  FilePickerItem,
  ConversationSummary,
  ProviderInfo,
  SearchResult,
  ToolResultImage,
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
let _receivingHistoryReplay = false;

export function resetReplayFlags(): void {
  _receivingHistoryReplay = false;
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
      const updatedMessages = sessionState.messages.map((m) => {
        const d = deltas.get(m.id);
        if (d) matched.add(m.id);
        return d ? { ...m, content: m.content + d } : m;
      });
      // Safety net: create response messages for orphaned deltas (#2611)
      const finalMessages = updatedMessages;
      for (const [msgId, delta] of deltas) {
        if (!matched.has(msgId)) {
          finalMessages.push({ id: msgId, type: 'response' as const, content: delta, timestamp: Date.now() } as ChatMessage);
        }
      }
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
          if (d) matched2.add(m.id);
          return d ? { ...m, content: m.content + d } : m;
        });
        // Safety net: create response messages for orphaned deltas (#2611)
        for (const [msgId, delta] of deltas) {
          if (!matched2.has(msgId)) {
            updated.push({ id: msgId, type: 'response' as const, content: delta, timestamp: Date.now() } as ChatMessage);
          }
        }
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

function handleAgentIdle(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => sharedAgentIdle());
  }
}

function handleAgentBusy(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => sharedAgentBusy());
  }
}

function handleStreamStart(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const streamId = msg.messageId as string;
  const targetId = (msg.sessionId as string) || get().activeSessionId;
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => {
      const existing = ss.messages.find((m) => m.id === streamId);
      const { resolvedId, remap } = resolveStreamId(existing, streamId);
      if (existing && existing.type === 'response') {
        // Reuse existing response message (reconnect replay dedup)
        return { streamingMessageId: resolvedId };
      }
      if (remap) {
        _deltaIdRemaps.set(remap.from, remap.to);
      }
      return {
        streamingMessageId: resolvedId,
        messages: [
          ...filterThinking(ss.messages),
          { id: resolvedId, type: 'response' as const, content: '', timestamp: Date.now() },
        ],
      };
    });
  } else {
    set((state: ConnectionState) => {
      const existing = state.messages.find((m) => m.id === streamId);
      const { resolvedId, remap } = resolveStreamId(existing, streamId);
      if (existing && existing.type === 'response') {
        return { streamingMessageId: resolvedId };
      }
      if (remap) {
        _deltaIdRemaps.set(remap.from, remap.to);
      }
      return {
        streamingMessageId: resolvedId,
        messages: [
          ...filterThinking(state.messages),
          { id: resolvedId, type: 'response' as const, content: '', timestamp: Date.now() },
        ],
      };
    });
  }
}

function handleStreamDelta(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  let deltaId = msg.messageId as string;
  const capturedSessionId = (msg.sessionId as string) || get().activeSessionId;

  // Forward delta text to terminal view (synthesize raw output in CLI mode)
  if (typeof msg.delta === 'string' && msg.delta.length > 0) {
    get().appendTerminalData(msg.delta);
  }

  // Permission boundary split: first delta after a split creates a new message
  if (_postPermissionSplits.has(deltaId)) {
    _postPermissionSplits.delete(deltaId);
    const newId = `${deltaId}-post-${Date.now()}`;
    _deltaIdRemaps.set(deltaId, newId);
    const newMsg: ChatMessage = {
      id: newId,
      type: 'response',
      content: '',
      timestamp: Date.now(),
    };
    const targetId = capturedSessionId;
    if (targetId && get().sessionStates[targetId]) {
      updateSession(targetId, (ss) => ({
        streamingMessageId: newId,
        messages: [...ss.messages, newMsg],
      }));
    } else {
      set((state: ConnectionState) => ({
        streamingMessageId: newId,
        messages: [...state.messages, newMsg],
      }));
    }
    deltaId = newId;
  } else if (_deltaIdRemaps.has(deltaId)) {
    deltaId = _deltaIdRemaps.get(deltaId)!;
  }

  const existingDelta = pendingDeltas.get(deltaId);
  pendingDeltas.set(deltaId, {
    sessionId: capturedSessionId,
    delta: (existingDelta?.delta || '') + (msg.delta as string),
  });
  if (!deltaFlushTimer) {
    deltaFlushTimer = setTimeout(flushPendingDeltas, 100);
  }
}

function handleStreamEnd(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // Flush any buffered deltas immediately before clearing streaming state
  if (deltaFlushTimer) {
    clearTimeout(deltaFlushTimer);
  }
  flushPendingDeltas();
  // Add newline separator after response ends for Output view readability
  get().appendTerminalData('\r\n');
  // Clean up permission boundary split tracking
  _postPermissionSplits.delete(msg.messageId as string);
  _deltaIdRemaps.delete(msg.messageId as string);
  const targetId = (msg.sessionId as string) || get().activeSessionId;
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
  const targetId = (msg.sessionId as string) || get().activeSessionId;
  // Forward tool invocation to terminal view
  {
    const toolName = (msg.tool as string) || 'tool';
    get().appendTerminalData(`\r\n\x1b[36m⏺ ${toolName}\x1b[0m\r\n`);
  }
  // Use server messageId as stable identifier for dedup (same ID on live + replay)
  const toolId = (msg.messageId as string) || nextMessageId('tool');
  // During ANY history replay (plain reconnect or session-switch), skip if a
  // tool_use with the same stable id is already in the per-session cache.
  // The legacy blanket `messages.length > 0` guard was removed (#2901): with
  // multi-session state the legacy flat array is empty, so the guard never
  // fired and reconnect replay duplicated tool_use entries that the client
  // already had. Per-id dedup is the correct check on both replay paths.
  if (_receivingHistoryReplay) {
    const targetState = targetId ? get().sessionStates[targetId] : null;
    const cached = targetState ? targetState.messages : get().messages;
    if (cached.some((m) => m.id === toolId)) return;
  }
  const toolMsg: ChatMessage = {
    id: toolId,
    type: 'tool_use',
    content: msg.input ? JSON.stringify(msg.input) : (msg.tool as string) || '',
    tool: msg.tool as string | undefined,
    toolUseId: msg.toolUseId as string | undefined,
    serverName: msg.serverName as string | undefined,
    timestamp: Date.now(),
  };
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => ({
      messages: [...ss.messages, toolMsg],
    }));
  } else {
    get().addMessage(toolMsg);
  }
}

function handleToolResult(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const toolUseId = msg.toolUseId as string;
  if (!toolUseId) return;
  const resultText = (msg.result as string) || '';
  const truncated = !!(msg.truncated as boolean);
  // Forward tool result to terminal view
  if (resultText) {
    const preview = resultText.length > 500 ? resultText.slice(0, 500) + '...' : resultText;
    get().appendTerminalData(`\x1b[2m${preview}\x1b[0m\r\n`);
  }
  const images = Array.isArray(msg.images) ? msg.images as ToolResultImage[] : undefined;
  const targetId = (msg.sessionId as string) || get().activeSessionId;
  // Find the matching tool_use message and attach the result
  const patch: Partial<ChatMessage> = { toolResult: resultText, toolResultTruncated: truncated };
  if (images?.length) patch.toolResultImages = images;
  const patchResult = (ss: SessionState) => {
    const idx = ss.messages.findIndex(
      (m) => m.type === 'tool_use' && m.toolUseId === toolUseId,
    );
    if (idx === -1) return {};
    const updated = [...ss.messages];
    updated[idx] = { ...updated[idx]!, ...patch };
    return { messages: updated };
  };
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, patchResult);
  } else {
    const idx = get().messages.findIndex(
      (m) => m.type === 'tool_use' && m.toolUseId === toolUseId,
    );
    if (idx !== -1) {
      const updated = [...get().messages];
      updated[idx] = { ...updated[idx]!, ...patch };
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
    const permMsg: ChatMessage = {
      id: nextMessageId('perm'),
      type: 'prompt',
      content: msg.tool ? `${msg.tool}: ${msg.description}` : ((msg.description as string) || 'Permission required'),
      tool: msg.tool as string | undefined,
      requestId: permRequestId,
      toolInput: msg.input && typeof msg.input === 'object' ? msg.input as Record<string, unknown> : undefined,
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
    // Auto-dismiss matching notification banner
    set((s) => ({
      sessionNotifications: s.sessionNotifications.filter(
        (n) => n.requestId !== resolvedRequestId
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
  tool_result: handleToolResult,
  permission_request: handlePermissionRequest,
  permission_resolved: handlePermissionResolved,
  budget_warning: handleBudgetWarning,
  budget_exceeded: handleBudgetExceeded,
  budget_resumed: handleBudgetResumed,
  server_error: handleServerError,
  server_shutdown: handleServerShutdown,
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

  // Dispatch to the handler map first — extracted, self-contained cases.
  const handler = HANDLERS[msg.type];
  if (handler) {
    handler(msg, get, set, ctx);
    return;
  }

  switch (msg.type) {

    case 'auth_ok': {
      // Reset replay flags — fresh auth means clean slate
      _receivingHistoryReplay = false;
      // Track this URL as successfully connected
      lastConnectedUrl = ctx.url;
      // Extract server context fields via shared handler (#3102)
      const authPayload = sharedAuthOk(msg);
      const authServerMode = authPayload.serverMode;
      const authSessionCwd = authPayload.sessionCwd;
      const authDefaultCwd = authPayload.defaultCwd;
      const authServerVersion = authPayload.serverVersion;
      const authLatestVersion = authPayload.latestVersion;
      const authServerCommit = authPayload.serverCommit;
      const authProtocolVersion = authPayload.protocolVersion;
      // Parse connected clients list with self-detection via clientId
      const myClientId = typeof msg.clientId === 'string' ? msg.clientId : null;
      const rawClients = Array.isArray(msg.connectedClients) ? msg.connectedClients : [];
      const clients: ConnectedClient[] = rawClients
        .filter((c: unknown): c is { clientId: string } => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).clientId === 'string')
        .map((c: { clientId: string; deviceName?: string; deviceType?: string; platform?: string }) => ({
          clientId: c.clientId,
          deviceName: typeof c.deviceName === 'string' ? c.deviceName : null,
          deviceType: (['phone', 'tablet', 'desktop', 'unknown'].includes(c.deviceType ?? '') ? c.deviceType : 'unknown') as ConnectedClient['deviceType'],
          platform: typeof c.platform === 'string' ? c.platform : 'unknown',
          isSelf: c.clientId === myClientId,
        }));

      // Parse web feature status from auth_ok
      const webFeaturesRaw = msg.webFeatures as Record<string, unknown> | undefined;
      const webFeatures = webFeaturesRaw ? {
        available: !!webFeaturesRaw.available,
        remote: !!webFeaturesRaw.remote,
        teleport: !!webFeaturesRaw.teleport,
      } : { available: false, remote: false, teleport: false };

      // On reconnect, preserve messages and terminal buffer
      const connectedState = {
        connectionPhase: 'connected' as const,
        viewingCachedSession: false,
        wsUrl: ctx.url,
        apiToken: ctx.token,
        socket: ctx.socket,
        claudeReady: false,
        serverMode: authServerMode,
        sessionCwd: authSessionCwd,
        defaultCwd: authDefaultCwd,
        serverVersion: authServerVersion,
        latestVersion: authLatestVersion,
        serverCommit: authServerCommit,
        serverProtocolVersion: authProtocolVersion,
        streamingMessageId: null,
        myClientId: myClientId,
        connectedClients: clients,
        connectionError: null as string | null,
        connectionRetryCount: 0,
        // Clear shutdown / startup state on successful connect
        serverPhase: null,
        tunnelProgress: null,
        shutdownReason: null,
        restartEtaMs: null,
        restartingSince: null,
        webFeatures,
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
      if (msg.encryption === 'required') {
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
      const sessionList = sharedSessionList(msg);
      if (sessionList) {
        // GC persisted messages for sessions that dropped out of the list
        const prevSessionIds = Object.keys(get().sessionStates);
        const newSessionIdSet = new Set(sessionList.map((s) => s.sessionId));
        const removedIds = prevSessionIds.filter((id) => !newSessionIdSet.has(id));
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
          if (get().activeSessionId && removedIds.includes(get().activeSessionId!)) {
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
        // Initialize session state for any new sessions not yet tracked
        const currentStates = get().sessionStates;
        const newInitStates = { ...currentStates };
        let initStatesChanged = false;
        for (const s of sessionList) {
          if (!newInitStates[s.sessionId]) {
            newInitStates[s.sessionId] = createEmptySessionState();
            initStatesChanged = true;
          }
        }
        if (initStatesChanged) {
          set({ sessionStates: newInitStates });
        }
        // Sync conversationId from session list into session states
        for (const s of sessionList) {
          if (s.conversationId && get().sessionStates[s.sessionId]) {
            updateSession(s.sessionId, (ss) =>
              ss.conversationId !== s.conversationId ? { conversationId: s.conversationId } : {}
            );
          }
        }
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
            error: msg.error as { code: string; message: string } | undefined,
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
      if (parsed.category === 'crash' && parsed.sessionPatch) {
        const crashedId = parsed.sessionPatch.sessionId;
        if (crashedId && get().sessionStates[crashedId]) {
          updateSession(crashedId, () => ({ health: 'crashed' as const }));
          pushSessionNotification(crashedId, 'error', 'Session crashed');
        }
      } else if (parsed.message) {
        _adapters.alert.alert('Session Error', parsed.message);
        get().addServerError(parsed.message);
      }
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
      _receivingHistoryReplay = true;
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
      _receivingHistoryReplay = sharedHistoryReplayEnd().receivingHistoryReplay;
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
      // Resolve the cache used for replay-dedup (target session if known,
      // else the global message log).
      const targetState = targetId ? get().sessionStates[targetId] : null;
      const cached = targetState ? targetState.messages : get().messages;
      const result = sharedMessageHandler(msg, get().activeSessionId, _receivingHistoryReplay, cached);
      if (!result.shouldDispatch) break;
      const newMsg = result.chatMessage!;
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
      const usage = msg.usage as Record<string, number> | undefined;
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      // Resolve cost: server provides it for Claude; compute client-side for
      // Codex/Gemini sessions that emit cost: null.
      let resolvedCost: number | null = typeof msg.cost === 'number' ? msg.cost : null;
      if (resolvedCost === null && usage) {
        const sessionModel = get().sessions.find(
          (s: SessionInfo) => s.sessionId === targetId,
        )?.model ?? null;
        if (sessionModel) {
          resolvedCost = calculateCost(
            sessionModel,
            usage.input_tokens || 0,
            usage.output_tokens || 0,
          );
        }
      }
      const resultPatch = {
        streamingMessageId: null as string | null,
        contextUsage: usage
          ? {
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              cacheCreation: usage.cache_creation_input_tokens || 0,
              cacheRead: usage.cache_read_input_tokens || 0,
            }
          : null,
        lastResultCost: resolvedCost,
        lastResultDuration: typeof msg.duration === 'number' ? msg.duration : null,
      };
      // Notify if a background session just finished (was streaming)
      if (targetId && get().sessionStates[targetId]?.streamingMessageId) {
        pushSessionNotification(targetId, 'completed', 'Task completed');
      }
      if (targetId && get().sessionStates[targetId]) {
        // Force a new messages array reference so selectors detect the change,
        // even when flushPendingDeltas() was a no-op (timer already flushed).
        updateSession(targetId, (ss) => ({
          ...resultPatch,
          messages: [...ss.messages],
        }));
      } else {
        set((s) => ({ ...resultPatch, messages: [...s.messages] }));
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
          // Still dismiss any lingering notification banner for this request.
          set((s) => ({
            sessionNotifications: s.sessionNotifications.filter(
              (n) => n.requestId !== expiredRequestId
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
        // Auto-dismiss matching notification banner (#1580)
        set((s) => ({
          sessionNotifications: s.sessionNotifications.filter(
            (n) => n.requestId !== expiredRequestId
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
        diffCb({
          files: payload.files as DiffFile[],
          error: payload.error,
        });
      }
      break;
    }

    case 'git_status_result': {
      const gitStatusCb = get()._gitStatusCallback;
      if (gitStatusCb) {
        const payload = sharedGitStatusResult(msg);
        gitStatusCb({
          branch: payload.branch,
          staged: payload.staged as GitStatusEntry[],
          unstaged: payload.unstaged as GitStatusEntry[],
          untracked: payload.untracked as string[],
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
      // History is preserved on disk. Full UI is a follow-up; log for now.
      const restoreFailed = sharedSessionRestoreFailed(msg);
      // eslint-disable-next-line no-console
      console.warn('[session_restore_failed]', {
        sessionId: restoreFailed.sessionId,
        name: restoreFailed.name,
        provider: restoreFailed.provider,
        errorCode: restoreFailed.errorCode,
        errorMessage: restoreFailed.errorMessage,
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
      set({ searchResults: results as SearchResult[], searchLoading: false });
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
      const { code: errCode, message: errMsg } = sharedError(msg);
      console.error(`[ws] Server handler error [${errCode}]: ${errMsg}`);
      get().addServerError(errMsg);
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
