import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { pinTmpDaemonBase } from './helpers/pin-tmp-daemon-base.js'

/**
 * #8418 — `conversationPersisted` (has claude ever saved this session's
 * conversation?) is serialized beside `sdkSessionId` and handed back to the
 * provider on restore.
 *
 * Every SessionManager here has a temp `stateFilePath` (CLAUDE.md #4633).
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR
const LOST_ID = '0f8418bb-0000-4000-8000-000000000002'
const RESTORED_SESSION_ID = 'a'.repeat(32)

let ctorOpts
class ReportingProvider extends EventEmitter {
  constructor(opts) {
    super()
    ctorOpts.push(opts)
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = opts.resumeSessionId || null
    this.conversationPersisted = opts.conversationPersisted === true
    this._messageCounter = 0
    this.bootedModel = null
  }
  static get capabilities() { return {} }
  async start() {}
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}
// A provider that does not track the bit at all (every provider but claude-tui).
class SilentProvider extends ReportingProvider {
  constructor(opts) {
    super(opts)
    delete this.conversationPersisted
  }
}
registerProvider('test-reporting-8418', ReportingProvider)
registerProvider('test-silent-8418', SilentProvider)

describe('conversationPersisted survives a restart (#8418)', () => {
  let dir, stateFile, mgrs
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8418-sm-'))
    stateFile = join(dir, 'session-state.json')
    ctorOpts = []
    mgrs = []
  })
  afterEach(() => {
    for (const m of mgrs) { try { m.destroyAll() } catch { /* ignore */ } }
    rmSync(dir, { recursive: true, force: true })
  })
  const newMgr = () => {
    const m = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgrs.push(m)
    return m
  }
  const writeState = (sessionOverrides) => writeFileSync(stateFile, JSON.stringify({
    version: 1,
    timestamp: Date.now(),
    sessions: [{
      id: RESTORED_SESSION_ID, name: 'S', cwd: '/tmp', model: null, permissionMode: 'approve',
      provider: 'test-reporting-8418', sdkSessionId: LOST_ID, history: [], ...sessionOverrides,
    }],
  }))

  it('serializeState writes the bit for a provider that reports it, true and false', () => {
    const mgr = newMgr()
    const a = mgr.createSession({ name: 'A', cwd: '/tmp', provider: 'test-reporting-8418', conversationPersisted: true })
    const b = mgr.createSession({ name: 'B', cwd: '/tmp', provider: 'test-reporting-8418' })
    const state = mgr.serializeState()
    const byId = new Map(state.sessions.map((s) => [s.id, s]))
    assert.strictEqual(byId.get(a).conversationPersisted, true)
    assert.strictEqual(byId.get(b).conversationPersisted, false, 'false is written, not omitted')
  })

  it('serializeState omits the key for a provider that does not track it', () => {
    const mgr = newMgr()
    mgr.createSession({ name: 'C', cwd: '/tmp', provider: 'test-silent-8418' })
    const [saved] = mgr.serializeState().sessions
    assert.equal(Object.prototype.hasOwnProperty.call(saved, 'conversationPersisted'), false)
  })

  it('round trip: a persisted bit comes back to the provider', () => {
    const first = newMgr()
    first.createSession({ name: 'R', cwd: '/tmp', provider: 'test-reporting-8418', resumeSessionId: LOST_ID, conversationPersisted: true })
    first.serializeState()
    first.destroyAll()
    ctorOpts = []
    const second = newMgr()
    assert.ok(second.restoreState(), 'restored')
    assert.equal(ctorOpts.length, 1)
    assert.strictEqual(ctorOpts[0].conversationPersisted, true)
    assert.equal(ctorOpts[0].resumeSessionId, LOST_ID)
  })

  it('an older state file with no bit restores exactly as before: the provider is not handed one', () => {
    writeState({})
    const mgr = newMgr()
    assert.ok(mgr.restoreState())
    assert.equal(ctorOpts.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(ctorOpts[0], 'conversationPersisted'), false)
  })

  it('only a literal true is believed; anything else restores as unknown', () => {
    for (const bad of [false, 'true', 1, {}, [], null]) {
      ctorOpts = []
      writeState({ conversationPersisted: bad })
      const mgr = newMgr()
      assert.ok(mgr.restoreState())
      assert.equal(Object.prototype.hasOwnProperty.call(ctorOpts[0], 'conversationPersisted'), false, `${JSON.stringify(bad)}`)
    }
  })

  it('a session parked as a failed restore keeps the bit on disk', () => {
    const mgr = newMgr()
    writeState({ provider: 'test-no-such-provider-8418', conversationPersisted: true })
    mgr.restoreState()
    const saved = mgr.serializeState().sessions.find((s) => s.id === RESTORED_SESSION_ID)
    assert.ok(saved, 'the unrestorable entry is rewritten, not dropped')
    assert.strictEqual(saved.conversationPersisted, true)
  })
})

describe('a restored claude-tui session whose transcript is gone (#8418)', () => {
  let home, origHome, origUserProfile, origClaudeDir, cwd, stateFile, unpinSink, root, mgrs
  let spawns, failSpawn
  const origWait = ClaudeTuiSession.prototype._waitForPrompt
  const origProbe = ClaudeTuiSession.prototype._probeLoginBeforeFirstSpawn

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-8418-int-'))
    home = join(root, 'home')
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    cwd = join(root, 'cwd')
    mkdirSync(cwd, { recursive: true })
    stateFile = join(root, 'session-state.json')
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    origClaudeDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.CHROXY_CONFIG_DIR = join(home, '.chroxy')
    unpinSink = pinTmpDaemonBase(ClaudeTuiSession, 'SINK_BASE')
    mgrs = []
    spawns = []
    failSpawn = false
    // A node-pty stand-in on the prototype: the manager builds the session itself.
    Object.defineProperty(ClaudeTuiSession.prototype, '_ptyModOverride', {
      configurable: true,
      writable: true,
      value: {
        spawn: (_cmd, args) => {
          if (failSpawn) throw new Error('spawn failed')
          spawns.push(args.slice())
          return { pid: 2 ** 30, write: () => {}, kill: () => {}, onExit: () => {}, on: () => {}, onData: () => {} }
        },
      },
    })
    ClaudeTuiSession.prototype._waitForPrompt = async () => true
    ClaudeTuiSession.prototype._probeLoginBeforeFirstSpawn = async () => {}
  })

  afterEach(() => {
    for (const m of mgrs) { try { m.destroyAll() } catch { /* ignore */ } }
    delete ClaudeTuiSession.prototype._ptyModOverride
    ClaudeTuiSession.prototype._waitForPrompt = origWait
    ClaudeTuiSession.prototype._probeLoginBeforeFirstSpawn = origProbe
    unpinSink()
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile
    else delete process.env.USERPROFILE
    if (origClaudeDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origClaudeDir
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    rmSync(root, { recursive: true, force: true })
  })

  const readState = () => JSON.parse(readFileSync(stateFile, 'utf-8'))
  const noticesIn = (history) => history.filter((h) => h.messageType === 'error' && h.code === 'resume_unknown')

  function writeSaved(overrides = {}) {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{
        id: RESTORED_SESSION_ID, name: 'TUI', cwd: realpathSync(cwd), model: null, permissionMode: 'approve',
        provider: 'claude-tui', sdkSessionId: LOST_ID, conversationPersisted: true,
        history: [{ type: 'message', messageType: 'user_input', content: 'earlier question', timestamp: Date.now() - 1000 }],
        ...overrides,
      }],
    }))
  }

  function boot() {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: cwd, stateFilePath: stateFile })
    mgrs.push(mgr)
    const seen = []
    mgr.on('session_event', (e) => seen.push(e))
    return { mgr, seen }
  }

  async function until(pred, what) {
    const deadline = Date.now() + 5000
    while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    assert.ok(pred(), what)
  }

  it('fresh on the same id; the notice is in history after the restored history and in the state file', async () => {
    writeSaved()
    const { mgr, seen } = boot()
    const id = mgr.restoreState()
    assert.ok(id, 'restored')
    await until(() => seen.some((e) => e.event === 'ready'), 'the restored session became ready')

    assert.equal(spawns.length, 1)
    assert.deepEqual(spawns[0].slice(0, 2), ['--session-id', LOST_ID], 'no --resume of a transcript that is gone; same id')

    const history = mgr.getHistory(id)
    const notice = noticesIn(history)
    assert.equal(notice.length, 1, 'exactly one notice, so a reconnect or cursor replay shows it once')
    assert.equal(notice[0].attemptedResumeId, LOST_ID)
    assert.ok(history.indexOf(notice[0]) > history.findIndex((h) => h.content === 'earlier question'),
      'it follows the history it explains')
    assert.equal(mgr._sessions.get(id).session.resumeSessionId, LOST_ID, 'the conversation id is untouched')

    mgr.serializeState()
    const saved = readState().sessions[0]
    assert.equal(saved.sdkSessionId, LOST_ID)
    assert.strictEqual(saved.conversationPersisted, false, 'nothing is saved under the fresh conversation yet')
    assert.equal(noticesIn(saved.history).length, 1, 'the notice is persisted with the history')
  })

  it('a restart before any new turn is a silent ordinary fresh start (the history keeps the one notice)', async () => {
    writeSaved()
    const first = boot()
    first.mgr.restoreState()
    await until(() => first.seen.some((e) => e.event === 'ready'), 'ready')
    first.mgr.serializeState()
    first.mgr.destroyAll()

    spawns.length = 0
    const second = boot()
    const id2 = second.mgr.restoreState()
    await until(() => second.seen.some((e) => e.event === 'ready'), 'second ready')
    assert.deepEqual(spawns[0].slice(0, 2), ['--session-id', LOST_ID])
    assert.equal(noticesIn(second.mgr.getHistory(id2)).length, 1, 'no second announcement')
  })

  it('a start that fails before the notice parks the ORIGINAL claim, and the retry announces the loss once', async () => {
    writeSaved()
    const { mgr, seen } = boot()
    failSpawn = true
    mgr.restoreState()
    await until(() => mgr.getFailedRestores().length === 1, 'the failed start was parked')
    assert.equal(seen.some((e) => e.event === 'ready'), false)

    const onDisk = readState().sessions.find((x) => x.id === RESTORED_SESSION_ID)
    assert.equal(onDisk.sdkSessionId, LOST_ID)
    assert.strictEqual(onDisk.conversationPersisted, true, 'the claim survives the failed start')
    assert.equal(noticesIn(onDisk.history).length, 0, 'nothing was announced')

    failSpawn = false
    const result = await mgr.retryFailedRestore(RESTORED_SESSION_ID)
    assert.equal(result.ok, true)
    await until(() => seen.some((e) => e.event === 'ready'), 'the retried session became ready')
    const notice = noticesIn(mgr.getHistory(result.sessionId))
    assert.equal(notice.length, 1, 'announced exactly once, by the attempt that succeeded')
    assert.equal(notice[0].attemptedResumeId, LOST_ID)
    assert.deepEqual(spawns[0].slice(0, 2), ['--session-id', LOST_ID])
  })

  it('a session that never completed a turn restores fresh with no notice', async () => {
    writeSaved({ conversationPersisted: false })
    const { mgr, seen } = boot()
    const id = mgr.restoreState()
    await until(() => seen.some((e) => e.event === 'ready'), 'ready')
    assert.deepEqual(spawns[0].slice(0, 2), ['--session-id', LOST_ID])
    assert.equal(noticesIn(mgr.getHistory(id)).length, 0)
  })
})
