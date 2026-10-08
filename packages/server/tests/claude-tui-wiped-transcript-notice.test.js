import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { encodeProjectPath } from '../src/jsonl-reader.js'
import { pinTmpDaemonBase } from './helpers/pin-tmp-daemon-base.js'

/**
 * #8418 — a restored claude-tui session used to decide `--resume` vs a fresh
 * `--session-id` from the disk probe alone (#8239), so a transcript that had
 * been wiped went fresh with only a `log.info`: the model forgot everything and
 * nobody was told. SessionManager now persists whether claude ever saved the
 * conversation (`conversationPersisted`); a session restored with that bit set
 * and no transcript starts a NEW conversation and says so with the existing
 * `resume_unknown` frame.
 *
 * These run the REAL `start()` / `_spawnPty` / `_respawnPty` against a node-pty
 * stand-in (the `_ptyModOverride` seam) and the REAL transcript probe under a
 * throwaway HOME. No claude is spawned and nothing touches ~/.claude.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR
const OLD_ID = '0f8418aa-0000-4000-8000-000000000001'
const fakePid = 2 ** 30

let unpinSinkBase
beforeEach(() => { unpinSinkBase = pinTmpDaemonBase(ClaudeTuiSession, 'SINK_BASE') })
afterEach(() => { if (unpinSinkBase) unpinSinkBase(); unpinSinkBase = null })

describe('claude-tui restored session whose transcript is gone (#8418)', () => {
  let fakeHome, origHome, origUserProfile, origConfigDir, fakeCwd, cwdReal, skillsDir, session

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-8418-home-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    fakeCwd = mkdtempSync(join(tmpdir(), 'chroxy-8418-cwd-'))
    cwdReal = realpathSync(fakeCwd) // the probe keys off the realpath (macOS /var -> /private/var)
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-8418-skills-'))
  })

  afterEach(async () => {
    if (session) {
      clearTimeout(session._respawnTimer)
      try { await session.destroy() } catch { /* ignore */ }
    }
    session = null
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile
    else delete process.env.USERPROFILE
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    for (const d of [fakeHome, fakeCwd, skillsDir]) rmSync(d, { recursive: true, force: true })
  })

  function writeTranscript(id) {
    const dir = join(fakeHome, '.claude', 'projects', encodeProjectPath(cwdReal))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n')
  }

  function make(ctorOpts = {}) {
    const control = { spawns: [], terms: [] }
    const s = new ClaudeTuiSession({
      cwd: fakeCwd, skillsDir, repoSkillsDir: null,
      // Hermetic: never run a real `claude auth status`.
      loginProbeRunner: async () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' }),
      ...ctorOpts,
    })
    session = s
    s._ptyModOverride = {
      spawn: (_cmd, args) => {
        control.spawns.push(args.slice())
        const term = {
          pid: fakePid + control.spawns.length,
          exitHandlers: [],
          write: () => {},
          kill: () => {},
          onExit: (cb) => { term.exitHandlers.push(cb) },
          on: () => {},
          onData: () => {},
        }
        control.terms.push(term)
        return term
      },
    }
    s._waitForPrompt = async () => true
    const events = []
    s.on('error', (e) => events.push({ type: 'error', ...e }))
    s.on('ready', (e) => events.push({ type: 'ready', ...e }))
    return { s, control, events }
  }

  const idArgs = (args) => args.slice(0, 2)
  const noticesOf = (events) => events.filter((e) => e.type === 'error' && e.code === 'resume_unknown')

  async function respawnNow(s) {
    clearTimeout(s._respawnTimer)
    s._respawnTimer = null
    s._respawnScheduled = false
    await s._respawnPty()
  }

  it('persisted bit + transcript gone: starts a NEW conversation under a NEW id and tells the user', async () => {
    const { s, control, events } = make({ resumeSessionId: OLD_ID, conversationPersisted: true })
    assert.equal(s.conversationPersisted, true, 'precondition: the latch is seeded from saved state')
    await s.start()

    const [flag, newId] = idArgs(control.spawns[0])
    assert.equal(flag, '--session-id', 'a vanished transcript cannot be resumed, so the spawn is fresh')
    assert.equal(control.spawns[0].includes('--resume'), false)
    assert.notEqual(newId, OLD_ID, 'the lost id is not reused')
    assert.equal(s.resumeSessionId, newId, 'what is persisted and reported next is the id claude now holds')

    const notices = noticesOf(events)
    assert.equal(notices.length, 1, 'exactly one visible notice')
    assert.equal(notices[0].attemptedResumeId, OLD_ID, 'it names the conversation that was lost')
    assert.ok(/could not be resumed/.test(notices[0].message))
    assert.ok(/transcript/.test(notices[0].message))
    const order = events.map((e) => e.type)
    assert.ok(order.indexOf('error') !== -1 && order.indexOf('error') < order.indexOf('ready'),
      'the notice is emitted before ready, not after')
    assert.equal(events.find((e) => e.type === 'ready').sessionId, newId, 'ready carries the new id')
    assert.equal(s.conversationPersisted, false, 'the new conversation has saved nothing yet')
  })

  it('a start that fails after the decision announces nothing (the notice belongs to a conversation that began)', async () => {
    const { s, events } = make({ resumeSessionId: OLD_ID, conversationPersisted: true })
    s._ptyModOverride = { spawn: () => { throw new Error('spawn failed') } }
    await assert.rejects(s.start())
    assert.equal(noticesOf(events).length, 0, 'no notice for a fresh conversation that never started')
  })

  it('the notice is told once: a respawn before any turn starts fresh on the new id, silently', async () => {
    const { s, control, events } = make({ resumeSessionId: OLD_ID, conversationPersisted: true })
    await s.start()
    const newId = s.resumeSessionId
    control.terms[0].exitHandlers[0]({ exitCode: 1 })
    await respawnNow(s)
    assert.deepEqual(idArgs(control.spawns[1]), ['--session-id', newId],
      'the latch was reset with the id, so the empty new conversation is not --resumed')
    assert.equal(noticesOf(events).length, 1, 'no second notice')
    assert.equal(s.resumeSessionId, newId)
  })

  it('persisted bit + transcript present: resumes the same id with no notice', async () => {
    writeTranscript(OLD_ID)
    const { s, control, events } = make({ resumeSessionId: OLD_ID, conversationPersisted: true })
    await s.start()
    assert.deepEqual(idArgs(control.spawns[0]), ['--resume', OLD_ID])
    assert.equal(s.resumeSessionId, OLD_ID)
    assert.equal(noticesOf(events).length, 0)
    assert.equal(s.conversationPersisted, true)
  })

  it('no persisted bit + no transcript (never completed a turn): fresh on the same id, NO notice', async () => {
    const { s, control, events } = make({ resumeSessionId: OLD_ID })
    await s.start()
    assert.deepEqual(idArgs(control.spawns[0]), ['--session-id', OLD_ID])
    assert.equal(s.resumeSessionId, OLD_ID, 'an untouched session keeps its id')
    assert.equal(noticesOf(events).length, 0, 'there was nothing to lose')
    assert.equal(events.filter((e) => e.type === 'error').length, 0)
    assert.equal(s.conversationPersisted, false)
  })

  it('an explicit false bit is the same as an absent one', async () => {
    const { s, control, events } = make({ resumeSessionId: OLD_ID, conversationPersisted: false })
    await s.start()
    assert.deepEqual(idArgs(control.spawns[0]), ['--session-id', OLD_ID])
    assert.equal(noticesOf(events).length, 0)
  })

  it('no persisted bit but the transcript is on disk: resumes, as before (the disk probe still wins)', async () => {
    writeTranscript(OLD_ID)
    const { s, control, events } = make({ resumeSessionId: OLD_ID })
    await s.start()
    assert.deepEqual(idArgs(control.spawns[0]), ['--resume', OLD_ID])
    assert.equal(noticesOf(events).length, 0)
    assert.equal(s.conversationPersisted, true, 'seeing the file latches it')
  })

  it('a bit without a resume id is ignored: a fresh session has no conversation to lose', async () => {
    const { s, control, events } = make({ conversationPersisted: true })
    assert.equal(s.conversationPersisted, false)
    await s.start()
    assert.equal(control.spawns[0][0], '--session-id')
    assert.equal(noticesOf(events).length, 0)
  })

  it('non-boolean bits never seed the latch', () => {
    for (const v of ['true', 1, {}, [], null, undefined]) {
      const { s } = make({ resumeSessionId: OLD_ID, conversationPersisted: v })
      assert.equal(s.conversationPersisted, false, `${JSON.stringify(v)} must not count`)
    }
  })

  it('fails safe: a transcript root it cannot read keeps --resume and tells no lie', { skip: process.platform === 'win32' ? 'chmod does not restrict access on win32' : false }, async () => {
    if (process.getuid && process.getuid() === 0) return
    const projects = join(fakeHome, '.claude', 'projects')
    mkdirSync(projects, { recursive: true })
    chmodSync(projects, 0o100) // searchable, not listable: the probe could not look
    try {
      const { s, control, events } = make({ resumeSessionId: OLD_ID, conversationPersisted: true })
      await s.start()
      assert.deepEqual(idArgs(control.spawns[0]), ['--resume', OLD_ID])
      assert.equal(noticesOf(events).length, 0, 'could not look is not "wiped"')
    } finally {
      chmodSync(projects, 0o700)
    }
  })

  it('a later PTY death with a live latch still takes the --resume classifier path (a mid-run wipe is not handled here)', async () => {
    writeTranscript(OLD_ID)
    const { s, control } = make({ resumeSessionId: OLD_ID, conversationPersisted: true })
    await s.start()
    control.terms[0].exitHandlers[0]({ exitCode: 1 })
    await respawnNow(s)
    assert.deepEqual(idArgs(control.spawns[1]), ['--resume', OLD_ID])
  })
})
