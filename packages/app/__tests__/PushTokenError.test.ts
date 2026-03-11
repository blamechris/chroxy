import { _testMessageHandler, setStore } from '../src/store/message-handler';
import { createEmptySessionState } from '../src/store/utils';
import type { ConnectionState } from '../src/store/types';

jest.mock('../src/store/persistence', () => ({
  clearPersistedSession: jest.fn(() => Promise.resolve()),
  persistSessionMessages: jest.fn(),
  persistViewMode: jest.fn(),
  persistActiveSession: jest.fn(),
  persistTerminalBuffer: jest.fn(),
  loadPersistedState: jest.fn(),
  loadSessionMessages: jest.fn(),
  clearPersistedState: jest.fn(),
  _resetForTesting: jest.fn(),
}));

function createMockStore(initialState: Partial<ConnectionState>) {
  let state = initialState as ConnectionState;
  return {
    getState: () => state,
    setState: (updater: Partial<ConnectionState> | ((s: ConnectionState) => Partial<ConnectionState>)) => {
      if (typeof updater === 'function') {
        state = { ...state, ...updater(state) };
      } else {
        state = { ...state, ...updater };
      }
    },
    subscribe: () => () => {},
    destroy: () => {},
  };
}

function createMockContext() {
  return {
    ws: null,
    sendMessage: jest.fn(),
    apiToken: 'test',
    serverUrl: 'wss://test',
    onSessionDestroyed: jest.fn(),
    reconnect: jest.fn(),
    disconnect: jest.fn(),
  };
}

describe('push_token_error handler (#1987)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('logs warning with error message from server', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
      messages: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'push_token_error',
      message: 'Invalid token format',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[push] Push token error from server:',
      'Invalid token format',
    );
  });

  test('uses fallback message when server message is empty', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
      messages: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'push_token_error',
      message: '',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[push] Push token error from server:',
      'Push token registration failed',
    );
  });
});
