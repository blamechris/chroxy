/**
 * #7807 — `thinking_level_changed` reaches the mobile app store.
 *
 * THE GAP THIS PINS
 * ------------------
 * `packages/app/src/store/message-handler.ts` imported the shared store-core
 * parser (`handleThinkingLevelChanged as sharedThinkingLevelChanged`) but never
 * called it anywhere — no `case`, no dispatch-table entry, no store field. The
 * server's `thinking_level_changed` broadcast (ws-history.js's reconnect / tab
 * -switch replay, settings-handlers.js after an accepted `set_thinking_level`,
 * event-normalizer.js's `ready` burst for the level a fresh codex session
 * booted at) was therefore silently dropped by the mobile app; only the
 * dashboard reflected a server-side level change
 * (dashboard message-handler.ts:4233, pre-migration).
 *
 * THE FIX
 * -------
 * `thinking_level_changed` is now a shared store-core dispatch-table entry
 * (`handleThinkingLevelChangedPatch`, mirroring `model_changed`'s
 * `sessionPatchDispatcher(handleModelChangedPatch)`), so both clients pick it
 * up via `runDispatch` before their own switch/HANDLERS map — replacing the
 * dashboard's former dashboard-local handler. The app gained a `thinkingLevel`
 * field on `SessionState` for the patch to land in.
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

describe('#7807 — thinking_level_changed reaches the app store', () => {
  it('sets the TARGETED session thinkingLevel from an explicit sessionId, not the active one', () => {
    const store = seed(
      {
        s1: { ...createEmptySessionState(), thinkingLevel: 'default' },
        s2: { ...createEmptySessionState(), thinkingLevel: 'default' },
      },
      's1',
    );

    _testMessageHandler.handle({ type: 'thinking_level_changed', sessionId: 's2', level: 'xhigh' });

    expect(store.getState().sessionStates.s2.thinkingLevel).toBe('xhigh');
    // Discriminating assertion: a handler that always wrote the ACTIVE session
    // (s1) instead of the targeted one (s2) would pass a single-session test.
    expect(store.getState().sessionStates.s1.thinkingLevel).toBe('default');
  });

  it('falls back to the active session when sessionId is absent', () => {
    const store = seed({ s1: { ...createEmptySessionState(), thinkingLevel: 'default' } }, 's1');

    _testMessageHandler.handle({ type: 'thinking_level_changed', level: 'high' });

    expect(store.getState().sessionStates.s1.thinkingLevel).toBe('high');
  });

  it('is a no-op for an unknown session', () => {
    const store = seed({ s1: { ...createEmptySessionState(), thinkingLevel: 'default' } }, 's1');

    _testMessageHandler.handle({ type: 'thinking_level_changed', sessionId: 'nope', level: 'xhigh' });

    expect(store.getState().sessionStates.nope).toBeUndefined();
    expect(store.getState().sessionStates.s1.thinkingLevel).toBe('default');
  });

  it('KEEPS a level this client has never heard of (codex efforts, not just the legacy Claude triple)', () => {
    const store = seed({ s1: { ...createEmptySessionState(), thinkingLevel: 'default' } }, 's1');

    _testMessageHandler.handle({ type: 'thinking_level_changed', sessionId: 's1', level: 'turbo' });

    expect(store.getState().sessionStates.s1.thinkingLevel).toBe('turbo');
  });

  it('falls back to the legacy default for a malformed level', () => {
    const store = seed({ s1: { ...createEmptySessionState(), thinkingLevel: 'high' } }, 's1');

    _testMessageHandler.handle({ type: 'thinking_level_changed', sessionId: 's1', level: '../../etc' });

    expect(store.getState().sessionStates.s1.thinkingLevel).toBe('default');
  });
});
