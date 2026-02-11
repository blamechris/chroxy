import { create } from 'zustand';
import { Alert, AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { registerForPushNotifications } from '../notifications';

const STORAGE_KEY_URL = 'chroxy_last_url';
const STORAGE_KEY_TOKEN = 'chroxy_last_token';
const STORAGE_KEY_INPUT_SETTINGS = 'chroxy_input_settings';

/** Delay before auto-reconnecting after an unexpected socket close (ms) */
const AUTO_RECONNECT_DELAY = 1500;
/** Delay before reconnecting after a WebSocket error (ms) */
const ERROR_RECONNECT_DELAY = 2000;

/** Strip ANSI escape codes for plain text display */
export function stripAnsi(str: string): string {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07?|\x1b[()#][A-Z0-2]|\x1b[A-Za-z]|\x9b[0-9;?]*[A-Za-z~]/g,
    '',
  );
}

/** Filter out thinking placeholder messages */
export function filterThinking(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.id !== 'thinking');
}

/** Register push notification token with the server */
async function registerPushToken(socket: WebSocket): Promise<void> {
  try {
    const token = await registerForPushNotifications();
    if (token && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'register_push_token', token }));
      console.log('[push] Registered push token with server');
    }
  } catch (err) {
    console.log('[push] Push registration skipped:', err);
  }
}

export interface ChatMessage {
  id: string;
  type: 'response' | 'user_input' | 'tool_use' | 'thinking' | 'prompt' | 'error' | 'system';
  content: string;
  tool?: string;
  options?: { label: string; value: string }[];
  requestId?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  answered?: string;
  timestamp: number;
}

interface SavedConnection {
  url: string;
  token: string;
}

export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface ClaudeStatus {
  cost: number;
  model: string;
  messageCount: number;
  contextTokens: string;
  contextPercent: number;
  compactPercent: number | null;
}

interface InputSettings {
  chatEnterToSend: boolean;
  terminalEnterToSend: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  fullId: string;
}

export interface SessionInfo {
  sessionId: string;
  name: string;
  cwd: string;
  type: 'cli' | 'pty';
  hasTerminal: boolean;
  model: string | null;
  permissionMode: string | null;
  isBusy: boolean;
  createdAt: number;
}

export interface DiscoveredSession {
  sessionName: string;
  cwd: string;
  pid: number;
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

export interface DirectoryListing {
  path: string | null;
  parentPath: string | null;
  entries: DirectoryEntry[];
  error: string | null;
}

export interface AgentInfo {
  toolUseId: string;
  description: string;
  startedAt: number;
}

export interface ConnectedClient {
  clientId: string;
  deviceName: string | null;
  deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown';
  platform: string;
  isSelf: boolean;
}

export type SessionHealth = 'healthy' | 'crashed';

export interface SessionState {
  messages: ChatMessage[];
  streamingMessageId: string | null;
  claudeReady: boolean;
  activeModel: string | null;
  permissionMode: string | null;
  contextUsage: ContextUsage | null;
  lastResultCost: number | null;
  lastResultDuration: number | null;
  isIdle: boolean;
  health: SessionHealth;
  activeAgents: AgentInfo[];
  isPlanPending: boolean;
  planAllowedPrompts: { tool: string; prompt: string }[];
  primaryClientId: string | null;
}

export interface ServerError {
  id: string;
  category: 'tunnel' | 'session' | 'permission' | 'general';
  message: string;
  recoverable: boolean;
  timestamp: number;
}

export type ConnectionPhase =
  | 'disconnected'        // Not connected, no auto-reconnect
  | 'connecting'          // Initial connection attempt
  | 'connected'           // WebSocket open + authenticated
  | 'reconnecting'        // Auto-reconnecting after unexpected disconnect
  | 'server_restarting';  // Health check returns { status: 'restarting' }

export const selectShowSession = (s: ConnectionState): boolean =>
  s.connectionPhase !== 'disconnected';

export function createEmptySessionState(): SessionState {
  return {
    messages: [],
    streamingMessageId: null,
    claudeReady: false,
    activeModel: null,
    permissionMode: null,
    contextUsage: null,
    lastResultCost: null,
    lastResultDuration: null,
    isIdle: true,
    health: 'healthy',
    activeAgents: [],
    isPlanPending: false,
    planAllowedPrompts: [],
    primaryClientId: null,
  };
}

interface ConnectionState {
  // Connection
  connectionPhase: ConnectionPhase;
  wsUrl: string | null;
  apiToken: string | null;
  socket: WebSocket | null;

  // Saved connection for quick reconnect
  savedConnection: SavedConnection | null;

  // Server mode: 'cli' (headless) or 'terminal' (PTY/tmux)
  serverMode: 'cli' | 'terminal' | null;

  // Server context (from auth_ok)
  sessionCwd: string | null;
  serverVersion: string | null;
  latestVersion: string | null;
  serverCommit: string | null;

  // Multi-session state
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStates: Record<string, SessionState>;

  // Legacy flat state (used when server doesn't send session_list, i.e. PTY mode)
  claudeReady: boolean;
  streamingMessageId: string | null;
  activeModel: string | null;
  permissionMode: string | null;
  contextUsage: ContextUsage | null;
  lastResultCost: number | null;
  lastResultDuration: number | null;
  isIdle: boolean;
  messages: ChatMessage[];

  // Available models from server (CLI mode)
  availableModels: ModelInfo[];

  // Available permission modes from server (CLI mode)
  availablePermissionModes: { id: string; label: string }[];

  // Discovered host tmux sessions (from discover_sessions)
  discoveredSessions: DiscoveredSession[] | null;

  // Claude Code status bar metadata (PTY mode)
  claudeStatus: ClaudeStatus | null;

  // Connected clients (multi-client awareness)
  myClientId: string | null;
  connectedClients: ConnectedClient[];
  primaryClientId: string | null;

  // Server errors forwarded over WebSocket (last 10)
  serverErrors: ServerError[];

  // Pending auto permission mode confirmation from server
  pendingPermissionConfirm: { mode: string; warning: string } | null;

  // Directory listing callback for file browser
  _directoryListingCallback: ((listing: DirectoryListing) => void) | null;

  // View mode
  viewMode: 'chat' | 'terminal';

  // Input settings
  inputSettings: InputSettings;

  // Raw terminal output buffer (ANSI-stripped, for plain text fallback)
  terminalBuffer: string;

  // Raw terminal buffer with ANSI codes intact (for xterm.js replay on view switch)
  terminalRawBuffer: string;

  // Imperative write callback for xterm.js (bypasses React state for performance)
  _terminalWriteCallback: ((data: string) => void) | null;

  // Actions
  connect: (url: string, token: string, options?: { silent?: boolean; _retryCount?: number }) => void;
  disconnect: () => void;
  loadSavedConnection: () => Promise<void>;
  clearSavedConnection: () => Promise<void>;
  setViewMode: (mode: 'chat' | 'terminal') => void;
  addMessage: (message: ChatMessage) => void;
  addUserMessage: (text: string) => void;
  appendTerminalData: (data: string) => void;
  clearTerminalBuffer: () => void;
  setTerminalWriteCallback: (cb: ((data: string) => void) | null) => void;
  updateInputSettings: (settings: Partial<InputSettings>) => void;
  sendInput: (input: string) => 'sent' | 'queued' | false;
  sendInterrupt: () => 'sent' | 'queued' | false;
  sendPermissionResponse: (requestId: string, decision: string) => 'sent' | 'queued' | false;
  sendUserQuestionResponse: (answer: string) => 'sent' | 'queued' | false;
  markPromptAnswered: (messageId: string, answer: string) => void;
  setModel: (model: string) => void;
  setPermissionMode: (mode: string) => void;
  confirmPermissionMode: (mode: string) => void;
  cancelPermissionConfirm: () => void;
  resize: (cols: number, rows: number) => void;

  // Directory listing
  setDirectoryListingCallback: (cb: ((listing: DirectoryListing) => void) | null) => void;
  requestDirectoryListing: (path?: string) => void;

  // Session actions
  switchSession: (sessionId: string) => void;
  createSession: (name: string, cwd?: string) => void;
  destroySession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  discoverSessions: () => void;
  attachSession: (tmuxSession: string, name?: string) => void;
  forgetSession: () => void;

  // Plan mode actions
  clearPlanState: () => void;

  // Server error actions
  dismissServerError: (id: string) => void;

  // Convenience accessor
  getActiveSessionState: () => SessionState;
}

// Stable device ID persisted across sessions
const STORAGE_KEY_DEVICE_ID = 'chroxy_device_id';
let _cachedDeviceId: string | null = null;

async function getDeviceId(): Promise<string> {
  if (_cachedDeviceId) return _cachedDeviceId;
  try {
    const stored = await SecureStore.getItemAsync(STORAGE_KEY_DEVICE_ID);
    if (stored) {
      _cachedDeviceId = stored;
      return stored;
    }
  } catch {
    // Storage not available
  }
  // Generate a new device ID
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  _cachedDeviceId = id;
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_DEVICE_ID, id);
  } catch {
    // Storage not available
  }
  return id;
}

function getDeviceInfo(): { deviceName: string | null; deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown'; platform: string } {
  const deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown' =
    Device.deviceType === Device.DeviceType.PHONE ? 'phone' :
    Device.deviceType === Device.DeviceType.TABLET ? 'tablet' :
    Device.deviceType === Device.DeviceType.DESKTOP ? 'desktop' : 'unknown';
  return {
    deviceName: Device.deviceName || null,
    deviceType,
    platform: Platform.OS,
  };
}

async function saveConnection(url: string, token: string) {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_URL, url);
    await SecureStore.setItemAsync(STORAGE_KEY_TOKEN, token);
  } catch {
    // Storage not available (e.g. Expo Go limitations)
  }
}

async function loadConnection(): Promise<SavedConnection | null> {
  try {
    const url = await SecureStore.getItemAsync(STORAGE_KEY_URL);
    const token = await SecureStore.getItemAsync(STORAGE_KEY_TOKEN);
    if (url && token) return { url, token };
  } catch {
    // Storage not available
  }
  return null;
}

async function clearConnection() {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY_URL);
    await SecureStore.deleteItemAsync(STORAGE_KEY_TOKEN);
  } catch {
    // Storage not available
  }
}

/** Context captured from connect() closure for use by the extracted handleMessage(). */
interface ConnectionContext {
  url: string;
  token: string;
  isReconnect: boolean;
  silent: boolean;
  socket: WebSocket;
}
let _connectionContext: ConnectionContext | null = null;

// Monotonically increasing counter to cancel stale retry chains
let connectionAttemptId = 0;
// Tracks which attempt was user-disconnected (replaces boolean flag to avoid
// stale-socket race: disconnect → reconnect → old socket onclose fires)
let disconnectedAttemptId = -1;
// Track the last successfully connected URL to detect reconnects reliably
let lastConnectedUrl: string | null = null;

/**
 * Message ID Convention
 *
 * Message IDs are used to uniquely identify and track messages in the chat history.
 * The default format produced by nextMessageId is: `{prefix}-{counter}-{timestamp}`.
 *
 * Prefixes used with nextMessageId:
 * - 'user'        — User-sent messages
 * - messageType   — Server-forwarded messages where the prefix is the messageType
 *                    (e.g. 'response', 'error', 'prompt', etc.)
 * - 'tool'        — Tool use messages
 * - 'perm'        — Permission request prompts from Claude Code (tool permission dialogs)
 * - 'msg'         — Generic messages (default when no prefix is provided)
 *
 * Special IDs (not produced by nextMessageId):
 * - 'thinking'    — Ephemeral thinking placeholder (singleton, no counter/timestamp; not
 *                    persisted/filtered from transcript export, but rendered in the chat UI)
 *
 * Note on ID assignment:
 * - Most locally-created and non-streaming messages use nextMessageId(prefix).
 * - Messages that already include a server-assigned ID (e.g., streaming events such as
 *   `stream_start`/`stream_delta`, or history replay messages) keep that server-provided
 *   messageId instead of generating a new one.
 *
 * Example ID formats:
 * - 'user-1-1700000000000'
 * - 'response-2-1700000001000'
 * - 'tool-3-1700000002000'
 * - 'perm-4-1700000003000'
 */

// Monotonic message ID counter (avoids Math.random() collisions)
let messageIdCounter = 0;
export function nextMessageId(prefix = 'msg'): string {
  return `${prefix}-${++messageIdCounter}-${Date.now()}`;
}

// Flag: currently receiving history replay from server — skip adding messages
// if local state already has them (prevents duplicates on reconnect)
let _receivingHistoryReplay = false;
// Flag: replay is from a session switch (cache may be stale) vs reconnect (cache is fresh)
let _isSessionSwitchReplay = false;
// Track user-initiated switch_session so we can distinguish it from auth-triggered session_switched
let _pendingSwitchSessionId: string | null = null;

// Terminal write batching: coalesce rapid writes into single injectJavaScript calls (~20/sec max)
let _pendingTerminalWrites = '';
let _terminalWriteTimer: ReturnType<typeof setTimeout> | null = null;

function _flushTerminalWrites() {
  _terminalWriteTimer = null;
  if (_pendingTerminalWrites.length === 0) return;
  const data = _pendingTerminalWrites;
  _pendingTerminalWrites = '';
  const cb = useConnectionStore.getState()._terminalWriteCallback;
  if (cb) cb(data);
}

// Delta batching: accumulate stream deltas and flush to state periodically
// to reduce re-renders (dozens of deltas/sec → one state update per 100ms).
// Keyed by sessionId so deltas are flushed to the correct session even if
// the user switches sessions during the 100ms batching window.
const pendingDeltas = new Map<string, { sessionId: string | null; delta: string }>();
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

// Message queue: buffer messages while disconnected, drain on reconnect
interface QueuedMessage {
  type: string;
  payload: unknown;
  queuedAt: number;
  maxAge: number;
}

const QUEUE_TTLS: Record<string, number> = {
  input: 60_000,
  interrupt: 5_000,
  permission_response: 300_000,
  user_question_response: 60_000,
};
const QUEUE_MAX_SIZE = 10;
const QUEUE_EXCLUDED = new Set(['set_model', 'set_permission_mode', 'mode', 'resize']);
const messageQueue: QueuedMessage[] = [];

function enqueueMessage(type: string, payload: unknown): 'queued' | false {
  if (QUEUE_EXCLUDED.has(type)) return false;
  const maxAge = QUEUE_TTLS[type];
  if (!maxAge) return false; // Unknown message type — don't queue
  if (messageQueue.length >= QUEUE_MAX_SIZE) return false;
  messageQueue.push({ type, payload, queuedAt: Date.now(), maxAge });
  console.log(`[queue] Queued ${type} (${messageQueue.length}/${QUEUE_MAX_SIZE})`);
  return 'queued';
}

/** @internal Exposed for testing only */
export const _testQueueInternals = {
  getQueue: () => messageQueue,
  enqueue: enqueueMessage,
  drain: drainMessageQueue,
  clear: () => { messageQueue.length = 0; },
};

function drainMessageQueue(socket: WebSocket) {
  if (messageQueue.length === 0) return;
  const now = Date.now();
  const valid = messageQueue.filter((m) => now - m.queuedAt < m.maxAge);
  messageQueue.length = 0;
  if (valid.length === 0) return;
  console.log(`[queue] Draining ${valid.length} queued message(s)`);
  for (const m of valid) {
    try {
      socket.send(JSON.stringify(m.payload));
    } catch (err) {
      console.warn(`[queue] Failed to send queued ${m.type}:`, err);
    }
  }
}

function flushPendingDeltas() {
  deltaFlushTimer = null;
  if (pendingDeltas.size === 0) return;
  const updates = new Map(pendingDeltas);
  pendingDeltas.clear();

  const state = useConnectionStore.getState();

  // Group deltas by session
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
      // Sync flat messages if this is the active session
      if (sessionId === state.activeSessionId) {
        useConnectionStore.setState({ sessionStates: newSessionStates, messages: updatedMessages });
        flatUpdated = true;
      }
    } else {
      // Legacy flat mode or no session
      useConnectionStore.setState((s) => ({
        messages: s.messages.map((m) => {
          const d = deltas.get(m.id);
          return d ? { ...m, content: m.content + d } : m;
        }),
      }));
      flatUpdated = true;
    }
  }

  if (!flatUpdated) {
    useConnectionStore.setState({ sessionStates: newSessionStates });
  }
}

/**
 * Update any session's state by ID. Syncs to flat state only when the target
 * session is the currently active session (so UI reads remain correct).
 */
function updateSession(sessionId: string, updater: (session: SessionState) => Partial<SessionState>) {
  const state = useConnectionStore.getState();
  if (!state.sessionStates[sessionId]) return;

  const current = state.sessionStates[sessionId];
  const patch = updater(current);
  if (Object.keys(patch).length === 0) return;
  const updated = { ...current, ...patch };
  const newSessionStates = { ...state.sessionStates, [sessionId]: updated };

  // Sync relevant fields to flat state only for the active session
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
    useConnectionStore.setState(flatPatch);
  } else {
    useConnectionStore.setState({ sessionStates: newSessionStates });
  }
}

/** Helper to update the active session's state and sync to flat state */
function updateActiveSession(updater: (session: SessionState) => Partial<SessionState>) {
  const state = useConnectionStore.getState();
  const activeId = state.activeSessionId;
  if (activeId) updateSession(activeId, updater);
}

/**
 * Handles a parsed WebSocket message. Extracted from the socket.onmessage
 * closure so it can be tested directly with raw JSON payloads.
 *
 * Reads/writes store via useConnectionStore.getState()/setState() and
 * module-level helpers (updateSession, updateActiveSession, nextMessageId, etc).
 * The few variables that were closured in connect() are accessed via _connectionContext.
 */
function handleMessage(raw: unknown, ctxOverride?: ConnectionContext): void {
  const ctx = ctxOverride ?? _connectionContext;
  if (!ctx) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string') return;

  const get = () => useConnectionStore.getState();
  const set: (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void =
    (s) => useConnectionStore.setState(s as ConnectionState);

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
      const authServerVersion = typeof msg.serverVersion === 'string' ? msg.serverVersion : null;
      const authLatestVersion = typeof msg.latestVersion === 'string' ? msg.latestVersion : null;
      const authServerCommit = typeof msg.serverCommit === 'string' ? msg.serverCommit : null;
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

      // On reconnect, preserve messages and terminal buffer
      const connectedState = {
        connectionPhase: 'connected' as const,
        wsUrl: ctx.url,
        apiToken: ctx.token,
        socket: ctx.socket,
        claudeReady: false,
        serverMode: authServerMode,
        sessionCwd: authSessionCwd,
        serverVersion: authServerVersion,
        latestVersion: authLatestVersion,
        serverCommit: authServerCommit,
        streamingMessageId: null,
        myClientId: myClientId,
        connectedClients: clients,
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
        });
      }
      ctx.socket.send(JSON.stringify({ type: 'mode', mode: get().viewMode }));
      // Save for quick reconnect
      saveConnection(ctx.url, ctx.token);
      set({ savedConnection: { url: ctx.url, token: ctx.token } });
      // Register push token (async, non-blocking)
      void registerPushToken(ctx.socket);
      break;
    }

    case 'auth_fail':
      ctx.socket.close();
      set({ connectionPhase: 'disconnected', socket: null });
      if (!ctx.silent) {
        Alert.alert('Auth Failed', (msg.reason as string) || 'Invalid token');
      }
      break;

    case 'server_mode':
      set({ serverMode: msg.mode as 'cli' | 'terminal' });
      // Force chat view in CLI mode (no terminal available)
      if (msg.mode === 'cli' && get().viewMode === 'terminal') {
        set({ viewMode: 'chat' });
      }
      break;

    // --- Multi-session messages ---

    case 'session_list':
      if (Array.isArray(msg.sessions)) {
        set({ sessions: msg.sessions as SessionInfo[] });
      }
      break;

    case 'session_switched': {
      const sessionId = msg.sessionId as string;
      // Only treat as session-switch replay if the user explicitly initiated it
      // (auth-triggered session_switched on reconnect should use reconnect dedup)
      if (_pendingSwitchSessionId && _pendingSwitchSessionId === sessionId) {
        _isSessionSwitchReplay = true;
      }
      _pendingSwitchSessionId = null;
      set((state: ConnectionState) => {
        // Initialize session state if it doesn't exist
        const sessionStates = { ...state.sessionStates };
        if (!sessionStates[sessionId]) {
          sessionStates[sessionId] = createEmptySessionState();
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
      break;
    }

    case 'session_error': {
      const errorSessionId = (msg.sessionId as string) || get().activeSessionId;
      if (msg.category === 'crash' && errorSessionId && get().sessionStates[errorSessionId]) {
        updateSession(errorSessionId, () => ({ health: 'crashed' as const }));
      }
      if (msg.category !== 'crash') {
        Alert.alert('Session Error', (msg.message as string) || 'Unknown error');
      }
      break;
    }

    case 'discovered_sessions':
      if (Array.isArray(msg.tmux)) {
        set({ discoveredSessions: msg.tmux as DiscoveredSession[] });
        if ((msg.tmux as DiscoveredSession[]).length > 0) {
          const names = (msg.tmux as DiscoveredSession[]).map((s: DiscoveredSession) => s.sessionName).join(', ');
          const discoveryMsg: ChatMessage = {
            id: nextMessageId('discovery'),
            type: 'system',
            content: (msg.tmux as DiscoveredSession[]).length === 1
              ? `New Claude session found: ${names}. Open session picker to attach.`
              : `${(msg.tmux as DiscoveredSession[]).length} new Claude sessions found: ${names}. Open session picker to attach.`,
            timestamp: Date.now(),
          };
          const activeId = get().activeSessionId;
          if (activeId && get().sessionStates[activeId]) {
            updateActiveSession((ss) => ({
              messages: [...ss.messages, discoveryMsg],
            }));
          } else {
            get().addMessage(discoveryMsg);
          }
        }
      }
      break;

    // --- History replay ---

    case 'history_replay_start':
      _receivingHistoryReplay = true;
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
      // Note: replay is always for the active session (connect or switch).
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

    // --- Existing message handlers (now session-aware) ---

    case 'message': {
      const msgType = (msg.messageType || msg.type) as string;
      // Skip server-echoed user_input — we already show it instantly client-side
      if (msgType === 'user_input') break;
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      // During reconnect replay, skip if app already has messages (cache is fresh)
      if (_receivingHistoryReplay && !_isSessionSwitchReplay && get().messages.length > 0) break;
      // During session-switch replay, skip if an equivalent message is already in cache (dedup)
      if (_receivingHistoryReplay && _isSessionSwitchReplay) {
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
      break;
    }

    case 'stream_start': {
      const streamId = msg.messageId as string;
      const targetId = (msg.sessionId as string) || get().activeSessionId;
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, (ss) => {
          if (ss.messages.some((m) => m.id === streamId)) {
            return { streamingMessageId: streamId };
          }
          return {
            streamingMessageId: streamId,
            messages: [
              ...filterThinking(ss.messages),
              { id: streamId, type: 'response' as const, content: '', timestamp: Date.now() },
            ],
          };
        });
      } else {
        set((state: ConnectionState) => {
          if (state.messages.some((m) => m.id === streamId)) {
            return { streamingMessageId: streamId };
          }
          return {
            streamingMessageId: streamId,
            messages: [
              ...filterThinking(state.messages),
              { id: streamId, type: 'response' as const, content: '', timestamp: Date.now() },
            ],
          };
        });
      }
      break;
    }

    case 'stream_delta': {
      // Batch deltas — accumulate and flush to state periodically.
      // Use server-provided sessionId so deltas route to the correct session
      // even for background (non-active) sessions.
      const deltaId = msg.messageId as string;
      const existingDelta = pendingDeltas.get(deltaId);
      const capturedSessionId = (msg.sessionId as string) || get().activeSessionId;
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
      {
        const targetId = (msg.sessionId as string) || get().activeSessionId;
        if (targetId && get().sessionStates[targetId]) {
          updateSession(targetId, () => ({ streamingMessageId: null }));
        } else {
          set({ streamingMessageId: null });
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

    case 'result': {
      // Flush any buffered deltas before clearing streaming state (safety net
      // for when stream_end was missed — mirrors the stream_end flush logic)
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer);
      }
      flushPendingDeltas();
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
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, () => resultPatch);
      } else {
        set(resultPatch);
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
            // Accept structured {id, label, fullId} objects
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
            // Accept legacy string format for backward compatibility
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

    case 'status_update': {
      // Server filters status_update to active session only, but defend
      // against misrouted messages on the client side too.
      const statusSid = (msg.sessionId as string) || get().activeSessionId;
      if (statusSid && statusSid !== get().activeSessionId) break;
      set({
        claudeStatus: {
          cost: msg.cost as number,
          model: msg.model as string,
          messageCount: msg.messageCount as number,
          contextTokens: msg.contextTokens as string,
          contextPercent: msg.contextPercent as number,
          compactPercent: (msg.compactPercent as number) ?? null,
        },
      });
      break;
    }

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
          // Dedup: skip if agent with same toolUseId already tracked
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
          // Skip no-op update if agent wasn't tracked (e.g. duplicate event)
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

    case 'raw_background':
      // Buffer raw data even in chat mode so terminal tab is always up to date
      get().appendTerminalData(msg.data as string);
      break;

    case 'permission_request': {
      const permMsg: ChatMessage = {
        id: nextMessageId('perm'),
        type: 'prompt',
        content: msg.tool ? `${msg.tool}: ${msg.description}` : ((msg.description as string) || 'Permission required'),
        tool: msg.tool as string | undefined,
        requestId: msg.requestId as string,
        toolInput: msg.input && typeof msg.input === 'object' ? msg.input as Record<string, unknown> : undefined,
        options: [
          { label: 'Allow', value: 'allow' },
          { label: 'Deny', value: 'deny' },
          { label: 'Always Allow', value: 'allowAlways' },
        ],
        timestamp: Date.now(),
      };
      const permTargetId = (msg.sessionId as string) || get().activeSessionId;
      if (permTargetId && get().sessionStates[permTargetId]) {
        updateSession(permTargetId, (ss) => ({
          messages: [...ss.messages, permMsg],
        }));
      } else {
        get().addMessage(permMsg);
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
      break;
    }

    case 'server_status': {
      // Non-error status update (e.g., tunnel recovery notifications).
      // Global broadcast (no sessionId) — route to active session.
      const statusMessage: string =
        typeof msg.message === 'string' && (msg.message as string).trim().length > 0
          ? stripAnsi(msg.message as string)
          : 'Status update';
      // Display as a system message in the chat
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
      // Add system message
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
      const departingClient = get().connectedClients.find((c) => c.clientId === msg.clientId);
      set((state: ConnectionState) => ({
        connectedClients: state.connectedClients.filter((c) => c.clientId !== msg.clientId),
      }));
      // Add system message
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
      if (typeof primarySessionId === 'string' && get().sessionStates[primarySessionId]) {
        updateSession(primarySessionId, () => ({
          primaryClientId,
        }));
      } else if (!primarySessionId || primarySessionId === 'default') {
        // Legacy/single-session mode: store at flat state level
        set({ primaryClientId });
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

    case 'server_error': {
      // Global broadcast (no sessionId) — route to active session.
      // Validate and coerce untyped JSON fields
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
      // Surface server errors into chat stream so they're visible
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
      // Show an alert for non-recoverable errors
      if (!serverError.recoverable) {
        Alert.alert('Server Error', serverError.message);
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

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connectionPhase: 'disconnected',
  wsUrl: null,
  apiToken: null,
  socket: null,
  serverMode: null,
  sessionCwd: null,
  serverVersion: null,
  latestVersion: null,
  serverCommit: null,
  sessions: [],
  activeSessionId: null,
  sessionStates: {},
  claudeReady: false,
  streamingMessageId: null,
  activeModel: null,
  availableModels: [],
  permissionMode: null,
  availablePermissionModes: [],
  discoveredSessions: null,
  claudeStatus: null,
  myClientId: null,
  connectedClients: [],
  primaryClientId: null,
  serverErrors: [],
  pendingPermissionConfirm: null,
  _directoryListingCallback: null,
  contextUsage: null,
  lastResultCost: null,
  lastResultDuration: null,
  isIdle: true,
  inputSettings: {
    chatEnterToSend: true,
    terminalEnterToSend: false,
  },
  savedConnection: null,
  viewMode: 'chat',
  messages: [],
  terminalBuffer: '',
  terminalRawBuffer: '',
  _terminalWriteCallback: null,

  getActiveSessionState: () => {
    const { activeSessionId, sessionStates } = get();
    if (activeSessionId && sessionStates[activeSessionId]) {
      return sessionStates[activeSessionId];
    }
    // Fallback: construct from flat state
    return {
      messages: get().messages,
      streamingMessageId: get().streamingMessageId,
      claudeReady: get().claudeReady,
      activeModel: get().activeModel,
      permissionMode: get().permissionMode,
      contextUsage: get().contextUsage,
      lastResultCost: get().lastResultCost,
      lastResultDuration: get().lastResultDuration,
      isIdle: true,
      health: 'healthy' as const,
      activeAgents: [],
      isPlanPending: false,
      planAllowedPrompts: [],
      primaryClientId: null,
    };
  },

  loadSavedConnection: async () => {
    const saved = await loadConnection();
    if (saved) {
      set({ savedConnection: saved });
    }
    // Load persisted input settings
    try {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY_INPUT_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.chatEnterToSend === 'boolean' || typeof parsed.terminalEnterToSend === 'boolean') {
          set((state) => ({ inputSettings: { ...state.inputSettings, ...parsed } }));
        }
      }
    } catch {
      // Storage not available or corrupt — use defaults
    }
  },

  clearSavedConnection: async () => {
    await clearConnection();
    set({ savedConnection: null });
  },

  // Initial connection uses bounded retries (MAX_RETRIES) with exponential backoff.
  // This prevents infinite loops on bad credentials or missing servers.
  // Auto-reconnect (socket.onclose) calls connect() with _retryCount=0, resetting
  // the retry budget — intentional, since established connections should recover
  // aggressively after transient drops (tunnel blips, server restarts, etc.).
  connect: (url: string, token: string, options?: { silent?: boolean; _retryCount?: number }) => {
    const _retryCount = options?._retryCount ?? 0;
    const silent = options?.silent ?? false;
    const MAX_RETRIES = 5;
    const RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000];

    // Detect if connecting to a different server — clear old session data + queue
    const currentUrl = get().wsUrl;
    if (_retryCount === 0 && currentUrl !== null && currentUrl !== url) {
      get().forgetSession();
      messageQueue.length = 0;
    }

    // Robust reconnect detection: check if we've successfully connected to this URL before
    // This is more reliable than checking messages.length which may have been cleared
    const isReconnect = lastConnectedUrl === url;

    // New top-level connect call (not a retry) — bump attempt ID to cancel any pending retries
    if (_retryCount === 0) {
      connectionAttemptId++;
    }
    const myAttemptId = connectionAttemptId;

    // Close any existing socket first
    const { socket: existing } = get();
    if (existing) {
      existing.onclose = null;
      existing.onerror = null;
      existing.onmessage = null;
      existing.close();
    }
    const phase = isReconnect || _retryCount > 0 ? 'reconnecting' : 'connecting';
    set({ socket: null, connectionPhase: phase });

    if (_retryCount > 0) {
      console.log(`[ws] Connection attempt ${_retryCount + 1}/${MAX_RETRIES + 1}...`);
    }

    // HTTP health check before WebSocket — verify tunnel is up
    const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    fetch(httpUrl, { method: 'GET', signal: controller.signal })
      .finally(() => clearTimeout(timeoutId))
      .then(async (res) => {
        if (myAttemptId !== connectionAttemptId) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // Check if the server is in restart mode (supervisor standby)
        try {
          const body = await res.json();
          console.log('[ws] Health check response:', body.status ?? 'no status field');
          if (body.status === 'restarting') {
            console.log(`[ws] Server is restarting, will retry (attempt ${_retryCount + 1}/${MAX_RETRIES + 1})`);
            set({ connectionPhase: 'server_restarting' });
            // Retry — the server will come back
            if (_retryCount < MAX_RETRIES) {
              const delay = RETRY_DELAYS[Math.min(_retryCount, RETRY_DELAYS.length - 1)];
              setTimeout(() => {
                if (myAttemptId !== connectionAttemptId) return;
                get().connect(url, token, { silent, _retryCount: _retryCount + 1 });
              }, delay);
            }
            return;
          }
        } catch (err) {
          console.log('[ws] Health check body unreadable:', err instanceof Error ? err.message : String(err));
        }

        console.log('[ws] Health check passed, connecting WebSocket...');
        _connectWebSocket();
      })
      .catch((err) => {
        if (myAttemptId !== connectionAttemptId) return;
        console.log(`[ws] Health check failed: ${err.message}`);
        // Tunnel not ready yet — retry
        if (_retryCount < MAX_RETRIES) {
          const delay = RETRY_DELAYS[_retryCount];
          console.log(`[ws] Retrying in ${delay}ms...`);
          setTimeout(() => {
            if (myAttemptId !== connectionAttemptId) return;
            get().connect(url, token, { silent, _retryCount: _retryCount + 1 });
          }, delay);
        } else {
          set({ connectionPhase: 'disconnected' });
          if (!silent) {
            Alert.alert(
              'Connection Failed',
              'Could not reach the Chroxy server. Make sure it\'s running.',
              [
                { text: 'OK' },
                { text: 'Forget Server', style: 'destructive', onPress: () => { void get().clearSavedConnection(); } },
                { text: 'Retry', onPress: () => get().connect(url, token) },
              ],
            );
          }
        }
      });

    function _connectWebSocket() {
    const socket = new WebSocket(url);

    socket.onopen = () => {
      // Include device info in auth for multi-client awareness
      const info = getDeviceInfo();
      void getDeviceId().then((deviceId) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'auth',
            token,
            deviceInfo: { deviceId, ...info },
          }));
        }
      });
    };

    const socketCtx: ConnectionContext = { url, token, isReconnect, silent, socket };
    _connectionContext = socketCtx;
    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(msg, socketCtx);
    };

    socket.onclose = () => {
      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      const wasConnected = get().connectionPhase === 'connected';
      set({ socket: null });

      // Auto-reconnect if the connection dropped unexpectedly (not user-initiated).
      // Calls connect() with _retryCount=0 to reset the retry budget — see comment
      // at connect() definition for rationale.
      if (wasConnected && disconnectedAttemptId !== myAttemptId) {
        console.log('[ws] Connection lost, auto-reconnecting...');
        set({ connectionPhase: 'reconnecting' });
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          get().connect(url, token);
        }, AUTO_RECONNECT_DELAY);
      } else if (disconnectedAttemptId === myAttemptId) {
        set({ connectionPhase: 'disconnected' });
      } else {
        // Connection dropped before auth completed — reset to disconnected
        set({ connectionPhase: 'disconnected' });
      }
    };

    socket.onerror = () => {
      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      set({ socket: null });

      // Auto-reconnect on unexpected WS error
      if (disconnectedAttemptId !== myAttemptId) {
        console.log('[ws] WebSocket error, reconnecting...');
        set({ connectionPhase: 'reconnecting' });
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          get().connect(url, token);
        }, ERROR_RECONNECT_DELAY);
      }
    };
    } // end _connectWebSocket
  },

  disconnect: () => {
    // Bump attempt ID to cancel any pending health checks / retry timers
    connectionAttemptId++;
    disconnectedAttemptId = connectionAttemptId;
    const { socket } = get();
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    // Reset replay flags in case disconnect happened mid-replay
    _receivingHistoryReplay = false;
    _isSessionSwitchReplay = false;
    _pendingSwitchSessionId = null;
    // Flush and clear any pending delta buffer
    if (deltaFlushTimer) {
      clearTimeout(deltaFlushTimer);
      deltaFlushTimer = null;
    }
    pendingDeltas.clear();
    // Clear terminal write batching
    if (_terminalWriteTimer) {
      clearTimeout(_terminalWriteTimer);
      _terminalWriteTimer = null;
    }
    _pendingTerminalWrites = '';
    // Clear message queue on explicit disconnect
    messageQueue.length = 0;
    // Preserve messages, terminalBuffer, sessions, activeSessionId, sessionStates
    // so reconnect to the same server can show previous chat history.
    // Only clear connection-level state.
    set({
      connectionPhase: 'disconnected',
      socket: null,
      serverMode: null,
      sessionCwd: null,
      serverVersion: null,
      latestVersion: null,
      serverCommit: null,
      claudeReady: false,
      streamingMessageId: null,
      activeModel: null,
      availableModels: [],
      permissionMode: null,
      availablePermissionModes: [],
      discoveredSessions: null,
      claudeStatus: null,
      myClientId: null,
      connectedClients: [],
      primaryClientId: null,
      serverErrors: [],
      pendingPermissionConfirm: null,
      _directoryListingCallback: null,
      _terminalWriteCallback: null,
      contextUsage: null,
      lastResultCost: null,
      lastResultDuration: null,
    });
    // Keep wsUrl, apiToken, messages, terminalBuffer, terminalRawBuffer, sessions, sessionStates, savedConnection
  },

  forgetSession: () => {
    // Clear last connected URL so next connect is treated as fresh
    lastConnectedUrl = null;
    set({
      messages: [],
      terminalBuffer: '',
      terminalRawBuffer: '',
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      wsUrl: null,
      apiToken: null,
      serverMode: null,
      sessionCwd: null,
      serverVersion: null,
      latestVersion: null,
      serverCommit: null,
    });
  },

  setViewMode: (mode) => {
    const { socket } = get();
    set({ viewMode: mode });
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'mode', mode }));
    }
  },

  addMessage: (message) => {
    set((state) => ({
      // Remove thinking placeholder when a real message arrives from the server
      messages: [
        ...state.messages.filter((m) => m.id !== 'thinking' || message.id === 'thinking'),
        message,
      ],
    }));
  },


  addUserMessage: (text) => {
    const userMsg: ChatMessage = {
      id: nextMessageId('user'),
      type: 'user_input',
      content: text,
      timestamp: Date.now(),
    };
    const thinkingMsg: ChatMessage = {
      id: 'thinking',
      type: 'thinking',
      content: '',
      timestamp: Date.now(),
    };

    const activeId = get().activeSessionId;
    if (activeId && get().sessionStates[activeId]) {
      // Session mode: use updateActiveSession helper for consistent sync logic
      updateActiveSession((ss) => ({
        messages: [...filterThinking(ss.messages), userMsg, thinkingMsg],
        streamingMessageId: 'pending',
      }));
    } else {
      // No active session: update flat state only (PTY mode, CLI mode pre-session, or legacy)
      set((state) => ({
        messages: [...filterThinking(state.messages), userMsg, thinkingMsg],
        streamingMessageId: 'pending',
      }));
    }

    // Safety net: if no stream_start arrives (e.g., WS not open, Claude not ready),
    // clear pending state and remove the thinking placeholder after 5 seconds.
    setTimeout(() => {
      if (get().streamingMessageId !== 'pending') return;
      const sid = get().activeSessionId;
      if (sid && get().sessionStates[sid]) {
        updateActiveSession((ss) => ({
          messages: filterThinking(ss.messages),
          streamingMessageId: null,
        }));
      } else {
        set((s) => ({
          messages: filterThinking(s.messages),
          streamingMessageId: null,
        }));
      }
    }, 5000);
  },

  appendTerminalData: (data) => {
    set((state) => ({
      terminalBuffer: (state.terminalBuffer + stripAnsi(data)).slice(-50000),
      terminalRawBuffer: (state.terminalRawBuffer + data).slice(-100000),
    }));
    // Forward raw data to xterm.js via batched write callback
    const cb = get()._terminalWriteCallback;
    if (cb) {
      _pendingTerminalWrites += data;
      if (!_terminalWriteTimer) {
        _terminalWriteTimer = setTimeout(_flushTerminalWrites, 50);
      }
    }
  },

  clearTerminalBuffer: () => {
    set({ terminalBuffer: '', terminalRawBuffer: '' });
    if (_terminalWriteTimer) {
      clearTimeout(_terminalWriteTimer);
      _terminalWriteTimer = null;
    }
    _pendingTerminalWrites = '';
  },

  setTerminalWriteCallback: (cb) => {
    set({ _terminalWriteCallback: cb });
  },

  updateInputSettings: (settings) => {
    set((state) => {
      const updated = { ...state.inputSettings, ...settings };
      // Persist to storage (fire-and-forget)
      SecureStore.setItemAsync(STORAGE_KEY_INPUT_SETTINGS, JSON.stringify(updated)).catch(() => {});
      return { inputSettings: updated };
    });
  },

  sendInput: (input) => {
    const { socket } = get();
    const payload = { type: 'input', data: input };
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return 'sent';
    }
    return enqueueMessage('input', payload);
  },

  sendInterrupt: () => {
    const { socket } = get();
    const payload = { type: 'interrupt' };
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return 'sent';
    }
    return enqueueMessage('interrupt', payload);
  },

  sendPermissionResponse: (requestId: string, decision: string) => {
    const { socket } = get();
    const payload = { type: 'permission_response', requestId, decision };
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return 'sent';
    }
    return enqueueMessage('permission_response', payload);
  },

  sendUserQuestionResponse: (answer: string) => {
    const { socket } = get();
    const payload = { type: 'user_question_response', answer };
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return 'sent';
    }
    return enqueueMessage('user_question_response', payload);
  },

  markPromptAnswered: (messageId: string, answer: string) => {
    const { activeSessionId, sessionStates } = get();

    if (activeSessionId && sessionStates[activeSessionId]) {
      updateActiveSession((ss) => ({
        messages: ss.messages.map((m) =>
          m.id === messageId ? { ...m, answered: answer } : m
        ),
      }));
    } else {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId ? { ...m, answered: answer } : m
        ),
      }));
    }
  },

  setModel: (model: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'set_model', model }));
    }
  },

  setPermissionMode: (mode: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'set_permission_mode', mode }));
    }
  },

  confirmPermissionMode: (mode: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'set_permission_mode', mode, confirmed: true }));
    }
    set({ pendingPermissionConfirm: null });
  },

  cancelPermissionConfirm: () => {
    set({ pendingPermissionConfirm: null });
  },

  resize: (cols, rows) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  },

  // Directory listing

  setDirectoryListingCallback: (cb) => {
    set({ _directoryListingCallback: cb });
  },

  requestDirectoryListing: (path?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'list_directory' };
      if (path) msg.path = path;
      socket.send(JSON.stringify(msg));
    }
  },

  // Session actions

  switchSession: (sessionId: string) => {
    const { socket, activeSessionId, sessionStates } = get();

    // Save current session state is already in sessionStates (it's always synced)
    // Just update activeSessionId locally and send WS message
    if (sessionId === activeSessionId) return;

    // Mark as user-initiated switch so session_switched handler uses session-switch dedup
    _pendingSwitchSessionId = sessionId;

    // Optimistically switch to cached state
    const cached = sessionStates[sessionId];
    if (cached) {
      set({
        activeSessionId: sessionId,
        messages: cached.messages,
        streamingMessageId: cached.streamingMessageId,
        claudeReady: cached.claudeReady,
        activeModel: cached.activeModel,
        permissionMode: cached.permissionMode,
        contextUsage: cached.contextUsage,
        lastResultCost: cached.lastResultCost,
        lastResultDuration: cached.lastResultDuration,
      });
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'switch_session', sessionId }));
    }
  },

  createSession: (name: string, cwd?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'create_session' };
      if (name) msg.name = name;
      if (cwd) msg.cwd = cwd;
      socket.send(JSON.stringify(msg));
    }
  },

  destroySession: (sessionId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'destroy_session', sessionId }));
    }
  },

  renameSession: (sessionId: string, name: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'rename_session', sessionId, name }));
    }
  },

  discoverSessions: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ discoveredSessions: null }); // clear stale results
      socket.send(JSON.stringify({ type: 'discover_sessions' }));
    }
  },

  attachSession: (tmuxSession: string, name?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'attach_session', tmuxSession };
      if (name) msg.name = name;
      socket.send(JSON.stringify(msg));
    }
  },

  clearPlanState: () => {
    updateActiveSession(() => ({
      isPlanPending: false,
      planAllowedPrompts: [],
    }));
  },

  dismissServerError: (id: string) => {
    set((state) => ({
      serverErrors: state.serverErrors.filter((e) => e.id !== id),
    }));
  },
}));

// Reconnect on app resume from background — detects stale sockets that
// Cloudflare or the mobile OS silently closed while the app was suspended.
// Singleton guard prevents duplicate listeners on Fast Refresh in development.
AppState.addEventListener('change', (nextState) => {
  if (nextState === 'active') {
    const { socket, connectionPhase, wsUrl, apiToken } = useConnectionStore.getState();
    if (connectionPhase === 'connected' && socket && socket.readyState !== WebSocket.OPEN && wsUrl && apiToken) {
      console.log('[ws] App resumed, socket stale — reconnecting');
      useConnectionStore.getState().connect(wsUrl, apiToken);
    }
  }
});
