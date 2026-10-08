/**
 * #7579 — object-shaped daemon snapshots have a CONNECTION lifetime, driven
 * through the real store.
 *
 * #7557 / #7573 gave the SATELLITES of the orchestration, scheduler and
 * credentials panels a lifetime (`orchestrationRunDetails`,
 * `credentialTestResults`, …) and left the PRIMARIES they attach to with none:
 * `orchestrationRuns`, `scheduledTasks`, `credentialsStatus`,
 * `byokCredentialsStatus`, their selections and error, and the Control Room
 * survey readings. After a switch the Runs panel rendered server A's run list
 * next to server B's empty detail maps, and the credentials pane rendered A's
 * `masked` key previews and A's `fileError` next to B's empty verdicts, with
 * action buttons that fire at B.
 *
 * The decision is per site, not per field:
 *
 *   * `forgetSession` and `_resetSessionMemory` — the two sites that mean "a
 *     DIFFERENT daemon" — clear them.
 *   * `disconnect()` and `auth_ok`'s non-reconnect branch do NOT. Both are also
 *     the ordinary Disconnect → Connect to the SAME server, where every one of
 *     them is still true and the Control Room's "generated Nm ago" line is the
 *     staleness cue (#6153, #7557, #7570).
 *
 * The source axis (a snapshot-shaped field with no lifetime is red) lives in
 * `session-destroy-prunes-pr-maps.test.ts`; this file asks the same question of
 * the STORE, because a source grep cannot see a clear that runs at the wrong
 * time and a behavioural test cannot see a field nobody listed.
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
const { createEmptyDaemonSnapshots } = await import('./utils')
const { handleMessage, stopHeartbeat, clearDeltaBuffers, clearPermissionSplits, resetReplayFlags } =
  await import('./message-handler')

type State = ReturnType<typeof useConnectionStore.getState>

/**
 * The roster, derived from the factory the fix spreads. The independent
 * statement of what it must CONTAIN is `EXPECTED` below: without that pin,
 * deleting a field from the factory would delete its cell here rather than turn
 * one red.
 */
const FIELDS: readonly string[] = Object.keys(createEmptyDaemonSnapshots())

const EXPECTED = [
  // the issue's named primaries and their selections / error
  'credentialsStatus', 'byokCredentialsStatus',
  'orchestrationRuns', 'selectedRunId',
  'scheduledTasks', 'selectedScheduledTaskId', 'scheduledTasksError',
  // the Control Room survey family
  'hostStatus', 'mailboxStatus', 'runnerStatus', 'containersStatus', 'repoRuntimeConfig',
  'byokPoolStatus', 'hostPruneStatus', 'integrationStatus', 'skillsInventory',
  'simulatorStatus', 'emulatorStatus', 'wslStatus', 'externalSessionsSnapshot',
  'repoEventsSnapshot', 'githubWebhookConfig', 'monthlyBudget', 'notificationPrefs',
  'sessionNotFoundError', 'symbols',
] as const

/** The three members that are plain strings; everything else is object-shaped. */
const STRING_FIELDS = new Set(['selectedRunId', 'selectedScheduledTaskId', 'scheduledTasksError'])

/** Server A's values: one distinguishable marker per field. */
function serverASnapshots(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of FIELDS) out[f] = STRING_FIELDS.has(f) ? `${f}-from-server-A` : { from: 'server A', field: f }
  return out
}

function readField(field: string): unknown {
  return (useConnectionStore.getState() as unknown as Record<string, unknown>)[field]
}

const SERVER_A_URL = 'wss://server-a/ws'
const SERVER_B_URL = 'wss://server-b/ws'

function seedServerA(extra: Partial<State> = {}) {
  useConnectionStore.setState({ ...serverASnapshots(), ...extra } as unknown as Partial<State>)
}

function resetSlice() {
  useConnectionStore.setState({
    ...createEmptyDaemonSnapshots(),
    failedRestores: null,
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
  for (const k of Object.keys(lsStore)) delete lsStore[k]
  resetSlice()
})
afterEach(() => { stopHeartbeat(); resetSlice(); vi.restoreAllMocks() })

describe('#7579 the roster is the one the issue describes', () => {
  it('createEmptyDaemonSnapshots() holds exactly the issue\'s primaries and the survey family', () => {
    expect([...FIELDS].sort()).toEqual([...EXPECTED].sort())
  })

  it('every value is the store\'s own initial value, so "empty" means "not asked yet"', () => {
    // Not a second hand-kept list of initial values: the store's real initial
    // state is the oracle. A factory value that differed (`{}` where the store
    // starts at `null`) would turn "not loaded yet" into "loaded, and empty" —
    // and the panels' first-load effects key off `null`.
    const initial = useConnectionStore.getInitialState() as unknown as Record<string, unknown>
    const empty = createEmptyDaemonSnapshots() as Record<string, unknown>
    for (const f of FIELDS) {
      expect(empty[f], `${f}: the roster's empty value must be the store's initial value`).toEqual(initial[f])
    }
  })
})

describe.each([
  ['forgetSession', () => useConnectionStore.getState().forgetSession()],
  ['_resetSessionMemory', () => useConnectionStore.getState()._resetSessionMemory()],
])('#7579 %s drops server A\'s snapshots', (_site, run) => {
  beforeEach(() => { seedServerA() })

  it('control: the fixture populated every field first', () => {
    // Without this every "gone afterwards" cell below passes for free against a
    // fixture that never landed — the negative-assertion trap.
    const unpopulated = FIELDS.filter((f) => readField(f) === null)
    expect(unpopulated, 'the fixture did not populate these, so their clears prove nothing').toEqual([])
  })

  it.each([...EXPECTED])('clears %s', (field) => {
    expect(readField(field), 'control: populated before the action').not.toBeNull()
    run()
    expect(readField(field), `${field} survived — server A's reading is now rendered as server B's (#7579)`)
      .toBeNull()
  })
})

describe('#7579 the panels the issue names', () => {
  it('the Runs panel: after a switch the run list, the selection and the details go together', () => {
    // The issue's headline: A's run list beside B's (correctly empty) detail maps.
    useConnectionStore.setState({
      orchestrationRuns: { type: 'orchestration_runs', runs: [{ runId: 'run-a' }] },
      selectedRunId: 'run-a',
      orchestrationRunDetails: { 'run-a': { detail: { runId: 'run-a' }, seq: 1 } },
    } as unknown as Partial<State>)

    useConnectionStore.getState()._resetSessionMemory()

    const s = useConnectionStore.getState()
    expect(s.orchestrationRuns).toBeNull()
    expect(s.selectedRunId).toBeNull()
    expect(s.orchestrationRunDetails).toEqual({})
  })

  it('the credentials pane: A\'s masked previews and fileError do not sit beside B\'s empty verdicts', () => {
    useConnectionStore.setState({
      credentialsStatus: {
        credentials: [{ key: 'anthropic', masked: 'sk-ant-…A', source: 'file' }],
        fileExists: true,
        fileError: 'server A: unreadable credentials file',
      },
      credentialTestResults: { anthropic: { ok: true, error: null, model: 'a', latencyMs: 1 } },
    } as unknown as Partial<State>)

    useConnectionStore.getState()._resetSessionMemory()

    const s = useConnectionStore.getState()
    expect(s.credentialsStatus).toBeNull()
    expect(s.credentialTestResults).toEqual({})
  })
})

describe('#7579 a user Disconnect keeps the readings of the daemon it is still pointed at', () => {
  it.each([...EXPECTED])('disconnect() preserves %s', (field) => {
    // The #7557 taxonomy, enforced: these are TRUE of the same daemon across a
    // Disconnect → Connect, and the "generated Nm ago" line is the staleness
    // cue. Clearing a primary here while the run-detail map beside it survives
    // would invert the defect this issue fixes.
    seedServerA({ connectionPhase: 'connected', wsUrl: SERVER_A_URL } as unknown as Partial<State>)
    const before = readField(field)
    expect(before, 'control: populated before the action').not.toBeNull()
    useConnectionStore.getState().disconnect()
    expect(readField(field)).toEqual(before)
  })

  it('…and so does the same-server auth_ok that follows it', () => {
    const socket = { close: vi.fn(), readyState: 1 }
    seedServerA({ connectionPhase: 'connected', wsUrl: SERVER_A_URL } as unknown as Partial<State>)
    useConnectionStore.getState().disconnect()
    // `connect` is stubbed: the thing under test is what the handshake leaves.
    useConnectionStore.setState({ connect: vi.fn() } as unknown as Partial<State>)
    handleMessage(
      {
        type: 'auth_ok', serverMode: 'cli', cwd: '/a', defaultCwd: '/a', serverVersion: '0.9.0',
        protocolVersion: 3, clientId: 'client-a', connectedClients: [],
      },
      { url: SERVER_A_URL, token: 'tok-a', socket, isReconnect: false, silent: true } as never,
    )
    expect(useConnectionStore.getState().connectionPhase).toBe('connected')
    const lost = FIELDS.filter((f) => readField(f) === null)
    expect(lost, 'a same-server Disconnect → Connect dropped a reading that is still true').toEqual([])
  })
})

describe('#7579 the failed connect, end to end', () => {
  it('auth_fail leaves A\'s snapshots intact, and the switch that follows drops them', () => {
    // #7559's route, driven rather than asserted into place: a FAILED CONNECT
    // rests at 'disconnected' with the previous server's state populated, so
    // `switchServer` skips `disconnect()` and `_resetSessionMemory` is all it runs.
    const socket = { close: vi.fn(), readyState: 1 }
    useConnectionStore.setState({ connect: vi.fn() } as unknown as Partial<State>)
    const a = useConnectionStore.getState().addServer('A', SERVER_A_URL, 'tok-a')
    const b = useConnectionStore.getState().addServer('B', SERVER_B_URL, 'tok-b')
    seedServerA({ activeServerId: a.id, connectionPhase: 'connected', socket: socket as unknown as WebSocket } as unknown as Partial<State>)

    handleMessage({ type: 'auth_fail', reason: 'token-expired' }, { url: SERVER_A_URL, token: 'tok-a', socket, isReconnect: false, silent: true } as never)
    expect(useConnectionStore.getState().connectionPhase, 'the phase the switch guard tests').toBe('disconnected')
    expect(FIELDS.filter((f) => readField(f) === null), 'auth_fail must leave the state intact — that is the premise')
      .toEqual([])

    useConnectionStore.getState().switchServer(b.id)

    expect(FIELDS.filter((f) => readField(f) !== null), "server A's readings survived into server B")
      .toEqual([])
  })
})

describe('#7579 forgetSession also drops the two #7625 / transcript overlays it used to skip', () => {
  it('failedRestores and transcriptViewer are cleared by a different-daemon connect()', () => {
    // `disconnect()` and `_resetSessionMemory` both nulled these; `forgetSession`
    // — the only site a direct `connect()` to another URL reaches (#8207) — did
    // not, though the roster comment on `failedRestores` calls the pair BOTH
    // full-reset sites.
    useConnectionStore.setState({
      failedRestores: { type: 'failed_restores_list', restores: [{ id: 'a', cwd: '/only/on/a' }] },
      transcriptViewer: { status: 'ready', conversationId: 'conv-a', entries: [], error: null },
    } as unknown as Partial<State>)
    expect(useConnectionStore.getState().failedRestores, 'control').not.toBeNull()
    expect(useConnectionStore.getState().transcriptViewer.conversationId, 'control').toBe('conv-a')

    useConnectionStore.getState().forgetSession()

    expect(useConnectionStore.getState().failedRestores).toBeNull()
    expect(useConnectionStore.getState().transcriptViewer.conversationId).not.toBe('conv-a')
  })
})
