import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { DockerSession } from '../src/docker-session.js'

/**
 * #9267: DockerSession inherits the Stop timer's child retirement. Its own spawn
 * wiring must carry the same identity guard the host provider has, or a retired
 * `docker exec` client closing AFTER a fresh one started clears the fresh child's
 * readlines, nulls `_child`, marks the session unready and schedules a respawn.
 *
 * Real DockerSession `_spawnPersistentProcess` wiring over mocked streams (the
 * existing `_spawnDocker` seam); the tree kill is injected so nothing is signalled.
 */

function fakeExec() {
  const c = new EventEmitter()
  c.stdin = new PassThrough()
  c.stdout = new PassThrough()
  c.stderr = new PassThrough()
  c.pid = undefined
  c.kill = () => {}
  return c
}

const open = []
afterEach((t) => {
  t.mock.timers.reset()
  for (const s of open.splice(0)) {
    for (const k of ['_resultTimeout', '_hardTimeout', '_streamStallTimeout', '_interruptTimer']) {
      if (s[k]) { clearTimeout(s[k]); s[k] = null }
    }
    s._destroying = true
  }
})

/** Real inactivity timers armed before the mock clock goes on: clear them with the real clearTimeout. */
function clearRealTimers(s) {
  for (const k of ['_resultTimeout', '_hardTimeout', '_streamStallTimeout']) {
    if (s[k]) { clearTimeout(s[k]); s[k] = null }
  }
}

function dockerSession() {
  const s = new DockerSession({ cwd: '/tmp' })
  open.push(s)
  s._containerId = 'abcdef0123456789'
  s.on('error', () => {})
  s._respawns = 0
  s._scheduleRespawn = () => { s._respawns++ }
  s._treeDeps = { isWindows: false, ps: () => '', startTimeOf: () => null, kill: () => {}, taskkill: () => {} }
  const execs = []
  s._spawnDocker = () => { const c = fakeExec(); execs.push(c); return c }
  s.start = () => { s._spawnPersistentProcess([]) }
  s._spawnPersistentProcess([])
  return { s, execs }
}

describe('DockerSession: a docker exec client the Stop timer retired (#9267)', () => {
  it('its late close touches nothing of the fresh client: no clear, no unready, no respawn', async (t) => {
    const { s, execs } = dockerSession()
    const old = s._child
    assert.equal(s._processReady, true)
    await s.sendMessage('first')
    clearRealTimers(s)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    s.interrupt()
    t.mock.timers.tick(5000)
    assert.equal(s._child, null, 'retired')
    await s.sendMessage('again') // revives with a fresh exec
    const fresh = s._child
    const freshRl = s._rl
    assert.notEqual(fresh, old)
    assert.equal(execs.length, 2)
    assert.equal(s._processReady, true)
    old.emit('close', 0)
    assert.equal(s._child, fresh, 'the fresh client is still current')
    assert.equal(s._processReady, true)
    assert.equal(s._rl, freshRl, 'the fresh client\'s readline is not closed')
    assert.equal(s._respawns, 0, 'no respawn')
  })

  it('its late error and late stdout are ignored too', async (t) => {
    const { s, execs } = dockerSession()
    const old = s._child
    const oldRl = s._rl
    const results = []
    s.on('result', (r) => results.push(r))
    await s.sendMessage('first')
    clearRealTimers(s)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    s.interrupt()
    t.mock.timers.tick(5000)
    assert.equal(results.length, 1)
    await s.sendMessage('again')
    const fresh = s._child
    old.emit('error', new Error('late'))
    oldRl.emit('line', JSON.stringify({ type: 'result', subtype: 'success', result: 'late', session_id: 's', duration_ms: 1 }))
    assert.equal(s._child, fresh)
    assert.equal(s._processReady, true)
    assert.equal(results.length, 1)
    assert.equal(s._respawns, 0)
    assert.equal(execs.length, 2)
  })
})

describe('DockerSession: the first send after a Stop is not stranded by a synchronous restart (#9267)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'chroxy-docker-stop-'))
  after(() => rmSync(cwd, { recursive: true, force: true }))

  it('Stop with nothing queued, then a send: the real start() is ready before the prompt is parked, and it is still dispatched', async (t) => {
    // A folder with no trust record is decided without an async scan and an existing container means no
    // `docker run`, so start() reaches ready and finishes its warmup drain synchronously.
    const s = new DockerSession({ cwd })
    open.push(s)
    s._containerId = 'abcdef0123456789'
    s.on('error', () => {})
    s._treeDeps = { isWindows: false, ps: () => '', startTimeOf: () => null, kill: () => {}, taskkill: () => {} }
    const writes = []
    const execs = []
    s._spawnDocker = () => {
      const c = fakeExec()
      c.stdin.on('data', (chunk) => writes.push(chunk.toString()))
      execs.push(c)
      return c
    }
    s.start()
    assert.equal(s._processReady, true)
    await s.sendMessage('first')
    clearRealTimers(s)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    s.interrupt()
    t.mock.timers.tick(5000)
    assert.equal(s._child, null)
    await s.sendMessage('after-stop')
    assert.equal(execs.length, 2, 'a fresh exec was started')
    assert.equal(s._pendingQueue.length, 0, 'the prompt was not left parked')
    assert.equal(writes.filter((w) => w.includes('after-stop')).length, 1, 'dispatched to the fresh child exactly once')
    assert.equal(s._isBusy, true)
  })
})
