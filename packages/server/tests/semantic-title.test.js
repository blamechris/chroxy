import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

/**
 * #6764 — SessionManager wiring for semantic session titles. The model call is
 * injected via the `titleRunOneShot` seam so no provider is needed.
 *
 * CRITICAL: every SessionManager MUST use a temp stateFilePath (#4633) or it
 * clobbers the real ~/.chroxy/session-state.json.
 */

let _tmpDir
function tmpStateFile() {
  if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'sm-semantic-title-'))
  return join(_tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_tmpDir) rmSync(_tmpDir, { recursive: true, force: true })
})

function makeMockSession() {
  const s = new EventEmitter()
  s.isRunning = false
  s.destroy = () => {}
  return s
}

// Drain the microtask + immediate queues so the fire-and-forget title chain
// (recordUserInput → auto_label → _maybeGenerateSemanticTitle → async model
// call → apply) completes before assertions run.
async function flush() {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
}

describe('SessionManager semantic titles (#6764)', () => {
  it('upgrades the truncation label to a model title when enabled', async () => {
    let calls = 0
    const mgr = new SessionManager({
      skipPreflight: true,
      stateFilePath: tmpStateFile(),
      semanticTitlesEnabled: true,
      titleRunOneShot: async () => { calls++; return 'Fix flaky reconnect test' },
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'Session 1', cwd: '/tmp' })

    const events = []
    mgr.on('session_updated', (d) => events.push(d.name))

    mgr.recordUserInput('s1', 'please help me fix the flaky WebSocket reconnect test in ws-server.js')

    // Synchronous truncation label is applied + broadcast immediately.
    assert.equal(events[0], 'please help me fix the flaky WebSocket...')

    await flush()

    assert.equal(calls, 1, 'model call fires exactly once')
    assert.equal(mgr.getSession('s1').name, 'Fix flaky reconnect test')
    assert.equal(events[events.length - 1], 'Fix flaky reconnect test')
    assert.equal(mgr._sessions.get('s1')._semanticTitleDone, true)
  })

  it('does not call the model when the feature is disabled (default)', async () => {
    let calls = 0
    const mgr = new SessionManager({
      skipPreflight: true,
      stateFilePath: tmpStateFile(),
      // semanticTitlesEnabled omitted → off
      titleRunOneShot: async () => { calls++; return 'Should Not Happen' },
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'Session 1', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'help me refactor the tunnel reconnect logic')
    await flush()

    assert.equal(calls, 0, 'model must not be called when disabled')
    assert.equal(mgr.getSession('s1').name, 'help me refactor the tunnel reconnect...')
  })

  it('falls back to the truncation label when the model call fails', async () => {
    const mgr = new SessionManager({
      skipPreflight: true,
      stateFilePath: tmpStateFile(),
      semanticTitlesEnabled: true,
      titleRunOneShot: async () => { throw new Error('provider exploded') },
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'Session 1', cwd: '/tmp' })

    const modelNames = []
    mgr.on('session_updated', (d) => modelNames.push(d.name))

    mgr.recordUserInput('s1', 'help me refactor the tunnel reconnect logic in tunnel.js')
    await flush()

    // Name stays the truncation; no second (model) broadcast landed.
    assert.equal(mgr.getSession('s1').name, 'help me refactor the tunnel reconnect...')
    assert.equal(modelNames.length, 1, 'only the truncation update was broadcast')
    // #6886 — the once-per-session in-flight guard must be cleared on the fail
    // path too, not just the success path, or it gets stuck `true` forever.
    assert.equal(mgr._sessions.get('s1')._semanticTitlePending, false, 'pending flag must be cleared after a failed title call')
  })

  it('only fires once per session (second turn does not re-trigger)', async () => {
    let calls = 0
    const mgr = new SessionManager({
      skipPreflight: true,
      stateFilePath: tmpStateFile(),
      semanticTitlesEnabled: true,
      titleRunOneShot: async () => { calls++; return 'Auth Middleware Refactor' },
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'Session 1', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'first message about refactoring the auth middleware layer')
    await flush()
    mgr.recordUserInput('s1', 'a second, unrelated follow-up message entirely')
    await flush()

    assert.equal(calls, 1, 'model call must not re-fire on later turns')
    assert.equal(mgr.getSession('s1').name, 'Auth Middleware Refactor')
  })

  it('respects a manual rename that lands while the model call is in flight', async () => {
    let resolveRun
    const mgr = new SessionManager({
      skipPreflight: true,
      stateFilePath: tmpStateFile(),
      semanticTitlesEnabled: true,
      titleRunOneShot: () => new Promise((res) => { resolveRun = res }),
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'Session 1', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'help me with the flaky reconnect test in ws-server.js')
    // The model call is now in flight (runOneShot invoked, awaiting resolveRun).
    assert.equal(typeof resolveRun, 'function')

    // User renames mid-flight.
    mgr.renameSession('s1', 'My Manual Name')

    // Model call now returns — the semantic title must NOT clobber the rename.
    resolveRun('A Different Model Title')
    await flush()

    assert.equal(mgr.getSession('s1').name, 'My Manual Name')
  })

  it('threads a non-undefined AbortSignal through to the model runner (#6881)', async () => {
    // Regression for the #6881 blocking finding: _generateSemanticTitle must pass
    // a real abort signal so a stalled one-shot can be torn down (and fail open)
    // instead of leaking a never-settling promise.
    let seen = 'UNSET'
    const mgr = new SessionManager({
      skipPreflight: true,
      stateFilePath: tmpStateFile(),
      semanticTitlesEnabled: true,
      titleRunOneShot: async (opts) => { seen = opts.signal; return 'Fix flaky reconnect test' },
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'Session 1', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'please help me fix the flaky WebSocket reconnect test in ws-server.js')
    await flush()

    assert.ok(seen instanceof AbortSignal, 'a non-undefined AbortSignal is threaded to the runner')
  })

  it('falls back to the truncation label when the model call times out (#6881)', async () => {
    // End-to-end proof that the timeout aborts a stalled runner and the session
    // keeps its truncation label — no hang, no leaked pending promise.
    const mgr = new SessionManager({
      skipPreflight: true,
      stateFilePath: tmpStateFile(),
      semanticTitlesEnabled: true,
      semanticTitleTimeoutMs: 20,
      // Mimic a stalled provider stream: the runner only settles by REJECTING when
      // the injected signal aborts (i.e. on the timeout) — it never resolves itself.
      titleRunOneShot: ({ signal }) => new Promise((_res, rej) => {
        signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
      }),
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'Session 1', cwd: '/tmp' })

    const names = []
    mgr.on('session_updated', (d) => names.push(d.name))

    mgr.recordUserInput('s1', 'help me refactor the tunnel reconnect logic in tunnel.js')
    // Give the 20ms AbortSignal.timeout room to fire, then let the fail-open apply
    // step settle.
    await new Promise((r) => setTimeout(r, 80))
    await flush()

    assert.equal(mgr.getSession('s1').name, 'help me refactor the tunnel reconnect...')
    assert.equal(names.length, 1, 'only the truncation update was broadcast — the model call timed out and failed open')
    // #6886 — same guard-clearing requirement on the timeout/abort path.
    assert.equal(mgr._sessions.get('s1')._semanticTitlePending, false, 'pending flag must be cleared after a timed-out title call')
  })

  it('does not upgrade custom-named sessions (no auto_label fires)', async () => {
    let calls = 0
    const mgr = new SessionManager({
      skipPreflight: true,
      stateFilePath: tmpStateFile(),
      semanticTitlesEnabled: true,
      titleRunOneShot: async () => { calls++; return 'Nope' },
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'My Custom Session', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'some input text that would otherwise be a label')
    await flush()

    assert.equal(calls, 0)
    assert.equal(mgr.getSession('s1').name, 'My Custom Session')
  })
})

// #8030 — the semantic-title one-shot spawn goes through the SAME per-spawn
// binary gate a fresh chat session or the summarizer would
// (SessionManager.verifyOneShotExecutable), via the `resolveExecutable` seam
// _generateSemanticTitle now threads into whichever runner is in play
// (titleRunOneShot here; the real defaultRunOneShot in production).
class SemanticTitleGateFixture extends EventEmitter {
  static get resolvedBinary() { return process.execPath }
  static get preflight() {
    return { label: 'Fixture SDK', binary: { name: 'node', candidates: [] } }
  }
}

function fakeProvenanceLedger(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    getRecord: (p) => (records.has(p) ? { ...records.get(p) } : null),
    approve: (p, sha256) => { records.set(p, { sha256 }); return true },
  }
}

const TITLE_GATE_REAL_HASH = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
const TITLE_GATE_WRONG_HASH = 'f'.repeat(64)

describe('SessionManager semantic titles — per-spawn binary gate (#8030)', () => {
  it('a block-mode mismatch refuses the title spawn before the runner ever spawns; the title stays the truncation label', async () => {
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: TITLE_GATE_WRONG_HASH } })
    let spawned = 0
    let sawResolveExecutable = false
    const mgr = new SessionManager({
      stateFilePath: tmpStateFile(),
      semanticTitlesEnabled: true,
      binaryProvenanceMode: 'block',
      binaryProvenanceLedger: ledger,
      oneShotProviderClass: SemanticTitleGateFixture,
      titleRunOneShot: async ({ resolveExecutable }) => {
        sawResolveExecutable = typeof resolveExecutable === 'function'
        // The fixture's contract: a real runner only "spawns" AFTER
        // resolveExecutable() returns a verified path. Here it throws, so
        // `spawned` below must never increment.
        resolveExecutable()
        spawned++
        return 'Should not happen'
      },
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'Session 1', cwd: '/tmp' })

    const names = []
    mgr.on('session_updated', (d) => names.push(d.name))
    // generateSessionTitle swallows the runner's error, so this warning is the
    // only trace the refusal leaves.
    const refusals = []
    const listener = (entry) => {
      if (entry.level === 'warn' && entry.message.includes('Semantic title spawn refused by the binary gate for s1')) refusals.push(entry)
    }
    addLogListener(listener)

    try {
      mgr.recordUserInput('s1', 'please help me fix the flaky WebSocket reconnect test in ws-server.js')
      await flush()
    } finally {
      removeLogListener(listener)
    }

    assert.ok(sawResolveExecutable, 'the runner must receive a resolveExecutable function')
    assert.equal(spawned, 0, 'the runner must never spawn once resolveExecutable throws')
    assert.equal(refusals.length, 1, 'the refusal must be logged')
    assert.equal(mgr.getSession('s1').name, 'please help me fix the flaky WebSocket...', 'title stays the truncation label — fail-open')
    assert.equal(names.length, 1, 'only the truncation update was broadcast')
  })

  it('a matching hash lets resolveExecutable return the verified path and the model title lands', async () => {
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: TITLE_GATE_REAL_HASH } })
    let spawnedWith = null
    const mgr = new SessionManager({
      stateFilePath: tmpStateFile(),
      semanticTitlesEnabled: true,
      binaryProvenanceMode: 'block',
      binaryProvenanceLedger: ledger,
      oneShotProviderClass: SemanticTitleGateFixture,
      titleRunOneShot: async ({ resolveExecutable }) => {
        spawnedWith = resolveExecutable()
        return 'Fix flaky reconnect test'
      },
    })
    mgr._sessions.set('s1', { session: makeMockSession(), name: 'Session 1', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'please help me fix the flaky WebSocket reconnect test in ws-server.js')
    await flush()

    assert.equal(spawnedWith, process.execPath)
    assert.equal(mgr.getSession('s1').name, 'Fix flaky reconnect test')
  })
})
