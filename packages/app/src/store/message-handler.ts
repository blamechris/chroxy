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
  parseUserInputMessage,
  resolveStreamId,
  resolveSessionId,
  isReplayDuplicate,
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
  handleCheckpointRestored as sharedCheckpointRestored,
  handleError as sharedError,
  handleSessionError as sharedSessionError,
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
  handleDirectoryListing as sharedDirectoryListing,
  handleFileListing as sharedFileListing,
  handleFileContent as sharedFileContent,
  handleWriteFileResult as sharedWriteFileResult,
  handleSessionList as sharedSessionList,
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
  handleAvailableModels as sharedAvailableModels,
  handleMcpServers as sharedMcpServers,
  handleCostUpdate as sharedCostUpdate,
} from '@chroxy/store-core';
import { PROTOCOL_VERSION } from '@chroxy/protocol';
import { hapticSuccess } from '../utils/haptics';
import type {
  ChatMessage,
  Checkpoint,
  ConnectedClient,
  ConnectionContext,
  ConnectionState,
  CustomAgent,
  DiffFile,
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
  SearchResult,
  ToolResultImage,
  WebTask,
  GitFileStatus,
  GitBranch,
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
  receivingHistoryReplay: boolean;
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

  // Message queue
  messageQueue: QueuedMessage[];
}

function createDefaultContext(): MessageHandlerContext {
  return {
    ...INITIAL_ENCRYPTION_CONTEXT,
    receivingHistoryReplay: false,
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
  _ctx.receivingHistoryReplay = false;
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
/** Max session IDs per subscribe_sessions message (must match server SubscribeSessionsSchema .max(20)) */
export const SUBSCRIBE_SESSIONS_CHUNK_SIZE = 20;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 5_000;
const EWMA_ALPHA = 0.3; // Weight for new samples (higher = more responsive)

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

function _onPong(): void {
  if (_ctx.pongTimeout) { clearTimeout(_ctx.pongTimeout); _ctx.pongTimeout = null; }
  // Measure RTT and update connection quality using EWMA for stability
  if (_ctx.lastPingSentAt > 0) {
    const rttMs = Date.now() - _ctx.lastPingSentAt;
    _ctx.lastPingSentAt = 0;
    // EWMA: smoothed = alpha * new + (1 - alpha) * prev (first sample bootstraps)
    _ctx.ewmaRtt = _ctx.ewmaRtt === null ? rttMs : EWMA_ALPHA * rttMs + (1 - EWMA_ALPHA) * _ctx.ewmaRtt;
    const smoothed = Math.round(_ctx.ewmaRtt);
    const quality: 'good' | 'fair' | 'poor' = smoothed < 200 ? 'good' : smoothed < 500 ? 'fair' : 'poor';
    useConnectionLifecycleStore.getState().setConnectionQuality(smoothed, quality);
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
      const updatedMessages = sessionState.messages.map((m) => {
        const d = deltas.get(m.id);
        return d ? { ...m, content: m.content + d } : m;
      });
      newSessionStates = {
        ...newSessionStates,
        [sessionId]: { ...sessionState, messages: updatedMessages },
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
        const updatedMessages = ss.messages.map((m) => {
          const d = deltas.get(m.id);
          return d ? { ...m, content: m.content + d } : m;
        });
        newSessionStates = {
          ...newSessionStates,
          [activeId]: { ...ss, messages: updatedMessages },
        };
        getStore().setState({ sessionStates: newSessionStates });
        flatUpdated = true;
      }
    }
  }

  if (!flatUpdated) {
    getStore().setState({ sessionStates: newSessionStates });
  }
}

export function clearDeltaBuffers(): void {
  if (_ctx.deltaFlushTimer) {
    clearTimeout(_ctx.deltaFlushTimer);
    _ctx.deltaFlushTimer = null;
  }
  _ctx.pendingDeltas.clear();
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
      _ctx.receivingHistoryReplay = false;
      _ctx.isSessionSwitchReplay = false;
      _ctx.pendingSwitchSessionId = null;
      if (!ctx.isReconnect) hapticSuccess();
      // Track this URL as successfully connected
      lastConnectedUrl = ctx.url;
      // Extract server context fields via shared handler (#3102).
      // The shared handler accepts both 'cli' and 'terminal'; the app has no
      // terminal view so we narrow 'terminal' to null (matches prior inline
      // `msg.serverMode === 'cli' ? 'cli' : null` behaviour).
      const authPayload = sharedAuthOk(msg);
      const authServerMode: 'cli' | null = authPayload.serverMode === 'cli' ? 'cli' : null;
      const authSessionCwd = authPayload.sessionCwd;
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
      // If server provided a sessionToken (via pairing), use it for future auth
      const effectiveToken = typeof msg.sessionToken === 'string' ? msg.sessionToken : ctx.token;
      const connectedState = {
        viewingCachedSession: false,
        socket: ctx.socket,
        claudeReady: false,
        streamingMessageId: null,
        myClientId: myClientId, // kept for backward compat; canonical source is useMultiClientStore
        connectedClients: clients, // kept for backward compat; canonical source is useMultiClientStore
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
      // Sync connection lifecycle store
      useConnectionLifecycleStore.getState().setConnectionPhase('connected');
      useConnectionLifecycleStore.getState().setConnectionDetails(ctx.url, effectiveToken);
      useConnectionLifecycleStore.getState().setServerInfo({
        serverMode: authServerMode,
        serverVersion: authServerVersion,
        latestVersion: authLatestVersion,
        serverCommit: authServerCommit,
        serverProtocolVersion: authProtocolVersion,
        sessionCwd: authSessionCwd,
      });
      useConnectionLifecycleStore.getState().setConnectionError(null, 0);
      useConnectionLifecycleStore.getState().setUserDisconnected(false);

      // Start client-side heartbeat for dead connection detection
      startHeartbeat(ctx.socket);

      // Initiate key exchange if server requires encryption
      if (msg.encryption === 'required') {
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
      }
      // Save for quick reconnect (use effectiveToken for pairing flow)
      saveConnection(ctx.url, effectiveToken);
      useConnectionLifecycleStore.getState().setSavedConnection({ url: ctx.url, token: effectiveToken });
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

    case 'server_mode': {
      // App has no terminal view, so 'terminal' is treated as null (matches
      // prior inline behaviour `msg.mode === 'cli' ? 'cli' : null`).
      const { mode } = sharedServerMode(msg);
      const newServerMode: 'cli' | null = mode === 'cli' ? 'cli' : null;
      useConnectionLifecycleStore.getState().setServerInfo({ serverMode: newServerMode });
      // Force chat view in CLI mode (no terminal available)
      if (mode === 'cli' && get().viewMode === 'terminal') {
        set({ viewMode: 'chat' });
      }
      break;
    }

    // --- Multi-session messages ---

    case 'session_list': {
      const sessionList = sharedSessionList(msg);
      if (sessionList) {
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
      if (!switched) break;
      const { newSessionId: sessionId, conversationId: switchConvId } = switched;
      // Only treat as session-switch replay if the user explicitly initiated it
      // (auth-triggered session_switched on reconnect should use reconnect dedup)
      if (_ctx.pendingSwitchSessionId && _ctx.pendingSwitchSessionId === sessionId) {
        _ctx.isSessionSwitchReplay = true;
      }
      _ctx.pendingSwitchSessionId = null;
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

    // --- History replay ---

    case 'history_replay_start': {
      // Parser is shared via store-core; flag mutation stays at this call
      // site (module-level _ctx state, not store state).
      const { fullHistory, sessionId: replayTargetId } = sharedHistoryReplayStart(
        msg,
        get().activeSessionId,
      );
      _ctx.receivingHistoryReplay = true;
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
      break;
    }

    case 'history_replay_end':
      // Parser is shared via store-core; flag mutation stays here.
      _ctx.receivingHistoryReplay = sharedHistoryReplayEnd().receivingHistoryReplay;
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
      const parsed = parseUserInputMessage(msg, get().myClientId, get().activeSessionId);
      if (!parsed) break;
      const { sessionId: parsedSessionId, ...parsedMsg } = parsed;
      // Adopt the server's stable messageId (issue #2902) so a later replay
      // of the same entry dedups by id against this live-echo copy.
      const stableId = typeof msg.messageId === 'string' ? msg.messageId : undefined;
      const uiMsg: ChatMessage = { id: stableId || nextMessageId('user_input'), ...parsedMsg };
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
      if (msgType === 'user_input' && !_ctx.receivingHistoryReplay) break;
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      const stableMessageId = typeof msg.messageId === 'string' ? (msg.messageId as string) : undefined;
      // During any history replay, skip if an equivalent message is already in cache (dedup).
      // This prevents duplicates when the app already received messages via real-time
      // subscription before switching to the session (which triggers history replay).
      // Shared helper lives in @chroxy/store-core (#2903).
      if (_ctx.receivingHistoryReplay) {
        const cached = getSessionMessages(targetId);
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
        id: (stableMessageId && msgType === 'user_input') ? stableMessageId : nextMessageId(msgType),
        type: msgType as ChatMessage['type'],
        content: msg.content as string,
        tool: msg.tool as string | undefined,
        options: msg.options as ChatMessage['options'],
        timestamp: msg.timestamp as number,
      };
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
          const { resolvedId, remap } = resolveStreamId(existing, streamId);
          if (existing && existing.type === 'response') {
            // Reuse existing response message (reconnect replay dedup)
            return { streamingMessageId: resolvedId };
          }
          if (remap) {
            _ctx.deltaIdRemaps.set(remap.from, remap.to);
          }
          return {
            streamingMessageId: resolvedId,
            messages: [
              ...filterThinking(ss.messages),
              { id: resolvedId, type: 'response' as const, content: '', timestamp: Date.now() },
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
      if (_ctx.postPermissionSplits.has(deltaId)) {
        _ctx.postPermissionSplits.delete(deltaId);
        const newId = `${deltaId}-post-${Date.now()}`;
        _ctx.deltaIdRemaps.set(deltaId, newId);
        const newMsg: ChatMessage = {
          id: newId,
          type: 'response',
          content: '',
          timestamp: Date.now(),
        };
        const targetId = capturedSessionId;
        const effectiveSplitId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
        if (effectiveSplitId && get().sessionStates[effectiveSplitId]) {
          updateSession(effectiveSplitId, (ss) => ({
            streamingMessageId: newId,
            messages: [...ss.messages, newMsg],
          }));
        }
        deltaId = newId;
      } else if (_ctx.deltaIdRemaps.has(deltaId)) {
        deltaId = _ctx.deltaIdRemaps.get(deltaId)!;
      } else {
        // Defensive: server reuses messageId for tool_start and the post-tool
        // stream_start. If stream_start was dropped or hasn't registered the
        // remap yet (e.g., session not in store at the time), the delta would
        // otherwise concatenate onto the tool_use bubble. Detect that here and
        // route to a suffixed response id, lazy-creating the bubble.
        const targetId = capturedSessionId;
        const effectiveDeltaId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
        if (effectiveDeltaId && get().sessionStates[effectiveDeltaId]) {
          const ss = get().sessionStates[effectiveDeltaId];
          const existing = ss.messages.find((m) => m.id === deltaId);
          if (existing && existing.type !== 'response') {
            const suffixed = `${deltaId}-response`;
            _ctx.deltaIdRemaps.set(deltaId, suffixed);
            if (!ss.messages.some((m) => m.id === suffixed)) {
              updateSession(effectiveDeltaId, (s) => ({
                streamingMessageId: suffixed,
                messages: [
                  ...s.messages,
                  { id: suffixed, type: 'response' as const, content: '', timestamp: Date.now() },
                ],
              }));
            }
            deltaId = suffixed;
          }
        }
      }

      const existingDelta = _ctx.pendingDeltas.get(deltaId);
      _ctx.pendingDeltas.set(deltaId, {
        sessionId: capturedSessionId,
        delta: (existingDelta?.delta || '') + (msg.delta as string),
      });
      if (!_ctx.deltaFlushTimer) {
        _ctx.deltaFlushTimer = setTimeout(flushPendingDeltas, 100);
      }
      break;
    }

    case 'stream_end':
      // Flush any buffered deltas immediately before clearing streaming state
      if (_ctx.deltaFlushTimer) {
        clearTimeout(_ctx.deltaFlushTimer);
      }
      flushPendingDeltas();
      // Clean up permission boundary split tracking
      _ctx.postPermissionSplits.delete(msg.messageId as string);
      _ctx.deltaIdRemaps.delete(msg.messageId as string);
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
          updateActiveSession((ss) => ({ streamingMessageId: null, messages: [...ss.messages] }));
        }
      }
      break;

    case 'tool_start': {
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      // Use server messageId as stable identifier for dedup (same ID on live + replay)
      const toolId = (msg.messageId as string) || nextMessageId('tool');
      // During any history replay, skip if tool already in cache (dedup by stable ID)
      if (_ctx.receivingHistoryReplay) {
        const cached = getSessionMessages(targetId);
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
      {
        const effectiveId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
        if (effectiveId && get().sessionStates[effectiveId]) {
          updateSession(effectiveId, (ss) => ({
            messages: [...ss.messages, toolMsg],
          }));
        }
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
      {
        const effectiveId = (targetId && get().sessionStates[targetId]) ? targetId : get().activeSessionId;
        if (effectiveId && get().sessionStates[effectiveId]) {
          updateSession(effectiveId, patchResult);
        }
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

    case 'raw':
      get().appendTerminalData(msg.data as string);
      useTerminalStore.getState().appendTerminalData(msg.data as string);
      break;

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

    case 'raw_background':
      get().appendTerminalData(msg.data as string);
      useTerminalStore.getState().appendTerminalData(msg.data as string);
      break;

    case 'permission_request': {
      const permPayload = sharedPermissionRequest(msg);
      // Skip malformed messages with missing/non-string requestId — without
      // this, we'd insert a prompt with `requestId === null` (the handler
      // contract) and the cast on the next line would mask the issue.
      if (!permPayload.requestId) break;
      // Split streaming response at permission boundary (#554)
      {
        const permTargetId = permPayload.sessionId || get().activeSessionId;
        const permSs = permTargetId ? get().sessionStates[permTargetId] : null;
        const currentStreamId = permSs ? permSs.streamingMessageId : null;
        if (currentStreamId && currentStreamId !== 'pending') {
          if (_ctx.deltaFlushTimer) {
            clearTimeout(_ctx.deltaFlushTimer);
          }
          flushPendingDeltas();
          let serverStreamId = currentStreamId;
          for (const [origId, remappedId] of _ctx.deltaIdRemaps) {
            if (remappedId === currentStreamId) {
              serverStreamId = origId;
              break;
            }
          }
          _ctx.postPermissionSplits.add(serverStreamId);
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
          // Fall back to `undefined` interpolation when description is missing
          // to match the prior `${msg.tool}: ${msg.description}` cast (avoids a
          // visible "null" appearing in the prompt content).
          content: permPayload.tool
            ? `${permPayload.tool}: ${permPayload.description ?? undefined}`
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
      // Ignore structured startup phase events (phase field) — only the dashboard uses these
      if (typeof msg.phase === 'string') break;

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
      const shutdownSince = Date.now();
      set({
        shutdownReason: reason,
        restartEtaMs: eta,
        restartingSince: shutdownSince,
      });
      useNotificationStore.getState().setShutdown(reason, eta, shutdownSince);
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
        diffCb({
          files: payload.files as DiffFile[],
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
          staged: payload.staged as GitFileStatus[],
          unstaged: payload.unstaged as GitFileStatus[],
          untracked: payload.untracked as string[],
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
          branches: payload.branches as GitBranch[],
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
          (p): p is { name: string; capabilities?: unknown } =>
            !!p &&
            typeof p === 'object' &&
            typeof (p as { name?: unknown }).name === 'string',
        )
        .map((p) => {
          const entry: ProviderInfo = { name: p.name };
          if (p.capabilities && typeof p.capabilities === 'object' && !Array.isArray(p.capabilities)) {
            entry.capabilities = p.capabilities as ProviderInfo['capabilities'];
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
      // History is preserved on disk. Full UI (retry button, needs-attention
      // marker) is a follow-up; for now just surface via console.
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
      const wf = {
        available: !!msg.available,
        remote: !!msg.remote,
        teleport: !!msg.teleport,
      };
      set({ webFeatures: wf });
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
        const errMessage = (msg.message as string) || 'Unknown error';
        // Update task status to failed
        set((state: ConnectionState) => ({
          webTasks: state.webTasks.map((t) =>
            t.taskId === errTaskId
              ? { ...t, status: 'failed' as const, error: errMessage, updatedAt: Date.now() }
              : t,
          ),
        }));
      }
      // For bound-session mismatches, surface the same actionable Alert used
      // by session_error (#2944). When boundSessionName is present the user
      // needs to know why the action was rejected and how to fix it.
      if (
        msg.code === 'SESSION_TOKEN_MISMATCH' &&
        typeof msg.boundSessionName === 'string' &&
        msg.boundSessionName.length > 0
      ) {
        showBoundSessionMismatchAlert(
          `This device is paired to session "${msg.boundSessionName}" and can only perform web tasks in that session. To use other sessions, disconnect and scan a fresh QR code from the desktop.`,
        );
        break;
      }
      // Otherwise show the error as a system message in chat
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
      // Parser shared via store-core; app-only state mirroring (loading/error
      // flags + useConversationStore) stays here.
      const { conversations } = sharedConversationsList(msg);
      set({ conversationHistory: conversations, conversationHistoryLoading: false, conversationHistoryError: null });
      useConversationStore.getState().setConversationHistory(conversations);
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
      useConversationStore.getState().setSearchResults(results as SearchResult[], currentQuery);
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
      useNotificationStore.getState().addServerError(serverError);
      const errorMsg: ChatMessage = {
        id: nextMessageId('err'),
        type: 'error',
        content: serverError.message,
        timestamp: Date.now(),
      };
      const activeErrId = get().activeSessionId;
      updateActiveSession((ss) => ({
        messages: filterThinking([...ss.messages, errorMsg]),
        streamingMessageId: null,
      }));
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
      const newToken = typeof msg.token === 'string' ? msg.token : null;
      if (newToken) {
        // Server sent the new token — update stored credentials seamlessly
        console.log('[ws] Server token rotated — updating stored token');
        saveConnection(ctx.url, newToken);
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
      const { code: errCode, message: errMsg, requestId: errRequestId } = sharedError(msg);
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
            Alert.alert(
              'Permission Mode Unavailable',
              errMsg || 'This provider does not support permission mode switching.',
            );
            break;
          }
          // Other error codes targeting the same in-flight request still
          // need to surface — fall through to the generic alert below so
          // the user knows the mode change failed.
        }
      }

      Alert.alert('Server Error', errMsg);
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
