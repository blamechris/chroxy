/**
 * #8518 — a thinking block that claude-tui reads from the transcript AFTER the
 * tool_start (or the answer) it was thought before is placed above it, live and
 * on a reload. The server says where (`thinkingPrecedes`); this proves the mobile
 * handler honours it through the SAME store-core placement the dashboard uses
 * (dashboard/src/store/late-thinking-order.test.ts is the twin).
 */
import {
  _testMessageHandler,
  setStore,
  _testResetStore,
  resetAllHandlerState,
} from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
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
    setState: (
      updater: Partial<ConnectionState> | ((s: ConnectionState) => Partial<ConnectionState>),
    ) => {
      state = typeof updater === 'function'
        ? { ...state, ...updater(state) }
        : { ...state, ...updater };
    },
    subscribe: () => () => {},
    destroy: () => {},
  };
}

const TURN = 'turn-1';
let store: ReturnType<typeof createMockStore>;
const send = (msg: Record<string, unknown>) => _testMessageHandler.handle({ sessionId: 's1', ...msg });
const ids = () => store.getState().sessionStates.s1.messages.map((m) => m.id);

beforeEach(() => {
  jest.clearAllMocks();
  resetAllHandlerState();
  store = createMockStore({
    activeSessionId: 's1',
    sessions: [],
    sessionStates: { s1: { ...createEmptySessionState(), isIdle: true, streamingMessageId: null } } as ConnectionState['sessionStates'],
  });
  setStore(store as never);
  _testMessageHandler.setContext(createMockConnectionContext());
});
afterEach(() => {
  _testResetStore();
});

describe('a late thinking block is placed by its ordering hint (#8518)', () => {
  const thinkingFrames = (precedes?: unknown) => {
    send({ type: 'stream_start', messageId: `${TURN}-thinking-0`, thinking: true, ...(precedes ? { thinkingPrecedes: precedes } : {}) });
    send({ type: 'stream_delta', messageId: `${TURN}-thinking-0`, delta: 'reasoning', thinking: true });
    send({ type: 'stream_end', messageId: `${TURN}-thinking-0`, thinking: true, thinkingDurationMs: 700 });
  };

  it('a block that names the tool it precedes lands directly above that tool row', () => {
    send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: { command: 'ls' } });
    thinkingFrames({ kind: 'tool_use', toolUseId: 'toolu_a' });
    expect(ids()).toEqual([`${TURN}-thinking-0`, 'toolu_a']);
    expect(store.getState().sessionStates.s1.messages.find((m) => m.type === 'thinking')).toMatchObject({
      content: 'reasoning', thinkingStreaming: false, thinkingDurationMs: 700,
    });
  });

  it('a block that names the response it precedes lands above the answer that is already shown', () => {
    send({ type: 'stream_start', messageId: TURN });
    send({ type: 'stream_delta', messageId: TURN, delta: 'The answer is 42.' });
    send({ type: 'stream_end', messageId: TURN });
    thinkingFrames({ kind: 'response', messageId: TURN });
    expect(ids()).toEqual([`${TURN}-thinking-0`, TURN]);
  });

  it('without a hint, or with a target that is not there, it is appended as it always was', () => {
    send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {} });
    thinkingFrames();
    expect(ids()).toEqual(['toolu_a', `${TURN}-thinking-0`]);
  });

  describe('after a reload (history replay)', () => {
    const replayThinkingEntry = (extra: Record<string, unknown>) => ({
      type: 'message', messageType: 'response', kind: 'thinking', content: 'reasoning', messageId: `${TURN}-thinking-0`,
      thinkingDurationMs: 700, timestamp: 30, ...extra,
    });

    it('the recorded hint puts the rebuilt bubble above its tool row, as it was live', () => {
      send({ type: 'history_replay_start', fullHistory: true });
      send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {}, timestamp: 20, historySeq: 1 });
      send(replayThinkingEntry({ historySeq: 2, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_a' } }));
      send({ type: 'history_replay_end' });
      expect(ids()).toEqual([`${TURN}-thinking-0`, 'toolu_a']);
    });

    it('the recorded hint puts the rebuilt bubble above the answer', () => {
      send({ type: 'history_replay_start', fullHistory: true });
      send({ type: 'message', messageType: 'response', content: 'The answer is 42.', messageId: TURN, timestamp: 20, historySeq: 1 });
      send(replayThinkingEntry({ historySeq: 2, thinkingPrecedes: { kind: 'response', messageId: TURN } }));
      send({ type: 'history_replay_end' });
      expect(ids()).toEqual([`${TURN}-thinking-0`, TURN]);
    });

    it('a connection cut mid-reasoning: the cursor replay fills the placed bubble in where it is, and adds nothing', () => {
      send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {} });
      send({ type: 'stream_start', messageId: `${TURN}-thinking-0`, thinking: true, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_a' } });
      send({ type: 'stream_delta', messageId: `${TURN}-thinking-0`, delta: 'reas', thinking: true });
      send({ type: 'history_replay_start', fullHistory: false });
      send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {}, timestamp: 20, historySeq: 1 });
      send(replayThinkingEntry({ historySeq: 2, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_a' } }));
      send({ type: 'history_replay_end' });
      expect(ids()).toEqual([`${TURN}-thinking-0`, 'toolu_a']);
      expect(store.getState().sessionStates.s1.messages[0]).toMatchObject({ content: 'reasoning', thinkingStreaming: false });
    });

    it('an entry without a hint is appended (history recorded before the hint existed)', () => {
      send({ type: 'history_replay_start', fullHistory: true });
      send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {}, timestamp: 20, historySeq: 1 });
      send(replayThinkingEntry({ historySeq: 2 }));
      send({ type: 'history_replay_end' });
      expect(ids()).toEqual(['toolu_a', `${TURN}-thinking-0`]);
    });
  });
});
