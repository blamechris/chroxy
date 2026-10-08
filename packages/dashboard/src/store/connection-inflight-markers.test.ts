/**
 * #7586 — a user Disconnect must clear every in-flight request marker, through
 * the SAME roster the socket-drop sweep uses.
 *
 * ## The defect
 *
 * `socket.onclose` clears every transient "a request is outstanding" marker (the
 * actioning-id sets, the reindex / relay re-run / retry paths, the survey
 * `*Loading` flags, the PR/CI request markers, …) because the reply that would
 * clear each one can never arrive on the dead socket. `disconnect()` nulls
 * `socket.onclose` first, to suppress auto-reconnect, so that sweep never ran
 * for a USER-initiated Disconnect: start a container action, Disconnect, Connect
 * to the same server, and the row stayed "actioning" forever. #7572 fixed the two
 * orchestration markers by copying them into `disconnect()`; this is the rest.
 *
 * ## What this file holds, and why it is shaped this way
 *
 * The four sites that end a connection — `socket.onclose`, `disconnect()`,
 * `forgetSession` and `_resetSessionMemory` — now take their marker set from one
 * factory, `createEmptyInFlightMarkers()` in `utils.ts`. So the cells here are
 * ITERATED over `Object.keys(createEmptyInFlightMarkers())`: a marker added to
 * the factory is exercised at all four sites with no edit here, and a marker
 * that is NOT in the factory is caught by the two cells that look for it from
 * the other side (the `onclose` source scan and the type-derived roster).
 *
 * The EXPECTED post-reset state is a LITERAL shape predicate (`isEmpty` below),
 * never the factory's own output. The parity guard in
 * `session-destroy-prunes-pr-maps.test.ts` was once red-proof-less for exactly
 * that reason (#7424: an expectation derived from its own subject cannot go
 * red), so what "empty" means is stated here independently of what the factory
 * returns.
 *
 * The preserved records — the `*Results` maps beside each marker, the survey
 * snapshots, the #7557 family — are asserted STILL THERE, so the fix cannot
 * regress into a blanket wipe (#7557 / #7559 / #7572).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import ts from 'typescript'

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

const { useConnectionStore } = await import('./connection')
const { createEmptyInFlightMarkers } = await import('./utils')
const { resetReconnectAttempt } = await import('./message-handler')

type State = ReturnType<typeof useConnectionStore.getState>

const connectionSrc = readFileSync(resolve(__dirname, 'connection.ts'), 'utf8')

/** The roster under test, derived from the one factory every site takes it from. */
const MARKER_ROSTER: readonly string[] = Object.keys(createEmptyInFlightMarkers())

/**
 * The independent statement of what the roster must CONTAIN: the markers #7586
 * names, plus the three `socket.onclose` already cleared that the issue did not
 * list (`cancellingActivityIds`, `retryingRestoreIds`, and `symbolsLoading`
 * which neither path cleared). Written out so that DELETING a field from the
 * factory goes red here instead of quietly deleting its own per-field cells
 * from the `it.each` below.
 */
const ROSTER_EXPECTED = [
  'containerActioningIds', 'environmentDestroyingIds', 'byokPoolActioningIds', 'hostPruneActioningIds',
  'simulatorActioningIds', 'emulatorActioningIds', 'wslActioningIds',
  'reindexingRepoPaths', 'relayRerunningRepoPaths',
  'hostStatusLoading', 'runnerStatusLoading', 'containersStatusLoading',
  'repoRuntimeConfigLoading', 'byokPoolStatusLoading', 'hostPruneStatusLoading',
  'simulatorStatusLoading', 'emulatorStatusLoading', 'wslStatusLoading',
  'integrationStatusLoading', 'skillsInventoryLoading', 'mailboxStatusLoading',
  'externalSessionsLoading', 'repoEventsLoading', 'githubWebhookConfigLoading',
  'orchestrationRunsLoading', 'failedRestoresLoading',
  'sessionPrStatusLoading', 'sessionPrThreadsLoading', 'sessionPrStatusRequestedAt',
  'orchestrationRunDetailLoading', 'orchestrationPendingActions',
  'cancellingActivityIds', 'retryingRestoreIds', 'symbolsLoading',
  // #8378: seven spinners `disconnect()` cleared as hand-written literals and a
  // transport drop did not. Each is armed by a send on the live socket and
  // cleared by its reply, so a daemon restart mid-request stranded it.
  'memoryStackLoading', 'workspaceSymbolsLoading', 'codeSearchLoading', 'referencesLoading',
  'permissionAuditLoading', 'conversationHistoryLoading', 'searchLoading',
] as const

/**
 * Records that stay TRUE of the same daemon across a Disconnect → Connect, so
 * they are NOT in-flight markers and must survive every path below that is not a
 * full reset. Literal values; a field here that ALSO appears in the roster is a
 * contradiction, asserted rather than assumed.
 */
const PRESERVED: Record<string, unknown> = {
  reindexResults: { '/repo/a': { ok: true, at: 1 } },
  relayRerunResults: { '/repo/a': { ok: true, at: 1 } },
  containerActionResults: { 'env-a': { ok: true, at: 1 } },
  byokPoolActionResults: { drain: { ok: true, at: 1 } },
  hostPruneActionResults: { images: { ok: true, at: 1 } },
  simulatorActionResults: { 'udid-a': { ok: true, at: 1 } },
  emulatorActionResults: { 'avd-a': { ok: true, at: 1 } },
  wslActionResults: { Ubuntu: { ok: true, at: 1 } },
  orchestrationActionResults: { 'req-a': { ok: true, error: null, at: 1 } },
  orchestrationRunDetails: { 'run-a': { detail: { runId: 'run-a' }, seq: 3 } },
  credentialTestResults: { anthropic: { ok: true, error: null, model: 'm', latencyMs: 1 } },
}

/** What "empty" means, stated here and NOT read from the factory (#7424). */
function isEmpty(v: unknown): boolean {
  if (v instanceof Set) return v.size === 0
  if (typeof v === 'boolean') return v === false
  if (v !== null && typeof v === 'object') return Object.keys(v as object).length === 0
  return false
}

/** A non-empty value of the same SHAPE as the roster member's empty value. */
function dirtyValue(empty: unknown): unknown {
  if (empty instanceof Set) return new Set(['marker-a'])
  if (typeof empty === 'boolean') return true
  return { 'marker-a': 1 }
}

function dirtyMarkers(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(createEmptyInFlightMarkers()).map(([k, empty]) => [k, dirtyValue(empty)]),
  )
}

const read = (field: string): unknown => (useConnectionStore.getState() as unknown as Record<string, unknown>)[field]

function seed(extra: Record<string, unknown> = {}): void {
  useConnectionStore.setState({
    ...dirtyMarkers(),
    ...PRESERVED,
    ...extra,
  } as unknown as Partial<State>)
}

/** Open a connection and return the freshly constructed (current-attempt) socket. */
async function openConnected(): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect('wss://tunnel.example.com/ws', 'tok')
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.readyState = 1
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  // The store adopts the socket on `auth_ok`; the handshake is not what is under
  // test, so install it directly (the senders gate on `get().socket` being OPEN).
  useConnectionStore.setState({ socket: ws as unknown as WebSocket, connectionPhase: 'connected', userDisconnected: false })
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  useConnectionStore.setState({ socket: null, connectionPhase: 'disconnected', userDisconnected: false })
})

afterEach(() => {
  // Cancel any reconnect timer a close armed, then reset the roster so this file
  // cannot leak a populated marker into the next one.
  useConnectionStore.getState().disconnect()
  useConnectionStore.setState({
    ...createEmptyInFlightMarkers(),
    ...Object.fromEntries(Object.keys(PRESERVED).map((k) => [k, {}])),
  } as unknown as Partial<State>)
  vi.useRealTimers()
})

describe('#7586 the fixture and the roster are real', () => {
  it('the roster contains every marker the issue names (deleting one is red)', () => {
    const missing = ROSTER_EXPECTED.filter((f) => !MARKER_ROSTER.includes(f))
    expect(missing, 'a marker was DELETED from createEmptyInFlightMarkers()').toEqual([])
  })

  it('the roster and the independent list agree both ways', () => {
    // The other direction: a marker added to the factory is a deliberate act that
    // belongs in the pin above too. Without this the pin only ever grows stale.
    const extra = MARKER_ROSTER.filter((f) => !(ROSTER_EXPECTED as readonly string[]).includes(f))
    expect(extra, 'a marker was ADDED to the roster; add it to ROSTER_EXPECTED too').toEqual([])
  })

  it('control: the fixture populates EVERY roster member (an "empty afterwards" cell would pass for free otherwise)', () => {
    seed()
    const notDirty = MARKER_ROSTER.filter((f) => isEmpty(read(f)))
    expect(notDirty, 'these were not populated, so the cells below prove nothing about them').toEqual([])
  })

  it('control: the preserved records are populated and are NOT roster members', () => {
    seed()
    expect(Object.keys(PRESERVED).filter((f) => isEmpty(read(f)))).toEqual([])
    expect(Object.keys(PRESERVED).filter((f) => MARKER_ROSTER.includes(f))).toEqual([])
  })

  it('control: isEmpty rejects what it must (a predicate that says yes to everything proves nothing)', () => {
    expect(isEmpty(new Set(['x']))).toBe(false)
    expect(isEmpty({ x: 1 })).toBe(false)
    expect(isEmpty(true)).toBe(false)
    expect(isEmpty(undefined)).toBe(false)
    expect(isEmpty(null)).toBe(false)
    expect(isEmpty(new Set())).toBe(true)
    expect(isEmpty({})).toBe(true)
    expect(isEmpty(false)).toBe(true)
  })
})

describe('#7586 the repro: container action → user Disconnect → Connect', () => {
  it('the row is not left stuck "actioning" across a same-server reconnect', async () => {
    await openConnected()
    const sent = useConnectionStore.getState().sendContainersAction('env-1', 'stop')
    expect(sent, 'the real sender must accept the open socket').toBe(true)
    expect(
      [...useConnectionStore.getState().containerActioningIds],
      'control: the action marked env-1 pending',
    ).toEqual(['env-1'])

    // A user Disconnect nulls socket.onclose, so the ack/failure can never be
    // observed and the onclose sweep never runs.
    useConnectionStore.getState().disconnect()
    expect(
      useConnectionStore.getState().containerActioningIds.size,
      'disconnect() left the container row stuck "actioning"',
    ).toBe(0)

    // …and Connect to the SAME server does not resurrect it.
    await openConnected()
    expect(useConnectionStore.getState().containerActioningIds.size).toBe(0)
  })

  it('a pending reindex goes the same way', async () => {
    await openConnected()
    expect(useConnectionStore.getState().sendRepoMemoryReindex('/repo/a')).toBe(true)
    expect(useConnectionStore.getState().reindexingRepoPaths.has('/repo/a')).toBe(true)
    useConnectionStore.getState().disconnect()
    expect(useConnectionStore.getState().reindexingRepoPaths.size).toBe(0)
  })
})

describe.each([
  ['a user disconnect()', async () => { await openConnected(); seed(); useConnectionStore.getState().disconnect() }],
  ['a transport drop (socket.onclose)', async () => { const ws = await openConnected(); seed(); ws.onclose?.({ code: 1006 }) }],
  ['forgetSession()', async () => { await openConnected(); seed(); useConnectionStore.getState().forgetSession() }],
  ['_resetSessionMemory()', async () => { await openConnected(); seed(); useConnectionStore.getState()._resetSessionMemory() }],
] as const)('#7586 %s clears every in-flight marker', (_label, run) => {
  beforeEach(async () => { await run() })

  it.each(MARKER_ROSTER)('%s is empty afterwards', (field) => {
    expect(isEmpty(read(field)), `${field} survived`).toBe(true)
  })
})

describe.each([
  ['a user disconnect()', async () => { await openConnected(); seed(); useConnectionStore.getState().disconnect() }],
  ['a transport drop (socket.onclose)', async () => { const ws = await openConnected(); seed(); ws.onclose?.({ code: 1006 }) }],
] as const)('#7586 the preserved records survive %s', (_label, run) => {
  beforeEach(async () => { await run() })

  it.each(Object.keys(PRESERVED))('%s is still there', (field) => {
    expect(isEmpty(read(field)), `${field} is a record, not a marker — the fix must not wipe it`).toBe(false)
    expect(read(field)).toEqual(PRESERVED[field])
  })
})

describe('#7586 a drop on an idle tab writes nothing (no subscriber churn)', () => {
  it('already-empty markers keep their identity through socket.onclose', async () => {
    const ws = await openConnected()
    useConnectionStore.setState({ ...createEmptyInFlightMarkers() } as unknown as Partial<State>)
    const before = Object.fromEntries(MARKER_ROSTER.map((f) => [f, read(f)]))
    ws.onclose?.({ code: 1006 })
    const replaced = MARKER_ROSTER.filter((f) => read(f) !== before[f])
    expect(replaced, 'an empty marker was replaced by a fresh empty one, re-rendering its subscribers').toEqual([])
  })
})

describe('#7586 the roster is the ONLY place a marker is added', () => {
  /** The `socket.onclose = …` handler's source, from its head to the next handler. */
  const oncloseStart = connectionSrc.indexOf('socket.onclose = (event')
  const oncloseEnd = connectionSrc.indexOf('socket.onerror = ', oncloseStart)
  const oncloseBody = connectionSrc.slice(oncloseStart, oncloseEnd)
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  /** Every key a `set({ key: … })` call in `src` names first. */
  const literalSetKeys = (src: string): string[] =>
    [...stripComments(src).matchAll(/\bset\(\{\s*([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]!)

  // Keys the handler may legitimately name in a literal `set({ … })`: the socket
  // itself and the phase it settles the tab in. Anything else is a state field being cleared by hand in `onclose`,
  // which is how the roster drifts from `disconnect()` in the first place.
  const ALLOWED_ONCLOSE_SET_KEYS = ['socket', 'connectionPhase']

  it('control: the onclose slice is the real handler', () => {
    expect(oncloseStart, 'socket.onclose handler not found').toBeGreaterThan(-1)
    expect(oncloseEnd, 'socket.onerror handler not found after it').toBeGreaterThan(oncloseStart)
    expect(oncloseBody.length).toBeGreaterThan(500)
    expect(oncloseBody.length, 'the slice swallowed the file').toBeLessThan(connectionSrc.length / 4)
    expect(literalSetKeys(oncloseBody), 'the scanner must SEE the handler\'s own literal set({ socket: … })')
      .toContain('socket')
  })

  it('socket.onclose clears markers through the roster, not field by field', () => {
    const offenders = literalSetKeys(oncloseBody).filter((k) => !ALLOWED_ONCLOSE_SET_KEYS.includes(k))
    expect(
      offenders,
      'onclose names a state field in a literal set({ … }). If it is an in-flight request marker, add it to ' +
      'createEmptyInFlightMarkers() (utils.ts) instead — that is what disconnect() and both full-reset ' +
      'sites take, and a hand-copy here is how a user Disconnect left ~12 markers stuck (#7586).',
    ).toEqual([])
    expect(
      stripComments(oncloseBody).includes('staleInFlightMarkers('),
      'onclose no longer sweeps the roster',
    ).toBe(true)
  })

  it('the scanner itself catches the drift it exists for (a synthetic hand-copy)', () => {
    const drifted = [
      'socket.onclose = (event) => {',
      '  if (get().fooActioningIds.size > 0) {',
      '    set({ fooActioningIds: new Set<string>() })',
      '  }',
      '}',
    ].join('\n')
    expect(literalSetKeys(drifted)).toEqual(['fooActioningIds'])
    // …and a comment mentioning one is not mistaken for code.
    expect(literalSetKeys('// set({ fooActioningIds: new Set() })')).toEqual([])
  })

  // ---- the type-derived roster ---------------------------------------------------
  // `onclose` cannot be scanned for a marker nobody wrote anywhere, so the other
  // half looks at the DECLARATIONS: every `Set<string>` member of ConnectionState
  // (all of them are request markers today) and every `*Loading: boolean` member
  // is either in the roster or named below with where it dies instead.

  const typesPath = resolve(__dirname, 'types.ts')
  const program = ts.createProgram([typesPath], {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  })
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(typesPath)!
  let connectionStateDecl: ts.InterfaceDeclaration | null = null
  ts.forEachChild(sf, (n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === 'ConnectionState') connectionStateDecl = n
  })
  const members: Array<{ name: string; type: string }> = connectionStateDecl
    ? checker
        .getTypeAtLocation((connectionStateDecl as ts.InterfaceDeclaration).name)
        .getProperties()
        .map((p) => ({
          name: p.getName(),
          type: checker.typeToString(checker.getTypeOfSymbolAtLocation(p, (connectionStateDecl as ts.InterfaceDeclaration).name)),
        }))
    : []

  /**
   * Declared markers that are NOT in the roster, with where each dies. A
   * `*Loading` flag cleared by `disconnect()` as its own literal, or by a
   * module-level registry, is a legitimate answer; "nothing" is not.
   */
  const NOT_IN_ROSTER_EXPECTED: Record<string, { kind: 'disconnect-literal' | 'scheduler-registry'; reason: string }> = {
    scheduledTasksLoading: {
      kind: 'scheduler-registry',
      reason: 'armed through armSchedulerRequest; failAllSchedulerRequests() fires its onFail on onclose AND disconnect() (#6871)',
    },
    // #8378: the seven that used to be listed here as 'disconnect-literal' (memoryStack,
    // workspaceSymbols, codeSearch, references, permissionAudit, conversationHistory,
    // search) were transient request markers, not survivors, and now live in the roster.
    // The map is empty of survivors except the scheduler's, which its own registry clears.
  }

  it('control: the checker found the real declarations', () => {
    expect(members.length, 'ConnectionState was not resolved').toBeGreaterThan(200)
    expect(members.filter((m) => m.type === 'Set<string>').length).toBeGreaterThanOrEqual(11)
    expect(members.filter((m) => m.type === 'boolean' && m.name.endsWith('Loading')).length).toBeGreaterThanOrEqual(20)
  })

  it('every Set<string> member of ConnectionState is a roster member', () => {
    const sets = members.filter((m) => m.type === 'Set<string>').map((m) => m.name)
    expect(
      sets.filter((f) => !MARKER_ROSTER.includes(f)),
      'a Set<string> was added to ConnectionState. Every one today is an in-flight request marker; if this one is ' +
      'too, add it to createEmptyInFlightMarkers() — otherwise a user Disconnect strands it (#7586).',
    ).toEqual([])
  })

  it('every *Loading boolean is in the roster or has a stated home', () => {
    const loadings = members.filter((m) => m.type === 'boolean' && m.name.endsWith('Loading')).map((m) => m.name)
    const unclassified = loadings.filter((f) => !MARKER_ROSTER.includes(f) && !(f in NOT_IN_ROSTER_EXPECTED))
    expect(
      unclassified,
      'a *Loading flag was added to ConnectionState and is neither in createEmptyInFlightMarkers() nor ' +
      'classified here. A loading flag whose reply can never arrive on a closed socket is stuck forever (#7586).',
    ).toEqual([])
  })

  it('the stated homes are real: declared, not in the roster, and cleared by disconnect()', async () => {
    const declared = new Set(members.map((m) => m.name))
    for (const [field, { kind, reason }] of Object.entries(NOT_IN_ROSTER_EXPECTED)) {
      expect(reason.length, `${field} needs a reason`).toBeGreaterThan(10)
      expect(declared.has(field), `${field} is classified here but no longer declared`).toBe(true)
      expect(MARKER_ROSTER.includes(field), `${field} IS in the roster now — drop it from the exemptions`).toBe(false)
      if (kind !== 'disconnect-literal') continue
      await openConnected()
      useConnectionStore.setState({ [field]: true } as unknown as Partial<State>)
      expect(read(field), `control: ${field} was populated`).toBe(true)
      useConnectionStore.getState().disconnect()
      expect(read(field), `${field} is claimed to be cleared by disconnect() and is not`).toBe(false)
    }
  })
})
