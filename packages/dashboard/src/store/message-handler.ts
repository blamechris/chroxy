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
  consoleAlert, noopHaptic, noopPush, createStorageAdapter, parseUserInputMessage,
  resolveStreamId,
  resolveSessionId,
  isReplayDuplicate,
  handleModelChanged as sharedModelChanged,
  handlePermissionModeChanged as sharedPermissionModeChanged,
  handleAvailablePermissionModes as sharedAvailablePermissionModes,
  handleSessionUpdated as sharedSessionUpdated,
  handleClaudeReady as sharedClaudeReady,
  handleAgentIdle as sharedAgentIdle,
  handleAgentBusy as sharedAgentBusy,
  handleThinkingLevelChanged as sharedThinkingLevelChanged,
  handleBudgetWarning as sharedBudgetWarning,
  handleBudgetExceeded as sharedBudgetExceeded,
  handleBudgetResumed as sharedBudgetResumed,
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
import { stripAnsi, filterThinking, nextMessageId } from './utils';
import type {
  ChatMessage,
  Checkpoint,
  ConnectedClient,
  ConnectionContext,
  ConnectionState,
  CustomAgent,
  DevPreview,
  DiffFile,
  DirectoryEntry,
  FileEntry,
  GitStatusEntry,
  McpServer,
  ModelInfo,
  QueuedMessage,
  ServerError,
  SessionInfo,
  SessionNotification,
  SessionState,
  SlashCommand,
  FilePickerItem,
  LogEntry,
  ConversationSummary,
  ProviderInfo,
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
let _isSessionSwitchReplay = false;
let _pendingSwitchSessionId: string | null = null;

export function setPendingSwitchSessionId(id: string | null): void {
  _pendingSwitchSessionId = id;
}

export function resetReplayFlags(): void {
  _receivingHistoryReplay = false;
  _isSessionSwitchReplay = false;
  _pendingSwitchSessionId = null;
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

function handleWebFeatureStatus(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  set({
    webFeatures: {
      available: !!msg.available,
      remote: !!msg.remote,
      teleport: !!msg.teleport,
    },
  });
}

function handleWebTaskList(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const tasks = Array.isArray(msg.tasks) ? (msg.tasks as WebTask[]) : [];
  set({ webTasks: tasks });
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
  const sessionId = msg.sessionId as string;
  // Only treat as session-switch replay if the user explicitly initiated it
  // (auth-triggered session_switched on reconnect should use reconnect dedup)
  if (_pendingSwitchSessionId && _pendingSwitchSessionId === sessionId) {
    _isSessionSwitchReplay = true;
  }
  _pendingSwitchSessionId = null;
  const switchConvId = typeof msg.conversationId === 'string' ? msg.conversationId : null;
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
  // During reconnect replay, skip if app already has messages (cache is fresh)
  if (_receivingHistoryReplay && !_isSessionSwitchReplay && get().messages.length > 0) return;
  // Use server messageId as stable identifier for dedup (same ID on live + replay)
  const toolId = (msg.messageId as string) || nextMessageId('tool');
  // During session-switch replay, skip if tool already in cache (dedup by stable ID)
  if (_receivingHistoryReplay && _isSessionSwitchReplay) {
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
  const allowedCategories = new Set<ServerError['category']>([
    'tunnel', 'session', 'permission', 'general',
  ]);
  const category: ServerError['category'] =
    typeof msg.category === 'string' && allowedCategories.has(msg.category as ServerError['category'])
      ? (msg.category as ServerError['category'])
      : 'general';
  const message: string =
    typeof msg.message === 'string' && (msg.message as string).trim().length > 0
      ? stripAnsi(msg.message as string)
      : 'Unknown server error';
  const recoverable: boolean =
    typeof msg.recoverable === 'boolean' ? msg.recoverable : true;

  const errSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
  const serverError: ServerError = {
    id: nextMessageId('err'),
    category,
    message,
    recoverable,
    timestamp: Date.now(),
    ...(errSessionId ? { sessionId: errSessionId } : {}),
  };
  set((state: ConnectionState) => ({
    serverErrors: [...state.serverErrors, serverError].slice(-10),
  }));
  const errorMsg: ChatMessage = {
    id: nextMessageId('err'),
    type: 'error',
    content: serverError.message,
    timestamp: Date.now(),
  };
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
  const reason = msg.reason === 'restart' || msg.reason === 'shutdown' || msg.reason === 'crash' ? msg.reason : 'shutdown';
  const eta = typeof msg.restartEtaMs === 'number' ? msg.restartEtaMs : 0;
  set({
    shutdownReason: reason,
    restartEtaMs: eta,
    restartingSince: Date.now(),
  });
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
      _isSessionSwitchReplay = false;
      _pendingSwitchSessionId = null;
      // Track this URL as successfully connected
      lastConnectedUrl = ctx.url;
      // Extract server context from auth_ok
      const authServerMode: 'cli' | 'terminal' | null =
        msg.serverMode === 'cli' || msg.serverMode === 'terminal' ? msg.serverMode : null;
      const authSessionCwd = typeof msg.cwd === 'string' ? msg.cwd : null;
      const authDefaultCwd = typeof msg.defaultCwd === 'string' ? msg.defaultCwd : null;
      const authServerVersion = typeof msg.serverVersion === 'string' ? msg.serverVersion : null;
      const authLatestVersion = typeof msg.latestVersion === 'string' ? msg.latestVersion : null;
      const authServerCommit = typeof msg.serverCommit === 'string' ? msg.serverCommit : null;
      const authProtocolVersion =
        typeof msg.protocolVersion === 'number' &&
        Number.isFinite(msg.protocolVersion) &&
        Number.isInteger(msg.protocolVersion) &&
        msg.protocolVersion >= 1
          ? msg.protocolVersion
          : null;
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
        if (!msg.publicKey || typeof msg.publicKey !== 'string') {
          console.error('[crypto] Invalid publicKey in key_exchange_ok message', msg.publicKey);
          ctx.socket.close();
          set({ connectionPhase: 'disconnected', socket: null });
          _pendingKeyPair = null;
          _pendingSalt = null;
          break;
        }
        const rawSharedKey = deriveSharedKey(msg.publicKey, _pendingKeyPair.secretKey);
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

    case 'auth_fail':
      ctx.socket.close();
      set({ connectionPhase: 'disconnected', socket: null });
      if (!ctx.silent) {
        _adapters.alert.alert('Auth Failed', (msg.reason as string) || 'Invalid token');
      }
      break;

    case 'server_mode': {
      const mode = msg.mode;
      if (mode === 'cli' || mode === 'terminal') {
        set({ serverMode: mode });
      } else {
        _adapters.alert.alert('Invalid Server Mode', `Ignoring invalid server_mode value: ${mode}`);
      }
      break;
    }

    // --- Multi-session messages ---

    case 'session_list':
      if (Array.isArray(msg.sessions)) {
        const sessionList = msg.sessions as SessionInfo[];
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

    case 'session_context': {
      const ctxSessionId = (msg.sessionId as string) || get().activeSessionId;
      if (ctxSessionId && get().sessionStates[ctxSessionId]) {
        updateSession(ctxSessionId, () => ({
          sessionContext: {
            gitBranch: typeof msg.gitBranch === 'string' ? msg.gitBranch : null,
            gitDirty: typeof msg.gitDirty === 'number' ? msg.gitDirty : 0,
            gitAhead: typeof msg.gitAhead === 'number' ? msg.gitAhead : 0,
            projectName: typeof msg.projectName === 'string' ? msg.projectName : null,
          },
        }));
      }
      break;
    }

    case 'conversation_id': {
      const convSessionId = msg.sessionId as string;
      const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : null;
      if (convSessionId && get().sessionStates[convSessionId]) {
        updateSession(convSessionId, () => ({ conversationId }));
      }
      break;
    }

    case 'session_error': {
      const errorSessionId = (msg.sessionId as string) || get().activeSessionId;
      if (msg.category === 'crash' && errorSessionId && get().sessionStates[errorSessionId]) {
        updateSession(errorSessionId, () => ({ health: 'crashed' as const }));
        pushSessionNotification(errorSessionId, 'error', 'Session crashed');
      }
      if (msg.category !== 'crash') {
        // Rewrite the bound-token error into something actionable (#2904).
        // The raw server message ("Not authorized: client is bound to a
        // specific session") tells the user nothing — replace with a note
        // that names the bound session and hints at the remediation.
        let errorMsg: string;
        if (
          msg.code === 'SESSION_TOKEN_MISMATCH' &&
          typeof msg.boundSessionName === 'string' &&
          msg.boundSessionName.length > 0
        ) {
          errorMsg = `This device is paired to session "${msg.boundSessionName}" and can only talk to that session. Disconnect and scan a fresh QR code to create new sessions.`;
        } else {
          errorMsg = (msg.message as string) || 'Unknown error';
        }
        _adapters.alert.alert('Session Error', errorMsg);
        get().addServerError(errorMsg);
      }
      break;
    }

    // --- History replay ---

    case 'history_replay_start':
      _receivingHistoryReplay = true;
      // Full history replay (from request_full_history): clear messages before replay
      if (msg.fullHistory === true) {
        _isSessionSwitchReplay = true;
        const targetId = (msg.sessionId as string) || get().activeSessionId;
        if (targetId && get().sessionStates[targetId]) {
          updateSession(targetId, () => ({ messages: [] }));
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

    case 'history_replay_end':
      _receivingHistoryReplay = false;
      _isSessionSwitchReplay = false;
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
      const parsed = parseUserInputMessage(msg, get().myClientId, get().activeSessionId);
      if (!parsed) break;
      const { sessionId: parsedSessionId, ...parsedMsg } = parsed;
      // Adopt the server's stable messageId (issue #2902) so a later replay
      // of the same entry dedups by id against this live-echo copy.
      const stableId = typeof msg.messageId === 'string' ? msg.messageId : undefined;
      const uiMsg: ChatMessage = { id: stableId || nextMessageId('user_input'), ...parsedMsg };
      // Write user message to terminal buffer for Output view
      if (parsed.content) {
        get().appendTerminalData(`\r\n\x1b[33m> ${parsed.content}\x1b[0m\r\n\r\n`);
      }
      updateSession(parsedSessionId, (ss) => ({
        messages: [...ss.messages, uiMsg],
      }));
      break;
    }

    // --- Existing message handlers (now session-aware) ---

    case 'message': {
      const msgType = (msg.messageType || msg.type) as string;
      // Live echoes from other clients arrive as top-level `type: 'user_input'`
      // and are handled above. Anything reaching here with
      // messageType === 'user_input' is a history-replay entry and must be
      // rendered so the prompts that triggered past responses are visible.
      if (msgType === 'user_input' && !_receivingHistoryReplay) break;
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      const stableMessageId = typeof msg.messageId === 'string' ? msg.messageId : undefined;
      // During any history replay, skip if an equivalent message is already in cache (dedup).
      // Shared helper lives in @chroxy/store-core (#2903).
      if (_receivingHistoryReplay) {
        const targetState = targetId ? get().sessionStates[targetId] : null;
        const cached = targetState ? targetState.messages : get().messages;
        if (isReplayDuplicate(cached, {
          messageType: msgType,
          messageId: stableMessageId,
          content: msg.content,
          timestamp: msg.timestamp as number | undefined,
          tool: msg.tool as string | undefined,
          options: msg.options as ChatMessage['options'],
        })) break;
      }
      const newMsg: ChatMessage = {
        // Preserve the server-assigned messageId so future replays can still dedup by id.
        id: stableMessageId || nextMessageId(msgType),
        type: msgType as ChatMessage['type'],
        content: msg.content as string,
        tool: msg.tool as string | undefined,
        options: msg.options as ChatMessage['options'],
        timestamp: msg.timestamp as number,
      };
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
      if (msgType === 'error' && typeof msg.content === 'string') {
        const content = (msg.content as string).toLowerCase();
        if (content.includes('rate limit') || content.includes('usage limit') || content.includes('quota') || content.includes('overloaded')) {
          _adapters.alert.alert('Usage Limit', msg.content as string);
        }
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
        lastResultCost: typeof msg.cost === 'number' ? msg.cost : null,
        lastResultDuration: typeof msg.duration === 'number' ? msg.duration : null,
      };
      const targetId = (msg.sessionId as string) || get().activeSessionId;
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

    case 'available_models':
      if (Array.isArray(msg.models)) {
        const cleaned = (msg.models as unknown[])
          .map((m: unknown): ModelInfo | null => {
            if (typeof m === 'object' && m !== null) {
              const { id, label, fullId, contextWindow } = m as ModelInfo;
              if (
                typeof id === 'string' && id.trim() !== '' &&
                typeof label === 'string' && label.trim() !== '' &&
                typeof fullId === 'string' && fullId.trim() !== ''
              ) {
                const info: ModelInfo = { id, label, fullId };
                if (typeof contextWindow === 'number' && contextWindow > 0) info.contextWindow = contextWindow;
                return info;
              }
            }
            if (typeof m === 'string' && m.trim().length > 0) {
              const s = m.trim();
              return { id: s, label: s.charAt(0).toUpperCase() + s.slice(1), fullId: s };
            }
            return null;
          })
          .filter((m: ModelInfo | null): m is ModelInfo => m !== null);
        const defaultModelId = typeof msg.defaultModel === 'string' ? msg.defaultModel : null;
        set({ availableModels: cleaned, defaultModelId });
      }
      break;

    case 'confirm_permission_mode': {
      const confirmMode = typeof msg.mode === 'string' ? msg.mode : null;
      const warning = typeof msg.warning === 'string' ? msg.warning : 'Are you sure?';
      if (confirmMode) {
        set({ pendingPermissionConfirm: { mode: confirmMode, warning } });
      }
      break;
    }

    case 'agent_spawned': {
      const spawnTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (spawnTargetId && get().sessionStates[spawnTargetId]) {
        updateSession(spawnTargetId, (ss) => {
          if (ss.activeAgents.some((a) => a.toolUseId === msg.toolUseId)) return {};
          return {
            activeAgents: [...ss.activeAgents, {
              toolUseId: msg.toolUseId as string,
              description: (msg.description as string) || 'Background task',
              startedAt: (msg.startedAt as number) || Date.now(),
            }],
          };
        });
      }
      break;
    }

    case 'agent_completed': {
      const completeTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (completeTargetId && get().sessionStates[completeTargetId]) {
        updateSession(completeTargetId, (ss) => {
          const filtered = ss.activeAgents.filter(
            (a) => a.toolUseId !== msg.toolUseId
          );
          if (filtered.length === ss.activeAgents.length) return {};
          return { activeAgents: filtered };
        });
      }
      break;
    }

    case 'plan_started': {
      const planStartTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (planStartTargetId && get().sessionStates[planStartTargetId]) {
        updateSession(planStartTargetId, () => ({
          isPlanPending: false,
          planAllowedPrompts: [],
        }));
      }
      break;
    }

    case 'plan_ready': {
      const planReadyTargetId = (msg.sessionId as string) || get().activeSessionId;
      const prompts = Array.isArray(msg.allowedPrompts) ? msg.allowedPrompts as { tool: string; prompt: string }[] : [];
      if (planReadyTargetId && get().sessionStates[planReadyTargetId]) {
        updateSession(planReadyTargetId, () => ({
          isPlanPending: true,
          planAllowedPrompts: prompts,
        }));
      }
      break;
    }

    case 'permission_expired': {
      const expiredRequestId = msg.requestId as string;
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
                ? { ...m, content: `${m.content}\n(Expired — this permission was already handled or timed out)`, options: undefined }
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
      const rulesSessionId = (msg.sessionId as string) || get().activeSessionId;
      const rules = Array.isArray(msg.rules)
        ? (msg.rules as { tool: string; decision: 'allow' | 'deny'; pattern?: string }[])
        : [];
      if (rulesSessionId && get().sessionStates[rulesSessionId]) {
        updateSession(rulesSessionId, () => ({ sessionRules: rules }));
      }
      break;
    }

    case 'user_question': {
      const questions = msg.questions as unknown[];
      if (!Array.isArray(questions) || questions.length === 0) break;
      const q = questions[0] as Record<string, unknown>;
      if (!q || typeof q !== 'object' || typeof q.question !== 'string') break;
      const questionMsg: ChatMessage = {
        id: nextMessageId('question'),
        type: 'prompt',
        content: q.question as string,
        toolUseId: msg.toolUseId as string,
        options: Array.isArray(q.options)
          ? (q.options as unknown[])
              .filter((o: unknown): o is { label: string } => !!o && typeof o === 'object' && typeof (o as Record<string, unknown>).label === 'string')
              .map((o: { label: string }) => ({
                label: o.label,
                value: o.label,
              }))
          : [],
        timestamp: Date.now(),
      };
      const questionTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (questionTargetId && get().sessionStates[questionTargetId]) {
        updateSession(questionTargetId, (ss) => ({
          messages: [...ss.messages, questionMsg],
        }));
      } else {
        get().addMessage(questionMsg);
      }
      if (questionTargetId) {
        const questionText = (q.question as string).slice(0, 60);
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

      // Legacy plain-message server_status (no phase field)
      const statusMessage: string =
        typeof msg.message === 'string' && (msg.message as string).trim().length > 0
          ? stripAnsi(msg.message as string)
          : 'Status update';
      const statusMsg: ChatMessage = {
        id: nextMessageId('status'),
        type: 'system',
        content: statusMessage,
        timestamp: Date.now(),
      };
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
      if (!msg.client || typeof (msg.client as Record<string, unknown>).clientId !== 'string') break;
      const client = msg.client as Record<string, unknown>;
      const newClient: ConnectedClient = {
        clientId: client.clientId as string,
        deviceName: typeof client.deviceName === 'string' ? client.deviceName : null,
        deviceType: (['phone', 'tablet', 'desktop', 'unknown'].includes(client.deviceType as string) ? client.deviceType : 'unknown') as ConnectedClient['deviceType'],
        platform: typeof client.platform === 'string' ? client.platform : 'unknown',
        isSelf: false,
      };
      set((state: ConnectionState) => ({
        connectedClients: [...state.connectedClients.filter((c) => c.clientId !== newClient.clientId), newClient],
      }));
      const deviceLabel = newClient.deviceName || 'A device';
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
      if (typeof msg.clientId !== 'string') break;
      const departingClient = get().connectedClients.find((c) => c.clientId === msg.clientId);
      set((state: ConnectionState) => ({
        connectedClients: state.connectedClients.filter((c) => c.clientId !== msg.clientId),
      }));
      const leftLabel = departingClient?.deviceName || 'A device';
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
      const primarySessionId = msg.sessionId as string;
      const primaryClientId = typeof msg.clientId === 'string' ? msg.clientId : null;
      if (typeof primarySessionId === 'string' && get().sessionStates[primarySessionId]) {
        updateSession(primarySessionId, () => ({
          primaryClientId,
        }));
      } else if (!primarySessionId || primarySessionId === 'default') {
        set({ primaryClientId });
      }
      break;
    }

    case 'client_focus_changed': {
      const focusClientId = typeof msg.clientId === 'string' ? msg.clientId : null;
      const focusSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      if (!focusClientId || !focusSessionId) break;
      // Auto-switch if follow mode is on, event is from another client, target session exists locally, and not already on it
      const { followMode, myClientId, activeSessionId, sessionStates } = get();
      if (followMode && focusClientId !== myClientId && focusSessionId !== activeSessionId && sessionStates[focusSessionId]) {
        get().switchSession(focusSessionId);
      }
      break;
    }

    case 'directory_listing': {
      const cb = get()._directoryListingCallback;
      if (cb) {
        cb({
          path: typeof msg.path === 'string' ? msg.path : null,
          parentPath: typeof msg.parentPath === 'string' ? msg.parentPath : null,
          entries: Array.isArray(msg.entries) ? msg.entries as DirectoryEntry[] : [],
          error: typeof msg.error === 'string' ? msg.error : null,
        });
      }
      break;
    }

    case 'file_listing': {
      const fileBrowserCb = get()._fileBrowserCallback;
      if (fileBrowserCb) {
        fileBrowserCb({
          path: typeof msg.path === 'string' ? msg.path : null,
          parentPath: typeof msg.parentPath === 'string' ? msg.parentPath : null,
          entries: Array.isArray(msg.entries) ? msg.entries as FileEntry[] : [],
          error: typeof msg.error === 'string' ? msg.error : null,
        });
      }
      break;
    }

    case 'file_content': {
      const fileContentCb = get()._fileContentCallback;
      if (fileContentCb) {
        fileContentCb({
          path: typeof msg.path === 'string' ? msg.path : null,
          content: typeof msg.content === 'string' ? msg.content : null,
          language: typeof msg.language === 'string' ? msg.language : null,
          size: typeof msg.size === 'number' ? msg.size : null,
          truncated: msg.truncated === true,
          error: typeof msg.error === 'string' ? msg.error : null,
        });
      }
      break;
    }

    case 'diff_result': {
      const diffCb = get()._diffCallback;
      if (diffCb) {
        diffCb({
          files: Array.isArray(msg.files) ? msg.files as DiffFile[] : [],
          error: typeof msg.error === 'string' ? msg.error : null,
        });
      }
      break;
    }

    case 'git_status_result': {
      const gitStatusCb = get()._gitStatusCallback;
      if (gitStatusCb) {
        gitStatusCb({
          branch: typeof msg.branch === 'string' ? msg.branch : null,
          staged: Array.isArray(msg.staged) ? msg.staged as GitStatusEntry[] : [],
          unstaged: Array.isArray(msg.unstaged) ? msg.unstaged as GitStatusEntry[] : [],
          untracked: Array.isArray(msg.untracked) ? msg.untracked as string[] : [],
          error: typeof msg.error === 'string' ? msg.error : null,
        });
      }
      break;
    }

    case 'slash_commands': {
      const slashSid = get().activeSessionId;
      if (msg.sessionId && slashSid && msg.sessionId !== slashSid) break;
      if (Array.isArray(msg.commands)) {
        set({ slashCommands: msg.commands as SlashCommand[] });
      }
      break;
    }

    case 'file_list': {
      const files = Array.isArray(msg.files)
        ? (msg.files as FilePickerItem[])
        : [];
      set({ filePickerFiles: files });
      break;
    }

    case 'agent_list': {
      const agentSid = get().activeSessionId;
      if (msg.sessionId && agentSid && msg.sessionId !== agentSid) break;
      if (Array.isArray(msg.agents)) {
        set({ customAgents: msg.agents as CustomAgent[] });
      }
      break;
    }

    case 'provider_list': {
      if (Array.isArray(msg.providers)) {
        set({ availableProviders: msg.providers as ProviderInfo[] });
      }
      break;
    }

    case 'checkpoint_created': {
      const cpSid = (msg.sessionId as string) || get().activeSessionId;
      if (cpSid !== get().activeSessionId) break;
      if (msg.checkpoint && typeof msg.checkpoint === 'object') {
        const cp = msg.checkpoint as Checkpoint;
        set({ checkpoints: [...get().checkpoints, cp] });
      }
      break;
    }

    case 'checkpoint_list': {
      const listSid = (msg.sessionId as string) || get().activeSessionId;
      if (listSid !== get().activeSessionId) break;
      if (Array.isArray(msg.checkpoints)) {
        set({ checkpoints: msg.checkpoints as Checkpoint[] });
      }
      break;
    }

    case 'mcp_servers': {
      const mcpTargetId = (msg.sessionId as string) || get().activeSessionId;
      const servers = (msg.servers as McpServer[]) || [];
      if (mcpTargetId && get().sessionStates[mcpTargetId]) {
        updateSession(mcpTargetId, () => ({ mcpServers: servers }));
      }
      break;
    }

    case 'cost_update': {
      const sessionCost = typeof msg.sessionCost === 'number' ? msg.sessionCost : null;
      const costTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (costTargetId && get().sessionStates[costTargetId]) {
        updateSession(costTargetId, () => ({ sessionCost }));
      }
      break;
    }

    case 'dev_preview': {
      const previewSid = (msg.sessionId as string) || get().activeSessionId;
      const preview: DevPreview = { port: msg.port as number, url: msg.url as string };
      if (previewSid && get().sessionStates[previewSid]) {
        updateSession(previewSid, (s) => {
          // Avoid duplicates for same port
          const existing = s.devPreviews.filter((p) => p.port !== preview.port);
          return { devPreviews: [...existing, preview] };
        });
      }
      break;
    }

    case 'dev_preview_stopped': {
      const stoppedSid = (msg.sessionId as string) || get().activeSessionId;
      const stoppedPort = msg.port as number;
      if (stoppedSid && get().sessionStates[stoppedSid]) {
        updateSession(stoppedSid, (s) => ({
          devPreviews: s.devPreviews.filter((p) => p.port !== stoppedPort),
        }));
      }
      break;
    }

    // -- Web tasks (Claude Code Web) --

    case 'web_task_created':
    case 'web_task_updated': {
      const task = msg.task as WebTask;
      if (!task || !task.taskId) break;
      set((state: ConnectionState) => {
        const existing = state.webTasks.filter((t) => t.taskId !== task.taskId);
        return { webTasks: [...existing, task] };
      });
      break;
    }

    case 'web_task_error': {
      const errTaskId = msg.taskId as string | null;
      if (errTaskId) {
        // Update task status to failed
        set((state: ConnectionState) => ({
          webTasks: state.webTasks.map((t) =>
            t.taskId === errTaskId
              ? { ...t, status: 'failed' as const, error: (msg.message as string) || 'Unknown error', updatedAt: Date.now() }
              : t,
          ),
        }));
      }
      // Show error as system message in chat
      const errorMsg: ChatMessage = {
        id: nextMessageId('web'),
        type: 'system',
        content: (msg.message as string) || 'Web task error',
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
      const results = Array.isArray(msg.results) ? msg.results : [];
      const msgQuery = typeof msg.query === 'string' ? msg.query : null;
      const currentQuery = (get() as ConnectionState).searchQuery;
      if (msgQuery !== null && currentQuery && msgQuery !== currentQuery) {
        break; // Stale response for an older query — ignore
      }
      set({ searchResults: results, searchLoading: false });
      break;
    }

    case 'log_entry': {
      const component = typeof msg.component === 'string' ? msg.component : 'unknown';
      const level = (['debug', 'info', 'warn', 'error'] as const).includes(msg.level as LogEntry['level'])
        ? (msg.level as LogEntry['level'])
        : 'info';
      const logMessage = typeof msg.message === 'string' ? stripAnsi(msg.message as string) : '';
      const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now();
      const logSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
      const entry: LogEntry = {
        id: nextMessageId('log'),
        component,
        level,
        message: logMessage,
        timestamp,
        ...(logSessionId && { sessionId: logSessionId }),
      };
      set((state: ConnectionState) => ({
        logEntries: [...state.logEntries, entry].slice(-500),
      }));
      break;
    }

    case 'session_warning': {
      const message = typeof msg.message === 'string' ? msg.message : 'Session will timeout soon';
      const warningMsg: ChatMessage = {
        id: nextMessageId('warn'),
        type: 'system',
        content: message,
        timestamp: Date.now(),
      };
      const warnSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
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
      const timeoutSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      const name = typeof msg.name === 'string' ? msg.name : 'Unknown';
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
      const environments = Array.isArray(msg.environments) ? msg.environments : [];
      set({ environments });
      break;
    }
    case 'environment_created':
    case 'environment_destroyed':
    case 'environment_info':
      // Handled implicitly via the environment_list broadcast that follows
      break;
    case 'environment_error': {
      console.error('[ws] Environment error:', msg.error);
      break;
    }

    case 'error': {
      // Structured error response from a handler catch block.
      // Log it and surface it as a server error notification.
      const errCode = typeof msg.code === 'string' ? msg.code : 'UNKNOWN';
      const errMsg = typeof msg.message === 'string'
        ? stripAnsi(msg.message as string)
        : 'An unexpected server error occurred';
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
