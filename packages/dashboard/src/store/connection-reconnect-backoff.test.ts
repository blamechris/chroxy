/**
 * #5555.5 — reconnect backoff on the socket-close/error path (dashboard).
 *
 * The close/error handlers used to schedule reconnects at a FIXED delay
 * (AUTO_RECONNECT_DELAY=1500ms / ERROR_RECONNECT_DELAY=2000ms). They now climb
 * the shared RETRY_DELAYS ladder ([1000, 2000, 3000, 5000, 8000], jittered) via
 * a module-level counter that RESETS on `auth_ok` (a successful connect), NOT on
 * mere socket-open.
 *
 * Math.random is pinned to 0 so withJitter() is the identity and each rung's
 * delay is exactly RETRY_DELAYS[N]. Mirrors the WebSocket/fetch mock harness in
 * connection-pairing.test.ts, with fake timers so we can assert exact delays.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RECONNECT_MAX_RUNG, TRANSIENT_SESSION_SWEEP_FIELDS } from '@chroxy/store-core'
import type { SessionState } from './types'

const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v },
  removeItem: (k: string) => { delete store[k] },
  clear: () => { for (const k of Object.keys(store)) delete store[k] },
  get length() { return Object.keys(store).length },
  key: (i: number) => Object.keys(store)[i] ?? null,
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

const RETRY_DELAYS: [number, number, number, number, number] = [1000, 2000, 3000, 5000, 8000]

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  url: string
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3 }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok' }),
}))

const { useConnectionStore, createEmptySessionState } = await import('./connection')
// Import the namespace (not a destructured binding) so `mh.reconnectAttempt`
// reflects the live module-level counter — destructuring a `let` export copies
// the value at import time and would always read 0.
const mh = await import('./message-handler')
const { resetReconnectAttempt, nextReconnectAttempt } = mh

/**
 * Open a connection, walk it through the health check + WS handshake, and mark
 * it connected so a subsequent onclose takes the auto-reconnect branch.
 * Returns the freshly opened socket.
 */
async function openConnected(): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect('wss://tunnel.example.com/ws', 'tok')
  // Flush the health-check fetch (microtasks) so the WS is constructed.
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.readyState = 1
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  useConnectionStore.setState({ connectionPhase: 'connected', userDisconnected: false })
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  vi.spyOn(Math, 'random').mockReturnValue(0) // zero jitter
  // Silence the per-cycle reconnect logging. These tests drive many
  // close→reconnect cycles (the #5698 give-up test alone runs 11), and that
  // console.log volume races vitest's onUserConsoleLog RPC at worker teardown
  // ("Closing rpc while onUserConsoleLog was pending"), surfacing as a flaky
  // EnvironmentTeardownError in CI even though every test passes. Restored by
  // vi.restoreAllMocks() in afterEach.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const k of Object.keys(store)) delete store[k]
  useConnectionStore.setState({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    wsUrl: null,
    userDisconnected: false,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Ladder math
// ---------------------------------------------------------------------------

describe('reconnect backoff ladder counter (#5555.5)', () => {
  it('nextReconnectAttempt advances and resetReconnectAttempt rewinds', () => {
    expect(mh.reconnectAttempt).toBe(0)
    expect(nextReconnectAttempt()).toBe(0)
    expect(nextReconnectAttempt()).toBe(1)
    resetReconnectAttempt()
    expect(mh.reconnectAttempt).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// End-to-end close-path backoff
// ---------------------------------------------------------------------------

describe('socket-close reconnect backoff (#5555.5)', () => {
  /**
   * Drives one drop → reconnect cycle and asserts the reconnect fires at exactly
   * `expectedDelay` ms (no sooner). Marks the new socket connected for reuse.
   */
  async function expectReconnectAt(expectedDelay: number) {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    const before = MockWebSocket.instances.length

    socket.onclose?.({ code: 1006 })

    // One tick short: no reconnect yet.
    await vi.advanceTimersByTimeAsync(expectedDelay - 1)
    expect(MockWebSocket.instances.length).toBe(before)

    // Cross the boundary: connect() → fetch → new socket.
    await vi.advanceTimersByTimeAsync(1)
    expect(MockWebSocket.instances.length).toBe(before + 1)

    const next = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    next.readyState = 1
    next.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    useConnectionStore.setState({ connectionPhase: 'connected' })
  }

  it('escalates through the RETRY_DELAYS ladder across consecutive drops', async () => {
    await openConnected()
    await expectReconnectAt(RETRY_DELAYS[0])
    await expectReconnectAt(RETRY_DELAYS[1])
    await expectReconnectAt(RETRY_DELAYS[2])
    await expectReconnectAt(RETRY_DELAYS[3])
  })

  it('caps at the top rung (8000ms) once the ladder is exhausted', async () => {
    await openConnected()
    await expectReconnectAt(RETRY_DELAYS[0])
    await expectReconnectAt(RETRY_DELAYS[1])
    await expectReconnectAt(RETRY_DELAYS[2])
    await expectReconnectAt(RETRY_DELAYS[3])
    await expectReconnectAt(RETRY_DELAYS[4])
    await expectReconnectAt(RETRY_DELAYS[4]) // clamps
  })

  it('a user-disconnect short-circuit does NOT burn a ladder rung', async () => {
    const ws = await openConnected()
    // Mark a user disconnect: scheduleReconnect returns before advancing the ladder.
    useConnectionStore.setState({ userDisconnected: true })
    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[4])
    expect(mh.reconnectAttempt).toBe(0) // never advanced
  })
})

// ---------------------------------------------------------------------------
// Reset-on-auth_ok (NOT on socket-open)
// ---------------------------------------------------------------------------

describe('backoff ladder resets on auth_ok, not socket-open (#5555.5)', () => {
  it('a successful auth_ok rewinds the ladder back to the bottom rung', async () => {
    const s0 = await openConnected()

    s0.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]) // rung 0 fires
    const s1 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    s1.readyState = 1
    s1.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    useConnectionStore.setState({ connectionPhase: 'connected' })

    s1.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1]) // rung 1 fires
    const s2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    s2.readyState = 1
    s2.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(mh.reconnectAttempt).toBe(2) // climbed, not yet reset

    // Drive a real auth_ok through the production onmessage path.
    s2.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(mh.reconnectAttempt).toBe(0) // auth_ok reset it
  })

  it('socket-open alone does NOT reset the ladder (only auth_ok does)', async () => {
    const s0 = await openConnected()

    s0.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]) // rung 0 fires
    const s1 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    s1.readyState = 1
    s1.onopen?.() // opened but never authenticated
    await vi.advanceTimersByTimeAsync(0)
    expect(mh.reconnectAttempt).toBe(1) // NOT reset by socket-open
  })
})

// ---------------------------------------------------------------------------
// #5698 — ladder gives up → terminal server_down + manual-retry recovery
// ---------------------------------------------------------------------------

describe('reconnect ladder gives up → server_down (#5698)', () => {
  // Drive one drop. If a reconnect socket is created, mark it connected (but
  // never auth_ok, so the ladder keeps climbing) and return true; if the ladder
  // gave up (no new socket), return false.
  async function driveDrop(): Promise<boolean> {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    const before = MockWebSocket.instances.length
    socket.onclose?.({ code: 1006 })
    // Advance well past the top rung so any armed timer fires.
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[4] * 2)
    if (MockWebSocket.instances.length === before) return false // gave up
    const next = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    next.readyState = 1
    next.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    useConnectionStore.setState({ connectionPhase: 'connected' })
    return true
  }

  it('goes terminal after RECONNECT_MAX_RUNG failed reconnects and a manual retry resets the ladder', async () => {
    await openConnected()
    let cycles = 0
    while (await driveDrop()) {
      cycles++
      if (cycles > RECONNECT_MAX_RUNG + 2) throw new Error('ladder never gave up')
    }
    // The ladder armed rungs 0..RECONNECT_MAX_RUNG-1 (that many reconnects), then
    // the next drop hit the cap and gave up instead of arming.
    expect(cycles).toBe(RECONNECT_MAX_RUNG)
    expect(useConnectionStore.getState().connectionPhase).toBe('server_down')

    // A user-initiated retry resets the ladder (resetReconnectAttempt runs even
    // though the local-daemon connect no-ops here — getAuthToken is mocked null).
    useConnectionStore.getState().retryConnection()
    expect(mh.reconnectAttempt).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// #5731 T4 — onclose clears transient streaming/plan state for EVERY session,
// not just the active one (a background tab mid-stream otherwise keeps a
// phantom "thinking" bubble that handleSessionSwitched surfaces on tab switch).
// ---------------------------------------------------------------------------

describe('onclose clears transient state across all sessions (#5731 T4)', () => {
  it('nulls streamingMessageId / plan / inactivity on background sessions too', async () => {
    const ws = await openConnected()

    // Active session "a" and a background session "b", both mid-stream, with
    // a pending plan + inactivity chip on the background session.
    useConnectionStore.setState({
      activeSessionId: 'a',
      streamingMessageId: 'msg-a',
      sessionStates: {
        a: {
          messages: [],
          streamingMessageId: 'msg-a',
          isPlanPending: false,
          planAllowedPrompts: [],
          pendingEvaluatorClarify: null,
          inactivityWarning: null,
        },
        b: {
          messages: [],
          streamingMessageId: 'msg-b',
          isPlanPending: true,
          planAllowedPrompts: ['go'],
          pendingEvaluatorClarify: { question: 'why?' },
          inactivityWarning: { sinceMs: 1 },
        },
      } as never,
    })

    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)

    const st = useConnectionStore.getState()
    // Active session cleared (and its flat mirror).
    expect(st.sessionStates.a!.streamingMessageId).toBeNull()
    expect(st.streamingMessageId).toBeNull()
    // Background session cleared too — the bug was that it stayed set.
    expect(st.sessionStates.b!.streamingMessageId).toBeNull()
    expect(st.sessionStates.b!.isPlanPending).toBe(false)
    expect(st.sessionStates.b!.planAllowedPrompts).toEqual([])
    expect(st.sessionStates.b!.pendingEvaluatorClarify).toBeNull()
    expect(st.sessionStates.b!.inactivityWarning).toBeNull()
  })

  // #7411 — the dashboard half of the shared-list parity guard (the app half is
  // connection-transient-state-sweep.test.ts). Iterating the shared list means a
  // field added to TRANSIENT_SESSION_SWEEP_FIELDS that this sweep doesn't clear
  // fails here, not only on the app side.
  it('parity guard: clears every TRANSIENT_SESSION_SWEEP_FIELDS field on a background session (#7411)', async () => {
    const ws = await openConnected()
    type SweepField = (typeof TRANSIENT_SESSION_SWEEP_FIELDS)[number]
    const DIRTY: Record<SweepField, unknown> = {
      streamingMessageId: 'msg-b',
      isPlanPending: true,
      planAllowedPrompts: ['go'],
      inactivityWarning: { sinceMs: 1 },
      sessionRole: 'observer',
      primaryClientId: 'other-device',
    }
    const CLEAN: Record<SweepField, unknown> = {
      streamingMessageId: null,
      isPlanPending: false,
      planAllowedPrompts: [],
      inactivityWarning: null,
      sessionRole: null,
      primaryClientId: null,
    }
    // Runtime half of the Record<SweepField> typing: a field added to the list
    // without a dirty/clean pair here must fail even where nothing typechecks
    // the test, and every dirty value must actually differ from its clean one.
    expect(Object.keys(DIRTY).sort()).toEqual([...TRANSIENT_SESSION_SWEEP_FIELDS].sort())
    for (const field of TRANSIENT_SESSION_SWEEP_FIELDS) expect(DIRTY[field], field).not.toEqual(CLEAN[field])

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: { messages: [], pendingEvaluatorClarify: null, ...CLEAN },
        b: { messages: [], pendingEvaluatorClarify: null, ...DIRTY },
      } as never,
    })

    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)

    const b = useConnectionStore.getState().sessionStates.b as unknown as Record<string, unknown>
    for (const field of TRANSIENT_SESSION_SWEEP_FIELDS) {
      expect(b[field], field).toEqual(CLEAN[field])
    }
  })

  // #5623 — onclose also clears the presence role (sessionRole/primaryClientId)
  // on every session so a stale "Observing"/driver badge doesn't persist through
  // the reconnect gap. The server re-emits session_role on reconnect/tab-switch.
  it('nulls sessionRole / primaryClientId on all sessions (#5623)', async () => {
    const ws = await openConnected()

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: {
          messages: [],
          streamingMessageId: null,
          isPlanPending: false,
          planAllowedPrompts: [],
          pendingEvaluatorClarify: null,
          inactivityWarning: null,
          sessionRole: 'observer',
          primaryClientId: 'other-device',
        },
        b: {
          messages: [],
          streamingMessageId: null,
          isPlanPending: false,
          planAllowedPrompts: [],
          pendingEvaluatorClarify: null,
          inactivityWarning: null,
          sessionRole: 'primary',
          primaryClientId: 'me',
        },
      } as never,
    })

    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)

    const st = useConnectionStore.getState()
    expect(st.sessionStates.a!.sessionRole).toBeNull()
    expect(st.sessionStates.a!.primaryClientId).toBeNull()
    expect(st.sessionStates.b!.sessionRole).toBeNull()
    expect(st.sessionStates.b!.primaryClientId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// #8147 — the REVERSE direction of the parity guard above: a field the real
// onclose sweep clears but which is NOT listed in TRANSIENT_SESSION_SWEEP_FIELDS
// must also go red. The forward-direction guard above only catches a LISTED
// field a sweep forgets to clear; it says nothing about a field a sweep
// clears that was never listed (the issue's `stoppedAt` mutant — one extra
// line in `clearTransientSessionStatePatch`, never added to the shared list,
// never mirrored to the app — passed every suite in #8144's head).
// ---------------------------------------------------------------------------

/**
 * #8201 review — the FIRST version of this fixture iterated
 * `Object.keys(createEmptySessionState())`, which only sees whatever the
 * factory actually emits. The factory leaves several of the dashboard's OWN
 * `SessionState` fields unset (they're all optional): `terminalSize`,
 * `sessionRules`, `persistentRules`, `skills`, `mismatchedSkillNames`,
 * `pendingCommunitySkills`, `pendingTrustGrants` — so all seven were
 * invisible to the old dirty fixture and to the `changed` comparison below.
 * Copilot's review flagged `pendingTrustGrants` specifically
 * (types.ts:794) as a concrete, PRE-EXISTING instance of the same gap the
 * `probeOptionalField` proof demonstrated against `BaseSessionState` itself.
 *
 * `ALL_SESSION_STATE_KEYS` is a COMPILE-TIME exhaustiveness check instead:
 * every key of the dashboard's `SessionState`, optional ones included, must
 * appear here with a `true` value, enforced by `satisfies
 * Record<keyof Required<SessionState>, true>`. `tsc` rejects the map — and
 * this whole test file — the moment `SessionState` (or the `BaseSessionState`
 * it extends) gains or loses a key, independent of whether a factory
 * happens to set it.
 */
const ALL_SESSION_STATE_KEYS = {
  // BaseSessionState fields
  messages: true,
  streamingMessageId: true,
  pendingClientMessageId: true,
  inputDeliveries: true,
  claudeReady: true,
  activeModel: true,
  permissionMode: true,
  contextUsage: true,
  contextOccupancy: true,
  lastResultCost: true,
  lastResultDuration: true,
  sessionCost: true,
  cumulativeUsage: true,
  costThresholdWarning: true,
  isIdle: true,
  lastClientActivityAt: true,
  health: true,
  stoppedAt: true,
  stoppedCode: true,
  containerLostAt: true,
  containerReattachError: true,
  activeAgents: true,
  activeTools: true,
  pendingBackgroundShells: true,
  // #8302: the server's busy reason + tracker size. Not transient-swept —
  // like pendingBackgroundShells they describe server state, and the post-auth
  // session_list re-seeds them on reconnect.
  busyReason: true,
  backgroundShellCount: true,
  transcriptBackgroundTasks: true,
  scheduledWakeup: true,
  isPlanPending: true,
  planAllowedPrompts: true,
  primaryClientId: true,
  sessionRole: true,
  conversationId: true,
  sessionContext: true,
  statusLine: true,
  mcpServers: true,
  devPreviews: true,
  inactivityWarning: true,
  interventions: true,
  queuedMessages: true,
  // Dashboard-only fields (packages/dashboard/src/store/types.ts)
  terminalRawBuffer: true,
  terminalSize: true,
  selectedFilePath: true,
  thinkingLevel: true,
  sessionRules: true,
  persistentRules: true,
  skills: true,
  mismatchedSkillNames: true,
  pendingCommunitySkills: true,
  pendingTrustGrants: true,
  pendingEvaluatorClarify: true,
} satisfies Record<keyof Required<SessionState>, true>

/**
 * Picks a "dirty" value for one field from its clean/default value's runtime
 * shape — distinct from the default, not necessarily domain-valid, because
 * the test below only checks whether the real sweep code TOUCHED the field
 * (object identity changes when a patch sets it; survives untouched
 * otherwise — it does NOT verify the field was cleared to the *correct*
 * value; that's the pre-existing forward-direction guards' job, e.g. the
 * `toEqual(CLEAN[field])` assertions above).
 */
function dirtyValueFor(key: string, defaultValue: unknown): unknown {
  if (defaultValue === null || defaultValue === undefined) return `__dirty__${key}`
  if (typeof defaultValue === 'boolean') return !defaultValue
  if (typeof defaultValue === 'number') return defaultValue + 1
  if (typeof defaultValue === 'string') return `${defaultValue}__dirty`
  if (Array.isArray(defaultValue)) return [`__dirty__${key}`]
  if (typeof defaultValue === 'object') return { __dirty: key }
  return defaultValue
}

/**
 * "Zero value of the right JS type" for the handful of `SessionState` fields
 * `createEmptySessionState()` leaves unset (all optional) — NOT a real
 * default, just enough shape for `dirtyValueFor` to produce a value of the
 * right TYPE instead of falling into its null/undefined branch for
 * everything. `pendingTrustGrants` is the one that matters behaviorally:
 * `clearAllSessionPendingTrustGrants` (#3605/#3588 — a DIFFERENT onclose
 * cleanup than the transient sweep this issue is about, but one that runs in
 * the SAME onclose handler) only clears it when `Array.isArray(...) &&
 * .length > 0`; a non-array dirty value would dodge that real codepath and
 * silently miss the exception this test documents below. Keyed by the SAME
 * names `ALL_SESSION_STATE_KEYS` already enumerates — not a second roster —
 * so a key missing a seed here just falls back to `dirtyValueFor`'s generic
 * null/undefined branch rather than going uncovered.
 */
const OPTIONAL_FIELD_SEEDS: Partial<Record<keyof SessionState, unknown>> = {
  terminalSize: { cols: 0, rows: 0 },
  sessionRules: [],
  persistentRules: [],
  skills: [],
  mismatchedSkillNames: [],
  pendingCommunitySkills: [],
  pendingTrustGrants: [],
}

/**
 * Every key `ALL_SESSION_STATE_KEYS` knows about (not
 * `Object.keys(createEmptySessionState())` — see that map's docstring) gets
 * a dirty value, reusing the factory's value where it sets one and an
 * `OPTIONAL_FIELD_SEEDS` shape hint otherwise.
 */
function buildFullyDirtySessionState(): Record<string, unknown> {
  const clean = createEmptySessionState() as unknown as Record<string, unknown>
  const seeds = OPTIONAL_FIELD_SEEDS as Record<string, unknown>
  const dirty: Record<string, unknown> = {}
  for (const key of Object.keys(ALL_SESSION_STATE_KEYS)) {
    const seed = key in clean ? clean[key] : seeds[key]
    dirty[key] = dirtyValueFor(key, seed)
  }
  return dirty
}

describe('reverse-direction parity guard: onclose sweeps nothing OUTSIDE the canonical list (#8147)', () => {
  it('changes exactly TRANSIENT_SESSION_SWEEP_FIELDS plus the documented pendingEvaluatorClarify/pendingTrustGrants exceptions — no more, no fewer', async () => {
    const ws = await openConnected()

    const dirty = buildFullyDirtySessionState()
    // Driven by the compile-time-exhaustive map, not by whatever `dirty`
    // happens to contain — see ALL_SESSION_STATE_KEYS.
    const allFieldNames = Object.keys(ALL_SESSION_STATE_KEYS)

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: createEmptySessionState(),
        b: dirty as never,
      },
    })

    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)

    const after = useConnectionStore.getState().sessionStates.b as unknown as Record<string, unknown>
    // Nit (#8201 review): touched-vs-untouched only, not touched-to-the-
    // correct-value — a field cleared to the WRONG value is caught by the
    // forward-direction guards elsewhere in this file, not by this one.
    const changed = allFieldNames.filter((key) => after[key] !== dirty[key])

    // `pendingEvaluatorClarify` (#3188) and `pendingTrustGrants` (#3605/#3588)
    // are the two documented, deliberate exceptions: the first is dashboard-only
    // and explained in utils.ts's TRANSIENT_SESSION_SWEEP_FIELDS doc comment;
    // the second is cleared by `clearAllSessionPendingTrustGrants`, a sibling
    // onclose cleanup unrelated to the transient-state sweep this issue is
    // about, that happens to run inside the same handler. Any OTHER field
    // showing up here — listed or not — is exactly the #8147 mutant shape: an
    // extra clear nothing catches.
    expect(changed.sort()).toEqual(
      [...TRANSIENT_SESSION_SWEEP_FIELDS, 'pendingEvaluatorClarify', 'pendingTrustGrants'].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// #8148 — disconnect() never got the onclose sweep #7411/#5731 T4 added.
// A user-initiated Disconnect nulls socket.onclose (to suppress
// auto-reconnect) before closing the socket, so onclose's sweep above never
// runs on THIS path — a background session mid-stream (or with a pending
// plan/clarify question/stale role) kept its state through the next
// connect. The fix reuses the SAME per-session patch onclose already
// applies, so these tests mirror the onclose ones above 1:1, calling
// disconnect() instead of ws.onclose?.().
// ---------------------------------------------------------------------------

describe('disconnect() clears transient streaming/plan state on all sessions (#8148)', () => {
  it('nulls streamingMessageId, isPlanPending and planAllowedPrompts on a BACKGROUND session', async () => {
    await openConnected()

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: {
          messages: [],
          streamingMessageId: null,
          isPlanPending: false,
          planAllowedPrompts: [],
          pendingEvaluatorClarify: null,
          inactivityWarning: null,
        },
        b: {
          messages: [],
          streamingMessageId: 'msg-b',
          isPlanPending: true,
          planAllowedPrompts: ['go'],
          pendingEvaluatorClarify: null,
          inactivityWarning: null,
        },
      } as never,
    })

    useConnectionStore.getState().disconnect()

    const st = useConnectionStore.getState()
    // Background session "b" is the one the bug left dirty.
    expect(st.sessionStates.b!.streamingMessageId).toBeNull()
    expect(st.sessionStates.b!.isPlanPending).toBe(false)
    expect(st.sessionStates.b!.planAllowedPrompts).toEqual([])
  })

  // #8148 acceptance — the onclose sweep also clears pendingEvaluatorClarify
  // (dashboard-only, #3188); disconnect() must match it.
  it('clears pendingEvaluatorClarify on a background session (parity with onclose)', async () => {
    await openConnected()

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: {
          messages: [],
          streamingMessageId: null,
          isPlanPending: false,
          planAllowedPrompts: [],
          pendingEvaluatorClarify: null,
          inactivityWarning: null,
        },
        b: {
          messages: [],
          streamingMessageId: null,
          isPlanPending: false,
          planAllowedPrompts: [],
          pendingEvaluatorClarify: { question: 'why?' },
          inactivityWarning: null,
        },
      } as never,
    })

    useConnectionStore.getState().disconnect()

    expect(useConnectionStore.getState().sessionStates.b!.pendingEvaluatorClarify).toBeNull()
  })

  // #7411/#8148 — the same shared-list parity guard as the onclose describe
  // above, run against disconnect() instead.
  it('parity guard: clears every TRANSIENT_SESSION_SWEEP_FIELDS field on a background session', async () => {
    await openConnected()
    type SweepField = (typeof TRANSIENT_SESSION_SWEEP_FIELDS)[number]
    const DIRTY: Record<SweepField, unknown> = {
      streamingMessageId: 'msg-b',
      isPlanPending: true,
      planAllowedPrompts: ['go'],
      inactivityWarning: { sinceMs: 1 },
      sessionRole: 'observer',
      primaryClientId: 'other-device',
    }
    const CLEAN: Record<SweepField, unknown> = {
      streamingMessageId: null,
      isPlanPending: false,
      planAllowedPrompts: [],
      inactivityWarning: null,
      sessionRole: null,
      primaryClientId: null,
    }
    expect(Object.keys(DIRTY).sort()).toEqual([...TRANSIENT_SESSION_SWEEP_FIELDS].sort())
    for (const field of TRANSIENT_SESSION_SWEEP_FIELDS) expect(DIRTY[field], field).not.toEqual(CLEAN[field])

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: { messages: [], pendingEvaluatorClarify: null, ...CLEAN },
        b: { messages: [], pendingEvaluatorClarify: null, ...DIRTY },
      } as never,
    })

    useConnectionStore.getState().disconnect()

    const b = useConnectionStore.getState().sessionStates.b as unknown as Record<string, unknown>
    for (const field of TRANSIENT_SESSION_SWEEP_FIELDS) {
      expect(b[field], field).toEqual(CLEAN[field])
    }
  })
})

// ---------------------------------------------------------------------------
// #6153 — onclose resets every Control Room survey *Loading flag. A refresh in
// flight when the socket drops would otherwise leave loading=true forever, and
// refreshDisabled = loading || !connected wedges the disabled Refresh button
// (it can't issue the request that would clear it) until a full remount.
// ---------------------------------------------------------------------------

describe('onclose resets Control Room survey loading flags (#6153)', () => {
  it('clears every *StatusLoading that was true; keeps the (stale) snapshots', async () => {
    const ws = await openConnected()

    useConnectionStore.setState({
      hostStatusLoading: true,
      runnerStatusLoading: true,
      containersStatusLoading: true,
      repoRuntimeConfigLoading: true,
      byokPoolStatusLoading: true,
      hostPruneStatusLoading: true,
      simulatorStatusLoading: true,
      emulatorStatusLoading: true,
      integrationStatusLoading: true,
      skillsInventoryLoading: true,
      mailboxStatusLoading: true,
      // a stale snapshot that must SURVIVE the drop (re-fetched on reconnect)
      hostPruneStatus: { type: 'host_prune_status_snapshot', generatedAt: '2026-06-20T00:00:00.000Z', dockerAvailable: true, note: null, containers: [], images: [], summary: { containerCount: 0, imageCount: 0, reclaimableBytes: 0 } },
    } as never)

    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)

    const st = useConnectionStore.getState()
    expect(st.hostStatusLoading).toBe(false)
    expect(st.runnerStatusLoading).toBe(false)
    expect(st.containersStatusLoading).toBe(false)
    expect(st.repoRuntimeConfigLoading).toBe(false)
    expect(st.byokPoolStatusLoading).toBe(false)
    expect(st.hostPruneStatusLoading).toBe(false)
    expect(st.simulatorStatusLoading).toBe(false)
    expect(st.emulatorStatusLoading).toBe(false)
    expect(st.integrationStatusLoading).toBe(false)
    expect(st.skillsInventoryLoading).toBe(false)
    expect(st.mailboxStatusLoading).toBe(false)
    // The snapshot is intentionally retained (staleness is signalled in the UI).
    expect(st.hostPruneStatus).not.toBeNull()
  })
})
