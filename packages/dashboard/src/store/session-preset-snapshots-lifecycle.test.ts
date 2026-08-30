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
 *   already cleared the map. The one remaining route into that branch —
 *   `connectToServer` — cannot carry another server's presets: its two callers
 *   are App.tsx's mount-only effect (a fresh page load, where the store starts
 *   at `{}`) and `retryConnection`, which targets the server already active.
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
