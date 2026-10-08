/**
 * #6630 -- live vs replayed transcript, through the REAL mobile-app handler.
 *
 * The shared fixtures (`@chroxy/store-core` REPLAY_PARITY_FIXTURES) hold, per
 * scenario, the frames the server sends live and the frames a full-rebuild replay
 * (session switch, reload) delivers for the SAME session events -- both produced
 * by the real server code (packages/server/tests/replay-parity-wire.test.js keeps
 * them honest). This feeds each set to the app's real `handleMessage` and compares
 * the transcripts that result. The dashboard runs the same fixtures through its
 * own handler (packages/dashboard/src/store/replay-parity.test.ts).
 *
 * A scenario in REPLAY_PARITY_DIVERGENCES is a known, tracked gap and is pinned on
 * both sides; every other scenario must come out EQUAL.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports (mirrors message-handler.test.ts)
// ---------------------------------------------------------------------------

jest.mock('../src/utils/crypto', () => ({
  // #6344: key_exchange_ok's prelude (encryption auth_ok) stashes _pendingKeyPair =
  // createKeyPair() and reads .publicKey — return a stub so it's non-falsy (mirrors
  // the dashboard crypto mock).
  createKeyPair: jest.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  generateConnectionSalt: jest.fn(() => 'mock-salt'),
  deriveConnectionKey: jest.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}));

jest.mock('../src/notifications', () => ({
  registerForPushNotifications: jest.fn(),
}));

jest.mock('../src/utils/haptics', () => ({
  hapticSuccess: jest.fn(),
}));

jest.mock('../src/store/persistence', () => ({
  clearPersistedSession: jest.fn(),
  // #6325: session_list persists the active conversation id as a side effect.
  persistLastConversationId: jest.fn(),
}));

jest.mock('../src/store/imperative-callbacks', () => ({
  getCallback: jest.fn(() => undefined),
}));

jest.mock('../src/store/multi-client', () => ({
  // #6325: client_joined calls addClient on the roster store.
  useMultiClientStore: { getState: jest.fn(() => ({ setClients: jest.fn(), addClient: jest.fn(), removeClient: jest.fn(), setMyClientId: jest.fn(), setConnectedClients: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/web', () => ({
  useWebStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/cost', () => ({
  useCostStore: { getState: jest.fn(() => ({ handleCostUpdate: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/terminal', () => ({
  useTerminalStore: { getState: jest.fn(() => ({ appendTerminalData: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/notifications', () => ({
  // #6325: permission_timeout/server_error/session_warning reach for more of the
  // notification store than addNotification — seed the full surface so they
  // exercise their real switch path instead of throwing on an undefined method.
  useNotificationStore: {
    getState: jest.fn(() => ({
      addNotification: jest.fn(),
      dismissNotification: jest.fn(),
      sessionNotifications: [],
      addSessionNotification: jest.fn(),
      dismissSessionNotification: jest.fn(),
      setTimeoutWarning: jest.fn(),
      addServerError: jest.fn(),
      setShutdown: jest.fn(),
    })),
    setState: jest.fn(),
  },
}));

jest.mock('../src/store/conversations', () => ({
  // #6325: conversations_list/search_results mirror into the conversation store.
  useConversationStore: {
    getState: jest.fn(() => ({ setConversationHistory: jest.fn(), setSearchResults: jest.fn() })),
    setState: jest.fn(),
  },
}));

jest.mock('../src/store/connection-lifecycle', () => ({
  // #6325: server_mode/auth_ok/auth_fail/pair_fail route connection state into
  // the lifecycle store — provide the full setter surface they reach for.
  useConnectionLifecycleStore: {
    getState: jest.fn(() => ({
      setServerInfo: jest.fn(),
      setConnectionPhase: jest.fn(),
      setConnectionDetails: jest.fn(),
      setActivePath: jest.fn(),
      setConnectionError: jest.fn(),
      setUserDisconnected: jest.fn(),
      setSavedConnection: jest.fn(),
      savedConnection: null,
    })),
    setState: jest.fn(),
  },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@chroxy/store-core', () => ({
  ...jest.requireActual('../../store-core/src/index'),
  parseUserInputMessage: jest.fn((text: string) => ({ type: 'text', content: text })),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  handleMessage,
  setStore,
  setConnectionContext,
  clearDeltaBuffers,
  clearPermissionSplits,
  resetReplayFlags,
} from '../src/store/message-handler';
import { createEmptySessionState } from '../src/store/utils';
import type { ConnectionState, SessionState } from '../src/store/types';
import {
  REPLAY_PARITY_FIXTURES,
  REPLAY_PARITY_DIVERGENCES,
  REPLAY_PARITY_SESSION_ID as SID,
  CURSOR_REPLAY_SCENARIOS,
  replayParityModel,
  type ReplayParityFrame,
} from '@chroxy/store-core';

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState;
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s;
      state = { ...state, ...patch };
    },
  };
}

const mockCtx = {
  url: 'wss://test.example.com',
  token: 'test-token',
  socket: { close: jest.fn(), send: jest.fn() } as unknown as WebSocket,
  isReconnect: false,
  silent: false,
};

function freshStore() {
  const store = createMockStore({
    activeSessionId: SID,
    sessions: [],
    availableProviders: [],
    sessionStates: { [SID]: createEmptySessionState() as SessionState },
    messages: [],
    addMessage: jest.fn(),
    appendTerminalData: jest.fn(),
    addInfoNotification: jest.fn(),
    connectedClients: [],
    activity: { bySession: {} },
    serverErrors: [],
    sessionNotifications: [],
    webTasks: [],
    fetchSlashCommands: jest.fn(),
    fetchCustomAgents: jest.fn(),
  } as unknown as ConnectionState);
  setStore(store);
  setConnectionContext(mockCtx as never);
  return store;
}

const messagesOf = (store: ReturnType<typeof createMockStore>) =>
  (store.getState() as unknown as { sessionStates: Record<string, SessionState> }).sessionStates[SID].messages;

/** The frames as a connected client receives them while the turn happens. */
function runLive(frames: ReplayParityFrame[]) {
  const store = freshStore();
  for (const frame of frames) handleMessage({ ...frame });
  jest.runAllTimers(); // stream deltas buffer behind a flush timer
  return replayParityModel(messagesOf(store));
}

/** The frames a session switch / reload delivers: a full rebuild of the transcript. */
function runReplay(frames: ReplayParityFrame[]) {
  const store = freshStore();
  const latestSeq = frames.reduce((max, f) => Math.max(max, typeof f.historySeq === 'number' ? f.historySeq : 0), 0);
  handleMessage({ type: 'history_replay_start', sessionId: SID, fullHistory: true, truncated: false, latestSeq });
  for (const frame of frames) handleMessage({ ...frame });
  handleMessage({ type: 'history_replay_end', sessionId: SID, latestSeq });
  jest.runAllTimers();
  return replayParityModel(messagesOf(store));
}

/**
 * A client that watched the turn LIVE and then reconnects with a cursor: the
 * server replays the entries after the cursor (`fullHistory: false`), which are
 * all the entries of this turn, and the client must dedup them against the
 * messages it already holds -- no duplicate bubble, nothing lost.
 */
function runLiveThenCursorReplay(live: ReplayParityFrame[], replay: ReplayParityFrame[]) {
  const store = freshStore();
  for (const frame of live) handleMessage({ ...frame });
  jest.runAllTimers();
  const latestSeq = replay.reduce((max, f) => Math.max(max, typeof f.historySeq === 'number' ? f.historySeq : 0), 0);
  handleMessage({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq });
  for (const frame of replay) handleMessage({ ...frame });
  handleMessage({ type: 'history_replay_end', sessionId: SID, latestSeq });
  jest.runAllTimers();
  return replayParityModel(messagesOf(store));
}

/** Like {@link runLiveThenCursorReplay}, but also reports the streaming marker (#8444). */
function runCutThenCursorReplay(live: ReplayParityFrame[], replay: ReplayParityFrame[]) {
  const store = freshStore();
  clearPermissionSplits(); // a cut run never reaches the `result` that clears the id remaps
  for (const frame of live) handleMessage({ ...frame });
  jest.runAllTimers();
  const sessionOf = () => (store.getState() as unknown as { sessionStates: Record<string, SessionState> }).sessionStates[SID];
  const heldStreaming = sessionOf().streamingMessageId;
  const latestSeq = replay.reduce((max, f) => Math.max(max, typeof f.historySeq === 'number' ? f.historySeq : 0), 0);
  handleMessage({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq });
  for (const frame of replay) handleMessage({ ...frame });
  handleMessage({ type: 'history_replay_end', sessionId: SID, latestSeq });
  jest.runAllTimers();
  const { messages, streamingMessageId } = sessionOf();
  return { model: replayParityModel(messages), messages, heldStreaming, streamingMessageId };
}

const isResponseEnd = (f: ReplayParityFrame) => f.type === 'stream_end' && f.thinking !== true;
const replyText = (model: ReturnType<typeof replayParityModel>) =>
  model.filter((r) => r.type === 'response').map((r) => r.content).join('');
/** Tool cards reduced to id and type (see the note on the reply-cut suite). */
const shape = (model: ReturnType<typeof replayParityModel>) =>
  model.map((r) => (r.type === 'tool_use' ? { id: r.id, type: r.type } : r));

describe('live vs replayed transcript -- app (#6630)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearDeltaBuffers();
    resetReplayFlags();
  });

  afterEach(() => {
    clearDeltaBuffers();
    jest.runAllTimers();
    jest.useRealTimers();
    setConnectionContext(null);
  });

  it('has fixtures, and every pinned divergence names a scenario that exists', () => {
    expect(REPLAY_PARITY_FIXTURES.length).toBeGreaterThanOrEqual(8);
    const names = new Set(REPLAY_PARITY_FIXTURES.map((f) => f.name));
    for (const name of Object.keys(REPLAY_PARITY_DIVERGENCES)) {
      expect(names.has(name)).toBe(true);
    }
  });

  for (const fx of REPLAY_PARITY_FIXTURES) {
    it(`${fx.name}: ${fx.description}`, () => {
      const live = runLive(fx.live);
      clearDeltaBuffers();
      resetReplayFlags();
      const replay = runReplay(fx.replay);
      // A transcript that is empty on both sides is equal for the wrong reason.
      expect(live.length).toBeGreaterThan(0);
      expect(replay.length).toBeGreaterThan(0);

      const divergence = REPLAY_PARITY_DIVERGENCES[fx.name];
      if (!divergence) {
        expect(replay).toEqual(live);
        return;
      }
      expect(live).toEqual(divergence.live);
      expect(replay).toEqual(divergence.replay);
      // The gap must still be a gap: when it closes, delete the entry.
      expect(replay).not.toEqual(live);
    });
  }
  // The permission scenarios are excluded: the live card is a pending prompt the
  // replay resolves in place (store-core's reconcileHeldPermissionCard, covered
  // by message-handler-permission-outcome.test.ts), which is not the dedup this checks.
  for (const fx of REPLAY_PARITY_FIXTURES.filter((f) => !f.name.startsWith('permission-'))) {
    it(`${fx.name}: a cursor replay onto the live transcript adds nothing and loses nothing`, () => {
      const liveOnly = runLive(fx.live);
      clearDeltaBuffers();
      resetReplayFlags();
      const after = runLiveThenCursorReplay(fx.live, fx.replay);
      expect(liveOnly.length).toBeGreaterThan(0);
      expect(after).toEqual(liveOnly);
    });
  }
  // A connection that drops MID-reasoning: the client holds a partial thinking
  // bubble, the server finishes the thought, and the cursor replay carries the full
  // text and duration. The held copy must be filled in (the cursor moves past the
  // entry, so nothing would ever retry), not discarded as a duplicate.
  const interruptible = REPLAY_PARITY_FIXTURES.filter((fx) =>
    fx.live.some((f) => f.type === 'stream_end' && f.thinking === true),
  );

  it('has scenarios to interrupt', () => {
    expect(interruptible.map((f) => f.name)).toEqual(expect.arrayContaining(['thinking-then-reply', 'thinking-without-text']));
  });

  for (const fx of interruptible) {
    const endIdx = fx.live.findIndex((f) => f.type === 'stream_end' && f.thinking === true);
    for (let cut = 1; cut <= endIdx; cut++) {
      it(`${fx.name}: delivery cut after live frame ${cut} of ${endIdx} is completed by the cursor replay`, () => {
        const full = runLive(fx.live);
        clearDeltaBuffers();
        resetReplayFlags();
        const after = runLiveThenCursorReplay(fx.live.slice(0, cut), fx.replay);
        expect(after).toEqual(full);
      });
    }
  }

  // #8444: the same drop MID-REPLY. The client holds the start of a response as one
  // bubble (or, after a tool, several), the server finishes the turn and records ONE
  // response entry under the stream id, and the cursor replay delivers it. Dedup by id
  // used to drop it, leaving the partial reply for good. Cutting after every frame up
  // to the reply's stream_end covers every point inside it.
  //
  // Wherever the cut falls the whole reply must show exactly once and no bubble id may
  // repeat. The transcript must also equal the one a connected client has, except for
  // a reply a tool splits in two when the client had not yet seen all the tools: the
  // history keeps one entry per stream and no boundary inside it (#8438), so the replay
  // cannot say where those tools fell in the text.
  const replyScenarios: Array<{ name: string; live: ReplayParityFrame[]; replay: ReplayParityFrame[] }> = [
    ...REPLAY_PARITY_FIXTURES.filter((f) => !f.name.startsWith('permission-')),
    ...CURSOR_REPLAY_SCENARIOS,
  ].filter((f) => f.live.some(isResponseEnd));

  it('has reply scenarios to interrupt', () => {
    expect(replyScenarios.map((f) => f.name)).toEqual(
      expect.arrayContaining(['plain-reply', 'text-around-a-tool', 'tools-then-summary-tui', 'long-reply', 'two-tool-rounds']),
    );
  });

  for (const fx of replyScenarios) {
    const endIdx = fx.live.findIndex(isResponseEnd);
    for (let cut = 1; cut <= endIdx; cut++) {
      it(`${fx.name}: delivery cut after live frame ${cut} of ${endIdx} ends with the transcript a connected client has`, () => {
        const full = runLive(fx.live);
        clearDeltaBuffers();
        resetReplayFlags();
        clearPermissionSplits();
        const atCut = runLive(fx.live.slice(0, cut));
        const { model, messages } = runCutThenCursorReplay(fx.live.slice(0, cut), fx.replay);
        expect(replyText(model)).toBe(replyText(full));
        expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
        const tools = (rows: typeof full) => rows.filter((r) => r.type === 'tool_use').length;
        const splitByATool = full.filter((r) => r.type === 'response').length > 1;
        if (!splitByATool || tools(atCut) === tools(full)) expect(shape(model)).toEqual(shape(full));
      });
    }
  }

  it('a reply completed by the cursor replay no longer reads as streaming', () => {
    const sc = CURSOR_REPLAY_SCENARIOS.find((s) => s.name === 'long-reply')!;
    const cut = sc.live.findIndex((f) => f.type === 'stream_delta') + 2;
    // Only the reply entry replays: the frames after it (result, idle) settle the
    // session on their own and would hide a marker the completion left behind.
    const out = runCutThenCursorReplay(sc.live.slice(0, cut), sc.replay.filter((f) => f.type === 'message'));
    expect(out.heldStreaming).toBe('m1');
    expect(replyText(out.model)).toBe('The build passed on every platform, so it can ship.');
    expect(out.streamingMessageId).toBeNull();
  });
});
