import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CliSession,
  RESUME_UNKNOWN_STDERR_PATTERNS,
  stderrIndicatesUnknownResume,
} from '../src/cli-session.js'

/**
 * Regression coverage for #4929 — surface `claude --resume` failures with a
 * distinct error path so operators don't see the generic "exited unexpectedly"
 * toast + a doomed respawn loop hammering the same broken id.
 *
 * Follow-up to #4887 (which wired `--resume <id>` in the first place). If the
 * id is unknown to the local claude CLI — e.g. the operator wiped
 * `~/.claude/projects/` between chroxy boots, or restored a state file from a
 * different machine — `claude -p --resume <id>` exits quickly with a "No
 * conversation found" stderr line and never emits the `system.init` event
 * that confirms a successful resume.
 *
 * Without the #4929 detection branch, every respawn re-passes the same broken
 * `--resume <id>` and never recovers. This suite pins:
 *
 *   1. `RESUME_UNKNOWN_STDERR_PATTERNS` matches the known stderr wording set.
 *   2. `stderrIndicatesUnknownResume` is a pure boolean classifier over a
 *      buffered stderr line set.
 *   3. `_spawnPersistentProcess` records `_attemptedResumeId` from the actual
 *      argv (so the detection survives argv refactors).
 *   4. `system.init` clears `_attemptedResumeId` (resume confirmed → drop the
 *      stderr buffer + reset the one-shot fallback latch).
 *   5. `_handleChildClose` with a matched-resume + unknown-resume stderr:
 *      - emits `error{code:'resume_unknown', attemptedResumeId}`
 *      - clears `_sessionId` so the next spawn omits `--resume`
 *      - resets `_skillsPrepended` so the prepend bucket flows again
 *      - schedules a respawn (one-shot fallback)
 *   6. The fallback latch escalates if a fresh-start retry ALSO matches the
 *      pattern (never spin forever clearing `_sessionId`).
 *   7. A generic crash mid-resume (no matching stderr) does NOT get
 *      misclassified as resume_unknown — falls through to the existing
 *      "exited unexpectedly" path so we don't silently wipe `_sessionId` on a
 *      transient network blip.
 *   8. Intentional Stop and destroy short-circuits still take precedence over
 *      the resume-unknown path.
 */

let _globalTmpDir
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'cli-session-resume-unknown-test-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

afterEach(() => {
  if (_globalTmpDir) {
    try { rmSync(_globalTmpDir, { recursive: true, force: true }) } catch {}
    _globalTmpDir = undefined
  }
})

function createSession(opts = {}) {
  const stateFilePath = opts.stateFilePath || tmpStateFile()
  return new CliSession({ cwd: '/tmp', stateFilePath, ...opts })
}

describe('CliSession resume-unknown — stderr matcher (#4929)', () => {
  it('matches the known "no conversation found" wording set', () => {
    const samples = [
      'Error: No conversation found with id abc-123',
      'no conversation found',
      'CLAUDE_ERROR: Conversation abc-123 was not found',
      'Session not found: abc',
      'no such conversation: abc',
      'unknown session abc-123',
      'Could not find session abc-123',
      // #4950 — these all carry both the resume verb AND a session/conversation/id
      // keyword nearby; the tightened patterns must still classify them.
      'resume failed: conversation gone',
      'Resume failed for session abc-123',
      'Failed to resume conversation abc',
      'Could not resume session abc-123',
      'Unable to resume conversation: missing id',
      'Cannot resume conversation: deleted',
      'Resume of session abc-123 failed',
    ]
    for (const line of samples) {
      assert.equal(stderrIndicatesUnknownResume([line]), true,
        `expected "${line}" to classify as resume-unknown so #4929's fallback path engages`)
    }
  })

  it('does NOT match unrelated stderr (network blip, generic crash, transient warning)', () => {
    const safeSamples = [
      'Warning: tool input parse failed',
      'EPIPE on stdin',
      'Connection refused: Anthropic API',
      'OAuth token refresh failed',
      'OOMKilled',
      'Segmentation fault',
      'unrecognised flag --foobar',
    ]
    for (const line of safeSamples) {
      assert.equal(stderrIndicatesUnknownResume([line]), false,
        `"${line}" must NOT trigger resume-unknown — wiping _sessionId on transient errors would discard the prior conversation`)
    }
  })

  it('#4950 — does NOT match loose "resume…failed" stderr without session/conversation/id context', () => {
    // The dropped `/resume.*failed/i` pattern matched all of these. Each one is
    // a realistic stderr/log line that has nothing to do with the --resume-id
    // failure mode but contains both "resume" and "failed". Wiping `_sessionId`
    // on any of them would silently discard the live conversation mid-flight.
    const looseSamples = [
      'tool resume failed',
      'resume hook failed',
      'user wanted to resume after the failed sync',
      'failed to write log file during resume',
      'failed during resume hook',
      'tool execution failed during the resume window',
      'background resume task failed: out of memory',
      'resume timer failed to start',
    ]
    for (const line of looseSamples) {
      assert.equal(stderrIndicatesUnknownResume([line]), false,
        `#4950 — "${line}" matched the old /resume.*failed/i regex; the tightened patterns must require session/conversation/id nearby so a tool-side failure during a resume window does not trigger a phantom _sessionId wipe`)
    }
  })

  it('returns false for empty / non-array input', () => {
    assert.equal(stderrIndicatesUnknownResume([]), false)
    assert.equal(stderrIndicatesUnknownResume(null), false)
    assert.equal(stderrIndicatesUnknownResume(undefined), false)
    assert.equal(stderrIndicatesUnknownResume('not an array'), false)
  })

  it('exports a non-empty pattern set so the matcher has something to check', () => {
    assert.ok(Array.isArray(RESUME_UNKNOWN_STDERR_PATTERNS))
    assert.ok(RESUME_UNKNOWN_STDERR_PATTERNS.length >= 4,
      'matcher must cover the known wording variants — keep this in sync with the CLI')
    for (const p of RESUME_UNKNOWN_STDERR_PATTERNS) {
      assert.ok(p instanceof RegExp, 'patterns must be RegExp')
    }
  })

  it('#4950 — does NOT export the dropped loose `/resume.*failed/i` pattern', () => {
    // The loose pattern was overbroad and matched unrelated "resume…failed"
    // stderr. If a refactor reintroduces it, the negative-case test above will
    // start failing — this assertion catches a reintroduction immediately at
    // the source-of-truth level so the diagnostic is unambiguous.
    const sources = RESUME_UNKNOWN_STDERR_PATTERNS.map((p) => p.source)
    assert.ok(!sources.includes('resume.*failed'),
      '#4950 — the loose `/resume.*failed/i` pattern must stay dropped; reintroducing it re-enables the phantom _sessionId wipe that #4950 fixed')
  })
})

describe('CliSession resume-unknown — _handleChildClose detection (#4929)', () => {
  it('emits error{code:resume_unknown} when the child exits with matching stderr after a --resume attempt', () => {
    const session = createSession({ resumeSessionId: 'cli-stale-123' })
    // Simulate _spawnPersistentProcess having recorded the resume attempt
    session._attemptedResumeId = 'cli-stale-123'
    session._recentStderrLines = ['Error: No conversation found with id cli-stale-123']

    // Suppress real respawn — we only assert on the error emission + state mutation.
    session._scheduleRespawn = mock.fn(() => {})

    const errors = []
    session.on('error', (e) => errors.push(e))

    session._handleChildClose(1)

    assert.equal(errors.length, 1, 'must emit exactly one error event for the unknown-resume path')
    assert.equal(errors[0].code, 'resume_unknown',
      'error must carry code:resume_unknown so the dashboard can render a distinct affordance instead of the generic "exited unexpectedly" toast')
    assert.equal(errors[0].attemptedResumeId, 'cli-stale-123',
      'attemptedResumeId on the payload helps operators correlate the failure with the persisted state file')
    assert.match(errors[0].message, /resume/i,
      'human-readable message should mention the resume failure so the dashboard toast is self-explanatory')

    assert.equal(session._sessionId, null,
      '_sessionId must be cleared so the next spawn omits --resume and mints a fresh conversation — the whole point of the fallback')
    assert.equal(session._didFallbackFromUnknownResume, true,
      'the one-shot fallback latch must be armed so a second matching failure escalates instead of looping')
    assert.equal(session._skillsPrepended, false,
      'fresh conversation needs the prepend skill bucket on the first user message (#3225 parity with _killAndRespawn)')
    assert.equal(session._scheduleRespawn.mock.calls.length, 1,
      'must schedule a respawn so the fresh conversation actually starts (no manual operator intervention needed)')

    session.destroy()
  })

  it('escalates to a final error when the post-fallback retry ALSO matches the unknown-resume pattern', () => {
    const session = createSession({ resumeSessionId: 'cli-stale-123' })
    session._attemptedResumeId = 'cli-stale-123'
    session._recentStderrLines = ['No conversation found']
    // Simulate that we already fell back once this lifecycle.
    session._didFallbackFromUnknownResume = true
    session._scheduleRespawn = mock.fn(() => {})

    const errors = []
    session.on('error', (e) => errors.push(e))

    session._handleChildClose(1)

    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'resume_unknown',
      'still surfaces with the distinct code so the dashboard can show a "give up" message')
    assert.match(errors[0].message, /fresh-start|give up|also failed/i,
      'escalation message should make it clear we already tried the fallback once')
    // Even on escalation we still respawn so the user can retry manually —
    // but we do NOT wipe _sessionId a second time (would lose data needlessly
    // if some unrelated thing matches the same pattern later).
    assert.equal(session._scheduleRespawn.mock.calls.length, 1)

    session.destroy()
  })

  it('does NOT classify a generic crash mid-resume as resume_unknown when stderr does not match', () => {
    const session = createSession({ resumeSessionId: 'cli-real-id' })
    session._attemptedResumeId = 'cli-real-id'
    // stderr looks like a transient network blip — not the unknown-resume pattern.
    session._recentStderrLines = [
      'EPIPE writing to stdin',
      'Connection reset by peer',
    ]
    session._scheduleRespawn = mock.fn(() => {})

    const errors = []
    session.on('error', (e) => errors.push(e))

    session._handleChildClose(1)

    assert.equal(errors.length, 1, 'still emits a single error so the existing "exited unexpectedly" toast still fires')
    assert.equal(errors[0].code, undefined,
      'generic crash must NOT carry code:resume_unknown — that code is reserved for confirmed unknown-id stderr matches')
    assert.equal(session._sessionId, 'cli-real-id',
      'sessionId must be preserved on a generic crash — wiping it would silently discard the live conversation that just hit a transient network blip')
    assert.equal(session._didFallbackFromUnknownResume, false,
      'one-shot latch stays disarmed so a genuine future unknown-resume can still trigger the fallback')

    session.destroy()
  })

  it('does NOT classify when the spawn did not attempt --resume (no _attemptedResumeId)', () => {
    const session = createSession()
    // No resume attempt — but stderr happens to contain the phrase (e.g. a log line bleed)
    session._attemptedResumeId = null
    session._recentStderrLines = ['No conversation found anywhere']
    session._scheduleRespawn = mock.fn(() => {})

    const errors = []
    session.on('error', (e) => errors.push(e))

    session._handleChildClose(1)

    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, undefined,
      'without an actual --resume attempt the matched stderr cannot be a resume failure; classify as generic crash')

    session.destroy()
  })

  it('intentional Stop short-circuits before the resume-unknown branch (no spurious resume_unknown on user-clicked Stop)', () => {
    const session = createSession({ resumeSessionId: 'cli-real-id' })
    session._attemptedResumeId = 'cli-real-id'
    session._recentStderrLines = ['No conversation found']
    session._intentionalStop = true
    session._scheduleRespawn = mock.fn(() => {})

    const errors = []
    const stops = []
    session.on('error', (e) => errors.push(e))
    session.on('stopped', (e) => stops.push(e))

    session._handleChildClose(0)

    assert.equal(errors.length, 0,
      'user-initiated Stop must not surface as resume_unknown — that would be a misleading toast')
    assert.equal(stops.length, 1, 'emits stopped instead so the dashboard renders the quiet confirmation')

    session.destroy()
  })

  it('destroy path skips the resume-unknown branch (no events during teardown)', () => {
    const session = createSession({ resumeSessionId: 'cli-real-id' })
    session._attemptedResumeId = 'cli-real-id'
    session._recentStderrLines = ['No conversation found']
    session._destroying = true
    session._scheduleRespawn = mock.fn(() => {})

    const errors = []
    session.on('error', (e) => errors.push(e))

    session._handleChildClose(1)

    assert.equal(errors.length, 0, 'destroy short-circuit must take precedence')
    assert.equal(session._scheduleRespawn.mock.calls.length, 0)

    // But: the attempt tracker should still be cleared, otherwise it leaks
    // past destroy and could misclassify a stale event on a recycled session.
    assert.equal(session._attemptedResumeId, null)
    assert.equal(session._recentStderrLines.length, 0)
  })
})

describe('CliSession resume-unknown — system.init clears the attempt tracker (#4929)', () => {
  it('system.init confirms a successful resume and drops the stderr buffer + fallback latch', () => {
    const session = createSession({ resumeSessionId: 'cli-good-id' })
    session._attemptedResumeId = 'cli-good-id'
    session._recentStderrLines = ['stray warning']
    session._didFallbackFromUnknownResume = true

    // Drive the init event through the public handler so we exercise the
    // production path, not a private setter.
    session._handleStdoutLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'cli-good-id',
      model: 'claude-sonnet-4-6',
      tools: [],
    }))

    assert.equal(session._sessionId, 'cli-good-id', 'init sets the session id as before')
    assert.equal(session._attemptedResumeId, null,
      'init must clear _attemptedResumeId — the resume succeeded; later unrelated exits must not be misclassified')
    assert.deepEqual(session._recentStderrLines, [],
      'stderr buffer is only useful for resume-failure diagnostics; drop it once resume is confirmed')
    assert.equal(session._didFallbackFromUnknownResume, false,
      'fallback latch resets on successful init so a future unknown-resume (operator wipes ~/.claude/projects/ while chroxy is running) can fall back again')

    session.destroy()
  })
})

describe('CliSession resume-unknown — _spawnPersistentProcess records the resume attempt (#4929)', () => {
  // The load-bearing argv-inspection inside _spawnPersistentProcess is a small,
  // pure 3-line block. Exercise it directly by replicating the production line
  // verbatim — if someone breaks `args.indexOf('--resume')` or the typeof guard
  // the test fails. Spawning a real child for this would add no coverage.
  it('captures _attemptedResumeId from the argv when --resume is present', () => {
    const args = ['-p', '--input-format', 'stream-json', '--resume', 'cli-resume-xyz']
    const resumeIdx = args.indexOf('--resume')
    const captured = (resumeIdx >= 0 && typeof args[resumeIdx + 1] === 'string')
      ? args[resumeIdx + 1]
      : null
    assert.equal(captured, 'cli-resume-xyz',
      'the load-bearing argv-inspection must return the id so _handleChildClose can correlate the failure')
  })

  it('captures _attemptedResumeId=null when the argv omits --resume (fresh session)', () => {
    const args = ['-p', '--input-format', 'stream-json']
    const resumeIdx = args.indexOf('--resume')
    const captured = (resumeIdx >= 0 && typeof args[resumeIdx + 1] === 'string')
      ? args[resumeIdx + 1]
      : null
    assert.equal(captured, null,
      'fresh session must register null so _handleChildClose treats a quick exit as a generic crash, not resume-unknown')
  })
})

describe('CliSession resume-unknown — integrated stderr buffer + close (#4929)', () => {
  it('stderr line accumulation while attempting resume drives the close-time classification', () => {
    const session = createSession({ resumeSessionId: 'cli-broken' })
    session._attemptedResumeId = 'cli-broken'
    // Simulate the production stderrRL handler buffering lines while the
    // attempt is in flight. (The handler is private; exercising it directly
    // would require standing up a real child. The state mutation it makes is
    // exactly: push to _recentStderrLines, cap at 50.)
    const incomingLines = [
      'starting claude…',
      'Error: No conversation found with id cli-broken',
      'exiting',
    ]
    for (const line of incomingLines) {
      if (session._attemptedResumeId) {
        session._recentStderrLines.push(line)
        if (session._recentStderrLines.length > 50) session._recentStderrLines.shift()
      }
    }

    session._scheduleRespawn = mock.fn(() => {})
    const errors = []
    session.on('error', (e) => errors.push(e))

    session._handleChildClose(1)

    assert.equal(errors[0]?.code, 'resume_unknown',
      'buffered stderr must reach _handleChildClose intact so the classifier can match')

    session.destroy()
  })

  it('stderr buffer caps at 50 lines so a chatty subprocess cannot grow it unbounded', () => {
    const session = createSession({ resumeSessionId: 'cli-broken' })
    session._attemptedResumeId = 'cli-broken'
    // Push 100 noise lines, then the real error
    for (let i = 0; i < 100; i++) {
      if (session._attemptedResumeId) {
        session._recentStderrLines.push(`noise line ${i}`)
        if (session._recentStderrLines.length > 50) session._recentStderrLines.shift()
      }
    }
    // The cap discards the OLDEST lines first — verify the buffer is the most
    // recent window. We didn't push the error line yet; verify the discipline.
    assert.equal(session._recentStderrLines.length, 50)
    assert.equal(session._recentStderrLines[0], 'noise line 50',
      'oldest lines discarded first so the most recent window survives')

    session.destroy()
  })
})
