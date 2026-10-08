/**
 * #7592 — `disconnect()` and `_resetSessionMemory()` tear down the SAME
 * module-level connection-scoped trackers, because they call ONE function.
 *
 * ## The defect this locks out
 *
 * The trackers that live outside the store (the outgoing message queue, the
 * replay baseline and history cursors, the in-flight transcript fetch, the
 * un-flushed delta buffers, the batched terminal writes) were cleared by two
 * hand-copied call lists. They drifted once already (#7578's review found
 * `clearDeltaBuffers` / `clearTerminalWriteBatching` missing from the
 * server-switch path), and the next tracker added to `disconnect()` would have
 * missed it again — a message queued for server A draining onto server B.
 *
 * ## What is checked, and where each expectation comes from
 *
 * The set under test is read OFF `clearConnectionScopedTrackers()` itself (the
 * identifiers it calls), so a tracker added to the helper is covered with no
 * edit here. Nothing below re-derives an expectation from the thing it checks
 * with the same code (#7424):
 *
 *  - SOURCE cells: both entry points call the helper, and NEITHER names one of
 *    the helper's calls directly (a tracker cleared in one entry point only is
 *    the exact drift). A call in `disconnect()` that looks like a teardown
 *    (`clear*` / `reset*`) but is in neither the helper nor the stated-reason
 *    map below fails, so a new tracker has to be CLASSIFIED when it is added.
 *  - ROSTER pin: the helper's call set equals a literal list written out here,
 *    so deleting a call from the helper is red rather than silently shrinking
 *    the derived set the other cells iterate.
 *  - BEHAVIOURAL cells: with every function export of the two tracker modules
 *    wrapped in a pass-through spy, a real `disconnect()` and a real
 *    `_resetSessionMemory()` each call every tracker in the derived set, with
 *    the same arguments — and `resetReplayReconcile` with `clearCursors: true`,
 *    stated as a literal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

/**
 * Wrap every plain function export in a pass-through `vi.fn`, so a spy exists
 * for whichever tracker the helper turns out to call while the real behaviour is
 * untouched. Classes are left alone (`vi.fn` would break `new`).
 */
function spyOnFunctionExports(actual: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...actual }
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== 'function') continue
    if (/^class\b/.test(Function.prototype.toString.call(value))) continue
    out[name] = vi.fn(value as (...args: unknown[]) => unknown)
  }
  return out
}
vi.mock('./message-handler', async (importOriginal) =>
  spyOnFunctionExports(await importOriginal<Record<string, unknown>>()))
vi.mock('@chroxy/store-core', async (importOriginal) =>
  spyOnFunctionExports(await importOriginal<Record<string, unknown>>()))

const { useConnectionStore } = await import('./connection')
const messageHandler = (await import('./message-handler')) as unknown as Record<string, unknown>
const storeCore = (await import('@chroxy/store-core')) as unknown as Record<string, unknown>

// ---- the source, parsed -----------------------------------------------------------

const connectionPath = resolve(__dirname, 'connection.ts')
const sourceFile = ts.createSourceFile(
  connectionPath, readFileSync(connectionPath, 'utf8'), ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS,
)

/** The function body of `function <name>() {}` at module level. */
function functionDeclarationBody(name: string): ts.Node | undefined {
  let found: ts.Node | undefined
  ts.forEachChild(sourceFile, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n.body
  })
  return found
}

/** The arrow/function body of the store property `<name>: () => {}`. */
function storeActionBody(name: string): ts.Node | undefined {
  let found: ts.Node | undefined
  const visit = (n: ts.Node): void => {
    if (
      !found && ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === name &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) found = n.initializer.body
    ts.forEachChild(n, visit)
  }
  visit(sourceFile)
  return found
}

/** Identifiers called directly (`foo(…)`) anywhere under `node` — not `a.b(…)`. */
function directCallees(node: ts.Node | undefined): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.push(n.expression.text)
    ts.forEachChild(n, visit)
  }
  if (node) visit(node)
  return out
}

/** Module specifier each imported name comes from in connection.ts. */
function importSources(): Record<string, string> {
  const out: Record<string, string> = {}
  ts.forEachChild(sourceFile, (n) => {
    if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return
    const bindings = n.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return
    for (const el of bindings.elements) out[el.name.text] = n.moduleSpecifier.text
  })
  return out
}

const HELPER = 'clearConnectionScopedTrackers'
const helperBody = functionDeclarationBody(HELPER)
const disconnectBody = storeActionBody('disconnect')
const resetBody = storeActionBody('_resetSessionMemory')

/** The tracker set, READ from the helper. */
const TRACKERS: readonly string[] = [...new Set(directCallees(helperBody))]
const disconnectCalls = directCallees(disconnectBody)
const resetCalls = directCallees(resetBody)

/**
 * The independent statement of what the helper must CALL (#7424). Written out so
 * that deleting a call from the helper goes red instead of quietly deleting its
 * own per-tracker cells below.
 */
const TRACKERS_EXPECTED = [
  'clearMessageQueue',
  'resetReplayReconcile',
  'resetTranscriptFetchTracking',
  'clearDeltaBuffers',
  'clearTerminalWriteBatching',
  // #8407: the destroy-in-flight safety timers.
  'cancelAllEnvironmentDestroyTimers',
] as const

/**
 * Teardown-looking calls (`clear*` / `reset*`) that `disconnect()` makes ITSELF,
 * outside the helper, each with why it is not a connection-scoped tracker. A new
 * `clear*` / `reset*` call in `disconnect()` is either one of the helper's (move
 * it there) or belongs here with a reason — never silently both-or-neither.
 */
const DISCONNECT_ONLY: Record<string, string> = {
  clearHandshakeTimer: 'the auth handshake timer of the socket being closed; a switch has nothing armed to cancel once disconnect() ran',
  clearPendingTrustGrants: 'pending request/ack correlations on the dead socket; socket teardown, not retained across a switch',
  clearPendingModelReverts: 'pending request/ack correlations on the dead socket; socket teardown',
  clearPendingPermissionModeReverts: 'pending request/ack correlations on the dead socket; socket teardown',
  clearPendingThinkingLevelReverts: 'pending request/ack correlations on the dead socket; socket teardown',
  clearGitOneshotCallbacks: 'fast-rejects git one-shot replies that can never arrive on the closed socket (writes store callbacks, so it takes set/get)',
  clearPendingMcpServerOps: 'pending add/remove MCP server correlations on the dead socket; socket teardown',
  clearPermissionSplits: 'permission-boundary split tracking for the closed socket; socket teardown',
  resetReplayFlags: 'the mid-replay flags of the closed socket; subsumed by the helper\'s cursor/baseline reset on a switch (see _resetSessionMemory)',
  clearAllSessionPendingTrustGrants: 'a pure transform of store state (sessionStates) written into disconnect()\'s own set(), not a module-level tracker; a switch empties sessionStates wholesale',
  clearDaemonUpdateWatchdog: 'the daemon-update restart watchdog; a user disconnect cancels it (#8331)',
}

const TEARDOWN_NAME = /^(clear|reset)/

// ---- the cells --------------------------------------------------------------------

describe('#7592 control: the scanner sees the real functions', () => {
  it('finds the helper, disconnect() and _resetSessionMemory() bodies', () => {
    expect(helperBody, `function ${HELPER}() not found in connection.ts`).toBeDefined()
    expect(disconnectBody, 'disconnect action not found').toBeDefined()
    expect(resetBody, '_resetSessionMemory action not found').toBeDefined()
    expect(TRACKERS.length, 'the helper calls nothing — the scan found an empty body').toBeGreaterThan(0)
    // Both entry points are big; a slice that swallowed a stub would be tiny.
    expect(disconnectCalls.length).toBeGreaterThan(10)
    expect(resetCalls.length).toBeGreaterThan(2)
  })

  it('the scanner distinguishes a direct call from a member call', () => {
    const sf = ts.createSourceFile('x.ts', 'function f() { a(); o.b(); get().c() }', ts.ScriptTarget.ES2020, true)
    expect(directCallees(sf)).toEqual(['a', 'get'])
  })
})

describe('#7592 the helper is the roster, and both entry points use it', () => {
  it('the helper calls exactly the pinned trackers (both directions)', () => {
    expect(TRACKERS.filter((t) => !(TRACKERS_EXPECTED as readonly string[]).includes(t)),
      'a call was ADDED to the helper; add it to TRACKERS_EXPECTED too').toEqual([])
    expect(TRACKERS_EXPECTED.filter((t) => !TRACKERS.includes(t)),
      'a tracker was DELETED from clearConnectionScopedTrackers()').toEqual([])
  })

  it.each([
    ['disconnect()', () => disconnectCalls],
    ['_resetSessionMemory()', () => resetCalls],
  ])('%s calls the helper', (_label, calls) => {
    expect(calls(), `${_label} no longer calls ${HELPER}()`).toContain(HELPER)
  })

  it.each([
    ['disconnect()', () => disconnectCalls],
    ['_resetSessionMemory()', () => resetCalls],
  ])('%s does not name a tracker itself (a hand-copy is how the two drifted)', (_label, calls) => {
    expect(
      calls().filter((c) => TRACKERS.includes(c)),
      `${_label} calls a tracker directly. Put it in ${HELPER}() so BOTH entry points clear it (#7592).`,
    ).toEqual([])
  })

  it('every teardown-looking call in disconnect() is the helper or has a stated reason', () => {
    const unclassified = [...new Set(disconnectCalls)].filter(
      (c) => TEARDOWN_NAME.test(c) && c !== HELPER && !(c in DISCONNECT_ONLY),
    )
    expect(
      unclassified,
      'disconnect() calls a clear*/reset* function that is neither in clearConnectionScopedTrackers() nor in ' +
      'DISCONNECT_ONLY. If it is a module-level connection-scoped tracker, add it to the helper (the server-switch ' +
      'path then clears it too); if it is socket teardown only, classify it with a reason (#7592).',
    ).toEqual([])
  })

  it('the stated reasons are real: each exemption is actually called by disconnect(), is not a tracker, and says why', () => {
    for (const [name, reason] of Object.entries(DISCONNECT_ONLY)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20)
      expect(disconnectCalls, `${name} is classified here but disconnect() no longer calls it`).toContain(name)
      expect(TRACKERS.includes(name), `${name} IS in the helper now — drop it from DISCONNECT_ONLY`).toBe(false)
    }
  })
})

describe('#7592 behaviour: a real disconnect() and _resetSessionMemory() each clear every tracker the helper names', () => {
  const sources = importSources()
  const moduleOf = (name: string): Record<string, unknown> => {
    const from = sources[name]
    if (from === './message-handler') return messageHandler
    if (from === '@chroxy/store-core') return storeCore
    throw new Error(
      `${name} is imported from ${String(from)}, which this test does not spy on. Add a vi.mock for that module ` +
      'with spyOnFunctionExports, or the behavioural cells below would prove nothing about it.',
    )
  }
  const spyOf = (name: string): ReturnType<typeof vi.fn> => {
    const fn = moduleOf(name)[name]
    if (!vi.isMockFunction(fn)) throw new Error(`${name} is not a spy`)
    return fn as unknown as ReturnType<typeof vi.fn>
  }

  /** Calls recorded by each tracker's spy while `run` executes. */
  const callsDuring = (run: () => void): Record<string, unknown[][]> => {
    for (const t of TRACKERS) spyOf(t).mockClear()
    run()
    return Object.fromEntries(TRACKERS.map((t) => [t, spyOf(t).mock.calls as unknown[][]]))
  }

  beforeEach(() => {
    useConnectionStore.setState({ socket: null, connectionPhase: 'disconnected', userDisconnected: false })
  })

  it('control: every tracker the helper names resolves to a spy', () => {
    for (const t of TRACKERS) expect(vi.isMockFunction(moduleOf(t)[t]), `${t} has no spy`).toBe(true)
  })

  it.each(TRACKERS)('%s runs on disconnect() AND on _resetSessionMemory(), with the same arguments', (tracker) => {
    const fromDisconnect = callsDuring(() => useConnectionStore.getState().disconnect())[tracker]!
    const fromReset = callsDuring(() => useConnectionStore.getState()._resetSessionMemory())[tracker]!
    expect(fromDisconnect.length, `disconnect() never called ${tracker}`).toBeGreaterThan(0)
    expect(fromReset.length, `_resetSessionMemory() never called ${tracker}`).toBeGreaterThan(0)
    // Every call the server-switch path made, `disconnect()` made too. (Subset, not
    // equality or "the first call": message-handler's own `resetReplayFlags()` also
    // reaches `resetReplayReconcile()`, with no arguments, inside disconnect().)
    const disconnectSeen = fromDisconnect.map((args) => JSON.stringify(args))
    const reachedOnlyByReset = fromReset.filter((args) => !disconnectSeen.includes(JSON.stringify(args)))
    expect(reachedOnlyByReset, `${tracker} was called with arguments on _resetSessionMemory() that disconnect() never used`).toEqual([])
  })

  it('the replay reset drops the history cursors on both paths (the literal, not read from the helper)', () => {
    const viaDisconnect = callsDuring(() => useConnectionStore.getState().disconnect())['resetReplayReconcile']!
    const viaReset = callsDuring(() => useConnectionStore.getState()._resetSessionMemory())['resetReplayReconcile']!
    expect(viaDisconnect, 'disconnect() never reset the replay state with clearCursors').toContainEqual([{ clearCursors: true }])
    expect(viaReset, '_resetSessionMemory() never reset the replay state with clearCursors').toContainEqual([{ clearCursors: true }])
  })
})
