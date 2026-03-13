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
import { Alert } from 'react-native';
import {
  createKeyPair,
  deriveSharedKey,
  DIRECTION_CLIENT,
  DIRECTION_SERVER,
  type EncryptionState,
  type KeyPair,
  type EncryptedEnvelope,
} from '../utils/crypto';
import { registerForPushNotifications } from '../notifications';
import { stripAnsi, filterThinking, nextMessageId } from './utils';
import { parseUserInputMessage } from '@chroxy/store-core';
import { hapticSuccess } from '../utils/haptics';
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
  McpServer,
  ModelInfo,
  QueuedMessage,
  ServerError,
  SessionInfo,
  SessionNotification,
  SessionState,
  SlashCommand,
  ConversationSummary,
  ToolResultImage,
  WebTask,
  GitFileStatus,
  GitBranch,
} from './types';
import { createEmptySessionState } from './utils';
import { deriveActivityState } from './session-activity';
import { clearPersistedSession } from './persistence';
import { getCallback } from './imperative-callbacks';
import { useMultiClientStore } from './multi-client';

// ---------------------------------------------------------------------------
// Protocol version — bumped when the WS message set changes
// ---------------------------------------------------------------------------
export const CLIENT_PROTOCOL_VERSION = 1;

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
import { encrypt, decrypt } from '../utils/crypto';

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

// Pending pairing ID — set when connecting via QR pairing flow, cleared after auth_ok
export let pendingPairingId: string | null = null;

export function setPendingPairingId(id: string | null): void {
  pendingPairingId = id;
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
  const cb = getCallback('terminalWrite');
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
/** Max session IDs per subscribe_sessions message (must match server SubscribeSessionsSchema .max(20)) */
export const SUBSCRIBE_SESSIONS_CHUNK_SIZE = 20;
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
      const updatedMessages = sessionState.messages.map((m) => {
        const d = deltas.get(m.id);
        return d ? { ...m, content: m.content + d } : m;
      });
      newSessionStates = {
        ...newSessionStates,
        [sessionId]: { ...sessionState, messages: updatedMessages },
      };
      if (sessionId === state.activeSessionId) {
        getStore().setState({ sessionStates: newSessionStates, messages: updatedMessages });
        flatUpdated = true;
      }
    } else {
      getStore().setState((s) => ({
        messages: s.messages.map((m) => {
          const d = deltas.get(m.id);
          return d ? { ...m, content: m.content + d } : m;
        }),
      }));
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
}

// ---------------------------------------------------------------------------
// Push token registration
// ---------------------------------------------------------------------------

async function registerPushToken(socket: WebSocket): Promise<void> {
  try {
    const token = await registerForPushNotifications();
    if (token && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'register_push_token', token });
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

const STORAGE_KEY_URL = 'chroxy_last_url';
const STORAGE_KEY_TOKEN = 'chroxy_last_token';

export async function saveConnection(url: string, token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_URL, url);
    await SecureStore.setItemAsync(STORAGE_KEY_TOKEN, token);
  } catch {
    // Storage not available (e.g. Expo Go limitations)
  }
}

export async function loadConnection(): Promise<{ url: string; token: string } | null> {
  try {
    const url = await SecureStore.getItemAsync(STORAGE_KEY_URL);
    const token = await SecureStore.getItemAsync(STORAGE_KEY_TOKEN);
    if (url && token) return { url, token };
  } catch {
    // Storage not available
  }
  return null;
}

export async function clearConnection(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY_URL);
    await SecureStore.deleteItemAsync(STORAGE_KEY_TOKEN);
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

  switch (msg.type) {
    case 'pong':
      _onPong();
      return;

    case 'auth_ok': {
      // Reset replay flags — fresh auth means clean slate
      _receivingHistoryReplay = false;
      _isSessionSwitchReplay = false;
      _pendingSwitchSessionId = null;
      if (!ctx.isReconnect) hapticSuccess();
      // Track this URL as successfully connected
      lastConnectedUrl = ctx.url;
      // Extract server context from auth_ok
      const authServerMode: 'cli' | null =
        msg.serverMode === 'cli' ? 'cli' : null;
      const authSessionCwd = typeof msg.cwd === 'string' ? msg.cwd : null;
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
      // If server provided a sessionToken (via pairing), use it for future auth
      const effectiveToken = typeof msg.sessionToken === 'string' ? msg.sessionToken : ctx.token;
      const connectedState = {
        connectionPhase: 'connected' as const,
        viewingCachedSession: false,
        wsUrl: ctx.url,
        apiToken: effectiveToken,
        socket: ctx.socket,
        claudeReady: false,
        serverMode: authServerMode,
        sessionCwd: authSessionCwd,
        serverVersion: authServerVersion,
        latestVersion: authLatestVersion,
        serverCommit: authServerCommit,
        serverProtocolVersion: authProtocolVersion,
        streamingMessageId: null,
        myClientId: myClientId, // kept for backward compat; canonical source is useMultiClientStore
        connectedClients: clients, // kept for backward compat; canonical source is useMultiClientStore
        connectionError: null as string | null,
        connectionRetryCount: 0,
        // Clear shutdown state on successful connect
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
      // Sync multi-client store (canonical source for multi-client state)
      useMultiClientStore.getState().setMyClientId(myClientId);
      useMultiClientStore.getState().setConnectedClients(clients);

      // Start client-side heartbeat for dead connection detection
      startHeartbeat(ctx.socket);

      // Initiate key exchange if server requires encryption
      if (msg.encryption === 'required') {
        _pendingKeyPair = createKeyPair();
        // Send key_exchange plaintext (before encryption is active)
        ctx.socket.send(JSON.stringify({ type: 'key_exchange', publicKey: _pendingKeyPair.publicKey }));
        // Post-auth messages will be sent after key_exchange_ok arrives
        set({ isEncrypted: true });
      } else {
        // No encryption — send post-auth messages immediately
        wsSend(ctx.socket, { type: 'list_slash_commands' });
        wsSend(ctx.socket, { type: 'list_agents' });
        set({ isEncrypted: false });
      }
      // Save for quick reconnect (use effectiveToken for pairing flow)
      saveConnection(ctx.url, effectiveToken);
      set({ savedConnection: { url: ctx.url, token: effectiveToken } });
      // Register push token (async, non-blocking)
      void registerPushToken(ctx.socket);
      break;
    }

    case 'key_exchange_ok': {
      if (_pendingKeyPair) {
        if (!msg.publicKey || typeof msg.publicKey !== 'string') {
          console.error('[crypto] Invalid publicKey in key_exchange_ok message', msg.publicKey);
          ctx.socket.close();
          set({ connectionPhase: 'disconnected', socket: null });
          _pendingKeyPair = null;
          break;
        }
        const sharedKey = deriveSharedKey(msg.publicKey, _pendingKeyPair.secretKey);
        _encryptionState = { sharedKey, sendNonce: 0, recvNonce: 0 };
        _pendingKeyPair = null;
        console.log('[crypto] E2E encryption established');
        // Now send the post-auth messages that were deferred
        wsSend(ctx.socket, { type: 'list_slash_commands' });
        wsSend(ctx.socket, { type: 'list_agents' });
      }
      break;
    }

    case 'auth_fail':
      ctx.socket.close();
      set({ connectionPhase: 'disconnected', socket: null });
      if (!ctx.silent) {
        Alert.alert('Auth Failed', (msg.reason as string) || 'Invalid token');
      }
      break;

    case 'pair_fail': {
      ctx.socket.close();
      set({ connectionPhase: 'disconnected', socket: null });
      if (!ctx.silent) {
        const reason = (msg.reason as string) || 'pairing_failed';
        const pairMessages: Record<string, string> = {
          expired: 'This QR code has expired. Scan the latest QR code from your server.',
          already_used: 'This QR code has already been used. Scan the latest QR code from your server.',
          invalid_pairing_id: 'Invalid pairing code. Scan the latest QR code from your server.',
          rate_limited: 'Too many attempts. Please wait a moment and try again.',
        };
        Alert.alert('Pairing Failed', pairMessages[reason] || `Pairing failed: ${reason}`);
      }
      break;
    }

    case 'server_mode':
      set({ serverMode: msg.mode === 'cli' ? 'cli' : null });
      // Force chat view in CLI mode (no terminal available)
      if (msg.mode === 'cli' && get().viewMode === 'terminal') {
        set({ viewMode: 'chat' });
      }
      break;

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
        // Initialize session state for any new sessions not yet tracked
        const currentStates = get().sessionStates;
        const newStates = { ...currentStates };
        let statesChanged = false;
        for (const s of sessionList) {
          if (!newStates[s.sessionId]) {
            newStates[s.sessionId] = createEmptySessionState();
            statesChanged = true;
          }
        }
        if (statesChanged) {
          set({ sessionStates: newStates });
        }
        // Sync conversationId from session list into session states
        for (const s of sessionList) {
          if (s.conversationId && get().sessionStates[s.sessionId]) {
            updateSession(s.sessionId, (ss) =>
              ss.conversationId !== s.conversationId ? { conversationId: s.conversationId } : {}
            );
          }
        }
        // Subscribe to all non-active sessions so we receive their events
        // (permissions, plan approvals, errors) in real-time
        const activeId = get().activeSessionId;
        const subscribeIds = sessionList
          .map((s) => s.sessionId)
          .filter((id) => id !== activeId);
        if (subscribeIds.length > 0) {
          const sock = get().socket;
          if (sock && sock.readyState === WebSocket.OPEN) {
            // Server schema enforces max IDs per message — chunk if needed
            for (let i = 0; i < subscribeIds.length; i += SUBSCRIBE_SESSIONS_CHUNK_SIZE) {
              wsSend(sock, { type: 'subscribe_sessions', sessionIds: subscribeIds.slice(i, i + SUBSCRIBE_SESSIONS_CHUNK_SIZE) });
            }
          }
        }
      }
      break;

    case 'session_updated': {
      const updatedId = msg.sessionId as string;
      const updatedName = msg.name as string;
      if (updatedId && updatedName) {
        const sessions = get().sessions.map((s) =>
          s.sessionId === updatedId ? { ...s, name: updatedName } : s,
        );
        set({ sessions });
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

    case 'session_switched': {
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
        Alert.alert('Session Error', (msg.message as string) || 'Unknown error');
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
      const parsed = parseUserInputMessage(msg, get().myClientId, get().activeSessionId);
      if (!parsed) break;
      const { sessionId: parsedSessionId, ...parsedMsg } = parsed;
      const uiMsg: ChatMessage = { id: nextMessageId('user_input'), ...parsedMsg };
      updateSession(parsedSessionId, (ss) => ({
        messages: [...ss.messages, uiMsg],
      }));
      break;
    }

    // --- Existing message handlers (now session-aware) ---

    case 'message': {
      const msgType = (msg.messageType || msg.type) as string;
      // Skip server-echoed user_input — we already show it instantly client-side
      // But allow user_input during full history sync (messages came from terminal)
      if (msgType === 'user_input' && !(_receivingHistoryReplay && _isSessionSwitchReplay)) break;
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      // During reconnect replay, skip if app already has messages (cache is fresh)
      if (_receivingHistoryReplay && !_isSessionSwitchReplay && get().messages.length > 0) break;
      // During any history replay, skip if an equivalent message is already in cache (dedup).
      // This prevents duplicates when the app already received messages via real-time
      // subscription before switching to the session (which triggers history replay).
      if (_receivingHistoryReplay) {
        const targetState = targetId ? get().sessionStates[targetId] : null;
        const cached = targetState ? targetState.messages : get().messages;
        const isDuplicate = cached.some((m) => {
          if (m.type !== msgType || m.content !== msg.content) return false;
          if (m.timestamp !== msg.timestamp) return false;
          if ((m.tool ?? null) !== (msg.tool ?? null)) return false;
          return JSON.stringify(m.options ?? null) === JSON.stringify(msg.options ?? null);
        });
        if (isDuplicate) break;
      }
      const newMsg: ChatMessage = {
        id: nextMessageId(msgType),
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
          Alert.alert('Usage Limit', msg.content as string);
        }
      }
      break;
    }

    case 'stream_start': {
      const streamId = msg.messageId as string;
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, (ss) => {
          const existing = ss.messages.find((m) => m.id === streamId);
          if (existing && existing.type === 'response') {
            // Reuse existing response message (reconnect replay dedup)
            return { streamingMessageId: streamId };
          }
          // If the ID collides with a non-response message (e.g., tool_use),
          // create a new response with a suffixed ID and remap future deltas.
          const responseId = existing ? `${streamId}-response` : streamId;
          if (existing) {
            _deltaIdRemaps.set(streamId, responseId);
          }
          return {
            streamingMessageId: responseId,
            messages: [
              ...filterThinking(ss.messages),
              { id: responseId, type: 'response' as const, content: '', timestamp: Date.now() },
            ],
          };
        });
      } else {
        set((state: ConnectionState) => {
          const existing = state.messages.find((m) => m.id === streamId);
          if (existing && existing.type === 'response') {
            return { streamingMessageId: streamId };
          }
          const responseId = existing ? `${streamId}-response` : streamId;
          if (existing) {
            _deltaIdRemaps.set(streamId, responseId);
          }
          return {
            streamingMessageId: responseId,
            messages: [
              ...filterThinking(state.messages),
              { id: responseId, type: 'response' as const, content: '', timestamp: Date.now() },
            ],
          };
        });
      }
      break;
    }

    case 'stream_delta': {
      let deltaId = msg.messageId as string;
      const capturedSessionId = (msg.sessionId as string) || get().activeSessionId;

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
      break;
    }

    case 'stream_end':
      // Flush any buffered deltas immediately before clearing streaming state
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer);
      }
      flushPendingDeltas();
      // Clean up permission boundary split tracking
      _postPermissionSplits.delete(msg.messageId as string);
      _deltaIdRemaps.delete(msg.messageId as string);
      {
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
      break;

    case 'tool_start': {
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      // During reconnect replay, skip if app already has messages (cache is fresh)
      if (_receivingHistoryReplay && !_isSessionSwitchReplay && get().messages.length > 0) break;
      // Use server messageId as stable identifier for dedup (same ID on live + replay)
      const toolId = (msg.messageId as string) || nextMessageId('tool');
      // During session-switch replay, skip if tool already in cache (dedup by stable ID)
      if (_receivingHistoryReplay && _isSessionSwitchReplay) {
        const targetState = targetId ? get().sessionStates[targetId] : null;
        const cached = targetState ? targetState.messages : get().messages;
        if (cached.some((m) => m.id === toolId)) break;
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
      break;
    }

    case 'tool_result': {
      const toolUseId = msg.toolUseId as string;
      if (!toolUseId) break;
      const resultText = (msg.result as string) || '';
      const truncated = !!(msg.truncated as boolean);
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
        updated[idx] = { ...updated[idx], ...patch };
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
          updated[idx] = { ...updated[idx], ...patch };
          set({ messages: updated });
        }
      }
      break;
    }

    case 'result': {
      hapticSuccess();
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

    case 'model_changed': {
      const model = (typeof msg.model === 'string' && (msg.model as string).trim()) ? (msg.model as string).trim() : null;
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, () => ({ activeModel: model }));
      } else {
        set({ activeModel: model });
      }
      break;
    }

    case 'available_models':
      if (Array.isArray(msg.models)) {
        const cleaned = (msg.models as unknown[])
          .map((m: unknown): ModelInfo | null => {
            if (typeof m === 'object' && m !== null) {
              const { id, label, fullId } = m as ModelInfo;
              if (
                typeof id === 'string' && id.trim() !== '' &&
                typeof label === 'string' && label.trim() !== '' &&
                typeof fullId === 'string' && fullId.trim() !== ''
              ) {
                return { id, label, fullId };
              }
            }
            if (typeof m === 'string' && m.trim().length > 0) {
              const s = m.trim();
              return { id: s, label: s.charAt(0).toUpperCase() + s.slice(1), fullId: s };
            }
            return null;
          })
          .filter((m: ModelInfo | null): m is ModelInfo => m !== null);
        set({ availableModels: cleaned });
      }
      break;

    case 'permission_mode_changed': {
      const mode = (typeof msg.mode === 'string' && (msg.mode as string).trim()) ? (msg.mode as string).trim() : null;
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, () => ({ permissionMode: mode }));
      } else {
        set({ permissionMode: mode });
      }
      // Clear pending confirm if mode change arrived (confirmation was accepted)
      set({ pendingPermissionConfirm: null });
      break;
    }

    case 'confirm_permission_mode': {
      const confirmMode = typeof msg.mode === 'string' ? msg.mode : null;
      const warning = typeof msg.warning === 'string' ? msg.warning : 'Are you sure?';
      if (confirmMode) {
        set({ pendingPermissionConfirm: { mode: confirmMode, warning } });
      }
      break;
    }

    case 'available_permission_modes':
      if (Array.isArray(msg.modes)) {
        const cleaned = (msg.modes as unknown[])
          .filter((m): m is { id: string; label: string } =>
            typeof m === 'object' && m !== null &&
            typeof (m as { id: unknown }).id === 'string' &&
            typeof (m as { label: unknown }).label === 'string'
          );
        set({ availablePermissionModes: cleaned });
      }
      break;

    case 'raw':
      get().appendTerminalData(msg.data as string);
      break;

    case 'claude_ready': {
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, () => ({ claudeReady: true }));
      } else {
        set({ claudeReady: true });
      }
      // Drain queued messages on reconnect
      const readySocket = get().socket;
      if (readySocket && readySocket.readyState === WebSocket.OPEN) {
        drainMessageQueue(readySocket);
      }
      break;
    }

    case 'agent_idle': {
      const idleTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (idleTargetId && get().sessionStates[idleTargetId]) {
        updateSession(idleTargetId, () => ({ isIdle: true }));
      }
      break;
    }

    case 'agent_busy': {
      const busyTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (busyTargetId && get().sessionStates[busyTargetId]) {
        updateSession(busyTargetId, () => ({ isIdle: false }));
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
      if (planReadyTargetId) {
        pushSessionNotification(planReadyTargetId, 'plan', 'Plan ready for approval');
      }
      break;
    }

    case 'raw_background':
      get().appendTerminalData(msg.data as string);
      break;

    case 'permission_request': {
      // Split streaming response at permission boundary (#554)
      {
        const permTargetId = (msg.sessionId as string) || get().activeSessionId;
        const currentStreamId = permTargetId && get().sessionStates[permTargetId]
          ? get().sessionStates[permTargetId].streamingMessageId
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
      const newOptions = [
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' },
        { label: 'Always Allow', value: 'allowAlways' },
      ];
      const newExpiresAt = typeof msg.remainingMs === 'number' ? Date.now() + msg.remainingMs : undefined;
      const permTargetId = (msg.sessionId as string) || get().activeSessionId;

      const targetMessages = permTargetId && get().sessionStates[permTargetId]
        ? get().sessionStates[permTargetId].messages
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
        const toolName = typeof msg.tool === 'string' ? msg.tool : undefined;
        const toolDesc = toolName ?? 'Permission needed';
        const toolDescription = typeof msg.description === 'string' ? msg.description : undefined;
        const inputPreview = msg.input && typeof msg.input === 'object'
          ? truncateInput(msg.input as Record<string, unknown>)
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
          sessionNotifications: (s.sessionNotifications ?? []).filter(
            (n) => n.requestId !== resolvedRequestId
          ),
        }));
      }
      break;
    }

    case 'permission_expired': {
      const expiredRequestId = msg.requestId as string;
      if (expiredRequestId) {
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
        // Auto-dismiss matching notification banner
        set((s) => ({
          sessionNotifications: (s.sessionNotifications ?? []).filter(
            (n) => n.requestId !== expiredRequestId
          ),
        }));
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

    case 'server_shutdown': {
      const reason = msg.reason === 'restart' || msg.reason === 'shutdown' || msg.reason === 'crash' ? msg.reason : 'shutdown';
      const eta = typeof msg.restartEtaMs === 'number' ? msg.restartEtaMs : 0;
      set({
        shutdownReason: reason,
        restartEtaMs: eta,
        restartingSince: Date.now(),
      });
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
      useMultiClientStore.getState().addClient(newClient);
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
      if (typeof msg.clientId !== 'string') break;
      const departingClient = useMultiClientStore.getState().removeClient(msg.clientId as string);
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
      const primarySessionId = msg.sessionId as string;
      const primaryClientId = typeof msg.clientId === 'string' ? msg.clientId : null;
      useMultiClientStore.getState().setPrimaryClientId(primaryClientId);
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
      const mcState = useMultiClientStore.getState();
      const { activeSessionId, sessionStates } = get();
      if (mcState.followMode && focusClientId !== mcState.myClientId && focusSessionId !== activeSessionId && sessionStates[focusSessionId]) {
        get().switchSession(focusSessionId);
      }
      break;
    }

    case 'directory_listing': {
      const cb = getCallback('directoryListing');
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
      const fileBrowserCb = getCallback('fileBrowser');
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
      const fileContentCb = getCallback('fileContent');
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

    case 'write_file_result': {
      const fileWriteCb = getCallback('fileWrite');
      if (fileWriteCb) {
        fileWriteCb({
          path: typeof msg.path === 'string' ? msg.path : null,
          error: typeof msg.error === 'string' ? msg.error : null,
        });
      }
      break;
    }

    case 'diff_result': {
      const diffCb = getCallback('diff');
      if (diffCb) {
        diffCb({
          files: Array.isArray(msg.files) ? msg.files as DiffFile[] : [],
          error: typeof msg.error === 'string' ? msg.error : null,
        });
      }
      break;
    }

    case 'git_status_result': {
      const cb = getCallback('gitStatus');
      if (cb) {
        cb({
          branch: typeof msg.branch === 'string' ? msg.branch : null,
          staged: Array.isArray(msg.staged) ? msg.staged as GitFileStatus[] : [],
          unstaged: Array.isArray(msg.unstaged) ? msg.unstaged as GitFileStatus[] : [],
          untracked: Array.isArray(msg.untracked) ? msg.untracked as string[] : [],
          error: typeof msg.error === 'string' ? msg.error : null,
        });
      }
      break;
    }

    case 'git_branches_result': {
      const cb = getCallback('gitBranches');
      if (cb) {
        cb({
          branches: Array.isArray(msg.branches) ? msg.branches as GitBranch[] : [],
          currentBranch: typeof msg.currentBranch === 'string' ? msg.currentBranch : null,
          error: typeof msg.error === 'string' ? msg.error : null,
        });
      }
      break;
    }

    case 'git_stage_result':
    case 'git_unstage_result': {
      const cb = getCallback('gitStage');
      if (cb) {
        cb({ error: typeof msg.error === 'string' ? msg.error : null });
      }
      break;
    }

    case 'git_commit_result': {
      const cb = getCallback('gitCommit');
      if (cb) {
        cb({
          hash: typeof msg.hash === 'string' ? msg.hash : null,
          message: typeof msg.message === 'string' ? msg.message : null,
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

    case 'agent_list': {
      const agentSid = get().activeSessionId;
      if (msg.sessionId && agentSid && msg.sessionId !== agentSid) break;
      if (Array.isArray(msg.agents)) {
        set({ customAgents: msg.agents as CustomAgent[] });
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

    case 'checkpoint_restored': {
      // Server created a new session at the checkpoint state.
      // Auto-switch to it; session_list update follows from server.
      const rawNewSid = msg.newSessionId;
      const restoredNewSid =
        typeof rawNewSid === 'string' ? rawNewSid.trim() : '';
      if (restoredNewSid.length > 0) {
        get().switchSession(restoredNewSid, { serverNotify: false, haptic: false });
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
      const totalCost = typeof msg.totalCost === 'number' ? msg.totalCost : null;
      const budget = typeof msg.budget === 'number' ? msg.budget : null;
      const costTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (costTargetId && get().sessionStates[costTargetId]) {
        updateSession(costTargetId, () => ({ sessionCost }));
      }
      set({ totalCost, costBudget: budget });
      break;
    }

    case 'budget_warning': {
      const warningMessage = typeof msg.message === 'string' ? msg.message : 'Approaching cost budget limit';
      Alert.alert('Budget Warning', warningMessage);
      const budgetWarnMsg: ChatMessage = {
        id: nextMessageId('system'),
        type: 'system',
        content: warningMessage,
        timestamp: Date.now(),
      };
      const budgetWarnTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (budgetWarnTargetId && get().sessionStates[budgetWarnTargetId]) {
        updateSession(budgetWarnTargetId, (ss) => ({
          messages: [...ss.messages, budgetWarnMsg],
        }));
      } else {
        get().addMessage(budgetWarnMsg);
      }
      break;
    }

    case 'budget_exceeded': {
      const exceededMessage = typeof msg.message === 'string' ? msg.message : 'Cost budget exceeded';
      const budgetExceededTargetId = (msg.sessionId as string) || get().activeSessionId;
      // Show alert with "Resume" option to override the pause
      Alert.alert('Budget Exceeded', `${exceededMessage}\n\nNew messages are paused.`, [
        { text: 'OK', style: 'cancel' },
        {
          text: 'Resume',
          onPress: () => {
            const socket = get().socket;
            if (socket && budgetExceededTargetId) {
              wsSend(socket, { type: 'resume_budget', sessionId: budgetExceededTargetId });
            }
          },
        },
      ]);
      const budgetExceededMsg: ChatMessage = {
        id: nextMessageId('system'),
        type: 'system',
        content: `${exceededMessage} — session paused`,
        timestamp: Date.now(),
      };
      if (budgetExceededTargetId && get().sessionStates[budgetExceededTargetId]) {
        updateSession(budgetExceededTargetId, (ss) => ({
          messages: [...ss.messages, budgetExceededMsg],
        }));
      } else {
        get().addMessage(budgetExceededMsg);
      }
      break;
    }

    case 'budget_resumed': {
      const resumedSessionId = (msg.sessionId as string) || get().activeSessionId;
      const resumedMsg: ChatMessage = {
        id: nextMessageId('system'),
        type: 'system',
        content: 'Cost budget override — session resumed',
        timestamp: Date.now(),
      };
      if (resumedSessionId && get().sessionStates[resumedSessionId]) {
        updateSession(resumedSessionId, (ss) => ({
          messages: [...ss.messages, resumedMsg],
        }));
      } else {
        get().addMessage(resumedMsg);
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

    case 'web_feature_status': {
      set({
        webFeatures: {
          available: !!msg.available,
          remote: !!msg.remote,
          teleport: !!msg.teleport,
        },
      });
      break;
    }

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

    case 'web_task_list': {
      const tasks = Array.isArray(msg.tasks) ? (msg.tasks as WebTask[]) : [];
      set({ webTasks: tasks });
      break;
    }

    case 'conversations_list': {
      const conversations = Array.isArray(msg.conversations) ? (msg.conversations as ConversationSummary[]) : [];
      set({ conversationHistory: conversations, conversationHistoryLoading: false, conversationHistoryError: null });
      break;
    }

    case 'search_results': {
      const results = Array.isArray(msg.results) ? msg.results : [];
      const msgQuery = typeof msg.query === 'string' ? msg.query : null;
      const currentQuery = (get() as ConnectionState).searchQuery;
      if (msgQuery !== null && currentQuery && msgQuery !== currentQuery) {
        break; // Stale response for an older query — ignore
      }
      set({ searchResults: results, searchLoading: false, searchError: null });
      break;
    }

    case 'server_error': {
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

      const serverError: ServerError = {
        id: nextMessageId('err'),
        category,
        message,
        recoverable,
        timestamp: Date.now(),
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
      // Token was rotated on the server — the new token is NOT sent over the wire.
      // The client must re-authenticate (re-scan QR or re-enter token).
      console.log('[ws] Server token rotated — re-authentication required');
      // Clear saved connection so stale token isn't reused
      void get().clearSavedConnection();
      // Disconnect the socket (sends user back to ConnectScreen)
      get().disconnect();
      // Alert the user after a brief delay (so disconnect state settles first)
      setTimeout(() => {
        Alert.alert(
          'Token Rotated',
          'The server API token has been rotated. Please re-scan the QR code or re-enter the new token to reconnect.',
          [{ text: 'OK' }],
        );
      }, 100);
      break;
    }

    case 'session_warning': {
      const warnSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      const sessionName = typeof msg.name === 'string' ? msg.name : 'Session';
      const remainingMs = typeof msg.remainingMs === 'number' ? msg.remainingMs : 120000;

      // Set timeout warning state for the banner UI
      set({
        timeoutWarning: {
          sessionId: warnSessionId || '',
          sessionName,
          remainingMs,
          receivedAt: Date.now(),
        },
      });
      break;
    }

    case 'session_timeout': {
      const timeoutSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      const name = typeof msg.name === 'string' ? msg.name : 'Unknown';
      Alert.alert('Session Closed', `Session "${name}" was closed due to inactivity.`);
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
