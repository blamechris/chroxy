/**
 * #7326 -- a turn that was cut off, refused or stopped leaves a marker in the
 * mobile transcript, and the marker survives a session switch / reload.
 *
 * Driven through the app's real `handleMessage` with the SAME wire frames the
 * server produces (the replay-parity `turn-outcomes` scenario, whose frames the
 * server's own wire test regenerates from the real normalizer and history ring),
 * so a client reading the wrong field, or a server dropping the outcome before
 * it reaches history, fails here.
 */
import {
  _testMessageHandler,
  setStore,
  _testResetStore,
  resetReplayFlags,
} from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import { createEmptySessionState } from '../../store/utils';
import {
  REPLAY_PARITY_FIXTURES,
  REPLAY_PARITY_SESSION_ID as SID,
  resetReplayReconcile,
  type ReplayParityFrame,
} from '@chroxy/store-core';
import type { ChatMessage, ConnectionState } from '../../store/types';

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
    setState: (updater: Partial<ConnectionState> | ((s: ConnectionState) => Partial<ConnectionState>)) => {
      state = { ...state, ...(typeof updater === 'function' ? updater(state) : updater) };
    },
    subscribe: () => () => {},
    destroy: () => {},
  };
}

function boot(messages: ChatMessage[] = []) {
  const store = createMockStore({
    activeSessionId: SID,
    sessions: [{ sessionId: SID, name: 'S1' } as any],
    sessionStates: { [SID]: { ...createEmptySessionState(), messages } },
    sessionNotifications: [],
    serverErrors: [],
  } as Partial<ConnectionState>);
  setStore(store as any);
  _testMessageHandler.setContext(createMockConnectionContext());
  const read = () => store.getState().sessionStates[SID]!.messages;
  return { read, send: (m: ReplayParityFrame) => _testMessageHandler.handle({ ...m }) };
}

const fixture = REPLAY_PARITY_FIXTURES.find((f) => f.name === 'turn-outcomes')!;
const markers = (messages: ChatMessage[]) =>
  messages.filter((m) => m.type === 'system' && m.turnOutcome !== undefined);

function replayAll(send: (m: ReplayParityFrame) => void, frames: ReplayParityFrame[], fullHistory: boolean) {
  const latestSeq = frames.reduce((max, f) => Math.max(max, typeof f.historySeq === 'number' ? f.historySeq : 0), 0);
  send({ type: 'history_replay_start', sessionId: SID, fullHistory, truncated: false, latestSeq });
  for (const f of frames) send(f);
  send({ type: 'history_replay_end', sessionId: SID, latestSeq });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetReplayReconcile({ clearCursors: true });
});
afterEach(() => {
  resetReplayFlags();
  _testResetStore();
  _testMessageHandler.setContext(null as never);
});

describe('turn outcome on the mobile app (#7326)', () => {
  it('has the scenario it drives', () => {
    expect(fixture).toBeDefined();
    expect(fixture.live.filter((f) => f.type === 'result').map((f) => f.turnOutcome)).toEqual([
      'truncated', 'refused', 'stopped', 'completed',
    ]);
  });

  it('a live truncated / refused / stopped turn each leaves a labelled marker; a completed turn leaves none', () => {
    const { read, send } = boot();
    for (const f of fixture.live) send(f);
    const found = markers(read());
    expect(found.map((m) => [m.turnOutcome, m.content])).toEqual([
      ['truncated', 'Reply cut off'],
      ['refused', 'The model declined'],
      ['stopped', 'Stopped'],
    ]);
    // The completed turn is the last reply, with nothing after it.
    const all = read();
    expect(all[all.length - 1]).toMatchObject({ type: 'response', content: 'A normal, finished reply.' });
  });

  it('a refusal with no reply text still gets its marker', () => {
    const { read, send } = boot();
    send(fixture.live.find((f) => f.type === 'result' && f.turnOutcome === 'refused')!);
    expect(markers(read()).map((m) => m.turnOutcome)).toEqual(['refused']);
  });

  it('survives a session switch: a full-rebuild replay builds the same markers from history', () => {
    const { read, send } = boot([{ id: 'stale', type: 'response', content: 'old', timestamp: 1 } as ChatMessage]);
    replayAll(send, fixture.replay, true);
    expect(markers(read()).map((m) => m.turnOutcome)).toEqual(['truncated', 'refused', 'stopped']);
    expect(read().some((m) => m.id === 'stale')).toBe(false);
  });

  it('a reconnect that replays turns the client already watched live adds no second marker', () => {
    const { read, send } = boot();
    for (const f of fixture.live) send(f);
    const before = read().length;
    replayAll(send, fixture.replay, false);
    expect(markers(read()).map((m) => m.turnOutcome)).toEqual(['truncated', 'refused', 'stopped']);
    expect(read().length).toBe(before);
  });

  it('an older server (no outcome on the frame) leaves the transcript exactly as it was', () => {
    const { read, send } = boot();
    send({ type: 'result', sessionId: SID, cost: 0.01, duration: 10 });
    expect(markers(read())).toHaveLength(0);
  });
});
