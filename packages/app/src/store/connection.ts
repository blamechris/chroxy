import { create } from 'zustand';
import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY_URL = 'chroxy_last_url';
const STORAGE_KEY_TOKEN = 'chroxy_last_token';
const STORAGE_KEY_INPUT_SETTINGS = 'chroxy_input_settings';

/** Strip ANSI escape codes for plain text display */
function stripAnsi(str: string): string {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07?|\x1b[()#][A-Z0-2]|\x1b[A-Za-z]|\x9b[0-9;?]*[A-Za-z~]/g,
    '',
  );
}

export interface ChatMessage {
  id: string;
  type: 'response' | 'user_input' | 'tool_use' | 'thinking' | 'prompt' | 'error';
  content: string;
  tool?: string;
  options?: { label: string; value: string }[];
  requestId?: string;
  timestamp: number;
}

interface SavedConnection {
  url: string;
  token: string;
}

interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
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

interface ConnectionState {
  // Connection
  isConnected: boolean;
  isReconnecting: boolean;
  wsUrl: string | null;
  apiToken: string | null;
  socket: WebSocket | null;

  // Saved connection for quick reconnect
  savedConnection: SavedConnection | null;

  // Server mode: 'cli' (headless) or 'terminal' (PTY/tmux)
  serverMode: 'cli' | 'terminal' | null;

  // Whether Claude Code is ready for input
  claudeReady: boolean;

  // Currently streaming message ID (CLI mode)
  streamingMessageId: string | null;

  // Active model (CLI mode)
  activeModel: string | null;

  // Available models from server (CLI mode)
  availableModels: ModelInfo[];

  // Context window usage from last result
  contextUsage: ContextUsage | null;

  // Cost/duration from last result
  lastResultCost: number | null;
  lastResultDuration: number | null;

  // View mode
  viewMode: 'chat' | 'terminal';

  // Input settings
  inputSettings: InputSettings;

  // Chat messages (parsed output)
  messages: ChatMessage[];

  // Raw terminal output buffer
  terminalBuffer: string;

  // Actions
  connect: (url: string, token: string, _retryCount?: number) => void;
  disconnect: () => void;
  loadSavedConnection: () => Promise<void>;
  clearSavedConnection: () => Promise<void>;
  setViewMode: (mode: 'chat' | 'terminal') => void;
  addMessage: (message: ChatMessage) => void;
  appendTerminalData: (data: string) => void;
  clearTerminalBuffer: () => void;
  updateInputSettings: (settings: Partial<InputSettings>) => void;
  sendInput: (input: string) => void;
  sendInterrupt: () => void;
  sendPermissionResponse: (requestId: string, decision: string) => void;
  setModel: (model: string) => void;
  resize: (cols: number, rows: number) => void;
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

// Monotonically increasing counter to cancel stale retry chains
let connectionAttemptId = 0;
// Tracks which attempt was user-disconnected (replaces boolean flag to avoid
// stale-socket race: disconnect → reconnect → old socket onclose fires)
let disconnectedAttemptId = -1;

// Monotonic message ID counter (avoids Math.random() collisions)
let messageIdCounter = 0;
function nextMessageId(prefix = 'msg'): string {
  return `${prefix}-${++messageIdCounter}-${Date.now()}`;
}

// Delta batching: accumulate stream deltas and flush to state periodically
// to reduce re-renders (dozens of deltas/sec → one state update per 100ms)
const pendingDeltas = new Map<string, string>();
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingDeltas() {
  deltaFlushTimer = null;
  if (pendingDeltas.size === 0) return;
  const updates = new Map(pendingDeltas);
  pendingDeltas.clear();
  useConnectionStore.setState((state) => ({
    messages: state.messages.map((m) => {
      const delta = updates.get(m.id);
      return delta ? { ...m, content: m.content + delta } : m;
    }),
  }));
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  isConnected: false,
  isReconnecting: false,
  wsUrl: null,
  apiToken: null,
  socket: null,
  serverMode: null,
  claudeReady: false,
  streamingMessageId: null,
  activeModel: null,
  availableModels: [],
  contextUsage: null,
  lastResultCost: null,
  lastResultDuration: null,
  inputSettings: {
    chatEnterToSend: true,
    terminalEnterToSend: false,
  },
  savedConnection: null,
  viewMode: 'chat',
  messages: [],
  terminalBuffer: '',

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

  connect: (url: string, token: string, _retryCount = 0) => {
    const MAX_RETRIES = 5;
    const RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000];
    const isReconnect = get().wsUrl === url && get().messages.length > 0;

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
    set({ socket: null, isConnected: false, isReconnecting: isReconnect || _retryCount > 0 });

    if (_retryCount > 0) {
      console.log(`[ws] Connection attempt ${_retryCount + 1}/${MAX_RETRIES + 1}...`);
    }

    // HTTP health check before WebSocket — verify tunnel is up
    const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    fetch(httpUrl, { method: 'GET', signal: controller.signal })
      .finally(() => clearTimeout(timeoutId))
      .then((res) => {
        if (myAttemptId !== connectionAttemptId) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
            get().connect(url, token, _retryCount + 1);
          }, delay);
        } else {
          set({ isReconnecting: false });
          clearConnection();
          set({ savedConnection: null });
          Alert.alert(
            'Connection Failed',
            'Could not reach the Chroxy server. Make sure it\'s running and scan the QR code again.',
          );
        }
      });

    function _connectWebSocket() {
    const socket = new WebSocket(url);

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', token }));
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'auth_ok':
          // On reconnect, preserve messages and terminal buffer
          if (isReconnect) {
            set({ isConnected: true, isReconnecting: false, wsUrl: url, apiToken: token, socket, claudeReady: false, serverMode: null, streamingMessageId: null });
          } else {
            set({ isConnected: true, isReconnecting: false, wsUrl: url, apiToken: token, socket, claudeReady: false, serverMode: null, streamingMessageId: null, messages: [], terminalBuffer: '' });
          }
          socket.send(JSON.stringify({ type: 'mode', mode: get().viewMode }));
          // Save for quick reconnect
          saveConnection(url, token);
          set({ savedConnection: { url, token } });
          break;

        case 'auth_fail':
          socket.close();
          set({ isConnected: false, isReconnecting: false, socket: null });
          Alert.alert('Auth Failed', msg.reason || 'Invalid token');
          break;

        case 'server_mode':
          set({ serverMode: msg.mode });
          // Force chat view in CLI mode (no terminal available)
          if (msg.mode === 'cli' && get().viewMode === 'terminal') {
            set({ viewMode: 'chat' });
          }
          break;

        case 'message': {
          const msgType = msg.messageType || msg.type;
          // Skip server-echoed user_input — we already show it instantly client-side
          if (msgType === 'user_input') break;
          get().addMessage({
            id: nextMessageId(msgType),
            type: msgType,
            content: msg.content,
            tool: msg.tool,
            options: msg.options,
            timestamp: msg.timestamp,
          });
          break;
        }

        case 'stream_start': {
          const streamId = msg.messageId;
          set((state) => {
            // If message with this streamId already exists (multi-block response),
            // just update streamingMessageId without creating a duplicate
            if (state.messages.some((m) => m.id === streamId)) {
              return { streamingMessageId: streamId };
            }
            return {
              streamingMessageId: streamId,
              messages: [
                ...state.messages.filter((m) => m.id !== 'thinking'),
                { id: streamId, type: 'response' as const, content: '', timestamp: Date.now() },
              ],
            };
          });
          break;
        }

        case 'stream_delta': {
          // Batch deltas — accumulate and flush to state periodically
          const deltaId = msg.messageId;
          const existing = pendingDeltas.get(deltaId) || '';
          pendingDeltas.set(deltaId, existing + msg.delta);
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
          set({ streamingMessageId: null });
          break;

        case 'tool_start':
          get().addMessage({
            id: nextMessageId('tool'),
            type: 'tool_use',
            content: msg.input ? JSON.stringify(msg.input) : '',
            tool: msg.tool,
            timestamp: Date.now(),
          });
          break;

        case 'result':
          set({
            contextUsage: msg.usage
              ? {
                  inputTokens: msg.usage.input_tokens || 0,
                  outputTokens: msg.usage.output_tokens || 0,
                  cacheCreation: msg.usage.cache_creation_input_tokens || 0,
                  cacheRead: msg.usage.cache_read_input_tokens || 0,
                }
              : null,
            lastResultCost: typeof msg.cost === 'number' ? msg.cost : null,
            lastResultDuration: typeof msg.duration === 'number' ? msg.duration : null,
          });
          break;

        case 'model_changed':
          set({ activeModel: (typeof msg.model === 'string' && msg.model.trim()) ? msg.model.trim() : null });
          break;

        case 'available_models':
          if (Array.isArray(msg.models)) {
            const cleaned = msg.models
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
              .filter((m): m is ModelInfo => m !== null);
            set({ availableModels: cleaned });
          }
          break;

        case 'raw':
          get().appendTerminalData(msg.data);
          break;

        case 'claude_ready':
          set({ claudeReady: true });
          break;

        case 'raw_background':
          // Buffer raw data even in chat mode so terminal tab is always up to date
          get().appendTerminalData(msg.data);
          break;

        case 'permission_request':
          get().addMessage({
            id: nextMessageId('perm'),
            type: 'prompt',
            content: `${msg.tool}: ${msg.description}`,
            requestId: msg.requestId,
            options: [
              { label: 'Allow', value: 'allow' },
              { label: 'Deny', value: 'deny' },
              { label: 'Always Allow', value: 'allowAlways' },
            ],
            timestamp: Date.now(),
          });
          break;
      }
    };

    socket.onclose = () => {
      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      const wasConnected = get().isConnected;
      set({ isConnected: false, socket: null });

      // Auto-reconnect if the connection dropped unexpectedly (not user-initiated)
      if (wasConnected && disconnectedAttemptId !== myAttemptId) {
        console.log('[ws] Connection lost, auto-reconnecting...');
        set({ isReconnecting: true });
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          get().connect(url, token);
        }, 1500);
      }
    };

    socket.onerror = () => {
      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      set({ isConnected: false, socket: null });

      // Auto-reconnect on unexpected WS error
      if (disconnectedAttemptId !== myAttemptId) {
        console.log('[ws] WebSocket error, reconnecting...');
        set({ isReconnecting: true });
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          get().connect(url, token);
        }, 2000);
      }
    };
    } // end _connectWebSocket
  },

  disconnect: () => {
    disconnectedAttemptId = connectionAttemptId;
    const { socket } = get();
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    // Flush and clear any pending delta buffer
    if (deltaFlushTimer) {
      clearTimeout(deltaFlushTimer);
      deltaFlushTimer = null;
    }
    pendingDeltas.clear();
    set({
      isConnected: false,
      isReconnecting: false,
      socket: null,
      wsUrl: null,
      apiToken: null,
      serverMode: null,
      claudeReady: false,
      streamingMessageId: null,
      activeModel: null,
      availableModels: [],
      contextUsage: null,
      lastResultCost: null,
      lastResultDuration: null,
      messages: [],
      terminalBuffer: '',
    });
    // Keep savedConnection — don't clear it on disconnect
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

  appendTerminalData: (data) => {
    set((state) => ({
      terminalBuffer: (state.terminalBuffer + stripAnsi(data)).slice(-50000),
    }));
  },

  clearTerminalBuffer: () => {
    set({ terminalBuffer: '' });
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
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data: input }));
    }
  },

  sendInterrupt: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'interrupt' }));
    }
  },

  sendPermissionResponse: (requestId: string, decision: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'permission_response', requestId, decision }));
    }
  },

  setModel: (model: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'set_model', model }));
    }
  },

  resize: (cols, rows) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  },
}));
