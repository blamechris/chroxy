import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'

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
