/**
 * Tests for the mobile `permission_input` feeder (#6543 PR-4, IDE P3 feature B).
 *
 * The dashboard shipped the editable pre-write-diff first: a permission prompt
 * pulls the FULL (secret-redacted) tool input via `get_permission_input`, and the
 * server replies with a single `permission_input` message that lands in
 * `permissionInputs[requestId]`. PR-4 brings the mobile app to parity — its
 * `handleMessage` switch gains a `case 'permission_input':` that mirrors the
 * dashboard handler exactly: Zod-validate → `set({ permissionInputs: { ...prev,
 * [requestId]: data } })`, dropping malformed messages.
 *
 * These tests exercise the production wire path: dispatch a message through
 * `_testMessageHandler.handle` and assert on the resulting `state.permissionInputs`
 * map — the same slice the mobile pre-write-diff UI reads. Mirrors the dashboard's
 * dispatch-permission-input.test.ts so both clients are behaviour-verified.
 */
import {
  _testMessageHandler,
  _testResetStore,
  setStore,
} from '../../store/message-handler';
import type { ConnectionState } from '../../store/types';

// Mock persistence so the handler's imports resolve without touching disk.
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

/** Minimal mock Zustand store seeding `permissionInputs` with an empty map. */
function createMockStore(initialInputs: Record<string, unknown> = {}) {
  let state = { permissionInputs: initialInputs } as unknown as ConnectionState;
  return {
    store: {
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
    },
    current: () => state,
  };
}

function createMockContext() {
  return {
    socket: { readyState: 1, send: jest.fn() } as any,
    serverUrl: 'wss://test.example.com',
    apiToken: 'test-token',
    connectionId: 'test-conn-1',
    reconnecting: false,
    connectedAt: Date.now(),
    isSessionSwitchReplay: false,
    activeSessionIdAtConnect: null,
    replayingSessions: new Set<string>(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// Clear BOTH the module-level store + context refs after each test so this suite
// can't leak state into other test files (order-dependent failures) — same
// hygiene as the #6247 activity feeder suite.
afterEach(() => {
  _testResetStore();
  _testMessageHandler.setContext(null as never);
});

describe('permission_input feeder (#6543 PR-4)', () => {
  it('stores a found:true permission_input keyed by requestId', () => {
    const { store, current } = createMockStore();
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_input',
      requestId: 'r1',
      found: true,
      tool: 'Write',
      input: { file_path: '/x', content: 'a\nb' },
    });

    const pulled = current().permissionInputs.r1 as Record<string, unknown>;
    expect(pulled).toBeDefined();
    expect(pulled.found).toBe(true);
    expect(pulled.tool).toBe('Write');
    expect(pulled.input).toEqual({ file_path: '/x', content: 'a\nb' });
  });

  it('stores a found:false permission_input (unavailable, carries error)', () => {
    const { store, current } = createMockStore();
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_input',
      requestId: 'r2',
      found: false,
      error: { code: 'NOT_PENDING', message: 'gone' },
    });

    const pulled = current().permissionInputs.r2 as Record<string, unknown>;
    expect(pulled).toBeDefined();
    expect(pulled.found).toBe(false);
    expect(pulled.error).toEqual({ code: 'NOT_PENDING', message: 'gone' });
  });

  it('does not clobber a prior entry for a different requestId', () => {
    const { store, current } = createMockStore();
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_input',
      requestId: 'r1',
      found: true,
      tool: 'Write',
      input: { file_path: '/a', content: 'first' },
    });
    _testMessageHandler.handle({
      type: 'permission_input',
      requestId: 'r2',
      found: true,
      tool: 'Edit',
      input: { file_path: '/b', old_string: 'x', new_string: 'y' },
    });

    expect(current().permissionInputs.r1).toBeDefined();
    expect(current().permissionInputs.r2).toBeDefined();
    expect((current().permissionInputs.r1 as Record<string, unknown>).tool).toBe('Write');
    expect((current().permissionInputs.r2 as Record<string, unknown>).tool).toBe('Edit');
  });

  it('drops a malformed permission_input (missing found) without throwing or mutating', () => {
    const seeded = {};
    const { store, current } = createMockStore(seeded);
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() =>
      _testMessageHandler.handle({ type: 'permission_input', requestId: 'r3' }),
    ).not.toThrow();

    // No-op: the seeded map reference is untouched (parse failed before any set).
    expect(current().permissionInputs).toBe(seeded);
    expect(current().permissionInputs.r3).toBeUndefined();
  });
});
