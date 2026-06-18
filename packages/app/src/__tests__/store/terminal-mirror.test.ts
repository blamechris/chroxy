import {
  useConnectionStore,
  createEmptySessionState,
  _testMessageHandler,
} from '../../store/connection';

// #5835 / #5987 — read-only PTY mirror channel on mobile (PR1). Covers the new
// store actions (terminal_subscribe / terminal_unsubscribe / terminal_resize)
// and the terminal_output receive path that feeds appendTerminalData.

const mockOpenSocket = () => {
  const sent: Record<string, unknown>[] = [];
  const socket = {
    readyState: 1, // OPEN
    send: (data: string) => { sent.push(JSON.parse(data)); },
    close: jest.fn(),
  };
  useConnectionStore.setState({ socket: socket as unknown as WebSocket });
  return sent;
};

beforeEach(() => {
  useConnectionStore.setState({
    terminalBuffer: '',
    terminalRawBuffer: '',
    sessionStates: { default: createEmptySessionState() },
    activeSessionId: 'default',
    socket: null,
  });
});

describe('subscribeTerminalMirror', () => {
  it('sends terminal_subscribe for a non-empty sessionId on an open socket', () => {
    const sent = mockOpenSocket();
    useConnectionStore.getState().subscribeTerminalMirror('sess-1');
    expect(sent).toEqual([{ type: 'terminal_subscribe', sessionId: 'sess-1' }]);
  });

  it('does nothing for an empty sessionId', () => {
    const sent = mockOpenSocket();
    useConnectionStore.getState().subscribeTerminalMirror('');
    expect(sent).toHaveLength(0);
  });

  it('no-ops (does not throw) when the socket is not open', () => {
    useConnectionStore.setState({ socket: null });
    expect(() => useConnectionStore.getState().subscribeTerminalMirror('sess-1')).not.toThrow();
  });
});

describe('unsubscribeTerminalMirror', () => {
  it('sends terminal_unsubscribe for a non-empty sessionId', () => {
    const sent = mockOpenSocket();
    useConnectionStore.getState().unsubscribeTerminalMirror('sess-1');
    expect(sent).toEqual([{ type: 'terminal_unsubscribe', sessionId: 'sess-1' }]);
  });

  it('does nothing for an empty sessionId', () => {
    const sent = mockOpenSocket();
    useConnectionStore.getState().unsubscribeTerminalMirror('');
    expect(sent).toHaveLength(0);
  });
});

describe('sendTerminalResize', () => {
  it('sends terminal_resize with cols/rows for a valid size', () => {
    const sent = mockOpenSocket();
    useConnectionStore.getState().sendTerminalResize('sess-1', 120, 40);
    expect(sent).toEqual([{ type: 'terminal_resize', sessionId: 'sess-1', cols: 120, rows: 40 }]);
  });

  it('does nothing when cols <= 0 or rows <= 0', () => {
    const sent = mockOpenSocket();
    useConnectionStore.getState().sendTerminalResize('sess-1', 0, 40);
    useConnectionStore.getState().sendTerminalResize('sess-1', 120, 0);
    useConnectionStore.getState().sendTerminalResize('sess-1', -1, -1);
    expect(sent).toHaveLength(0);
  });

  it('does nothing for an empty sessionId', () => {
    const sent = mockOpenSocket();
    useConnectionStore.getState().sendTerminalResize('', 120, 40);
    expect(sent).toHaveLength(0);
  });
});

describe('terminal_output receive', () => {
  const mockSocket = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;

  beforeEach(() => {
    _testMessageHandler.setContext({
      url: 'wss://test', token: 'tok', isReconnect: false,
      silent: false, socket: mockSocket,
    });
  });
  afterEach(() => _testMessageHandler.clearContext());

  it('appends the data string for the ACTIVE session (same path as raw)', () => {
    // activeSessionId is 'default' (see top-level beforeEach).
    _testMessageHandler.handle({ type: 'terminal_output', sessionId: 'default', data: 'hello shell\r\n' });
    expect(useConnectionStore.getState().terminalRawBuffer).toContain('hello shell');
  });

  it('ignores a frame for a non-active session (no cross-session bleed)', () => {
    // A stale frame for a just-left session must not paint the active terminal
    // (mobile uses one global terminalRawBuffer). Active is 'default'.
    const before = useConnectionStore.getState().terminalRawBuffer;
    _testMessageHandler.handle({ type: 'terminal_output', sessionId: 'other-session', data: 'stale bytes' });
    expect(useConnectionStore.getState().terminalRawBuffer).toBe(before);
  });

  it('ignores a frame with a missing sessionId', () => {
    const before = useConnectionStore.getState().terminalRawBuffer;
    _testMessageHandler.handle({ type: 'terminal_output', data: 'orphan' });
    expect(useConnectionStore.getState().terminalRawBuffer).toBe(before);
  });

  it('ignores a non-string data payload without throwing or appending', () => {
    const before = useConnectionStore.getState().terminalRawBuffer;
    _testMessageHandler.handle({ type: 'terminal_output', sessionId: 'default', data: 12345 });
    _testMessageHandler.handle({ type: 'terminal_output', sessionId: 'default' });
    expect(useConnectionStore.getState().terminalRawBuffer).toBe(before);
  });
});
