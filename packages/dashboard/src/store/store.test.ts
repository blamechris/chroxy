/**
 * Desktop Zustand store tests (#1094)
 *
 * Covers: persistence, utils, types, and store creation.
 * Message handler and connection tests require the ported files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stripAnsi, filterThinking, nextMessageId, withJitter, createEmptySessionState } from './utils';
import type { ChatMessage, SessionState, ConnectionPhase } from './types';
import {
  persistViewMode,
  persistActiveSession,
  loadPersistedState,
  loadSessionMessages,
  clearPersistedState,
  _resetForTesting,
  // #4303 — sidebar panel slot persistence
  persistSidebarPanelHeight,
  loadPersistedSidebarPanelHeight,
  persistSidebarPanelView,
  loadPersistedSidebarPanelView,
  persistSidebarPanelCollapsed,
  loadPersistedSidebarPanelCollapsed,
  // #6883 — device-view preferences must survive an unscoped clear
  persistShowConsoleTab,
  loadPersistedShowConsoleTab,
  persistInterventionPing,
  loadPersistedInterventionPing,
  persistCompactChatFilter,
  loadPersistedCompactChatFilter,
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

  it('persistViewMode round-trips system view mode', () => {
    persistViewMode('system');
    const state = loadPersistedState();
    expect(state.viewMode).toBe('system');
  });

  it('persistViewMode round-trips console view mode', () => {
    persistViewMode('console');
    const state = loadPersistedState();
    expect(state.viewMode).toBe('console');
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

  // #6883 — device-view prefs (compact filter, console tab, intervention
  // ping) are per-device UI choices, not server-scoped session state, so an
  // unscoped clearPersistedState() must not reset them (matching theme /
  // view_mode). Pre-#6883, these were wiped alongside session data.
  it('clearPersistedState preserves device-view prefs but still clears session state', () => {
    persistShowConsoleTab(true);
    persistInterventionPing(false);
    persistCompactChatFilter(true);
    persistActiveSession('sess-1');

    clearPersistedState();

    expect(loadPersistedShowConsoleTab()).toBe(true);
    expect(loadPersistedInterventionPing()).toBe(false);
    expect(loadPersistedCompactChatFilter()).toBe(true);
    // Session-scoped state still clears
    expect(loadPersistedState().activeSessionId).toBeNull();
  });

  it('loadPersistedState returns defaults when empty', () => {
    const state = loadPersistedState();
    expect(state.viewMode).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(state.terminalBuffer).toBeNull();
  });

  // #4303 — pluggable sidebar panel slot
  describe('sidebar panel slot persistence (#4303)', () => {
    it('persistSidebarPanelHeight and loadPersistedSidebarPanelHeight round-trip', () => {
      persistSidebarPanelHeight(240);
      expect(loadPersistedSidebarPanelHeight()).toBe(240);
    });

    it('loadPersistedSidebarPanelHeight returns null when unset', () => {
      expect(loadPersistedSidebarPanelHeight()).toBeNull();
    });

    it('loadPersistedSidebarPanelHeight returns null for non-positive values', () => {
      localStorage.setItem('chroxy_persist_sidebar_panel_height', '0');
      expect(loadPersistedSidebarPanelHeight()).toBeNull();
      localStorage.setItem('chroxy_persist_sidebar_panel_height', '-50');
      expect(loadPersistedSidebarPanelHeight()).toBeNull();
    });

    it('loadPersistedSidebarPanelHeight returns null for non-numeric values', () => {
      localStorage.setItem('chroxy_persist_sidebar_panel_height', 'banana');
      expect(loadPersistedSidebarPanelHeight()).toBeNull();
    });

    it('persistSidebarPanelView and loadPersistedSidebarPanelView round-trip', () => {
      persistSidebarPanelView('tokens');
      expect(loadPersistedSidebarPanelView()).toBe('tokens');
    });

    it('persistSidebarPanelView(null) removes the key', () => {
      persistSidebarPanelView('tokens');
      persistSidebarPanelView(null);
      expect(loadPersistedSidebarPanelView()).toBeNull();
    });

    it('persistSidebarPanelCollapsed round-trips true/false', () => {
      persistSidebarPanelCollapsed(true);
      expect(loadPersistedSidebarPanelCollapsed()).toBe(true);
      persistSidebarPanelCollapsed(false);
      expect(loadPersistedSidebarPanelCollapsed()).toBe(false);
    });

    it('loadPersistedSidebarPanelCollapsed defaults to false when unset (panel starts expanded)', () => {
      expect(loadPersistedSidebarPanelCollapsed()).toBe(false);
    });
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

  it('#5277: sendCancelActivity marks the node cancelling and sends when the socket is open', async () => {
    const { useConnectionStore } = await import('./connection');
    const send = vi.fn();
    const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    useConnectionStore.setState({ socket: openSocket, activeSessionId: 's1', cancellingActivityIds: new Set() });

    const result = useConnectionStore.getState().sendCancelActivity('act-1');

    expect(result).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((send.mock.calls[0]![0]) as string);
    expect(payload.type).toBe('cancel_activity');
    expect(payload.activityId).toBe('act-1');
    expect(typeof payload.requestId).toBe('string');
    // Keyed by `${sessionId}:${activityId}` so one session's cancel can't affect
    // another's identically-ided node.
    expect(useConnectionStore.getState().cancellingActivityIds.has('s1:act-1')).toBe(true);
  });

  it('#5277: sendCancelActivity does NOT mark cancelling when offline (cancel is not queueable)', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.setState({ socket: null, activeSessionId: 's1', cancellingActivityIds: new Set() });

    useConnectionStore.getState().sendCancelActivity('act-1');

    // Offline send is dropped (not in QUEUE_TTLS); the node must NOT be stranded "Cancelling…".
    expect(useConnectionStore.getState().cancellingActivityIds.has('s1:act-1')).toBe(false);
  });

  // #5939 (epic #5935 ④): send-while-busy queues (optimistic badge) instead of
  // faking a new turn; per-item cancel sends cancel_queued + optimistically
  // clears the local entry.
  describe('#5939 queued send-while-busy', () => {
    it('queues a send while the turn is in progress: optimistic bubble + pending queue entry, no new-turn fake', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), streamingMessageId: 'm-live', messages: [], queuedMessages: [] } },
      });

      useConnectionStore.getState().sendInput('follow-up');

      const ss = useConnectionStore.getState().sessionStates.s1!;
      // The live turn keeps its own streaming id — we did NOT reset it to 'pending'.
      expect(ss.streamingMessageId).toBe('m-live');
      // No optimistic thinking indicator for a queued follow-up.
      expect(ss.messages.some(m => m.type === 'thinking')).toBe(false);
      // The user bubble is shown, and its id is recorded in the queue model as pending.
      const bubble = ss.messages.find(m => m.type === 'user_input');
      expect(bubble?.content).toBe('follow-up');
      expect(ss.queuedMessages).toHaveLength(1);
      expect(ss.queuedMessages[0]!.status).toBe('pending');
      expect(ss.queuedMessages[0]!.clientMessageId).toBe(bubble!.id);
      // The input still goes over the wire (the server queues it authoritatively).
      const payload = JSON.parse(send.mock.calls[0]![0] as string);
      expect(payload.type).toBe('input');
      expect(payload.clientMessageId).toBe(bubble!.id);
    });

    it('carries previewAttachments onto the optimistic user bubble (#6632)', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), streamingMessageId: null, isIdle: true, messages: [], queuedMessages: [] } },
      });
      const previewAttachments = [
        { id: 'img-0', type: 'image' as const, uri: 'data:image/png;base64,abc', name: 'shot.png', mediaType: 'image/png', size: 3 },
      ];
      useConnectionStore.getState().sendInput('look at this', undefined, { previewAttachments });
      const bubble = useConnectionStore.getState().sessionStates.s1!.messages.find(m => m.type === 'user_input');
      // The real send path (sendInput → addUserMessage) surfaces the previews so
      // the transcript can render them — guards the wiring that was dead before.
      expect(bubble?.attachments).toEqual(previewAttachments);
    });

    it('preserves the in-progress turn thinking indicator when queueing a follow-up', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      // streamingMessageId 'pending' = sent, awaiting stream_start; the thinking
      // bubble for that live turn is present and must survive a queued follow-up.
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            streamingMessageId: 'pending',
            messages: [
              { id: 'uin-0', type: 'user_input', content: 'first', timestamp: 1 },
              { id: 'thinking', type: 'thinking', content: '', timestamp: 2 },
            ],
            queuedMessages: [],
          },
        },
      });

      useConnectionStore.getState().sendInput('second');

      const ss = useConnectionStore.getState().sessionStates.s1!;
      // The live turn's thinking indicator is NOT stripped...
      expect(ss.messages.some(m => m.id === 'thinking')).toBe(true);
      // ...and the queued bubble lands at the tail (queued behind the live turn).
      expect(ss.messages[ss.messages.length - 1]!.content).toBe('second');
      expect(ss.queuedMessages).toHaveLength(1);
    });

    it('#5952: queues when the server says busy (isIdle false) even if streamingMessageId is still null', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      // The pre-stream window: the server reported the turn busy (isIdle:false)
      // but no stream_start has set streamingMessageId yet. The InputBar shows
      // its busy UI here (isBusy = !isIdle), so a send must QUEUE — not fake a
      // fresh turn — matching the input affordance.
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), isIdle: false, streamingMessageId: null, messages: [], queuedMessages: [] } },
      });

      useConnectionStore.getState().sendInput('follow-up');

      const ss = useConnectionStore.getState().sessionStates.s1!;
      expect(ss.queuedMessages).toHaveLength(1);
      expect(ss.queuedMessages[0]!.status).toBe('pending');
      // Did NOT fake a new turn.
      expect(ss.messages.some(m => m.type === 'thinking')).toBe(false);
      expect(ss.streamingMessageId).toBeNull();
    });

    it('does NOT queue when idle: normal optimistic turn (thinking + pending stream)', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), streamingMessageId: null, messages: [], queuedMessages: [] } },
      });

      useConnectionStore.getState().sendInput('first');

      const ss = useConnectionStore.getState().sessionStates.s1!;
      expect(ss.streamingMessageId).toBe('pending');
      expect(ss.messages.some(m => m.type === 'thinking')).toBe(true);
      expect(ss.queuedMessages).toHaveLength(0);
    });

    it('sendCancelQueued sends cancel_queued and optimistically removes the local entry', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            queuedMessages: [
              { clientMessageId: 'uin-1', text: 'a', queuedAt: 1, status: 'confirmed' },
              { clientMessageId: 'uin-2', text: 'b', queuedAt: 2, status: 'confirmed' },
            ],
          },
        },
      });

      const result = useConnectionStore.getState().sendCancelQueued('uin-1');

      expect(result).toBe('sent');
      const payload = JSON.parse(send.mock.calls[0]![0] as string);
      expect(payload).toEqual({ type: 'cancel_queued', clientMessageId: 'uin-1', sessionId: 's1' });
      // Optimistic local removal — only uin-2 remains.
      const ss = useConnectionStore.getState().sessionStates.s1!;
      expect(ss.queuedMessages.map(m => m.clientMessageId)).toEqual(['uin-2']);
    });

    it('sendCancelQueued with an explicit sessionId clears THAT session, not the active one', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's-active',
        sessionStates: {
          's-active': { ...createEmptySessionState(), queuedMessages: [{ clientMessageId: 'uin-a', text: 'a', queuedAt: 1, status: 'confirmed' }] },
          's-other': { ...createEmptySessionState(), queuedMessages: [{ clientMessageId: 'uin-b', text: 'b', queuedAt: 1, status: 'confirmed' }] },
        },
      });

      useConnectionStore.getState().sendCancelQueued('uin-b', 's-other');

      const states = useConnectionStore.getState().sessionStates;
      // The target session's entry is removed; the ACTIVE session is untouched.
      expect(states['s-other']!.queuedMessages).toHaveLength(0);
      expect(states['s-active']!.queuedMessages.map(m => m.clientMessageId)).toEqual(['uin-a']);
      const payload = JSON.parse(send.mock.calls[0]![0] as string);
      expect(payload.sessionId).toBe('s-other');
    });

    it('sendCancelQueued is a no-op offline (not queueable — races the flush)', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      useConnectionStore.setState({
        socket: null,
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), queuedMessages: [{ clientMessageId: 'uin-1', text: 'a', queuedAt: 1, status: 'confirmed' }] } },
      });

      const result = useConnectionStore.getState().sendCancelQueued('uin-1');

      expect(result).toBe(false);
      // Local entry untouched — no optimistic removal without a real send.
      expect(useConnectionStore.getState().sessionStates.s1!.queuedMessages).toHaveLength(1);
    });

    it('#5938: sendCancelQueued also drops the never-sent optimistic bubble (not just the badge)', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            // The bubble id IS the clientMessageId for a queued send.
            messages: [
              { id: 'uin-1', type: 'user_input', content: 'a', timestamp: 1 },
              { id: 'uin-2', type: 'user_input', content: 'b', timestamp: 2 },
            ],
            queuedMessages: [
              { clientMessageId: 'uin-1', text: 'a', queuedAt: 1, status: 'confirmed' },
              { clientMessageId: 'uin-2', text: 'b', queuedAt: 2, status: 'confirmed' },
            ],
          },
        },
      });

      useConnectionStore.getState().sendCancelQueued('uin-1');

      const ss = useConnectionStore.getState().sessionStates.s1!;
      // Badge cleared AND the phantom bubble removed — only uin-2 lingers.
      expect(ss.queuedMessages.map(m => m.clientMessageId)).toEqual(['uin-2']);
      expect(ss.messages.map(m => m.id)).toEqual(['uin-2']);
    });

    it('#5938: sendInterrupt clears the queue and drops every never-sent queued bubble', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            streamingMessageId: 'm-live',
            messages: [
              // A bubble belonging to the live (already-sent) turn must survive.
              { id: 'uin-live', type: 'user_input', content: 'live', timestamp: 1 },
              { id: 'uin-q1', type: 'user_input', content: 'q1', timestamp: 2 },
              { id: 'uin-q2', type: 'user_input', content: 'q2', timestamp: 3 },
            ],
            queuedMessages: [
              { clientMessageId: 'uin-q1', text: 'q1', queuedAt: 2, status: 'confirmed' },
              { clientMessageId: 'uin-q2', text: 'q2', queuedAt: 3, status: 'confirmed' },
            ],
          },
        },
      });

      const result = useConnectionStore.getState().sendInterrupt();

      expect(result).toBe('sent');
      const payload = JSON.parse(send.mock.calls[0]![0] as string);
      expect(payload.type).toBe('interrupt');
      const ss = useConnectionStore.getState().sessionStates.s1!;
      // Queue emptied; both queued bubbles dropped; the live-turn bubble stays.
      expect(ss.queuedMessages).toHaveLength(0);
      expect(ss.messages.map(m => m.id)).toEqual(['uin-live']);
    });

    it('#5938: sendInterrupt with an explicit sessionId clears THAT session queue + bubbles', async () => {
      const { useConnectionStore, createEmptySessionState } = await import('./connection');
      const send = vi.fn();
      const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
      useConnectionStore.setState({
        socket: openSocket,
        activeSessionId: 's-active',
        sessionStates: {
          's-active': {
            ...createEmptySessionState(),
            messages: [{ id: 'uin-a', type: 'user_input', content: 'a', timestamp: 1 }],
            queuedMessages: [{ clientMessageId: 'uin-a', text: 'a', queuedAt: 1, status: 'confirmed' }],
          },
          's-other': {
            ...createEmptySessionState(),
            messages: [{ id: 'uin-b', type: 'user_input', content: 'b', timestamp: 1 }],
            queuedMessages: [{ clientMessageId: 'uin-b', text: 'b', queuedAt: 1, status: 'confirmed' }],
          },
        },
      });

      useConnectionStore.getState().sendInterrupt('s-other');

      const states = useConnectionStore.getState().sessionStates;
      // The target session is cleared; the ACTIVE session is untouched.
      expect(states['s-other']!.queuedMessages).toHaveLength(0);
      expect(states['s-other']!.messages).toHaveLength(0);
      expect(states['s-active']!.queuedMessages.map(m => m.clientMessageId)).toEqual(['uin-a']);
      expect(states['s-active']!.messages.map(m => m.id)).toEqual(['uin-a']);
    });
  });

  it('#5710: destroySession sends force:true only when forced', async () => {
    const { useConnectionStore } = await import('./connection');
    const send = vi.fn();
    const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    useConnectionStore.setState({ socket: openSocket });

    // Normal delete — no force field on the wire.
    useConnectionStore.getState().destroySession('s1');
    const normal = JSON.parse(send.mock.calls[0]![0] as string);
    expect(normal).toEqual({ type: 'destroy_session', sessionId: 's1' });
    expect(normal.force).toBeUndefined();

    // Forced delete (a wedged running session) — carries force:true to bypass
    // the server's #5695 busy guard.
    useConnectionStore.getState().destroySession('s2', true);
    const forced = JSON.parse(send.mock.calls[1]![0] as string);
    expect(forced).toEqual({ type: 'destroy_session', sessionId: 's2', force: true });
  });

  it('#5500: sendRepoMemoryReindex marks the repo pending, clears its stale result, and sends', async () => {
    const { useConnectionStore } = await import('./connection');
    const send = vi.fn();
    const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    useConnectionStore.setState({
      socket: openSocket,
      reindexingRepoPaths: new Set(),
      reindexResults: { '/p/chroxy': { counts: null, error: 'old failure', at: 1 } },
    });

    const result = useConnectionStore.getState().sendRepoMemoryReindex('/p/chroxy');

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((send.mock.calls[0]![0]) as string);
    expect(payload.type).toBe('integration_action');
    expect(payload.action).toBe('repo_memory_reindex');
    expect(payload.repoPath).toBe('/p/chroxy');
    expect(typeof payload.requestId).toBe('string');
    expect(useConnectionStore.getState().reindexingRepoPaths.has('/p/chroxy')).toBe(true);
    // A fresh request invalidates the previous inline result for the repo.
    expect(useConnectionStore.getState().reindexResults['/p/chroxy']).toBeUndefined();
  });

  it('#5500: sendRepoMemoryReindex is a no-op offline (not queueable — would strand the row pending)', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.setState({ socket: null, reindexingRepoPaths: new Set(), reindexResults: {} });

    const result = useConnectionStore.getState().sendRepoMemoryReindex('/p/chroxy');

    expect(result).toBe(false);
    expect(useConnectionStore.getState().reindexingRepoPaths.has('/p/chroxy')).toBe(false);
  });

  it('#5502: sendRepoRelayRerun marks the repo pending, clears its stale result, and sends the runId', async () => {
    const { useConnectionStore } = await import('./connection');
    const send = vi.fn();
    const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    useConnectionStore.setState({
      socket: openSocket,
      relayRerunningRepoPaths: new Set(),
      relayRerunResults: { '/p/chroxy': { error: 'old failure', at: 1 } },
    });

    const result = useConnectionStore.getState().sendRepoRelayRerun('/p/chroxy', 9001);

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((send.mock.calls[0]![0]) as string);
    expect(payload.type).toBe('integration_action');
    expect(payload.action).toBe('repo_relay_rerun');
    expect(payload.repoPath).toBe('/p/chroxy');
    expect(payload.runId).toBe(9001);
    expect(typeof payload.requestId).toBe('string');
    expect(useConnectionStore.getState().relayRerunningRepoPaths.has('/p/chroxy')).toBe(true);
    // A fresh request invalidates the previous inline result for the repo.
    expect(useConnectionStore.getState().relayRerunResults['/p/chroxy']).toBeUndefined();
  });

  it('#5502: sendRepoRelayRerun is a no-op offline and rejects a non-integer runId', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.setState({ socket: null, relayRerunningRepoPaths: new Set(), relayRerunResults: {} });
    expect(useConnectionStore.getState().sendRepoRelayRerun('/p/chroxy', 9001)).toBe(false);
    expect(useConnectionStore.getState().relayRerunningRepoPaths.has('/p/chroxy')).toBe(false);

    const send = vi.fn();
    const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    useConnectionStore.setState({ socket: openSocket });
    expect(useConnectionStore.getState().sendRepoRelayRerun('/p/chroxy', 1.5)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('#6134: sendContainersAction marks the env pending, clears its stale result, and sends', async () => {
    const { useConnectionStore } = await import('./connection');
    const send = vi.fn();
    const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    useConnectionStore.setState({
      socket: openSocket,
      containerActioningIds: new Set(),
      containerActionResults: { 'env-web': { action: 'stop', status: null, error: 'old failure', at: 1 } },
    });

    const result = useConnectionStore.getState().sendContainersAction('env-web', 'restart');

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((send.mock.calls[0]![0]) as string);
    expect(payload.type).toBe('containers_action');
    expect(payload.action).toBe('restart');
    expect(payload.environmentId).toBe('env-web');
    expect(typeof payload.requestId).toBe('string');
    expect(useConnectionStore.getState().containerActioningIds.has('env-web')).toBe(true);
    // A fresh request invalidates the previous inline result for the env.
    expect(useConnectionStore.getState().containerActionResults['env-web']).toBeUndefined();
  });

  it('#6134: sendContainersAction is a no-op offline, with an empty id, or an unknown action', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.setState({ socket: null, containerActioningIds: new Set(), containerActionResults: {} });
    expect(useConnectionStore.getState().sendContainersAction('env-web', 'stop')).toBe(false);
    expect(useConnectionStore.getState().containerActioningIds.has('env-web')).toBe(false);

    const send = vi.fn();
    const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    useConnectionStore.setState({ socket: openSocket });
    // empty id and an out-of-enum action both reject without sending.
    expect(useConnectionStore.getState().sendContainersAction('', 'stop')).toBe(false);
    expect(useConnectionStore.getState().sendContainersAction('env-web', 'frob' as never)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('#6139: requestRepoRuntimeConfig sets loading and sends on the wire; no-op + no loading offline', async () => {
    const { useConnectionStore } = await import('./connection');
    const send = vi.fn();
    const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    useConnectionStore.setState({ socket: openSocket, repoRuntimeConfigLoading: false });
    expect(useConnectionStore.getState().requestRepoRuntimeConfig()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0] as string).type).toBe('repo_runtime_config_request');
    expect(useConnectionStore.getState().repoRuntimeConfigLoading).toBe(true);

    // Offline: no send, no loading flip.
    useConnectionStore.setState({ socket: null, repoRuntimeConfigLoading: false });
    expect(useConnectionStore.getState().requestRepoRuntimeConfig()).toBe(false);
    expect(useConnectionStore.getState().repoRuntimeConfigLoading).toBe(false);
  });

  it('#6285: createSession returns true when sent, false when the socket is closed', async () => {
    const { useConnectionStore } = await import('./connection');
    const send = vi.fn();
    const openSocket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    useConnectionStore.setState({ socket: openSocket });
    expect(useConnectionStore.getState().createSession({ name: 'demo' })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0] as string).type).toBe('create_session');

    // Closed socket: silent no-op, returns false so the caller skips its spinner.
    send.mockClear();
    useConnectionStore.setState({ socket: null });
    expect(useConnectionStore.getState().createSession({ name: 'demo' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
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
    expect(typeof state.sendCancelActivity).toBe('function');
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

  // #5184: header cost-badge display mode — default, setter, persistence.
  describe('costBadgeMode (#5184)', () => {
    it('defaults to cost (#5203)', async () => {
      const { useConnectionStore } = await import('./connection');
      expect(useConnectionStore.getState().costBadgeMode).toBe('cost');
    });

    it('setCostBadgeMode updates state and persists to localStorage', async () => {
      const { useConnectionStore } = await import('./connection');
      useConnectionStore.getState().setCostBadgeMode('tokens');
      expect(useConnectionStore.getState().costBadgeMode).toBe('tokens');
      expect(localStorage.getItem('chroxy_cost_badge_mode')).toBe('tokens');
      // Restore so later tests in this file see the default again.
      useConnectionStore.getState().setCostBadgeMode('provider-model');
    });

    it('swallows a localStorage write failure (private mode / quota)', async () => {
      const { useConnectionStore } = await import('./connection');
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      try {
        expect(() => useConnectionStore.getState().setCostBadgeMode('cost')).not.toThrow();
        // State still updates even when the write fails.
        expect(useConnectionStore.getState().costBadgeMode).toBe('cost');
      } finally {
        spy.mockRestore();
        useConnectionStore.getState().setCostBadgeMode('provider-model');
      }
    });
  });

  describe('confirmSessionClose (#5206)', () => {
    it('defaults to enabled (true)', async () => {
      const { useConnectionStore } = await import('./connection');
      expect(useConnectionStore.getState().confirmSessionClose).toBe(true);
    });

    it('setConfirmSessionClose updates state and persists to localStorage', async () => {
      const { useConnectionStore } = await import('./connection');
      useConnectionStore.getState().setConfirmSessionClose(false);
      expect(useConnectionStore.getState().confirmSessionClose).toBe(false);
      expect(localStorage.getItem('chroxy_confirm_session_close')).toBe('false');
      useConnectionStore.getState().setConfirmSessionClose(true);
      expect(useConnectionStore.getState().confirmSessionClose).toBe(true);
      expect(localStorage.getItem('chroxy_confirm_session_close')).toBe('true');
    });

    it('swallows a localStorage write failure (private mode / quota)', async () => {
      const { useConnectionStore } = await import('./connection');
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      try {
        expect(() => useConnectionStore.getState().setConfirmSessionClose(false)).not.toThrow();
        expect(useConnectionStore.getState().confirmSessionClose).toBe(false);
      } finally {
        spy.mockRestore();
        useConnectionStore.getState().setConfirmSessionClose(true);
      }
    });
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

  it('switchSession resets the flat primaryClientId so it does not bleed across sessions (#5731 T2)', async () => {
    const { useConnectionStore } = await import('./connection');

    const makeSession = (id: string) => ({
      sessionId: id, name: id, cwd: '/tmp', type: 'cli' as const,
      hasTerminal: false, model: null, permissionMode: null, isBusy: false,
      createdAt: 0, conversationId: null,
    });

    // Session A is owned by client-a; switching to a session with cached state
    // must adopt that session's owner (not retain A's), and switching to an
    // uncached session must reset the flat owner to null.
    useConnectionStore.setState({
      sessions: [makeSession('session-a'), makeSession('session-b'), makeSession('session-c')],
      activeSessionId: 'session-a',
      primaryClientId: 'client-a',
      sessionStates: {
        'session-b': { ...createEmptySessionState(), primaryClientId: 'client-b' },
      },
    });

    // Cached target → adopt the cached session's owner, not the prior one.
    useConnectionStore.getState().switchSession('session-b');
    expect(useConnectionStore.getState().primaryClientId).toBe('client-b');

    // Uncached target → reset to null (no bleed of session-b's owner).
    useConnectionStore.getState().switchSession('session-c');
    expect(useConnectionStore.getState().primaryClientId).toBeNull();

    // Cleanup
    useConnectionStore.setState({
      sessions: [], activeSessionId: null, sessionStates: {}, messages: [], primaryClientId: null,
    });
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

  // #5835 Phase 2: live-PTY mirror resize actions.
  it('setTerminalSize records the authoritative size on an existing session', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.setState({ sessionStates: { 'sess-1': createEmptySessionState() } });
    useConnectionStore.getState().setTerminalSize('sess-1', 160, 48);
    expect(useConnectionStore.getState().sessionStates['sess-1']!.terminalSize).toEqual({ cols: 160, rows: 48 });
    useConnectionStore.setState({ sessionStates: {} });
  });

  it('setTerminalSize is a no-op for an unknown session', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.setState({ sessionStates: {} });
    useConnectionStore.getState().setTerminalSize('ghost', 100, 40);
    expect(useConnectionStore.getState().sessionStates['ghost']).toBeUndefined();
  });

  it('setTerminalSize does not produce a new sessionStates object on an unchanged size', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.setState({ sessionStates: { 'sess-1': createEmptySessionState() } });
    useConnectionStore.getState().setTerminalSize('sess-1', 120, 30);
    const after1 = useConnectionStore.getState().sessionStates;
    // Same size again — must skip set() entirely (no new ref, no subscriber churn)
    useConnectionStore.getState().setTerminalSize('sess-1', 120, 30);
    expect(useConnectionStore.getState().sessionStates).toBe(after1);
    // An unknown session also must not churn state
    useConnectionStore.getState().setTerminalSize('ghost', 80, 24);
    expect(useConnectionStore.getState().sessionStates).toBe(after1);
    useConnectionStore.setState({ sessionStates: {} });
  });

  it('requestTerminalResize sends terminal_resize over an open socket', async () => {
    const { useConnectionStore } = await import('./connection');
    const sent: string[] = [];
    const mockSocket = { send: (d: string) => sent.push(d), readyState: 1 } as unknown as WebSocket;
    useConnectionStore.setState({ socket: mockSocket });
    useConnectionStore.getState().requestTerminalResize('sess-1', 120, 36);
    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]!);
    expect(parsed).toMatchObject({ type: 'terminal_resize', sessionId: 'sess-1', cols: 120, rows: 36 });
    useConnectionStore.setState({ socket: null });
  });

  it('requestTerminalResize is a no-op for non-positive dimensions', async () => {
    const { useConnectionStore } = await import('./connection');
    const sent: string[] = [];
    const mockSocket = { send: (d: string) => sent.push(d), readyState: 1 } as unknown as WebSocket;
    useConnectionStore.setState({ socket: mockSocket });
    useConnectionStore.getState().requestTerminalResize('sess-1', 0, 40);
    expect(sent).toHaveLength(0);
    useConnectionStore.setState({ socket: null });
  });

  it('sendTerminalInput sends terminal_input over an open socket; empty data is a no-op', async () => {
    const { useConnectionStore } = await import('./connection');
    const sent: string[] = [];
    const mockSocket = { send: (d: string) => sent.push(d), readyState: 1 } as unknown as WebSocket;
    useConnectionStore.setState({ socket: mockSocket });
    useConnectionStore.getState().sendTerminalInput('sess-1', '\x03');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'terminal_input', sessionId: 'sess-1', data: '\x03' });
    useConnectionStore.getState().sendTerminalInput('sess-1', '');
    expect(sent).toHaveLength(1);
    useConnectionStore.setState({ socket: null });
  });

  it('sendTerminalInput chunks a large paste into sub-cap frames without splitting surrogate pairs', async () => {
    const { useConnectionStore } = await import('./connection');
    const sent: string[] = [];
    const mockSocket = { send: (d: string) => sent.push(d), readyState: 1 } as unknown as WebSocket;
    useConnectionStore.setState({ socket: mockSocket });

    const MAX = 65536;
    // 150k chars → 3 frames; put an emoji (surrogate pair) exactly straddling the
    // first 64k boundary so the surrogate-safe split is exercised.
    const big = 'a'.repeat(MAX - 1) + '😀' + 'b'.repeat(90000);
    useConnectionStore.getState().sendTerminalInput('sess-1', big);

    expect(sent.length).toBeGreaterThan(1);
    let reassembled = '';
    for (const raw of sent) {
      const m = JSON.parse(raw);
      expect(m.type).toBe('terminal_input');
      expect(m.sessionId).toBe('sess-1');
      expect(m.data.length).toBeLessThanOrEqual(MAX);
      // No chunk ends on a lone high surrogate (would mean a split pair).
      const last = m.data.charCodeAt(m.data.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      reassembled += m.data;
    }
    expect(reassembled).toBe(big); // lossless
    useConnectionStore.setState({ socket: null });
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

  it('sendCancelActivity sends cancel_activity with the explicit sessionId (#5272)', async () => {
    const { useConnectionStore } = await import('./connection');
    const sent: string[] = [];
    useConnectionStore.setState({
      socket: { send: (d: string) => sent.push(d), readyState: 1 } as unknown as WebSocket,
      activeSessionId: 'active-sess',
    });

    const result = useConnectionStore.getState().sendCancelActivity('tu-1', 'drill-sess');
    expect(result).toBe('sent');
    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]!);
    expect(parsed.type).toBe('cancel_activity');
    expect(parsed.activityId).toBe('tu-1');
    // Explicit sessionId wins over the active session.
    expect(parsed.sessionId).toBe('drill-sess');
  });

  it('sendCancelActivity falls back to the active session when no sessionId is given (#5272)', async () => {
    const { useConnectionStore } = await import('./connection');
    const sent: string[] = [];
    useConnectionStore.setState({
      socket: { send: (d: string) => sent.push(d), readyState: 1 } as unknown as WebSocket,
      activeSessionId: 'active-sess',
    });

    useConnectionStore.getState().sendCancelActivity('tu-9');
    const parsed = JSON.parse(sent[0]!);
    expect(parsed.activityId).toBe('tu-9');
    expect(parsed.sessionId).toBe('active-sess');
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
// #6222 — answering a permission clears the pending-permission count
// ---------------------------------------------------------------------------
describe('sendPermissionResponse clears pending-permission count (#6222)', () => {
  const futureExpiry = () => Date.now() + 5 * 60_000;

  const makeLivePrompt = (id: string, reqId: string) => ({
    id,
    type: 'prompt' as const,
    content: 'Allow?',
    timestamp: 1,
    requestId: reqId,
    // requestId + future expiresAt are what make isLivePermissionPrompt count it
    // as a live *permission* prompt (vs an AskUserQuestion, which carries neither).
    expiresAt: futureExpiry(),
  });

  afterEach(async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.setState({ sessions: [], activeSessionId: null, sessionStates: {}, socket: null });
  });

  it('marks the prompt answered so derivePendingPermissionCounts drops to 0 (inline chat Allow path)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { derivePendingPermissionCounts, totalPendingPermissions } = await import('@chroxy/store-core');

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [makeLivePrompt('m1', 'req-a')] },
      },
      socket: { readyState: 1, send: () => {} } as unknown as WebSocket,
    });

    // Before: one live pending permission.
    const before = useConnectionStore.getState().sessionStates;
    expect(totalPendingPermissions(derivePendingPermissionCounts(before, Date.now()))).toBe(1);

    // Answer it via the inline-chat path (sendPermissionResponse only — no
    // separate markPromptAnswered call, exactly what PermissionPrompt does).
    useConnectionStore.getState().sendPermissionResponse('req-a', 'allow');

    // After: the prompt is marked answered with the canonical decision TOKEN
    // (not a display label — consumers treat `answered` as a decision enum) and
    // the count clears.
    const after = useConnectionStore.getState().sessionStates;
    const prompt = after.s1!.messages.find((m) => m.requestId === 'req-a');
    expect(prompt?.answered).toBe('allow');
    expect(totalPendingPermissions(derivePendingPermissionCounts(after, Date.now()))).toBe(0);
  });

  it('records a denial as the answered decision (deny path)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { derivePendingPermissionCounts, totalPendingPermissions } = await import('@chroxy/store-core');

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [makeLivePrompt('m1', 'req-a')] },
      },
      socket: { readyState: 1, send: () => {} } as unknown as WebSocket,
    });

    useConnectionStore.getState().sendPermissionResponse('req-a', 'deny');

    const after = useConnectionStore.getState().sessionStates;
    const prompt = after.s1!.messages.find((m) => m.requestId === 'req-a');
    expect(prompt?.answered).toBe('deny');
    expect(totalPendingPermissions(derivePendingPermissionCounts(after, Date.now()))).toBe(0);
  });

  it('clears a prompt owned by a background (non-active) session', async () => {
    const { useConnectionStore } = await import('./connection');
    const { derivePendingPermissionCounts, totalPendingPermissions } = await import('@chroxy/store-core');

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [makeLivePrompt('m2', 'req-b')] },
      },
      socket: { readyState: 1, send: () => {} } as unknown as WebSocket,
    });

    expect(
      totalPendingPermissions(derivePendingPermissionCounts(useConnectionStore.getState().sessionStates, Date.now())),
    ).toBe(1);

    useConnectionStore.getState().sendPermissionResponse('req-b', 'allow');

    const after = useConnectionStore.getState().sessionStates;
    expect(after.s2!.messages.find((m) => m.requestId === 'req-b')?.answered).toBe('allow');
    expect(totalPendingPermissions(derivePendingPermissionCounts(after, Date.now()))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resolved-permission persistence + Allow for Session (#2833, #2834)
// ---------------------------------------------------------------------------
describe('resolvedPermissions + Allow for Session (#2833, #2834)', () => {
  beforeEach(async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.setState({
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      socket: null,
      resolvedPermissions: {},
      sessionNotifications: [],
    });
  });

  it('initial state has an empty resolvedPermissions map', async () => {
    const { useConnectionStore } = await import('./connection');
    expect(useConnectionStore.getState().resolvedPermissions).toEqual({});
  });

  it('markPermissionResolved records the decision keyed by requestId', async () => {
    const { useConnectionStore } = await import('./connection');
    useConnectionStore.getState().markPermissionResolved('req-1', 'allow');
    expect(useConnectionStore.getState().resolvedPermissions).toEqual({ 'req-1': 'allow' });
    useConnectionStore.getState().markPermissionResolved('req-2', 'deny');
    useConnectionStore.getState().markPermissionResolved('req-3', 'allowSession');
    expect(useConnectionStore.getState().resolvedPermissions).toEqual({
      'req-1': 'allow',
      'req-2': 'deny',
      'req-3': 'allowSession',
    });
  });

  it('markPermissionResolved caps the map size and evicts oldest entry (#2838)', async () => {
    const { useConnectionStore, RESOLVED_PERMISSIONS_CAP } = await import('./connection');

    for (let i = 0; i < RESOLVED_PERMISSIONS_CAP; i++) {
      useConnectionStore.getState().markPermissionResolved(`req-${i}`, 'allow');
    }
    let state = useConnectionStore.getState().resolvedPermissions;
    expect(Object.keys(state).length).toBe(RESOLVED_PERMISSIONS_CAP);
    expect(state['req-0']).toBe('allow');

    // Adding one more beyond the cap should evict req-0 (oldest).
    useConnectionStore.getState().markPermissionResolved('req-overflow', 'deny');
    state = useConnectionStore.getState().resolvedPermissions;
    expect(Object.keys(state).length).toBe(RESOLVED_PERMISSIONS_CAP);
    expect(state['req-0']).toBeUndefined();
    expect(state['req-overflow']).toBe('deny');
    expect(state['req-1']).toBe('allow');

    // Adding several more in a row evicts in insertion order.
    for (let i = 0; i < 5; i++) {
      useConnectionStore.getState().markPermissionResolved(`req-extra-${i}`, 'allow');
    }
    state = useConnectionStore.getState().resolvedPermissions;
    expect(Object.keys(state).length).toBe(RESOLVED_PERMISSIONS_CAP);
    for (let i = 1; i <= 5; i++) {
      expect(state[`req-${i}`]).toBeUndefined();
    }
    expect(state['req-6']).toBe('allow');
  });

  it('markPermissionResolved re-resolving an entry bumps it to most-recent (#2838)', async () => {
    const { useConnectionStore, RESOLVED_PERMISSIONS_CAP } = await import('./connection');

    // Fill the map.
    useConnectionStore.getState().markPermissionResolved('req-sticky', 'allow');
    for (let i = 0; i < RESOLVED_PERMISSIONS_CAP - 1; i++) {
      useConnectionStore.getState().markPermissionResolved(`req-${i}`, 'allow');
    }
    // Re-resolve the sticky entry — should bump it to the tail.
    useConnectionStore.getState().markPermissionResolved('req-sticky', 'deny');

    // Fill beyond the cap — req-sticky must survive because it was just bumped.
    useConnectionStore.getState().markPermissionResolved('req-new-1', 'allow');
    useConnectionStore.getState().markPermissionResolved('req-new-2', 'allow');

    const state = useConnectionStore.getState().resolvedPermissions;
    expect(state['req-sticky']).toBe('deny');
    // Oldest (req-0) should be evicted now that two new entries were added.
    expect(state['req-0']).toBeUndefined();
    expect(Object.keys(state).length).toBe(RESOLVED_PERMISSIONS_CAP);
  });

  it('capResolvedPermissions pure helper evicts without mutating input (#2838)', async () => {
    const { capResolvedPermissions } = await import('./connection');

    const input = { a: 'allow' as const, b: 'deny' as const, c: 'allow' as const };
    const out = capResolvedPermissions(input, 'd', 'deny', 3);
    expect(out).toEqual({ b: 'deny', c: 'allow', d: 'deny' });
    // Input was not mutated.
    expect(input).toEqual({ a: 'allow', b: 'deny', c: 'allow' });
  });

  it('sendPermissionResponse marks the requestId resolved in the store', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    const sent: { type: string; decision?: string; rules?: unknown[] }[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          messages: [{
            id: 'm1', type: 'prompt', content: 'Allow?', timestamp: 1,
            requestId: 'req-a', tool: 'Write',
          }],
        },
      },
      socket: mockSocket as unknown as WebSocket,
    });

    useConnectionStore.getState().sendPermissionResponse('req-a', 'allow');
    expect(useConnectionStore.getState().resolvedPermissions['req-a']).toBe('allow');

    useConnectionStore.getState().sendPermissionResponse('req-a', 'deny');
    expect(useConnectionStore.getState().resolvedPermissions['req-a']).toBe('deny');
  });

  it('#5699: sendPermissionResponse refuses (no enqueue, no optimistic resolve) when disconnected', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testQueueInternals } = await import('./message-handler');
    _testQueueInternals.clear();
    // No socket (or a non-OPEN socket) — the disconnected case.
    useConnectionStore.setState({ socket: null, resolvedPermissions: {} });

    const result = useConnectionStore.getState().sendPermissionResponse('req-x', 'allow');

    // Must NOT optimistically mark the prompt answered — that's the silent-loss
    // bug (#5699): the UI would show "answered" for a request the server never got.
    expect(result).toBe(false);
    expect(useConnectionStore.getState().resolvedPermissions['req-x']).toBeUndefined();
    // And must NOT queue the answer — a permission request expires server-side,
    // so a queued answer would be replayed against a dead request.
    expect(_testQueueInternals.getQueue()).toHaveLength(0);

    // A CLOSED socket (readyState !== OPEN) is treated the same as no socket.
    useConnectionStore.setState({ socket: { readyState: 3, send: () => {} } as unknown as WebSocket });
    expect(useConnectionStore.getState().sendPermissionResponse('req-y', 'deny')).toBe(false);
    expect(useConnectionStore.getState().resolvedPermissions['req-y']).toBeUndefined();
    expect(_testQueueInternals.getQueue()).toHaveLength(0);
  });

  it('sendPermissionResponse with allowSession sends wire "allow" + set_permission_rules', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    const sent: Array<Record<string, unknown>> = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          sessionRules: [{ tool: 'Glob', decision: 'allow' }],
          messages: [{
            id: 'm1', type: 'prompt', content: 'Read /etc/hosts', timestamp: 1,
            requestId: 'req-read', tool: 'Read',
          }],
        },
      },
      socket: mockSocket as unknown as WebSocket,
    });

    useConnectionStore.getState().sendPermissionResponse('req-read', 'allowSession');

    // Wire decision is 'allow', not 'allowSession' (server schema rejects the latter).
    const permMsg = sent.find((m) => m.type === 'permission_response');
    expect(permMsg).toBeDefined();
    expect(permMsg!.decision).toBe('allow');

    const rulesMsg = sent.find((m) => m.type === 'set_permission_rules');
    expect(rulesMsg).toBeDefined();
    expect(rulesMsg!.sessionId).toBe('s1');
    // Existing rule preserved, new rule appended for the resolved tool.
    expect(rulesMsg!.rules).toEqual([
      { tool: 'Glob', decision: 'allow' },
      { tool: 'Read', decision: 'allow' },
    ]);

    // Resolved decision records 'allowSession' for UI state.
    expect(useConnectionStore.getState().resolvedPermissions['req-read']).toBe('allowSession');
  });

  it('sendPermissionResponse with allowSession does NOT send set_permission_rules for ineligible tools', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    const sent: Array<Record<string, unknown>> = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          messages: [{
            id: 'm1', type: 'prompt', content: 'Run foo', timestamp: 1,
            requestId: 'req-bash', tool: 'Bash',
          }],
        },
      },
      socket: mockSocket as unknown as WebSocket,
    });

    useConnectionStore.getState().sendPermissionResponse('req-bash', 'allowSession');

    expect(sent.some((m) => m.type === 'permission_response')).toBe(true);
    expect(sent.some((m) => m.type === 'set_permission_rules')).toBe(false);
  });

  // #6772/#6829 — Session Rules viewer store actions (the SettingsPanel remove /
  // clear-all path). These assert the exact wire shape the panel produces.
  it('setPermissionRules sends set_permission_rules with the (bare) session rule list', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    const sent: Array<Record<string, unknown>> = [];
    const mockSocket = { readyState: 1, send: (d: string) => { sent.push(JSON.parse(d)); } };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: { ...createEmptySessionState(), sessionRules: [{ tool: 'Edit', decision: 'allow' }] } },
      socket: mockSocket as unknown as WebSocket,
    });

    // Remove the only session rule → send an empty list.
    useConnectionStore.getState().setPermissionRules([]);

    const msg = sent.find((m) => m.type === 'set_permission_rules');
    expect(msg).toBeDefined();
    expect(msg!.sessionId).toBe('s1');
    expect(msg!.rules).toEqual([]);
    expect(msg!.projectRules).toBeUndefined();
  });

  it('setProjectPermissionRules sends the reduced projectRules AND re-sends the current session rules (stripped of persist)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    const sent: Array<Record<string, unknown>> = [];
    const mockSocket = { readyState: 1, send: (d: string) => { sent.push(JSON.parse(d)); } };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          sessionRules: [{ tool: 'Glob', decision: 'allow' }],
          persistentRules: [
            { tool: 'Write', decision: 'allow', persist: 'project' },
            { tool: 'Edit', decision: 'allow', persist: 'project' },
          ],
        },
      },
      socket: mockSocket as unknown as WebSocket,
    });

    // Remove the first project rule (Write) → send the reduced project list.
    useConnectionStore.getState().setProjectPermissionRules([{ tool: 'Edit', decision: 'allow', persist: 'project' }]);

    const msg = sent.find((m) => m.type === 'set_permission_rules');
    expect(msg).toBeDefined();
    expect(msg!.sessionId).toBe('s1');
    // Session rules preserved (server's single handler would otherwise clobber them).
    expect(msg!.rules).toEqual([{ tool: 'Glob', decision: 'allow' }]);
    // projectRules carry only { tool, decision } — the client-only `persist` marker is stripped.
    expect(msg!.projectRules).toEqual([{ tool: 'Edit', decision: 'allow' }]);
  });

  // #6824 — per-server MCP enable/disable action.
  it('setMcpServerEnabled sends set_mcp_server_enabled scoped to the active session', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    const sent: Array<Record<string, unknown>> = [];
    const mockSocket = { readyState: 1, send: (d: string) => { sent.push(JSON.parse(d)); } };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: { ...createEmptySessionState() } },
      socket: mockSocket as unknown as WebSocket,
    });

    useConnectionStore.getState().setMcpServerEnabled('filesystem', false);

    const msg = sent.find((m) => m.type === 'set_mcp_server_enabled');
    expect(msg).toBeDefined();
    expect(msg!.sessionId).toBe('s1');
    expect(msg!.server).toBe('filesystem');
    expect(msg!.enabled).toBe(false);
    expect(typeof msg!.requestId).toBe('string');
  });

  it('setMcpServerEnabled sends nothing when the socket is closed (silent no-op, mirrors setPermissionRules)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    const sent: Array<Record<string, unknown>> = [];
    const mockSocket = { readyState: 3, send: (d: string) => { sent.push(JSON.parse(d)); } };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: { ...createEmptySessionState() } },
      socket: mockSocket as unknown as WebSocket,
    });

    useConnectionStore.getState().setMcpServerEnabled('filesystem', true);
    expect(sent.find((m) => m.type === 'set_mcp_server_enabled')).toBeUndefined();
  });

  // #6822 — submit a pasted OAuth authorization code.
  it('submitMcpAuthCode sends submit_mcp_auth_code scoped to the active session, trimming the code', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    const sent: Array<Record<string, unknown>> = [];
    const mockSocket = { readyState: 1, send: (d: string) => { sent.push(JSON.parse(d)); } };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: { ...createEmptySessionState() } },
      socket: mockSocket as unknown as WebSocket,
    });

    useConnectionStore.getState().submitMcpAuthCode('remote', '  code-123  ');

    const msg = sent.find((m) => m.type === 'submit_mcp_auth_code');
    expect(msg).toBeDefined();
    expect(msg!.sessionId).toBe('s1');
    expect(msg!.server).toBe('remote');
    expect(msg!.code).toBe('code-123');
    expect(typeof msg!.requestId).toBe('string');
  });

  it('submitMcpAuthCode is a no-op for an empty code or a closed socket', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    const sent: Array<Record<string, unknown>> = [];
    const openSocket = { readyState: 1, send: (d: string) => { sent.push(JSON.parse(d)); } };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: { ...createEmptySessionState() } },
      socket: openSocket as unknown as WebSocket,
    });
    // Empty/whitespace code → nothing sent.
    useConnectionStore.getState().submitMcpAuthCode('remote', '   ');
    expect(sent.find((m) => m.type === 'submit_mcp_auth_code')).toBeUndefined();

    // Closed socket → nothing sent.
    const closedSocket = { readyState: 3, send: (d: string) => { sent.push(JSON.parse(d)); } };
    useConnectionStore.setState({ socket: closedSocket as unknown as WebSocket });
    useConnectionStore.getState().submitMcpAuthCode('remote', 'code');
    expect(sent.find((m) => m.type === 'submit_mcp_auth_code')).toBeUndefined();
  });

  it('queryPermissionAudit sets the loading flag and sends query_permission_audit scoped to the active session', async () => {
    const { useConnectionStore } = await import('./connection');

    const sent: Array<Record<string, unknown>> = [];
    const mockSocket = { readyState: 1, send: (d: string) => { sent.push(JSON.parse(d)); } };
    useConnectionStore.setState({
      activeSessionId: 's1',
      socket: mockSocket as unknown as WebSocket,
      permissionAudit: null,
      permissionAuditLoading: false,
    });

    useConnectionStore.getState().queryPermissionAudit();

    expect(useConnectionStore.getState().permissionAuditLoading).toBe(true);
    const msg = sent.find((m) => m.type === 'query_permission_audit');
    expect(msg).toBeDefined();
    expect(msg!.sessionId).toBe('s1');
  });

  it('permission_audit_result populates permissionAudit and clears the loading flag', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({ permissionAudit: null, permissionAuditLoading: true });
    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    _testMessageHandler.handle({
      type: 'permission_audit_result',
      entries: [
        { type: 'decision', sessionId: 's1', decision: 'allow', reason: 'user', timestamp: 1 },
        { type: 'mode_change', sessionId: 's1', previousMode: 'approve', newMode: 'auto', timestamp: 2 },
      ],
    });

    const state = useConnectionStore.getState();
    expect(state.permissionAuditLoading).toBe(false);
    expect(state.permissionAudit).toHaveLength(2);
    expect(state.permissionAudit![0]!.type).toBe('decision');
    expect(state.permissionAudit![1]!.newMode).toBe('auto');
    expect(state.permissionAuditError).toBe(false);

    _testMessageHandler.clearContext();
  });

  it('a MALFORMED permission_audit_result clears the loading flag and raises the error state (no wedge)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({ permissionAudit: null, permissionAuditLoading: true, permissionAuditError: false });
    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    // entries must be an array — a scalar fails the schema parse.
    _testMessageHandler.handle({ type: 'permission_audit_result', entries: 'not-an-array' });

    const state = useConnectionStore.getState();
    expect(state.permissionAuditLoading).toBe(false); // button unwedged
    expect(state.permissionAuditError).toBe(true);    // generic load-failed state
    expect(state.permissionAudit).toBeNull();         // no garbage stored

    _testMessageHandler.clearContext();
  });

  it('an UNKNOWN audit entry type still parses (forward-compatible wire schema)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({ permissionAudit: null, permissionAuditLoading: true, permissionAuditError: false });
    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    // A future server-side audit kind must not fail the WHOLE payload (#6836 review).
    _testMessageHandler.handle({
      type: 'permission_audit_result',
      entries: [
        { type: 'rule_expired', sessionId: 's1', timestamp: 1 },
        { type: 'decision', sessionId: 's1', decision: 'allow', timestamp: 2 },
      ],
    });

    const state = useConnectionStore.getState();
    expect(state.permissionAuditLoading).toBe(false);
    expect(state.permissionAuditError).toBe(false);
    expect(state.permissionAudit).toHaveLength(2);
    expect(state.permissionAudit![0]!.type).toBe('rule_expired');

    _testMessageHandler.clearContext();
  });

  it('switchSession clears the permission audit history so it never shows another session\'s entries', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: { ...createEmptySessionState() }, s2: { ...createEmptySessionState() } },
      sessionNotifications: [],
      permissionAudit: [{ type: 'decision', sessionId: 's1', decision: 'allow', timestamp: 1 }],
      permissionAuditLoading: true,
      socket: null,
    });

    useConnectionStore.getState().switchSession('s2');

    const state = useConnectionStore.getState();
    expect(state.activeSessionId).toBe('s2');
    expect(state.permissionAudit).toBeNull();
    expect(state.permissionAuditLoading).toBe(false);
  });

  it('permission_expired for an already-resolved requestId does not mutate the prompt message', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');
    const { _testMessageHandler } = await import('./message-handler');

    const originalContent = 'Allow write?';
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          messages: [{
            id: 'm1', type: 'prompt', content: originalContent, timestamp: 1,
            requestId: 'req-resolved', tool: 'Write',
          }],
        },
      },
      resolvedPermissions: { 'req-resolved': 'allow' },
      sessionNotifications: [{
        id: 'n1', sessionId: 's1', sessionName: 's1', eventType: 'permission',
        message: 'Write', timestamp: 1, requestId: 'req-resolved',
      }],
    });

    _testMessageHandler.setContext({
      url: 'ws://x', token: 't', isReconnect: false, silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });
    _testMessageHandler.handle({ type: 'permission_expired', requestId: 'req-resolved', message: 'timeout' });

    const state = useConnectionStore.getState();
    // The prompt message content must NOT have "(Expired …)" appended —
    // user already answered, so the late expiry is a no-op (#2833).
    const promptMsg = state.sessionStates.s1!.messages[0]!;
    expect(promptMsg.content).toBe(originalContent);
    // #5008 — the notification row is preserved as durable widget history,
    // but stamped read so the banner stack drops it. Pre-#5008 we
    // hard-removed the row, which silently drained every resolved/expired
    // alert from the NotificationsWidget.
    const banner = state.sessionNotifications.find((n) => n.requestId === 'req-resolved');
    expect(banner).toBeDefined();
    expect(banner!.readAt).toBeTypeOf('number');

    _testMessageHandler.clearContext();
  });

  it('permission_expired for an UN-resolved requestId still appends the expiry note', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          messages: [{
            id: 'm1', type: 'prompt', content: 'Allow write?', timestamp: 1,
            requestId: 'req-open', tool: 'Write',
          }],
        },
      },
      resolvedPermissions: {},
    });

    _testMessageHandler.setContext({
      url: 'ws://x', token: 't', isReconnect: false, silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });
    _testMessageHandler.handle({ type: 'permission_expired', requestId: 'req-open', message: 'timeout' });

    const promptMsg = useConnectionStore.getState().sessionStates.s1!.messages[0]!;
    expect(promptMsg.content).toMatch(/Expired/);

    _testMessageHandler.clearContext();
  });

  it('permission_rules_updated stores the rules on the target session', async () => {
    const { useConnectionStore } = await import('./connection');
    const { createEmptySessionState } = await import('./utils');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: createEmptySessionState() },
    });

    _testMessageHandler.setContext({
      url: 'ws://x', token: 't', isReconnect: false, silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });
    _testMessageHandler.handle({
      type: 'permission_rules_updated',
      sessionId: 's1',
      rules: [
        { tool: 'Read', decision: 'allow' },
        { tool: 'Write', decision: 'allow' },
      ],
    });

    const state = useConnectionStore.getState();
    expect(state.sessionStates.s1!.sessionRules).toEqual([
      { tool: 'Read', decision: 'allow' },
      { tool: 'Write', decision: 'allow' },
    ]);

    _testMessageHandler.clearContext();
  });

  it('isRuleEligibleTool covers the same set as the mobile app pattern', async () => {
    const { isRuleEligibleTool } = await import('./connection');
    for (const tool of ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']) {
      expect(isRuleEligibleTool(tool)).toBe(true);
    }
    for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'SomethingNew']) {
      expect(isRuleEligibleTool(tool)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// #4296 — Output tab visibility for AskUserQuestion answers
// ---------------------------------------------------------------------------
// The Output tab is synthesized from a narrow set of sources (user-prompt
// echo via appendTerminalData + chat-text deltas). Pre-#4296, picking an
// option in QuestionPrompt sent the answer over the wire but left NO trace
// in the Output tab — the question JSON appeared, then immediately the next
// tool fired with no record of what the user picked. Fix: echo the resolved
// answer to the terminal buffer in cyan so the Output tab shows a visible
// "User answered: <label>" line in the chronological stream.
describe('sendUserQuestionResponse Output-tab echo (#4296)', () => {
  it('echoes "User answered: <answer>" to the terminal buffer in cyan when the wire send succeeds', async () => {
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse('All three', 'toolu_abc');

    // Wire payload still goes out unchanged
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'user_question_response',
      answer: 'All three',
      toolUseId: 'toolu_abc',
    });

    // Raw buffer carries the cyan-tinted echo so xterm.js renders it
    const { terminalBuffer, terminalRawBuffer } = useConnectionStore.getState();
    expect(terminalRawBuffer).toContain('\x1b[36m');
    expect(terminalRawBuffer).toContain('> User answered: All three');
    expect(terminalRawBuffer).toContain('\x1b[0m');
    // Stripped buffer (for plain-text consumers) carries the message without ANSI
    expect(terminalBuffer).toContain('User answered: All three');
    expect(terminalBuffer).not.toContain('\x1b[');
  });

  it('echoes freeform "Other" custom-text answers identically', async () => {
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse('something else entirely', 'toolu_xyz');

    const { terminalBuffer } = useConnectionStore.getState();
    expect(terminalBuffer).toContain('User answered: something else entirely');
  });

  it('still echoes when the wire send is queued (socket not open)', async () => {
    // Queued path: when the socket is not OPEN, the response is enqueued for
    // replay on reconnect. The Output-tab echo must still fire so the user
    // sees their answer locally even before the server roundtrips it back.
    const { useConnectionStore } = await import('./connection');

    useConnectionStore.setState({
      socket: null,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    const result = useConnectionStore.getState().sendUserQuestionResponse('queued answer', 'toolu_q');
    expect(result).toBe('queued');

    const { terminalBuffer } = useConnectionStore.getState();
    expect(terminalBuffer).toContain('User answered: queued answer');
  });

  it('does not echo when the answer string is empty (defensive)', async () => {
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse('', 'toolu_empty');

    const { terminalRawBuffer } = useConnectionStore.getState();
    // No echo for an empty answer — the wire send still happens (server
    // schema may accept it) but we don't render an "answered:" line for
    // nothing.
    expect(terminalRawBuffer).not.toContain('User answered:');
  });

  // #4735 — answerSummary flattens BOTH native string[] values AND the
  // legacy JSON-stringified array envelope (pre-#4735 wire). Without
  // this, a mixed-version replay where an old dashboard had stashed a
  // JSON-stringified answer in local storage would leak `["App","Tests"]`
  // syntax through the terminal echo and the `answer` summary field.
  it('flattens legacy JSON-stringified array envelopes in the answer summary (#4735 back-compat)', async () => {
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    const legacyAnswersMap = {
      'Which targets?': JSON.stringify(['App', 'Tests']),
      'Confirm?': 'Yes',
    };
    useConnectionStore.getState().sendUserQuestionResponse(legacyAnswersMap, 'toolu_legacy');

    expect(sent).toHaveLength(1);
    const payload = sent[0] as { type: string; answer: string; answers: Record<string, unknown>; toolUseId: string };
    expect(payload.type).toBe('user_question_response');
    // Wire `answers` field passes the legacy JSON-string shape through
    // unchanged (server back-compat for old encoders).
    expect(payload.answers).toEqual(legacyAnswersMap);
    // Summary string flattens BOTH the legacy JSON-string envelope and
    // any native string[] values for the readable `answer` field.
    expect(payload.answer).toBe(
      'Which targets?: App, Tests | Confirm?: Yes',
    );
    // Terminal echo carries the flattened summary, NOT the JSON syntax.
    const { terminalBuffer } = useConnectionStore.getState();
    expect(terminalBuffer).toContain('User answered: Which targets?: App, Tests | Confirm?: Yes');
    expect(terminalBuffer).not.toContain('["App"');
  });

  // #4735 — multi-question multi-select wire format. The widened wire
  // (UserQuestionResponseSchema) accepts `string | string[]` per question.
  // The store should forward the answers map shape verbatim AND populate
  // the `answer` summary field with a comma-joined flattening of any
  // array values so older servers reading only `answer` still see a
  // human-readable line.
  it('forwards multi-question Record<string, string | string[]> verbatim and flattens arrays in the answer summary (#4735)', async () => {
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    const answersMap = {
      'Which release strategy?': 'Patch',
      'Which targets?': ['App', 'Tests'],
      'Confirm?': 'Yes',
    };
    useConnectionStore.getState().sendUserQuestionResponse(answersMap, 'toolu_multi');

    expect(sent).toHaveLength(1);
    const payload = sent[0] as { type: string; answer: string; answers: Record<string, unknown>; toolUseId: string };
    expect(payload.type).toBe('user_question_response');
    expect(payload.toolUseId).toBe('toolu_multi');
    // answers field passes the map through unchanged — arrays stay arrays.
    expect(payload.answers).toEqual({
      'Which release strategy?': 'Patch',
      'Which targets?': ['App', 'Tests'],
      'Confirm?': 'Yes',
    });
    expect(Array.isArray(payload.answers['Which targets?'])).toBe(true);
    // Summary string flattens arrays as comma-joined labels so the
    // string-only `answer` field stays readable on older servers.
    expect(payload.answer).toBe(
      'Which release strategy?: Patch | Which targets?: App, Tests | Confirm?: Yes',
    );
  });

  it('emits {answer:<otherLabel>, freeformText} when called with the Other / freeform shape (#4651)', async () => {
    // #4651 — single-question "Other" path. The dashboard sends both:
    // - `answer` = the Other option's label, so the server can resolve
    //   it to a 1-indexed digit (claude TUI hotkey) and write the digit
    //   FIRST to swap the menu into text-input mode.
    // - `freeformText` = the typed text, which the server writes after
    //   the prompt-swap settles + Enter to submit.
    // The Output-tab echo surfaces the typed text (not the literal
    // "Other" label) to match the user's mental model of what they sent.
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse(
      { otherLabel: 'Other', freeformText: 'my custom answer' },
      'toolu_other_freeform',
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'user_question_response',
      answer: 'Other',
      freeformText: 'my custom answer',
      toolUseId: 'toolu_other_freeform',
    });
    // No `answers` field — that's reserved for multi-question forms.
    expect(sent[0]).not.toHaveProperty('answers');

    const { terminalBuffer } = useConnectionStore.getState();
    expect(terminalBuffer).toContain('User answered: my custom answer');
  });
});

// ---------------------------------------------------------------------------
// #4901 — migration to shared `isFreeformAnswer` predicate from store-core.
// ---------------------------------------------------------------------------
// Pin behaviour after replacing the inline 5-condition shape detector in
// `sendUserQuestionResponse` with the shared `isFreeformAnswer` typed-guard
// from `@chroxy/store-core/freeform-answer` (mobile counterpart migrated in
// #4875 / PR #4900). The migration MUST be a behaviour-neutral refactor:
// the wire payload, the `appendTerminalData` echo, the `runningSince`
// optimistic bump, and the negative-misroute defence (the original Copilot
// review concern in #4753) all stay identical. These tests mirror the
// mobile #4755 block in `packages/app/src/__tests__/store/connection.test.ts`.
describe('sendUserQuestionResponse Other / freeform shape (#4901 shared-guard migration)', () => {
  it('preserves a model-supplied custom Other label on the wire', async () => {
    // Defends against a future regression where we forget to thread
    // `otherLabel` through and instead hard-code the literal "Other"
    // string — the server's digit-lookup would then resolve to the wrong
    // hotkey for any custom-label Other option. Mirrors the mobile
    // counterpart at app/__tests__/store/connection.test.ts (#4755).
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse(
      { otherLabel: 'Something else', freeformText: 'typed' },
      'toolu-custom-other',
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'user_question_response',
      answer: 'Something else',
      freeformText: 'typed',
      toolUseId: 'toolu-custom-other',
    });
  });

  it('omits toolUseId from the wire payload when not provided', async () => {
    // Mirrors the mobile counterpart (#4755). Zero-options free-text
    // AskUserQuestions historically lack a tool pairing.
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse(
      { otherLabel: 'Other', freeformText: 'no-tooluse case' },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'user_question_response',
      answer: 'Other',
      freeformText: 'no-tooluse case',
    });
    expect(sent[0]).not.toHaveProperty('toolUseId');
  });

  // The Copilot review concern from #4753: a multi-question Record whose
  // keys happen to literally be `otherLabel` and `freeformText` must NOT
  // misroute through the freeform branch. The shared guard enforces the
  // tightest possible shape (exactly two keys AND both string values), so
  // any non-string value (string[] for a multi-select, etc.) falls
  // through to the multi-question Record path with `answers` populated
  // and the freeform `freeformText` field absent.
  it('does NOT misroute a multi-question Record whose keys happen to be otherLabel + freeformText with non-string values', async () => {
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    // A model-phrased multi-question form whose question keys happen to
    // literally be `otherLabel` and `freeformText` AND whose answers are
    // arrays (multi-select). The shared guard rejects this (array values
    // fail the `typeof === 'string'` check), so it must serialize as a
    // multi-question Record on the wire.
    const adversarial = {
      otherLabel: ['Patch', 'Minor'],
      freeformText: ['App', 'Tests'],
    };
    useConnectionStore.getState().sendUserQuestionResponse(
      adversarial as unknown as Record<string, string | string[]>,
      'toolu-adversarial',
    );

    expect(sent).toHaveLength(1);
    const payload = sent[0] as Record<string, unknown>;
    expect(payload.type).toBe('user_question_response');
    expect(payload.toolUseId).toBe('toolu-adversarial');
    // Multi-question path: `answers` carries the verbatim map.
    expect(payload.answers).toEqual(adversarial);
    // Freeform-only field MUST be absent — proof we did not misroute.
    expect(payload).not.toHaveProperty('freeformText');
  });

  // The acceptance criteria says no behavioural change to the
  // `appendTerminalData` echo path. This pin defends against an accidental
  // narrowing or branch reordering during the migration that would skip
  // the terminal echo for freeform answers (the cyan "User answered:" line
  // landed in #4296 and gates on `answerSummary` being non-empty).
  it('still echoes the freeform text into the terminal buffer (#4296 / #4901 acceptance)', async () => {
    const { useConnectionStore } = await import('./connection');

    const mockSocket = {
      readyState: 1,
      send: () => { /* swallow */ },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse(
      { otherLabel: 'Other', freeformText: 'typed answer for echo pin' },
      'toolu-echo',
    );

    const { terminalBuffer } = useConnectionStore.getState();
    // ANSI is stripped by the dashboard's terminal-buffer pipeline
    // (cyan/yellow distinction lives in the rawBuffer / terminal renderer).
    // The acceptance criteria pin here is just that the cyan-prefixed echo
    // line still fires for freeform answers under the shared guard — i.e.
    // the post-detection branch that calls `appendTerminalData` is taken.
    expect(terminalBuffer).toContain('User answered: typed answer for echo pin');
    // The "> " prefix is part of the echo template — if it disappears it
    // means the echo path was bypassed and only the formatQuestionAnswerSummary
    // fallback wrote into the buffer.
    expect(terminalBuffer).toContain('> User answered:');
  });

  // Mirrors mobile #4755 third test: legacy string answers must keep the
  // back-compat wire shape — `freeformText` MUST be absent so older
  // servers cannot misclassify a plain option tap as an Other / freeform
  // send (Zod schema strict-mode would also reject extras here).
  it('keeps the legacy {answer:<string>, toolUseId} shape for plain string answers and OMITS freeformText', async () => {
    const { useConnectionStore } = await import('./connection');

    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse('Option A', 'toolu-string');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'user_question_response',
      answer: 'Option A',
      toolUseId: 'toolu-string',
    });
    expect(sent[0]).not.toHaveProperty('freeformText');
    expect(sent[0]).not.toHaveProperty('answers');
  });
});

// ---------------------------------------------------------------------------
// #4312 — optimistic busy-state bump on answer send
// ---------------------------------------------------------------------------
// sendInput (the regular chat path) implicitly puts the dashboard into a
// "running" visual state via the input-bump path; sendUserQuestionResponse
// historically skipped this, so the per-session activity dot + ActivityIndicator
// stayed idle in the gap between answer-send and the next server-emitted
// stream/tool event. The fix mirrors sendInput by flipping isIdle:false and
// stamping lastClientActivityAt on the active session before the wire send.
describe('sendUserQuestionResponse optimistic activity bump (#4312)', () => {
  it('flips active session to running (isIdle:false) and bumps lastClientActivityAt', async () => {
    const { useConnectionStore } = await import('./connection');

    const mockSocket = {
      readyState: 1,
      send: () => { /* swallow */ },
    };

    const beforeNow = Date.now();

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          isIdle: true,
          lastClientActivityAt: null,
        },
      },
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse('Option A', 'toolu_abc');

    const ss = useConnectionStore.getState().sessionStates.s1!;
    expect(ss.isIdle).toBe(false);
    expect(ss.lastClientActivityAt).not.toBeNull();
    expect(ss.lastClientActivityAt!).toBeGreaterThanOrEqual(beforeNow);

    // Clean up so unrelated tests don't see stale active session state.
    useConnectionStore.setState({
      activeSessionId: null,
      sessionStates: {},
    });
  });
});

// #4465: when the user answers a TUI AskUserQuestion, claude TUI may or may
// not emit PostToolUse for it (v0.9.12 — empirical: the prompt resolves but
// the hook never fires for some question shapes). Without server-side
// tool_result the dashboard's activeTools entry sits forever, so the footer
// pill keeps ticking `Running AskUserQuestion · Nm Ns` indefinitely.
//
// Fix: when the user answers via the QuestionPrompt UI, optimistically drop
// the matching activeTools entry. If the server later does fire tool_result,
// sharedToolResult is idempotent on missing entries. If it doesn't (#4465's
// stall case), the pill clears anyway.
describe('sendUserQuestionResponse clears in-flight tool slot (#4465)', () => {
  it('drops the matching activeTools entry when called with toolUseId', async () => {
    const { useConnectionStore } = await import('./connection');
    const mockSocket = { readyState: 1, send: () => {} };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          activeTools: [
            { toolUseId: 'tu-ask-1', tool: 'AskUserQuestion', input: {}, startedAt: 100 },
            // Sibling in-flight tool that must NOT be cleared.
            { toolUseId: 'tu-bash-1', tool: 'Bash', input: { command: 'ls' }, startedAt: 150 },
          ],
        },
      },
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse('Option A', 'tu-ask-1');

    const ss = useConnectionStore.getState().sessionStates.s1!;
    expect(ss.activeTools.map(t => t.toolUseId)).toEqual(['tu-bash-1']);

    useConnectionStore.setState({ activeSessionId: null, sessionStates: {} });
  });

  it('is a no-op on activeTools when called without toolUseId (free-text fallback)', async () => {
    // Some legacy callsites send the answer without a toolUseId (free-text
    // question prompts where the dashboard can't pair to a specific tool).
    // Those must NOT clear any in-flight tool — the server stays
    // authoritative.
    const { useConnectionStore } = await import('./connection');
    const mockSocket = { readyState: 1, send: () => {} };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          activeTools: [
            { toolUseId: 'tu-ask-1', tool: 'AskUserQuestion', input: {}, startedAt: 100 },
          ],
        },
      },
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse('A');

    const ss = useConnectionStore.getState().sessionStates.s1!;
    expect(ss.activeTools).toHaveLength(1)
    expect(ss.activeTools[0]!.toolUseId).toBe('tu-ask-1')

    useConnectionStore.setState({ activeSessionId: null, sessionStates: {} });
  });

  // Regression for agent-review critical finding (#4499): the
  // ActivityIndicator messages-walk fallback re-surfaces the AskUserQuestion
  // tool_use the moment activeTools empties. Optimistically clearing
  // activeTools alone is insufficient — we must ALSO patch the tool_use
  // ChatMessage in messages[] so findInFlightToolUse no longer treats it
  // as in-flight.
  it('patches the tool_use ChatMessage in messages[] so the walk fallback no longer surfaces it (#4499)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { findInFlightToolUse } = await import('../components/ActivityIndicator');
    const mockSocket = { readyState: 1, send: () => {} };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          activeTools: [
            { toolUseId: 'tu-ask-walk', tool: 'AskUserQuestion', input: {}, startedAt: 100 },
          ],
          // tool_use ChatMessage pushed by handleToolStart — same id as the
          // toolUseId per claude-tui-session.js:1115. toolResult undefined
          // because PostToolUse never fired (the #4465 scenario).
          messages: [
            { id: 'tu-ask-walk', type: 'tool_use', tool: 'AskUserQuestion', content: '', timestamp: 100 },
          ],
        },
      },
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    // Sanity: before the answer, the walk fallback finds the in-flight tool.
    const before = findInFlightToolUse(
      useConnectionStore.getState().sessionStates.s1!.messages,
    );
    expect(before).not.toBeNull();
    expect(before!.tool).toBe('AskUserQuestion');

    useConnectionStore.getState().sendUserQuestionResponse('A', 'tu-ask-walk');

    const after = useConnectionStore.getState().sessionStates.s1!;
    expect(after.activeTools).toEqual([]);
    // The walk fallback no longer surfaces the AskUserQuestion because the
    // tool_use now carries a synthetic toolResult.
    const post = findInFlightToolUse(after.messages);
    expect(post).toBeNull();

    useConnectionStore.setState({ activeSessionId: null, sessionStates: {} });
  });

  it('leaves an already-resolved tool_use intact (no double-patch)', async () => {
    // Defense: if the server's tool_result already landed for the AskUserQuestion
    // and patched toolResult on the message, the answer-send must NOT overwrite
    // the real result with our sentinel.
    const { useConnectionStore } = await import('./connection');
    const mockSocket = { readyState: 1, send: () => {} };

    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          activeTools: [],
          messages: [
            { id: 'tu-already-resolved', type: 'tool_use', tool: 'AskUserQuestion', content: '', toolResult: 'server answer', timestamp: 100 },
          ],
        },
      },
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse('A', 'tu-already-resolved');

    const ss = useConnectionStore.getState().sessionStates.s1!;
    const m = ss.messages.find(x => x.id === 'tu-already-resolved');
    expect(m?.toolResult).toBe('server answer');

    useConnectionStore.setState({ activeSessionId: null, sessionStates: {} });
  });

  it('a subsequent server-emitted tool_result for the same toolUseId is a no-op (idempotent)', async () => {
    // After the optimistic clear, if claude TUI does eventually emit
    // PostToolUse, the resulting tool_result hits sharedToolResult which
    // looks up by toolUseId and finds nothing — no double-clear, no
    // re-append. Verifies the cross-PR contract isn't broken.
    const { useConnectionStore } = await import('./connection');
    const { handleMessage } = await import('./message-handler');

    const mockSocket = { readyState: 1, send: () => {} };
    useConnectionStore.setState({
      socket: mockSocket as unknown as WebSocket,
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          activeTools: [
            { toolUseId: 'tu-ask-2', tool: 'AskUserQuestion', input: {}, startedAt: 100 },
          ],
        },
      },
      terminalBuffer: '',
      terminalRawBuffer: '',
    });

    useConnectionStore.getState().sendUserQuestionResponse('B', 'tu-ask-2');
    // Late tool_result arrives.
    handleMessage(
      { type: 'tool_result', toolUseId: 'tu-ask-2', result: 'B', sessionId: 's1' },
      { url: 'wss://t' } as any,
    );
    const ss = useConnectionStore.getState().sessionStates.s1!;
    expect(ss.activeTools).toEqual([]);

    useConnectionStore.setState({ activeSessionId: null, sessionStates: {} });
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

// ---------------------------------------------------------------------------
// App.tsx toast filtering — session-scoped server_error (#1804)
// ---------------------------------------------------------------------------
describe('reconnect scheduling dedupe (#3624)', () => {
  /**
   * Browsers fire `error` → `close` for the same transport drop, so without
   * dedupe both `socket.onerror` and `socket.onclose` would each schedule a
   * `setTimeout(connect)`. Dedupe is per-socket via `reconnectScheduled`
   * inside `scheduleReconnect`: the first call arms the timer; the second
   * call (from the same socket's other event) short-circuits.
   *
   * Why per-socket and not phase-only: `connectionPhase: 'reconnecting'`
   * is overloaded — `connect()` sets it for in-flight reconnect attempts
   * BEFORE the new socket has finished the auth handshake. If that new
   * socket then fails, phase-only gating would skip arming a fresh retry
   * (because phase is already 'reconnecting') and leave the UI stuck.
   * Each new socket gets its own scheduler with `reconnectScheduled=false`,
   * so failed reconnects can still arm subsequent retries.
   *
   * `connectionError` is first-write-wins: both events carry equally
   * generic messages, so flipping mid-display would just be visual churn.
   *
   * History: originally landed as #3615 (introduced the flag); audit
   * under #3624 confirmed the flag closes a real gap that phase-only
   * dedupe cannot. The dedupe sites also stop the error→close ordering
   * from clobbering 'reconnecting' back to 'disconnected'.
   */
  type ReconnectMockSocket = {
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    close: () => void;
  };

  type SetTimeoutCallTuple = [() => void, number];

  async function setupReconnectScenario(): Promise<{
    socket: ReconnectMockSocket;
    wsConstructions: { count: number };
    reconnectTimers: SetTimeoutCallTuple[];
    teardown: () => void;
  }> {
    const { useConnectionStore } = await import('./connection');

    // Mock health check so connect() advances to _connectWebSocket().
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const captured: { socket: ReconnectMockSocket | null } = { socket: null };
    const wsConstructions = { count: 0 };

    class MockWebSocket {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      readyState = 0;
      constructor(_url: string) {
        wsConstructions.count++;
        captured.socket = this as unknown as ReconnectMockSocket;
      }
      send(_data: string): void { /* no-op */ }
      close(): void { this.readyState = 3; }
    }
    (MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
    vi.stubGlobal('WebSocket', MockWebSocket);

    // Filter setTimeout calls down to "reconnect" timers (>=1000ms). We avoid
    // fake timers because the connect() flow uses Promise microtasks for the
    // health check; mixing fake timers + microtasks turned out to be flaky.
    const reconnectTimers: SetTimeoutCallTuple[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.fn((fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms >= 1000) {
        reconnectTimers.push([fn, ms]);
        // Don't actually schedule reconnect timers — we only want to count them.
        // Returning a sentinel id is fine because production code never reads it.
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    });
    vi.stubGlobal('setTimeout', setTimeoutSpy);

    // Pre-populate one connected session so onclose treats this as an
    // unexpected drop (wasConnected=true) and schedules a reconnect.
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState() },
      },
      socket: null,
      userDisconnected: false,
      connectionPhase: 'connected',
    });

    void useConnectionStore.getState().connect('wss://example.invalid', 'tok');

    // Let the mocked fetch().then chain run so _connectWebSocket() executes.
    await new Promise((r) => realSetTimeout(r, 0));
    await new Promise((r) => realSetTimeout(r, 0));

    if (!captured.socket) throw new Error('MockWebSocket was never constructed');
    // Reset wsConstructions count to 0 so the test only counts reconnect-driven
    // WebSocket constructions (not the initial connect).
    wsConstructions.count = 0;
    // Reset reconnectTimers — only count timers armed AFTER the initial connect.
    reconnectTimers.length = 0;

    // Move phase back to 'connected' so onclose treats this drop as an
    // unexpected loss (wasConnected=true). connect() transitions to
    // 'connecting' on its own; in production this would advance to
    // 'connected' via the auth_ok handler we don't run here.
    useConnectionStore.setState({ connectionPhase: 'connected' });

    const teardown = () => {
      vi.unstubAllGlobals();
      useConnectionStore.setState({
        sessions: [],
        activeSessionId: null,
        sessionStates: {},
        userDisconnected: true,
        socket: null,
        connectionPhase: 'disconnected',
      });
    };

    return { socket: captured.socket, wsConstructions, reconnectTimers, teardown };
  }

  it('arms exactly one reconnect timer for an error → close pair', async () => {
    const { useConnectionStore } = await import('./connection');
    const { socket, reconnectTimers, teardown } = await setupReconnectScenario();

    try {
      // Order matches browser semantics for a transport drop.
      socket.onerror!();
      socket.onclose!();

      expect(reconnectTimers).toHaveLength(1);
      // #3633: pin the rest of the reconnecting-state patch from
      // scheduleReconnect — first-write-wins on connectionError, and
      // connectionRetryCount must be reset to 0 exactly once. Without
      // these assertions a regression that double-fires the patch (or
      // overwrites connectionError on the second event) would still
      // pass the timer-count check but break the operator-visible UI.
      const state = useConnectionStore.getState();
      expect(state.connectionError).toBe('Connection error');
      expect(state.connectionRetryCount).toBe(0);
      // Note: connectionPhase after error → close is BLOCKED by the
      // onclose-else-branch clobber tracked in #3632 (fixed in PR #3631
      // — this PR can't assert phase here without depending on that fix
      // landing). PR #3631's `preserves connectionPhase=reconnecting
      // through error → close ordering` covers the missing assertion.
    } finally {
      teardown();
    }
  });

  it('arms exactly one reconnect timer for a close → error pair', async () => {
    // Some failure modes (e.g. server-initiated close) fire close-then-error.
    // Either way we want the dedupe to hold.
    const { useConnectionStore } = await import('./connection');
    const { socket, reconnectTimers, teardown } = await setupReconnectScenario();

    try {
      socket.onclose!();
      socket.onerror!();

      expect(reconnectTimers).toHaveLength(1);
      // #3633: full state-after-both assertions for the close → error
      // path (the easier ordering — onclose's wasConnected gate runs
      // first, schedule fires, onerror's reconnectScheduled flag
      // short-circuits the second call cleanly).
      const state = useConnectionStore.getState();
      expect(state.connectionPhase).toBe('reconnecting');
      expect(state.connectionError).toBe('Connection lost');
      expect(state.connectionRetryCount).toBe(0);
    } finally {
      teardown();
    }
  });

  it('repeated onerror fires after onclose do not drift the reconnecting-state patch (idempotent)', async () => {
    // #3633: pin idempotency for the *reconnecting-state patch only* —
    // additional onerror fires from the same transport drop must not
    // change connectionPhase / connectionError / connectionRetryCount.
    // Today this holds because scheduleReconnect short-circuits via
    // the per-socket `reconnectScheduled` flag, so the patch (the
    // `set({ connectionPhase: 'reconnecting', connectionError, ... })`
    // call inside scheduleReconnect) only runs once. onerror itself
    // does perform other cleanup on each fire (clearing the local
    // socket ref, draining pending trust grants, etc.) — that's NOT
    // what's being tested here. A future regression that bypassed the
    // reconnectScheduled flag would silently re-apply the
    // reconnecting-state patch without changing the timer count, and
    // these assertions would catch it.
    //
    // Note: we do NOT exercise repeated onclose fires here because
    // onclose's else-branch clobbers phase to 'disconnected' on the
    // second fire (separate bug, #3632 / fixed in PR #3631). That
    // codepath isn't part of this idempotency contract.
    const { useConnectionStore } = await import('./connection');
    const { socket, reconnectTimers, teardown } = await setupReconnectScenario();

    try {
      socket.onclose!();
      const after1 = useConnectionStore.getState();
      const snapshot = {
        phase: after1.connectionPhase,
        error: after1.connectionError,
        retry: after1.connectionRetryCount,
      };

      socket.onerror!();
      socket.onerror!();
      socket.onerror!();
      const after4 = useConnectionStore.getState();

      expect(reconnectTimers).toHaveLength(1);
      expect(after4.connectionPhase).toBe(snapshot.phase);
      expect(after4.connectionError).toBe(snapshot.error);
      expect(after4.connectionRetryCount).toBe(snapshot.retry);
    } finally {
      teardown();
    }
  });

  it('does not schedule a reconnect after disconnect()', async () => {
    // After user-initiated disconnect, both onclose and onerror should
    // short-circuit before scheduling.
    const { useConnectionStore } = await import('./connection');
    const { socket, reconnectTimers, teardown } = await setupReconnectScenario();

    try {
      useConnectionStore.getState().disconnect();
      // disconnect() nulls out socket.onclose, but the onerror handler on the
      // captured socket is still wired — fire it to verify the guard.
      socket.onerror?.();

      expect(reconnectTimers).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  // #3624: pin connectionError first-write-wins. When onerror fires after
  // onclose for the same transport drop, the second event must NOT
  // overwrite the connectionError that onclose already set — both messages
  // are equally generic, so flipping mid-display would just be visual
  // churn. Conversely, when onerror fires first, its "Connection error"
  // message stays put and onclose's "Connection lost" is suppressed.
  it('connectionError is set by whichever event runs first (close → error)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { socket, teardown } = await setupReconnectScenario();
    try {
      socket.onclose!();
      expect(useConnectionStore.getState().connectionError).toBe('Connection lost');
      socket.onerror!();
      // onerror after onclose must NOT clobber the message
      expect(useConnectionStore.getState().connectionError).toBe('Connection lost');
    } finally {
      teardown();
    }
  });

  it('connectionError is set by whichever event runs first (error → close)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { socket, teardown } = await setupReconnectScenario();
    try {
      socket.onerror!();
      expect(useConnectionStore.getState().connectionError).toBe('Connection error');
      socket.onclose!();
      // onclose after onerror must NOT clobber the message
      expect(useConnectionStore.getState().connectionError).toBe('Connection error');
    } finally {
      teardown();
    }
  });

  // #3624: when onerror runs first, it transitions phase to 'reconnecting'
  // and arms the timer. The subsequent onclose for the same drop must NOT
  // clobber phase back to 'disconnected' — that briefly flashes the wrong
  // status until the retry timer fires.
  it('preserves connectionPhase=reconnecting through error → close ordering', async () => {
    const { useConnectionStore } = await import('./connection');
    const { socket, teardown } = await setupReconnectScenario();
    try {
      socket.onerror!();
      expect(useConnectionStore.getState().connectionPhase).toBe('reconnecting');
      socket.onclose!();
      expect(useConnectionStore.getState().connectionPhase).toBe('reconnecting');
    } finally {
      teardown();
    }
  });
});

describe('server_error toast scope filtering', () => {
  // Replicates the exact filter from App.tsx toastItems useMemo:
  //   serverErrors.filter(e => !e.sessionId || e.sessionId === activeSessionId)
  function toastFilter(
    serverErrors: { id: string; message: string; sessionId?: string }[],
    activeSessionId: string | null,
  ) {
    return serverErrors
      .filter(e => !e.sessionId || e.sessionId === activeSessionId)
      .map(e => ({ id: e.id, message: e.message }));
  }

  it('shows global errors (no sessionId) regardless of active session', () => {
    const errors = [
      { id: 'e1', message: 'Tunnel lost', sessionId: undefined },
    ];
    const items = toastFilter(errors, 's1');
    expect(items).toHaveLength(1);
    expect(items[0]!.message).toBe('Tunnel lost');
  });

  it('hides session-scoped errors for non-active sessions', () => {
    const errors = [
      { id: 'e1', message: 'Global error' },
      { id: 'e2', message: 'Session s2 error', sessionId: 's2' },
    ];
    const items = toastFilter(errors, 's1');
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('e1');
  });

  it('shows session-scoped errors when they match the active session', () => {
    const errors = [
      { id: 'e1', message: 'Global error' },
      { id: 'e2', message: 'Session s1 error', sessionId: 's1' },
    ];
    const items = toastFilter(errors, 's1');
    expect(items).toHaveLength(2);
    expect(items.map(i => i.id)).toEqual(['e1', 'e2']);
  });

  it('shows only global errors when active session has no scoped errors', () => {
    const errors = [
      { id: 'e1', message: 'Global' },
      { id: 'e2', message: 'For s2', sessionId: 's2' },
      { id: 'e3', message: 'For s3', sessionId: 's3' },
    ];
    const items = toastFilter(errors, 's1');
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('e1');
  });

  it('shows all errors when activeSessionId is null (global + unscoped)', () => {
    const errors = [
      { id: 'e1', message: 'Global error' },
      { id: 'e2', message: 'Scoped error', sessionId: 's1' },
    ];
    // activeSessionId is null — scoped errors don't match null, so only global shows
    const items = toastFilter(errors, null);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('e1');
  });

  it('returns empty when all errors are scoped to other sessions', () => {
    const errors = [
      { id: 'e1', message: 'For s2', sessionId: 's2' },
      { id: 'e2', message: 'For s3', sessionId: 's3' },
    ];
    const items = toastFilter(errors, 's1');
    expect(items).toHaveLength(0);
  });

  it('integration: store serverErrors + activeSessionId filter correctly', async () => {
    const { useConnectionStore } = await import('./connection');

    useConnectionStore.setState({
      activeSessionId: 's1',
      serverErrors: [
        { id: 'e1', category: 'tunnel', message: 'Tunnel lost', recoverable: true, timestamp: 1 },
        { id: 'e2', category: 'session', message: 'Process crashed', recoverable: true, timestamp: 2, sessionId: 's2' },
        { id: 'e3', category: 'session', message: 'OOM', recoverable: false, timestamp: 3, sessionId: 's1' },
      ],
    });

    const { serverErrors, activeSessionId } = useConnectionStore.getState();
    const items = serverErrors
      .filter(e => !e.sessionId || e.sessionId === activeSessionId)
      .map(e => ({ id: e.id, message: e.message }));

    // e1 (global) and e3 (matches active s1) shown; e2 (scoped to s2) hidden
    expect(items).toHaveLength(2);
    expect(items.map(i => i.id)).toEqual(['e1', 'e3']);

    useConnectionStore.setState({ serverErrors: [], activeSessionId: null });
  });

  it('budget_exceeded adds system message once for active session (no duplication)', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    const sessionState = { ...createEmptySessionState(), messages: [] as ChatMessage[] };
    useConnectionStore.setState({
      activeSessionId: 's1',
      messages: [],
      sessionStates: { s1: sessionState },
    });

    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    _testMessageHandler.handle({
      type: 'budget_exceeded',
      sessionId: 's1',
      message: 'Cost budget exceeded ($5.00/$5.00)',
    });

    const state = useConnectionStore.getState();
    // updateSession syncs to flat messages for active session, so only 1 copy should exist
    const flatBudgetMsgs = state.messages.filter(
      (m: ChatMessage) => m.type === 'system' && m.content.includes('budget')
    );
    expect(flatBudgetMsgs).toHaveLength(1);

    // Session state should also have exactly 1
    const ssMsgs = (state.sessionStates.s1 as SessionState).messages.filter(
      (m: ChatMessage) => m.type === 'system' && m.content.includes('budget')
    );
    expect(ssMsgs).toHaveLength(1);

    _testMessageHandler.clearContext();
    useConnectionStore.setState({ activeSessionId: null, messages: [], sessionStates: {} });
  });

  it('error message is handled without throwing', async () => {
    const { _testMessageHandler } = await import('./message-handler');

    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    expect(() => {
      _testMessageHandler.handle({
        type: 'error',
        requestId: 'req-abc',
        code: 'HANDLER_ERROR',
        message: 'Checkpoint creation failed',
      });
    }).not.toThrow();

    _testMessageHandler.clearContext();
  });

  it('error message surfaces via addServerError', async () => {
    const { useConnectionStore } = await import('./connection');
    const { _testMessageHandler } = await import('./message-handler');

    useConnectionStore.setState({ serverErrors: [] });

    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    _testMessageHandler.handle({
      type: 'error',
      requestId: null,
      code: 'HANDLER_ERROR',
      message: 'Something failed on the server',
    });

    const { serverErrors } = useConnectionStore.getState();
    expect(serverErrors.length).toBeGreaterThanOrEqual(1);
    expect(serverErrors.some((e: { message: string }) => e.message === 'Something failed on the server')).toBe(true);

    _testMessageHandler.clearContext();
    useConnectionStore.setState({ serverErrors: [] });
  });

  it('error message with missing fields is handled gracefully', async () => {
    const { _testMessageHandler } = await import('./message-handler');

    _testMessageHandler.setContext({
      url: 'ws://localhost:3000',
      token: 'test-token',
      isReconnect: false,
      silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    });

    expect(() => {
      _testMessageHandler.handle({ type: 'error' });
    }).not.toThrow();

    _testMessageHandler.clearContext();
  });

  // #3588: skill_trust_grant in-flight tracking — the grantCommunitySkillTrust
  // action records the requestId on the active session's pendingTrustGrants
  // list so the SkillsPanel can render an in-flight state. The disconnect
  // path must clear the list so a stale entry doesn't leak across reconnects.
  describe('grantCommunitySkillTrust pendingTrustGrants tracking (#3588)', () => {
    it('appends a pendingTrustGrants entry when the WS message is sent', async () => {
      const { useConnectionStore } = await import('./connection');
      const sent: string[] = [];

      useConnectionStore.setState({
        activeSessionId: 's1',
        sessionStates: {
          s1: { ...createEmptySessionState() },
        },
        socket: {
          send: (data: string) => sent.push(data),
          readyState: 1,
        } as unknown as WebSocket,
      });

      useConnectionStore.getState().grantCommunitySkillTrust('alice-skill', 'alice');

      // WS payload was sent.
      expect(sent).toHaveLength(1);
      const wire = JSON.parse(sent[0]!);
      expect(wire.type).toBe('skill_trust_grant');
      expect(wire.skillName).toBe('alice-skill');
      expect(wire.author).toBe('alice');
      expect(typeof wire.requestId).toBe('string');

      // Pending entry was recorded with the same requestId.
      const ss = useConnectionStore.getState().sessionStates.s1!;
      expect(ss.pendingTrustGrants).toHaveLength(1);
      expect(ss.pendingTrustGrants![0]).toEqual({
        requestId: wire.requestId,
        skillName: 'alice-skill',
        author: 'alice',
      });

      // Cleanup
      useConnectionStore.setState({
        sessions: [],
        activeSessionId: null,
        sessionStates: {},
        socket: null,
      });
    });

    it('de-dupes per (skillName, author) so a re-click replaces the stale requestId', async () => {
      // Defensive: if the operator rage-clicks Trust twice before the
      // first response arrives, we should track only the latest
      // requestId — otherwise the second response would only clear one
      // of two entries and the row would stay stuck.
      const { useConnectionStore } = await import('./connection');
      const sent: string[] = [];

      useConnectionStore.setState({
        activeSessionId: 's1',
        sessionStates: {
          s1: { ...createEmptySessionState() },
        },
        socket: {
          send: (data: string) => sent.push(data),
          readyState: 1,
        } as unknown as WebSocket,
      });

      useConnectionStore.getState().grantCommunitySkillTrust('alice-skill', 'alice');
      useConnectionStore.getState().grantCommunitySkillTrust('alice-skill', 'alice');

      // Two WS messages went out, but only one pending entry remains —
      // the latest requestId wins.
      expect(sent).toHaveLength(2);
      const wire2 = JSON.parse(sent[1]!);

      const ss = useConnectionStore.getState().sessionStates.s1!;
      expect(ss.pendingTrustGrants).toHaveLength(1);
      expect(ss.pendingTrustGrants![0]!.requestId).toBe(wire2.requestId);

      useConnectionStore.setState({
        sessions: [],
        activeSessionId: null,
        sessionStates: {},
        socket: null,
      });
    });

    it('disconnect clears pendingTrustGrants on every session', async () => {
      const { useConnectionStore } = await import('./connection');

      useConnectionStore.setState({
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            pendingTrustGrants: [
              { requestId: 'req-1', skillName: 'alice-skill', author: 'alice' },
            ],
          },
          s2: {
            ...createEmptySessionState(),
            pendingTrustGrants: [
              { requestId: 'req-2', skillName: 'bob-skill', author: 'bob' },
            ],
          },
        },
        socket: null,
      });

      useConnectionStore.getState().disconnect();

      const after = useConnectionStore.getState().sessionStates;
      expect(after.s1!.pendingTrustGrants).toEqual([]);
      expect(after.s2!.pendingTrustGrants).toEqual([]);

      useConnectionStore.setState({
        sessions: [],
        activeSessionId: null,
        sessionStates: {},
        userDisconnected: false,
      });
    });
  });

  // #3605: PR #3600 only cleared pendingTrustGrants in disconnect()
  // (user-initiated). The auto-reconnect path (socket.onclose / socket.onerror)
  // doesn't call disconnect(), so an in-flight entry could survive a transient
  // drop and leave the SkillsPanel "Trust" button stuck after reconnect.
  describe('pendingTrustGrants cleanup on auto-reconnect path (#3605)', () => {
    /**
     * Drives connect() far enough to wire up the real socket.onclose /
     * socket.onerror handlers, then returns the captured socket so the test
     * can fire the handler synchronously. We mock fetch (health check) and
     * WebSocket so no real network IO happens.
     */
    async function setupCapturedSocket(): Promise<{
      socket: { onclose: (() => void) | null; onerror: (() => void) | null; close: () => void };
      teardown: () => void;
    }> {
      const { useConnectionStore } = await import('./connection');
      const { bumpConnectionAttemptId } = await import('./message-handler');

      // Mock health check so connect() advances to _connectWebSocket().
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      }));
      vi.stubGlobal('fetch', fetchSpy);

      const captured: {
        socket: { onclose: (() => void) | null; onerror: (() => void) | null; close: () => void } | null;
      } = { socket: null };

      class MockWebSocket {
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: ((ev: { data: string }) => void) | null = null;
        readyState = 0;
        constructor(_url: string) {
          captured.socket = this as unknown as {
            onclose: (() => void) | null;
            onerror: (() => void) | null;
            close: () => void;
          };
        }
        send(_data: string): void { /* no-op */ }
        close(): void { this.readyState = 3; }
      }
      // Mirror the static OPEN constant the production code references.
      (MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
      vi.stubGlobal('WebSocket', MockWebSocket);

      // Pre-populate two sessions with in-flight pendingTrustGrants.
      useConnectionStore.setState({
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            pendingTrustGrants: [
              { requestId: 'req-1', skillName: 'alice-skill', author: 'alice' },
            ],
          },
          s2: {
            ...createEmptySessionState(),
            pendingTrustGrants: [
              { requestId: 'req-2', skillName: 'bob-skill', author: 'bob' },
            ],
          },
        },
        socket: null,
        userDisconnected: false,
        connectionPhase: 'connected',
      });

      // Kick off connect — health check and ws-construction both run async.
      void useConnectionStore.getState().connect('wss://example.invalid', 'tok');

      // Let the mocked fetch().then chain run so _connectWebSocket() executes.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      if (!captured.socket) throw new Error('MockWebSocket was never constructed');

      const teardown = () => {
        // #3616: cancel any auto-reconnect setTimeout scheduled by
        // socket.onclose/socket.onerror. The reconnect callback gates on
        // `myAttemptId !== connectionAttemptId`, so bumping the attempt id
        // here invalidates the captured `myAttemptId` and the timer becomes
        // a no-op. Without this, a stale timer from one test could fire
        // during the next test's setup phase and call connect() unexpectedly.
        bumpConnectionAttemptId();
        vi.unstubAllGlobals();
        useConnectionStore.setState({
          sessions: [],
          activeSessionId: null,
          sessionStates: {},
          userDisconnected: true, // suppress further auto-reconnect attempts
          socket: null,
          connectionPhase: 'disconnected',
        });
      };

      return { socket: captured.socket, teardown };
    }

    it('clears pendingTrustGrants when onclose fires (transport drop, not user disconnect)', async () => {
      const { useConnectionStore } = await import('./connection');
      const { socket, teardown } = await setupCapturedSocket();

      try {
        // Sanity: handlers wired up.
        expect(typeof socket.onclose).toBe('function');

        // Fire onclose to simulate a transient transport drop. This is the
        // codepath PR #3600 missed — onclose triggers auto-reconnect, not
        // disconnect(), so without #3605 the pendingTrustGrants arrays
        // would survive the drop.
        socket.onclose!();

        const after = useConnectionStore.getState().sessionStates;
        expect(after.s1!.pendingTrustGrants).toEqual([]);
        expect(after.s2!.pendingTrustGrants).toEqual([]);
      } finally {
        teardown();
      }
    });

    it('clears pendingTrustGrants when onerror fires', async () => {
      const { useConnectionStore } = await import('./connection');
      const { socket, teardown } = await setupCapturedSocket();

      try {
        expect(typeof socket.onerror).toBe('function');

        socket.onerror!();

        const after = useConnectionStore.getState().sessionStates;
        expect(after.s1!.pendingTrustGrants).toEqual([]);
        expect(after.s2!.pendingTrustGrants).toEqual([]);
      } finally {
        teardown();
      }
    });

    // #6289: externalSessionsLoading was absent from the #6153 onclose survey
    // sweep, so a refresh in flight when the socket dropped left the mission-
    // control survey's Refresh button disabled forever (refreshDisabled = loading
    // || !connected, and no reconnect path could re-issue the request).
    it('clears externalSessionsLoading when onclose fires (#6289)', async () => {
      const { useConnectionStore } = await import('./connection');
      const { socket, teardown } = await setupCapturedSocket();

      try {
        useConnectionStore.setState({ externalSessionsLoading: true });
        socket.onclose!();
        expect(useConnectionStore.getState().externalSessionsLoading).toBe(false);
      } finally {
        teardown();
      }
    });

    it('preserves other session state when clearing pendingTrustGrants on transport drop', async () => {
      // Regression guard: the cleanup must only zero `pendingTrustGrants` —
      // other session fields (messages, claudeReady, etc.) must survive an
      // onclose so the auto-reconnect can replay history into them.
      const { useConnectionStore } = await import('./connection');

      // Pre-populate before connect() so setupCapturedSocket overwrite doesn't
      // strip our marker fields. We can't go through setupCapturedSocket here
      // because it uses createEmptySessionState; build manually instead.
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      }));
      vi.stubGlobal('fetch', fetchSpy);

      const captured: { socket: { onclose: (() => void) | null; close: () => void } | null } = { socket: null };
      class MockWebSocket {
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: ((ev: { data: string }) => void) | null = null;
        readyState = 0;
        constructor(_url: string) {
          captured.socket = this as unknown as { onclose: (() => void) | null; close: () => void };
        }
        send(): void { /* no-op */ }
        close(): void { this.readyState = 3; }
      }
      (MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
      vi.stubGlobal('WebSocket', MockWebSocket);

      const sentinel: ChatMessage = {
        id: 'msg-keep',
        type: 'response',
        content: 'do not lose me',
        timestamp: 42,
      };
      useConnectionStore.setState({
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            messages: [sentinel],
            claudeReady: true,
            pendingTrustGrants: [
              { requestId: 'req-1', skillName: 'alice-skill', author: 'alice' },
            ],
          },
        },
        socket: null,
        userDisconnected: false,
        connectionPhase: 'connected',
      });

      void useConnectionStore.getState().connect('wss://example.invalid', 'tok');
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      try {
        expect(captured.socket).not.toBeNull();
        captured.socket!.onclose!();

        const after = useConnectionStore.getState().sessionStates.s1!;
        expect(after.pendingTrustGrants).toEqual([]);
        expect(after.messages).toEqual([sentinel]);
        expect(after.claudeReady).toBe(true);
      } finally {
        vi.unstubAllGlobals();
        useConnectionStore.setState({
          sessions: [],
          activeSessionId: null,
          sessionStates: {},
          userDisconnected: true,
          socket: null,
          connectionPhase: 'disconnected',
        });
      }
    });

    // #3616: setupCapturedSocket() teardown must cancel the auto-reconnect
    // setTimeout scheduled by socket.onclose/socket.onerror. The reconnect
    // callback only gates on `myAttemptId !== connectionAttemptId`; if
    // teardown doesn't bump the attempt id, a stale timer from one test
    // can fire mid-setup of the next.
    it('cancels auto-reconnect timer in teardown so no stray timer fires', async () => {
      const { useConnectionStore } = await import('./connection');
      const { socket, teardown } = await setupCapturedSocket();

      try {
        // The auto-reconnect timer in socket.onclose only schedules when
        // `wasConnected === true`. connect() sets phase to 'connecting' as
        // it runs, so simulate the post-handshake state by promoting the
        // phase back to 'connected' before firing onclose.
        useConnectionStore.setState({ connectionPhase: 'connected' });

        // Switch to fake timers AFTER setup (which uses real microtasks /
        // setTimeout(0) to let the fetch chain run). Fake timers only need
        // to cover the auto-reconnect setTimeout firing window.
        vi.useFakeTimers();
        try {
          // Spy on connect() to detect any stray reconnect attempt. The
          // captured onclose closure invokes the action via `get().connect`,
          // and Zustand's action functions remain reference-stable across
          // setState calls — spying on the current state's `connect` method
          // therefore intercepts the closure's later call too.
          // mockImplementation(() => {}) prevents a regression-induced real
          // call from kicking off a fresh fetch/WebSocket cycle under fake
          // timers, which would hang or pollute later tests.
          const connectSpy = vi
            .spyOn(useConnectionStore.getState(), 'connect')
            .mockImplementation(() => {});

          // Fire onclose to schedule the auto-reconnect setTimeout
          // (AUTO_RECONNECT_DELAY = 1500ms).
          socket.onclose!();

          // Tear down before the timer's deadline. Must invalidate the
          // captured `myAttemptId` so the queued callback no-ops.
          teardown();

          // Advance past both AUTO_RECONNECT_DELAY (1500ms) and
          // ERROR_RECONNECT_DELAY (2000ms) — anything queued should now
          // have fired. With teardown bumping connectionAttemptId, the
          // gate fails and connect() is never called.
          vi.advanceTimersByTime(5000);

          expect(connectSpy).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      } finally {
        // Outer guard: even if the inner block throws before reaching the
        // explicit teardown() above (e.g., onclose was null, spy setup
        // failed), guarantee globals + store get reset so we don't leak
        // stubbed fetch/WebSocket into later tests. teardown() is
        // idempotent: bumpConnectionAttemptId() is just an integer
        // increment, vi.unstubAllGlobals() no-ops if nothing is stubbed,
        // and the setState call is a fresh write.
        teardown();
      }
    });
  });
});
