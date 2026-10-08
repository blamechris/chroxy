import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { encodeProjectPath, hasPersistedTranscript, resolveClaudeProjectsDir } from '../src/jsonl-reader.js'

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
let realUserProfile
let realConfigDir
let cwd
let cwdReal
const cleanups = []

beforeEach(() => {
  realHome = process.env.HOME
  // os.homedir() reads USERPROFILE on Windows, not HOME.
  realUserProfile = process.env.USERPROFILE
  realConfigDir = process.env.CLAUDE_CONFIG_DIR
  // A developer's own override must not leak into the probe under test.
  delete process.env.CLAUDE_CONFIG_DIR
  fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-8239-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'chroxy-8239-cwd-'))
  cwdReal = realpathSync(cwd)
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
})

afterEach(async () => {
  process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = realConfigDir
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
  // Hermetic on every host: with a real `claude` on PATH the pre-spawn login
  // probe would run `claude auth status` against the temp HOME, answer
  // logged-out, and refuse the spawn with AUTH_REQUIRED.
  const loginProbeRunner = async () => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' })
  const s = new ClaudeTuiSession({ cwd, skillsDir, repoSkillsDir: null, loginProbeRunner, ...ctorOpts })
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

// Drive one real turn to the Stop-hook success path: the fake PTY drops a
// `stop-*.json` into the sink dir when the prompt is written, exactly as
// claude's Stop hook does.
async function completeTurnViaStopHook(session, control) {
  session._processReady = true
  // The sink dir's PARENT is the hook-sink base, which the poll re-validates as
  // owned by this uid (`sink_base_compromised` otherwise, and the Stop hook is
  // never read). A bare tmpdir() is the user's own on macOS but root's on Linux,
  // so nest under a base this process owns, as the real SINK_BASE is.
  const sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-8239-sinkbase-'))
  const sinkDir = join(sinkBase, 's-test')
  mkdirSync(sinkDir, { recursive: true, mode: 0o700 })
  session._sinkDir = sinkDir
  cleanups.push(() => rmSync(sinkBase, { recursive: true, force: true }))
  session._hardTimeoutMs = 5000
  session._resultTimeoutMs = 5000
  control.terms[0].write = () => {
    writeFileSync(join(sinkDir, 'stop-8239.json'), JSON.stringify({ last_assistant_message: 'done' }))
  }
  await session.sendMessage('hello')
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

  it('a turn completed through the REAL Stop-hook path latches, so the next respawn --resumes', async () => {
    // No transcript on disk: only the latch can say a conversation exists.
    const { session, control, errors } = makeSession()
    session._resumedFromPersisted = false
    await session._spawnPty(false)
    assert.equal(session._conversationEverPersisted, false, 'precondition: nothing latched yet')
    await completeTurnViaStopHook(session, control)
    assert.equal(session._conversationEverPersisted, true, 'the Stop hook latched the conversation')
    control.terms[0].exitHandlers[0]({ exitCode: 1 })
    clearTimeout(session._respawnTimer)
    session._respawnTimer = null
    session._respawnScheduled = false
    await session._respawnPty()
    assert.deepEqual(idArgs(control.spawns[1]), ['--resume', SESSION_ID])
    assert.equal(errors.some((e) => e.code === 'resume_unknown'), false)
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

describe('CLAUDE_CONFIG_DIR (#8239)', () => {
  let configDir
  beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'chroxy-8239-config-')) })
  afterEach(() => { rmSync(configDir, { recursive: true, force: true }) })

  function writeTranscriptUnder(root) {
    const dir = join(root, 'projects', encodeProjectPath(cwdReal))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${SESSION_ID}.jsonl`), '{"type":"user"}\n')
  }

  it('resolves the projects root from the override, else ~/.claude', () => {
    assert.equal(resolveClaudeProjectsDir({ CLAUDE_CONFIG_DIR: configDir }), join(configDir, 'projects'))
    assert.equal(resolveClaudeProjectsDir({}), join(fakeHome, '.claude', 'projects'))
    assert.equal(resolveClaudeProjectsDir({ CLAUDE_CONFIG_DIR: '' }), join(fakeHome, '.claude', 'projects'))
  })

  it('the probe finds a transcript that lives under the override, not ~/.claude', () => {
    writeTranscriptUnder(configDir)
    assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID, { CLAUDE_CONFIG_DIR: configDir }), true)
    assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID, {}), false, 'with no override ~/.claude is searched, and it is empty')
  })

  it('with the override set, a transcript under ~/.claude is NOT what claude would resume', () => {
    writeTranscript()
    assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID, { CLAUDE_CONFIG_DIR: configDir }), false)
  })

  it('a restored session resumes when the transcript is under the env the child is spawned with', async () => {
    writeTranscriptUnder(configDir)
    const { session, control } = makeSession({ resumeSessionId: SESSION_ID, connectionChildEnv: { ...process.env, CLAUDE_CONFIG_DIR: configDir } })
    await session._spawnPty(false)
    assert.deepEqual(idArgs(control.spawns[0]), ['--resume', SESSION_ID])
  })

  it('a restored session resumes when the override comes from the daemon env', async () => {
    writeTranscriptUnder(configDir)
    process.env.CLAUDE_CONFIG_DIR = configDir
    const { session, control } = makeSession({ resumeSessionId: SESSION_ID })
    await session._spawnPty(false)
    assert.deepEqual(idArgs(control.spawns[0]), ['--resume', SESSION_ID])
  })

  it('with the override unset the restored session still probes ~/.claude', async () => {
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

  it('fails safe when a project dir cannot be searched (EACCES is not "never saved")', { skip: process.platform === 'win32' ? 'chmod does not restrict access on win32' : false }, () => {
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

  it('fails safe when the projects directory itself cannot be read (a non-ENOENT readdir error is not "never saved")', { skip: process.platform === 'win32' ? 'chmod does not restrict access on win32' : false }, () => {
    if (process.getuid && process.getuid() === 0) return
    // Search (x) permission without read (r): statting the expected child
    // answers ENOENT, then listing `projects` itself fails with EACCES.
    const projects = join(fakeHome, '.claude', 'projects')
    mkdirSync(projects, { recursive: true })
    chmodSync(projects, 0o100)
    try {
      assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID), true)
    } finally {
      chmodSync(projects, 0o700)
    }
  })

  it('fails safe when the expected project key is too long to stat (ENAMETOOLONG is not "never saved")', { skip: process.platform === 'win32' ? 'win32 long-path handling does not raise ENAMETOOLONG here' : false }, () => {
    // claude shortens long project keys itself, so the file sits under a name
    // this probe cannot derive; the first stat throws ENAMETOOLONG, which must
    // read as "could not look", not "absent".
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true })
    assert.equal(hasPersistedTranscript('/' + 'a'.repeat(300), SESSION_ID), true)
  })

  it('fails safe when the expected project dir cannot be stat-ed (EACCES is not "never saved")', { skip: process.platform === 'win32' ? 'chmod does not restrict access on win32' : false }, () => {
    if (process.getuid && process.getuid() === 0) return
    // x-bit removed on the expected key dir: statSync of <dir>/<id>.jsonl is
    // EACCES. (The all-directories scan hits the same entry, so this branch and
    // the scan answer alike; the test pins the answer, not which one gave it.)
    const dir = join(fakeHome, '.claude', 'projects', encodeProjectPath(cwdReal))
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o000)
    try {
      assert.equal(hasPersistedTranscript(cwdReal, SESSION_ID), true)
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})
