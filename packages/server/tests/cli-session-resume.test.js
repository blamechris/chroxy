import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliSession, buildClaudeCliArgs } from '../src/cli-session.js'

/**
 * Regression coverage for #4887 — claude CLI session resumes without prior
 * assistant turn, model starts cold mid-conversation.
 *
 * Root cause: the claude `-p --input-format stream-json` subprocess holds the
 * conversation context entirely in process memory. When chroxy respawns the
 * subprocess (model switch, permission-mode flip, crash) — or when chroxy
 * itself restarts and SessionManager rebuilds the session — the new process
 * starts cold. The user's history is still in the chroxy ring buffer and
 * replays to the dashboard fine, but the model itself has no idea what the
 * prior assistant turn said.
 *
 * Claude CLI ships `--resume <session-id>` that wires the new subprocess back
 * onto the previous conversation. This suite pins the resume contract:
 *
 *   1. The exposed `resumeSessionId` getter mirrors `_sessionId` so
 *      SessionManager.serializeState can persist it under `sdkSessionId`.
 *   2. The CliSession constructor accepts `resumeSessionId` and seeds
 *      `_sessionId` from it so server-restart restore re-uses it.
 *   3. `buildClaudeCliArgs` includes `--resume <id>` when a session id is
 *      known — both on respawn within the same process and on a restored
 *      session's first spawn.
 *   4. `capabilities.resume` is true.
 *   5. `_killAndRespawn` preserves `_sessionId` so the respawned subprocess
 *      can carry `--resume` forward.
 */

let _globalTmpDir
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'cli-session-resume-test-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function createSession(opts = {}) {
  const stateFilePath = opts.stateFilePath || tmpStateFile()
  const session = new CliSession({ cwd: '/tmp', stateFilePath, ...opts })
  session._testStateFilePath = stateFilePath
  return session
}

describe('CliSession resume — buildClaudeCliArgs (#4887)', () => {
  it('omits --resume on a brand-new session (no _sessionId yet)', () => {
    const args = buildClaudeCliArgs({
      model: null,
      permissionMode: 'approve',
      allowedTools: [],
      skillsText: '',
      resumeSessionId: null,
    })
    assert.ok(!args.includes('--resume'),
      'fresh session must not carry --resume; CLI starts a new conversation')
  })

  it('includes --resume <id> when a session id is known (respawn / restore path)', () => {
    const args = buildClaudeCliArgs({
      model: null,
      permissionMode: 'approve',
      allowedTools: [],
      skillsText: '',
      resumeSessionId: 'cli-session-abc-123',
    })
    const i = args.indexOf('--resume')
    assert.ok(i >= 0,
      'respawned / restored session must carry --resume so the model sees the prior conversation')
    assert.equal(args[i + 1], 'cli-session-abc-123',
      'the session id captured from system.init must be the argument to --resume')
  })

  it('preserves --model / --permission-mode / --allowedTools alongside --resume', () => {
    const args = buildClaudeCliArgs({
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
      allowedTools: ['Read', 'Write'],
      skillsText: 'extra system prompt',
      resumeSessionId: 'cli-resume-xyz',
    })
    assert.ok(args.includes('--resume'))
    assert.equal(args[args.indexOf('--resume') + 1], 'cli-resume-xyz')
    assert.ok(args.includes('--model'))
    assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6')
    assert.ok(args.includes('--permission-mode'))
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions')
    assert.ok(args.includes('--allowedTools'))
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Write')
    assert.ok(args.includes('--append-system-prompt'))
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'extra system prompt')
  })

  it('always emits the headless streaming defaults', () => {
    const args = buildClaudeCliArgs({
      model: null,
      permissionMode: 'approve',
      allowedTools: [],
      skillsText: '',
      resumeSessionId: null,
    })
    assert.equal(args[0], '-p')
    assert.ok(args.includes('--input-format'))
    assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json')
    assert.ok(args.includes('--output-format'))
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json')
    assert.ok(args.includes('--verbose'))
    assert.ok(args.includes('--include-partial-messages'))
  })

  it('treats empty / non-string resumeSessionId as "no resume"', () => {
    for (const value of [null, undefined, '', 0, false, {}, []]) {
      const args = buildClaudeCliArgs({
        model: null,
        permissionMode: 'approve',
        allowedTools: [],
        skillsText: '',
        resumeSessionId: value,
      })
      assert.ok(!args.includes('--resume'),
        `non-string / empty resumeSessionId (${JSON.stringify(value)}) must not emit --resume; ` +
        'a phantom resume id would 404 or fork into a wrong conversation')
    }
  })
})

describe('CliSession resume — capability + constructor (#4887)', () => {
  afterEach(() => {
    if (_globalTmpDir) {
      try { rmSync(_globalTmpDir, { recursive: true, force: true }) } catch {}
      _globalTmpDir = undefined
    }
  })

  it('declares resume: true so SessionManager / UI know the provider supports it', () => {
    assert.equal(CliSession.capabilities.resume, true,
      'claude CLI supports --resume; capability must reflect that so the persistence layer round-trips _sessionId')
  })

  it('exposes resumeSessionId getter wired to _sessionId', () => {
    const session = createSession()
    assert.equal(session.resumeSessionId, null, 'no init yet → no resume id')
    session._sessionId = 'cli-init-uuid'
    assert.equal(session.resumeSessionId, 'cli-init-uuid',
      'getter must mirror _sessionId so SessionManager.serializeState can persist it')
    session.destroy()
  })

  it('accepts resumeSessionId in the constructor and seeds _sessionId', () => {
    const session = createSession({ resumeSessionId: 'cli-restored-123' })
    assert.equal(session._sessionId, 'cli-restored-123',
      'restore path forwards resumeSessionId; the session must adopt it so start() can pass --resume')
    assert.equal(session.resumeSessionId, 'cli-restored-123')
    session.destroy()
  })

  it('ignores empty / missing resumeSessionId (fresh session, no opt)', () => {
    const session1 = createSession()
    assert.equal(session1._sessionId, null)
    session1.destroy()

    const session2 = createSession({ resumeSessionId: '' })
    assert.equal(session2._sessionId, null, 'empty string must not pin a phantom resume id')
    session2.destroy()

    const session3 = createSession({ resumeSessionId: null })
    assert.equal(session3._sessionId, null)
    session3.destroy()
  })
})

describe('CliSession resume — _killAndRespawn preserves _sessionId so the next start() resumes (#4887)', () => {
  afterEach(() => {
    if (_globalTmpDir) {
      try { rmSync(_globalTmpDir, { recursive: true, force: true }) } catch {}
      _globalTmpDir = undefined
    }
  })

  it('does NOT clear _sessionId on _killAndRespawn — the respawned child must --resume', () => {
    const session = createSession()
    session._sessionId = 'cli-init-uuid-from-prior-turn'
    // Stub start() so we don't actually spawn — we only assert on state.
    session.start = () => {}
    session._destroying = true // suppress the closure respawn() so the test is hermetic
    session._killAndRespawn()
    assert.equal(session._sessionId, 'cli-init-uuid-from-prior-turn',
      '_killAndRespawn must NOT null out _sessionId — the next start() needs it to pass --resume so the model retains conversation context')
    assert.equal(session.resumeSessionId, 'cli-init-uuid-from-prior-turn',
      'getter mirrors _sessionId; the persistence layer reads this on the next serialize tick')
  })
})
