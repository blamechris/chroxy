/**
 * #7411 — onclose must clear transient streaming/plan state for EVERY
 * session, not just the active one. The dashboard already sweeps all
 * sessions for this (#5731 T4); the app's onclose handler used
 * `updateActiveSession` here, so a BACKGROUND session mid-stream kept a
 * phantom "thinking" bubble (`streamingMessageId`) and a stale pending plan
 * across a reconnect.
 *
 * `pendingEvaluatorClarify` is part of the dashboard's parallel fix
 * (`clearTransientSessionState` in packages/dashboard/src/store/connection.ts)
 * but is NOT tested here — the app's `SessionState` has no such field (no
 * evaluator-clarify feature exists on the app yet), so there is nothing on
 * this side to clear or to test.
 *
 * Mirrors the fake-WebSocket harness in connection-reconnect-backoff.test.ts
 * and the #5623 "sweep sessionRole/primaryClientId across all sessions" test
 * in that same file — this is the streaming/plan sibling of that fix, plus a
 * canonical-field-list parity guard (TRANSIENT_SESSION_SWEEP_FIELDS) so the
 * two clients' onclose sweeps can't drift apart again the way they just did.
 */
import { TRANSIENT_SESSION_SWEEP_FIELDS, createEmptyBaseSessionState } from '@chroxy/store-core';
import type { BaseSessionState } from '@chroxy/store-core';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('dev-id-123')),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { useConnectionStore, __resetDeviceIdCacheForTests, createEmptySessionState } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { resetReconnectAttempt } from '../../store/message-handler';
import { clearAllCallbacks } from '../../store/imperative-callbacks';
import type { SessionState } from '../../store/types';

function flushPromises(): Promise<void> {
  return new Promise((resolve) =>
    jest.requireActual<typeof globalThis>('timers').setImmediate(resolve),
  );
}

function mockResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body ?? {}),
    text: () => Promise.resolve(JSON.stringify(body ?? {})),
  } as unknown as Response;
}

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  send: jest.Mock;
  close: jest.Mock;
}

function installMockWebSocket(): { instances: FakeSocket[]; restore: () => void } {
  const instances: FakeSocket[] = [];
  const Original = global.WebSocket;
  // @ts-expect-error — mock WebSocket constructor
  global.WebSocket = class MockWebSocket {
    static OPEN = 1;
    url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((event?: unknown) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;
    onmessage: ((event: unknown) => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(url: string) {
      this.url = url;
      instances.push(this as unknown as FakeSocket);
    }
  };
  return { instances, restore: () => { global.WebSocket = Original; } };
}

const originalFetch = global.fetch;
let randomSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  clearAllCallbacks();
  __resetDeviceIdCacheForTests();
  resetReconnectAttempt();
  randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
  (SecureStore.getItemAsync as jest.Mock).mockReset();
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('dev-id-123');
  (SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined);
  useConnectionStore.setState({
    serverErrors: [],
    connectedClients: [],
    myClientId: null,
    primaryClientId: null,
    sessionStates: {},
    activeSessionId: null,
    socket: null,
    shutdownReason: null,
    restartEtaMs: null,
    restartingSince: null,
  });
  useConnectionLifecycleStore.setState({
    connectionPhase: 'disconnected',
    connectionError: null,
    connectionRetryCount: 0,
    wsUrl: null,
  });
});

afterEach(() => {
  useConnectionStore.getState().disconnect();
  randomSpy.mockRestore();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

async function openConnectedSocket() {
  const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
  global.fetch = fetchMock;
  const ws = installMockWebSocket();

  useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
  await flushPromises();
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
  return { ws };
}

type SweepFieldName = (typeof TRANSIENT_SESSION_SWEEP_FIELDS)[number];
type SweepFieldValues = Pick<SessionState, SweepFieldName>;

// A dirty value per canonical sweep field, and the value each must become
// once cleared. Iterating TRANSIENT_SESSION_SWEEP_FIELDS (rather than
// hardcoding a parallel list of field names here) is the parity guard: a
// field added to the shared list without a matching entry here — or without
// the app's onclose sweep actually clearing it — fails this test loudly
// instead of silently passing.
const DIRTY_VALUES: SweepFieldValues = {
  streamingMessageId: 'msg-b',
  isPlanPending: true,
  planAllowedPrompts: [{ tool: 'Bash', prompt: 'echo hi' }],
  inactivityWarning: { idleMs: 60000, prefab: 'check-in', receivedAt: Date.now() },
  sessionRole: 'observer',
  primaryClientId: 'other-device',
};
const CLEAN_VALUES: SweepFieldValues = {
  streamingMessageId: null,
  isPlanPending: false,
  planAllowedPrompts: [],
  inactivityWarning: null,
  sessionRole: null,
  primaryClientId: null,
};

function dirtySessionState(): SessionState {
  return { ...createEmptySessionState(), ...DIRTY_VALUES };
}

/**
 * #8147 — the REVERSE direction of the parity guard below: a field the real
 * onclose sweep clears but which is NOT listed in TRANSIENT_SESSION_SWEEP_FIELDS
 * must also go red (the forward direction above only catches a LISTED field
 * the sweep forgets). Derived from `createEmptyBaseSessionState()` — the
 * canonical default-state factory, exported from `@chroxy/store-core` and
 * already typechecked against `BaseSessionState` — rather than a hand-typed
 * field list, so a field added to `BaseSessionState` automatically gets a
 * dirty value here too; there is no parallel roster to go stale.
 *
 * Each field's "dirty" value is picked generically from its clean/default
 * value's runtime shape (flip a boolean, bump a number, suffix a string, use
 * a fresh non-empty array/object for null/array/object defaults) — it only
 * needs to be DISTINCT from the default, not domain-valid, because the test
 * below never inspects the dirty value's contents, only whether the real
 * sweep code touched it (the object reference changes when a patch sets it;
 * it stays byte-identical when nothing does).
 */
function dirtyValueFor(key: string, defaultValue: unknown): unknown {
  if (defaultValue === null || defaultValue === undefined) return `__dirty__${key}`;
  if (typeof defaultValue === 'boolean') return !defaultValue;
  if (typeof defaultValue === 'number') return defaultValue + 1;
  if (typeof defaultValue === 'string') return `${defaultValue}__dirty`;
  if (Array.isArray(defaultValue)) return [`__dirty__${key}`];
  if (typeof defaultValue === 'object') return { __dirty: key };
  return defaultValue;
}

function buildFullyDirtyBaseSessionState(): BaseSessionState {
  const clean = createEmptyBaseSessionState() as unknown as Record<string, unknown>;
  const dirty: Record<string, unknown> = {};
  for (const key of Object.keys(clean)) {
    dirty[key] = dirtyValueFor(key, clean[key]);
  }
  return dirty as unknown as BaseSessionState;
}

describe('onclose clears transient streaming/plan state on all sessions (#7411)', () => {
  it('nulls streamingMessageId, isPlanPending and planAllowedPrompts on a BACKGROUND session', async () => {
    const { ws } = await openConnectedSocket();

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: createEmptySessionState(),
        b: {
          ...createEmptySessionState(),
          streamingMessageId: 'msg-b',
          isPlanPending: true,
          planAllowedPrompts: [{ tool: 'Bash', prompt: 'echo hi' }],
        },
      },
    });

    const socket = ws.instances[ws.instances.length - 1];
    socket.onclose?.({ code: 1006 });
    await flushPromises();

    const st = useConnectionStore.getState();
    // Background session "b" is the one the bug left dirty.
    expect(st.sessionStates.b!.streamingMessageId).toBeNull();
    expect(st.sessionStates.b!.isPlanPending).toBe(false);
    expect(st.sessionStates.b!.planAllowedPrompts).toEqual([]);

    ws.restore();
  });

  it("re-derives a background session's activityState, so no phantom 'thinking' survives the sweep", async () => {
    // Review on #8144: the app's `updateSession` re-derives `activityState`
    // from isIdle/streamingMessageId/isPlanPending ("one writer, one
    // derivation"). A sweep that writes the store directly clears the fields
    // but leaves activityState at 'thinking', which BackgroundSessionProgress,
    // the composer lozenge and notifications all read.
    const { ws } = await openConnectedSocket();

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: createEmptySessionState(),
        b: {
          ...createEmptySessionState(),
          isIdle: true,
          streamingMessageId: 'msg-b',
          activityState: { state: 'thinking', startedAt: 1 },
        },
      },
    });

    const socket = ws.instances[ws.instances.length - 1];
    socket.onclose?.({ code: 1006 });
    await flushPromises();

    const st = useConnectionStore.getState();
    expect(st.sessionStates.b!.streamingMessageId).toBeNull();
    expect(st.sessionStates.b!.activityState?.state).toBe('idle');

    ws.restore();
  });

  it('parity guard: clears every TRANSIENT_SESSION_SWEEP_FIELDS field on a background session', async () => {
    const { ws } = await openConnectedSocket();

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: createEmptySessionState(),
        b: dirtySessionState(),
      },
    });

    const socket = ws.instances[ws.instances.length - 1];
    socket.onclose?.({ code: 1006 });
    await flushPromises();

    // A field added to the shared list without a dirty/clean pair above must
    // fail at runtime too, and each dirty value must differ from its clean one.
    expect(Object.keys(DIRTY_VALUES).sort()).toEqual([...TRANSIENT_SESSION_SWEEP_FIELDS].sort());
    for (const field of TRANSIENT_SESSION_SWEEP_FIELDS) {
      expect(DIRTY_VALUES[field]).not.toEqual(CLEAN_VALUES[field]);
    }

    const st = useConnectionStore.getState();
    for (const field of TRANSIENT_SESSION_SWEEP_FIELDS) {
      expect(st.sessionStates.b).toHaveProperty(field, CLEAN_VALUES[field]);
    }

    ws.restore();
  });
});

describe('reverse-direction parity guard: onclose sweeps nothing OUTSIDE the canonical list (#8147)', () => {
  it('changes exactly TRANSIENT_SESSION_SWEEP_FIELDS on a fully-dirty background session — no more, no fewer', async () => {
    const { ws } = await openConnectedSocket();

    const dirtyBase = buildFullyDirtyBaseSessionState();
    const dirty: SessionState = { ...createEmptySessionState(), ...dirtyBase };
    const dirtyBaseRecord = dirtyBase as unknown as Record<string, unknown>;
    const baseFieldNames = Object.keys(dirtyBaseRecord);

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: createEmptySessionState(),
        b: dirty,
      },
    });

    const socket = ws.instances[ws.instances.length - 1];
    socket.onclose?.({ code: 1006 });
    await flushPromises();

    const after = useConnectionStore.getState().sessionStates.b as unknown as Record<string, unknown>;

    // Every BaseSessionState field the sweep actually changed (by reference —
    // untouched fields survive the sweep's object spreads byte-identical to
    // the dirty value we seeded) must be exactly the canonical list. A field
    // the sweep clears without it being listed (the issue's `stoppedAt`
    // mutant) shows up here and fails the assertion below; a listed field the
    // sweep forgets is already caught by the forward-direction guard above.
    const changed = baseFieldNames.filter((key) => after[key] !== dirtyBaseRecord[key]);
    expect(changed.sort()).toEqual([...TRANSIENT_SESSION_SWEEP_FIELDS].sort());

    ws.restore();
  });
});

/**
 * #8148 — disconnect() never got the onclose sweep #7411 added.
 * disconnect() nulls `socket.onclose` (to suppress auto-reconnect) before
 * closing the socket, so the onclose sweep above never runs on a
 * user-initiated disconnect — a background session mid-stream (or with a
 * pending plan) kept its phantom "thinking" bubble / stale plan through the
 * next connect. The fix reuses the exact same
 * `clearStreamingAndPlanStateAcrossSessions(get)` call disconnect() already
 * makes for `clearInactivityWarningsAcrossSessions`/
 * `clearSessionRolesAcrossSessions`, so these tests mirror the onclose ones
 * above 1:1, calling `disconnect()` instead of `socket.onclose?.()`.
 */
describe('disconnect() clears transient streaming/plan state on all sessions (#8148)', () => {
  it('nulls streamingMessageId, isPlanPending and planAllowedPrompts on a BACKGROUND session', async () => {
    const { ws } = await openConnectedSocket();

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: createEmptySessionState(),
        b: {
          ...createEmptySessionState(),
          streamingMessageId: 'msg-b',
          isPlanPending: true,
          planAllowedPrompts: [{ tool: 'Bash', prompt: 'echo hi' }],
        },
      },
    });

    useConnectionStore.getState().disconnect();

    const st = useConnectionStore.getState();
    // Background session "b" is the one the bug left dirty.
    expect(st.sessionStates.b!.streamingMessageId).toBeNull();
    expect(st.sessionStates.b!.isPlanPending).toBe(false);
    expect(st.sessionStates.b!.planAllowedPrompts).toEqual([]);

    ws.restore();
  });

  it("re-derives a background session's activityState, so no phantom 'thinking' survives disconnect", async () => {
    // Same "one writer, one derivation" concern as the onclose test above:
    // updateSession re-derives activityState from
    // isIdle/streamingMessageId/isPlanPending, so a sweep that skipped it
    // would leave activityState at 'thinking' after disconnect() too.
    const { ws } = await openConnectedSocket();

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: createEmptySessionState(),
        b: {
          ...createEmptySessionState(),
          isIdle: true,
          streamingMessageId: 'msg-b',
          activityState: { state: 'thinking', startedAt: 1 },
        },
      },
    });

    useConnectionStore.getState().disconnect();

    const st = useConnectionStore.getState();
    expect(st.sessionStates.b!.streamingMessageId).toBeNull();
    expect(st.sessionStates.b!.activityState?.state).toBe('idle');

    ws.restore();
  });

  it('parity guard: clears every TRANSIENT_SESSION_SWEEP_FIELDS field on a background session', async () => {
    // disconnect() already sweeps inactivityWarning/sessionRole/
    // primaryClientId across all sessions (#3899/#5623); this guard fails
    // if the streaming/plan trio isn't swept the same way.
    const { ws } = await openConnectedSocket();

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: createEmptySessionState(),
        b: dirtySessionState(),
      },
    });

    useConnectionStore.getState().disconnect();

    const st = useConnectionStore.getState();
    for (const field of TRANSIENT_SESSION_SWEEP_FIELDS) {
      expect(st.sessionStates.b).toHaveProperty(field, CLEAN_VALUES[field]);
    }

    ws.restore();
  });
});
