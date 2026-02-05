import { create } from 'zustand';
import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY_URL = 'chroxy_last_url';
const STORAGE_KEY_TOKEN = 'chroxy_last_token';

export interface ChatMessage {
  id: string;
  type: 'response' | 'user_input' | 'tool_use' | 'thinking';
  content: string;
  tool?: string;
  timestamp: number;
}

interface SavedConnection {
  url: string;
  token: string;
}

interface ConnectionState {
  // Connection
  isConnected: boolean;
  wsUrl: string | null;
  apiToken: string | null;
  socket: WebSocket | null;

  // Saved connection for quick reconnect
  savedConnection: SavedConnection | null;

  // View mode
  viewMode: 'chat' | 'terminal';

  // Chat messages (parsed output)
  messages: ChatMessage[];

  // Raw terminal output buffer
  terminalBuffer: string;

  // Actions
  connect: (url: string, token: string) => void;
  disconnect: () => void;
  loadSavedConnection: () => Promise<void>;
  clearSavedConnection: () => Promise<void>;
  setViewMode: (mode: 'chat' | 'terminal') => void;
  addMessage: (message: ChatMessage) => void;
  appendTerminalData: (data: string) => void;
  sendInput: (input: string) => void;
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

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  isConnected: false,
  wsUrl: null,
  apiToken: null,
  socket: null,
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

  connect: (url: string, token: string) => {
    // Close any existing socket first
    const { socket: existing } = get();
    if (existing) {
      existing.onclose = null;
      existing.onerror = null;
      existing.onmessage = null;
      existing.close();
    }
    set({ socket: null, isConnected: false });

    const socket = new WebSocket(url, undefined, {
      headers: { 'ngrok-skip-browser-warning': '1' },
    } as any);

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
          set({ isConnected: true, wsUrl: url, apiToken: token, socket });
          socket.send(JSON.stringify({ type: 'mode', mode: get().viewMode }));
          // Save for quick reconnect
          saveConnection(url, token);
          set({ savedConnection: { url, token } });
          break;

        case 'auth_fail':
          socket.close();
          set({ isConnected: false, socket: null });
          Alert.alert('Auth Failed', msg.reason || 'Invalid token');
          break;

        case 'message':
          get().addMessage({
            id: `${msg.timestamp}-${Math.random()}`,
            type: msg.messageType || msg.type,
            content: msg.content,
            tool: msg.tool,
            timestamp: msg.timestamp,
          });
          break;

        case 'raw':
          get().appendTerminalData(msg.data);
          break;

        case 'raw_background':
          break;
      }
    };

    socket.onclose = () => {
      set({ isConnected: false, socket: null });
    };

    socket.onerror = () => {
      set({ isConnected: false, socket: null });
      Alert.alert(
        'Connection Failed',
        'Could not reach the Chroxy server. Make sure it\'s running and the URL is correct.',
      );
    };
  },

  disconnect: () => {
    const { socket } = get();
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    set({
      isConnected: false,
      socket: null,
      wsUrl: null,
      apiToken: null,
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
      messages: [...state.messages, message],
    }));
  },

  appendTerminalData: (data) => {
    set((state) => ({
      terminalBuffer: (state.terminalBuffer + data).slice(-50000),
    }));
  },

  sendInput: (input) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data: input }));
    }
  },

  resize: (cols, rows) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  },
}));
