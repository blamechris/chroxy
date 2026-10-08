import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { encodeProjectPath, hasPersistedTranscript } from '../src/jsonl-reader.js'

/**
 * #8239 — a claude-tui session that never completed a turn has no transcript
 * for its id (claude writes `<id>.jsonl` on the first turn, not at launch), so
 * `--resume <id>` is rejected and the user saw a bogus "could not be resumed"
 * notice after every PTY death / daemon restart of an untouched session.
 *
 * These drive the REAL `_spawnPty` / `_respawnPty` / `_onPtyGone` through the
 * `_ptyModOverride` stand-in (no claude is ever spawned) and the REAL
 * transcript probe against a throwaway HOME, so nothing touches ~/.claude.
 */

const SESSION_ID = '0f8239aa-0000-4000-8000-000000000001'

let fakeHome
let realHome
let cwd
let cwdReal
const cleanups = []

beforeEach(() => {
  realHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-8239-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'chroxy-8239-cwd-'))
  cwdReal = realpathSync(cwd)
  process.env.HOME = fakeHome
})

afterEach(async () => {
  process.env.HOME = realHome
  for (const fn of cleanups.splice(0)) await fn()
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function writeTranscript(dirCwd = cwdReal, id = SESSION_ID) {
  const dir = join(fakeHome, '.claude', 'projects', encodeProjectPath(dirCwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n')
}

function makeSession(ctorOpts = {}) {
  const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-8239-skills-'))
  const s = new ClaudeTuiSession({ cwd, skillsDir, repoSkillsDir: null, ...ctorOpts })
  s._waitForPrompt = async () => true
  s._sessionId = ctorOpts.resumeSessionId || SESSION_ID
  s._settingsPath = join(tmpdir(), 'fixture-settings-8239.json')
  const control = { spawns: [], terms: [], tailOnSpawn: null }
  s._ptyModOverride = {
    spawn: (_cmd, args) => {
      control.spawns.push(args.slice())
      const term = {
        pid: 2147483600 + control.spawns.length,
        exitHandlers: [],
        dataHandlers: [],
        write: () => {},
        kill: () => {},
        onData: (cb) => { term.dataHandlers.push(cb) },
        onExit: (cb) => { term.exitHandlers.push(cb) },
        on: () => {},
      }
      control.terms.push(term)
      return term
    },
  }
  const errors = []
  s.on('error', (e) => errors.push(e))
  cleanups.push(async () => {
    if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null }
    clearTimeout(s._respawnTimer)
    try { await s.destroy() } catch { /* ignore */ }
    if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null }
    rmSync(skillsDir, { recursive: true, force: true })
  })
  return { session: s, control, errors }
}

const idArgs = (args) => args.slice(0, 2)

describe('claude-tui respawn without a persisted transcript (#8239)', () => {
  it('an untouched session respawns FRESH on the same id: no --resume, no rejection notice', async () => {
    const { session, control, errors } = makeSession()
    session._resumedFromPersisted = false // start() spawned it fresh (--session-id)
    await session._spawnPty(false)
    assert.deepEqual(idArgs(control.spawns[0]), ['--session-id', SESSION_ID], 'precondition: first spawn is fresh')

    control.terms[0].exitHandlers[0]({ exitCode: 1 })
    clearTimeout(session._respawnTimer)
    session._respawnTimer = null
    session._respawnScheduled = false
    await session._respawnPty()

    assert.deepEqual(idArgs(control.spawns[1]), ['--session-id', SESSION_ID],
      'no transcript exists for the id, so the respawn must be fresh on the SAME id')
    assert.equal(control.spawns[1].includes('--resume'), false, 'must not --resume an id claude never saved')
    assert.equal(session._sessionId, SESSION_ID, 'the conversation id is not changed')
    assert.equal(errors.some((e) => e.code === 'resume_unknown'), false, 'no resume-rejection notice')
    assert.equal(errors.some((e) => /could not be resumed/.test(e.message || '')), false)
  })

  it('a session that completed a turn respawns with --resume', async () => {
    const { session, control } = makeSession()
    session._resumedFromPersisted = false
    await session._spawnPty(false)
    session._conversationEverPersisted = true // what the Stop-hook success path latches
    control.terms[0].exitHandlers[0]({ exitCode: 1 })
    clearTimeout(session._respawnTimer)
    session._respawnTimer = null
    session._respawnScheduled = false
    await session._respawnPty()
    assert.deepEqual(idArgs(control.spawns[1]), ['--resume', SESSION_ID])
    assert.equal(control.spawns[1].includes('--session-id'), false)
  })

  it('a session whose transcript is on disk (no turn seen in this process) respawns with --resume', async () => {
    writeTranscript()
    const { session, control } = makeSession()
    session._resumedFromPersisted = false
    await session._spawnPty(false)
    control.terms[0].exitHandlers[0]({ exitCode: 1 })
    clearTimeout(session._respawnTimer)
    session._respawnTimer = null
    session._respawnScheduled = false
    await session._respawnPty()
    assert.deepEqual(idArgs(control.spawns[1]), ['--resume', SESSION_ID])
    assert.equal(session._conversationEverPersisted, true, 'seeing the file latches it')
  })

  it('a transcript that existed and is now gone keeps the "could not be resumed" notice', async () => {
    const { session, control, errors } = makeSession()
    session._resumedFromPersisted = false
    await session._spawnPty(false)
    // A turn completed (transcript existed); the PTY dies and is respawned.
    session._conversationEverPersisted = true
    control.terms[0].exitHandlers[0]({ exitCode: 1 })
    clearTimeout(session._respawnTimer)
    session._respawnTimer = null
    session._respawnScheduled = false
    await session._respawnPty()
    // The second PTY (the --resume respawn) dies rejecting the id.
    assert.deepEqual(idArgs(control.spawns[1]), ['--resume', SESSION_ID])
    control.terms[control.terms.length - 1].dataHandlers.forEach((cb) => cb('No conversation found with session ID: ' + SESSION_ID + '\r\n'))
    control.terms[control.terms.length - 1].exitHandlers[0]({ exitCode: 1 })
    clearTimeout(session._respawnTimer)
    const notice = errors.find((e) => e.code === 'resume_unknown')
    assert.ok(notice, 'the #7847/#5417 classifier still reports the rejected resume')
    assert.equal(notice.attemptedResumeId, SESSION_ID)
    assert.ok(/could not be resumed/.test(notice.message))
  })

  it('a session restored from state with no transcript starts fresh on its first spawn', async () => {
    const { session, control, errors } = makeSession({ resumeSessionId: SESSION_ID })
    assert.equal(session._resumedFromPersisted, true, 'precondition: the ctor seeded the persisted id')
    await session._spawnPty(false)
    assert.deepEqual(idArgs(control.spawns[0]), ['--session-id', SESSION_ID])
    assert.equal(control.spawns[0].includes('--resume'), false)
    assert.equal(errors.length, 0)
  })

  it('a session restored from state WITH a transcript resumes', async () => {
    writeTranscript()
    const { session, control } = makeSession({ resumeSessionId: SESSION_ID })
    await session._spawnPty(false)
    assert.deepEqual(idArgs(control.spawns[0]), ['--resume', SESSION_ID])
  })
})

describe('hasPersistedTranscript (#8239)', () => {
  it('finds the transcript under the expected project directory', () => {
    writeTranscript()
    assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID), true)
  })

  it('finds it under a different project directory (key derivation drift cannot read as "never saved")', () => {
    writeTranscript('/some/other/project')
    assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID), true)
  })

  it('answers false only when it looked and the file is absent', () => {
    mkdirSync(join(fakeHome, '.claude', 'projects', 'x'), { recursive: true })
    assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID), false)
  })

  it('answers false when ~/.claude/projects does not exist at all', () => {
    assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID), false)
  })

  it('fails safe (true = keep resuming) for ids it cannot look up', () => {
    assert.equal(hasPersistedTranscript(cwdReal, '../etc/passwd'), true)
    assert.equal(hasPersistedTranscript(cwdReal, ''), true)
    assert.equal(hasPersistedTranscript(cwdReal, null), true)
  })

  it('fails safe when a project dir cannot be searched (EACCES is not "never saved")', () => {
    // chmod 000 does not restrict root, so there is nothing to assert there.
    if (process.getuid && process.getuid() === 0) return
    const dir = join(fakeHome, '.claude', 'projects', 'locked')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o000)
    try {
      assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID), true)
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})
