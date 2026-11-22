import { describe, it, mock, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * #9267: after a Stop, the 5 s safety timer ends the turn if the child ignored
 * SIGINT. That child used to stay alive and its late answer was accepted as a new
 * `message` + `result` on the already-stopped turn. The timer now retires the
 * child and its output and close are ignored; the next send (or a follow-up
 * already queued) starts a fresh child whose output is delivered.
 *
 * Every cell goes through the production `_spawnPersistentProcess()` wiring, so the
 * REAL readline callback and `close` listener (and their identity guards) are what
 * run. The children are real `node` processes that ignore SIGINT/SIGTERM, spawned by
 * this test and SIGKILLed in afterEach. The tree kill is injected (`_treeDeps` /
 * `_killChildTree`), so nothing but those children is ever signalled.
 */

if (typeof mock.module !== 'function') {
  describe('claude-cli: Stop safety timer vs a child that ignored SIGINT (#9267)', () => {
    it('skipped: mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks')
    })
  })
} else {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-cli-stop-timer-'))
  after(() => rmSync(root, { recursive: true, force: true }))
  const realResolver = await import('../src/utils/resolve-binary.js')
  mock.module('../src/utils/resolve-binary.js', {
    namedExports: { ...realResolver, resolveBinary: () => process.execPath },
  })
  const { CliSession } = await import('../src/cli-session.js')

  const IGNORE = ['-e', "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1e6)"]
  const MARK = 'stopped_before_output'
  const spawned = []
  const sessions = []

  afterEach((t) => {
    t.mock.timers.reset()
    for (const s of sessions.splice(0)) {
      for (const k of ['_resultTimeout', '_hardTimeout', '_streamStallTimeout', '_interruptTimer']) {
        if (s[k]) { clearTimeout(s[k]); s[k] = null }
      }
      s._destroying = true
    }
    for (const c of spawned.splice(0)) { try { c.kill('SIGKILL') } catch {} }
  })

  /** Real inactivity timers armed before the mock clock goes on: clear them with the real clearTimeout. */
  function clearRealTimers(s) {
    for (const k of ['_resultTimeout', '_hardTimeout', '_streamStallTimeout']) {
      if (s[k]) { clearTimeout(s[k]); s[k] = null }
    }
  }

  async function until(cond, label) {
    const deadline = Date.now() + 5000
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** A session whose production spawn wiring runs on a real SIGINT-ignoring child. */
  async function startedSession() {
    const session = new CliSession({ cwd: root, skillsDir: root, repoSkillsDir: null })
    sessions.push(session)
    session.on('error', () => {})
    session._scheduleRespawn = () => { session._respawnsScheduled = (session._respawnsScheduled || 0) + 1 }
    // Nothing the retirement does may enumerate or signal anything but the test's own children.
    session._treeDeps = { ps: () => '', startTimeOf: () => null, kill: () => {} }
    session.start = () => { session._spawnPersistentProcess(IGNORE); spawned.push(session._child) }
    session._spawnPersistentProcess(IGNORE)
    spawned.push(session._child)
    await until(() => session._processReady, 'the first child to be ready')
    return session
  }

  function watch(session) {
    const w = { messages: [], results: [], stopped: [], errors: [] }
    session.on('message', (m) => w.messages.push(m))
    session.on('result', (r) => w.results.push(r))
    session.on('stopped', (s) => w.stopped.push(s))
    session.on('error', (e) => w.errors.push(e))
    w.markers = () => w.results.filter((r) => r.turnOutcome === MARK)
    return w
  }

  const reply = (text) => JSON.stringify({ type: 'result', subtype: 'success', result: text, session_id: 's-1', duration_ms: 1 }) + '\n'

  /** Stop a busy turn and let the 5 s timer fire (the child ignores SIGINT). */
  async function stopAndExpire(t, session, { requested = false } = {}) {
    await session.sendMessage('first')
    assert.equal(session._isBusy, true)
    clearRealTimers(session)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    if (requested) session.markStopRequested()
    session.interrupt()
    t.mock.timers.tick(5000)
  }

  describe('claude-cli: Stop safety timer vs a child that ignored SIGINT (#9267)', () => {
    it('drops the late reply and result of the retired child (through the real readline callback)', async (t) => {
      const session = await startedSession()
      const old = session._child
      const rl = session._rl
      const w = watch(session)
      await stopAndExpire(t, session)
      assert.equal(w.results.length, 1, 'the timer reports the stop once')
      // The readline is closed, but its listener is still the production callback: it must refuse on identity.
      rl.emit('line', reply('I kept running after SIGINT.').trim())
      assert.equal(w.messages.length, 0, 'no message on the ended turn')
      assert.equal(w.results.length, 1, 'no second result')
      assert.notEqual(session._child, old)
    })

    it('SIGTERMs the child tree that ignored SIGINT, SIGKILLing after a grace', async (t) => {
      const session = await startedSession()
      const calls = []
      session._killChildTree = (child, opts = {}) => calls.push({ child, force: !!opts.force })
      const old = session._child
      await stopAndExpire(t, session)
      assert.deepEqual(calls, [{ child: old, force: false }])
      t.mock.timers.tick(3000)
      assert.deepEqual(calls, [{ child: old, force: false }, { child: old, force: true }])
    })

    it('is per child: a message sent after the timer starts a new child whose reply is delivered', async (t) => {
      const session = await startedSession()
      const old = session._child
      const oldRl = session._rl
      const w = watch(session)
      await stopAndExpire(t, session)
      await session.sendMessage('again') // revives: start() spawns a fresh child
      await until(() => session._processReady && session._child && session._child !== old, 'the fresh child')
      const fresh = session._child
      assert.equal(session._isBusy, true)
      oldRl.emit('line', reply('late old').trim())
      assert.equal(w.results.length, 1, 'the old child is still ignored')
      session._rl.emit('line', reply('fresh answer').trim())
      assert.equal(w.results.length, 2, 'the new child answers the new turn')
      assert.equal(w.messages.some((m) => m.content === 'fresh answer'), true)
      assert.equal(w.messages.some((m) => m.content === 'late old'), false)
      assert.equal(session._child, fresh)
    })

    it('the retired child\'s late close touches nothing of the fresh child: no result, no marker, no respawn', async (t) => {
      const session = await startedSession()
      const old = session._child
      const w = watch(session)
      await stopAndExpire(t, session, { requested: true })
      await session.sendMessage('again')
      await until(() => session._processReady && session._child && session._child !== old, 'the fresh child')
      const fresh = session._child
      const freshRl = session._rl
      const before = w.results.length
      old.emit('close', 0) // the production close listener of the OLD child
      assert.equal(w.results.length, before, 'no second result')
      assert.equal(w.markers().length, 0)
      assert.equal(w.stopped.length, 0)
      assert.equal(session._respawnsScheduled || 0, 0, 'no respawn')
      assert.equal(session._child, fresh, 'the fresh child is still current')
      assert.equal(session._processReady, true)
      assert.equal(session._rl, freshRl, 'the fresh child\'s readline is not closed')
    })

    it('a follow-up accepted during the 5 s window starts a fresh child and is delivered exactly once', async (t) => {
      const session = await startedSession()
      const old = session._child
      const sent = []
      const realSend = session.sendMessage.bind(session)
      session.sendMessage = (prompt, ...rest) => { sent.push(prompt); return realSend(prompt, ...rest) }
      await session.sendMessage('first')
      clearRealTimers(session)
      t.mock.timers.enable({ apis: ['setTimeout'] })
      session.interrupt()
      await session.sendMessage('follow-up') // busy: parked in the outgoing queue
      assert.equal(session._outgoingQueue.length, 1)
      sent.length = 0 // count only the dispatches the timer's restart causes
      t.mock.timers.tick(5000)
      await until(() => session._processReady && session._child && session._child !== old, 'the fresh child')
      await until(() => sent.filter((p) => p === 'follow-up').length >= 1 && session._outgoingQueue.length === 0, 'the follow-up dispatch')
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(sent.filter((p) => p === 'follow-up').length, 1, 'dispatched exactly once')
      assert.equal(session._isBusy, true)
      assert.equal(session._outgoingQueue.length, 0)
    })

    it('forgets the background shells the retired child took with it', async (t) => {
      const session = await startedSession()
      session.trackBackgroundShell({ shellId: 'brk1', command: 'tail -f log' })
      await stopAndExpire(t, session)
      assert.equal(session._isBusy, false)
      assert.equal(session.isRunning, false)
    })

    it('a Stop whose child exits promptly behaves as before: one result, stopped, no SIGTERM, and the marker', async (t) => {
      const session = await startedSession()
      const calls = []
      session._killChildTree = (...a) => calls.push(a)
      const old = session._child
      const w = watch(session)
      await session.sendMessage('first')
      clearRealTimers(session)
      t.mock.timers.enable({ apis: ['setTimeout'] })
      session.markStopRequested()
      session.interrupt()
      old.emit('close', 0) // the child honoured SIGINT
      t.mock.timers.tick(5000)
      assert.equal(w.results.length, 1)
      assert.equal(w.stopped.length, 1)
      assert.deepEqual(calls, [])
      assert.equal(w.markers().length, 1, 'positive control: a prompt-exit Stop before output mints the marker')
    })

    it('the timer path mints no marker and a later close cannot mint one after the fact', async (t) => {
      const session = await startedSession()
      const old = session._child
      const w = watch(session)
      await stopAndExpire(t, session, { requested: true })
      assert.equal(w.markers().length, 0, 'the child may still be running: this is not the Stop certified')
      old.emit('close', 0)
      assert.equal(w.markers().length, 0)
    })
  })
}
