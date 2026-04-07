/**
 * Integration tests for message-handler.ts — the WebSocket message dispatch.
 *
 * Tests stream lifecycle (stream_start -> stream_delta -> stream_end),
 * permission_request creation, and graceful handling of edge cases.
 *
 * Each test uses unique message IDs to avoid cross-test contamination from
 * module-level Maps (_deltaIdRemaps, _postPermissionSplits, pendingDeltas).
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

// Native modules already mocked in jest.setup.js (AsyncStorage, expo-speech, etc.)

jest.mock('../src/utils/crypto', () => ({
  createKeyPair: jest.fn(),
  deriveSharedKey: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  generateConnectionSalt: jest.fn(() => 'mock-salt'),
  deriveConnectionKey: jest.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}));

jest.mock('../src/notifications', () => ({
  registerForPushNotifications: jest.fn(),
}));

jest.mock('../src/utils/haptics', () => ({
  hapticSuccess: jest.fn(),
}));

jest.mock('../src/store/persistence', () => ({
  clearPersistedSession: jest.fn(),
}));

jest.mock('../src/store/imperative-callbacks', () => ({
  getCallback: jest.fn(() => undefined),
}));

jest.mock('../src/store/multi-client', () => ({
  useMultiClientStore: { getState: jest.fn(() => ({ setClients: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/web', () => ({
  useWebStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/cost', () => ({
  useCostStore: { getState: jest.fn(() => ({ handleCostUpdate: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/terminal', () => ({
  useTerminalStore: { getState: jest.fn(() => ({ appendTerminalData: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/notifications', () => ({
  useNotificationStore: { getState: jest.fn(() => ({ addNotification: jest.fn(), dismissNotification: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/conversations', () => ({
  useConversationStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@chroxy/store-core', () => ({
  ...jest.requireActual('../../store-core/src/index'),
  parseUserInputMessage: jest.fn((text: string) => ({ type: 'text', content: text })),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  handleMessage,
  setStore,
  setConnectionContext,
  clearDeltaBuffers,
} from '../src/store/message-handler';
import { createEmptySessionState } from '../src/store/utils';
import type { ConnectionState, SessionState } from '../src/store/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-1';

/** Build a minimal ConnectionState with one session. */
function createMockState(overrides?: Partial<SessionState>): Partial<ConnectionState> {
  return {
    activeSessionId: SESSION_ID,
    sessionStates: {
      [SESSION_ID]: { ...createEmptySessionState(), ...overrides },
    },
    appendTerminalData: jest.fn(),
  } as unknown as Partial<ConnectionState>;
}

/** Create a mock store compatible with setStore(). */
function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState;
  const store = {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s;
      state = { ...state, ...patch };
    },
  };
  return store;
}

/** Minimal connection context so handleMessage doesn't bail early. */
const mockCtx = {
  url: 'wss://test.example.com',
  token: 'test-token',
  socket: {} as WebSocket,
  isReconnect: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('message-handler', () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    jest.useFakeTimers();
    clearDeltaBuffers();
    store = createMockStore(createMockState());
    setStore(store);
    setConnectionContext(mockCtx as any);
  });

  afterEach(() => {
    clearDeltaBuffers();
    jest.runAllTimers();
    jest.useRealTimers();
    setConnectionContext(null);
  });

  // ---- stream_start ----

  describe('stream_start', () => {
    it('creates a new response message in the session', () => {
      handleMessage({
        type: 'stream_start',
        messageId: 'start-1',
        sessionId: SESSION_ID,
      });

      const ss = store.getState().sessionStates[SESSION_ID];
      expect(ss.messages).toHaveLength(1);
      expect(ss.messages[0]).toMatchObject({
        id: 'start-1',
        type: 'response',
        content: '',
      });
      expect(ss.streamingMessageId).toBe('start-1');
    });

    it('reuses existing response message on reconnect replay', () => {
      store = createMockStore(createMockState({
        messages: [{ id: 'start-2', type: 'response', content: 'old content', timestamp: 1000 }],
      }));
      setStore(store);

      handleMessage({
        type: 'stream_start',
        messageId: 'start-2',
        sessionId: SESSION_ID,
      });

      const ss = store.getState().sessionStates[SESSION_ID];
      expect(ss.messages).toHaveLength(1);
      expect(ss.messages[0].content).toBe('old content');
      expect(ss.streamingMessageId).toBe('start-2');
    });

    it('creates suffixed ID when colliding with non-response message', () => {
      store = createMockStore(createMockState({
        messages: [{ id: 'start-3', type: 'tool_use', content: 'tool content', timestamp: 1000 }],
      }));
      setStore(store);

      handleMessage({
        type: 'stream_start',
        messageId: 'start-3',
        sessionId: SESSION_ID,
      });

      const ss = store.getState().sessionStates[SESSION_ID];
      expect(ss.messages).toHaveLength(2);
      expect(ss.messages[1]).toMatchObject({
        id: 'start-3-response',
        type: 'response',
        content: '',
      });
      expect(ss.streamingMessageId).toBe('start-3-response');
    });
  });

  // ---- stream_delta ----

  describe('stream_delta', () => {
    it('appends content to the existing response message after flush', () => {
      handleMessage({ type: 'stream_start', messageId: 'delta-1', sessionId: SESSION_ID });
      handleMessage({ type: 'stream_delta', messageId: 'delta-1', sessionId: SESSION_ID, delta: 'Hello ' });

      jest.advanceTimersByTime(150);

      const ss = store.getState().sessionStates[SESSION_ID];
      const msg = ss.messages.find((m: any) => m.id === 'delta-1');
      expect(msg).toBeDefined();
      expect(msg!.content).toBe('Hello ');
    });

    it('accumulates multiple deltas before flush', () => {
      handleMessage({ type: 'stream_start', messageId: 'delta-2', sessionId: SESSION_ID });
      handleMessage({ type: 'stream_delta', messageId: 'delta-2', sessionId: SESSION_ID, delta: 'Hello ' });
      handleMessage({ type: 'stream_delta', messageId: 'delta-2', sessionId: SESSION_ID, delta: 'world!' });

      jest.advanceTimersByTime(150);

      const ss = store.getState().sessionStates[SESSION_ID];
      const msg = ss.messages.find((m: any) => m.id === 'delta-2');
      expect(msg!.content).toBe('Hello world!');
    });

    it('handles delta for non-existent session gracefully', () => {
      expect(() => {
        handleMessage({
          type: 'stream_delta',
          messageId: 'delta-orphan',
          sessionId: 'nonexistent-session',
          delta: 'orphan data',
        });
        jest.advanceTimersByTime(150);
      }).not.toThrow();
    });
  });

  // ---- stream_end ----

  describe('stream_end', () => {
    it('clears streamingMessageId and flushes pending deltas', () => {
      handleMessage({ type: 'stream_start', messageId: 'end-1', sessionId: SESSION_ID });
      handleMessage({ type: 'stream_delta', messageId: 'end-1', sessionId: SESSION_ID, delta: 'Complete response' });
      handleMessage({ type: 'stream_end', messageId: 'end-1', sessionId: SESSION_ID });

      const ss = store.getState().sessionStates[SESSION_ID];
      expect(ss.streamingMessageId).toBeNull();
      const msg = ss.messages.find((m: any) => m.id === 'end-1');
      expect(msg!.content).toBe('Complete response');
    });

    it('works when there are no pending deltas', () => {
      handleMessage({ type: 'stream_start', messageId: 'end-2', sessionId: SESSION_ID });

      expect(() => {
        handleMessage({ type: 'stream_end', messageId: 'end-2', sessionId: SESSION_ID });
      }).not.toThrow();

      const ss = store.getState().sessionStates[SESSION_ID];
      expect(ss.streamingMessageId).toBeNull();
    });
  });

  // ---- permission_request ----

  describe('permission_request', () => {
    it('creates a prompt message with options', () => {
      handleMessage({
        type: 'permission_request',
        requestId: 'perm-1',
        tool: 'Write',
        description: 'Write to file.txt',
        sessionId: SESSION_ID,
      });

      const ss = store.getState().sessionStates[SESSION_ID];
      const permMsg = ss.messages.find((m: any) => m.type === 'prompt');
      expect(permMsg).toBeDefined();
      expect(permMsg!.requestId).toBe('perm-1');
      expect(permMsg!.content).toContain('Write');
      expect(permMsg!.content).toContain('file.txt');
      expect(permMsg!.options).toEqual([
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' },
        { label: 'Allow for Session', value: 'allowSession' },
      ]);
    });

    it('updates existing permission with same requestId instead of duplicating', () => {
      handleMessage({
        type: 'permission_request',
        requestId: 'perm-dedup',
        tool: 'Write',
        description: 'Write to file.txt',
        sessionId: SESSION_ID,
      });

      handleMessage({
        type: 'permission_request',
        requestId: 'perm-dedup',
        tool: 'Write',
        description: 'Write to file.txt',
        remainingMs: 30000,
        sessionId: SESSION_ID,
      });

      const ss = store.getState().sessionStates[SESSION_ID];
      const permMsgs = ss.messages.filter((m: any) => m.type === 'prompt' && m.requestId === 'perm-dedup');
      expect(permMsgs).toHaveLength(1);
      expect(permMsgs[0].expiresAt).toBeDefined();
    });

    it('includes tool input when provided', () => {
      handleMessage({
        type: 'permission_request',
        requestId: 'perm-input',
        tool: 'Bash',
        description: 'Run command',
        input: { command: 'ls -la' },
        sessionId: SESSION_ID,
      });

      const ss = store.getState().sessionStates[SESSION_ID];
      const permMsg = ss.messages.find((m: any) => m.requestId === 'perm-input');
      expect(permMsg!.toolInput).toEqual({ command: 'ls -la' });
    });
  });

  // ---- Full stream lifecycle ----

  describe('full stream lifecycle', () => {
    it('handles start -> delta -> delta -> end correctly', () => {
      handleMessage({ type: 'stream_start', messageId: 'lifecycle-1', sessionId: SESSION_ID });
      handleMessage({ type: 'stream_delta', messageId: 'lifecycle-1', sessionId: SESSION_ID, delta: 'Part 1. ' });
      handleMessage({ type: 'stream_delta', messageId: 'lifecycle-1', sessionId: SESSION_ID, delta: 'Part 2.' });
      handleMessage({ type: 'stream_end', messageId: 'lifecycle-1', sessionId: SESSION_ID });

      const ss = store.getState().sessionStates[SESSION_ID];
      expect(ss.streamingMessageId).toBeNull();
      expect(ss.messages).toHaveLength(1);
      expect(ss.messages[0].content).toBe('Part 1. Part 2.');
      expect(ss.messages[0].type).toBe('response');
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('ignores messages with no type', () => {
      expect(() => {
        handleMessage({ content: 'no type field' });
      }).not.toThrow();
    });

    it('ignores null/undefined/array messages', () => {
      expect(() => {
        handleMessage(null);
        handleMessage(undefined);
        handleMessage([1, 2, 3]);
      }).not.toThrow();
    });

    it('ignores messages when connection context is null', () => {
      setConnectionContext(null);
      expect(() => {
        handleMessage({ type: 'stream_start', messageId: 'ctx-null', sessionId: SESSION_ID });
      }).not.toThrow();
    });
  });
});
