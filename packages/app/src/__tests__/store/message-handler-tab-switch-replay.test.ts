import {
  _testMessageHandler,
  setStore,
  _testResetStore,
  resetAllHandlerState,
} from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import { resetReplayReconcile } from '@chroxy/store-core';
import { createEmptySessionState } from '../../store/utils';
import type { ConnectionState } from '../../store/types';

jest.mock('../../store/persistence', () => ({
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
    setState: (u: Partial<ConnectionState> | ((s: ConnectionState) => Partial<ConnectionState>)) => {
      state = typeof u === 'function' ? { ...state, ...u(state) } : { ...state, ...u };
    },
    subscribe: () => () => {},
    destroy: () => {},
  };
}

let store: ReturnType<typeof createMockStore>;
const send = (msg: Record<string, unknown>) => _testMessageHandler.handle(msg);
const rows = (sid = 's1') =>
  store.getState().sessionStates[sid].messages.map((m) => `${m.type}:${m.id}:${(m.content ?? '').slice(0, 12)}`);

beforeEach(() => {
  jest.clearAllMocks();
  resetAllHandlerState();
  store = createMockStore({
    activeSessionId: 's1',
    fetchSlashCommands: jest.fn(),
    fetchCustomAgents: jest.fn(),
    sessions: [],
    sessionStates: {
      s1: { ...createEmptySessionState(), isIdle: true, streamingMessageId: null },
      s2: { ...createEmptySessionState(), isIdle: true, streamingMessageId: null },
    } as ConnectionState['sessionStates'],
  });
  setStore(store as never);
  _testMessageHandler.setContext(createMockConnectionContext());
});
afterEach(() => _testResetStore());

// Live turn (what the client builds while connected)
function liveTurn(n: number) {
  send({ type: 'user_input', sessionId: 's1', clientId: 'other', messageId: `u${n}`, text: `question ${n}`, timestamp: n * 10 });
  send({ type: 'stream_start', sessionId: 's1', messageId: `r${n}` });
  send({ type: 'stream_delta', sessionId: 's1', messageId: `r${n}`, delta: `answer ${n}` });
  send({ type: 'stream_end', sessionId: 's1', messageId: `r${n}` });
}
// The server's forceFull replay of the same history, as sendHistoryEntry frames it
function fullReplay(turns: number, sid = 's1') {
  send({ type: 'session_switched', sessionId: sid, name: sid, cwd: '/x' });
  send({ type: 'history_replay_start', sessionId: sid, fullHistory: true, truncated: false, latestSeq: turns * 2 });
  for (let n = 1; n <= turns; n++) {
    send({ type: 'message', sessionId: sid, messageType: 'user_input', content: `question ${n}`, messageId: `u${n}`, timestamp: n * 10, historySeq: n * 2 - 1 });
    send({ type: 'message', sessionId: sid, messageType: 'response', content: `answer ${n}`, messageId: `r${n}`, timestamp: n * 10 + 1, historySeq: n * 2 });
  }
  send({ type: 'history_replay_end', sessionId: sid, latestSeq: turns * 2 });
}

/**
 * #8953 -- the STORE side of a tab switch. The reported blank / partial list was
 * a stale FlatList (see ChatView.sessionKey.test.tsx): the store always held every
 * message, and Files -> Chat, which remounts the list, showed them all. These pin
 * that half: a full-rebuild replay of a switch must hand back exactly the messages
 * the session held, so the list fix is not papering over a store that lost them.
 */
describe('tab switch away and back keeps every message in the store (#8953)', () => {
  it('a session that streamed live', () => {
    liveTurn(1); liveTurn(2); liveTurn(3);
    const before = rows();
    send({ type: 'session_switched', sessionId: 's2', name: 's2', cwd: '/x' });
    fullReplay(3);
    expect(rows()).toEqual(before);
    expect(rows()).toHaveLength(6);
  });

  it('a session rebuilt from a replay, switched away and back twice', () => {
    fullReplay(4);
    const before = rows();
    expect(before).toHaveLength(8);
    send({ type: 'session_switched', sessionId: 's2', name: 's2', cwd: '/x' });
    fullReplay(4);
    send({ type: 'session_switched', sessionId: 's2', name: 's2', cwd: '/x' });
    fullReplay(4);
    expect(rows()).toEqual(before);
  });

  it('after a daemon restart (connection reset, cursor replay) and then a switch', () => {
    fullReplay(4);
    const before = rows();
    // The socket dropped and re-authenticated: replay windows are torn down, cursors kept.
    resetReplayReconcile();
    send({ type: 'history_replay_start', sessionId: 's1', fullHistory: false, truncated: false, latestSeq: 8 });
    send({ type: 'history_replay_end', sessionId: 's1', latestSeq: 8 });
    expect(rows()).toEqual(before);
    send({ type: 'session_switched', sessionId: 's2', name: 's2', cwd: '/x' });
    fullReplay(4);
    expect(rows()).toEqual(before);
  });

  it('two overlapping full replays of one session (subscribe + switch) still end with every message once', () => {
    liveTurn(1); liveTurn(2);
    const before = rows();
    const entries = (n: number) => [
      { type: 'message', sessionId: 's1', messageType: 'user_input', content: `question ${n}`, messageId: `u${n}`, timestamp: n * 10, historySeq: n * 2 - 1 },
      { type: 'message', sessionId: 's1', messageType: 'response', content: `answer ${n}`, messageId: `r${n}`, timestamp: n * 10 + 1, historySeq: n * 2 },
    ];
    send({ type: 'history_replay_start', sessionId: 's1', fullHistory: true, truncated: false, latestSeq: 4 });
    send({ type: 'history_replay_start', sessionId: 's1', fullHistory: true, truncated: false, latestSeq: 4 });
    for (const n of [1, 2]) for (const e of entries(n)) { send(e); send(e); }
    send({ type: 'history_replay_end', sessionId: 's1', latestSeq: 4 });
    send({ type: 'history_replay_end', sessionId: 's1', latestSeq: 4 });
    expect(rows()).toEqual(before);
  });
});
