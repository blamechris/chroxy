/**
 * #7488 — `sessionPresetSnapshots` must be cleared on the SERVER-SWITCH paths,
 * and must NOT be cleared on a same-server reconnect.
 *
 * ## Why this map is different
 *
 * It is `Record<cwd, ServerSessionPresetFull | null>` (#5553), populated by
 * `session_preset_snapshot` replies and — until this change — never cleared or
 * pruned on ANY path: not `forgetSession`, not `_resetSessionMemory`, not
 * `auth_ok`, not the `session_list` `removedIds` block. Its only write outside
 * the store's initial `{}` was the additive merge in the handler.
 *
 * The roster guard in `session-destroy-prunes-pr-maps.test.ts` classifies it
 * `NOT_SESSION_KEYED` and is right to: `removedIds` is a list of session ids and
 * this map is keyed by cwd, so there is nothing to diff. That classification is
 * also what hid the problem — "not keyed by a session id" says nothing about
 * whether the entries outlive the CONNECTION.
 *
 * ## Why the key space makes it worse, not better
 *
 * Session ids are 16 random bytes, so entropy alone separates two daemons' id
 * spaces. Cwd paths have no such property: `/home/user/project`, `/workspace`
 * and `/Users/chris/Projects/chroxy` are shared across machines routinely. So a
 * preset fetched from server A is very likely to be read against server B at the
 * same path after a `switchServer`.
 *
 * And what is read is not a status chip. `ServerSessionPresetFull` carries the
 * full preamble + seed text and the preset's approval state, surfaced by
 * `RepoPresetDrawer` and the create-session modal disclosure — so the user is
 * shown one machine's preset content, and can approve and apply it, believing it
 * came from the daemon they are now connected to.
 *
 * ## The adjudication, per site
 *
 * - `forgetSession` / `_resetSessionMemory` — CLEAR. Both are connection
 *   teardowns; `_resetSessionMemory` is the server switch itself, and it
 *   deliberately keeps the old server's PERSISTED data, which is what makes the
 *   cross-server read reachable rather than theoretical.
 * - `auth_ok` non-reconnect — KEEP, decided explicitly rather than by analogy
 *   with the session-keyed maps. That branch is reached by Disconnect → Connect
 *   to the SAME server, where a preset for a cwd is still true; dropping it
 *   would make every reconnect re-fetch a drawer the user is reading. It is also
 *   reached on the server-switch route, but only AFTER `_resetSessionMemory` has
 *   already cleared the map.
 *
 *   What makes that safe on every OTHER route into the branch is an INVARIANT,
 *   not a caller census. PR #7564's review is why this is worded that way: the
 *   first draft claimed `connectToServer` was "the one remaining route" and
 *   named its two callers, and the reviewer found four more — `retryConnection`'s
 *   LOCAL branch, `useTauriEvents`' `server_ready`, the `visibilitychange` retry,
 *   and `scheduleRetry`. A census goes stale the moment someone adds a caller.
 *   The invariant does not:
 *
 *       // connection.ts, inside connect()
 *       const currentUrl = get().wsUrl;
 *       if (_retryCount === 0 && currentUrl !== null && currentUrl !== url) {
 *         get().forgetSession();
 *         clearMessageQueue();
 *       }
 *
 *   `connect()` self-clears via `forgetSession()` — which this PR makes clear
 *   `sessionPresetSnapshots` — whenever the target URL differs from the last
 *   one. So reaching `auth_ok` against a DIFFERENT daemon has already dropped
 *   the presets, by a different door than `_resetSessionMemory`. The cell at the
 *   bottom of this file drives that door end to end.
 *
 *   The one hole, named rather than omitted: that guard is
 *   `_retryCount === 0`-conditional, and `scheduleRetry` always re-enters with
 *   `nextAttempt >= 1`, so a mid-ladder host change would slip past it.
 *   Unreachable today — there is no `storage` listener in the dashboard, and
 *   `applyRotatedTunnelUrlDashboard` repoints to a new tunnel for the SAME
 *   daemon — but it is where this argument ends.
 * - `session_list` `removedIds` — DOES NOT APPLY. `removedIds` holds session
 *   ids; this map is keyed by cwd, so there is nothing to diff against.
 *
 * Driven through the REAL store rather than a mock, because the thing under test
 * is the action's `set({ ... })` payload itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const lsStore: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => lsStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { lsStore[key] = value }),
  removeItem: vi.fn((key: string) => { delete lsStore[key] }),
  clear: vi.fn(() => { for (const k of Object.keys(lsStore)) delete lsStore[k] }),
  get length() { return Object.keys(lsStore).length },
  key: vi.fn((i: number) => Object.keys(lsStore)[i] ?? null),
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

const { useConnectionStore } = await import('./connection')
const { createEmptySessionState } = await import('./utils')
const { handleMessage, stopHeartbeat, clearDeltaBuffers, clearPermissionSplits, resetReplayFlags } =
  await import('./message-handler')

/** The colliding path: the same absolute cwd on two different machines. */
const SHARED_CWD = '/home/user/project'
const OTHER_CWD = '/workspace'

/** A preset carrying the content the drawer actually renders. */
function presetFromServerA() {
  return {
    id: 'preset-a',
    name: 'Server A preset',
    preamble: 'SECRET PREAMBLE FROM SERVER A',
    seed: 'seed text staged into the composer on server A',
    approved: true,
  }
}

function seedServerAPresets() {
  useConnectionStore.setState({
    sessions: [{ sessionId: 'sess-A' }] as never,
    activeSessionId: 'sess-A',
    sessionStates: { 'sess-A': createEmptySessionState() },
    sessionPresetSnapshots: {
      [SHARED_CWD]: presetFromServerA() as never,
      // An explicit `null` (fetched, no preset for that repo) has to go too: it
      // is just as much a claim about server A as a populated entry is, and it
      // suppresses the drawer's fetch on server B.
      [OTHER_CWD]: null,
    },
  })
}

function resetStoreSlice() {
  useConnectionStore.setState({
    sessionPresetSnapshots: {},
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
  })
}

describe.each([
  ['forgetSession', () => useConnectionStore.getState().forgetSession()],
  ['_resetSessionMemory', () => useConnectionStore.getState()._resetSessionMemory()],
])('#7488 %s clears sessionPresetSnapshots', (_name, run) => {
  beforeEach(() => {
    resetStoreSlice()
    seedServerAPresets()
  })

  it('control: the fixture populated the map first', () => {
    // Without this the "empty afterwards" assertion below passes for free on a
    // fixture that never landed.
    const s = useConnectionStore.getState()
    expect(Object.keys(s.sessionPresetSnapshots)).toEqual([SHARED_CWD, OTHER_CWD])
    expect(s.sessionPresetSnapshots[SHARED_CWD]?.preamble).toBe('SECRET PREAMBLE FROM SERVER A')
    // The `null` entry is PRESENT, not merely absent — `in` distinguishes
    // "fetched, no preset" from "not fetched", and only the first suppresses a
    // re-fetch on the next server.
    expect(OTHER_CWD in s.sessionPresetSnapshots).toBe(true)
  })

  // Asserted PER SITE (via describe.each) so clearing one and not the other
  // names the one that is missing.
  it('clears it', () => {
    run()
    expect(useConnectionStore.getState().sessionPresetSnapshots).toEqual({})
  })

  it('clears the explicit null entry too, not just the populated one', () => {
    run()
    const s = useConnectionStore.getState()
    expect(OTHER_CWD in s.sessionPresetSnapshots).toBe(false)
  })

  it('clears it in the same reset that drops the roster', () => {
    run()
    const s = useConnectionStore.getState()
    expect(s.sessionStates).toEqual({})
    expect(s.sessions).toEqual([])
  })
})

describe('#7488 the cross-server bleed, end to end', () => {
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://server-b', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
    mockSocket = { send: vi.fn(), close: vi.fn(), readyState: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket
    resetStoreSlice()
    seedServerAPresets()
  })
  afterEach(() => { stopHeartbeat(); resetStoreSlice() })

  it('a switchServer to a daemon with the SAME cwd reads no preset', () => {
    // The whole defect in one sequence: server A's preset for `/home/user/project`,
    // then the switch, then server B's post-auth burst. The drawer for that repo
    // path must find nothing rather than server A's preamble + seed.
    expect(useConnectionStore.getState().sessionPresetSnapshots[SHARED_CWD]?.preamble)
      .toBe('SECRET PREAMBLE FROM SERVER A')
    useConnectionStore.getState()._resetSessionMemory()
    handleMessage(
      {
        type: 'auth_ok',
        serverMode: 'cli',
        cwd: SHARED_CWD,
        defaultCwd: '/home/user',
        serverVersion: '0.11.0',
        protocolVersion: 3,
        clientId: 'client-1',
        connectedClients: [],
      },
      ctx() as never,
    )
    handleMessage({ type: 'session_list', sessions: [{ sessionId: 'sess-on-B', isBusy: false }] }, ctx() as never)
    const s = useConnectionStore.getState()
    expect(s.sessionPresetSnapshots[SHARED_CWD], "server A's preset is being read against server B").toBeUndefined()
    expect(SHARED_CWD in s.sessionPresetSnapshots).toBe(false)
  })

  it('POSITIVE CONTROL: a same-server reconnect KEEPS the presets', () => {
    // The adjudication, as a test. `auth_ok`'s non-reconnect branch is reached by
    // Disconnect → Connect to the SAME server; a preset for a cwd is still true
    // there, and clearing it would blank a drawer the user is reading and force a
    // re-fetch on every reconnect. This is what stops the fix degenerating into
    // "clear on every auth_ok", which would satisfy every assertion above.
    handleMessage(
      {
        type: 'auth_ok',
        serverMode: 'cli',
        cwd: SHARED_CWD,
        defaultCwd: '/home/user',
        serverVersion: '0.11.0',
        protocolVersion: 3,
        clientId: 'client-1',
        connectedClients: [],
      },
      { url: 'wss://server-a', token: 'tok', socket: mockSocket, isReconnect: false, silent: false } as never,
    )
    const s = useConnectionStore.getState()
    expect(s.sessionPresetSnapshots[SHARED_CWD]?.preamble).toBe('SECRET PREAMBLE FROM SERVER A')
    expect(OTHER_CWD in s.sessionPresetSnapshots).toBe(true)
  })

  it('POSITIVE CONTROL: a SILENT reconnect keeps them too', () => {
    handleMessage(
      {
        type: 'auth_ok',
        serverMode: 'cli',
        cwd: SHARED_CWD,
        defaultCwd: '/home/user',
        serverVersion: '0.11.0',
        protocolVersion: 3,
        clientId: 'client-1',
        connectedClients: [],
      },
      { url: 'wss://server-a', token: 'tok', socket: mockSocket, isReconnect: true, silent: true } as never,
    )
    expect(useConnectionStore.getState().sessionPresetSnapshots[SHARED_CWD]?.preamble)
      .toBe('SECRET PREAMBLE FROM SERVER A')
  })

  it('INVARIANT: connect() to a DIFFERENT url self-clears the presets via forgetSession', () => {
    // #7564 review, finding 6 — the thing the adjudication actually rests on,
    // converted from prose into a test. This is the door that defuses every
    // route into `auth_ok`'s non-reconnect branch that does NOT go through
    // `_resetSessionMemory` (the Tauri `server_ready` handler, the
    // visibilitychange retry, `retryConnection`'s local branch): a first-attempt
    // `connect()` whose target url differs from `wsUrl` calls `forgetSession()`,
    // and `forgetSession` clears this map.
    useConnectionStore.setState({ wsUrl: 'wss://server-a' })
    expect(
      useConnectionStore.getState().sessionPresetSnapshots[SHARED_CWD]?.preamble,
      'control: server A presets are in the store before the connect',
    ).toBe('SECRET PREAMBLE FROM SERVER A')
    useConnectionStore.getState().connect('wss://server-b', 'tok')
    expect(
      useConnectionStore.getState().sessionPresetSnapshots,
      "connect() to a different url must self-clear server A's presets",
    ).toEqual({})
    useConnectionStore.getState().disconnect()
  })

  it('INVARIANT control: connect() to the SAME url does NOT self-clear', () => {
    // The negative half — otherwise the cell above would pass on a `connect()`
    // that cleared unconditionally, which would silently drop the presets on
    // every ordinary reconnect and make the whole `auth_ok`-KEEP adjudication
    // moot.
    useConnectionStore.setState({ wsUrl: 'wss://server-a' })
    useConnectionStore.getState().connect('wss://server-a', 'tok')
    expect(useConnectionStore.getState().sessionPresetSnapshots[SHARED_CWD]?.preamble)
      .toBe('SECRET PREAMBLE FROM SERVER A')
    useConnectionStore.getState().disconnect()
  })

  it('a session_list that removes a session does NOT touch the map', () => {
    // The site that does not apply, pinned so nobody "completes" the roster by
    // wiring a cwd-keyed map into a session-id prune. Presets legitimately
    // outlive the session that was open in that repo.
    useConnectionStore.setState({
      sessions: [{ sessionId: 'sess-A' }, { sessionId: 'sess-B' }] as never,
      sessionStates: { 'sess-A': createEmptySessionState(), 'sess-B': createEmptySessionState() },
    })
    handleMessage({ type: 'session_list', sessions: [{ sessionId: 'sess-B', isBusy: false }] }, ctx() as never)
    expect(useConnectionStore.getState().sessionPresetSnapshots[SHARED_CWD]?.preamble)
      .toBe('SECRET PREAMBLE FROM SERVER A')
  })
})
