import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ClaudeTuiSession, STARTUP_NO_OUTPUT_CODE } from '../src/claude-tui-session.js'

/**
 * #7881 — a claude child blocked before it printed anything (seen live: stuck in
 * getcwd() on a macOS privacy-protected folder) used to be advertised `ready`
 * once warmup expired, accept input, then end that input with a first-output
 * timeout that invited a blind resend.
 *
 * These run the REAL start() / _spawnPty / _waitForPrompt against a node-pty
 * stand-in (the `_ptyModOverride` seam) with a short warmup ceiling.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR
const __origHome = process.env.HOME

// Assigning undefined to process.env stores the string "undefined"; delete instead.
function restoreEnv(name, saved) {
  if (saved === undefined) delete process.env[name]
  else process.env[name] = saved
}
const WARMUP_MS = 300

async function waitUntil(predicate, label, deadlineMs = 5000) {
  const stop = Date.now() + deadlineMs
  while (Date.now() < stop) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail(`timed out waiting for: ${label}`)
}

describe('ClaudeTuiSession — silent child at startup (#7881)', () => {
  let fakeHome
  let skillsDir
  let session
  let warmupDescriptor
  let sinkDescriptor
  let sinkBase

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-7881-home-'))
    writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
    process.env.HOME = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-7881-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-7881-sink-'))
    sinkDescriptor = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'SINK_BASE')
    Object.defineProperty(ClaudeTuiSession, 'SINK_BASE', { get: () => sinkBase, configurable: true })
    warmupDescriptor = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'SPAWN_WARMUP_MAX_MS')
    Object.defineProperty(ClaudeTuiSession, 'SPAWN_WARMUP_MAX_MS', { get: () => WARMUP_MS, configurable: true })
  })

  afterEach(async () => {
    Object.defineProperty(ClaudeTuiSession, 'SPAWN_WARMUP_MAX_MS', warmupDescriptor)
    Object.defineProperty(ClaudeTuiSession, 'SINK_BASE', sinkDescriptor)
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    restoreEnv('HOME', __origHome)
    restoreEnv('CHROXY_CONFIG_DIR', __sandboxConfigDir)
    for (const d of [fakeHome, skillsDir, sinkBase]) rmSync(d, { recursive: true, force: true })
  })

  function startable() {
    const fake = {
      pid: 2 ** 30, // no session file for this pid: the probe can only fall back to output
      dataCb: null,
      write() {}, kill() {}, on() {},
      onData(cb) { fake.dataCb = cb },
      onExit() {},
    }
    session = new ClaudeTuiSession({
      cwd: '/tmp',
      port: 12381,
      skillsDir,
      repoSkillsDir: null,
      loginProbeRunner: async () => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' }),
    })
    session._ptyModOverride = { spawn: () => fake }
    const events = { ready: [], errors: [] }
    session.on('ready', (e) => events.ready.push(e))
    session.on('error', (e) => events.errors.push(e))
    return { s: session, fake, events }
  }

  it('warmup expiring with zero PTY bytes does not advertise ready, and reports STARTUP_NO_OUTPUT with the cwd', async () => {
    const { s, events } = startable()
    await s.start()
    assert.equal(events.ready.length, 0, 'no ready for a child that printed nothing')
    assert.equal(s._processReady, false)
    const coded = events.errors.filter((e) => e.code === STARTUP_NO_OUTPUT_CODE)
    assert.equal(coded.length, 1, 'exactly one coded startup diagnostic')
    assert.equal(STARTUP_NO_OUTPUT_CODE, 'STARTUP_NO_OUTPUT')
    assert.ok(coded[0].message.includes('no output during startup'), 'says what was observed')
    assert.ok(coded[0].message.includes('/tmp'), 'names the cwd')
    assert.ok(/inaccessible/.test(coded[0].message) && /privacy-protected/.test(coded[0].message), 'hints at an inaccessible directory')
  })

  it('input to a still-silent session is refused as not dispatched and retry-safe, with the coded reason', async () => {
    const { s, events } = startable()
    await s.start()
    events.errors.length = 0
    let admission = null
    const result = await s.sendMessage('hello', [], { onInputAdmission: (a) => { admission = a } })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_runnable')
    assert.equal(admission.status, 'rejected')
    assert.equal(admission.delivery, 'not_dispatched')
    assert.equal(admission.retrySafe, true)
    assert.equal(admission.reason, STARTUP_NO_OUTPUT_CODE)
    assert.equal(events.errors[0].code, STARTUP_NO_OUTPUT_CODE)
    assert.equal(s._isBusy, false)
  })

  it('a slow child that prints after warmup expired becomes ready then, exactly once', async () => {
    const { s, fake, events } = startable()
    await s.start()
    assert.equal(events.ready.length, 0)
    fake.dataCb('claude is up')
    await waitUntil(() => events.ready.length === 1, 'ready after the late first byte')
    assert.equal(s._processReady, true)
    fake.dataCb('more output')
    assert.equal(events.ready.length, 1, 'later output does not re-announce ready')
  })

  it('control: a child that prints during warmup is ready from start() with no startup diagnostic', async () => {
    const { s, fake, events } = startable()
    const starting = s.start()
    await waitUntil(() => typeof fake.dataCb === 'function', 'PTY onData registered')
    fake.dataCb('claude composer')
    await starting
    assert.equal(events.ready.length, 1)
    assert.equal(s._processReady, true)
    assert.deepEqual(events.errors.filter((e) => e.code === STARTUP_NO_OUTPUT_CODE), [])
  })
})

describe('ClaudeTuiSession — silent child: spawn-in-flight, terminal input, respawn (#7881)', () => {
  let fakeHome
  let skillsDir
  let sinkBase
  let session
  let sinkDescriptor

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-7881-b-home-'))
    writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
    process.env.HOME = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-7881-b-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-7881-b-sink-'))
    sinkDescriptor = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'SINK_BASE')
    Object.defineProperty(ClaudeTuiSession, 'SINK_BASE', { get: () => sinkBase, configurable: true })
  })

  afterEach(async () => {
    Object.defineProperty(ClaudeTuiSession, 'SINK_BASE', sinkDescriptor)
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    restoreEnv('HOME', __origHome)
    restoreEnv('CHROXY_CONFIG_DIR', __sandboxConfigDir)
    for (const d of [fakeHome, skillsDir, sinkBase]) rmSync(d, { recursive: true, force: true })
  })

  function make() {
    session = new ClaudeTuiSession({
      cwd: '/tmp', port: 12382, skillsDir, repoSkillsDir: null,
      loginProbeRunner: async () => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' }),
    })
    const writes = []
    const fake = { pid: 2 ** 30, write: (d) => writes.push(d), kill() {}, on() {}, onData() {}, onExit() {} }
    const log = []
    session.on('ready', () => log.push('ready'))
    session.on('error', (e) => log.push(`error:${e.code || e.message}`))
    return { s: session, fake, log, writes }
  }

  // Stand-in for _spawnPty that ends the way a silent child's warmup does (live
  // PTY, latch set), but lets a test land a byte / a verdict while the spawn is
  // still "in flight" (the native-route marker wait sits there in the real method).
  function stubSpawn(s, fake, midSpawn) {
    s._spawnPty = async function () {
      this._term = fake
      this._ptyExited = false
      this._startupNoOutput = true
      this._sawFirstOutput = false
      await midSpawn(this)
    }
  }

  it('a byte landing while the spawn is in flight yields exactly one ready, after the spawn returns', async () => {
    const { s, fake, log } = make()
    let spawnReturned = false
    stubSpawn(s, fake, async (self) => {
      await new Promise((r) => setTimeout(r, 20))
      self._appendToOutputTail('late byte during the marker wait')
      assert.deepEqual(log, [], 'no ready emitted from inside the spawn')
      await new Promise((r) => setTimeout(r, 20))
      spawnReturned = true
    })
    s.on('ready', () => assert.equal(spawnReturned, true, 'ready only after _spawnPty returned'))
    await s.start()
    assert.deepEqual(log.filter((e) => e === 'ready'), ['ready'], 'exactly one ready')
    assert.equal(log.some((e) => e.startsWith('error:STARTUP_NO_OUTPUT')), false, 'no silent-child diagnostic once bytes arrived')
    assert.equal(s._processReady, true)
  })

  it('a byte during the spawn, then the spawn throwing (marker verdict), yields no ready at all', async () => {
    const { s, fake, log } = make()
    stubSpawn(s, fake, async (self) => {
      self._appendToOutputTail('byte')
      throw Object.assign(new Error('marker mismatch'), { code: 'NATIVE_ENDPOINT_UNVERIFIED' })
    })
    await assert.rejects(s.start(), (err) => err.code === 'NATIVE_ENDPOINT_UNVERIFIED')
    assert.deepEqual(log.filter((e) => e === 'ready'), [])
    assert.equal(s._processReady, false)
  })

  it('terminal input is refused while the child is silent, and does not reach the PTY', async () => {
    const { s, fake, writes } = make()
    stubSpawn(s, fake, async () => {})
    await s.start()
    assert.equal(s._startupNoOutput, true, 'precondition: start() withheld ready')
    assert.equal(s.writeTerminalInput('abc'), false)
    assert.deepEqual(writes, [], 'nothing written to the wedged child')
    s._appendToOutputTail('claude is up')
    assert.equal(s.writeTerminalInput('abc'), true, 'accepted once the child has produced output')
    assert.deepEqual(writes, ['abc'])
  })

  it('a silent respawn withholds ready and keeps the retry budget; a late byte then makes it ready once', async () => {
    const { s, fake, log } = make()
    s._respawnCount = 3
    stubSpawn(s, fake, async () => {})
    log.length = 0
    await s._respawnPty()
    assert.equal(log.includes('ready'), false, 'no ready for a silent respawn')
    assert.equal(log.includes('error:STARTUP_NO_OUTPUT'), true, 'coded diagnostic')
    assert.equal(s._respawnCount, 3, 'retry budget untouched by an unproven respawn')
    assert.equal(s._processReady, false)
    s._appendToOutputTail('back')
    s._appendToOutputTail('more')
    assert.equal(log.filter((e) => e === 'ready').length, 1, 'ready exactly once on the late byte')
    assert.equal(s._respawnCount, 0, 'budget reset once it proved alive')
    assert.equal(s._processReady, true)
  })
})

describe('ClaudeTuiSession — first-output timeout is not a retry invitation (#7881)', () => {
  let fakeHome
  let skillsDir
  let sinkBase
  let session

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-7881-turn-'))
    process.env.HOME = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-7881-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-7881-sink-'))
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    restoreEnv('HOME', __origHome)
    restoreEnv('CHROXY_CONFIG_DIR', __sandboxConfigDir)
    for (const d of [fakeHome, skillsDir, sinkBase]) rmSync(d, { recursive: true, force: true })
  })

  it('reports delivery uncertain / not retry-safe and does not say "Try sending again"', async () => {
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null,
      loginProbeRunner: async () => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000, firstOutputTimeoutMs: 300,
    })
    const s = session
    s._processReady = true
    s._sessionId = 'sess-7881'
    s._sinkDir = join(sinkBase, 's-test')
    mkdirSync(s._sinkDir, { recursive: true, mode: 0o700 })
    s._waitForPrompt = async () => true
    s._writePtyTextThrottled = async () => true
    s._term = { write: () => {}, kill: () => {}, pid: 2 ** 30 }
    const errors = []
    const results = []
    s.on('error', (e) => errors.push(e))
    s.on('result', (e) => results.push(e))
    let admission = null
    await s.sendMessage('hi', [], { onInputAdmission: (a) => { admission = a } })
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'stream_stall')
    assert.equal(errors[0].delivery, 'uncertain')
    assert.equal(errors[0].retrySafe, false)
    assert.ok(!/try sending again/i.test(errors[0].message), 'no blind-resend invitation')
    assert.ok(/before sending it again/.test(errors[0].message), 'tells the user to check first')
    assert.equal(results.length, 1, 'the turn still ends so the client leaves busy')
    assert.equal(s._isBusy, false)
    assert.equal(admission.status, 'accepted', 'the write was admitted; only the outcome is uncertain')
  })
})
