/**
 * Desktop Zustand store tests (#1094)
 *
 * Covers: persistence, utils, types, and store creation.
 * Message handler and connection tests require the ported files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stripAnsi, filterThinking, nextMessageId, withJitter, createEmptySessionState } from './utils';
import type { ChatMessage, SessionState, ConnectionPhase } from './types';
import {
  persistViewMode,
  persistActiveSession,
  loadPersistedState,
  loadSessionMessages,
  clearPersistedState,
  _resetForTesting,
} from './persistence';
import {
  createKeyPair,
  deriveSharedKey,
  encrypt,
  decrypt,
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
} from './crypto';

// ---------------------------------------------------------------------------
// Utils tests
// ---------------------------------------------------------------------------
describe('utils', () => {
  it('stripAnsi removes ANSI escape codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('plain text')).toBe('plain text');
    expect(stripAnsi('\x1b[1;32mgreen bold\x1b[0m')).toBe('green bold');
  });

  it('filterThinking removes thinking placeholder', () => {
    const messages: ChatMessage[] = [
      { id: 'msg-1', type: 'response', content: 'hello', timestamp: 1 },
      { id: 'thinking', type: 'thinking', content: '...', timestamp: 2 },
      { id: 'msg-2', type: 'response', content: 'world', timestamp: 3 },
    ];
    const filtered = filterThinking(messages);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(m => m.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('nextMessageId generates unique monotonic IDs', () => {
    const id1 = nextMessageId('test');
    const id2 = nextMessageId('test');
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^test-\d+-\d+$/);
    // Counter is monotonically increasing
    const counter1 = parseInt(id1.split('-')[1]!);
    const counter2 = parseInt(id2.split('-')[1]!);
    expect(counter2).toBeGreaterThan(counter1);
  });

  it('withJitter adds 0-50% jitter to delay', () => {
    const base = 1000;
    for (let i = 0; i < 20; i++) {
      const jittered = withJitter(base);
      expect(jittered).toBeGreaterThanOrEqual(base);
      expect(jittered).toBeLessThan(base * 1.5);
    }
  });

  it('createEmptySessionState returns fresh state', () => {
    const state = createEmptySessionState();
    expect(state.messages).toEqual([]);
    expect(state.claudeReady).toBe(false);
    expect(state.activeModel).toBeNull();
    expect(state.isIdle).toBe(true);
    expect(state.health).toBe('healthy');
    expect(state.activeAgents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Persistence tests (localStorage)
// ---------------------------------------------------------------------------
describe('persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
  });

  it('persistViewMode and loadPersistedState round-trips view mode', () => {
    persistViewMode('terminal');
    const state = loadPersistedState();
    expect(state.viewMode).toBe('terminal');
  });

  it('loadPersistedState returns null for invalid view mode', () => {
    localStorage.setItem('chroxy_persist_view_mode', 'invalid');
    const state = loadPersistedState();
    expect(state.viewMode).toBeNull();
  });

  it('persistActiveSession and loadPersistedState round-trips session ID', () => {
    persistActiveSession('session-abc');
    const state = loadPersistedState();
    expect(state.activeSessionId).toBe('session-abc');
  });

  it('persistActiveSession(null) removes the key', () => {
    persistActiveSession('session-abc');
    persistActiveSession(null);
    const state = loadPersistedState();
    expect(state.activeSessionId).toBeNull();
  });

  it('loadSessionMessages returns empty array for unknown session', () => {
    const msgs = loadSessionMessages('nonexistent');
    expect(msgs).toEqual([]);
  });

  it('clearPersistedState removes session keys but preserves global settings', () => {
    persistViewMode('chat');
    persistActiveSession('sess-1');
    localStorage.setItem('other_key', 'keep');
    clearPersistedState();
    expect(localStorage.getItem('other_key')).toBe('keep');
    const state = loadPersistedState();
    // Global settings (view mode) are preserved
    expect(state.viewMode).toBe('chat');
    // Session-specific data is cleared
    expect(state.activeSessionId).toBeNull();
  });

  it('loadPersistedState returns defaults when empty', () => {
    const state = loadPersistedState();
    expect(state.viewMode).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(state.terminalBuffer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Crypto tests (E2E encryption)
// ---------------------------------------------------------------------------
describe('crypto', () => {
  it('createKeyPair generates base64 public key', () => {
    const kp = createKeyPair();
    expect(kp.publicKey).toBeTruthy();
    expect(typeof kp.publicKey).toBe('string');
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
  });

  it('deriveSharedKey produces same key for both parties', () => {
    const alice = createKeyPair();
    const bob = createKeyPair();
    const aliceShared = deriveSharedKey(bob.publicKey, alice.secretKey);
    const bobShared = deriveSharedKey(alice.publicKey, bob.secretKey);
    expect(aliceShared).toEqual(bobShared);
  });

  it('encrypt/decrypt round-trips JSON message', () => {
    const alice = createKeyPair();
    const bob = createKeyPair();
    const sharedKey = deriveSharedKey(bob.publicKey, alice.secretKey);

    const original = { type: 'test', data: 'hello world' };
    const envelope = encrypt(JSON.stringify(original), sharedKey, 0, DIRECTION_CLIENT);

    expect(envelope.type).toBe('encrypted');
    expect(envelope.n).toBe(0);

    const decrypted = decrypt(envelope, sharedKey, 0, DIRECTION_CLIENT);
    expect(decrypted).toEqual(original);
  });

  it('decrypt rejects wrong nonce', () => {
    const alice = createKeyPair();
    const bob = createKeyPair();
    const sharedKey = deriveSharedKey(bob.publicKey, alice.secretKey);

    const envelope = encrypt('{"test":true}', sharedKey, 0, DIRECTION_CLIENT);
    expect(() => decrypt(envelope, sharedKey, 1, DIRECTION_CLIENT)).toThrow('Unexpected nonce');
  });

  it('decrypt rejects wrong direction', () => {
    const alice = createKeyPair();
    const bob = createKeyPair();
    const sharedKey = deriveSharedKey(bob.publicKey, alice.secretKey);

    const envelope = encrypt('{"test":true}', sharedKey, 0, DIRECTION_CLIENT);
    expect(() => decrypt(envelope, sharedKey, 0, DIRECTION_SERVER)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Types compile test (ensures types.ts exports correctly)
// ---------------------------------------------------------------------------
describe('types', () => {
  it('ConnectionPhase union type works', () => {
    const phases: ConnectionPhase[] = [
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
      'server_restarting',
    ];
    expect(phases).toHaveLength(5);
  });

  it('SessionState shape matches expected fields', () => {
    const state: SessionState = createEmptySessionState();
    expect(state).toHaveProperty('messages');
    expect(state).toHaveProperty('streamingMessageId');
    expect(state).toHaveProperty('claudeReady');
    expect(state).toHaveProperty('activeModel');
    expect(state).toHaveProperty('permissionMode');
    expect(state).toHaveProperty('contextUsage');
    expect(state).toHaveProperty('isIdle');
    expect(state).toHaveProperty('health');
    expect(state).toHaveProperty('activeAgents');
    expect(state).toHaveProperty('isPlanPending');
    expect(state).toHaveProperty('sessionContext');
    expect(state).toHaveProperty('mcpServers');
    expect(state).toHaveProperty('devPreviews');
  });
});

// ---------------------------------------------------------------------------
// No React Native imports check
// ---------------------------------------------------------------------------
describe('no React Native imports', () => {
  it('types.ts has no RN imports', async () => {
    const content = await import('./types?raw');
    // Type module — no runtime imports to check, but verify it loads
    expect(content).toBeDefined();
  });

  it('utils.ts has no RN imports', async () => {
    // If utils imported react-native, this would throw in jsdom
    const utils = await import('./utils');
    expect(utils.stripAnsi).toBeInstanceOf(Function);
    expect(utils.filterThinking).toBeInstanceOf(Function);
    expect(utils.nextMessageId).toBeInstanceOf(Function);
  });

  it('persistence.ts has no RN imports', async () => {
    // If persistence imported AsyncStorage, this would throw in jsdom
    const persistence = await import('./persistence');
    expect(persistence.persistViewMode).toBeInstanceOf(Function);
    expect(persistence.loadPersistedState).toBeInstanceOf(Function);
  });

  it('crypto.ts has no RN imports', async () => {
    const crypto = await import('./crypto');
    expect(crypto.createKeyPair).toBeInstanceOf(Function);
    expect(crypto.encrypt).toBeInstanceOf(Function);
    expect(crypto.decrypt).toBeInstanceOf(Function);
  });

  it('connection.ts has no RN imports', async () => {
    const conn = await import('./connection');
    expect(conn.useConnectionStore).toBeDefined();
  });

  it('message-handler.ts has no RN imports', async () => {
    const mh = await import('./message-handler');
    expect(mh.wsSend).toBeInstanceOf(Function);
    expect(mh.handleMessage).toBeInstanceOf(Function);
    expect(mh._testMessageHandler).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Zustand store tests
// ---------------------------------------------------------------------------
describe('useConnectionStore', () => {
  it('creates store with correct initial state', async () => {
    const { useConnectionStore } = await import('./connection');
    const state = useConnectionStore.getState();

    expect(state.connectionPhase).toBe('disconnected');
    expect(state.wsUrl).toBeNull();
    expect(state.apiToken).toBeNull();
    expect(state.socket).toBeNull();
    expect(state.sessions).toEqual([]);
    expect(state.activeSessionId).toBeNull();
    expect(state.sessionStates).toEqual({});
    expect(state.messages).toEqual([]);
    expect(state.availableModels).toEqual([]);
    expect(state.viewMode).toBe('chat');
  });

  it('exposes all required actions', async () => {
    const { useConnectionStore } = await import('./connection');
    const state = useConnectionStore.getState();

    // Connection actions
    expect(typeof state.connect).toBe('function');
    expect(typeof state.disconnect).toBe('function');
    expect(typeof state.loadSavedConnection).toBe('function');

    // Message actions
    expect(typeof state.sendInput).toBe('function');
    expect(typeof state.sendInterrupt).toBe('function');
    expect(typeof state.sendPermissionResponse).toBe('function');
    expect(typeof state.sendUserQuestionResponse).toBe('function');

    // Session actions
    expect(typeof state.switchSession).toBe('function');
    expect(typeof state.createSession).toBe('function');
    expect(typeof state.destroySession).toBe('function');
    expect(typeof state.renameSession).toBe('function');

    // Model/permission actions
    expect(typeof state.setModel).toBe('function');
    expect(typeof state.setPermissionMode).toBe('function');

    // View actions
    expect(typeof state.setViewMode).toBe('function');
    expect(typeof state.appendTerminalData).toBe('function');

    // Plan mode
    expect(typeof state.clearPlanState).toBe('function');
  });

  it('switchSession updates activeSessionId even without cached state', async () => {
    const { useConnectionStore } = await import('./connection');

    const makeSession = (id: string) => ({
      sessionId: id, name: id, cwd: '/tmp', type: 'cli' as const,
      hasTerminal: false, model: null, permissionMode: null, isBusy: false,
      createdAt: 0, conversationId: null,
    });

    useConnectionStore.setState({
      sessions: [makeSession('session-a'), makeSession('session-b')],
      activeSessionId: 'session-a',
      sessionStates: {},
    });

    useConnectionStore.getState().switchSession('session-b');

    expect(useConnectionStore.getState().activeSessionId).toBe('session-b');
    expect(useConnectionStore.getState().messages).toEqual([]);

    // Cleanup
    useConnectionStore.setState({ sessions: [], activeSessionId: null, sessionStates: {}, messages: [] });
  });

  it('switchSession uses cached messages when state exists', async () => {
    const { useConnectionStore } = await import('./connection');

    const makeSession = (id: string) => ({
      sessionId: id, name: id, cwd: '/tmp', type: 'cli' as const,
      hasTerminal: false, model: null, permissionMode: null, isBusy: false,
      createdAt: 0, conversationId: null,
    });
    const cachedMsg = { id: 'msg-1', type: 'response' as const, content: 'cached', timestamp: 1 };

    useConnectionStore.setState({
      sessions: [makeSession('session-a'), makeSession('session-b')],
      activeSessionId: 'session-a',
      sessionStates: {
        'session-b': { ...createEmptySessionState(), messages: [cachedMsg] },
      },
    });

    useConnectionStore.getState().switchSession('session-b');

    expect(useConnectionStore.getState().activeSessionId).toBe('session-b');
    expect(useConnectionStore.getState().messages).toEqual([cachedMsg]);

    // Cleanup
    useConnectionStore.setState({ sessions: [], activeSessionId: null, sessionStates: {}, messages: [] });
  });

  it('addMessage appends to messages array', async () => {
    const { useConnectionStore } = await import('./connection');
    const msg: ChatMessage = {
      id: 'test-1',
      type: 'response',
      content: 'Hello world',
      timestamp: Date.now(),
    };

    useConnectionStore.getState().addMessage(msg);
    const { messages } = useConnectionStore.getState();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Hello world');
  });

  it('setViewMode updates view mode', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.getState().setViewMode('terminal');
    expect(useConnectionStore.getState().viewMode).toBe('terminal');
  });

  it('appendTerminalData grows terminal buffer', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.getState().appendTerminalData('$ ls\n');
    useConnectionStore.getState().appendTerminalData('file.txt\n');
    const { terminalBuffer } = useConnectionStore.getState();
    expect(terminalBuffer).toContain('ls');
    expect(terminalBuffer).toContain('file.txt');
  });
});

// ---------------------------------------------------------------------------
// Message handler tests
// ---------------------------------------------------------------------------
describe('message handler', () => {
  it('_testMessageHandler exposes handle and context setters', async () => {
    const { _testMessageHandler } = await import('./message-handler');
    expect(typeof _testMessageHandler.handle).toBe('function');
    expect(typeof _testMessageHandler.setContext).toBe('function');
    expect(typeof _testMessageHandler.clearContext).toBe('function');
  });

  it('_testQueueInternals exposes queue operations', async () => {
    const { _testQueueInternals } = await import('./message-handler');
    expect(typeof _testQueueInternals.getQueue).toBe('function');
    expect(typeof _testQueueInternals.enqueue).toBe('function');
    expect(typeof _testQueueInternals.drain).toBe('function');
    expect(typeof _testQueueInternals.clear).toBe('function');

    // Queue starts empty
    _testQueueInternals.clear();
    expect(_testQueueInternals.getQueue()).toHaveLength(0);
  });

  it('wsSend serializes and sends JSON', async () => {
    const { wsSend } = await import('./message-handler');
    const sent: string[] = [];
    const mockSocket = {
      send: (data: string) => sent.push(data),
      readyState: 1,
    } as unknown as WebSocket;

    wsSend(mockSocket, { type: 'test', data: 'hello' });
    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]!);
    expect(parsed.type).toBe('test');
    expect(parsed.data).toBe('hello');
  });

  it('session_error surfaces non-crash errors via addServerError', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    // Set up a mock connection context so handleMessage doesn't bail
    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    // Clear any prior server errors
    useConnectionStore.setState({ serverErrors: [] });

    // Feed a non-crash session_error (handleMessage expects a parsed object)
    _testMessageHandler.handle({
      type: 'session_error',
      category: 'validation',
      message: 'Invalid working directory',
    });

    const { serverErrors } = useConnectionStore.getState();
    expect(serverErrors.length).toBeGreaterThanOrEqual(1);
    expect(serverErrors.some((e: { message: string }) => e.message === 'Invalid working directory')).toBe(true);

    _testMessageHandler.clearContext();
  });

  it('user_input from another client is added to session messages', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      myClientId: 'client-a',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
      },
    });

    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    _testMessageHandler.handle({
      type: 'user_input',
      sessionId: 's1',
      clientId: 'client-b',
      text: 'Hello from phone',
      timestamp: 1000,
    });

    const { sessionStates } = useConnectionStore.getState();
    const msgs = sessionStates.s1!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe('user_input');
    expect(msgs[0]!.content).toBe('Hello from phone');

    _testMessageHandler.clearContext();
  });

  it('user_input from self (same clientId) is skipped', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      myClientId: 'client-a',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
      },
    });

    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    _testMessageHandler.handle({
      type: 'user_input',
      sessionId: 's1',
      clientId: 'client-a',
      text: 'My own message',
      timestamp: 1000,
    });

    const { sessionStates } = useConnectionStore.getState();
    expect(sessionStates.s1!.messages).toHaveLength(0);

    _testMessageHandler.clearContext();
  });
});

// ---------------------------------------------------------------------------
// System message routing (#1706)
// ---------------------------------------------------------------------------
describe('system message routing', () => {
  const mockContext = {
    url: 'ws://localhost:3000',
    token: 'test-token',
    isReconnect: false,
    silent: false,
    socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
  };

  it('client_joined adds system message to ALL session states', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      connectedClients: [],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [] },
      },
    });
    _testMessageHandler.setContext(mockContext);

    _testMessageHandler.handle({
      type: 'client_joined',
      client: { clientId: 'phone-1', deviceName: 'iPhone 17 Pro', deviceType: 'phone', platform: 'ios' },
    });

    const { sessionStates } = useConnectionStore.getState();
    expect(sessionStates.s1!.messages.some((m) => m.content.includes('iPhone 17 Pro'))).toBe(true);
    expect(sessionStates.s2!.messages.some((m) => m.content.includes('iPhone 17 Pro'))).toBe(true);

    _testMessageHandler.clearContext();
    useConnectionStore.setState({ sessionStates: {}, activeSessionId: null, connectedClients: [] });
  });

  it('client_left adds system message to ALL session states', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      connectedClients: [{ clientId: 'phone-1', deviceName: 'My Phone', deviceType: 'phone', platform: 'ios', isSelf: false }],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [] },
      },
    });
    _testMessageHandler.setContext(mockContext);

    _testMessageHandler.handle({ type: 'client_left', clientId: 'phone-1' });

    const { sessionStates } = useConnectionStore.getState();
    expect(sessionStates.s1!.messages.some((m) => m.content.includes('disconnected'))).toBe(true);
    expect(sessionStates.s2!.messages.some((m) => m.content.includes('disconnected'))).toBe(true);

    _testMessageHandler.clearContext();
    useConnectionStore.setState({ sessionStates: {}, activeSessionId: null, connectedClients: [] });
  });

  it('client_joined updates all session states in a single setState call', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler, setStore } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      connectedClients: [],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [] },
        s3: { ...createEmptySessionState(), messages: [] },
      },
    });
    _testMessageHandler.setContext(mockContext);

    // Intercept via setStore so we count the same setState reference
    // that handleMessage's set() closure calls through getStore().
    let setStateCalls = 0;
    const origSetState = useConnectionStore.setState;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = (...args: any[]) => { setStateCalls++; return (origSetState as any)(...args); };
    try {
      setStore({
        getState: useConnectionStore.getState,
        setState: spy,
      });

      _testMessageHandler.handle({
        type: 'client_joined',
        client: { clientId: 'phone-1', deviceName: 'iPhone', deviceType: 'phone', platform: 'ios' },
      });

      // Should use at most 2 setState calls: 1 for connectedClients, 1 for sessionStates+flat
      expect(setStateCalls).toBeLessThanOrEqual(2);

      // Behavior preserved: message appears in all sessions
      const { sessionStates } = useConnectionStore.getState();
      expect(sessionStates.s1!.messages.some((m) => m.content.includes('iPhone'))).toBe(true);
      expect(sessionStates.s2!.messages.some((m) => m.content.includes('iPhone'))).toBe(true);
      expect(sessionStates.s3!.messages.some((m) => m.content.includes('iPhone'))).toBe(true);
    } finally {
      // Restore the original store binding
      setStore({
        getState: useConnectionStore.getState,
        setState: origSetState,
      });
      _testMessageHandler.clearContext();
      origSetState({ sessionStates: {}, activeSessionId: null, connectedClients: [] });
    }
  });

  it('client_left updates all session states in a single setState call', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler, setStore } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      connectedClients: [{ clientId: 'phone-1', deviceName: 'My Phone', deviceType: 'phone', platform: 'ios', isSelf: false }],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [] },
        s3: { ...createEmptySessionState(), messages: [] },
      },
    });
    _testMessageHandler.setContext(mockContext);

    // Intercept via setStore so we count the same setState reference
    // that handleMessage's set() closure calls through getStore().
    let setStateCalls = 0;
    const origSetState = useConnectionStore.setState;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = (...args: any[]) => { setStateCalls++; return (origSetState as any)(...args); };
    try {
      setStore({
        getState: useConnectionStore.getState,
        setState: spy,
      });

      _testMessageHandler.handle({ type: 'client_left', clientId: 'phone-1' });

      // Should use at most 2 setState calls: 1 for connectedClients, 1 for sessionStates+flat
      expect(setStateCalls).toBeLessThanOrEqual(2);

      // Behavior preserved
      const { sessionStates } = useConnectionStore.getState();
      expect(sessionStates.s1!.messages.some((m) => m.content.includes('disconnected'))).toBe(true);
      expect(sessionStates.s2!.messages.some((m) => m.content.includes('disconnected'))).toBe(true);
      expect(sessionStates.s3!.messages.some((m) => m.content.includes('disconnected'))).toBe(true);
    } finally {
      // Restore the original store binding
      setStore({
        getState: useConnectionStore.getState,
        setState: origSetState,
      });
      _testMessageHandler.clearContext();
      origSetState({ sessionStates: {}, activeSessionId: null, connectedClients: [] });
    }
  });

  it('server_error with sessionId routes only to that session', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      serverErrors: [],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [] },
      },
    });
    _testMessageHandler.setContext(mockContext);

    _testMessageHandler.handle({
      type: 'server_error',
      category: 'session',
      message: 'Process exited with code 1',
      recoverable: true,
      sessionId: 's2',
    });

    const { sessionStates } = useConnectionStore.getState();
    expect(sessionStates.s2!.messages.some((m) => m.content.includes('Process exited'))).toBe(true);
    expect(sessionStates.s1!.messages).toHaveLength(0);

    _testMessageHandler.clearContext();
    useConnectionStore.setState({ sessionStates: {}, activeSessionId: null, serverErrors: [] });
  });

  it('server_error without sessionId routes to active session', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      serverErrors: [],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [] },
      },
    });
    _testMessageHandler.setContext(mockContext);

    _testMessageHandler.handle({
      type: 'server_error',
      category: 'tunnel',
      message: 'Tunnel connection lost',
      recoverable: true,
    });

    const { sessionStates } = useConnectionStore.getState();
    expect(sessionStates.s1!.messages.some((m) => m.content.includes('Tunnel connection lost'))).toBe(true);

    _testMessageHandler.clearContext();
    useConnectionStore.setState({ sessionStates: {}, activeSessionId: null, serverErrors: [] });
  });

  it('server_error with sessionId stores sessionId on ServerError object', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      serverErrors: [],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [] },
      },
    });
    _testMessageHandler.setContext(mockContext);

    _testMessageHandler.handle({
      type: 'server_error',
      category: 'session',
      message: 'Process exited',
      recoverable: true,
      sessionId: 's2',
    });

    const { serverErrors } = useConnectionStore.getState();
    expect(serverErrors).toHaveLength(1);
    expect(serverErrors[0]!.sessionId).toBe('s2');

    _testMessageHandler.clearContext();
    useConnectionStore.setState({ sessionStates: {}, activeSessionId: null, serverErrors: [] });
  });

  it('server_error without sessionId has no sessionId on ServerError object', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      serverErrors: [],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
    });
    _testMessageHandler.setContext(mockContext);

    _testMessageHandler.handle({
      type: 'server_error',
      category: 'tunnel',
      message: 'Tunnel lost',
      recoverable: false,
    });

    const { serverErrors } = useConnectionStore.getState();
    expect(serverErrors).toHaveLength(1);
    expect(serverErrors[0]!.sessionId).toBeUndefined();

    _testMessageHandler.clearContext();
    useConnectionStore.setState({ sessionStates: {}, activeSessionId: null, serverErrors: [] });
  });
});

// ---------------------------------------------------------------------------
// Permission response auto-switch (#1710)
// ---------------------------------------------------------------------------
describe('permission response auto-switch', () => {
  it('switches to session that owns the permission when different from active', async () => {
    const { useConnectionStore } = await import('./connection');

    const makeMsg = (id: string, reqId: string) => ({
      id,
      type: 'prompt' as const,
      content: 'Allow?',
      timestamp: 1,
      requestId: reqId,
    });

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [makeMsg('m1', 'req-a')] },
        s2: { ...createEmptySessionState(), messages: [makeMsg('m2', 'req-b')] },
      },
      socket: { readyState: 1, send: () => {} } as unknown as WebSocket,
    });

    useConnectionStore.getState().sendPermissionResponse('req-b', 'allow');

    expect(useConnectionStore.getState().activeSessionId).toBe('s2');

    useConnectionStore.setState({ sessions: [], activeSessionId: null, sessionStates: {}, socket: null });
  });

  it('does not switch when permission belongs to the active session', async () => {
    const { useConnectionStore } = await import('./connection');

    const makeMsg = (id: string, reqId: string) => ({
      id,
      type: 'prompt' as const,
      content: 'Allow?',
      timestamp: 1,
      requestId: reqId,
    });

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [makeMsg('m1', 'req-a')] },
        s2: { ...createEmptySessionState(), messages: [] },
      },
      socket: { readyState: 1, send: () => {} } as unknown as WebSocket,
    });

    useConnectionStore.getState().sendPermissionResponse('req-a', 'deny');

    expect(useConnectionStore.getState().activeSessionId).toBe('s1');

    useConnectionStore.setState({ sessions: [], activeSessionId: null, sessionStates: {}, socket: null });
  });

  it('sends permission_response before switch_session when cross-session', async () => {
    const { useConnectionStore } = await import('./connection');

    const sentMessages: { type: string }[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => {
        sentMessages.push(JSON.parse(data));
      },
    };

    const makeMsg = (id: string, reqId: string) => ({
      id,
      type: 'prompt' as const,
      content: 'Allow?',
      timestamp: 1,
      requestId: reqId,
    });

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [makeMsg('m1', 'req-a')] },
        s2: { ...createEmptySessionState(), messages: [makeMsg('m2', 'req-b')] },
      },
      socket: mockSocket as unknown as WebSocket,
    });

    useConnectionStore.getState().sendPermissionResponse('req-b', 'allow');

    // permission_response must be the first message sent (before switch_session)
    expect(sentMessages[0]?.type).toBe('permission_response');
    const switchIdx = sentMessages.findIndex((m) => m.type === 'switch_session');
    const permIdx = sentMessages.findIndex((m) => m.type === 'permission_response');
    expect(permIdx).toBeLessThan(switchIdx === -1 ? Infinity : switchIdx);

    useConnectionStore.setState({ sessions: [], activeSessionId: null, sessionStates: {}, socket: null });
  });

  it('does not switch activeSessionId when requestId is not found in any session', async () => {
    const { useConnectionStore } = await import('./connection');

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [] },
      },
      socket: { readyState: 1, send: () => {} } as unknown as WebSocket,
    });

    // requestId 'req-ghost' does not exist in any session
    useConnectionStore.getState().sendPermissionResponse('req-ghost', 'allow');

    expect(useConnectionStore.getState().activeSessionId).toBe('s1');

    useConnectionStore.setState({ sessions: [], activeSessionId: null, sessionStates: {}, socket: null });
  });
});

// ---------------------------------------------------------------------------
// PTY dead code removal (#1759)
// ---------------------------------------------------------------------------
describe('PTY dead code removal', () => {
  it('connection.ts does not contain PTY mirror actions', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, 'connection.ts'), 'utf-8');
    expect(src).not.toMatch(/spawnPty|writePty|resizePty|killPty|ptyActive/);
  });

  it('message-handler.ts does not contain PTY message cases', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, 'message-handler.ts'), 'utf-8');
    expect(src).not.toMatch(/pty_spawned|pty_data|pty_exit|pty_error/);
  });

  it('types.ts does not contain PTY action signatures or ptyActive field', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, 'types.ts'), 'utf-8');
    expect(src).not.toMatch(/spawnPty|writePty|resizePty|killPty|ptyActive/);
  });
});

// ---------------------------------------------------------------------------
// SSR safety — module-level DOM guards (#1151)
// ---------------------------------------------------------------------------
describe('SSR safety', () => {
  it('visibilitychange listener is guarded by typeof document check', async () => {
    // The connection store registers a visibilitychange listener at module scope.
    // Verify the source code wraps it in a typeof document guard.
    const fs = await import('fs');
    const path = await import('path');
    const storeSource = fs.readFileSync(
      path.resolve(__dirname, 'connection.ts'),
      'utf-8'
    );
    // The guard should appear before the addEventListener call
    const guardPattern = /typeof document\s*!==\s*['"]undefined['"]/;
    const listenerPattern = /document\.addEventListener\s*\(\s*['"]visibilitychange['"]/;

    const guardMatch = storeSource.match(guardPattern);
    const listenerMatch = storeSource.match(listenerPattern);

    expect(guardMatch).not.toBeNull();
    expect(listenerMatch).not.toBeNull();

    // Guard must appear before the listener in the source
    expect(guardMatch!.index!).toBeLessThan(listenerMatch!.index!);
  });
});
