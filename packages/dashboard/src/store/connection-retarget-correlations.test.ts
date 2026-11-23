/**
 * #9218 — connect() replacing a live socket must end that socket's request correlations.
 *
 * `retireSocket` nulls onclose/onerror before closing (#8485), so a retarget or direct
 * reconnect skipped the teardown close/error/disconnect run. Harness copied from
 * connection-stale-socket.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const lsStore: Record<string, string> = {}
const localStorageMock = {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = v },
  removeItem: (k: string) => { delete lsStore[k] },
  clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
  get length() { return Object.keys(lsStore).length },
  key: (i: number) => Object.keys(lsStore)[i] ?? null,
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  url: string
  readyState = 1
  sent: string[] = []
  closed = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.closed += 1; this.readyState = 3 }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok' }),
}))

const { useConnectionStore } = await import('./connection')
const mh = await import('./message-handler')
const { createEmptyInFlightMarkers, createEmptySessionState } = await import('./utils')

type McpResult = { ok: boolean; code?: string }

const URL_A = 'wss://daemon-a.example.com/ws'
const URL_B = 'wss://daemon-b.example.com/ws'

async function open(url: string): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect(url, 'tok')
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.readyState = 1
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  return ws
}

async function authOk(ws: MockWebSocket): Promise<void> {
  ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
  await vi.advanceTimersByTimeAsync(0)
}

async function authenticated(url: string): Promise<MockWebSocket> {
  const ws = await open(url)
  await authOk(ws)
  // Pending requests are armed against the store's socket; give it a session id
  // (the MCP op needs one).
  useConnectionStore.setState({ activeSessionId: 's1' })
  return ws
}

interface Armed {
  evaluator: { error: string | null }
  summarize: { error: string | null }
  mcp: { result: McpResult | null }
  git: { result: { error?: string | null } | null }
  destroyExpired: { fired: boolean }
  markerKeys: string[]
}

/** Arm one request per socket-scoped correlation family on the CURRENT store socket. */
function armAll(): Armed {
  const st = useConnectionStore.getState()
  const armed: Armed = {
    evaluator: { error: null },
    summarize: { error: null },
    mcp: { result: null },
    git: { result: null },
    destroyExpired: { fired: false },
    markerKeys: [],
  }
  mh.registerEvaluatorRequest('eval-1', {
    resolve: () => { /* never resolved in these tests */ },
    reject: (e: Error) => { armed.evaluator.error = e.message },
    timeoutId: window.setTimeout(() => { /* watchdog: must NOT be what clears it */ }, 60_000),
  })
  st.summarizeSession('s1').catch((e: Error) => { armed.summarize.error = e.message })
  st.addMcpServer('srv', { command: 'x' } as never, 'project' as never, (r: McpResult) => { armed.mcp.result = r })
  st.setGitStageCallback((r: { error?: string | null }) => { armed.git.result = r })
  st.requestScheduledTasks()
  mh.registerModelChangeRequest('model-1', { sessionId: 's1', previousModel: 'm0' })
  // Map-based correlations armed through their real registration functions.
  mh.registerTrustGrantRequest('trust-1', { skillName: 'sk', author: 'au' })
  mh.registerPermissionModeChangeRequest('pm-1', { sessionId: 's1', previousMode: 'default' } as never)
  mh.registerThinkingLevelChangeRequest('tl-1', { sessionId: 's1', previousLevel: 'low' })
  mh.armEnvironmentDestroyTimer('env-1', 5_000, () => { armed.destroyExpired.fired = true })
  // Store-state families. These have no wire-level arming path reachable from the
  // fake socket (the UI actions that set them go through panels), so they are set
  // as store state exactly as those actions leave it.
  const base = useConnectionStore.getState().sessionStates.s1 ?? createEmptySessionState()
  useConnectionStore.setState({
    sessionStates: {
      ...useConnectionStore.getState().sessionStates,
      s1: { ...base, pendingTrustGrants: [{ requestId: 'trust-1', skillName: 'sk', author: 'au' }] },
    },
    transcriptViewer: { conversationId: 'c1', status: 'loading', messages: [], error: null },
    failedRestoreHistories: { h1: { entries: [], total: 0, loading: true, pendingOffset: 0 } },
    archivedSessionHistories: { h2: { entries: [], total: 0, loading: true, pendingOffset: 0 } },
  } as never)
  // Every in-flight marker in the roster, set non-empty by shape.
  const nonEmpty: Record<string, unknown> = {}
  for (const [key, empty] of Object.entries(createEmptyInFlightMarkers())) {
    if (empty instanceof Set) nonEmpty[key] = new Set(['x'])
    else if (typeof empty === 'boolean') nonEmpty[key] = true
    else if (empty !== null && typeof empty === 'object') nonEmpty[key] = { x: true }
    else continue
    armed.markerKeys.push(key)
  }
  useConnectionStore.setState(nonEmpty as never)
  return armed
}

/** Every family settled NOW (no timer has been advanced since arming). */
async function expectAllCleared(armed: Armed, opts: { viewerResetByPath?: boolean } = {}): Promise<void> {
  await vi.advanceTimersByTimeAsync(0) // let promise rejections land; NOT a timeout
  expect(armed.evaluator.error !== null).toBe(true)
  expect(armed.summarize.error !== null).toBe(true)
  expect(armed.mcp.result?.ok === false).toBe(true)
  expect(armed.git.result?.error != null).toBe(true)
  expect(useConnectionStore.getState().scheduledTasksLoading).toBe(false)
  expect(mh._testModelRevertPendingSize()).toBe(0)
  expect(mh._testEvaluatorPendingSize()).toBe(0)
  expect(mh._testMcpServerOpPendingSize()).toBe(0)
  expect(mh._testTrustGrantPendingSize()).toBe(0)
  expect(mh._testPermissionModeRevertPendingSize()).toBe(0)
  expect(mh._testThinkingLevelRevertPendingSize()).toBe(0)
  const st = useConnectionStore.getState()
  expect(st.sessionStates.s1?.pendingTrustGrants?.length ?? 0).toBe(0)
  // Paths that ALSO reset the viewer wholesale afterwards (disconnect(), and a
  // retarget's forgetSession()) leave it idle; the rest must have failed it.
  if (opts.viewerResetByPath) expect(st.transcriptViewer.status).not.toBe('loading')
  else expect(st.transcriptViewer.status).toBe('error')
  // Same split for the history views: settled to loading:false, or (on the paths
  // that reset them wholesale) gone.
  if (opts.viewerResetByPath) {
    expect(st.failedRestoreHistories.h1?.loading).not.toBe(true)
    expect(st.archivedSessionHistories.h2?.loading).not.toBe(true)
  } else {
    expect(st.failedRestoreHistories.h1?.loading).toBe(false)
    expect(st.archivedSessionHistories.h2?.loading).toBe(false)
  }
  // The destroy timer was cancelled, not merely not-yet-due.
  await vi.advanceTimersByTimeAsync(6_000)
  expect(armed.destroyExpired.fired).toBe(false)
  // Every roster marker is empty again (the roster must have been non-trivial).
  expect(armed.markerKeys.length).toBeGreaterThan(5)
  const state = st as unknown as Record<string, unknown>
  const stuck = armed.markerKeys.filter((k) => {
    const v = state[k]
    if (v instanceof Set) return v.size > 0
    if (typeof v === 'boolean') return v
    return v !== null && typeof v === 'object' && Object.keys(v as object).length > 0
  })
  expect(stuck).toEqual([])
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  mh.resetReconnectAttempt()
  mh.clearPendingModelReverts()
  mh.clearPendingTrustGrants()
  mh.clearPendingPermissionModeReverts()
  mh.clearPendingThinkingLevelReverts()
  mh.cancelAllEnvironmentDestroyTimers()
  for (const k of Object.keys(lsStore)) delete lsStore[k]
  useConnectionStore.setState({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    wsUrl: null,
    socket: null,
    userDisconnected: false,
    serverErrors: [],
    connectionError: null,
    activeSessionId: null,
    scheduledTasksLoading: false,
  })
})

afterEach(() => {
  useConnectionStore.getState().disconnect()
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('#9218 connect() replacing a live socket ends that socket\'s correlations', () => {
  it('retargeting to a DIFFERENT url clears every pending request at once', async () => {
    await authenticated(URL_A)
    const armed = armAll()
    expect(mh._testModelRevertPendingSize()).toBe(1)
    expect(useConnectionStore.getState().scheduledTasksLoading).toBe(true)

    useConnectionStore.getState().connect(URL_B, 'tok')
    await expectAllCleared(armed, { viewerResetByPath: true })
    expect(armed.evaluator.error).toContain('replaced')
    expect(armed.summarize.error).toContain('replaced')
  })

  it('a direct same-URL reconnect over a live socket clears them too', async () => {
    await authenticated(URL_A)
    const armed = armAll()

    useConnectionStore.getState().connect(URL_A, 'tok')
    await expectAllCleared(armed)
  })

  it('control: a request armed on the NEW socket survives and resolves normally', async () => {
    await authenticated(URL_A)
    armAll()
    const b = await authenticated(URL_B)

    let resolved: unknown = null
    let rejected: string | null = null
    mh.registerEvaluatorRequest('eval-new', {
      resolve: (r) => { resolved = r },
      reject: (e: Error) => { rejected = e.message },
      timeoutId: window.setTimeout(() => { /* watchdog */ }, 60_000),
    })
    let mcp: McpResult | null = null
    useConnectionStore.getState().addMcpServer('srv2', { command: 'x' } as never, 'project' as never, (r: McpResult) => { mcp = r })
    expect(mh._testEvaluatorPendingSize()).toBe(1)
    expect(mh._testMcpServerOpPendingSize()).toBe(1)
    expect(rejected).toBeNull()
    expect(mcp).toBeNull()

    b.onmessage?.({ data: JSON.stringify({ type: 'evaluate_draft_result', requestId: 'eval-new', verdict: 'send', reasoning: 'ok' }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved !== null).toBe(true)
    expect(rejected).toBeNull()
    expect(mh._testEvaluatorPendingSize()).toBe(0)
  })

  it('a first connect (no live socket) clears nothing armed beforehand', async () => {
    let result: unknown = null
    mh.registerEvaluatorRequest('eval-pre', {
      resolve: () => { /* */ },
      reject: (e: Error) => { result = e.message },
      timeoutId: window.setTimeout(() => { /* watchdog */ }, 60_000),
    })
    await open(URL_A)
    expect(result).toBeNull()
    expect(mh._testEvaluatorPendingSize()).toBe(1)
  })
})

describe('#9218 close / error / disconnect still clear the same set', () => {
  it('onclose', async () => {
    const a = await authenticated(URL_A)
    const armed = armAll()
    a.readyState = 3
    a.onclose?.()
    await expectAllCleared(armed)
    expect(armed.evaluator.error).toContain('closed')
  })

  it('onerror', async () => {
    const a = await authenticated(URL_A)
    const armed = armAll()
    a.onerror?.()
    await expectAllCleared(armed)
    expect(armed.evaluator.error).toContain('errored')
  })

  it('disconnect()', async () => {
    await authenticated(URL_A)
    const armed = armAll()
    useConnectionStore.getState().disconnect()
    await expectAllCleared(armed, { viewerResetByPath: true })
    expect(armed.evaluator.error).toContain('Disconnected')
  })
})
