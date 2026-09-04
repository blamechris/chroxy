/**
 * #7603 — app dispatch wiring for the per-session container-lost state.
 *
 * store-core owns the PARSE (its handlers.test.ts pins it); this file pins the
 * app's WIRING at runtime, against the real reducer — the same claims the
 * dashboard's `dispatch-container-lost.test.ts` makes, so a divergence between
 * the two clients shows up as one of these going red.
 *
 * The `claude_ready` test is the load-bearing one. `stoppedAt` clears on
 * `claude_ready`, so copying that pattern here is the obvious move and it is
 * WRONG: ws-history's `sendSessionInfo` re-sends `claude_ready` on every
 * reconnect and session switch whenever `session.isReady`, and `isReady`
 * describes the child process, not the container. Clearing on it would drop the
 * banner while the container was still gone. It carries a positive CONTROL so
 * it cannot pass by the message never having been processed at all.
 */
import {
  _testMessageHandler,
  setStore,
  clearPermissionSplits,
  clearDeltaBuffers,
  resetReplayFlags,
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

/** The wire shape the server actually produces for a vanish. */
function vanishMessage(sessionId: string, code = 'CONTAINER_VANISHED', message?: string) {
  return {
    type: 'message',
    messageType: 'error',
    content: 'The container for this session is no longer running.',
    timestamp: 1,
    code,
    sessionId,
    ...(message ? { message } : {}),
  };
}

function arrange() {
  const store = createMockStore({
    activeSessionId: 's1',
    sessions: [
      { sessionId: 's1', name: 'S1' } as any,
      { sessionId: 's2', name: 'S2' } as any,
    ],
    sessionStates: {
      s1: createEmptySessionState(),
      s2: createEmptySessionState(),
    },
  });
  setStore(store as any);
  _testMessageHandler.setContext(createMockConnectionContext());
  return store;
}

describe('app dispatch — container-lost state (#7603)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearDeltaBuffers();
    clearPermissionSplits();
    resetReplayFlags();
  });

  it('arms containerLostAt on a live CONTAINER_VANISHED for the named session', () => {
    const store = arrange();
    const before = Date.now();
    _testMessageHandler.handle(vanishMessage('s2'));
    const after = Date.now();

    const ss = store.getState().sessionStates.s2;
    expect(typeof ss.containerLostAt).toBe('number');
    expect(ss.containerLostAt as number).toBeGreaterThanOrEqual(before);
    expect(ss.containerLostAt as number).toBeLessThanOrEqual(after);
    expect(ss.containerReattachError).toBeNull();
    // Applied to the session the message NAMES — the active session is untouched.
    expect(store.getState().sessionStates.s1.containerLostAt).toBeNull();
  });

  it('records the refusal detail on ENVIRONMENT_UNAVAILABLE', () => {
    const store = arrange();
    _testMessageHandler.handle(
      vanishMessage('s1', 'ENVIRONMENT_UNAVAILABLE', 'the environment now runs a different container'),
    );
    const ss = store.getState().sessionStates.s1;
    expect(typeof ss.containerLostAt).toBe('number');
    expect(ss.containerReattachError).toBe('the environment now runs a different container');
  });

  it('does NOT banner the ACTIVE session when the vanish names an unregistered session', () => {
    // The app's message-append falls back to the active session (`effectiveId`)
    // so a bubble is never dropped. The container-lost patch deliberately does
    // NOT take that fallback: `resolveSessionId` only falls back when the field
    // is EMPTY, so a message naming an id the client has never heard of resolves
    // to that foreign id, while `effectiveId` silently collapses to the active
    // session. Applying the patch through `effectiveId` would banner a session
    // whose container is perfectly healthy.
    //
    // This is the one regression the surrounding code comment claims to prevent
    // and nothing else here exercises — swapping `containerLost.sessionId` for
    // `effectiveId` leaves every other test in this file green.
    const store = arrange();
    _testMessageHandler.handle(vanishMessage('ghost-session-not-in-store'));

    // CONTROL: the bubble DID land on the active session, so the message really
    // was processed down the effectiveId fallback — the null below is the
    // patch's own targeting, not a dropped message.
    const active = store.getState().sessionStates.s1;
    expect(active.messages.some((m) => m.code === 'CONTAINER_VANISHED')).toBe(true);

    expect(active.containerLostAt).toBeNull();
    expect(active.containerReattachError).toBeNull();
    expect(store.getState().sessionStates.s2.containerLostAt).toBeNull();
  });

  it('leaves the state untouched for an ordinary error message', () => {
    const store = arrange();
    _testMessageHandler.handle({
      type: 'message',
      messageType: 'error',
      content: 'boom',
      timestamp: 1,
      sessionId: 's1',
    });
    expect(store.getState().sessionStates.s1.containerLostAt).toBeNull();
  });

  it('a completed turn (result) RELEASES the state', () => {
    const store = arrange();
    _testMessageHandler.handle(vanishMessage('s1'));
    expect(store.getState().sessionStates.s1.containerLostAt).not.toBeNull();

    _testMessageHandler.handle({ type: 'result', sessionId: 's1', cost: 0 });

    const ss = store.getState().sessionStates.s1;
    expect(ss.containerLostAt).toBeNull();
    expect(ss.containerReattachError).toBeNull();
  });

  it('claude_ready does NOT release the state (isReady is about the child, not the container)', () => {
    const store = arrange();
    _testMessageHandler.handle(vanishMessage('s1', 'ENVIRONMENT_UNAVAILABLE', 'rebuilt'));
    // Put the session into the stopped state too, so claude_ready has something
    // it IS expected to clear.
    _testMessageHandler.handle({ type: 'session_stopped', sessionId: 's1', code: 0 });
    expect(store.getState().sessionStates.s1.stoppedAt).not.toBeNull();

    _testMessageHandler.handle({ type: 'claude_ready', sessionId: 's1' });

    const ss = store.getState().sessionStates.s1;
    // CONTROL: claude_ready really was processed — it did the clearing it owns.
    // Without this the assertions below would hold for free if the message had
    // been dropped anywhere upstream.
    expect(ss.claudeReady).toBe(true);
    expect(ss.stoppedAt).toBeNull();
    // The actual claim.
    expect(typeof ss.containerLostAt).toBe('number');
    expect(ss.containerReattachError).toBe('rebuilt');
  });
});
