import {
  stripAnsi,
  filterThinking,
  createEmptySessionState,
  nextMessageId,
  selectShowSession,
  useConnectionStore,
  ChatMessage,
} from '../../store/connection';

// Reset store between tests
beforeEach(() => {
  useConnectionStore.setState({
    messages: [],
    terminalBuffer: '',
    serverErrors: [],
    connectionPhase: 'disconnected',
    sessionStates: {},
    activeSessionId: null,
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
      useConnectionStore.setState({ connectionPhase: phase });
      const result = selectShowSession(useConnectionStore.getState());
      if (phase === 'disconnected') {
        expect(result).toBe(false);
      } else {
        expect(result).toBe(true);
      }
    }
  });
});

// -- Store actions --

describe('store actions', () => {
  describe('addMessage', () => {
    it('appends a message to the list', () => {
      const msg: ChatMessage = { id: 'test-1', type: 'response', content: 'hi', timestamp: 1 };
      useConnectionStore.getState().addMessage(msg);
      expect(useConnectionStore.getState().messages).toEqual([msg]);
    });

    it('removes thinking placeholder when a real message arrives', () => {
      const thinking: ChatMessage = { id: 'thinking', type: 'thinking', content: '', timestamp: 1 };
      const real: ChatMessage = { id: 'r1', type: 'response', content: 'done', timestamp: 2 };
      useConnectionStore.getState().addMessage(thinking);
      useConnectionStore.getState().addMessage(real);
      const messages = useConnectionStore.getState().messages;
      expect(messages).toEqual([real]);
    });

    it('does not filter thinking when adding another thinking message', () => {
      const thinking: ChatMessage = { id: 'thinking', type: 'thinking', content: '', timestamp: 1 };
      useConnectionStore.getState().addMessage(thinking);
      useConnectionStore.getState().addMessage(thinking);
      // addMessage keeps existing thinking when the new message IS thinking (filter passes all)
      expect(useConnectionStore.getState().messages.length).toBe(2);
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
    it('resets buffer to empty string', () => {
      useConnectionStore.setState({ terminalBuffer: 'some content' });
      useConnectionStore.getState().clearTerminalBuffer();
      expect(useConnectionStore.getState().terminalBuffer).toBe('');
    });
  });
});

// -- Message queue --

describe('message queue', () => {
  beforeEach(() => {
    // Clear queue by calling disconnect, then reset state
    useConnectionStore.getState().disconnect();
    useConnectionStore.setState({ connectionPhase: 'disconnected' });
  });

  it('queues input when socket is not connected', () => {
    const result = useConnectionStore.getState().sendInput('hello');
    expect(result).toBe('queued');
  });

  it('queues interrupt when socket is not connected', () => {
    const result = useConnectionStore.getState().sendInterrupt();
    expect(result).toBe('queued');
  });

  it('queues permission_response when socket is not connected', () => {
    const result = useConnectionStore.getState().sendPermissionResponse('req-1', 'allow');
    expect(result).toBe('queued');
  });

  it('queues user_question_response when socket is not connected', () => {
    const result = useConnectionStore.getState().sendUserQuestionResponse('yes');
    expect(result).toBe('queued');
  });

  it('returns false when queue is full (max 10)', () => {
    const store = useConnectionStore.getState();
    for (let i = 0; i < 10; i++) {
      expect(store.sendInput(`msg-${i}`)).toBe('queued');
    }
    // 11th should fail
    expect(store.sendInput('overflow')).toBe(false);
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
