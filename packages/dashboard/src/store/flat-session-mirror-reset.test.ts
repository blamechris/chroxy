/**
 * #7555 — the FLAT session mirror must be reset with the roster it mirrors.
 *
 * ## The shape
 *
 * `ConnectionState` carries a copy of the ACTIVE session's per-session state at
 * top level — `isIdle`, `claudeReady`, `activeModel`, the context meters, the
 * last result's cost/duration, and the transcript itself. `App.tsx` reads those
 * FLAT fields (`isBusy={!isIdle}` drives the Send/Stop button and the Working
 * banner), so they are not a cache: they are what the user sees.
 *
 * The three sites that empty the session roster wholesale — `forgetSession`,
 * `_resetSessionMemory` (switchServer / connectLocal) and `auth_ok`'s
 * non-reconnect branch — emptied `sessions`, `sessionStates` and
 * `activeSessionId` and left that mirror behind. It then described a session
 * that no longer exists, on a server that may not be the one it came from.
 *
 * ## Why the consumer-side convergence is not enough
 *
 * #7550 converges `isIdle` ALONE, at the `session_list` consumer, and only when
 * the active session appears in the snapshot carrying a boolean `isBusy`. Two
 * sub-cases it structurally cannot see are reproduced at the bottom of this
 * file; both are DURABLE on a server that has no session for the restored id,
 * because `sendPostAuthInfo` only sends `session_switched` `if (entry)`
 * (`packages/server/src/ws-history.js`), so nothing re-syncs the mirror from a
 * shell either. Symptom: a Stop button and a Working banner on a dashboard with
 * no session at all.
 *
 * That is the "adjacent-field" pattern — a roster of twelve, a fix that touches
 * one, at the consumer. The repair is at the SOURCE: reset the whole flat block
 * where the roster is emptied.
 *
 * ## The roster is DERIVED, not hand-written
 *
 * `FLAT_SESSION_FIELDS` is pinned against `keyof ConnectionState & keyof
 * SessionState` — read structurally out of `types.ts` by the guard below — so a
 * thirteenth field declared on both interfaces is RED until someone puts it in
 * the roster or says why it does not belong. A hand-list beside the state type
 * is exactly the drift this issue is an instance of
 * (`docs/false-safety-guards.md`, "a hardcoded list next to a set that grows").
 *
 * The EXPECTED post-reset values below are written out LITERALLY rather than
 * read from `createEmptySessionState()`, because the fix derives from that same
 * function: an expectation derived from its own subject cannot go red (#7424).
 * The parity cell pins the two together instead, so a changed session default
 * is a red that a human re-adjudicates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import ts from 'typescript'

// Mock localStorage before importing the store (same idiom as
// session-reset-clears-pr-maps.test.ts — connection.ts reads persisted settings
// at module scope).
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
type ConnectionState = import('./types').ConnectionState

const A = 'sess-from-server-A'

/**
 * The twelve flat fields and the value each must hold once the session they
 * mirror is gone. Hand-written on purpose — see the file docstring.
 */
const EXPECTED_AFTER_RESET = {
  messages: [],
  streamingMessageId: null,
  claudeReady: false,
  activeModel: null,
  permissionMode: null,
  contextUsage: null,
  contextOccupancy: null,
  lastResultCost: null,
  lastResultDuration: null,
  isIdle: true,
  primaryClientId: null,
  terminalRawBuffer: '',
} as const

const FLAT_FIELDS = Object.keys(EXPECTED_AFTER_RESET) as (keyof typeof EXPECTED_AFTER_RESET)[]

/**
 * Every flat field set to something the reset must NOT leave behind. Each value
 * differs from its `EXPECTED_AFTER_RESET` counterpart, which the control cell
 * below asserts field by field — an "everything is default afterwards" check
 * that the fixture never dirtied would pass for free.
 */
function dirtyFlatState(): Partial<ConnectionState> {
  return {
    messages: [{ id: 'm-A', type: 'response', content: 'from server A', timestamp: 1 }],
    streamingMessageId: 'stream-A',
    claudeReady: true,
    activeModel: 'claude-opus-4-1',
    permissionMode: 'acceptEdits',
    contextUsage: { inputTokens: 111, outputTokens: 222, cacheCreation: 333, cacheRead: 444 },
    contextOccupancy: {
      totalTokens: 90000,
      maxTokens: 200000,
      autoCompactThreshold: 160000,
      isAutoCompactEnabled: true,
      source: 'context-usage-api',
    },
    lastResultCost: 1.23,
    lastResultDuration: 4567,
    isIdle: false,
    primaryClientId: 'client-on-server-A',
    terminalRawBuffer: 'raw bytes from server A',
  }
}

/** The previous server's world: one busy session, and the flat mirror of it. */
function seedPreviousServer() {
  useConnectionStore.setState({
    sessions: [{ sessionId: A }] as never,
    activeSessionId: A,
    sessionStates: { [A]: { ...createEmptySessionState(), isIdle: false, claudeReady: true } },
    ...dirtyFlatState(),
  })
}

/** Put the flat block back to its empty values so this file cannot leak. */
function restoreFlatState() {
  useConnectionStore.setState({
    ...(EXPECTED_AFTER_RESET as unknown as Partial<ConnectionState>),
    messages: [],
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
  })
}

describe('#7555 the flat session mirror is derived, not hand-listed', () => {
  // The derivation is the TypeScript CHECKER, not a regex over the source.
  //
  // PR #7564's review killed the regex version with the declaration style the
  // repo already uses: `/^ {2}(\w+)\??: ([^\n]*)$/` requires the type to start
  // on the same line as the colon, so a member written
  //
  //     lastTurnSummary:
  //       | { text: string; at: number }
  //       | null;
  //
  // was invisible to it — a genuine thirteenth flat field, never reset at any of
  // the three sites, and the whole file stayed green at 53/53. That is not
  // hypothetical about THIS interface: `ConnectionState` already declares
  // `addMcpServer` across six lines, which is why the regex OVER-included it.
  //
  // `docs/false-safety-guards.md`, "a guard whose comment describes a stronger
  // check than its code performs" — committed inside the guard written to
  // prevent its cousin, which is the same way #7481 killed this file's ancestor.
  //
  // A shape-guard cell rejecting `/^ {2}\w+\??:\s*$/` would have closed THAT
  // spelling. The checker closes the CLASS: it is the real `keyof
  // ConnectionState & keyof SessionState`, the same expression the compile-time
  // binding in `store/utils.ts` asserts the roster is a subset of — so the two
  // halves of the contract are now written against one definition of "declared
  // on both interfaces" rather than two.
  const typesPath = resolve(__dirname, 'types.ts')

  /** Property names of a named interface, resolved by the checker. */
  function interfaceProps(program: ts.Program, sf: ts.SourceFile, name: string): string[] {
    let decl: ts.InterfaceDeclaration | null = null
    ts.forEachChild(sf, (n) => {
      if (ts.isInterfaceDeclaration(n) && n.name.text === name) decl = n
    })
    expect(decl, `interface ${name} must exist in ${sf.fileName}`).not.toBeNull()
    return program
      .getTypeChecker()
      .getTypeAtLocation((decl as unknown as ts.InterfaceDeclaration).name)
      .getProperties()
      .map((s) => s.getName())
  }

  /** `keyof ConnectionState & keyof SessionState`, for a built program. */
  function intersectionOf(program: ts.Program, sf: ts.SourceFile): string[] {
    const conn = new Set(interfaceProps(program, sf, 'ConnectionState'))
    return interfaceProps(program, sf, 'SessionState').filter((p) => conn.has(p)).sort()
  }

  /**
   * A program over the REAL `types.ts`. `SessionState extends BaseSessionState`
   * from `@chroxy/store-core`, and the checker follows that import itself — so
   * unlike the regex version this needs no second hand-named source file, and a
   * field moving between the base and the derived interface changes nothing.
   */
  const realProgram = ts.createProgram([typesPath], {
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
  const realSf = realProgram.getSourceFile(typesPath)!

  /** A program over an in-memory synthetic source, for the phantom cells. */
  function syntheticProgram(source: string): { program: ts.Program; sf: ts.SourceFile } {
    const fileName = '/synthetic-state.ts'
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true)
    const host: ts.CompilerHost = {
      getSourceFile: (f) => (f === fileName ? sf : undefined),
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => {},
      getCurrentDirectory: () => '/',
      getDirectories: () => [],
      fileExists: (f) => f === fileName,
      readFile: (f) => (f === fileName ? source : undefined),
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
    }
    const program = ts.createProgram([fileName], { noLib: true, strict: true }, host)
    return { program, sf: program.getSourceFile(fileName)! }
  }
  const syntheticIntersection = (source: string): string[] => {
    const { program, sf } = syntheticProgram(source)
    return intersectionOf(program, sf)
  }

  it('control: the checker really resolved both interfaces', () => {
    // Non-vacuous in both directions. An unresolved program yields zero
    // properties, which would make the intersection empty and every roster
    // assertion below pass for free.
    expect(realSf, 'types.ts must be in the program').toBeTruthy()
    expect(
      interfaceProps(realProgram, realSf, 'ConnectionState').length,
      'no ConnectionState properties resolved',
    ).toBeGreaterThan(300)
    expect(
      interfaceProps(realProgram, realSf, 'SessionState').length,
      'no SessionState properties resolved — the store-core import did not resolve',
    ).toBeGreaterThan(40)
  })

  it('SessionState declares no callable property — so the intersection is data-only', () => {
    // Why the intersection needs no function filter, asserted rather than
    // assumed. `ConnectionState` mixes ~195 state members with ~200 ACTIONS, and
    // a plain `keyof ∩ keyof` would happily include an action whose name
    // collided with a session field — `createEmptyFlatSessionMirror` would then
    // copy a function into flat state. It cannot happen while this holds, and
    // if `SessionState` ever grows a callback member this cell says so instead
    // of the roster quietly admitting one.
    const checker = realProgram.getTypeChecker()
    let decl: ts.InterfaceDeclaration | null = null
    ts.forEachChild(realSf, (n) => {
      if (ts.isInterfaceDeclaration(n) && n.name.text === 'SessionState') decl = n
    })
    const callable = checker
      .getTypeAtLocation((decl as unknown as ts.InterfaceDeclaration).name)
      .getProperties()
      .filter((s) => {
        const at = s.valueDeclaration ?? s.declarations?.[0]
        if (!at) return false
        return checker.getTypeOfSymbolAtLocation(s, at).getCallSignatures().length > 0
      })
      .map((s) => s.getName())
    expect(callable, 'SessionState grew a callable property — re-adjudicate the roster').toEqual([])
  })

  it('the roster IS `keyof ConnectionState & keyof SessionState`', () => {
    expect(
      intersectionOf(realProgram, realSf),
      'a field is declared on BOTH ConnectionState and SessionState but is not in the flat-mirror ' +
      'roster (or vice versa). Every such field holds the ACTIVE session\'s value at top level, so ' +
      'a site that empties the roster must reset it — add it to FLAT_SESSION_FIELDS in ' +
      'store/utils.ts (which resets it at all three sites for free) and to EXPECTED_AFTER_RESET ' +
      'here. #7555',
    ).toEqual([...FLAT_FIELDS].sort())
  })

  it('the roster the SOURCE resets is this roster', async () => {
    const { FLAT_SESSION_FIELDS } = await import('./utils')
    expect([...FLAT_SESSION_FIELDS].sort()).toEqual([...FLAT_FIELDS].sort())
  })

  it('parity: every EXPECTED value equals the empty SessionState default', () => {
    // The two halves the docstring keeps apart: the literal expectation above
    // and the derivation the fix uses. Divergence is a red a human reads, not a
    // silently-adopted new default.
    const empty = createEmptySessionState() as unknown as Record<string, unknown>
    for (const f of FLAT_FIELDS) {
      expect(empty[f], `empty SessionState.${f} disagrees with EXPECTED_AFTER_RESET.${f}`)
        .toEqual(EXPECTED_AFTER_RESET[f])
    }
  })

  // ---- The derivation's own contract, on synthetic sources. -------------
  //
  // PERMANENT cells rather than one-off mutants, the same move
  // `session-destroy-prunes-pr-maps.test.ts` makes for its site detector and for
  // the same reason: a mutant proves the guard was alive on the day someone ran
  // it, and these prove it is alive on every run. Named for what a real
  // thirteenth field would be called, not for the pattern that extracts it —
  // #7481's review killed a guard certified by a mutant named after its own
  // regex, and #7564's review killed this one's regex outright.

  it('sees a phantom 13th field declared on BOTH interfaces', () => {
    // THE cell the roster exists for: a new flat field lands on both interfaces
    // and is RED until it joins the roster (which resets it at all three sites)
    // or someone says why it should not.
    expect(
      syntheticIntersection(`
        export interface ConnectionState {
          isIdle: boolean;
          lastTurnSummary: { text: string; at: number } | null;
        }
        export interface SessionState {
          isIdle: boolean;
          lastTurnSummary: { text: string; at: number } | null;
          selectedFilePath: string | null;
        }
      `),
    ).toEqual(['isIdle', 'lastTurnSummary'])
  })

  it('sees a phantom 13th field whose TYPE starts on the next line', () => {
    // #7564 review, finding 1 — the exact evasion that took the regex version
    // to 53/53 green, byte for byte, kept as a cell so the spelling cannot come
    // back as a blind spot. The six-line `addMcpServer` beside it is the shape
    // that already exists at types.ts (the regex OVER-included it), here to
    // prove the checker is not merely tolerant of multi-line members but
    // correct about them: an action must NOT enter the intersection.
    expect(
      syntheticIntersection(`
        export interface ConnectionState {
          isIdle: boolean;
          lastTurnSummary:
            | { text: string; at: number }
            | null;
          addMcpServer: (
            name: string,
            cfg: { command: string },
            scope: 'user' | 'project',
          ) => void;
        }
        export interface SessionState {
          isIdle: boolean;
          lastTurnSummary: { text: string; at: number } | null;
          selectedFilePath: string | null;
        }
      `),
    ).toEqual(['isIdle', 'lastTurnSummary'])
  })

  it('does not read members off a NEIGHBOURING interface', () => {
    // types.ts declares plenty of other interfaces. A field that happens to be
    // named the same on one of them is not store state, and extracting it would
    // make the roster permanently red on a phantom.
    expect(
      syntheticIntersection(`
        export interface ConnectionState { isIdle: boolean; }
        export interface McpServerConfig { claudeReady: boolean; }
        export interface SessionState { isIdle: boolean; claudeReady: boolean; }
      `),
    ).toEqual(['isIdle'])
  })

  it('an action that exists on ConnectionState alone stays out of the roster', () => {
    // The over-inclusion half. `ConnectionState` is roughly half actions; the
    // intersection must be indifferent to all of them.
    expect(
      syntheticIntersection(`
        export interface ConnectionState {
          isIdle: boolean;
          switchSession: (id: string) => boolean;
          setViewMode: (m: 'chat' | 'terminal') => void;
        }
        export interface SessionState { isIdle: boolean; selectedFilePath: string | null; }
      `),
    ).toEqual(['isIdle'])
  })

  it('follows `extends`, so a base-interface field still counts', () => {
    // The real `SessionState extends BaseSessionState` from @chroxy/store-core,
    // in miniature. The regex version needed the base file named by hand; the
    // checker does not, and a field MOVING between the two must not change the
    // roster.
    expect(
      syntheticIntersection(`
        export interface BaseSessionState { isIdle: boolean; }
        export interface ConnectionState { isIdle: boolean; selectedFilePath: string | null; }
        export interface SessionState extends BaseSessionState { selectedFilePath: string | null; }
      `),
    ).toEqual(['isIdle', 'selectedFilePath'])
  })


  it('the not-mirrored exclusion list names only REAL roster fields', async () => {
    // #7564 review, finding 2 (Copilot's thread). `Record<string, string>`
    // accepted any key, so `primaryClientld` (lowercase L) silently promoted
    // `primaryClientId` back into the mirror with tsc and 1458 store tests
    // green. The `satisfies Partial<Record<FlatSessionField, string>>` in
    // utils.ts is the primary fix and turns that typo into a COMPILE error;
    // this is the runtime half, so the pin survives a future widening of the
    // declared type.
    const { FLAT_SESSION_FIELDS, FLAT_SESSION_FIELDS_NOT_MIRRORED, UPDATE_SESSION_MIRRORED_FIELDS } =
      await import('./utils')
    const roster = new Set<string>(FLAT_SESSION_FIELDS)
    const excluded = Object.keys(FLAT_SESSION_FIELDS_NOT_MIRRORED)
    expect(
      excluded.filter((k) => !roster.has(k)),
      'a not-mirrored key is not a FLAT_SESSION_FIELDS member — a typo here silently MIRRORS the ' +
      'field it was meant to exclude. #7564',
    ).toEqual([])
    // Non-vacuous: the list is not empty, so the filter above is doing work.
    expect(excluded.length, 'the exclusion list is empty — this cell proves nothing').toBe(2)
    // …and the derived list really is the roster MINUS exactly those keys.
    expect([...UPDATE_SESSION_MIRRORED_FIELDS].sort())
      .toEqual([...FLAT_SESSION_FIELDS].filter((f) => !excluded.includes(f)).sort())
    // Every exclusion carries a reason, not a placeholder.
    for (const [k, reason] of Object.entries(FLAT_SESSION_FIELDS_NOT_MIRRORED)) {
      expect(reason.length, `${k} needs a real reason`).toBeGreaterThan(40)
    }
  })

  it('the exclusion filter reads OWN properties, not the prototype chain', () => {
    // `in` would exclude a flat field named `toString` / `constructor` /
    // `valueOf` on the strength of Object.prototype alone, silently dropping it
    // from the mirror. Proven on the same predicate the source uses, because
    // no such field exists yet to prove it on directly (#7564 review).
    const excl = { primaryClientId: 'x' } as Record<string, string>
    const own = (f: string) => Object.prototype.hasOwnProperty.call(excl, f)
    expect('toString' in excl, 'the prototype-chain hazard is real').toBe(true)
    expect(own('toString'), 'hasOwnProperty must not see the prototype chain').toBe(false)
    expect(own('primaryClientId')).toBe(true)
  })

  it("updateSession's mirror block has no hand-written field assignment left", () => {
    // Anchored to the block, not the file: a file-wide grep would be satisfied
    // by any of the hundreds of other `flatPatch`-shaped lines. The mirror is a
    // loop over the roster now, so ANY `flatPatch.<field> =` inside it is a
    // hand-list growing back.
    const src = readFileSync(resolve(__dirname, 'message-handler.ts'), 'utf8')
    const start = src.indexOf('export function updateSession(')
    expect(start, 'updateSession must exist').toBeGreaterThan(-1)
    const end = src.indexOf('export function updateActiveSession(', start)
    expect(end, 'updateActiveSession must follow it').toBeGreaterThan(start)
    const block = src.slice(start, end)
    const handWritten = [...block.matchAll(/flatPatch\.(\w+)\s*=/g)].map((m) => m[1]!)
    expect(
      handWritten,
      'updateSession mirrors a field by hand again — the roster in store/utils.ts is the one list. #7555',
    ).toEqual([])
    // Non-vacuous: the loop the assertion is about is actually there.
    expect(/for \(const \w+ of UPDATE_SESSION_MIRRORED_FIELDS\)/.test(block)).toBe(true)
  })
})

describe.each([
  ['forgetSession', () => useConnectionStore.getState().forgetSession()],
  ['_resetSessionMemory', () => useConnectionStore.getState()._resetSessionMemory()],
])('#7555 %s resets the flat session mirror', (_name, run) => {
  beforeEach(() => {
    restoreFlatState()
    seedPreviousServer()
  })

  it('control: the fixture dirtied every flat field', () => {
    const s = useConnectionStore.getState() as unknown as Record<string, unknown>
    for (const f of FLAT_FIELDS) {
      expect(s[f], `${f} was not dirtied — every assertion below would pass for free`)
        .not.toEqual(EXPECTED_AFTER_RESET[f])
    }
  })

  // One cell per field: a reset that clears eleven of twelve must name the
  // twelfth. A single "the whole block is empty" assertion is satisfied by
  // eleven, which is the adjacent-field failure this issue IS.
  it.each(FLAT_FIELDS)('resets %s', (field) => {
    run()
    const s = useConnectionStore.getState() as unknown as Record<string, unknown>
    expect(s[field]).toEqual(EXPECTED_AFTER_RESET[field])
  })

  it('resets it in the same patch that empties the roster', () => {
    run()
    const s = useConnectionStore.getState()
    expect(s.sessionStates).toEqual({})
    expect(s.sessions).toEqual([])
    expect(s.activeSessionId).toBeNull()
  })
})

describe('#7555 auth_ok resets the flat mirror on a fresh connect only', () => {
  let mockSocket: WebSocket

  function authOk(): Record<string, unknown> {
    return {
      type: 'auth_ok',
      serverMode: 'cli',
      cwd: '/home/user/project',
      defaultCwd: '/home/user',
      serverVersion: '0.11.0',
      protocolVersion: 3,
      clientId: 'client-1',
      connectedClients: [{ clientId: 'client-1', deviceName: 'Dashboard', deviceType: 'desktop', platform: 'macos' }],
    }
  }
  const freshCtx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })
  const reconnectCtx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: true, silent: false })

  beforeEach(() => {
    clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
    mockSocket = { send: vi.fn(), close: vi.fn(), readyState: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket
    restoreFlatState()
    seedPreviousServer()
  })
  afterEach(() => { stopHeartbeat(); restoreFlatState() })

  it.each(FLAT_FIELDS)('a fresh connect resets %s', (field) => {
    handleMessage(authOk(), freshCtx() as never)
    const s = useConnectionStore.getState() as unknown as Record<string, unknown>
    expect(s[field]).toEqual(EXPECTED_AFTER_RESET[field])
  })

  /**
   * Two roster members are reset on EVERY `auth_ok`, both branches, by the
   * `connectedState` object the handler builds before it branches — and that
   * predates this issue. A dropped socket invalidates readiness and any
   * in-flight stream id whether or not the roster survives, so `claude_ready`
   * and the next `stream_start` re-establish them. Named here rather than
   * silently excluded, and asserted to be EXACTLY these two so the exemption
   * cannot quietly grow to cover a field the reconnect branch starts blanking
   * by accident.
   */
  const RESET_ON_EVERY_AUTH_OK = ['claudeReady', 'streamingMessageId'] as const

  it('POSITIVE CONTROL: a silent RECONNECT keeps the mirror, because it keeps the roster', () => {
    // The reconnect branch preserves `sessionStates`, so the mirror still
    // describes a session that exists — blanking it here would wipe the
    // transcript and flip the Send/Stop button on every transient drop. This is
    // what stops the fix degenerating into "reset on every auth_ok".
    handleMessage(authOk(), reconnectCtx() as never)
    const s = useConnectionStore.getState() as unknown as Record<string, unknown>
    expect(Object.keys(useConnectionStore.getState().sessionStates)).toEqual([A])
    const dirty = dirtyFlatState() as unknown as Record<string, unknown>
    const kept = FLAT_FIELDS.filter((f) => !(RESET_ON_EVERY_AUTH_OK as readonly string[]).includes(f))
    for (const f of kept) {
      expect(s[f], `a silent reconnect must not reset ${f}`).toEqual(dirty[f])
    }
    // The exemption, pinned: these two ARE reset on a reconnect, and nothing
    // else is. Asserting the carve-out rather than just skipping it is what
    // keeps `kept` from silently shrinking to nothing.
    for (const f of RESET_ON_EVERY_AUTH_OK) {
      expect(s[f], `${f} is exempt because connectedState resets it on both branches`)
        .toEqual(EXPECTED_AFTER_RESET[f])
    }
    expect(kept.length, 'the exemption swallowed the whole roster').toBe(FLAT_FIELDS.length - 2)
  })
})

/**
 * The two residues the #7550 convergence structurally cannot reach, driven
 * through the REAL `switchServer` sequence: `_resetSessionMemory()`, then
 * `activeSessionId` restored from persistence, then the new server's first
 * `session_list`.
 *
 * Both were measured on the pre-fix tree by the reviewer who filed #7555, and
 * both are held here as the end-to-end statement of what the reset buys: the
 * consumer-side force converges the ACTIVE session when the snapshot has an
 * opinion about it, and these are the two cases where it has none.
 */
describe('#7555 the reset closes the two residues #7550 cannot reach', () => {
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
    mockSocket = { send: vi.fn(), close: vi.fn(), readyState: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket
    restoreFlatState()
    seedPreviousServer()
  })
  afterEach(() => { stopHeartbeat(); restoreFlatState() })

  it('control: the previous server left a BUSY flat mirror behind', () => {
    expect(useConnectionStore.getState().isIdle).toBe(false)
    expect(useConnectionStore.getState().sessionStates[A]?.isIdle).toBe(false)
  })

  it('residue 1: the restored active id is ABSENT from the new snapshot', () => {
    // `sendPostAuthInfo` sends `session_switched` only `if (entry)`, so on a
    // server with no session for this id nothing re-syncs the mirror from a
    // shell: pre-fix this is a DURABLE Stop button on a dashboard with no
    // session at all.
    useConnectionStore.getState()._resetSessionMemory()
    useConnectionStore.setState({ activeSessionId: A })
    handleMessage({ type: 'session_list', sessions: [{ sessionId: 'sess-on-server-B', isBusy: false }] }, ctx() as never)
    const s = useConnectionStore.getState()
    expect(s.sessionStates[A], 'the phantom id has no shell — nothing for the #7550 force to see').toBeUndefined()
    expect(s.isIdle, 'flat isIdle survived the server switch').toBe(true)
  })

  it('residue 2: the snapshot lists the id but has NO opinion on isBusy', () => {
    // An older server (or one that omits the field) produces no `isIdlePatches`
    // entry, so the #7550 force never runs for this id.
    useConnectionStore.getState()._resetSessionMemory()
    useConnectionStore.setState({ activeSessionId: A })
    handleMessage({ type: 'session_list', sessions: [{ sessionId: A }] }, ctx() as never)
    const s = useConnectionStore.getState()
    expect(s.sessionStates[A], 'the snapshot seeded a fresh shell').toBeDefined()
    expect(s.sessionStates[A]!.isIdle, 'the fresh shell defaults to idle').toBe(true)
    expect(s.isIdle, 'flat isIdle survived the server switch').toBe(true)
  })

  it('POSITIVE CONTROL: a snapshot that says BUSY still lands busy after the reset', () => {
    // The reset must not become "always idle": when the new server does report
    // the restored session as in-flight, the #7550 force still converges it.
    useConnectionStore.getState()._resetSessionMemory()
    useConnectionStore.setState({ activeSessionId: A })
    handleMessage({ type: 'session_list', sessions: [{ sessionId: A, isBusy: true }] }, ctx() as never)
    const s = useConnectionStore.getState()
    expect(s.sessionStates[A]!.isIdle).toBe(false)
    expect(s.isIdle).toBe(false)
  })
})
