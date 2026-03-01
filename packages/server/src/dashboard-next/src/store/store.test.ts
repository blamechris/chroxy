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

  it('clearPersistedState removes all chroxy keys', () => {
    persistViewMode('chat');
    persistActiveSession('sess-1');
    localStorage.setItem('other_key', 'keep');
    clearPersistedState();
    expect(localStorage.getItem('other_key')).toBe('keep');
    const state = loadPersistedState();
    expect(state.viewMode).toBeNull();
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
    const guardPattern = /typeof document\s*!==?\s*['"]undefined['"]/;
    const listenerPattern = /document\.addEventListener\s*\(\s*['"]visibilitychange['"]/;

    const guardMatch = storeSource.match(guardPattern);
    const listenerMatch = storeSource.match(listenerPattern);

    expect(guardMatch).not.toBeNull();
    expect(listenerMatch).not.toBeNull();

    // Guard must appear before the listener in the source
    if (guardMatch && listenerMatch) {
      expect(guardMatch.index).toBeLessThan(listenerMatch.index!);
    }
  });
});
