/**
 * #7557 / #7559 — the CONNECTION lifetime, driven through the real store.
 *
 * The source axis lives in `session-destroy-prunes-pr-maps.test.ts`'s
 * `#7488 connection lifetime` describe: it reads `connection.ts` and asks, of
 * every `NOT_SESSION_KEYED` member, where the field dies. This file asks the
 * same question of the STORE — populate a field as server A, run the action, and
 * look. A source grep cannot see a clear that runs at the wrong time, and a
 * behavioural test cannot see a field nobody thought to list, so the two axes
 * are complements rather than duplicates.
 *
 * ## #7557 — eleven maps cleared by nothing
 *
 * `orchestration*` / `scheduledTask*` / `credentialTestResults` /
 * `pendingPairRequests` / `serverStartupLogs`: an initial `{}` at construction,
 * additive writes from a handler, and no clear on ANY lifecycle path — not
 * `forgetSession`, not `_resetSessionMemory`, not `disconnect()`, not `auth_ok`.
 * The hazard is a WRONG VALUE across a SERVER SWITCH, and the key spaces are
 * what make it reachable:
 *
 *   * `runId`s are minted per daemon and are not the 16 random bytes a session
 *     id is, so server A's held run detail (and its error / stale flags) can
 *     surface under server B's run list.
 *   * `credentialTestResults` is keyed by credential key (`anthropic`,
 *     `openai`, …) — IDENTICAL on every daemon by construction. A green "test
 *     passed" from server A renders against server B, where the credential may
 *     be absent or wrong.
 *   * `serverStartupLogs` is one daemon's startup output rendered without
 *     provenance: after a switch the operator reads server A's failure while
 *     looking at server B.
 *   * `pendingPairRequests` is the security-shaped one. It is an approve/deny
 *     prompt for a device that asked ANOTHER daemon to pair, and `deviceName` is
 *     attacker-controlled. Approving it is a decision the operator makes about
 *     the daemon they believe they are looking at.
 *
 * The twelfth field of that issue, `infoNotifications`, is adjudicated onto
 * `disconnect()` instead — see its describe below for why, and for the #7528
 * precedent it is measured against.
 *
 * ## #7559 — the switch that skipped the clears
 *
 * `switchServer` / `connectLocal` call `disconnect()` only
 * `if (get().connectionPhase !== 'disconnected')`. One route reaches
 * `'disconnected'` with the previous server's state intact — a FAILED CONNECT —
 * and this file drives the real one (`auth_fail`) rather than asserting a phase
 * string into place. `server_down` is its own phase (so `disconnect()` DOES
 * run) and a user Disconnect has already cleared everything, which is why
 * neither appears here (#7564 review).
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

vi.mock('../utils/auth', () => ({ getAuthToken: () => 'local-token' }))

const { useConnectionStore } = await import('./connection')
const { createEmptyConnectionScope } = await import('./utils')

/**
 * The roster the fix spreads, derived from the factory itself. The independent
 * statement of what it must CONTAIN is `ROSTER_EXPECTED` below — without that
 * pin, deleting a field from the factory would silently delete its cell here
 * rather than turn one red.
 */
const CONNECTION_SCOPED_RESET_FIELDS: readonly string[] = Object.keys(createEmptyConnectionScope())
const {
  handleMessage, stopHeartbeat, clearDeltaBuffers, clearPermissionSplits, resetReplayFlags,
  // #7578 — the module-level connection-scoped trackers `_resetSessionMemory`
  // now clears. They are NOT store fields, so `CONNECTION_SCOPED_RESET_FIELDS`
  // cannot reach them — they get their own describe below.
  enqueueMessage, clearMessageQueue, _testQueueInternals,
  resetTranscriptFetchTracking, beginTranscriptFetch, endTranscriptFetch,
} = await import('./message-handler')
// #7578 fold — the namespace, so `vi.spyOn(mh, 'clearDeltaBuffers')` intercepts
// the call `connection.ts` makes through the SAME live module binding (verified:
// a spy set here is observed by `disconnect()` / `_resetSessionMemory`). Used for
// the delta buffers, which expose no state getter; the terminal buffer is
// observed by its flush effect instead.
const mh = await import('./message-handler')
// Cursors live in store-core; `resetReplayReconcile` is shared by both clients.
const { recordHistorySeq, getHistoryCursors, resetReplayReconcile } =
  await import('@chroxy/store-core')
const { resetSchedulerRequestsForTest, hasPendingSchedulerRequests, SCHEDULER_DISCONNECT_ERROR } =
  await import('./scheduledTaskRequests')

type State = ReturnType<typeof useConnectionStore.getState>

/**
 * #7557's eleven, written out rather than derived from the fix, so deleting a
 * clear from `connection.ts` cannot also delete this test's opinion about it.
 */
const ELEVEN = [
  'orchestrationPendingActions',
  'orchestrationActionResults',
  'scheduledTaskPendingActions',
  'scheduledTaskActionResults',
  'orchestrationRunDetails',
  'orchestrationRunDetailErrors',
  'orchestrationRunDetailStale',
  'orchestrationRunDetailLoading',
  'credentialTestResults',
  'pendingPairRequests',
  'serverStartupLogs',
] as const

/**
 * #7572 — two of the eleven are TRANSIENT in-flight request markers, not records
 * of the daemon: an `orchestration_run_detail` request whose reply can never
 * arrive on the dropped socket (a stuck spinner) and a pending mutating action
 * awaiting an ack that will never come. The socket's `onclose` handler already
 * clears them on a transport drop (#6691 S-3), but a USER-initiated `disconnect()`
 * nulls `socket.onclose` first to suppress auto-reconnect, so `onclose` never
 * runs — and neither `auth_ok`'s non-reconnect branch nor `connect()` touches
 * them on a same-server Disconnect → Connect. So `disconnect()` clears them with
 * an explicit `set()` literal in its own payload.
 */
const DISCONNECT_CLEARS_VIA_SET = [
  'orchestrationRunDetailLoading',
  'orchestrationPendingActions',
] as const

/**
 * `scheduledTaskPendingActions` is ALSO emptied by a user `disconnect()`, but by
 * a DIFFERENT mechanism than the two above: `disconnect()` calls
 * `failAllSchedulerRequests(SCHEDULER_DISCONNECT_ERROR)`, which sweeps the
 * MODULE-LEVEL scheduler registry and fires each armed request's onFail →
 * `releaseScheduledTaskRequest`, deleting the id from this map (and recording a
 * failure reason in `scheduledTaskActionResults`). It has no explicit `set()`
 * literal in `disconnect()`'s payload, so it is verified in its own describe
 * below — and that describe must ARM the registry, because the sweep early-returns
 * on an empty registry and a map-only seed would pass VACUOUSLY (#7573 review).
 */
const DISCONNECT_DRAINS_VIA_REGISTRY = ['scheduledTaskPendingActions'] as const

const CLEARED_BY_DISCONNECT = new Set<string>([
  ...DISCONNECT_CLEARS_VIA_SET,
  ...DISCONNECT_DRAINS_VIA_REGISTRY,
])

/**
 * The eight that stay TRUE of the same daemon across a Disconnect → Connect to
 * the SAME server (records, not in-flight markers) — a credential verdict, a held
 * run detail and its error/stale flags, the orchestration and scheduler action
 * RESULTS (terminal outcomes the panel renders), a pairing request the daemon
 * still has open, the startup log the operator is reading. `disconnect()` never
 * EMPTIES any of these (the scheduler drain only ADDS a failure result); only the
 * three in the two sets above are cleared (#7572).
 */
const DISCONNECT_PRESERVES = ELEVEN.filter((f) => !CLEARED_BY_DISCONNECT.has(f))

/**
 * #7559's sixteen, quoted from the issue body, plus `infoNotifications` (#7557).
 * The roster in `utils.ts` is what the fix actually spreads; this list is the
 * independent statement of what it must contain, so a field DELETED from the
 * roster goes red here instead of quietly leaving every per-field cell below
 * with nothing to iterate.
 */
const ROSTER_EXPECTED = [
  'permissionInputs', 'resolvedPermissions', 'serverCapabilities', 'availableProviders',
  'availableModels', 'availablePermissionModes', 'connectedClients', 'webTasks',
  'slashCommands', 'filePickerFiles', 'mcpResources', 'customAgents', 'conversationHistory',
  'searchResults', 'checkpoints', 'environments',
  'infoNotifications',
  // #7625 — the parked failed-restore roster. Per daemon: the rows name
  // sessions on the OLD server and carry its absolute host paths.
  'failedRestores',
] as const

/** Server A's values, one distinguishable marker per field. */
function serverAState(): Record<string, unknown> {
  return {
    // ---- #7557's eleven ----------------------------------------------
    orchestrationPendingActions: { 'req-a1': { kind: 'start', runId: 'run-a', at: 1 } },
    orchestrationActionResults: { 'req-a1': { ok: true, error: null, at: 2 } },
    scheduledTaskPendingActions: { 'req-a2': { kind: 'save', taskId: 'task-a', at: 3 } },
    scheduledTaskActionResults: { 'req-a2': { ok: true, error: null, at: 4 } },
    orchestrationRunDetails: { 'run-a': { detail: { runId: 'run-a', status: 'running' }, seq: 7 } },
    orchestrationRunDetailErrors: { 'run-a': { code: 'E_A', message: 'from server A' } },
    orchestrationRunDetailStale: { 'run-a': true },
    orchestrationRunDetailLoading: new Set(['run-a']),
    credentialTestResults: { anthropic: { ok: true, error: null, model: 'a-model', latencyMs: 12 } },
    pendingPairRequests: [
      { type: 'pair_pending', requestId: 'pair-a', deviceName: "Someone else's iPhone", verifyCode: '123456', expiresAt: 9_999_999 },
    ],
    serverStartupLogs: ['server A: failed to bind port 8765'],

    // ---- #7559's roster ----------------------------------------------
    permissionInputs: { 'req-a3': { content: 'half-typed reply to server A' } },
    resolvedPermissions: { 'req-a3': 'allow' },
    serverCapabilities: { fileOps: true, teleport: true },
    availableProviders: [{ name: 'claude-a', displayName: 'A' }],
    availableModels: [{ id: 'model-a', fullId: 'a/model-a', name: 'A' }],
    availablePermissionModes: [{ id: 'yolo-a', label: 'Server A only mode' }],
    connectedClients: [{ clientId: 'client-a', deviceName: 'A' }],
    webTasks: [{ taskId: 'task-a', status: 'running' }],
    slashCommands: [{ name: 'a-command', source: 'project' }],
    filePickerFiles: [{ path: '/only/on/server-a', type: 'file' }],
    mcpResources: [{ uri: 'mcp://server-a/thing' }],
    customAgents: [{ name: 'agent-a', source: 'project' }],
    conversationHistory: [{ conversationId: 'conv-a', summary: 'server A transcript' }],
    searchResults: [{ conversationId: 'conv-a', snippet: 'from server A' }],
    checkpoints: [{ id: 'ckpt-a', label: 'A' }],
    environments: [{ id: 'env-a', name: 'A', sessions: ['sess-a'] }],
    failedRestores: [{
      sessionId: 'sess-parked-a', name: 'Parked A', provider: 'claude',
      cwd: '/srv/a', errorCode: 'ENVIRONMENT_STOPPED', errorMessage: 'down', historyLength: 3,
    }],
    infoNotifications: [{ id: 'info-a', category: 'general', message: 'server A: update available', recoverable: true, timestamp: 1 }],
  }
}

/** Empty for THIS field's shape: `{}` / `[]` / empty Set / `null`. */
function isEmptyValue(v: unknown): boolean {
  if (v === null) return true
  if (v instanceof Set) return v.size === 0
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as object).length === 0
  return false
}

function populated(field: string): boolean {
  return !isEmptyValue((useConnectionStore.getState() as unknown as Record<string, unknown>)[field])
}

function readField(field: string): unknown {
  return (useConnectionStore.getState() as unknown as Record<string, unknown>)[field]
}

function seedServerA(extra: Partial<State> = {}) {
  useConnectionStore.setState({ ...serverAState(), ...extra } as unknown as Partial<State>)
}

function resetSlice() {
  useConnectionStore.setState({
    ...createEmptyConnectionScope(),
    orchestrationPendingActions: {},
    orchestrationActionResults: {},
    scheduledTaskPendingActions: {},
    scheduledTaskActionResults: {},
    orchestrationRunDetails: {},
    orchestrationRunDetailErrors: {},
    orchestrationRunDetailStale: {},
    orchestrationRunDetailLoading: new Set<string>(),
    credentialTestResults: {},
    pendingPairRequests: [],
    serverStartupLogs: null,
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    wsUrl: null,
    socket: null,
  } as unknown as Partial<State>)
}

beforeEach(() => {
  clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
  resetSchedulerRequestsForTest()
  for (const k of Object.keys(lsStore)) delete lsStore[k]
  resetSlice()
})
afterEach(() => { stopHeartbeat(); resetSlice(); resetSchedulerRequestsForTest(); vi.restoreAllMocks() })

// ---------------------------------------------------------------------------
// #7557 — the eleven, per field, per full-reset site.
// ---------------------------------------------------------------------------

describe.each([
  ['forgetSession', () => useConnectionStore.getState().forgetSession()],
  ['_resetSessionMemory', () => useConnectionStore.getState()._resetSessionMemory()],
])('#7557 %s clears the eleven never-cleared connection maps', (_site, run) => {
  beforeEach(() => { seedServerA() })

  it('control: the fixture populated all eleven first', () => {
    // Without this, every "empty afterwards" cell below passes for free against a
    // fixture that never landed — the negative-assertion trap.
    const unpopulated = ELEVEN.filter((f) => !populated(f))
    expect(unpopulated, 'the fixture did not populate these, so their clears prove nothing').toEqual([])
  })

  // PER FIELD, so clearing ten of eleven names the eleventh rather than reporting
  // one vague red.
  it.each(ELEVEN)('clears %s', (field) => {
    expect(populated(field), 'control: populated before the action').toBe(true)
    run()
    expect(isEmptyValue(readField(field)), `${field} survived the reset (#7557)`).toBe(true)
  })

  it('the run-detail family goes together — a held detail with no loading flag is a stuck spinner', () => {
    run()
    const s = useConnectionStore.getState()
    expect(s.orchestrationRunDetails).toEqual({})
    expect(s.orchestrationRunDetailErrors).toEqual({})
    expect(s.orchestrationRunDetailStale).toEqual({})
    expect(s.orchestrationRunDetailLoading.size).toBe(0)
  })
})

describe('#7557/#7572 the adjudication: disconnect() clears the in-flight markers, keeps the record fields', () => {
  // Decided per field rather than by analogy, which is what #7557 asked for.
  // EIGHT of the eleven are still TRUE of the SAME daemon across a
  // Disconnect → Connect: a credential verdict, a held run detail and its
  // error/stale flags, the orchestration + scheduler action RESULTS, a pairing
  // request the daemon still has open, the startup log the operator is reading
  // to find out why the daemon died. `disconnect()` never EMPTIES those, so it
  // is not where they die — the two full-reset sites are.
  //
  // Two of the exceptions are #7572: `orchestrationRunDetailLoading` and
  // `orchestrationPendingActions` are TRANSIENT in-flight markers (a reply that
  // can never arrive on the dropped socket), not records of the daemon. The
  // socket's `onclose` clears them on a transport drop (#6691 S-3), but a USER
  // disconnect nulls `socket.onclose` first, so `disconnect()` must clear them
  // itself or a stuck spinner / stale pending-action survives a same-server
  // reconnect. They are still cleared at BOTH full-reset sites too — the
  // describe.each above proves that — so this is an ADDITIONAL clear, not a move
  // out of that set.
  //
  // The THIRD field emptied by disconnect(), `scheduledTaskPendingActions`, is
  // NOT iterated here: it is drained by the scheduler-registry sweep rather than
  // an explicit `set()` literal, and asserting it here would be VACUOUS because
  // `seedServerA` seeds the store map without arming the registry the sweep
  // iterates. Its own describe below arms the registry and proves the drain.
  //
  // serverStartupLogs has a same-server wrinkle worth stating precisely (#7573
  // review, C3): the Tauri `server_error` listener calls disconnect() and THEN
  // fetches the logs (`useTauriEvents.ts` server_error handler), so a clear at
  // disconnect() would be OVERWRITTEN by that fetch, not raced by it — there is
  // no race in that direction. The real reason it must survive disconnect() is a
  // LATER `server_stopped` → disconnect() (no accompanying fetch), which would
  // erase logs already on screen.
  //
  // This is also the mutant-detector for the opposite mistake: moving the NINE
  // into `createEmptyConnectionScope()` (where the #7559 roster lives) would
  // clear them here and turn every PRESERVES cell in this describe red.
  beforeEach(() => { seedServerA({ connectionPhase: 'connected' } as Partial<State>) })

  it('control: the fixture populated all eleven first', () => {
    // Without this, every "empty afterwards" / "still here afterwards" cell below
    // passes for free against a fixture that never landed.
    const unpopulated = ELEVEN.filter((f) => !populated(f))
    expect(unpopulated, 'the fixture did not populate these, so the cells below prove nothing').toEqual([])
  })

  it.each(DISCONNECT_PRESERVES)('disconnect() leaves %s alone', (field) => {
    expect(populated(field), 'control: populated before the disconnect').toBe(true)
    useConnectionStore.getState().disconnect()
    expect(populated(field), `${field} is now cleared by disconnect() — re-read the #7557 adjudication`).toBe(true)
  })

  it.each(DISCONNECT_CLEARS_VIA_SET)('disconnect() CLEARS %s (#7572)', (field) => {
    expect(populated(field), 'control: populated before the disconnect').toBe(true)
    useConnectionStore.getState().disconnect()
    expect(
      isEmptyValue(readField(field)),
      `${field} survived a USER disconnect() — a stuck orchestration spinner / stale pending-action ` +
      'persists across a same-server Disconnect → Connect because disconnect() nulls socket.onclose ' +
      'before the #6691 onclose reset can run (#7572)',
    ).toBe(true)
  })

  it('POSITIVE CONTROL: the same disconnect() DOES clear a roster member', () => {
    // Otherwise the CLEARS cells above would pass against a `disconnect()` that
    // had stopped clearing anything at all.
    useConnectionStore.getState().disconnect()
    expect(useConnectionStore.getState().serverCapabilities).toEqual({})
  })

  it('POSITIVE CONTROL (#7557): the fix did NOT become a blanket wipe of the eleven', () => {
    // The counterpart of the CLEARS cells: a representative #7557 RECORD survives
    // the same disconnect(), so clearing the in-flight markers cannot have
    // regressed into clearing the eight records that must persist (#7557/#7559).
    useConnectionStore.getState().disconnect()
    const s = useConnectionStore.getState()
    expect(s.orchestrationRunDetails, 'a held run detail is a record and must survive disconnect()')
      .toEqual({ 'run-a': { detail: { runId: 'run-a', status: 'running' }, seq: 7 } })
    expect(s.credentialTestResults, 'a credential verdict is a record and must survive disconnect()')
      .not.toEqual({})
  })
})

describe('#7572/#6871 the scheduler drain: disconnect() empties scheduledTaskPendingActions via the registry sweep', () => {
  // `scheduledTaskPendingActions` is emptied by a user `disconnect()`, but NOT by
  // an explicit `set()` literal like the two orchestration markers above. It is
  // DRAINED: `disconnect()` calls `failAllSchedulerRequests(SCHEDULER_DISCONNECT_ERROR)`
  // (connection.ts), which sweeps the MODULE-LEVEL scheduler registry and fires
  // each armed request's onFail → `releaseScheduledTaskRequest`, DELETING the id
  // from this map and recording a terminal failure reason in
  // `scheduledTaskActionResults`.
  //
  // The sweep EARLY-RETURNS on an empty registry, so seeding the store map alone
  // — the way `seedServerA` does — makes any "cleared afterwards" assertion
  // VACUOUS: it would stay green even if the real drain regressed (#7573 review,
  // finding #2). Every PRODUCTION pending action is armed at the same moment it
  // is written to the map (`sendScheduledTaskAction` / `setSchedulerEnabled`), so
  // this drives the REAL sender to re-create that invariant before disconnecting,
  // rather than hand-seeding an unarmed entry that cannot occur in production.
  let openSocket: WebSocket

  beforeEach(() => {
    resetSchedulerRequestsForTest()
    openSocket = { send: vi.fn(), close: vi.fn(), readyState: 1, onclose: null } as unknown as WebSocket
    useConnectionStore.setState({
      connectionPhase: 'connected',
      socket: openSocket,
      scheduledTaskPendingActions: {},
      // A PRE-EXISTING terminal result, to prove the drain ADDS to this map rather
      // than replacing it (the drain writes results; it must not erase records).
      scheduledTaskActionResults: { 'req-old': { ok: true, error: null, at: 4 } },
    } as unknown as Partial<State>)
  })

  afterEach(() => { resetSchedulerRequestsForTest() })

  it('control: the real sender ARMS the registry and writes the pending action', () => {
    // Without this the drain cell below is vacuous — it must be draining a genuinely
    // armed request, not an empty registry.
    const reqId = useConnectionStore.getState().sendScheduledTaskAction('create', { task: { name: 'nightly' } as never })
    expect(reqId, 'the real sender rejected the open socket — check the WebSocket.OPEN readyState').toBeTruthy()
    expect(hasPendingSchedulerRequests(), 'the request was not armed in the scheduler registry').toBe(true)
    expect(Object.keys(useConnectionStore.getState().scheduledTaskPendingActions)).toEqual([reqId])
  })

  it('disconnect() drains the ARMED pending action and sweeps the registry (non-vacuous)', () => {
    const reqId = useConnectionStore.getState().sendScheduledTaskAction('create', { task: { name: 'nightly' } as never })
    expect(reqId).toBeTruthy()
    expect(hasPendingSchedulerRequests(), 'armed precondition').toBe(true)

    useConnectionStore.getState().disconnect()

    const s = useConnectionStore.getState()
    // The pending action is GONE — otherwise it is a "Saving…" row stuck across a
    // same-server reconnect. This fails RED if disconnect() stops calling
    // failAllSchedulerRequests: the armed onFail never fires and the entry survives.
    expect(
      s.scheduledTaskPendingActions,
      'the armed scheduler pending action survived disconnect() — the registry sweep did not run',
    ).toEqual({})
    // …and the registry itself was swept, so no 30s watchdog fires later.
    expect(hasPendingSchedulerRequests(), 'the scheduler registry was not swept by disconnect()').toBe(false)
    // The drain ADDS a terminal failure keyed by the drained requestId…
    expect(s.scheduledTaskActionResults[reqId!]).toMatchObject({ ok: false, error: SCHEDULER_DISCONNECT_ERROR })
    // …and does NOT erase the pre-existing record (it adds; it does not clear).
    expect(
      s.scheduledTaskActionResults['req-old'],
      'the drain erased a pre-existing scheduler result — it must only ADD to this map',
    ).toMatchObject({ ok: true })
  })
})

describe('#7557 infoNotifications — the twelfth field, adjudicated against #7528', () => {
  // #7528 ruled that a notification row is a RECORD and must survive the SESSION
  // it describes. That is about session death, and nothing here prunes this map
  // on a roster wipe, so the precedent is untouched. The CONNECTION is a
  // different boundary, and the store already answered it for the two siblings
  // rendered in the same banner list.
  beforeEach(() => { seedServerA({ connectionPhase: 'connected', serverErrors: [{ id: 'err-a', category: 'general', message: 'A', recoverable: true, timestamp: 1 }], sessionNotifications: [{ id: 'note-a', sessionId: 'sess-a', kind: 'error', message: 'A', timestamp: 1 }] } as unknown as Partial<State>) })

  it('PRECEDENT: disconnect() already clears its two banner siblings', () => {
    // The fact the adjudication rests on, asserted rather than asserted-in-prose.
    expect(useConnectionStore.getState().serverErrors).toHaveLength(1)
    expect(useConnectionStore.getState().sessionNotifications).toHaveLength(1)
    useConnectionStore.getState().disconnect()
    expect(useConnectionStore.getState().serverErrors).toEqual([])
    expect(useConnectionStore.getState().sessionNotifications).toEqual([])
  })

  it('disconnect() clears infoNotifications too', () => {
    expect(useConnectionStore.getState().infoNotifications).toHaveLength(1)
    useConnectionStore.getState().disconnect()
    expect(useConnectionStore.getState().infoNotifications).toEqual([])
  })

  it('a session roster wipe does NOT prune it — the #7528 precedent, held', () => {
    // The half of #7528 that must keep working: notification history is not
    // session-scoped state and a roster wipe is not a connection boundary.
    useConnectionStore.getState().forgetSession()
    expect(
      useConnectionStore.getState().infoNotifications,
      'forgetSession pruned notification history — that is the thing #7528 decided against',
    ).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// #7559 — the switch made from an already-disconnected tab.
// ---------------------------------------------------------------------------

describe('#7559 the shared roster is the one both issues describe', () => {
  it('createEmptyConnectionScope() holds exactly the sixteen plus infoNotifications', () => {
    expect([...CONNECTION_SCOPED_RESET_FIELDS].sort()).toEqual([...ROSTER_EXPECTED].sort())
  })

  it('every roster field is in the fixture, so the per-field cells below are real', () => {
    const fixture = serverAState()
    const missing = CONNECTION_SCOPED_RESET_FIELDS.filter((f) => !(f in fixture))
    expect(missing, 'a roster field the fixture never populates would pass its clear cell for free').toEqual([])
  })
})

describe.each([
  ['switchServer', (id: string) => useConnectionStore.getState().switchServer(id)],
  ['connectLocal', (_id: string) => useConnectionStore.getState().connectLocal()],
])('#7559 %s from connectionPhase disconnected still clears the roster', (_name, run) => {
  let serverBId = ''

  beforeEach(() => {
    // #6063 — stub the network-touching `connect` so the switch paths never open
    // a real WebSocket; the thing under test is the synchronous state these
    // actions leave BEHIND before they delegate.
    useConnectionStore.setState({ connect: vi.fn() } as unknown as Partial<State>)
    const a = useConnectionStore.getState().addServer('A', 'wss://server-a/ws', 'tok-a')
    const b = useConnectionStore.getState().addServer('B', 'wss://server-b/ws', 'tok-b')
    serverBId = b.id
    seedServerA({ activeServerId: a.id, connectionPhase: 'disconnected', socket: null } as unknown as Partial<State>)
  })

  it('control: the tab really is at disconnected with server A state loaded', () => {
    const s = useConnectionStore.getState()
    expect(s.connectionPhase).toBe('disconnected')
    const unpopulated = CONNECTION_SCOPED_RESET_FIELDS.filter((f) => !populated(f))
    expect(unpopulated, 'fixture did not populate these roster fields').toEqual([])
  })

  it.each([...CONNECTION_SCOPED_RESET_FIELDS])('clears %s', (field) => {
    expect(populated(field), 'control: populated before the switch').toBe(true)
    run(serverBId)
    expect(
      isEmptyValue(readField(field)),
      `${field} survived a switch made from the disconnected phase — server A's value is now ` +
      "rendered as server B's (#7559)",
    ).toBe(true)
  })

  it('POSITIVE CONTROL: the switch from a CONNECTED tab still clears them (the path that worked)', () => {
    // So the fix cannot be "delete the phase guard and hope": this is the route
    // `disconnect()` already covered, and it must keep working.
    const closed = vi.fn()
    useConnectionStore.setState({
      connectionPhase: 'connected',
      socket: { close: closed, readyState: 1 } as unknown as WebSocket,
    } as unknown as Partial<State>)
    run(serverBId)
    const survivors = CONNECTION_SCOPED_RESET_FIELDS.filter((f) => populated(f))
    expect(survivors).toEqual([])
    expect(closed, 'the phase guard still lets disconnect() tear the socket down').toHaveBeenCalled()
  })

  it('the eleven #7557 maps go with them on this path too', () => {
    run(serverBId)
    const survivors = ELEVEN.filter((f) => populated(f))
    expect(survivors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// #7578 — the MODULE-LEVEL connection-scoped trackers.
//
// `CONNECTION_SCOPED_RESET_FIELDS` above is store state; these three are not.
// They live in `message-handler.ts` (the outgoing message queue, the
// transcript-fetch tracking) and store-core (the replay history cursors), and
// `disconnect()` clears all three — but a switch from an already-disconnected
// tab skipped `disconnect()`, so they crossed into the next server. The
// outgoing MESSAGE QUEUE is the leak #7578 filed: a prompt queued while
// disconnected drained onto server B. Same shape as #7559, one indirection over.
// ---------------------------------------------------------------------------
describe.each([
  ['switchServer', (id: string) => useConnectionStore.getState().switchServer(id)],
  ['connectLocal', (_id: string) => useConnectionStore.getState().connectLocal()],
])('#7578 %s from connectionPhase disconnected clears the module-level trackers', (_name, run) => {
  let serverBId = ''
  const TRANSCRIPT_ID = 'conv-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  beforeEach(() => {
    // #6063 — stub the network-touching `connect` so the switch never opens a
    // real socket; the thing under test is the synchronous teardown that runs
    // BEFORE `connect` is delegated to.
    useConnectionStore.setState({ connect: vi.fn() } as unknown as Partial<State>)
    const a = useConnectionStore.getState().addServer('A', 'wss://server-a/ws', 'tok-a')
    const b = useConnectionStore.getState().addServer('B', 'wss://server-b/ws', 'tok-b')
    serverBId = b.id
    seedServerA({ activeServerId: a.id, connectionPhase: 'disconnected', socket: null } as unknown as Partial<State>)
    // Server A's module-level trackers, each with a distinguishable marker.
    clearMessageQueue()
    enqueueMessage('input', { type: 'input', content: 'prompt meant for server A' })
    resetReplayReconcile({ clearCursors: true })
    recordHistorySeq('sess-a', 42)
    resetTranscriptFetchTracking()
    beginTranscriptFetch(TRANSCRIPT_ID)
  })

  afterEach(() => {
    clearMessageQueue()
    resetReplayReconcile({ clearCursors: true })
    resetTranscriptFetchTracking()
    clearDeltaBuffers()
    mh.clearTerminalWriteBatching()
  })

  it('control: the trackers really are populated as server A before the switch', () => {
    expect(useConnectionStore.getState().connectionPhase).toBe('disconnected')
    expect(_testQueueInternals.getQueue()).toHaveLength(1)
    expect(getHistoryCursors()).toEqual({ 'sess-a': 42 })
  })

  it('the outgoing message queue does not survive into server B (#7578)', () => {
    expect(_testQueueInternals.getQueue(), 'control: queued before the switch').toHaveLength(1)
    run(serverBId)
    expect(
      _testQueueInternals.getQueue(),
      "server A's queued prompt survived a switch made from the disconnected phase and would " +
        'drain onto server B (#7578)',
    ).toEqual([])
  })

  it('the replay history cursors do not survive into server B', () => {
    expect(getHistoryCursors(), 'control: cursor recorded before the switch').toEqual({ 'sess-a': 42 })
    run(serverBId)
    expect(
      getHistoryCursors(),
      "server A's replay cursor survived the switch and would be sent in server B's auth handshake",
    ).toEqual({})
  })

  it('an in-flight transcript fetch does not keep intercepting frames after the switch', () => {
    run(serverBId)
    // The user opens that same transcript on server B. If server A's pending
    // fetch survived, `isTranscriptFramePending` still returns true for this id,
    // so a server-B frame is diverted into the transcript viewer.
    useConnectionStore.setState({
      transcriptViewer: { conversationId: TRANSCRIPT_ID, status: 'loading', messages: [], error: null },
    } as unknown as Partial<State>)
    handleMessage(
      { type: 'message', messageType: 'user_input', content: 'a server B frame', sessionId: TRANSCRIPT_ID, timestamp: 100 },
      { url: 'wss://server-b/ws', token: 'tok-b', socket: { readyState: 1 }, isReconnect: false, silent: true } as never,
    )
    expect(
      useConnectionStore.getState().transcriptViewer.messages,
      "server A's pending transcript fetch intercepted a server B frame (a stale conversationId " +
        'that must not survive the switch)',
    ).toHaveLength(0)
    endTranscriptFetch(TRANSCRIPT_ID)
  })

  it('an open transcript VIEWER does not survive into server B (#7578)', () => {
    // The STORE-FIELD sibling of the transcript-fetch tracking above: a past
    // conversation left open on server A. Its `conversationId` is minted per
    // daemon, so it renders meaningless content against server B. `disconnect()`
    // resets this slice (connection.ts ~L3251); `_resetSessionMemory` must too.
    useConnectionStore.setState({
      transcriptViewer: {
        conversationId: 'conv-server-a',
        status: 'ready',
        messages: [{ id: 'm-a', type: 'user_input', content: 'server A transcript', timestamp: 1 }],
        error: null,
      },
    } as unknown as Partial<State>)
    run(serverBId)
    expect(
      useConnectionStore.getState().transcriptViewer,
      "server A's open transcript stayed on screen after a switch made from the disconnected " +
        "phase — its conversationId is meaningless on server B (#7578)",
    ).toEqual({ conversationId: null, status: 'idle', messages: [], error: null })
  })

  it('the un-flushed streaming DELTA buffers are torn down on the switch (#7578)', () => {
    // No state getter is exported for `deltaFlusher.pendingDeltas` /
    // `_deltaServerTs`, so observe the teardown the way the module allows: spy
    // the exact function `disconnect()` uses (call-through), and assert the
    // switch invokes it. Installed AFTER the top-level beforeEach's own
    // `clearDeltaBuffers()`, so the pre-run count is a true zero.
    const spy = vi.spyOn(mh, 'clearDeltaBuffers')
    expect(spy, 'control: not called before the switch').not.toHaveBeenCalled()
    run(serverBId)
    expect(
      spy,
      "server A's un-flushed streaming deltas were not torn down on the switch — they could flush " +
        'into server B (#7578)',
    ).toHaveBeenCalled()
  })

  it("server A's batched TERMINAL writes do not flush into server B (#7578)", () => {
    // The observable proof: `clearTerminalWriteBatching()` drops the buffered
    // bytes AND the ~50ms coalescing timer. Seed server A's partial bytes, run
    // the switch, then let the timer fire — a flush would deliver them through
    // `_terminalWriteCallback` (which `_resetSessionMemory` does NOT null, so it
    // survives the switch and the observation is real, not masked).
    vi.useFakeTimers()
    try {
      const flushed: string[] = []
      useConnectionStore.setState({
        _terminalWriteCallback: (d: string) => { flushed.push(d) },
      } as unknown as Partial<State>)
      mh.appendPendingTerminalWrite('server A partial terminal bytes')
      run(serverBId)
      vi.advanceTimersByTime(200) // well past the 50ms window
      expect(
        flushed,
        "server A's batched terminal bytes flushed after the switch — they would land in server " +
          "B's terminal (#7578)",
      ).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('POSITIVE CONTROL: the switch from a CONNECTED tab still clears the trackers (the path disconnect() covered)', () => {
    const closed = vi.fn()
    useConnectionStore.setState({
      connectionPhase: 'connected',
      socket: { close: closed, readyState: 1 } as unknown as WebSocket,
    } as unknown as Partial<State>)
    run(serverBId)
    expect(_testQueueInternals.getQueue(), 'the connected-tab path still drops the queue').toEqual([])
    expect(getHistoryCursors(), 'the connected-tab path still drops the cursors').toEqual({})
    expect(closed, 'the phase guard still lets disconnect() tear the socket down').toHaveBeenCalled()
  })
})

describe('#7559 the failed connect, end to end', () => {
  let socket: { close: ReturnType<typeof vi.fn>; readyState: number }
  const ctx = () => ({ url: 'wss://server-a/ws', token: 'tok-a', socket, isReconnect: false, silent: true })

  beforeEach(() => {
    useConnectionStore.setState({ connect: vi.fn() } as unknown as Partial<State>)
    socket = { close: vi.fn(), readyState: 1 }
  })

  it("auth_fail is a real producer of 'disconnected' with the previous server's state intact", () => {
    // The trigger, driven rather than asserted into place. #7564's review found
    // that two of the three routes originally named for this were wrong
    // (`server_down` is its own phase; a user Disconnect has already cleared
    // everything) — a FAILED CONNECT is the real one, and `auth_fail` is the
    // cheapest of that family to drive from a unit test.
    const a = useConnectionStore.getState().addServer('A', 'wss://server-a/ws', 'tok-a')
    seedServerA({ activeServerId: a.id, connectionPhase: 'connected', socket: socket as unknown as WebSocket } as unknown as Partial<State>)

    handleMessage({ type: 'auth_fail', reason: 'token-expired' }, ctx() as never)

    const s = useConnectionStore.getState()
    expect(s.connectionPhase, 'the phase the switch guard tests').toBe('disconnected')
    expect(s.socket).toBeNull()
    // …and it did NOT go through disconnect(): every roster field is still here.
    // This is the exposure #7559 is about, reproduced.
    const survivors = CONNECTION_SCOPED_RESET_FIELDS.filter((f) => populated(f))
    expect([...survivors].sort(), 'auth_fail must leave the state intact — that is the premise')
      .toEqual([...CONNECTION_SCOPED_RESET_FIELDS].sort())
  })

  it('…and the switch that follows it clears the roster', () => {
    const a = useConnectionStore.getState().addServer('A', 'wss://server-a/ws', 'tok-a')
    const b = useConnectionStore.getState().addServer('B', 'wss://server-b/ws', 'tok-b')
    seedServerA({ activeServerId: a.id, connectionPhase: 'connected', socket: socket as unknown as WebSocket } as unknown as Partial<State>)
    handleMessage({ type: 'auth_fail', reason: 'token-expired' }, ctx() as never)

    useConnectionStore.getState().switchServer(b.id)

    const survivors = CONNECTION_SCOPED_RESET_FIELDS.filter((f) => populated(f))
    expect(survivors, "server A's connection state survived into server B").toEqual([])
  })

  it("availablePermissionModes — the SHARP member: an older server B that omits it leaves no stale list", () => {
    // #7564's re-ranking, as a test. `auth_ok` re-sets this field only
    // CONDITIONALLY (`if (auth.availablePermissionModes)`), so it is the one
    // member nothing downstream repairs: without the switch-path clear, server
    // A's mode list keeps driving the permission-mode picker on server B for the
    // life of the tab.
    const a = useConnectionStore.getState().addServer('A', 'wss://server-a/ws', 'tok-a')
    const b = useConnectionStore.getState().addServer('B', 'wss://server-b/ws', 'tok-b')
    seedServerA({ activeServerId: a.id, connectionPhase: 'connected', socket: socket as unknown as WebSocket } as unknown as Partial<State>)
    handleMessage({ type: 'auth_fail', reason: 'token-expired' }, ctx() as never)

    useConnectionStore.getState().switchServer(b.id)
    // Server B is OLDER: its auth_ok carries no availablePermissionModes at all.
    handleMessage(
      {
        type: 'auth_ok',
        serverMode: 'cli',
        cwd: '/b',
        defaultCwd: '/b',
        serverVersion: '0.9.0',
        protocolVersion: 3,
        clientId: 'client-b',
        connectedClients: [],
      },
      { url: 'wss://server-b/ws', token: 'tok-b', socket, isReconnect: false, silent: true } as never,
    )

    expect(
      useConnectionStore.getState().availablePermissionModes,
      "server A's permission modes are still driving the picker on server B (#7559)",
    ).toEqual([])
  })

  it('serverCapabilities — the FAIL-OPEN member: empty is the capability-gated fail-closed state', () => {
    // Weaker than it looks (`auth_ok` full-replaces it on both branches, and an
    // omitted `capabilities` normalises to `{}`), but the window between the
    // switch and the handshake is real, and an empty map is what #3272 chose as
    // the fail-closed value for every capability-gated affordance.
    const a = useConnectionStore.getState().addServer('A', 'wss://server-a/ws', 'tok-a')
    const b = useConnectionStore.getState().addServer('B', 'wss://server-b/ws', 'tok-b')
    seedServerA({ activeServerId: a.id, connectionPhase: 'connected', socket: socket as unknown as WebSocket } as unknown as Partial<State>)
    handleMessage({ type: 'auth_fail', reason: 'token-expired' }, ctx() as never)
    expect(useConnectionStore.getState().serverCapabilities).toEqual({ fileOps: true, teleport: true })

    useConnectionStore.getState().switchServer(b.id)

    expect(
      useConnectionStore.getState().serverCapabilities,
      "server A's advertised capabilities are gating server B's UI (#7559)",
    ).toEqual({})
  })
})
