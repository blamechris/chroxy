import {
  stripAnsi,
  filterThinking,
  createEmptySessionState,
  nextMessageId,
  selectShowSession,
  useConnectionStore,
  ChatMessage,
  ConnectedClient,
  DirectoryListing,
  _testQueueInternals,
  _testMessageHandler,
} from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { clearAllCallbacks, getCallback } from '../../store/imperative-callbacks';
import { derivePendingPermissionCounts, totalPendingPermissions } from '@chroxy/store-core';
import {
  prepareEagerKeyExchange,
  setPendingKeyPair,
  getEncryptionState,
  setEncryptionState,
} from '../../store/message-handler';
import { createKeyPair } from '@chroxy/store-core';

// Reset store between tests
beforeEach(() => {
  clearAllCallbacks();
  useConnectionStore.setState({
    terminalBuffer: '',
    terminalRawBuffer: '',
    serverErrors: [],
    connectedClients: [],
    myClientId: null,
    primaryClientId: null,
    sessionStates: { default: createEmptySessionState() },
    activeSessionId: 'default',
    viewingCachedSession: false,
  });
  useConnectionLifecycleStore.setState({
    connectionPhase: 'disconnected',
    connectionError: null,
    connectionRetryCount: 0,
    userDisconnected: false,
  });
});

// -- stripAnsi --

describe('stripAnsi', () => {
  it('strips SGR color sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips bold/dim/italic sequences', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[22m \x1b[3mitalic\x1b[23m')).toBe('bold italic');
  });

  it('strips cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2Ahello\x1b[3B')).toBe('hello');
  });

  it('strips OSC sequences (title set)', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
  });

  it('strips complex combined sequences', () => {
    expect(stripAnsi('\x1b[38;5;196m\x1b[1mERROR\x1b[0m: fail')).toBe('ERROR: fail');
  });

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

// -- filterThinking --

describe('filterThinking', () => {
  const thinking: ChatMessage = { id: 'thinking', type: 'thinking', content: '', timestamp: 1 };
  const user: ChatMessage = { id: 'u1', type: 'user_input', content: 'hi', timestamp: 2 };
  const response: ChatMessage = { id: 'r1', type: 'response', content: 'hello', timestamp: 3 };

  it('removes thinking messages', () => {
    expect(filterThinking([user, thinking, response])).toEqual([user, response]);
  });

  it('preserves non-thinking messages', () => {
    expect(filterThinking([user, response])).toEqual([user, response]);
  });

  it('handles empty array', () => {
    expect(filterThinking([])).toEqual([]);
  });
});

// -- createEmptySessionState --

describe('createEmptySessionState', () => {
  it('returns correct shape with default values', () => {
    const state = createEmptySessionState();
    expect(state.messages).toEqual([]);
    expect(state.streamingMessageId).toBeNull();
    expect(state.claudeReady).toBe(false);
    expect(state.activeModel).toBeNull();
    expect(state.permissionMode).toBeNull();
    expect(state.contextUsage).toBeNull();
    expect(state.lastResultCost).toBeNull();
    expect(state.lastResultDuration).toBeNull();
    expect(state.isIdle).toBe(true);
    expect(state.health).toBe('healthy');
    expect(state.activeAgents).toEqual([]);
  });

  it('returns unique references per call', () => {
    const a = createEmptySessionState();
    const b = createEmptySessionState();
    expect(a).not.toBe(b);
    expect(a.messages).not.toBe(b.messages);
    expect(a.activeAgents).not.toBe(b.activeAgents);
  });
});

// -- nextMessageId --

describe('nextMessageId', () => {
  it('uses the given prefix', () => {
    const id = nextMessageId('test');
    expect(id).toMatch(/^test-\d+-\d+$/);
  });

  it('defaults to msg prefix', () => {
    const id = nextMessageId();
    expect(id).toMatch(/^msg-\d+-\d+$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => nextMessageId('u')));
    expect(ids.size).toBe(100);
  });

  it('produces monotonically increasing counters', () => {
    const a = nextMessageId('x');
    const b = nextMessageId('x');
    const counterA = parseInt(a.split('-')[1], 10);
    const counterB = parseInt(b.split('-')[1], 10);
    expect(counterB).toBeGreaterThan(counterA);
  });
});

// -- selectShowSession --

describe('selectShowSession', () => {
  const phases = ['disconnected', 'connecting', 'connected', 'reconnecting', 'server_restarting'] as const;

  it('returns false only for disconnected', () => {
    for (const phase of phases) {
      useConnectionLifecycleStore.setState({ connectionPhase: phase });
      useConnectionStore.setState({ viewingCachedSession: false });
      const result = selectShowSession(useConnectionStore.getState());
      if (phase === 'disconnected') {
        expect(result).toBe(false);
      } else {
        expect(result).toBe(true);
      }
    }
  });

  it('returns true when viewingCachedSession even if disconnected', () => {
    useConnectionLifecycleStore.setState({ connectionPhase: 'disconnected' });
    useConnectionStore.setState({ viewingCachedSession: true });
    expect(selectShowSession(useConnectionStore.getState())).toBe(true);
  });
});

// -- Store actions --

describe('store actions', () => {
  describe('addMessage', () => {
    it('appends a message to the active session', () => {
      const msg: ChatMessage = { id: 'test-1', type: 'response', content: 'hi', timestamp: 1 };
      useConnectionStore.getState().addMessage(msg);
      expect(useConnectionStore.getState().sessionStates['default'].messages).toEqual([msg]);
    });

    it('removes thinking placeholder when a real message arrives', () => {
      const thinking: ChatMessage = { id: 'thinking', type: 'thinking', content: '', timestamp: 1 };
      const real: ChatMessage = { id: 'r1', type: 'response', content: 'done', timestamp: 2 };
      useConnectionStore.getState().addMessage(thinking);
      useConnectionStore.getState().addMessage(real);
      const messages = useConnectionStore.getState().sessionStates['default'].messages;
      expect(messages).toEqual([real]);
    });

    it('does not filter thinking when adding another thinking message', () => {
      const thinking: ChatMessage = { id: 'thinking', type: 'thinking', content: '', timestamp: 1 };
      useConnectionStore.getState().addMessage(thinking);
      useConnectionStore.getState().addMessage(thinking);
      // addMessage keeps existing thinking when the new message IS thinking (filter passes all)
      expect(useConnectionStore.getState().sessionStates['default'].messages.length).toBe(2);
    });
  });

  describe('appendTerminalData', () => {
    it('appends stripped text to buffer', () => {
      useConnectionStore.getState().appendTerminalData('\x1b[32mhello\x1b[0m');
      expect(useConnectionStore.getState().terminalBuffer).toBe('hello');
    });

    it('truncates buffer at 50k characters', () => {
      const long = 'x'.repeat(60000);
      useConnectionStore.getState().appendTerminalData(long);
      expect(useConnectionStore.getState().terminalBuffer.length).toBe(50000);
    });

    it('preserves tail when truncating', () => {
      useConnectionStore.setState({ terminalBuffer: 'a'.repeat(49990) });
      useConnectionStore.getState().appendTerminalData('b'.repeat(20));
      const buf = useConnectionStore.getState().terminalBuffer;
      expect(buf.length).toBe(50000);
      expect(buf.endsWith('b'.repeat(20))).toBe(true);
    });

    it('stores raw ANSI data in terminalRawBuffer', () => {
      const raw = '\x1b[32mhello\x1b[0m';
      useConnectionStore.getState().appendTerminalData(raw);
      expect(useConnectionStore.getState().terminalRawBuffer).toBe(raw);
    });

    it('truncates terminalRawBuffer at 100KB', () => {
      const long = 'x'.repeat(110000);
      useConnectionStore.getState().appendTerminalData(long);
      expect(useConnectionStore.getState().terminalRawBuffer.length).toBe(100000);
    });

    it('calls _terminalWriteCallback when set', () => {
      jest.useFakeTimers();
      const writes: string[] = [];
      useConnectionStore.getState().setTerminalWriteCallback((data) => writes.push(data));
      useConnectionStore.getState().appendTerminalData('hello');
      // Callback is batched — flush timer
      jest.advanceTimersByTime(100);
      expect(writes).toEqual(['hello']);
      jest.useRealTimers();
    });
  });

  describe('terminalWriteCallback', () => {
    it('is cleared on disconnect', () => {
      useConnectionStore.getState().setTerminalWriteCallback(() => {});
      expect(getCallback('terminalWrite')).not.toBeNull();
      useConnectionStore.getState().disconnect();
      expect(getCallback('terminalWrite')).toBeNull();
    });
  });

  describe('viewCachedSession', () => {
    it('sets viewingCachedSession when active session has cached messages', () => {
      useConnectionStore.setState({
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            messages: [{ id: 'm1', type: 'response', content: 'hi', timestamp: 1 }],
          },
        },
      });
      useConnectionStore.getState().viewCachedSession();
      expect(useConnectionStore.getState().viewingCachedSession).toBe(true);
    });

    it('does nothing when no cached messages exist', () => {
      useConnectionStore.setState({
        activeSessionId: 's1',
        sessionStates: { s1: createEmptySessionState() },
      });
      useConnectionStore.getState().viewCachedSession();
      expect(useConnectionStore.getState().viewingCachedSession).toBe(false);
    });

    it('does nothing when no active session', () => {
      useConnectionStore.setState({ activeSessionId: null });
      useConnectionStore.getState().viewCachedSession();
      expect(useConnectionStore.getState().viewingCachedSession).toBe(false);
    });
  });

  describe('exitCachedSession', () => {
    it('resets viewingCachedSession to false', () => {
      useConnectionStore.setState({ viewingCachedSession: true });
      useConnectionStore.getState().exitCachedSession();
      expect(useConnectionStore.getState().viewingCachedSession).toBe(false);
    });
  });

  describe('disconnect resets viewingCachedSession', () => {
    it('clears viewingCachedSession on disconnect', () => {
      useConnectionStore.setState({ viewingCachedSession: true });
      useConnectionStore.getState().disconnect();
      expect(useConnectionStore.getState().viewingCachedSession).toBe(false);
    });
  });

  describe('disconnect sets userDisconnected flag', () => {
    it('sets userDisconnected to true on explicit disconnect', () => {
      useConnectionLifecycleStore.setState({ connectionPhase: 'connected', userDisconnected: false });
      useConnectionStore.getState().disconnect();
      expect(useConnectionLifecycleStore.getState().userDisconnected).toBe(true);
    });

    it('disconnect sets both userDisconnected and connectionPhase', () => {
      useConnectionLifecycleStore.setState({ connectionPhase: 'connected', userDisconnected: false });
      useConnectionStore.getState().disconnect();
      expect(useConnectionLifecycleStore.getState().userDisconnected).toBe(true);
      expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('disconnected');
    });

    it('connect() clears userDisconnected flag', () => {
      useConnectionLifecycleStore.setState({ userDisconnected: true, connectionPhase: 'disconnected' });
      // connect() will fail (no server) but should clear the flag immediately
      useConnectionStore.getState().connect('ws://localhost:9999', 'test-token');
      expect(useConnectionLifecycleStore.getState().userDisconnected).toBe(false);
      // Clean up — disconnect to cancel any pending retries
      useConnectionStore.getState().disconnect();
    });
  });

  describe('forgetSession resets viewingCachedSession', () => {
    it('clears viewingCachedSession on forgetSession', () => {
      useConnectionStore.setState({ viewingCachedSession: true });
      useConnectionStore.getState().forgetSession();
      expect(useConnectionStore.getState().viewingCachedSession).toBe(false);
    });
  });

  describe('dismissServerError', () => {
    it('removes error by id', () => {
      useConnectionStore.setState({
        serverErrors: [
          { id: 'e1', category: 'general', message: 'fail', recoverable: true, timestamp: 1 },
          { id: 'e2', category: 'tunnel', message: 'down', recoverable: false, timestamp: 2 },
        ],
      });
      useConnectionStore.getState().dismissServerError('e1');
      const errors = useConnectionStore.getState().serverErrors;
      expect(errors).toHaveLength(1);
      expect(errors[0].id).toBe('e2');
    });

    it('no-ops for non-existent id', () => {
      useConnectionStore.setState({
        serverErrors: [
          { id: 'e1', category: 'general', message: 'fail', recoverable: true, timestamp: 1 },
        ],
      });
      useConnectionStore.getState().dismissServerError('nonexistent');
      expect(useConnectionStore.getState().serverErrors).toHaveLength(1);
    });
  });

  describe('clearTerminalBuffer', () => {
    it('resets both buffers to empty string', () => {
      useConnectionStore.setState({ terminalBuffer: 'some content', terminalRawBuffer: '\x1b[32msome\x1b[0m content' });
      useConnectionStore.getState().clearTerminalBuffer();
      expect(useConnectionStore.getState().terminalBuffer).toBe('');
      expect(useConnectionStore.getState().terminalRawBuffer).toBe('');
    });
  });
});

// -- Message queue --

describe('message queue', () => {
  beforeEach(() => {
    // Clear queue by calling disconnect, then reset state
    useConnectionStore.getState().disconnect();
    useConnectionLifecycleStore.setState({ connectionPhase: 'disconnected' });
  });

  it('queues input when socket is not connected', () => {
    const result = useConnectionStore.getState().sendInput('hello');
    expect(result).toBe('queued');
  });

  it('queues interrupt when socket is not connected', () => {
    const result = useConnectionStore.getState().sendInterrupt();
    expect(result).toBe('queued');
  });

  it('REFUSES permission_response when socket is not connected (#5699 — never queued)', () => {
    // The server expires the pending request on disconnect, so a queued
    // response would drain into the void on reconnect while the prompt could
    // look answered. Refuse with `false` instead of queuing.
    const result = useConnectionStore.getState().sendPermissionResponse('req-1', 'allow');
    expect(result).toBe(false);
  });

  it('REFUSES user_question_response when socket is not connected (#5699 — never queued)', () => {
    const result = useConnectionStore.getState().sendUserQuestionResponse('yes');
    expect(result).toBe(false);
  });

  it('a refused permission/question response consumes no queue capacity (#5699)', () => {
    const store = useConnectionStore.getState();
    // Refused responses must not occupy a queue slot — fill exactly to 10 with
    // inputs after attempting to "answer" while disconnected.
    expect(store.sendPermissionResponse('req-x', 'allow')).toBe(false);
    expect(store.sendUserQuestionResponse('nope')).toBe(false);
    for (let i = 0; i < 10; i++) {
      expect(store.sendInput(`msg-${i}`)).toBe('queued');
    }
    // 11th input overflows — proving the two refused responses took no slots.
    expect(store.sendInput('overflow')).toBe(false);
  });

  it('mirrors the queue length into reactive queuedMessageCount (#5699)', () => {
    const store = useConnectionStore.getState();
    expect(useConnectionStore.getState().queuedMessageCount).toBe(0);
    store.sendInput('one');
    expect(useConnectionStore.getState().queuedMessageCount).toBe(1);
    store.sendInput('two');
    expect(useConnectionStore.getState().queuedMessageCount).toBe(2);
    // Refused responses don't bump the count.
    store.sendPermissionResponse('req-z', 'allow');
    expect(useConnectionStore.getState().queuedMessageCount).toBe(2);
    // A queued interrupt is an ephemeral control signal, not a "message" — it
    // gets buffered (TTL 5s) but must NOT inflate the unsent-message count that
    // drives the banner copy + discard warning (#5699 Copilot follow-up).
    expect(store.sendInterrupt()).toBe('queued');
    expect(useConnectionStore.getState().queuedMessageCount).toBe(2);
    // disconnect() clears the queue → count resets to 0.
    store.disconnect();
    expect(useConnectionStore.getState().queuedMessageCount).toBe(0);
  });

  it('returns false when queue is full (max 10)', () => {
    const store = useConnectionStore.getState();
    for (let i = 0; i < 10; i++) {
      expect(store.sendInput(`msg-${i}`)).toBe('queued');
    }
    // 11th should fail
    expect(store.sendInput('overflow')).toBe(false);
  });

  // #6222: answering a permission must clear the shared pending-permission count
  // (isLivePermissionPrompt keys on m.answered). The cross-session
  // SessionNotificationBanner calls only sendPermissionResponse, so without the
  // fix that path left the prompt counted as pending.
  it('sendPermissionResponse marks the prompt answered so the pending count clears (#6222)', () => {
    const mockSocket = { readyState: 1, send: () => {} } as unknown as WebSocket;
    const livePrompt: ChatMessage = {
      id: 'm1',
      type: 'prompt',
      content: 'Allow?',
      timestamp: 1,
      requestId: 'req-a',
      expiresAt: Date.now() + 5 * 60_000,
    };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: { ...createEmptySessionState(), messages: [livePrompt] } },
      socket: mockSocket,
    });

    const before = useConnectionStore.getState().sessionStates;
    expect(totalPendingPermissions(derivePendingPermissionCounts(before, Date.now()))).toBe(1);

    useConnectionStore.getState().sendPermissionResponse('req-a', 'allow');

    const after = useConnectionStore.getState().sessionStates;
    // Canonical decision TOKEN, not a display label — SettingsScreen /
    // PermissionHistoryScreen tally `m.answered === 'allow' | 'deny' | ...`.
    expect(after.s1.messages.find((m) => m.requestId === 'req-a')?.answered).toBe('allow');
    expect(totalPendingPermissions(derivePendingPermissionCounts(after, Date.now()))).toBe(0);

    // beforeEach does not reset `socket`; clear it so the open mock doesn't bleed
    // into later tests that assume a disconnected socket.
    useConnectionStore.setState({ socket: null });
  });

  it('does not queue excluded message types (setModel)', () => {
    // setModel calls socket.send directly and doesn't use enqueueMessage,
    // so it just silently no-ops when disconnected. Verify that calling
    // setModel does not consume queue capacity.
    const store = useConnectionStore.getState();

    // Fill the queue to 9 items.
    for (let i = 0; i < 9; i++) {
      expect(store.sendInput(`msg-${i}`)).toBe('queued');
    }

    // This excluded action should not be added to the queue.
    store.setModel('test-model');

    // We should still be able to enqueue the 10th item.
    expect(store.sendInput('msg-9')).toBe('queued');

    // And the 11th should fail, proving only 10 items were queued and
    // setModel did not count towards the limit.
    expect(store.sendInput('overflow')).toBe(false);
  });
});

// -- Message queue internals (TTL, drain, clear) --

describe('message queue internals', () => {
  beforeEach(() => {
    _testQueueInternals.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('filters expired messages on drain', () => {
    // Enqueue an input message (TTL = 60s)
    _testQueueInternals.enqueue('input', { type: 'input', data: 'hello' });
    expect(_testQueueInternals.getQueue()).toHaveLength(1);

    // Advance past its TTL
    jest.advanceTimersByTime(61_000);

    // Drain into a mock socket — expired message should be filtered out
    const sent: string[] = [];
    const mockSocket = { send: (data: string) => sent.push(data) } as unknown as WebSocket;
    _testQueueInternals.drain(mockSocket);

    expect(sent).toHaveLength(0);
    expect(_testQueueInternals.getQueue()).toHaveLength(0);
  });

  it('sends valid (non-expired) messages on drain', () => {
    _testQueueInternals.enqueue('input', { type: 'input', data: 'msg1' });
    _testQueueInternals.enqueue('input', { type: 'input', data: 'msg2' });

    // Advance less than TTL
    jest.advanceTimersByTime(30_000);

    const sent: string[] = [];
    const mockSocket = { send: (data: string) => sent.push(data) } as unknown as WebSocket;
    _testQueueInternals.drain(mockSocket);

    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0])).toEqual({ type: 'input', data: 'msg1' });
    expect(JSON.parse(sent[1])).toEqual({ type: 'input', data: 'msg2' });
    expect(_testQueueInternals.getQueue()).toHaveLength(0);
  });

  it('respects per-type TTL (interrupt = 5s)', () => {
    _testQueueInternals.enqueue('interrupt', { type: 'interrupt' });
    _testQueueInternals.enqueue('input', { type: 'input', data: 'hello' });

    // Advance past interrupt TTL but within input TTL
    jest.advanceTimersByTime(6_000);

    const sent: string[] = [];
    const mockSocket = { send: (data: string) => sent.push(data) } as unknown as WebSocket;
    _testQueueInternals.drain(mockSocket);

    // Only the input message should survive
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).type).toBe('input');
  });

  it('disconnect clears the queue', () => {
    _testQueueInternals.enqueue('input', { type: 'input', data: 'queued' });
    _testQueueInternals.enqueue('input', { type: 'input', data: 'queued2' });
    expect(_testQueueInternals.getQueue()).toHaveLength(2);

    useConnectionStore.getState().disconnect();
    expect(_testQueueInternals.getQueue()).toHaveLength(0);
  });

  it('drain clears the queue even when all messages are expired', () => {
    _testQueueInternals.enqueue('interrupt', { type: 'interrupt' });
    jest.advanceTimersByTime(10_000);

    const sent: string[] = [];
    const mockSocket = { send: (data: string) => sent.push(data) } as unknown as WebSocket;
    _testQueueInternals.drain(mockSocket);

    expect(sent).toHaveLength(0);
    expect(_testQueueInternals.getQueue()).toHaveLength(0);
  });
});

// -- sendUserQuestionResponse: widened payload shapes (#4761) --

describe('sendUserQuestionResponse wire payload (#4761)', () => {
  beforeEach(() => {
    useConnectionStore.setState({
      terminalBuffer: '',
      terminalRawBuffer: '',
    });
  });

  it('emits the legacy single-question wire shape for a string answer (back-compat)', () => {
    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };
    useConnectionStore.setState({ socket: mockSocket as unknown as WebSocket });

    const result = useConnectionStore.getState().sendUserQuestionResponse('Option A', 'toolu_single');

    expect(result).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'user_question_response',
      answer: 'Option A',
      toolUseId: 'toolu_single',
    });
    // No `answers` field on the single-question path — that's reserved
    // for multi-question forms so older servers ignore it cleanly.
    expect(sent[0]).not.toHaveProperty('answers');
  });

  it('forwards multi-question Record<string, string | string[]> verbatim and flattens arrays in the answer summary', () => {
    // #4761 — mirror the dashboard's `sendUserQuestionResponse` widening
    // (#4760). The widened wire (`UserQuestionResponseSchema`) accepts
    // `string | string[]` per question. The mobile store should:
    //   1. Populate `answers` with the map shape unchanged (arrays stay
    //      arrays — the server normalizes downstream).
    //   2. Populate the string-only `answer` field with a flattened
    //      comma-joined summary so older servers reading only `answer`
    //      still see a human-readable line (no leaked JSON syntax).
    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };
    useConnectionStore.setState({ socket: mockSocket as unknown as WebSocket });

    const answersMap = {
      'Which release strategy?': 'Patch',
      'Which targets?': ['App', 'Tests'],
      'Confirm?': 'Yes',
    };
    const result = useConnectionStore.getState().sendUserQuestionResponse(answersMap, 'toolu_multi');

    expect(result).toBe('sent');
    expect(sent).toHaveLength(1);
    const payload = sent[0] as { type: string; answer: string; answers: Record<string, unknown>; toolUseId: string };
    expect(payload.type).toBe('user_question_response');
    expect(payload.toolUseId).toBe('toolu_multi');
    // `answers` passes the map through unchanged — arrays stay arrays.
    expect(payload.answers).toEqual({
      'Which release strategy?': 'Patch',
      'Which targets?': ['App', 'Tests'],
      'Confirm?': 'Yes',
    });
    expect(Array.isArray(payload.answers['Which targets?'])).toBe(true);
    // Summary flattens arrays as comma-joined labels.
    expect(payload.answer).toBe(
      'Which release strategy?: Patch | Which targets?: App, Tests | Confirm?: Yes',
    );
  });

  it('flattens legacy JSON-stringified array envelopes in the answer summary (back-compat)', () => {
    // Pre-#4621 dashboards JSON-stringified multi-select arrays into a
    // single string. If mixed-version rehydrated state replays such a
    // payload through the widened store, the `answers` field should
    // pass through unchanged BUT the `answer` summary should still
    // flatten the JSON envelope so the terminal echo / older-server
    // `answer` read stays readable.
    const sent: Record<string, unknown>[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => { sent.push(JSON.parse(data)); },
    };
    useConnectionStore.setState({ socket: mockSocket as unknown as WebSocket });

    const legacyAnswersMap = {
      'Which targets?': JSON.stringify(['App', 'Tests']),
      'Confirm?': 'Yes',
    };
    useConnectionStore.getState().sendUserQuestionResponse(legacyAnswersMap, 'toolu_legacy');

    expect(sent).toHaveLength(1);
    const payload = sent[0] as { type: string; answer: string; answers: Record<string, unknown>; toolUseId: string };
    expect(payload.answers).toEqual(legacyAnswersMap);
    expect(payload.answer).toBe('Which targets?: App, Tests | Confirm?: Yes');
    expect(payload.answer).not.toContain('["App"');
  });

  it('REFUSES the multi-question payload when socket is not connected (#5699 — never queued)', () => {
    // A multi-question answer is still a user_question_response: the server
    // expires the pending request on disconnect, so it must be refused (false),
    // not queued, to avoid a silent drain-into-the-void on reconnect.
    useConnectionStore.setState({ socket: null });
    const result = useConnectionStore
      .getState()
      .sendUserQuestionResponse({ 'Q?': ['A', 'B'] }, 'toolu_q');
    expect(result).toBe(false);
  });
});

// -- Connected clients state --

describe('connectedClients state', () => {
  const mockClient1: ConnectedClient = {
    clientId: 'client-1',
    deviceName: 'iPhone 15',
    deviceType: 'phone',
    platform: 'ios',
    isSelf: false,
  };
  const mockClient2: ConnectedClient = {
    clientId: 'client-2',
    deviceName: 'iPad Pro',
    deviceType: 'tablet',
    platform: 'ios',
    isSelf: true,
  };

  it('initializes as empty array', () => {
    expect(useConnectionStore.getState().connectedClients).toEqual([]);
  });

  it('stores connected clients from auth_ok', () => {
    useConnectionStore.setState({ connectedClients: [mockClient1, mockClient2] });
    expect(useConnectionStore.getState().connectedClients).toHaveLength(2);
    expect(useConnectionStore.getState().connectedClients[0].deviceName).toBe('iPhone 15');
    expect(useConnectionStore.getState().connectedClients[1].isSelf).toBe(true);
  });

  it('adds client on client_joined', () => {
    useConnectionStore.setState({ connectedClients: [mockClient2] });
    useConnectionStore.setState((state) => ({
      connectedClients: [...state.connectedClients, mockClient1],
    }));
    expect(useConnectionStore.getState().connectedClients).toHaveLength(2);
  });

  it('removes client on client_left', () => {
    useConnectionStore.setState({ connectedClients: [mockClient1, mockClient2] });
    useConnectionStore.setState((state) => ({
      connectedClients: state.connectedClients.filter((c) => c.clientId !== 'client-1'),
    }));
    const remaining = useConnectionStore.getState().connectedClients;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].clientId).toBe('client-2');
  });

  it('clears on disconnect', () => {
    useConnectionStore.setState({ connectedClients: [mockClient1, mockClient2] });
    useConnectionStore.getState().disconnect();
    expect(useConnectionStore.getState().connectedClients).toEqual([]);
  });
});

// -- createEmptySessionState with primaryClientId --

describe('createEmptySessionState (primaryClientId)', () => {
  it('includes primaryClientId as null', () => {
    const state = createEmptySessionState();
    expect(state.primaryClientId).toBeNull();
  });
});

// -- myClientId state --

describe('myClientId state', () => {
  it('initializes as null', () => {
    expect(useConnectionStore.getState().myClientId).toBeNull();
  });

  it('stores myClientId from auth_ok', () => {
    useConnectionStore.setState({ myClientId: 'client-abc' });
    expect(useConnectionStore.getState().myClientId).toBe('client-abc');
  });

  it('clears on disconnect', () => {
    useConnectionStore.setState({ myClientId: 'client-abc' });
    useConnectionStore.getState().disconnect();
    expect(useConnectionStore.getState().myClientId).toBeNull();
  });
});

// -- connectionError + connectionRetryCount state --

describe('connectionError and connectionRetryCount state', () => {
  it('initializes with null error and zero retry count', () => {
    const state = useConnectionLifecycleStore.getState();
    expect(state.connectionError).toBeNull();
    expect(state.connectionRetryCount).toBe(0);
  });

  it('clears both on disconnect', () => {
    useConnectionLifecycleStore.setState({ connectionError: 'Connection lost', connectionRetryCount: 3 });
    useConnectionStore.getState().disconnect();
    expect(useConnectionLifecycleStore.getState().connectionError).toBeNull();
    expect(useConnectionLifecycleStore.getState().connectionRetryCount).toBe(0);
  });

  it('auth_ok clears both fields', () => {
    const mockSocket = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;
    _testMessageHandler.setContext({
      url: 'wss://test', token: 'tok', isReconnect: false,
      silent: false, socket: mockSocket,
    });
    useConnectionLifecycleStore.setState({ connectionError: 'Network error', connectionRetryCount: 2 });
    _testMessageHandler.handle({ type: 'auth_ok', serverMode: 'cli' });
    const state = useConnectionLifecycleStore.getState();
    expect(state.connectionError).toBeNull();
    expect(state.connectionRetryCount).toBe(0);
    _testMessageHandler.clearContext();
  });
});

// -- primaryClientId flat state (legacy/single-session mode) --

describe('primaryClientId flat state', () => {
  it('initializes as null', () => {
    expect(useConnectionStore.getState().primaryClientId).toBeNull();
  });

  it('can be set directly for legacy mode', () => {
    useConnectionStore.setState({ primaryClientId: 'client-xyz' });
    expect(useConnectionStore.getState().primaryClientId).toBe('client-xyz');
  });

  it('clears on disconnect', () => {
    useConnectionStore.setState({ primaryClientId: 'client-xyz' });
    useConnectionStore.getState().disconnect();
    expect(useConnectionStore.getState().primaryClientId).toBeNull();
  });
});

// -- Multi-client message handling (via handler) --

describe('multi-client message handling', () => {
  const mockSocket = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;

  beforeEach(() => {
    _testMessageHandler.setContext({
      url: 'wss://test', token: 'tok', isReconnect: false,
      silent: false, socket: mockSocket,
    });
  });
  afterEach(() => _testMessageHandler.clearContext());

  describe('client_joined dedup', () => {
    it('replaces existing client with same clientId', () => {
      // Seed an existing client
      useConnectionStore.setState({
        connectedClients: [{
          clientId: 'client-1', deviceName: 'iPhone 15',
          deviceType: 'phone', platform: 'ios', isSelf: false,
        }],
      });
      // Simulate a duplicate join via handler
      _testMessageHandler.handle({
        type: 'client_joined',
        client: { clientId: 'client-1', deviceName: 'iPhone 15 Pro', deviceType: 'phone', platform: 'ios' },
      });
      const clients = useConnectionStore.getState().connectedClients;
      expect(clients).toHaveLength(1);
      expect(clients[0].deviceName).toBe('iPhone 15 Pro');
    });
  });

  describe('client_joined with missing fields', () => {
    it('handles client with missing deviceName/deviceType (defaults to unknown)', () => {
      _testMessageHandler.handle({
        type: 'client_joined',
        client: { clientId: 'client-minimal' },
      });
      const client = useConnectionStore.getState().connectedClients[0];
      expect(client.deviceName).toBeNull();
      expect(client.deviceType).toBe('unknown');
      expect(client.platform).toBe('unknown');
    });
  });

  describe('rapid join/leave', () => {
    it('handles join then immediate leave for same client', () => {
      _testMessageHandler.handle({
        type: 'client_joined',
        client: { clientId: 'client-1', deviceName: 'iPhone 15', deviceType: 'phone', platform: 'ios' },
      });
      expect(useConnectionStore.getState().connectedClients).toHaveLength(1);

      _testMessageHandler.handle({ type: 'client_left', clientId: 'client-1' });
      expect(useConnectionStore.getState().connectedClients).toHaveLength(0);
    });

    it('handles multiple rapid joins', () => {
      for (let i = 0; i < 5; i++) {
        _testMessageHandler.handle({
          type: 'client_joined',
          client: { clientId: `client-${i}`, deviceName: `Device ${i}`, deviceType: 'phone', platform: 'ios' },
        });
      }
      expect(useConnectionStore.getState().connectedClients).toHaveLength(5);
    });
  });

  describe('primary_changed in multi-session mode', () => {
    it('updates primaryClientId in session state', () => {
      const sessionId = 'session-1';
      useConnectionStore.setState({
        activeSessionId: sessionId,
        sessionStates: { [sessionId]: createEmptySessionState() },
      });
      _testMessageHandler.handle({
        type: 'primary_changed', sessionId, clientId: 'client-1',
      });
      expect(useConnectionStore.getState().sessionStates[sessionId].primaryClientId).toBe('client-1');
    });

    it('clears primaryClientId when set to null', () => {
      const sessionId = 'session-1';
      const sessionState = createEmptySessionState();
      sessionState.primaryClientId = 'client-1';
      useConnectionStore.setState({
        activeSessionId: sessionId,
        sessionStates: { [sessionId]: sessionState },
      });
      _testMessageHandler.handle({
        type: 'primary_changed', sessionId, clientId: null,
      });
      expect(useConnectionStore.getState().sessionStates[sessionId].primaryClientId).toBeNull();
    });
  });

  describe('primary_changed in legacy mode', () => {
    it('stores primaryClientId in session state for default session', () => {
      _testMessageHandler.handle({
        type: 'primary_changed', sessionId: 'default', clientId: 'client-1',
      });
      expect(useConnectionStore.getState().sessionStates.default!.primaryClientId).toBe('client-1');
    });

    it('stores primaryClientId at flat state level when no sessionId', () => {
      _testMessageHandler.handle({
        type: 'primary_changed', clientId: 'client-1',
      });
      expect(useConnectionStore.getState().primaryClientId).toBe('client-1');
    });

    it('clears flat primaryClientId when set to null', () => {
      useConnectionStore.setState({ primaryClientId: 'client-1' });
      _testMessageHandler.handle({
        type: 'primary_changed', clientId: null,
      });
      expect(useConnectionStore.getState().primaryClientId).toBeNull();
    });
  });

  describe('primary_changed for unknown session IDs', () => {
    it('does not clobber flat primaryClientId when event is for unknown non-default session', () => {
      useConnectionStore.setState({
        primaryClientId: 'client-legacy',
        sessionStates: { 'session-1': createEmptySessionState() },
      });
      // An event for 'session-unknown' should NOT overwrite flat primaryClientId
      _testMessageHandler.handle({
        type: 'primary_changed', sessionId: 'session-unknown', clientId: 'client-new',
      });
      expect(useConnectionStore.getState().primaryClientId).toBe('client-legacy');
    });
  });
});

// -- WS message handler (direct) --

describe('WS message handler (direct)', () => {
  const mockSocket = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;

  beforeEach(() => {
    (mockSocket.send as jest.Mock).mockClear();
    (mockSocket.close as jest.Mock).mockClear();
    _testMessageHandler.setContext({
      url: 'wss://test', token: 'tok', isReconnect: false,
      silent: false, socket: mockSocket,
    });
  });
  afterEach(() => _testMessageHandler.clearContext());

  describe('auth_ok', () => {
    it('parses connectedClients with isSelf detection via clientId', () => {
      _testMessageHandler.handle({
        type: 'auth_ok',
        clientId: 'me-123',
        connectedClients: [
          { clientId: 'me-123', deviceName: 'My Phone', deviceType: 'phone', platform: 'ios' },
          { clientId: 'other-456', deviceName: 'Their Tablet', deviceType: 'tablet', platform: 'android' },
        ],
        serverMode: 'cli',
        cwd: '/home/user',
      });
      const state = useConnectionStore.getState();
      expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('connected');
      expect(state.myClientId).toBe('me-123');
      expect(state.connectedClients).toHaveLength(2);
      expect(state.connectedClients[0].isSelf).toBe(true);
      expect(state.connectedClients[1].isSelf).toBe(false);
    });

    it('handles missing connectedClients gracefully', () => {
      _testMessageHandler.handle({
        type: 'auth_ok',
        clientId: 'me-123',
        serverMode: 'cli',
      });
      const state = useConnectionStore.getState();
      expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('connected');
      expect(state.connectedClients).toEqual([]);
    });

    // #5555 (eager key exchange) — onopen prepares the keypair eagerly and
    // sends pubkey+salt with auth; if auth_ok carries serverPublicKey the
    // client derives the shared key inline and sends the burst immediately,
    // skipping the discrete key_exchange RTT. Uses real store-core crypto.
    describe('eager key exchange (#5555)', () => {
      afterEach(() => {
        setEncryptionState(null);
        setPendingKeyPair(null);
      });

      it('derives encryption inline and sends the burst when serverPublicKey is present', () => {
        // Simulate onopen having generated + sent the eager keypair.
        prepareEagerKeyExchange();
        const serverKp = createKeyPair();
        (mockSocket.send as jest.Mock).mockClear();

        _testMessageHandler.handle({
          type: 'auth_ok',
          clientId: 'me-123',
          serverMode: 'cli',
          encryption: 'required',
          serverPublicKey: serverKp.publicKey,
        });

        // Shared key established without a discrete key_exchange round trip.
        expect(getEncryptionState()).not.toBeNull();
        const sentTypes = (mockSocket.send as jest.Mock).mock.calls
          .map((c) => JSON.parse(c[0] as string).type);
        expect(sentTypes).not.toContain('key_exchange');
        // Burst sends are encrypted envelopes (encryptionState is active).
        expect(sentTypes).toContain('encrypted');
      });

      it('falls back to the discrete key_exchange when serverPublicKey is absent (old server)', () => {
        prepareEagerKeyExchange();
        (mockSocket.send as jest.Mock).mockClear();

        _testMessageHandler.handle({
          type: 'auth_ok',
          clientId: 'me-123',
          serverMode: 'cli',
          encryption: 'required',
          // no serverPublicKey → old server
        });

        // No shared key yet — waiting on key_exchange_ok.
        expect(getEncryptionState()).toBeNull();
        const sent = (mockSocket.send as jest.Mock).mock.calls
          .map((c) => JSON.parse(c[0] as string));
        const ke = sent.find((m) => m.type === 'key_exchange');
        expect(ke).toBeTruthy();
        expect(typeof ke.publicKey).toBe('string');
        expect(typeof ke.salt).toBe('string');
      });
    });
  });

  describe('client_joined', () => {
    it('validates fields, deduplicates, generates system message', () => {
      _testMessageHandler.handle({
        type: 'client_joined',
        client: { clientId: 'c1', deviceName: 'Phone', deviceType: 'phone', platform: 'ios' },
      });
      expect(useConnectionStore.getState().connectedClients).toHaveLength(1);
      // System message generated
      const msgs = useConnectionStore.getState().getActiveSessionState().messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe('system');
      expect(msgs[0].content).toBe('Phone connected');
    });

    it('handles missing deviceName/deviceType (defaults to unknown)', () => {
      _testMessageHandler.handle({
        type: 'client_joined',
        client: { clientId: 'c2' },
      });
      const client = useConnectionStore.getState().connectedClients[0];
      expect(client.deviceName).toBeNull();
      expect(client.deviceType).toBe('unknown');
      // System message uses fallback label
      expect(useConnectionStore.getState().getActiveSessionState().messages[0].content).toBe('A device connected');
    });

    it('skips if msg.client.clientId is not a string', () => {
      _testMessageHandler.handle({
        type: 'client_joined',
        client: { clientId: 123 },
      });
      expect(useConnectionStore.getState().connectedClients).toHaveLength(0);
      expect(useConnectionStore.getState().getActiveSessionState().messages).toHaveLength(0);
    });
  });

  describe('client_left', () => {
    it('removes client by ID, generates system message', () => {
      useConnectionStore.setState({
        connectedClients: [
          { clientId: 'c1', deviceName: 'Phone', deviceType: 'phone', platform: 'ios', isSelf: false },
        ],
      });
      _testMessageHandler.handle({ type: 'client_left', clientId: 'c1' });
      expect(useConnectionStore.getState().connectedClients).toHaveLength(0);
      const msgs = useConnectionStore.getState().getActiveSessionState().messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('Phone disconnected');
    });

    it('no-ops for unknown clientId (no crash)', () => {
      _testMessageHandler.handle({ type: 'client_left', clientId: 'nonexistent' });
      expect(useConnectionStore.getState().connectedClients).toHaveLength(0);
      // Still generates a system message with fallback label
      expect(useConnectionStore.getState().getActiveSessionState().messages[0].content).toBe('A device disconnected');
    });
  });

  describe('primary_changed', () => {
    it('updates session state in multi-session mode', () => {
      const sessionId = 'sess-1';
      useConnectionStore.setState({
        activeSessionId: sessionId,
        sessionStates: { [sessionId]: createEmptySessionState() },
      });
      _testMessageHandler.handle({
        type: 'primary_changed', sessionId, clientId: 'c1',
      });
      expect(useConnectionStore.getState().sessionStates[sessionId].primaryClientId).toBe('c1');
    });

    it('stores in session state for default session', () => {
      _testMessageHandler.handle({
        type: 'primary_changed', sessionId: 'default', clientId: 'c1',
      });
      expect(useConnectionStore.getState().sessionStates.default!.primaryClientId).toBe('c1');
    });

    it('ignores unknown session IDs in multi-session mode', () => {
      useConnectionStore.setState({
        primaryClientId: 'existing',
        sessionStates: { 'known-session': createEmptySessionState() },
      });
      _testMessageHandler.handle({
        type: 'primary_changed', sessionId: 'unknown-session', clientId: 'new-client',
      });
      // Should not touch flat primaryClientId
      expect(useConnectionStore.getState().primaryClientId).toBe('existing');
    });
  });

  describe('malformed payloads', () => {
    it('silently skips messages with missing type field', () => {
      // Should not throw
      _testMessageHandler.handle({ content: 'no type' });
      expect(useConnectionStore.getState().getActiveSessionState().messages).toHaveLength(0);
    });

    it('silently skips messages with unknown type', () => {
      _testMessageHandler.handle({ type: 'totally_unknown_msg_type' });
      expect(useConnectionStore.getState().getActiveSessionState().messages).toHaveLength(0);
    });

    it('skips client_joined with no client object', () => {
      _testMessageHandler.handle({ type: 'client_joined' });
      expect(useConnectionStore.getState().connectedClients).toHaveLength(0);
    });

    it('skips client_left with non-string clientId', () => {
      _testMessageHandler.handle({ type: 'client_left', clientId: 42 });
      expect(useConnectionStore.getState().connectedClients).toHaveLength(0);
      expect(useConnectionStore.getState().getActiveSessionState().messages).toHaveLength(0);
    });
  });

  describe('no context', () => {
    it('silently returns when context is null', () => {
      _testMessageHandler.clearContext();
      // Should not throw
      _testMessageHandler.handle({ type: 'auth_ok', clientId: 'x' });
      expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('disconnected');
    });
  });

  describe('directory_listing', () => {
    it('invokes callback with correct data shape', () => {
      let received: DirectoryListing | null = null;
      useConnectionStore.getState().setDirectoryListingCallback((listing) => {
        received = listing;
      });

      _testMessageHandler.handle({
        type: 'directory_listing',
        path: '/Users/test/Projects',
        parentPath: '/Users/test',
        entries: [{ name: 'chroxy', isDirectory: true }],
        error: null,
      });

      expect(received).not.toBeNull();
      expect(received!.path).toBe('/Users/test/Projects');
      expect(received!.parentPath).toBe('/Users/test');
      expect(received!.entries).toEqual([{ name: 'chroxy', isDirectory: true }]);
      expect(received!.error).toBeNull();
    });

    it('does not invoke callback when null', () => {
      // Ensure no callback is set
      useConnectionStore.getState().setDirectoryListingCallback(null);

      // Should not throw
      _testMessageHandler.handle({
        type: 'directory_listing',
        path: '/tmp',
        parentPath: '/',
        entries: [],
        error: null,
      });
    });

    it('coerces nullable path from server error response', () => {
      let received: DirectoryListing | null = null;
      useConnectionStore.getState().setDirectoryListingCallback((listing) => {
        received = listing;
      });

      _testMessageHandler.handle({
        type: 'directory_listing',
        path: null,
        parentPath: null,
        entries: [],
        error: 'Directory not found',
      });

      expect(received).not.toBeNull();
      expect(received!.path).toBeNull();
      expect(received!.error).toBe('Directory not found');
    });

    it('guards entries as array', () => {
      let received: DirectoryListing | null = null;
      useConnectionStore.getState().setDirectoryListingCallback((listing) => {
        received = listing;
      });

      _testMessageHandler.handle({
        type: 'directory_listing',
        path: '/tmp',
        parentPath: '/',
        entries: 'not-an-array',
        error: null,
      });

      expect(received).not.toBeNull();
      expect(received!.entries).toEqual([]);
    });

    it('guards error as string', () => {
      let received: DirectoryListing | null = null;
      useConnectionStore.getState().setDirectoryListingCallback((listing) => {
        received = listing;
      });

      _testMessageHandler.handle({
        type: 'directory_listing',
        path: '/tmp',
        parentPath: '/',
        entries: [],
        error: 42,
      });

      expect(received).not.toBeNull();
      expect(received!.error).toBeNull();
    });

    it('callback is cleared on disconnect', () => {
      let callCount = 0;
      useConnectionStore.getState().setDirectoryListingCallback(() => {
        callCount++;
      });

      useConnectionStore.getState().disconnect();

      _testMessageHandler.setContext({
        url: 'wss://test', token: 'tok', isReconnect: false,
        silent: false, socket: mockSocket,
      });

      _testMessageHandler.handle({
        type: 'directory_listing',
        path: '/tmp',
        parentPath: '/',
        entries: [],
        error: null,
      });

      expect(callCount).toBe(0);
    });
  });
});

// -- buildXtermHtml --

import { buildXtermHtml } from '../../components/xterm-html';

describe('buildXtermHtml', () => {
  it('returns valid HTML with doctype', () => {
    const html = buildXtermHtml();
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html>');
    expect(html).toContain('</html>');
  });

  it('inlines xterm.js locally (no CDN)', () => {
    const html = buildXtermHtml();
    // Should contain inlined xterm code, not CDN references
    expect(html).toContain('new Terminal(');
    expect(html).toContain('FitAddon');
    expect(html).toContain('.xterm');
    // Should NOT reference any CDN
    expect(html).not.toContain('cdn.jsdelivr.net');
  });

  it('interpolates theme colors', () => {
    const html = buildXtermHtml();
    expect(html).toContain('#000'); // backgroundTerminal
    expect(html).toContain('#00ff00'); // textTerminal
  });

  it('includes bridge protocol handlers', () => {
    const html = buildXtermHtml();
    expect(html).toContain('ReactNativeWebView.postMessage');
    expect(html).toContain("type: 'ready'");
    expect(html).toContain("case 'write'");
    expect(html).toContain("case 'clear'");
    expect(html).toContain("case 'reset'");
  });

  it('configures terminal as display-only', () => {
    const html = buildXtermHtml();
    expect(html).toContain('disableStdin: true');
  });

  it('includes resize notification with debounce', () => {
    const html = buildXtermHtml();
    expect(html).toContain("type: 'resize'");
    expect(html).toContain('notifyResize');
    // Verify debounce timer (250ms)
    expect(html).toContain('250');
  });
});

// -- resize() store action --

describe('resize store action', () => {
  it('sends resize message over WebSocket', () => {
    const sent: string[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: string) => sent.push(data),
    } as unknown as WebSocket;

    useConnectionStore.setState({ socket: mockSocket });
    useConnectionStore.getState().resize(120, 40);

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ type: 'resize', cols: 120, rows: 40, sessionId: 'default' });
  });

  it('no-ops when socket is not connected', () => {
    useConnectionStore.setState({ socket: null });
    // Should not throw
    useConnectionStore.getState().resize(80, 24);
  });
});

// -- createSession() store action --

describe('createSession store action', () => {
  // The next describe block ('permission boundary splitting') calls
  // `useConnectionStore.getState().disconnect()` in its beforeEach, which
  // unconditionally invokes `socket.close()` on whatever socket is set.
  // Without a `close` (and `onclose`) on this mock, that disconnect would
  // throw `socket.close is not a function` when the suite runs in order.
  // Provide no-op stubs to keep the test suite order-independent.
  function makeMockSocket(): { socket: WebSocket; sent: string[] } {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      send: (data: string) => sent.push(data),
      close: () => {},
      onclose: null,
    } as unknown as WebSocket;
    return { socket, sent };
  }

  // Reset the socket to null after each test so a leaked mock can't bleed
  // into a sibling describe block's `disconnect()` call. Belt-and-braces
  // alongside the close stub above.
  afterEach(() => {
    useConnectionStore.setState({ socket: null });
  });

  it('sends create_session with name only when other fields omitted', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().createSession({ name: 'NewSession' });

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ type: 'create_session', name: 'NewSession' });
  });

  it('sends cwd, worktree, provider when provided', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().createSession({
      name: 'S',
      cwd: '/work',
      worktree: true,
      provider: 'sdk',
    });

    expect(JSON.parse(sent[0])).toEqual({
      type: 'create_session',
      name: 'S',
      cwd: '/work',
      worktree: true,
      provider: 'sdk',
    });
  });

  it('forwards model and permissionMode to the wire (#3599)', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().createSession({
      name: 'S',
      cwd: '/work',
      worktree: false,
      provider: 'sdk',
      model: 'claude-sonnet-4-5',
      permissionMode: 'plan',
    });

    expect(JSON.parse(sent[0])).toEqual({
      type: 'create_session',
      name: 'S',
      cwd: '/work',
      provider: 'sdk',
      model: 'claude-sonnet-4-5',
      permissionMode: 'plan',
    });
  });

  it('omits model and permissionMode when undefined (no behaviour change)', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().createSession({
      name: 'S',
      cwd: undefined,
      worktree: undefined,
      provider: undefined,
      model: undefined,
      permissionMode: undefined,
    });

    const payload = JSON.parse(sent[0]);
    expect(payload.model).toBeUndefined();
    expect(payload.permissionMode).toBeUndefined();
  });

  it('omits empty-string model and permissionMode (so SessionInfo `null` falls through cleanly)', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    // The restart handler passes `session.model || undefined` — but this also
    // verifies the action itself filters falsy values, defending against any
    // future caller that forwards an empty string.
    useConnectionStore.getState().createSession({
      name: 'S',
      cwd: '/cwd',
      worktree: false,
      provider: 'sdk',
      model: '',
      permissionMode: '',
    });

    const payload = JSON.parse(sent[0]);
    expect(payload.model).toBeUndefined();
    expect(payload.permissionMode).toBeUndefined();
  });

  it('forwards environmentId to the wire (#3611, dashboard parity)', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().createSession({
      name: 'S',
      environmentId: 'env-123',
    });

    expect(JSON.parse(sent[0])).toEqual({
      type: 'create_session',
      name: 'S',
      environmentId: 'env-123',
    });
  });

  it('omits empty-string environmentId (consistent with other fields)', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().createSession({
      name: 'S',
      environmentId: '',
    });

    const payload = JSON.parse(sent[0]);
    expect(payload.environmentId).toBeUndefined();
  });

  it('no-ops when socket is not connected', () => {
    useConnectionStore.setState({ socket: null });
    // Should not throw
    useConnectionStore.getState().createSession({
      name: 'S',
      cwd: '/cwd',
      worktree: false,
      provider: 'sdk',
      model: 'opus',
      permissionMode: 'plan',
    });
  });
});

// -- SessionScreen restart handler integration (#3599) --
//
// Static check that handleRestartStdinSession forwards the source session's
// model + permissionMode to createSession so the restart preserves user-
// customized values. Mirrors the dashboard's handleRestartSession (#3593).

describe('SessionScreen handleRestartStdinSession (#3599)', () => {
  it('forwards session.model and session.permissionMode to createSession', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(
      path.resolve(__dirname, '../../screens/SessionScreen.tsx'),
      'utf-8',
    );
    // The restart handler must pass model + permissionMode in the options
    // object so the recreated session preserves them. Match a flexible pattern
    // that tolerates whitespace/comments but requires both fields. (#3611
    // refactored this from 6 positional args to a single options object.)
    expect(src).toMatch(/handleRestartStdinSession[\s\S]*?createSession\(\{[\s\S]*?session\.model[\s\S]*?session\.permissionMode/);
  });
});

// -- Permission boundary splitting --

describe('permission boundary splitting', () => {
  const mockSocket = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    // Clear module-level split state via disconnect (resets _postPermissionSplits,
    // _deltaIdRemaps, pendingDeltas, deltaFlushTimer)
    useConnectionStore.getState().disconnect();
    useConnectionStore.setState({
      activeSessionId: 'default',
      sessionStates: { default: createEmptySessionState() },
    });
    useConnectionLifecycleStore.setState({ connectionPhase: 'disconnected' });
    (mockSocket.send as jest.Mock).mockClear();
    (mockSocket.close as jest.Mock).mockClear();
    _testMessageHandler.setContext({
      url: 'wss://test', token: 'tok', isReconnect: false,
      silent: false, socket: mockSocket,
    });
  });

  afterEach(() => {
    _testMessageHandler.clearContext();
    jest.useRealTimers();
  });

  it('flushes pending deltas and splits on permission_request mid-stream', () => {
    // Start a stream
    _testMessageHandler.handle({ type: 'stream_start', messageId: 'srv-1' });
    expect(useConnectionStore.getState().getActiveSessionState().streamingMessageId).toBe('srv-1');

    // Send a delta (buffered, not yet flushed)
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'Hello ' });

    // Permission request arrives mid-stream — should flush buffered deltas
    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'req-1',
      tool: 'Write', description: 'Write to file',
    });

    // streamingMessageId should be cleared
    expect(useConnectionStore.getState().getActiveSessionState().streamingMessageId).toBeNull();

    // The buffered delta should have been flushed (the response message has content)
    const msgs = useConnectionStore.getState().getActiveSessionState().messages;
    const response = msgs.find((m) => m.id === 'srv-1');
    expect(response).toBeDefined();
    expect(response!.content).toBe('Hello ');

    // Permission prompt should be present
    const perm = msgs.find((m) => m.type === 'prompt');
    expect(perm).toBeDefined();
    expect(perm!.requestId).toBe('req-1');
  });

  it('creates a new message on first post-permission delta', () => {
    // Start stream, send delta, flush it, then permission
    _testMessageHandler.handle({ type: 'stream_start', messageId: 'srv-1' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'Before' });
    jest.advanceTimersByTime(200); // flush

    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'req-1',
      tool: 'Write', description: 'Write file',
    });

    // First delta after permission should create a new message
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'After' });
    jest.advanceTimersByTime(200); // flush

    const msgs = useConnectionStore.getState().getActiveSessionState().messages;

    // Should have: original response, permission prompt, new response
    const responses = msgs.filter((m) => m.type === 'response');
    expect(responses).toHaveLength(2);
    expect(responses[0].id).toBe('srv-1');
    expect(responses[0].content).toBe('Before');
    expect(responses[1].id).toMatch(/^srv-1-post-/);
    expect(responses[1].content).toBe('After');

    // streamingMessageId should point to the new message
    expect(useConnectionStore.getState().getActiveSessionState().streamingMessageId).toBe(responses[1].id);
  });

  it('remaps subsequent deltas to the new post-permission message', () => {
    _testMessageHandler.handle({ type: 'stream_start', messageId: 'srv-1' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'X' });
    jest.advanceTimersByTime(200);

    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'req-1',
      tool: 'Read', description: 'Read file',
    });

    // First post-permission delta creates new message
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'A' });
    jest.advanceTimersByTime(200);

    // Subsequent delta should be remapped to the same new message
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'B' });
    jest.advanceTimersByTime(200);

    const msgs = useConnectionStore.getState().getActiveSessionState().messages;
    const postPermResponse = msgs.filter((m) => m.type === 'response')[1];
    expect(postPermResponse.content).toBe('AB');
  });

  it('handles multiple permission splits in the same stream', () => {
    _testMessageHandler.handle({ type: 'stream_start', messageId: 'srv-1' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'Part1' });
    jest.advanceTimersByTime(200);

    // First permission
    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'req-1',
      tool: 'Write', description: 'Write file 1',
    });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'Part2' });
    jest.advanceTimersByTime(200);

    // Second permission
    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'req-2',
      tool: 'Write', description: 'Write file 2',
    });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'Part3' });
    jest.advanceTimersByTime(200);

    const msgs = useConnectionStore.getState().getActiveSessionState().messages;
    const responses = msgs.filter((m) => m.type === 'response');
    expect(responses).toHaveLength(3);
    expect(responses[0].content).toBe('Part1');
    expect(responses[1].content).toBe('Part2');
    expect(responses[2].content).toBe('Part3');

    const prompts = msgs.filter((m) => m.type === 'prompt');
    expect(prompts).toHaveLength(2);
  });

  it('cleans up split state on stream_end', () => {
    _testMessageHandler.handle({ type: 'stream_start', messageId: 'srv-1' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'text' });
    jest.advanceTimersByTime(200);

    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'req-1',
      tool: 'Write', description: 'Write',
    });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'more' });
    jest.advanceTimersByTime(200);

    // stream_end should clean up
    _testMessageHandler.handle({ type: 'stream_end', messageId: 'srv-1' });
    expect(useConnectionStore.getState().getActiveSessionState().streamingMessageId).toBeNull();

    // Starting a new stream with the same messageId should not trigger a split
    _testMessageHandler.handle({ type: 'stream_start', messageId: 'srv-1' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'fresh' });
    jest.advanceTimersByTime(200);

    // The original srv-1 message should be updated (not split)
    const responses = useConnectionStore.getState().getActiveSessionState().messages.filter((m) => m.type === 'response');
    // Last response should have content appended (fresh is appended to existing)
    const srv1 = responses.find((m) => m.id === 'srv-1');
    expect(srv1).toBeDefined();
    expect(srv1!.content).toContain('fresh');
  });

  it('cleans up split state on result (safety net)', () => {
    _testMessageHandler.handle({ type: 'stream_start', messageId: 'srv-1' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'srv-1', delta: 'text' });
    jest.advanceTimersByTime(200);

    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'req-1',
      tool: 'Write', description: 'Write',
    });

    // Result arrives without stream_end (missed stream_end scenario)
    _testMessageHandler.handle({ type: 'result', cost: 0.01, duration: 100 });
    expect(useConnectionStore.getState().getActiveSessionState().streamingMessageId).toBeNull();
  });
});

// -- Permission request dedup on reconnect --

describe('permission_request dedup on reconnect', () => {
  const mockSocket = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    useConnectionStore.getState().disconnect();
    useConnectionStore.setState({
      activeSessionId: 'default',
      sessionStates: { default: createEmptySessionState() },
    });
    useConnectionLifecycleStore.setState({ connectionPhase: 'disconnected' });
    (mockSocket.send as jest.Mock).mockClear();
    (mockSocket.close as jest.Mock).mockClear();
    _testMessageHandler.setContext({
      url: 'wss://test', token: 'tok', isReconnect: false,
      silent: false, socket: mockSocket,
    });
  });

  afterEach(() => {
    _testMessageHandler.clearContext();
    jest.useRealTimers();
  });

  it('updates existing permission card instead of appending duplicate on reconnect', () => {
    // First permission_request — creates the card
    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'perm-dup-1',
      tool: 'Bash', description: 'rm -rf /tmp/test',
      remainingMs: 300_000,
    });

    const msgsAfterFirst = useConnectionStore.getState().getActiveSessionState().messages;
    expect(msgsAfterFirst.filter((m) => m.type === 'prompt')).toHaveLength(1);
    const firstCard = msgsAfterFirst.find((m) => m.requestId === 'perm-dup-1');
    expect(firstCard).toBeDefined();
    expect(firstCard!.expiresAt).toBeDefined();
    const originalId = firstCard!.id;

    // Second permission_request with same requestId (simulates reconnect re-send)
    // with a shorter remainingMs (time has elapsed)
    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'perm-dup-1',
      tool: 'Bash', description: 'rm -rf /tmp/test',
      remainingMs: 240_000,
    });

    const msgsAfterSecond = useConnectionStore.getState().getActiveSessionState().messages;

    // Should still have exactly one prompt — no duplicate
    const prompts = msgsAfterSecond.filter((m) => m.type === 'prompt');
    expect(prompts).toHaveLength(1);

    // The card should be updated (same id, refreshed expiresAt)
    const updatedCard = prompts[0];
    expect(updatedCard.requestId).toBe('perm-dup-1');
    expect(updatedCard.id).toBe(originalId);
    // expiresAt should reflect the new remainingMs
    expect(updatedCard.expiresAt).toBeDefined();
  });

  it('clears answered state when updating an existing permission card', () => {
    // Create a permission card
    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'perm-dup-2',
      tool: 'Edit', description: 'edit config.js',
      remainingMs: 300_000,
    });

    // Simulate the card being answered (mark it manually)
    const state = useConnectionStore.getState();
    const ss = state.sessionStates[state.activeSessionId!]!;
    const msgs = ss.messages;
    const card = msgs.find((m) => m.requestId === 'perm-dup-2');
    expect(card).toBeDefined();
    useConnectionStore.setState({
      sessionStates: {
        ...state.sessionStates,
        [state.activeSessionId!]: {
          ...ss,
          messages: msgs.map((m) =>
            m.requestId === 'perm-dup-2' ? { ...m, answered: 'allow' as const } : m
          ),
        },
      },
    });

    // Verify it was marked as answered
    const answeredMsgs = useConnectionStore.getState().getActiveSessionState().messages;
    const answeredCard = answeredMsgs.find((m) => m.requestId === 'perm-dup-2');
    expect(answeredCard!.answered).toBe('allow');

    // Re-send same permission (reconnect) — should clear answered state
    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'perm-dup-2',
      tool: 'Edit', description: 'edit config.js',
      remainingMs: 200_000,
    });

    const finalMsgs = useConnectionStore.getState().getActiveSessionState().messages;
    const finalCard = finalMsgs.find((m) => m.requestId === 'perm-dup-2');
    expect(finalCard!.answered).toBeUndefined();
    expect(finalCard!.expiresAt).toBeDefined();
  });

  it('creates separate cards for different requestIds', () => {
    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'perm-a',
      tool: 'Bash', description: 'ls',
      remainingMs: 300_000,
    });

    _testMessageHandler.handle({
      type: 'permission_request', requestId: 'perm-b',
      tool: 'Edit', description: 'edit file',
      remainingMs: 300_000,
    });

    const prompts = useConnectionStore.getState().getActiveSessionState().messages.filter((m) => m.type === 'prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[0].requestId).toBe('perm-a');
    expect(prompts[1].requestId).toBe('perm-b');
  });
});

// ---------------------------------------------------------------------------
// Permission response auto-switch (#1710) — app store
// ---------------------------------------------------------------------------
describe('permission response auto-switch (app)', () => {
  const makeMsg = (id: string, reqId: string): ChatMessage => ({
    id,
    type: 'prompt',
    content: 'Allow?',
    timestamp: 1,
    requestId: reqId,
  });

  it('switches to session that owns the permission when different from active', () => {
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
  });

  it('does not switch when permission belongs to the active session', () => {
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
  });
});

describe('markPromptAnsweredByRequestId', () => {
  it('marks the correct message when prompt belongs to a non-active session', () => {
    const permMsg = {
      id: 'perm-bg',
      type: 'prompt' as const,
      content: 'Allow?',
      requestId: 'req-bg',
      timestamp: 1,
    };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
        s2: { ...createEmptySessionState(), messages: [permMsg] },
      },
    });

    useConnectionStore.getState().markPromptAnsweredByRequestId('req-bg', 'allow');

    const s2Msgs = useConnectionStore.getState().sessionStates.s2!.messages;
    const marked = s2Msgs.find((m) => m.requestId === 'req-bg');
    expect(marked?.answered).toBe('allow');
  });

  it('leaves other session messages untouched', () => {
    const permMsg = {
      id: 'perm-bg2',
      type: 'prompt' as const,
      content: 'Allow write?',
      requestId: 'req-bg2',
      timestamp: 1,
    };
    const otherMsg = {
      id: 'other-1',
      type: 'response' as const,
      content: 'Hello',
      requestId: undefined,
      timestamp: 2,
    };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [otherMsg] },
        s2: { ...createEmptySessionState(), messages: [permMsg] },
      },
    });

    useConnectionStore.getState().markPromptAnsweredByRequestId('req-bg2', 'deny');

    // s1 untouched
    const s1Msgs = useConnectionStore.getState().sessionStates.s1!.messages;
    expect(s1Msgs).toHaveLength(1);
    expect((s1Msgs[0] as any).answered).toBeUndefined();
  });

  it('is a no-op when sessionStates has no matching requestId', () => {
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: createEmptySessionState() },
    });

    // Should not throw
    useConnectionStore.getState().markPromptAnsweredByRequestId('req-nonexistent', 'allow');

    const msgs = useConnectionStore.getState().getActiveSessionState().messages;
    expect(msgs).toHaveLength(0);
  });
});

describe('markPromptAnsweredMulti (#4973)', () => {
  it('stores the structured answers map and a comma-joined summary on the active session message', () => {
    const promptMsg = {
      id: 'mq-1',
      type: 'prompt' as const,
      content: 'Q1?',
      toolUseId: 'toolu_multi',
      timestamp: 1,
    };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [promptMsg] },
      },
    });

    const answers = {
      'Q1 — deploy to production?': 'approve',
      'Q2 — which areas to verify?': ['app', 'server'],
    };
    useConnectionStore.getState().markPromptAnsweredMulti('mq-1', answers);

    const msg = useConnectionStore.getState().getActiveSessionState().messages[0] as any;
    // Structured map preserved verbatim (multi-select stays a string[]).
    expect(msg.answeredAnswers).toEqual(answers);
    // Flat `answered` holds the human-readable comma-joined summary.
    expect(msg.answered).toBe(
      'Q1 — deploy to production?: approve | Q2 — which areas to verify?: app, server',
    );
    expect(typeof msg.answeredAt).toBe('number');
  });

  it('leaves other messages untouched', () => {
    const promptMsg = {
      id: 'mq-2',
      type: 'prompt' as const,
      content: 'Q?',
      toolUseId: 'toolu_x',
      timestamp: 1,
    };
    const otherMsg = {
      id: 'resp-1',
      type: 'response' as const,
      content: 'Hi',
      timestamp: 2,
    };
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [promptMsg, otherMsg] },
      },
    });

    useConnectionStore.getState().markPromptAnsweredMulti('mq-2', { 'Q?': 'yes' });

    const msgs = useConnectionStore.getState().getActiveSessionState().messages;
    expect((msgs[1] as any).answered).toBeUndefined();
    expect((msgs[1] as any).answeredAnswers).toBeUndefined();
  });
});

describe('inactivityWarning cleanup (#3899)', () => {
  const WARNING = { idleMs: 1_800_000, prefab: 'Status update?', receivedAt: 1 };

  it('sendInput clears the active session warning when the input is queued (no socket)', () => {
    useConnectionStore.setState({
      socket: null,
      activeSessionId: 's-active',
      sessionStates: {
        's-active': { ...createEmptySessionState(), inactivityWarning: { ...WARNING } },
      },
    });

    const result = useConnectionStore.getState().sendInput('Status update?');

    // No live socket → queued, but the chip should still dismiss.
    expect(result).toBe('queued');
    const ss = useConnectionStore.getState().sessionStates['s-active']!;
    expect(ss.inactivityWarning).toBeNull();
  });

  it('sendInput leaves other-session warnings intact', () => {
    useConnectionStore.setState({
      socket: null,
      activeSessionId: 's-active',
      sessionStates: {
        's-active': { ...createEmptySessionState(), inactivityWarning: { ...WARNING } },
        's-other': { ...createEmptySessionState(), inactivityWarning: { ...WARNING } },
      },
    });

    useConnectionStore.getState().sendInput('Status update?');

    const states = useConnectionStore.getState().sessionStates;
    expect(states['s-active']!.inactivityWarning).toBeNull();
    expect(states['s-other']!.inactivityWarning).toEqual(WARNING);
  });

  it('disconnect clears warnings across ALL sessions, not just the active one', () => {
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: {
        s1: { ...createEmptySessionState(), inactivityWarning: { ...WARNING } },
        s2: { ...createEmptySessionState(), inactivityWarning: { ...WARNING } },
        s3: { ...createEmptySessionState() }, // no warning — unaffected
      },
    });

    useConnectionStore.getState().disconnect();

    const states = useConnectionStore.getState().sessionStates;
    expect(states.s1!.inactivityWarning).toBeNull();
    expect(states.s2!.inactivityWarning).toBeNull();
    expect(states.s3!.inactivityWarning).toBeNull();
  });

  it('disconnect is a no-op for warning state when no session has one outstanding', () => {
    const before = createEmptySessionState();
    useConnectionStore.setState({
      activeSessionId: 's1',
      sessionStates: { s1: before },
    });
    // Capture pre-disconnect reference equality
    const sessionsRefBefore = useConnectionStore.getState().sessionStates.s1;

    useConnectionStore.getState().disconnect();

    const sessionsRefAfter = useConnectionStore.getState().sessionStates.s1;
    expect(sessionsRefAfter).toBe(sessionsRefBefore);
  });
});

// -- sendUserQuestionResponse Other / freeform shape (#4755) --
//
// Pins the wire-payload serialization for the single-question Other path,
// mirroring the dashboard's #4651 store test. When `answer` is the
// `{otherLabel, freeformText}` object shape, the wire payload must be
// `{type:'user_question_response', answer:<otherLabel>, freeformText:<typed>,
// toolUseId?}` so the server can drive the two-stage TUI write (Other digit
// → text-input prompt → freeform text + Enter). String answers must keep
// the legacy `{type, answer, toolUseId?}` shape unchanged.

describe('sendUserQuestionResponse Other / freeform shape (#4755)', () => {
  function makeMockSocket(): { socket: WebSocket; sent: string[] } {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      send: (data: string) => sent.push(data),
      close: () => {},
      onclose: null,
    } as unknown as WebSocket;
    return { socket, sent };
  }

  afterEach(() => {
    useConnectionStore.setState({ socket: null });
  });

  it('emits {answer:<otherLabel>, freeformText, toolUseId} for the freeform object shape', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().sendUserQuestionResponse(
      { otherLabel: 'Other', freeformText: 'my custom answer' },
      'toolu_other_freeform',
    );
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      type: 'user_question_response',
      answer: 'Other',
      freeformText: 'my custom answer',
      toolUseId: 'toolu_other_freeform',
    });
  });

  it('preserves a model-supplied custom Other label on the wire', () => {
    // Defends against a future regression where we forget to thread
    // `otherLabel` through and instead hard-code the literal "Other"
    // string — the server's digit-lookup would then resolve to the wrong
    // hotkey for any custom-label Other option.
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().sendUserQuestionResponse(
      { otherLabel: 'Something else', freeformText: 'typed' },
      'toolu-x',
    );
    expect(JSON.parse(sent[0])).toEqual({
      type: 'user_question_response',
      answer: 'Something else',
      freeformText: 'typed',
      toolUseId: 'toolu-x',
    });
  });

  it('keeps the legacy {answer:<string>, toolUseId} shape for plain string answers', () => {
    // Regular option taps + zero-options free-text answers (#1245) must
    // keep flowing through the legacy string serializer — older servers
    // that ignore `freeformText` must continue to receive a payload they
    // understand verbatim.
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().sendUserQuestionResponse('Option A', 'toolu-string');
    expect(JSON.parse(sent[0])).toEqual({
      type: 'user_question_response',
      answer: 'Option A',
      toolUseId: 'toolu-string',
    });
    // Critically, `freeformText` MUST be absent in the legacy shape so
    // server-side schema validators / handlers don't misclassify a plain
    // option tap as an Other / freeform send.
    expect(JSON.parse(sent[0])).not.toHaveProperty('freeformText');
  });

  it('omits toolUseId from the wire payload when not provided', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().sendUserQuestionResponse(
      { otherLabel: 'Other', freeformText: 'no-tooluse case' },
    );
    const payload = JSON.parse(sent[0]);
    expect(payload).toEqual({
      type: 'user_question_response',
      answer: 'Other',
      freeformText: 'no-tooluse case',
    });
    expect(payload).not.toHaveProperty('toolUseId');
  });
});

// #5589 / #5281 — explicit primary (driver) ownership claim. The action sends
// a `claim_primary` wire message; `force` overrides the current owner.
describe('claimPrimary wire payload (#5589 / #5281)', () => {
  function makeMockSocket(): { socket: WebSocket; sent: string[] } {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      send: (data: string) => { sent.push(data); },
    } as unknown as WebSocket;
    return { socket, sent };
  }

  it('emits a plain claim (no force) by default', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().claimPrimary('s1');
    expect(sent).toHaveLength(1);
    const payload = JSON.parse(sent[0]);
    expect(payload).toEqual({ type: 'claim_primary', sessionId: 's1' });
    expect(payload).not.toHaveProperty('force');
  });

  it('emits force:true for an explicit take-over', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().claimPrimary('s1', { force: true });
    expect(JSON.parse(sent[0])).toEqual({ type: 'claim_primary', sessionId: 's1', force: true });
  });

  it('no-ops when the socket is not open', () => {
    const sent: string[] = [];
    const socket = { readyState: 0, send: (d: string) => { sent.push(d); } } as unknown as WebSocket;
    useConnectionStore.setState({ socket });
    useConnectionStore.getState().claimPrimary('s1');
    expect(sent).toHaveLength(0);
  });
});
