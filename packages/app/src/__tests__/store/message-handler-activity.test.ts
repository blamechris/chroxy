/**
 * Tests for the mobile Control Room activity feeder (#6246).
 *
 * #6245 (PR1) added `activity: ActivityState` to the app ConnectionState and a
 * read-only MissionControlScreen, but nothing dispatched `activity_snapshot` /
 * `activity_delta` into the store, so the view always showed its empty state.
 * #6246 wires those two message types into handleMessage's switch (mirroring the
 * dashboard feeder): parse with the protocol Zod schema → reduce via store-core
 * (`applyActivitySnapshot` REPLACE / `applyActivityDelta` upsert-by-id) → set,
 * with a `next === prev` no-op short-circuit to skip needless re-renders.
 *
 * These tests exercise the production wire path: dispatch a message through
 * `_testMessageHandler.handle` and assert on the resulting `state.activity` tree
 * (keyed `bySession[sessionId].byId[entryId]`), exactly the shape the
 * MissionControlScreen's `selectCrossSessionActivity` reads.
 */
import {
  _testMessageHandler,
  _testResetStore,
  setStore,
} from '../../store/message-handler';
import { createEmptyActivityState } from '@chroxy/store-core';
import type { ActivityEntry, ActivityState } from '@chroxy/store-core';
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

const T0 = 1_800_000_000_000;

/** Build a wire-valid ActivityEntry, defaulting the schema-required fields. */
function entry(over: Partial<ActivityEntry> & Pick<ActivityEntry, 'id'>): ActivityEntry {
  const status = over.status ?? 'running';
  const terminal = status === 'done' || status === 'failed';
  return {
    id: over.id,
    kind: over.kind ?? 'tool',
    label: over.label ?? `label-${over.id}`,
    status,
    startedAt: over.startedAt ?? T0,
    endedAt: over.endedAt ?? (terminal ? T0 + 1000 : undefined),
    parentId: over.parentId,
    outputRef: over.outputRef,
  };
}

/** Minimal mock Zustand store seeding `activity` with an empty reducer state. */
function createMockStore(
  initialActivity: ActivityState,
  sessionStates: Record<string, Record<string, unknown>> = {},
) {
  // sessionStates is present like the real store (the #6248 delta bump reads
  // get().sessionStates[sid]); default empty so the bump is simply skipped.
  let state = { activity: initialActivity, sessionStates } as unknown as ConnectionState;
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

// #6247 review: the message-handler keeps module-level store + context refs.
// Clear BOTH after each test so this suite can't leak state into other test
// files (order-dependent failures). _testResetStore() drops the store; the
// context is cleared so a later file that forgets to set it fails loudly
// rather than reusing this suite's mock.
afterEach(() => {
  _testResetStore();
  _testMessageHandler.setContext(null as never);
});

describe('activity feeder (#6246)', () => {
  it('activity_snapshot populates state.activity for a session', () => {
    const { store, current } = createMockStore(createEmptyActivityState());
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'activity_snapshot',
      sessionId: 's1',
      schemaVersion: 1,
      entries: [entry({ id: 'e1', status: 'running' }), entry({ id: 'e2', status: 'blocked' })],
    });

    const tree = current().activity;
    expect(tree.bySession.s1).toBeDefined();
    expect(tree.bySession.s1!.byId.e1!.status).toBe('running');
    expect(tree.bySession.s1!.byId.e2!.status).toBe('blocked');
  });

  it('activity_snapshot REPLACES the prior tree for that session', () => {
    const { store, current } = createMockStore(createEmptyActivityState());
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'activity_snapshot',
      sessionId: 's1',
      schemaVersion: 1,
      entries: [entry({ id: 'old', status: 'running' })],
    });
    _testMessageHandler.handle({
      type: 'activity_snapshot',
      sessionId: 's1',
      schemaVersion: 1,
      entries: [entry({ id: 'fresh', status: 'running' })],
    });

    const tree = current().activity;
    expect(tree.bySession.s1!.byId.old).toBeUndefined();
    expect(tree.bySession.s1!.byId.fresh!.status).toBe('running');
  });

  it('activity_delta upserts an entry into its session', () => {
    const { store, current } = createMockStore(createEmptyActivityState());
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'activity_delta',
      sessionId: 's2',
      schemaVersion: 1,
      op: 'started',
      entry: entry({ id: 'd1', status: 'running' }),
    });

    let tree = current().activity;
    expect(tree.bySession.s2!.byId.d1!.status).toBe('running');

    // An `updated` delta carrying the full, current node upserts by id.
    _testMessageHandler.handle({
      type: 'activity_delta',
      sessionId: 's2',
      schemaVersion: 1,
      op: 'updated',
      entry: entry({ id: 'd1', status: 'blocked', label: 'now-blocked' }),
    });

    tree = current().activity;
    expect(tree.bySession.s2!.byId.d1!.status).toBe('blocked');
    expect(tree.bySession.s2!.byId.d1!.label).toBe('now-blocked');
  });

  it('drops a malformed activity_snapshot without throwing or mutating state', () => {
    const seeded = createEmptyActivityState();
    const { store, current } = createMockStore(seeded);
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() =>
      _testMessageHandler.handle({
        type: 'activity_snapshot',
        sessionId: 's1',
        // schemaVersion missing → schema parse fails
        entries: 'not-an-array',
      }),
    ).not.toThrow();

    // No-op: the seeded reference is untouched (parse failed before any set).
    expect(current().activity).toBe(seeded);
    expect(current().activity.bySession).toEqual({});
  });

  it('drops a malformed activity_delta without throwing or mutating state', () => {
    const seeded = createEmptyActivityState();
    const { store, current } = createMockStore(seeded);
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() =>
      _testMessageHandler.handle({
        type: 'activity_delta',
        sessionId: 's1',
        schemaVersion: 1,
        op: 'started',
        entry: { id: 'bad' }, // missing required fields (kind/label/status/startedAt)
      }),
    ).not.toThrow();

    expect(current().activity).toBe(seeded);
    expect(current().activity.bySession).toEqual({});
  });

  // #6248 — a live activity_delta counts as activity: it bumps the session's
  // lastClientActivityAt and clears a stale inactivityWarning (parity with the
  // dashboard feeder + the app's isActivityEvent bump).
  it('activity_delta bumps lastClientActivityAt and clears inactivityWarning for its session', () => {
    const { store, current } = createMockStore(createEmptyActivityState(), {
      s2: { lastClientActivityAt: 1000, inactivityWarning: { remainingMs: 5000 } },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'activity_delta',
      sessionId: 's2',
      schemaVersion: 1,
      op: 'started',
      entry: entry({ id: 'd1', status: 'running' }),
    });

    const ss = (current().sessionStates as Record<string, { lastClientActivityAt?: number; inactivityWarning?: unknown }>).s2;
    expect(ss.lastClientActivityAt).toBeGreaterThan(1000);
    expect(ss.inactivityWarning).toBeNull();
  });

  it('activity_delta does NOT bump a session absent from sessionStates (no throw)', () => {
    const { store, current } = createMockStore(createEmptyActivityState()); // empty sessionStates
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() =>
      _testMessageHandler.handle({
        type: 'activity_delta',
        sessionId: 'ghost',
        schemaVersion: 1,
        op: 'started',
        entry: entry({ id: 'd1', status: 'running' }),
      }),
    ).not.toThrow();
    // The activity tree still updates; only the (absent) session bump is skipped.
    expect(current().activity.bySession.ghost!.byId.d1!.status).toBe('running');
  });

  // #6248 guardrail 1: a delta arriving while the session is REPLAYING history
  // must NOT bump (a session-switch replay would otherwise reset the timestamp).
  // The replaying set lives on the module-level _ctx and is populated via a real
  // `history_replay_start` (the canonical path the production gate reads).
  it('activity_delta does NOT bump while the session is replaying history', () => {
    const { store, current } = createMockStore(createEmptyActivityState(), {
      // `messages: []` so history_replay_start (which reads messages.length) runs.
      s2: { messages: [], lastClientActivityAt: 1000, inactivityWarning: { remainingMs: 5000 } },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    // Put s2 into _ctx.replayingSessions via the real replay-start path.
    _testMessageHandler.handle({ type: 'history_replay_start', sessionId: 's2' });
    const before = (current().sessionStates as Record<string, { lastClientActivityAt?: number }>).s2.lastClientActivityAt;

    _testMessageHandler.handle({
      type: 'activity_delta',
      sessionId: 's2',
      schemaVersion: 1,
      op: 'started',
      entry: entry({ id: 'd1', status: 'running' }),
    });

    const ss = (current().sessionStates as Record<string, { lastClientActivityAt?: number }>).s2;
    // Gated out: the delta did not bump the timestamp. The tree itself still upserts.
    expect(ss.lastClientActivityAt).toBe(before);
    expect(current().activity.bySession.s2!.byId.d1!.status).toBe('running');
  });

  // #6248 guardrail 2: activity_snapshot is a full-state RESYNC (on subscribe /
  // reconnect), not fresh work — it must NOT bump lastClientActivityAt.
  it('activity_snapshot does NOT bump lastClientActivityAt', () => {
    const { store, current } = createMockStore(createEmptyActivityState(), {
      s2: { lastClientActivityAt: 1000, inactivityWarning: { remainingMs: 5000 } },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'activity_snapshot',
      sessionId: 's2',
      schemaVersion: 1,
      entries: [entry({ id: 'e1', status: 'running' })],
    });

    const ss = (current().sessionStates as Record<string, { lastClientActivityAt?: number; inactivityWarning?: unknown }>).s2;
    expect(ss.lastClientActivityAt).toBe(1000); // unchanged — snapshot doesn't bump
    expect(ss.inactivityWarning).toEqual({ remainingMs: 5000 });
    // …but the activity tree IS replaced by the snapshot.
    expect(current().activity.bySession.s2!.byId.e1!.status).toBe('running');
  });
});
