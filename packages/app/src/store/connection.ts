/**
 * Connection store — Zustand store managing WebSocket connection,
 * session state, and all server communication.
 *
 * This module was split from a single 2850-line file into:
 * - types.ts       — All shared interfaces and type definitions
 * - utils.ts       — Pure utility functions (stripAnsi, filterThinking, etc.)
 * - message-handler.ts — handleMessage() and module-level state
 * - connection.ts   — Store definition and actions (this file)
 */
import { create } from 'zustand';
import { Alert, AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { type EncryptedEnvelope } from '../utils/crypto';
import { hapticLight, hapticMedium, hapticWarning } from '../utils/haptics';

// Global augmentation for hot-reload cleanup sentinel
declare global {
  // eslint-disable-next-line no-var
  var __chroxy_appStateSub: ReturnType<typeof AppState.addEventListener> | undefined;
}

// Re-export all types for backward compatibility
export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  ContextUsage,
  ModelInfo,
  SessionInfo,
  DirectoryEntry,
  DirectoryListing,
  FileEntry,
  FileListing,
  FileContent,
  FileWriteResult,
  DiffHunkLine,
  DiffHunk,
  DiffFile,
  DiffResult,
  GitFileStatus,
  GitBranch,
  GitStatusResult,
  GitBranchesResult,
  GitStageResult,
  GitCommitResult,
  AgentInfo,
  ConnectedClient,
  SessionHealth,
  SessionContext,
  McpServer,
  DevPreview,
  SessionState,
  ServerError,
  SessionNotification,
  SlashCommand,
  CustomAgent,
  ConnectionPhase,
  ConnectionContext,
  ConversationSummary,
  SearchResult,
  ConnectionState,
} from './types';

// Re-export utility functions for backward compatibility
export { stripAnsi, filterThinking, nextMessageId, createEmptySessionState } from './utils';

// Re-export loadConnection for backward compatibility (used by notifications.ts)
export { loadConnection, _testQueueInternals, _testMessageHandler } from './message-handler';

// Import what we need internally
import type {
  ChatMessage,
  ConnectionContext,
  ConnectionState,
  MessageAttachment,
  SessionInfo,
} from './types';
import { stripAnsi, filterThinking, nextMessageId, createEmptySessionState, withJitter } from './utils';
import {
  setStore,
  wsSend,
  handleMessage,
  setConnectionContext,
  setEncryptionState,
  setPendingKeyPair,
  getEncryptionState,
  getPendingKeyPair,
  connectionAttemptId,
  bumpConnectionAttemptId,
  disconnectedAttemptId,
  setDisconnectedAttemptId,
  lastConnectedUrl,
  setLastConnectedUrl,
  pendingPairingId,
  setPendingPairingId,
  setPendingSwitchSessionId,
  resetReplayFlags,
  clearPermissionSplits,
  clearTerminalWriteBatching,
  appendPendingTerminalWrite,
  stopHeartbeat,
  clearDeltaBuffers,
  clearMessageQueue,
  enqueueMessage,
  updateSession,
  updateActiveSession,
  saveConnection,
  clearConnection,
  loadConnection,
  drainMessageQueue,
  CLIENT_PROTOCOL_VERSION,
} from './message-handler';
import { setCallback as setImperativeCallback, getCallback, clearAllCallbacks } from './imperative-callbacks';
import { decrypt, DIRECTION_SERVER, type EncryptionState } from '../utils/crypto';
import {
  loadPersistedState,
  loadSessionMessages,
  loadSessionList,
  loadAllSessionMessages,
  persistSessionMessages,
  persistViewMode,
  persistActiveSession,
  persistTerminalBuffer,
  persistSessionList,
  clearPersistedState,
} from './persistence';

const STORAGE_KEY_INPUT_SETTINGS = 'chroxy_input_settings';

/** Delay before auto-reconnecting after an unexpected socket close (ms) */
const AUTO_RECONNECT_DELAY = 1500;
/** Delay before reconnecting after a WebSocket error (ms) */
const ERROR_RECONNECT_DELAY = 2000;

export const selectShowSession = (s: ConnectionState): boolean =>
  s.connectionPhase !== 'disconnected' || s.viewingCachedSession;

// Search request tracking — prevents stale timeout/response races
let searchNonce = 0;
let searchTimeoutId: ReturnType<typeof setTimeout> | undefined;

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
  serverProtocolVersion: null,
  sessions: [],
  activeSessionId: null,
  sessionStates: {},
  claudeReady: false,
  streamingMessageId: null,
  activeModel: null,
  availableModels: [],
  permissionMode: null,
  availablePermissionModes: [],
  myClientId: null,
  connectedClients: [],
  primaryClientId: null,
  followMode: false,
  connectionError: null,
  connectionRetryCount: 0,
  latencyMs: null,
  connectionQuality: null,
  serverErrors: [],
  sessionNotifications: [],
  shutdownReason: null,
  restartEtaMs: null,
  restartingSince: null,
  isEncrypted: false,
  pendingPermissionConfirm: null,
  timeoutWarning: null,
  slashCommands: [],
  customAgents: [],
  checkpoints: [],
  conversationHistory: [],
  conversationHistoryLoading: false,
  conversationHistoryError: null,
  searchResults: [],
  searchLoading: false,
  searchQuery: '',
  searchError: null,
  contextUsage: null,
  lastResultCost: null,
  lastResultDuration: null,
  totalCost: null,
  costBudget: null,
  isIdle: true,
  inputSettings: {
    chatEnterToSend: true,
    terminalEnterToSend: false,
  },
  savedConnection: null,
  userDisconnected: false,
  viewingCachedSession: false,
  viewMode: 'chat',
  messages: [],
  terminalBuffer: '',
  terminalRawBuffer: '',

  closeDevPreview: (port: number) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'close_dev_preview', port, sessionId: activeSessionId });
    }
  },

  // Web tasks (Claude Code Web)
  webFeatures: { available: false, remote: false, teleport: false },
  webTasks: [],

  launchWebTask: (prompt: string, cwd?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'launch_web_task', prompt };
      if (cwd) payload.cwd = cwd;
      wsSend(socket, payload);
      return 'sent';
    }
    return false;
  },

  listWebTasks: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_web_tasks' });
    }
  },

  teleportWebTask: (taskId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'teleport_web_task', taskId });
    }
  },

  viewCachedSession: () => {
    const { activeSessionId, sessionStates } = get();
    if (activeSessionId && sessionStates[activeSessionId]?.messages.length > 0) {
      set({ viewingCachedSession: true });
    }
  },

  exitCachedSession: () => {
    set({ viewingCachedSession: false });
  },

  dismissTimeoutWarning: () => {
    set({ timeoutWarning: null });
  },

  setFollowMode: (enabled: boolean) => {
    set({ followMode: enabled });
  },

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
      sessionCost: null,
      isIdle: true,
      health: 'healthy' as const,
      activeAgents: [],
      isPlanPending: false,
      planAllowedPrompts: [],
      primaryClientId: null,
      conversationId: null,
      sessionContext: null,
      mcpServers: [],
      devPreviews: [],
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
    // Load persisted session state (view mode, active session, terminal buffer, session list)
    try {
      const [persisted, cachedSessions] = await Promise.all([
        loadPersistedState(),
        loadSessionList(),
      ]);
      const updates: Partial<ReturnType<typeof get>> = {};
      if (persisted.viewMode) updates.viewMode = persisted.viewMode;
      if (persisted.activeSessionId) updates.activeSessionId = persisted.activeSessionId;
      if (persisted.terminalBuffer) updates.terminalBuffer = persisted.terminalBuffer;
      if (cachedSessions.length > 0) updates.sessions = cachedSessions;
      if (Object.keys(updates).length > 0) set(updates);

      // Load cached messages for all sessions (not just active)
      const sessionIds = cachedSessions.map((s) => s.sessionId);
      if (persisted.activeSessionId && !sessionIds.includes(persisted.activeSessionId)) {
        sessionIds.push(persisted.activeSessionId);
      }
      if (sessionIds.length > 0) {
        const allMessages = await loadAllSessionMessages(sessionIds);
        const sessionStates: Record<string, ReturnType<typeof createEmptySessionState>> = {};
        for (const [id, messages] of Object.entries(allMessages)) {
          if (messages.length > 0) {
            sessionStates[id] = { ...createEmptySessionState(), messages };
          }
        }
        if (Object.keys(sessionStates).length > 0) {
          set((state) => ({
            sessionStates: { ...state.sessionStates, ...sessionStates },
          }));
        }
      }
    } catch {
      // Persisted state unavailable — use defaults
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
      clearMessageQueue();
    }

    // Robust reconnect detection: check if we've successfully connected to this URL before
    const isReconnect = lastConnectedUrl === url;

    // New top-level connect call (not a retry) — bump attempt ID to cancel any pending retries
    if (_retryCount === 0) {
      bumpConnectionAttemptId();
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
    // Only clear connectionError on fresh user-initiated connections (not retries/reconnects)
    const errorPatch = _retryCount === 0 && !isReconnect ? { connectionError: null } : {};
    set({ socket: null, connectionPhase: phase, connectionRetryCount: _retryCount, userDisconnected: false, ...errorPatch });

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
            const healthEta = typeof body.restartEtaMs === 'number' ? body.restartEtaMs : null;
            const currentState = get();
            set({
              connectionPhase: 'server_restarting',
              shutdownReason: currentState.shutdownReason ?? 'restart',
              restartEtaMs: healthEta,
              restartingSince: currentState.restartingSince || Date.now(),
            });
            if (_retryCount < MAX_RETRIES) {
              const delay = withJitter(RETRY_DELAYS[Math.min(_retryCount, RETRY_DELAYS.length - 1)]);
              setTimeout(() => {
                if (myAttemptId !== connectionAttemptId) return;
                get().connect(url, token, { silent, _retryCount: _retryCount + 1 });
              }, delay);
            } else {
              set({ connectionPhase: 'disconnected', connectionError: 'Server restart timed out' });
              if (!silent) {
                Alert.alert(
                  'Connection Failed',
                  'The server is still restarting. Try again later.',
                  [
                    { text: 'OK' },
                    { text: 'Retry', onPress: () => get().connect(url, token) },
                  ],
                );
              }
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
        const reason = err.name === 'AbortError' ? 'Server not responding'
          : err.message?.startsWith('HTTP ') ? err.message
          : 'Network error';
        set({ connectionError: reason });
        if (_retryCount < MAX_RETRIES) {
          const delay = withJitter(RETRY_DELAYS[_retryCount]);
          console.log(`[ws] Retrying in ${delay}ms...`);
          setTimeout(() => {
            if (myAttemptId !== connectionAttemptId) return;
            get().connect(url, token, { silent, _retryCount: _retryCount + 1 });
          }, delay);
        } else {
          set({ connectionPhase: 'disconnected', connectionError: 'Could not reach server' });
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
    // Reset encryption state for each new connection (forward secrecy)
    setEncryptionState(null);
    setPendingKeyPair(null);
    const socket = new WebSocket(url);

    socket.onopen = () => {
      // Include device info in auth for multi-client awareness
      const info = getDeviceInfo();
      void getDeviceId().then((deviceId) => {
        if (socket.readyState === WebSocket.OPEN) {
          // Use pairing flow when pendingPairingId is set (from QR scan)
          const pairId = pendingPairingId;
          if (pairId) {
            setPendingPairingId(null); // Clear after use (one-time)
            socket.send(JSON.stringify({
              type: 'pair',
              pairingId: pairId,
              protocolVersion: CLIENT_PROTOCOL_VERSION,
              deviceInfo: { deviceId, ...info },
            }));
          } else {
            socket.send(JSON.stringify({
              type: 'auth',
              token,
              protocolVersion: CLIENT_PROTOCOL_VERSION,
              deviceInfo: { deviceId, ...info },
            }));
          }
        }
      });
    };

    const socketCtx: ConnectionContext = { url, token, isReconnect, silent, socket };
    setConnectionContext(socketCtx);
    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      // Decrypt incoming encrypted messages
      const encState = getEncryptionState();
      if (msg.type === 'encrypted' && encState) {
        if (typeof msg.d !== 'string' || typeof msg.n !== 'number') {
          console.error('[crypto] Invalid encrypted envelope structure:', msg);
          socket.close();
          return;
        }
        try {
          msg = decrypt(msg as EncryptedEnvelope, encState.sharedKey, encState.recvNonce, DIRECTION_SERVER);
          setEncryptionState({ ...encState, recvNonce: encState.recvNonce + 1 });
        } catch (err) {
          console.error('[crypto] Decryption failed:', err);
          socket.close();
          return;
        }
      }
      handleMessage(msg, socketCtx);
    };

    socket.onclose = () => {
      stopHeartbeat();

      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      const wasConnected = get().connectionPhase === 'connected';
      set({ socket: null });

      // Clear transient streaming/plan state so stale UI doesn't persist
      clearPermissionSplits();
      updateActiveSession((ss) => {
        const patch: Partial<import('./types').SessionState> = {};
        if (ss.streamingMessageId) patch.streamingMessageId = null;
        if (ss.isPlanPending) {
          patch.isPlanPending = false;
          patch.planAllowedPrompts = [];
        }
        return Object.keys(patch).length > 0 ? patch : {};
      });

      // Auto-reconnect if the connection dropped unexpectedly (not user-initiated)
      if (wasConnected && disconnectedAttemptId !== myAttemptId) {
        console.log('[ws] Connection lost, auto-reconnecting...');
        set({ connectionPhase: 'reconnecting', connectionError: 'Connection lost', connectionRetryCount: 0 });
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          get().connect(url, token);
        }, AUTO_RECONNECT_DELAY);
      } else if (disconnectedAttemptId === myAttemptId) {
        set({ connectionPhase: 'disconnected' });
      } else {
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
        set({ connectionPhase: 'reconnecting', connectionError: 'Connection error', connectionRetryCount: 0 });
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          get().connect(url, token);
        }, ERROR_RECONNECT_DELAY);
      }
    };
    } // end _connectWebSocket
  },

  disconnect: () => {
    hapticMedium();
    // Bump attempt ID to cancel any pending health checks / retry timers
    bumpConnectionAttemptId();
    setDisconnectedAttemptId(connectionAttemptId);
    // Clear saved connection so ConnectScreen doesn't auto-reconnect
    setLastConnectedUrl(null);
    stopHeartbeat();
    const { socket } = get();
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    // Reset replay flags in case disconnect happened mid-replay
    resetReplayFlags();
    // Flush and clear any pending delta buffer
    clearDeltaBuffers();
    // Clear permission boundary split tracking
    clearPermissionSplits();
    // Clear terminal write batching
    clearTerminalWriteBatching();
    // Clear encryption state (new connection = new keys = forward secrecy)
    setEncryptionState(null);
    setPendingKeyPair(null);
    // Clear message queue on explicit disconnect
    clearMessageQueue();
    // Preserve messages, terminalBuffer, sessions, activeSessionId, sessionStates
    set({
      connectionPhase: 'disconnected',
      socket: null,
      serverMode: null,
      sessionCwd: null,
      serverVersion: null,
      latestVersion: null,
      serverCommit: null,
      serverProtocolVersion: null,
      claudeReady: false,
      streamingMessageId: null,
      activeModel: null,
      availableModels: [],
      permissionMode: null,
      availablePermissionModes: [],
      myClientId: null,
      connectedClients: [],
      primaryClientId: null,
      connectionError: null,
      connectionRetryCount: 0,
      latencyMs: null,
      connectionQuality: null,
      serverErrors: [],
      sessionNotifications: [],
      shutdownReason: null,
      restartEtaMs: null,
      restartingSince: null,
      isEncrypted: false,
      pendingPermissionConfirm: null,
      timeoutWarning: null,
      slashCommands: [],
      customAgents: [],
      checkpoints: [],
      contextUsage: null,
      lastResultCost: null,
      lastResultDuration: null,
      totalCost: null,
      costBudget: null,
      webFeatures: { available: false, remote: false, teleport: false },
      webTasks: [],
      savedConnection: null,
      userDisconnected: true,
      viewingCachedSession: false,
      conversationHistory: [],
      conversationHistoryLoading: false,
      conversationHistoryError: null,
      searchResults: [],
      searchLoading: false,
      searchQuery: '',
      searchError: null,
    });
    clearAllCallbacks();
  },

  forgetSession: () => {
    setLastConnectedUrl(null);
    clearPersistedState().catch(() => {});
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
      serverProtocolVersion: null,
      viewingCachedSession: false,
      conversationHistory: [],
      conversationHistoryLoading: false,
      conversationHistoryError: null,
    });
  },

  setViewMode: (mode) => {
    set({ viewMode: mode });
    persistViewMode(mode).catch(() => {});
  },

  addMessage: (message) => {
    set((state) => ({
      messages: [
        ...state.messages.filter((m) => m.id !== 'thinking' || message.id === 'thinking'),
        message,
      ],
    }));
  },


  addUserMessage: (text, attachments) => {
    const userMsg: ChatMessage = {
      id: nextMessageId('user'),
      type: 'user_input',
      content: text,
      timestamp: Date.now(),
      ...(attachments?.length ? { attachments } : undefined),
    };
    const thinkingMsg: ChatMessage = {
      id: 'thinking',
      type: 'thinking',
      content: '',
      timestamp: Date.now(),
    };

    const activeId = get().activeSessionId;
    if (activeId && get().sessionStates[activeId]) {
      updateActiveSession((ss) => ({
        messages: [...filterThinking(ss.messages), userMsg, thinkingMsg],
        streamingMessageId: 'pending',
      }));
    } else {
      set((state) => ({
        messages: [...filterThinking(state.messages), userMsg, thinkingMsg],
        streamingMessageId: 'pending',
      }));
    }

    // Safety net: if no stream_start arrives, clear pending state after 5 seconds.
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
    if (getCallback('terminalWrite')) {
      appendPendingTerminalWrite(data);
    }
  },

  clearTerminalBuffer: () => {
    set({ terminalBuffer: '', terminalRawBuffer: '' });
    clearTerminalWriteBatching();
  },

  setTerminalWriteCallback: (cb) => {
    setImperativeCallback('terminalWrite', cb);
  },

  updateInputSettings: (settings) => {
    set((state) => {
      const updated = { ...state.inputSettings, ...settings };
      SecureStore.setItemAsync(STORAGE_KEY_INPUT_SETTINGS, JSON.stringify(updated)).catch(() => {});
      return { inputSettings: updated };
    });
  },

  sendInput: (input, wireAttachments, options) => {
    const { socket, activeSessionId } = get();
    const payload: Record<string, unknown> = { type: 'input', data: input };
    if (activeSessionId) payload.sessionId = activeSessionId;
    if (wireAttachments?.length) {
      payload.attachments = wireAttachments;
    }
    if (options?.isVoice) {
      payload.isVoice = true;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      hapticLight();
      wsSend(socket, payload);
      return 'sent';
    }
    return enqueueMessage('input', payload);
  },

  sendInterrupt: () => {
    const { socket, activeSessionId } = get();
    const payload: Record<string, unknown> = { type: 'interrupt' };
    if (activeSessionId) payload.sessionId = activeSessionId;
    if (socket && socket.readyState === WebSocket.OPEN) {
      hapticMedium();
      wsSend(socket, payload);
      return 'sent';
    }
    return enqueueMessage('interrupt', payload);
  },

  sendPermissionResponse: (requestId: string, decision: string) => {
    const { socket } = get();
    const payload = { type: 'permission_response', requestId, decision };
    let result: 'sent' | 'queued' | false;
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (decision === 'deny') hapticWarning(); else hapticMedium();
      wsSend(socket, payload);
      result = 'sent';
    } else {
      result = enqueueMessage('permission_response', payload);
    }
    // Auto-switch to the session that owns this prompt (if different from active).
    // Prefer sessionNotifications lookup (covers prompts stored before sessionStates[sid] existed),
    // fall back to scanning sessionStates messages.
    const { activeSessionId, sessionStates, sessionNotifications } = get();
    const notifMatch = sessionNotifications.find((n) => n.requestId === requestId);
    const targetSid = notifMatch?.sessionId
      ?? Object.entries(sessionStates).find(([, ss]) => ss.messages.some((m) => m.requestId === requestId))?.[0];
    if (targetSid && targetSid !== activeSessionId) get().switchSession(targetSid, { haptic: false });
    return result;
  },

  sendUserQuestionResponse: (answer: string, toolUseId?: string) => {
    const { socket } = get();
    const payload: Record<string, string> = { type: 'user_question_response', answer };
    if (toolUseId) payload.toolUseId = toolUseId;
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, payload);
      return 'sent';
    }
    return enqueueMessage('user_question_response', payload);
  },

  markPromptAnswered: (messageId: string, answer: string) => {
    const { activeSessionId, sessionStates } = get();
    const now = Date.now();

    if (activeSessionId && sessionStates[activeSessionId]) {
      updateActiveSession((ss) => ({
        messages: ss.messages.map((m) =>
          m.id === messageId ? { ...m, answered: answer, answeredAt: now } : m
        ),
      }));
    } else {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId ? { ...m, answered: answer, answeredAt: now } : m
        ),
      }));
    }
  },

  markPromptAnsweredByRequestId: (requestId: string, answer: string) => {
    const { sessionStates } = get();
    const now = Date.now();

    // Search all sessions — push-notification path may answer prompts in background sessions
    for (const [sid, ss] of Object.entries(sessionStates)) {
      if (ss.messages.some((m) => m.requestId === requestId)) {
        updateSession(sid, (s) => ({
          messages: s.messages.map((m) =>
            m.requestId === requestId ? { ...m, answered: answer, answeredAt: now } : m
          ),
        }));
        return;
      }
    }

    // Fallback: check legacy flat messages
    set((state) => ({
      messages: state.messages.map((m) =>
        m.requestId === requestId ? { ...m, answered: answer, answeredAt: now } : m
      ),
    }));
  },

  setModel: (model: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_model', model };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  setPermissionMode: (mode: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_permission_mode', mode };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  confirmPermissionMode: (mode: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_permission_mode', mode, confirmed: true };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
    set({ pendingPermissionConfirm: null });
  },

  cancelPermissionConfirm: () => {
    set({ pendingPermissionConfirm: null });
  },

  resize: (cols, rows) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'resize', cols, rows };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  // Directory listing

  setDirectoryListingCallback: (cb) => {
    setImperativeCallback('directoryListing', cb);
  },

  requestDirectoryListing: (path?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'list_directory' };
      if (path) msg.path = path;
      wsSend(socket, msg);
    }
  },

  // File browser

  setFileBrowserCallback: (cb) => {
    setImperativeCallback('fileBrowser', cb);
  },

  setFileContentCallback: (cb) => {
    setImperativeCallback('fileContent', cb);
  },

  requestFileListing: (path?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'browse_files' };
      if (path) msg.path = path;
      wsSend(socket, msg);
    }
  },

  requestFileContent: (path: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'read_file', path });
    }
  },

  setFileWriteCallback: (cb) => {
    setImperativeCallback('fileWrite', cb);
  },

  requestFileWrite: (path: string, content: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'write_file', path, content });
    }
  },

  // Diff viewer

  setDiffCallback: (cb) => {
    setImperativeCallback('diff', cb);
  },

  requestDiff: (base?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'get_diff' };
      if (base) msg.base = base;
      wsSend(socket, msg);
    }
  },

  // Git operations

  setGitStatusCallback: (cb) => { setImperativeCallback('gitStatus', cb); },
  setGitBranchesCallback: (cb) => { setImperativeCallback('gitBranches', cb); },
  setGitStageCallback: (cb) => { setImperativeCallback('gitStage', cb); },
  setGitCommitCallback: (cb) => { setImperativeCallback('gitCommit', cb); },

  requestGitStatus: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_status' });
    }
  },

  requestGitBranches: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_branches' });
    }
  },

  requestGitStage: (paths: string[]) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_stage', files: paths });
    }
  },

  requestGitUnstage: (paths: string[]) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_unstage', files: paths });
    }
  },

  requestGitCommit: (message: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_commit', message });
    }
  },

  fetchSlashCommands: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_slash_commands' });
    }
  },

  fetchCustomAgents: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_agents' });
    }
  },

  // Session actions

  switchSession: (sessionId: string, options?: { serverNotify?: boolean; haptic?: boolean }) => {
    const { socket, activeSessionId, sessionStates } = get();
    const serverNotify = options?.serverNotify ?? true;
    const haptic = options?.haptic ?? true;

    if (sessionId === activeSessionId) return;
    if (haptic) hapticLight();

    // Mark as user-initiated switch so session_switched handler uses session-switch dedup
    if (serverNotify) setPendingSwitchSessionId(sessionId);

    // Optimistically switch to cached state + dismiss notifications for target session
    const cached = sessionStates[sessionId];
    const filteredNotifications = get().sessionNotifications.filter(
      (n) => n.sessionId !== sessionId,
    );
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
        sessionNotifications: filteredNotifications,
      });
    } else {
      set({ activeSessionId: sessionId, sessionNotifications: filteredNotifications });
    }

    if (serverNotify && socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'switch_session', sessionId });
    }
  },

  createSession: (name: string, cwd?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'create_session' };
      if (name) msg.name = name;
      if (cwd) msg.cwd = cwd;
      wsSend(socket, msg);
    }
  },

  destroySession: (sessionId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'destroy_session', sessionId });
    }
  },

  renameSession: (sessionId: string, name: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'rename_session', sessionId, name });
    }
  },

  fetchConversationHistory: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ conversationHistoryLoading: true, conversationHistoryError: null });
      wsSend(socket, { type: 'list_conversations' });
      // Safety timeout — clear loading state if server never responds
      setTimeout(() => {
        if (get().conversationHistoryLoading) {
          set({ conversationHistoryLoading: false, conversationHistoryError: 'Request timed out. Check your connection and try again.' });
        }
      }, 10_000);
    } else {
      // Not connected — set error
      set({ conversationHistoryLoading: false, conversationHistoryError: 'Not connected to server.' });
    }
  },

  resumeConversation: (conversationId: string, cwd?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'resume_conversation', conversationId };
      if (cwd) payload.cwd = cwd;
      wsSend(socket, payload);
    }
  },

  searchConversations: (query: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const nonce = ++searchNonce;
      set({ searchLoading: true, searchResults: [], searchQuery: query, searchError: null });
      wsSend(socket, { type: 'search_conversations', query });
      // Timeout to surface error if no response in 15s
      clearTimeout(searchTimeoutId);
      searchTimeoutId = setTimeout(() => {
        if (searchNonce === nonce && get().searchLoading) {
          set({ searchLoading: false, searchError: 'Search timed out. Check your connection and try again.' });
        }
      }, 15000);
    } else {
      // Not connected: clear any in-flight search state and surface error
      clearTimeout(searchTimeoutId);
      searchNonce++;
      set({
        searchLoading: false,
        searchResults: [],
        searchQuery: query,
        searchError: 'Not connected to server.',
      });
    }
  },

  clearSearchResults: () => {
    set({ searchResults: [], searchLoading: false, searchQuery: '', searchError: null });
  },

  requestFullHistory: (sessionId?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'request_full_history' };
      if (sessionId) msg.sessionId = sessionId;
      wsSend(socket, msg);
    }
  },

  createCheckpoint: (name?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'create_checkpoint' };
      if (name) msg.name = name;
      wsSend(socket, msg);
    }
  },

  listCheckpoints: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_checkpoints' });
    }
  },

  restoreCheckpoint: (checkpointId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'restore_checkpoint', checkpointId });
    }
  },

  deleteCheckpoint: (checkpointId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'delete_checkpoint', checkpointId });
    }
  },

  clearPlanState: () => {
    updateActiveSession(() => ({
      isPlanPending: false,
      planAllowedPrompts: [],
    }));
  },

  sendPlanResponse: (sessionId: string, approve: boolean) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const data = approve ? 'Go ahead with the plan' : 'n';
      wsSend(socket, { type: 'input', data, sessionId });
    }
    // Clear plan state for the target session
    if (get().sessionStates[sessionId]) {
      const store = get();
      const sessionState = store.sessionStates[sessionId];
      set({
        sessionStates: {
          ...store.sessionStates,
          [sessionId]: { ...sessionState, isPlanPending: false, planAllowedPrompts: [] },
        },
      });
    }
  },

  dismissServerError: (id: string) => {
    set((state) => ({
      serverErrors: state.serverErrors.filter((e) => e.id !== id),
    }));
  },

  dismissSessionNotification: (id: string) => {
    set((state) => ({
      sessionNotifications: state.sessionNotifications.filter((n) => n.id !== id),
    }));
  },
}));

// Type for the store API used by message-handler
type StoreApi = {
  getState: () => ConnectionState;
  setState: (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void;
};

// Wire up the store reference synchronously now that create() has returned
setStore({
  getState: useConnectionStore.getState,
  setState: useConnectionStore.setState as StoreApi['setState'],
});

// Persist session messages, active session, session list when they change
let _prevActiveSessionId: string | null = null;
const _prevMessageCounts: Record<string, number> = {};
let _prevTerminalBufferLen = 0;
let _prevSessions: SessionInfo[] = [];
useConnectionStore.subscribe((state) => {
  // Persist active session ID changes
  if (state.activeSessionId !== _prevActiveSessionId) {
    // Flush messages for the previous session before switching (avoids losing debounced writes)
    if (_prevActiveSessionId) {
      const prevSs = state.sessionStates[_prevActiveSessionId];
      if (prevSs) {
        persistSessionMessages(_prevActiveSessionId, prevSs.messages);
        _prevMessageCounts[_prevActiveSessionId] = prevSs.messages.length;
      }
    }
    _prevActiveSessionId = state.activeSessionId;
    persistActiveSession(state.activeSessionId).catch(() => {});
  }

  // Persist messages for ALL sessions with changed message counts (not just active)
  for (const [sessionId, ss] of Object.entries(state.sessionStates)) {
    const prevCount = _prevMessageCounts[sessionId] ?? 0;
    if (ss.messages.length !== prevCount) {
      _prevMessageCounts[sessionId] = ss.messages.length;
      persistSessionMessages(sessionId, ss.messages);
    }
  }

  // Persist session list when it changes (reference equality — catches renames, model changes, etc.)
  if (state.sessions !== _prevSessions) {
    _prevSessions = state.sessions;
    if (state.sessions.length > 0) {
      persistSessionList(state.sessions);
    }
  }

  // Persist terminal buffer changes (debounced internally, only when changed)
  if (state.terminalBuffer.length !== _prevTerminalBufferLen) {
    _prevTerminalBufferLen = state.terminalBuffer.length;
    if (state.terminalBuffer) {
      persistTerminalBuffer(state.terminalBuffer);
    }
  }
});

// Reconnect on app resume from background.
// Clean up previous subscription on Metro hot-reload to prevent duplicate listeners.
if (global.__chroxy_appStateSub) {
  global.__chroxy_appStateSub.remove();
}
export const _appStateSub = AppState.addEventListener('change', (nextState) => {
  if (nextState === 'active') {
    const { socket, connectionPhase, wsUrl, apiToken } = useConnectionStore.getState();
    if (connectionPhase === 'connected' && socket && socket.readyState !== WebSocket.OPEN && wsUrl && apiToken) {
      console.log('[ws] App resumed, socket stale — reconnecting');
      useConnectionStore.getState().connect(wsUrl, apiToken);
    }
  }
});
global.__chroxy_appStateSub = _appStateSub;
