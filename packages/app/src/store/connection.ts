import { create } from 'zustand';
import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY_URL = 'chroxy_last_url';
const STORAGE_KEY_TOKEN = 'chroxy_last_token';

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
  timestamp: number;
}

interface SavedConnection {
  url: string;
  token: string;
}

interface InputSettings {
  chatEnterToSend: boolean;
  terminalEnterToSend: boolean;
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
// Flag to distinguish user-initiated disconnect from unexpected close
let userDisconnected = false;

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  isConnected: false,
  isReconnecting: false,
  wsUrl: null,
  apiToken: null,
  socket: null,
  serverMode: null,
  claudeReady: false,
  streamingMessageId: null,
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
      userDisconnected = false;
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
          break;

        case 'message': {
          const msgType = msg.messageType || msg.type;
          // Skip server-echoed user_input — we already show it instantly client-side
          if (msgType === 'user_input') break;
          get().addMessage({
            id: `${msg.timestamp}-${Math.random()}`,
            type: msgType,
            content: msg.content,
            tool: msg.tool,
            options: msg.options,
            timestamp: msg.timestamp,
          });
          break;
        }

        case 'stream_start': {
          console.log('[ws] stream_start:', msg.messageId);
          const streamId = msg.messageId;
          set((state) => ({
            streamingMessageId: streamId,
            messages: [
              ...state.messages.filter((m) => m.id !== 'thinking'),
              { id: streamId, type: 'response' as const, content: '', timestamp: Date.now() },
            ],
          }));
          break;
        }

        case 'stream_delta': {
          const deltaId = msg.messageId;
          set((state) => ({
            messages: state.messages.map((m) =>
              m.id === deltaId ? { ...m, content: m.content + msg.delta } : m,
            ),
          }));
          break;
        }

        case 'stream_end':
          console.log('[ws] stream_end:', msg.messageId);
          set({ streamingMessageId: null });
          break;

        case 'tool_start':
          get().addMessage({
            id: `tool-${msg.messageId}-${Date.now()}`,
            type: 'tool_use',
            content: msg.input ? JSON.stringify(msg.input) : '',
            tool: msg.tool,
            timestamp: Date.now(),
          });
          break;

        case 'result':
          // Query complete — could display cost info in future
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
      }
    };

    socket.onclose = () => {
      const wasConnected = get().isConnected;
      set({ isConnected: false, socket: null });

      // Auto-reconnect if the connection dropped unexpectedly (not user-initiated)
      if (wasConnected && !userDisconnected) {
        console.log('[ws] Connection lost, auto-reconnecting...');
        set({ isReconnecting: true });
        setTimeout(() => {
          if (userDisconnected) return;
          get().connect(url, token);
        }, 1500);
      }
    };

    socket.onerror = () => {
      // WebSocket failed after health check passed — likely a transient issue
      const wasConnected = get().isConnected;
      set({ isConnected: false, socket: null });

      if (myAttemptId !== connectionAttemptId) return;

      // Auto-reconnect on unexpected WS error (same as onclose logic)
      if (!userDisconnected) {
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
    userDisconnected = true;
    const { socket } = get();
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    set({
      isConnected: false,
      isReconnecting: false,
      socket: null,
      wsUrl: null,
      apiToken: null,
      serverMode: null,
      claudeReady: false,
      streamingMessageId: null,
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
    set((state) => ({
      inputSettings: { ...state.inputSettings, ...settings },
    }));
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

  resize: (cols, rows) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  },
}));
