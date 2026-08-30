/**
 * Mobile `isBusy → isIdle` resync (#7518, the client half of #7507).
 *
 * THE FALSE NEGATIVE THIS PINS
 * ----------------------------
 * The dashboard has re-derived `sessionStates[id].isIdle` from the server's
 * authoritative `isBusy` since #4639 — on `session_list` (seed + resync) and on
 * `session_activity`. The mobile app had NEITHER: its only `isIdle` writers were
 * `agent_busy` / `agent_idle`, so the ONLY thing that could clear a stale
 * "Running Bash …" chip was an `agent_idle` — including the synthesized one at
 * the end of a JSONL full-history replay (#7484 / PR #7479's N2).
 *
 * That synthesis is suppressed while `sessionManager.isSessionBusy()` reports the
 * session live, and "live" is `entry.session.isRunning` = `_isBusy ||
 * _backgroundShellTracker.size > 0`. A session whose turn has ENDED but which
 * still holds an un-polled `Bash(run_in_background: true)` shell therefore reads
 * busy, the heal is suppressed, and on mobile the chip stayed until the shell was
 * polled, the session was destroyed, or the 4h hard quiesce reaped it
 * (`backgroundShellHardQuiesceMs: 0` makes that never).
 *
 * On the dashboard the same suppression is CORRECT — `session_list` /
 * `session_activity` publish the same `isRunning` as `isBusy`, so a narrower heal
 * would be a flicker, not a heal. Giving the app the same two resync paths makes
 * the server-side guard right on BOTH clients (the AC of #7518), which is why the
 * server's `isRunning` guard is left untouched.
 *
 * WHAT EACH TEST IS FOR
 * ---------------------
 *  - "stale chip heals" — the red-first repro: a session sitting at
 *    `isIdle: false` with an unresolved tool_use in `messages[]` (exactly what
 *    ActivityIndicator walks to render the chip) is corrected by a snapshot /
 *    ping that says `isBusy: false`.
 *  - "genuinely busy stays busy" — the POSITIVE CONTROL. It fails if the resync
 *    is inverted (`desiredIsIdle = isBusy`), which is the mutation that would
 *    make a real turn look finished.
 *  - "writes only isIdle" — scope. #7500's replay synthesis and #7508's pending
 *    question resend own `activeTools` / prompt state; this resync must not.
 *    `agent_idle` clears `activeTools` + `streamingMessageId`; the #4639 resync
 *    deliberately does NOT (it is a snapshot reconciliation, not a turn
 *    boundary).
 */
import {
  _testMessageHandler,
  setStore,
  _testResetStore,
  resetAllHandlerState,
} from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import { createEmptySessionState } from '../../store/utils';
import type { ChatMessage } from '@chroxy/store-core';
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

/**
 * The transcript shape ActivityIndicator's `inFlight` walk reads: a `tool_call`
 * message with no `toolResult` attached is what renders "Running Bash · 12s".
 * The chip is gated on `!isIdle`, so healing `isIdle` is what clears it — the
 * transcript itself is left alone on purpose.
 */
const UNRESOLVED_TOOL: ChatMessage = {
  id: 'm-tool-1',
  type: 'tool_call',
  content: 'Bash',
  timestamp: 1_800_000_000_000,
  tool: 'Bash',
  toolUseId: 'tu-1',
  toolInput: { command: 'npm test &', run_in_background: true },
} as unknown as ChatMessage;

/** A session stuck busy with a phantom in-flight tool — the #7518 symptom. */
function staleBusySession() {
  return {
    ...createEmptySessionState(),
    isIdle: false,
    messages: [UNRESOLVED_TOOL],
    activeTools: [{ toolUseId: 'tu-1', tool: 'Bash', startedAt: 1_800_000_000_000 }],
    streamingMessageId: 'm-stream-1',
  };
}

function seed(sessionStates: Record<string, unknown>, activeSessionId: string | null = 's1') {
  const store = createMockStore({
    activeSessionId,
    sessions: [],
    sessionStates: sessionStates as ConnectionState['sessionStates'],
  });
  setStore(store as never);
  _testMessageHandler.setContext(createMockConnectionContext());
  return store;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAllHandlerState();
});

afterEach(() => {
  _testResetStore();
});

describe('#7518 — session_list resyncs isIdle from the server isBusy', () => {
  it('heals a stale busy session when the snapshot reports isBusy: false', () => {
    const store = seed({ s1: staleBusySession() });

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1', isBusy: false }],
    });

    expect(store.getState().sessionStates.s1.isIdle).toBe(true);
  });

  it('POSITIVE CONTROL — a genuinely busy session stays busy through a session_list', () => {
    const store = seed({ s1: { ...createEmptySessionState(), isIdle: false } });

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1', isBusy: true }],
    });

    expect(store.getState().sessionStates.s1.isIdle).toBe(false);
  });

  it('corrects a locally-idle session the server still reports busy', () => {
    const store = seed({ s1: { ...createEmptySessionState(), isIdle: true } });

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1', isBusy: true }],
    });

    expect(store.getState().sessionStates.s1.isIdle).toBe(false);
  });

  it('seeds isIdle from isBusy for a brand-new session entry', () => {
    const store = seed({}, null);

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1', isBusy: true }],
    });

    const ss = store.getState().sessionStates.s1;
    expect(ss).toBeDefined();
    expect(ss.isIdle).toBe(false);
  });

  it('a brand-new busy entry lands with a CONSISTENT derived activityState', () => {
    // The app derives `activityState` inside `updateSession` (the dashboard has
    // no such field). Writing `isIdle` straight into the fresh shell — the way
    // the dashboard seeds it — bypasses that derivation, and the resync that
    // follows then short-circuits (`ss.isIdle === desired` → `{}`), so the
    // session reads busy while its chat lozenge says idle. Found by mutating the
    // seed away and watching nothing go red.
    const store = seed({}, null);

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1', isBusy: true }],
    });

    const ss = store.getState().sessionStates.s1;
    expect(ss.isIdle).toBe(false);
    expect(ss.activityState.state).toBe('busy');
  });

  it('seeds isIdle: true for a brand-new idle session entry', () => {
    const store = seed({}, null);

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1', isBusy: false }],
    });

    expect(store.getState().sessionStates.s1.isIdle).toBe(true);
  });

  it('leaves isIdle alone when the snapshot omits isBusy (older server)', () => {
    const store = seed({ s1: { ...createEmptySessionState(), isIdle: false } });

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1' }],
    });

    expect(store.getState().sessionStates.s1.isIdle).toBe(false);
  });

  it('leaves isIdle alone when isBusy is a non-boolean — BOTH truthy and falsy', () => {
    // Both arms, because a `!isBusy` coercion is only visible from the side
    // whose inversion DIFFERS from the seeded value. Seeded-busy + `'yes'` was
    // the original single arm and it passed under a coercing mutant
    // (`!'yes'` === false === the seed) — a vacuous pass.
    const truthy = seed({ s1: { ...createEmptySessionState(), isIdle: true } });
    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1', isBusy: 'yes' }],
    });
    expect(truthy.getState().sessionStates.s1.isIdle).toBe(true);

    const falsy = seed({ s1: { ...createEmptySessionState(), isIdle: false } });
    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1', isBusy: null }],
    });
    expect(falsy.getState().sessionStates.s1.isIdle).toBe(false);
  });

  it('SCOPE — the resync writes isIdle only, never the turn-boundary fields', () => {
    const store = seed({ s1: staleBusySession() });

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1', isBusy: false }],
    });

    const ss = store.getState().sessionStates.s1;
    expect(ss.isIdle).toBe(true);
    // agent_idle clears these; the #4639 snapshot resync must not — #7500's
    // replay synthesis and #7508's prompt resend own them.
    expect(ss.activeTools).toHaveLength(1);
    expect(ss.streamingMessageId).toBe('m-stream-1');
    expect(ss.messages).toHaveLength(1);
  });
});

describe('#7518 — session_activity resyncs isIdle from the server isBusy', () => {
  it('heals a stale busy session when the ping reports isBusy: false', () => {
    const store = seed({ s1: staleBusySession() });

    _testMessageHandler.handle({ type: 'session_activity', sessionId: 's1', isBusy: false });

    expect(store.getState().sessionStates.s1.isIdle).toBe(true);
  });

  it('POSITIVE CONTROL — a genuinely busy session stays busy through a session_activity', () => {
    const store = seed({ s1: { ...createEmptySessionState(), isIdle: false } });

    _testMessageHandler.handle({ type: 'session_activity', sessionId: 's1', isBusy: true });

    expect(store.getState().sessionStates.s1.isIdle).toBe(false);
  });

  it('flips a locally-idle non-active session busy (peer-driven turn)', () => {
    const store = seed(
      {
        s1: { ...createEmptySessionState(), isIdle: true },
        s2: { ...createEmptySessionState(), isIdle: true },
      },
      's1',
    );

    _testMessageHandler.handle({ type: 'session_activity', sessionId: 's2', isBusy: true });

    expect(store.getState().sessionStates.s2.isIdle).toBe(false);
    expect(store.getState().sessionStates.s1.isIdle).toBe(true);
  });

  it('is a no-op for an unknown session — session_list owns seeding', () => {
    const store = seed({ s1: { ...createEmptySessionState(), isIdle: true } });

    _testMessageHandler.handle({ type: 'session_activity', sessionId: 'nope', isBusy: true });

    expect(store.getState().sessionStates.nope).toBeUndefined();
    expect(store.getState().sessionStates.s1.isIdle).toBe(true);
  });

  it('does NOT fall back to the active session when sessionId is absent', () => {
    const store = seed({ s1: { ...createEmptySessionState(), isIdle: true } });

    _testMessageHandler.handle({ type: 'session_activity', isBusy: true });

    expect(store.getState().sessionStates.s1.isIdle).toBe(true);
  });

  it('is a no-op when isBusy is missing or a non-boolean — BOTH truthy and falsy', () => {
    const busy = seed({ s1: { ...createEmptySessionState(), isIdle: false } });
    _testMessageHandler.handle({ type: 'session_activity', sessionId: 's1' });
    expect(busy.getState().sessionStates.s1.isIdle).toBe(false);
    // `!null` is true — a coercing handler would "heal" this session on a
    // malformed frame.
    _testMessageHandler.handle({ type: 'session_activity', sessionId: 's1', isBusy: null });
    expect(busy.getState().sessionStates.s1.isIdle).toBe(false);

    const idle = seed({ s1: { ...createEmptySessionState(), isIdle: true } });
    // `!'no'` is false — a coercing handler would mark this session busy.
    _testMessageHandler.handle({ type: 'session_activity', sessionId: 's1', isBusy: 'no' });
    expect(idle.getState().sessionStates.s1.isIdle).toBe(true);
  });

  it('SCOPE — the ping writes isIdle only, never the turn-boundary fields', () => {
    const store = seed({ s1: staleBusySession() });

    _testMessageHandler.handle({ type: 'session_activity', sessionId: 's1', isBusy: false });

    const ss = store.getState().sessionStates.s1;
    expect(ss.isIdle).toBe(true);
    expect(ss.activeTools).toHaveLength(1);
    expect(ss.streamingMessageId).toBe('m-stream-1');
    expect(ss.messages).toHaveLength(1);
  });
});
