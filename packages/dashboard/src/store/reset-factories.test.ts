/**
 * #8411 / #7588 — the two reset factories that replaced hand-copied literals:
 *
 *   - `createEmptySessionPanels()`       the per-ACTIVE-SESSION panels (permission-audit
 *                                         history, memory stack). Cleared on a session
 *                                         change AND on every full reset.
 *   - `createEmptyConnectionReadings()`  the object-shaped transient readings of requests
 *                                         made on one daemon's socket (IDE results, the
 *                                         permission-confirm dialog, the memory-read
 *                                         nonce). Cleared on every full reset, not on a
 *                                         session change.
 *
 * ## The defect class
 *
 * The same reset values were spelled out at several sites. #7546 was the copy that went
 * missing at two of them (the panel bled across a session death), and #8411 was a whole
 * group missing from both full-reset sites: `switchServer` / `connectLocal` run
 * `disconnect()` only `if (connectionPhase !== 'disconnected')`, and a failed connect
 * rests at exactly that phase with the previous server's values populated, so the switch
 * reached `_resetSessionMemory()` alone and carried them to the next daemon.
 *
 * ## What holds it
 *
 * 1. BEHAVIOURAL, per site, per field: dirty every key a factory returns, run the site,
 *    assert the key reads the factory's value. Goes red when a site stops spreading the
 *    factory.
 * 2. STRUCTURAL, per site: the site's source spreads the factory and does not hand-list
 *    any of its keys. Goes red when a literal grows back beside the spread (the copy that
 *    drifts).
 * 3. COMPLETENESS: every ConnectionState member of the panel families is in the factory,
 *    and the store is CONSTRUCTED with the factory's values. Goes red when a field is
 *    added to the type and the initial state but not to the factory, which is exactly the
 *    "8th panel field misses the death-path copies" hazard #7588 names.
 *
 * The dirty values are DERIVED from the factory's own values (null -> a marker object,
 * false -> true, '' -> a string), so a key added to a factory is dirtied without anyone
 * editing this file. A value shape the derivation does not know throws, rather than
 * skipping the key: "cannot dirty this" must not read as "nothing to check".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// connection.ts reads persisted settings at module scope (same idiom as the sibling
// store tests).
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
// Captured before any test mutates the store: what the store was CONSTRUCTED with.
const INITIAL = { ...useConnectionStore.getState() } as unknown as Record<string, unknown>
const {
  createEmptySessionPanels, createEmptyConnectionReadings, createEmptySessionState,
  createEmptyConnectionScope, createEmptyInFlightMarkers, createEmptyDaemonSnapshots, createEmptyFlatSessionMirror,
} = await import('./utils')
const { handleMessage, stopHeartbeat, clearDeltaBuffers, clearPermissionSplits, resetReplayFlags } =
  await import('./message-handler')
type State = import('./types').ConnectionState

const storeSrc = readFileSync(resolve(__dirname, 'connection.ts'), 'utf8')
const handlerSrc = readFileSync(resolve(__dirname, 'message-handler.ts'), 'utf8')
const typesSrc = readFileSync(resolve(__dirname, 'types.ts'), 'utf8')

type Roster = Record<string, unknown>
const PANELS: Roster = createEmptySessionPanels()
const READINGS: Roster = createEmptyConnectionReadings()
const PANEL_KEYS = Object.keys(PANELS)
const READING_KEYS = Object.keys(READINGS)

/** A value that is NOT the reset value, derived from the reset value's shape. */
function dirtyValue(key: string, reset: unknown): unknown {
  if (reset === null) return { stale: `server A: ${key}`, nonce: 7 }
  if (reset === false) return true
  if (reset === '') return `stale ${key}`
  throw new Error(
    `reset-factories.test: cannot derive a dirty value for ${key} (reset value ${JSON.stringify(reset)}). ` +
    'Teach dirtyValue() this shape; do not skip the key, or its reset cell passes for free.',
  )
}

function dirtyOf(roster: Roster): Roster {
  return Object.fromEntries(Object.entries(roster).map(([k, v]) => [k, dirtyValue(k, v)]))
}

const read = (): Roster => useConnectionStore.getState() as unknown as Roster

function seed(extra: Partial<State> | Roster = {}): void {
  useConnectionStore.setState({ ...dirtyOf(PANELS), ...dirtyOf(READINGS), ...extra } as unknown as Partial<State>)
}

/** Put both rosters back so no cell leaks into the next. */
function restore(): void {
  useConnectionStore.setState({ ...PANELS, ...READINGS } as unknown as Partial<State>)
}

function expectRoster(roster: Roster, keys: string[], where: string): void {
  for (const k of keys) {
    expect(read()[k], `${k} was not reset by ${where}`).toEqual(roster[k])
  }
}

function expectUntouched(dirty: Roster, keys: string[], where: string): void {
  for (const k of keys) {
    expect(read()[k], `${k} must survive ${where}`).toEqual(dirty[k])
  }
}

afterEach(() => {
  stopHeartbeat()
  restore()
})

// ---------------------------------------------------------------------------
// Controls: the rosters are real, and the derivation really dirties them.
// ---------------------------------------------------------------------------
describe('#8411 / #7588 controls', () => {
  it('both rosters are non-empty and disjoint (one field, one lifetime)', () => {
    expect(PANEL_KEYS.length, 'the panel roster is empty').toBeGreaterThanOrEqual(7)
    expect(READING_KEYS.length, 'the readings roster is empty').toBeGreaterThanOrEqual(9)
    expect(PANEL_KEYS.filter((k) => READING_KEYS.includes(k))).toEqual([])
  })

  it('each key has ONE reset value: the readings overlap no other roster, the panels overlap only the two loading flags', () => {
    // A key in two rosters with different values would be reset to whichever spread
    // lands last. The ONE deliberate overlap is permissionAuditLoading / memoryStackLoading,
    // which are both a panel flag (cleared on a session change) and an in-flight marker
    // (cleared on a transport drop, #8378). Pinned exactly, with the values equal, so a
    // third overlap is red and the two cannot drift apart.
    const others: Record<string, Roster> = {
      createEmptyConnectionScope: createEmptyConnectionScope(),
      createEmptyInFlightMarkers: createEmptyInFlightMarkers(),
      createEmptyDaemonSnapshots: createEmptyDaemonSnapshots(),
      createEmptyFlatSessionMirror: createEmptyFlatSessionMirror(),
    }
    for (const [name, roster] of Object.entries(others)) {
      expect(Object.keys(roster).length, `${name}() returned nothing`).toBeGreaterThan(0)
      expect(READING_KEYS.filter((k) => k in roster), `readings overlap ${name}()`).toEqual([])
    }
    const overlap = PANEL_KEYS.filter((k) => Object.values(others).some((r) => k in r))
    expect(overlap.sort()).toEqual(['memoryStackLoading', 'permissionAuditLoading'])
    for (const k of overlap) {
      expect(PANELS[k], `${k}: the panel and in-flight reset values disagree`)
        .toEqual((others.createEmptyInFlightMarkers as Roster)[k])
    }
  })

  it('every key is dirtied by the derivation to a value that differs from its reset', () => {
    for (const [roster, dirty] of [[PANELS, dirtyOf(PANELS)], [READINGS, dirtyOf(READINGS)]] as const) {
      for (const k of Object.keys(roster)) {
        expect(dirty[k], `${k}: the dirty value equals the reset value, so its cell would pass for free`)
          .not.toEqual(roster[k])
      }
    }
  })

  it('the seeded store really holds the dirty values before any site runs', () => {
    seed()
    const dirty = { ...dirtyOf(PANELS), ...dirtyOf(READINGS) }
    for (const k of Object.keys(dirty)) expect(read()[k], `${k} was not seeded`).toEqual(dirty[k])
  })

  it('the issue-named fields are covered (non-vacuity of the derived rosters)', () => {
    // The independent statement of what #8411 and #7588 name. The rosters above are
    // derived from the factories, so deleting a field from a factory would otherwise
    // delete its cells too; this line is what turns that red.
    expect([...PANEL_KEYS].sort()).toEqual([
      'memoryStackEntries', 'memoryStackError', 'memoryStackFile', 'memoryStackLoading',
      'permissionAudit', 'permissionAuditError', 'permissionAuditLoading',
    ])
    for (const k of [
      'pendingPermissionConfirm', 'fileBrowserPendingOpen', 'workspaceSymbols', 'symbolLocation',
      'codeSearchResults', 'referencesResult', 'referencesSymbol', 'referencesOpen', 'lastMemoryStackRequestId',
    ]) {
      expect(READING_KEYS, `${k} is named by #8411 and is not in the readings roster`).toContain(k)
    }
  })
})

// ---------------------------------------------------------------------------
// BEHAVIOUR 1 — the three full-reset actions clear BOTH rosters.
// ---------------------------------------------------------------------------
describe.each([
  ['forgetSession', () => useConnectionStore.getState().forgetSession()],
  ['_resetSessionMemory', () => useConnectionStore.getState()._resetSessionMemory()],
  ['disconnect()', () => useConnectionStore.getState().disconnect()],
])('#8411 / #7588 %s clears both rosters', (_name, run) => {
  beforeEach(() => seed())

  it.each(PANEL_KEYS)('resets panel field %s', (k) => {
    run()
    expect(read()[k]).toEqual(PANELS[k])
  })

  it.each(READING_KEYS)('resets reading %s', (k) => {
    run()
    expect(read()[k]).toEqual(READINGS[k])
  })
})

// ---------------------------------------------------------------------------
// BEHAVIOUR 2 — the owner path of #8411: a switch from an ALREADY-DISCONNECTED tab.
// ---------------------------------------------------------------------------
describe.each([
  ['switchServer', (id: string) => useConnectionStore.getState().switchServer(id)],
  ['connectLocal', (_id: string) => useConnectionStore.getState().connectLocal()],
])('#8411 %s from connectionPhase disconnected clears both rosters', (_name, run) => {
  let serverBId = ''

  beforeEach(() => {
    // Stub the network-touching `connect`; the thing under test is the synchronous state
    // the switch leaves BEHIND before it delegates.
    useConnectionStore.setState({ connect: vi.fn() } as unknown as Partial<State>)
    const a = useConnectionStore.getState().addServer('A', 'wss://server-a/ws', 'tok-a')
    const b = useConnectionStore.getState().addServer('B', 'wss://server-b/ws', 'tok-b')
    serverBId = b.id
    seed({ activeServerId: a.id, connectionPhase: 'disconnected', socket: null } as unknown as Partial<State>)
  })

  it('control: the tab really rests at disconnected with the previous server\'s readings loaded', () => {
    expect(read().connectionPhase).toBe('disconnected')
    expect(read().socket).toBeNull()
    expect(read().pendingPermissionConfirm).not.toBeNull()
  })

  it.each([...PANEL_KEYS, ...READING_KEYS])('clears %s', (k) => {
    run(serverBId)
    expect(
      read()[k],
      `${k} survived a switch made from the disconnected phase: server A's reading is now shown as server B's`,
    ).toEqual({ ...PANELS, ...READINGS }[k])
  })

  it('POSITIVE CONTROL: the switch from a CONNECTED tab still clears them (the path that worked)', () => {
    useConnectionStore.setState({
      connectionPhase: 'connected',
      socket: { close: vi.fn(), readyState: 1 } as unknown as WebSocket,
    } as unknown as Partial<State>)
    run(serverBId)
    expectRoster({ ...PANELS, ...READINGS }, [...PANEL_KEYS, ...READING_KEYS], 'a connected-tab switch')
  })
})

// ---------------------------------------------------------------------------
// BEHAVIOUR 3 — session changes: switchSession (both branches) and both death paths
// clear the PANELS, and leave the READINGS alone.
// ---------------------------------------------------------------------------
describe('#7588 an active-session change clears the panels and only the panels', () => {
  const ctx = () => ({
    url: 'wss://t', token: 'tok', isReconnect: false, silent: false,
    socket: { send: vi.fn(), close: vi.fn(), readyState: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  })

  function seedTwoSessions(): { panelsDirty: Roster; readingsDirty: Roster } {
    clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
    seed({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' }, { sessionId: 's2', name: 'S2' }],
      sessionStates: { s1: createEmptySessionState(), s2: createEmptySessionState() },
      socket: null,
    } as unknown as Partial<State>)
    return { panelsDirty: dirtyOf(PANELS), readingsDirty: dirtyOf(READINGS) }
  }

  const SITES: Array<[string, () => void]> = [
    ['switchSession (cached branch)', () => { useConnectionStore.getState().switchSession('s2') }],
    ['switchSession (uncached branch)', () => {
      // `s3` is listed but has no cached state: the else branch.
      useConnectionStore.setState({
        sessions: [{ sessionId: 's1', name: 'S1' }, { sessionId: 's3', name: 'S3' }],
      } as unknown as Partial<State>)
      useConnectionStore.getState().switchSession('s3')
    }],
    ['the session_list active-removal death path', () => {
      handleMessage({ type: 'session_list', sessions: [{ sessionId: 's2', name: 'S2' }] } as never, ctx() as never)
    }],
    ['the session_timeout death path', () => {
      handleMessage({ type: 'session_timeout', sessionId: 's1', name: 'S1', idleMs: 600000 } as never, ctx() as never)
    }],
  ]

  describe.each(SITES)('%s', (name, run) => {
    it('control: the active session changed', () => {
      seedTwoSessions()
      run()
      expect(read().activeSessionId, `${name} did not move the active session`).not.toBe('s1')
    })

    it.each(PANEL_KEYS)('resets panel field %s', (k) => {
      seedTwoSessions()
      run()
      expect(read()[k]).toEqual(PANELS[k])
    })

    it('leaves the connection-lifetime readings alone (a session change is not a daemon change)', () => {
      const { readingsDirty } = seedTwoSessions()
      run()
      expectUntouched(readingsDirty, READING_KEYS, name)
    })
  })

  it('POSITIVE CONTROL: a BACKGROUND session dying does not blank the active panels', () => {
    const { panelsDirty } = seedTwoSessions()
    handleMessage({ type: 'session_list', sessions: [{ sessionId: 's1', name: 'S1' }] } as never, ctx() as never)
    expect(read().activeSessionId).toBe('s1')
    expectUntouched(panelsDirty, PANEL_KEYS, 'a background session_list removal')

    handleMessage({ type: 'session_timeout', sessionId: 's2', name: 'S2', idleMs: 600000 } as never, ctx() as never)
    expectUntouched(panelsDirty, PANEL_KEYS, 'a background session_timeout')
  })
})

// ---------------------------------------------------------------------------
// STRUCTURE — each site takes its roster by spread and hand-lists none of its keys.
// ---------------------------------------------------------------------------
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

function slice(src: string, startNeedle: string, endNeedle: string): string {
  const s = src.indexOf(startNeedle)
  expect(s, `${startNeedle} must exist`).toBeGreaterThan(-1)
  const e = src.indexOf(endNeedle, s + startNeedle.length)
  expect(e, `${endNeedle} must follow ${startNeedle}`).toBeGreaterThan(s)
  return stripComments(src.slice(s, e))
}

/** A key hand-assigned as a literal member (`key:`), an assignment (`key =`) or `patch.key =`. */
const handListed = (code: string, keys: string[]): string[] =>
  keys.filter((k) => new RegExp(`(^|[^A-Za-z0-9_$])${k}\\s*[:=][^=]`).test(code))

const connectionBodies = {
  disconnect: slice(storeSrc, "      connectionPhase: 'disconnected',", '  forgetSession:'),
  forgetSession: slice(storeSrc, '  forgetSession: () => {', '  /** Reset in-memory session state'),
  _resetSessionMemory: slice(storeSrc, '  _resetSessionMemory: () => {', '  setViewMode:'),
  switchSession: slice(storeSrc, '  switchSession: (', '  // #6285 — return whether the create request'),
}

describe('#8411 / #7588 structure: every reset site takes the roster by spread, never by literal', () => {
  it('control: the four connection.ts bodies were found and are non-trivial', () => {
    for (const [name, body] of Object.entries(connectionBodies)) {
      expect(body.length, `${name} body not found`).toBeGreaterThan(300)
    }
  })

  const FULL_RESETS = ['disconnect', 'forgetSession', '_resetSessionMemory'] as const

  it.each(FULL_RESETS)('%s spreads BOTH factories', (name) => {
    const body = connectionBodies[name]
    expect(body.includes('...createEmptySessionPanels()'), `${name} must spread createEmptySessionPanels()`).toBe(true)
    expect(body.includes('...createEmptyConnectionReadings()'), `${name} must spread createEmptyConnectionReadings()`).toBe(true)
  })

  it.each(FULL_RESETS)('%s hand-lists none of either roster\'s keys', (name) => {
    expect(
      handListed(connectionBodies[name], [...PANEL_KEYS, ...READING_KEYS]),
      `${name} spells out a field the factories already own: the next field added to one place will miss the other (#7588)`,
    ).toEqual([])
  })

  it('switchSession takes the panels from the factory (both branches follow it) and hand-lists no panel key', () => {
    const body = connectionBodies.switchSession
    expect(/set\(createEmptySessionPanels\(\)\)/.test(body), 'switchSession must set the panel factory').toBe(true)
    // It runs BEFORE the cached / uncached split, so it covers both branches.
    expect(
      body.indexOf('createEmptySessionPanels()') < body.indexOf('const cached ='),
      'the panel reset must precede the cached/uncached branch split',
    ).toBe(true)
    expect(handListed(body, PANEL_KEYS)).toEqual([])
  })

  // The closed-world half of the guard (#7588's exact scenario). The checks above only know
  // the keys a factory ALREADY owns, so a NEW reset value written beside the factory
  // (`set({ claudeMdDraft: null })`) is invisible to them whatever it is called. These
  // enumerate every state write the site makes and allow only the known ones.
  const FLAT_MIRROR_KEYS = Object.keys(createEmptyFlatSessionMirror())

  const setHeads = (code: string): string[] =>
    [...code.matchAll(/\bset\(\s*(\{\s*[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*\(\))/g)].map((m) => m[1]!.replace(/\s+/g, ' '))

  it('switchSession makes exactly four state writes, and the panel factory is the only reset among them', () => {
    expect(
      setHeads(connectionBodies.switchSession),
      'switchSession writes state the guard does not know. A new reset value beside the factory is the ' +
      'copy that drifts (#7588): add it to createEmptySessionPanels(), not to a second set().',
    ).toEqual([
      '{ sessionNotFoundError',
      'createEmptySessionPanels()',
      '{ activeSessionId',
      '{ activeSessionId',
    ])
  })

  it('the cached and uncached branch literals of switchSession write only the active id, notifications and the flat mirror', () => {
    const body = connectionBodies.switchSession
    const branches = body.slice(body.indexOf('if (cached) {'), body.indexOf('if (socket && socket.readyState'))
    const keys = [...branches.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]!)
    expect(keys.length, 'the branch extraction matched (almost) nothing').toBeGreaterThanOrEqual(24)
    const allowed = new Set([...FLAT_MIRROR_KEYS, 'activeSessionId', 'sessionNotifications'])
    expect(keys.filter((k) => !allowed.has(k)), 'a branch of switchSession writes a field outside the flat mirror').toEqual([])
  })

  const deathBlocks = (): string[] => {
    const out: string[] = []
    let from = 0
    for (;;) {
      const s = handlerSrc.indexOf('patch.activeSessionId = nextId;', from)
      if (s < 0) break
      const e = handlerSrc.indexOf('set(patch);', s)
      expect(e, 'a death-path block has no set(patch)').toBeGreaterThan(s)
      out.push(stripComments(handlerSrc.slice(s, e)))
      from = e
    }
    return out
  }

  it('control: both death-path blocks were found', () => {
    const blocks = deathBlocks()
    expect(blocks.length, 'session_list and session_timeout each switch the active session').toBe(2)
    for (const b of blocks) expect(b.length).toBeGreaterThan(400)
  })

  it('each death path writes only the active id, the flat mirror and the panel factory (no state it does not know)', () => {
    const allowed = new Set([...FLAT_MIRROR_KEYS, 'activeSessionId'])
    for (const block of deathBlocks()) {
      const written = [...block.matchAll(/\bpatch\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]!)
      expect(written.length, 'the write extraction matched nothing').toBeGreaterThanOrEqual(12)
      expect(
        written.filter((k) => !allowed.has(k)),
        'a death path writes a field outside the flat mirror beside the panel factory: a new per-session reset ' +
        'value belongs in createEmptySessionPanels() (#7588)',
      ).toEqual([])
      expect(block.match(/Object\.assign\(patch, createEmptySessionPanels\(\)\)/g)?.length).toBe(1)
      // Any other way of writing state into the patch or the store is also unknown.
      expect(block.match(/Object\.assign\(/g)?.length, 'an Object.assign other than the panel factory').toBe(1)
      expect(/(^|[^\w$.])set\(/.test(block), 'a death-path block writes the store directly').toBe(false)
      expect(/\.\.\.\w/.test(block), 'a spread into the patch that the guard does not know').toBe(false)
    }
  })

  it('switchSession does NOT clear the connection-lifetime readings', () => {
    // A session change must not discard a pending file-open or the references modal.
    expect(handListed(connectionBodies.switchSession, READING_KEYS)).toEqual([])
    expect(connectionBodies.switchSession.includes('createEmptyConnectionReadings')).toBe(false)
  })

  it('the two death paths in message-handler.ts spread the panel factory and hand-write no panel key', () => {
    const code = stripComments(handlerSrc)
    const uses = code.match(/Object\.assign\(patch, createEmptySessionPanels\(\)\)/g) ?? []
    expect(uses.length, 'session_list and session_timeout must each take the panel roster').toBe(2)
    // The hand copies were `patch.<key> = …`; any one growing back is the drift.
    const literal = PANEL_KEYS.filter((k) => new RegExp(`\\bpatch\\.${k}\\s*=`).test(code))
    expect(literal, 'a death path re-spells a panel field instead of taking it from the factory').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// COMPLETENESS — a field added to the type but not to the factory is red.
// ---------------------------------------------------------------------------
describe('#7588 completeness: the factory covers the panel families, and the store is built from it', () => {
  const interfaceStart = typesSrc.indexOf('export interface ConnectionState')
  const declared = new Set(
    [...typesSrc.slice(interfaceStart).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!),
  )

  it('control: the ConnectionState members were extracted', () => {
    expect(interfaceStart).toBeGreaterThan(-1)
    expect(declared.size).toBeGreaterThan(200)
    expect(declared.has('memoryStackFile')).toBe(true)
  })

  // The panel families are the two the issue names. A new member of either that is not in
  // the factory misses every death-path copy: exactly the 8th-field hazard.
  const FAMILIES = ['memoryStack', 'permissionAudit']
  // The one family member that is deliberately NOT per-session (see the factory docstring).
  const NOT_A_SESSION_PANEL = ['lastMemoryStackRequestId']

  it('every declared memoryStack* / permissionAudit* member is in a factory', () => {
    const family = [...declared].filter((n) => FAMILIES.some((p) => n.startsWith(p)) || /^last(MemoryStack|PermissionAudit)/.test(n))
    expect(family.length, 'the family extraction matched nothing').toBeGreaterThanOrEqual(8)
    const missing = family.filter((n) => !PANEL_KEYS.includes(n) && !READING_KEYS.includes(n))
    expect(
      missing,
      'a member of a per-active-session panel family is declared on ConnectionState and owned by no reset factory: ' +
      'the session-death paths and the full resets will leave it behind (#7588). Add it to ' +
      'createEmptySessionPanels() (per active session) or createEmptyConnectionReadings() (per connection).',
    ).toEqual([])
    for (const n of NOT_A_SESSION_PANEL) expect(READING_KEYS).toContain(n)
  })

  it('every factory key is a declared ConnectionState member', () => {
    expect([...PANEL_KEYS, ...READING_KEYS].filter((k) => !declared.has(k))).toEqual([])
  })

  it('the store is CONSTRUCTED with the factory values (no second copy of the reset value)', () => {
    for (const k of [...PANEL_KEYS, ...READING_KEYS]) {
      expect(INITIAL[k], `${k}: the initial state disagrees with the factory`).toEqual({ ...PANELS, ...READINGS }[k])
    }
  })

  it('the derivation is red on a phantom: a panel field absent from the factory is reported', () => {
    // The same predicate, against a phantom roster, so "a new family member misses the
    // factory goes red" is a permanent cell rather than a mutant someone ran once.
    const phantomDeclared = new Set([...declared, 'memoryStackStale'])
    const missing = [...phantomDeclared].filter(
      (n) => (FAMILIES.some((p) => n.startsWith(p))) && !PANEL_KEYS.includes(n) && !READING_KEYS.includes(n),
    )
    expect(missing).toEqual(['memoryStackStale'])
  })
})
