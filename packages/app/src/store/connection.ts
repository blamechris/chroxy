import { create } from 'zustand';

export interface ChatMessage {
  id: string;
  type: 'response' | 'user_input' | 'tool_use' | 'thinking';
  content: string;
  tool?: string;
  timestamp: number;
}

interface ConnectionState {
  // Connection
  isConnected: boolean;
  wsUrl: string | null;
  apiToken: string | null;
  socket: WebSocket | null;

  // View mode
  viewMode: 'chat' | 'terminal';

  // Chat messages (parsed output)
  messages: ChatMessage[];

  // Raw terminal output buffer
  terminalBuffer: string;

  // Actions
  connect: (url: string, token: string) => void;
  disconnect: () => void;
  setViewMode: (mode: 'chat' | 'terminal') => void;
  addMessage: (message: ChatMessage) => void;
  appendTerminalData: (data: string) => void;
  sendInput: (input: string) => void;
  resize: (cols: number, rows: number) => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  isConnected: false,
  wsUrl: null,
  apiToken: null,
  socket: null,
  viewMode: 'chat',
  messages: [],
  terminalBuffer: '',

  connect: (url: string, token: string) => {
    const socket = new WebSocket(url);

    socket.onopen = () => {
      // Authenticate immediately
      socket.send(JSON.stringify({ type: 'auth', token }));
    };

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'auth_ok':
          set({ isConnected: true, wsUrl: url, apiToken: token, socket });
          // Request current view mode
          socket.send(JSON.stringify({ type: 'mode', mode: get().viewMode }));
          break;

        case 'auth_fail':
          console.error('Auth failed:', msg.reason);
          socket.close();
          set({ isConnected: false, socket: null });
          break;

        case 'message':
          // Parsed chat message
          get().addMessage({
            id: `${msg.timestamp}-${Math.random()}`,
            type: msg.type,
            content: msg.content,
            tool: msg.tool,
            timestamp: msg.timestamp,
          });
          break;

        case 'raw':
          // Raw terminal output
          get().appendTerminalData(msg.data);
          break;

        case 'raw_background':
          // Background raw data (for chat mode, store but don't display prominently)
          // Could be used for embedded terminal preview
          break;
      }
    };

    socket.onclose = () => {
      set({ isConnected: false, socket: null });
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  },

  disconnect: () => {
    const { socket } = get();
    if (socket) {
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
      // Keep last 50KB of terminal output
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
