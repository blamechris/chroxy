import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { dirname } from 'path'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { transcriptPathForSessionFile } from '../src/transcript-tasks.js'

/**
 * #7327 — claude-tui (the default provider) never populated `bootedModel`,
 * so the dashboard's model badge/header stayed blank for every session that
 * didn't specify an explicit `model` override. Unlike cli-session/sdk-session
 * (which learn their booted model from the CLI/SDK's own structured init
 * event), claude-tui is a PTY-driven TUI with no such event — the ONLY place
 * the running model appears at all is `message.model` on the session's own
 * transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`).
 *
 * These tests drive the real `getBackgroundTaskSnapshot` / `_adoptObservedModel`
 * / `_refreshObservedModel` / `_clearTurnEndState` wiring against a fixture
 * per-PID session file + transcript under a temp HOME, mirroring the pattern
 * `claude-tui-session.test.js`'s "readiness probe" describe block uses for
 * `~/.claude/sessions/<pid>.json`.
 *
 * A dedicated file rather than adding to the already-huge
 * claude-tui-session.test.js, matching claude-tui-session-spawn-gate.test.js
 * / claude-tui-session-paste-heuristic.test.js's precedent.
 */

// Snapshot BEFORE any test touches it (mirrors claude-tui-session.test.js's
// own __sandboxConfigDir capture) so it can be restored exactly.
const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

describe('ClaudeTuiSession — observed model from the transcript (#7327)', () => {
  let fakeHome
  let origHome
  let fakePid
  let fakeCwd
  let session
  let skillsDir

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-model-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    origHome = process.env.HOME
    process.env.HOME = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    // Any positive integer — the probe only uses it to build a file path.
    fakePid = 8888
    // Never touched as a real path — only encoded into the fixture
    // transcript's directory slug (both by the fixture writer below and by
    // the code under test, via the SAME transcriptPathForSessionFile call),
    // so it need not exist. join()/tmpdir() keeps it Windows-safe.
    fakeCwd = join(tmpdir(), 'chroxy-7327-fake-cwd')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-model-skills-'))
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } }
    session = null
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    if (skillsDir) rmSync(skillsDir, { recursive: true, force: true })
  })

  /** Write the per-PID session file the readiness probe (and this feature) resolve the transcript from. */
  function writeSessFile(pid, sessionId, cwd = fakeCwd) {
    const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
    writeFileSync(path, JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() }))
    return path
  }

  /** Write (or append to) the fixture transcript derived from a session file, creating its directory. */
  function writeJournal(sessFile, lines) {
    const transcriptPath = transcriptPathForSessionFile(sessFile)
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, lines.map((l) => l + '\n').join(''))
    return transcriptPath
  }

  function appendJournal(transcriptPath, lines) {
    appendFileSync(transcriptPath, lines.map((l) => l + '\n').join(''))
  }

  function assistantLine(model, { text = 'ok', ts = '2026-06-10T02:39:05.423Z' } = {}) {
    const message = { role: 'assistant', content: [{ type: 'text', text }] }
    if (model !== undefined) message.model = model
    return JSON.stringify({ type: 'assistant', timestamp: ts, message })
  }

  function makeSession(ctorOpts = {}) {
    const s = new ClaudeTuiSession({ cwd: fakeCwd, skillsDir, repoSkillsDir: null, ...ctorOpts })
    s.on('error', () => {})
    session = s
    return s
  }

  it('sets bootedModel from an assistant entry and re-emits ready (the CliSession/SdkSession event path)', () => {
    const s = makeSession()
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    s._sessionId = 'uuid-observed-1'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine('claude-sonnet-5')])

    const readyEvents = []
    s.on('ready', (d) => readyEvents.push(d))

    assert.equal(s.bootedModel, null, 'precondition: unobserved')
    s._clearTurnEndState()

    assert.equal(s.bootedModel, 'claude-sonnet-5', 'bootedModel set from the transcript observation')
    assert.equal(readyEvents.length, 1, 'a fresh ready was emitted so event-normalizer recomputes model_changed')
    assert.equal(readyEvents[0].sessionId, 'uuid-observed-1')
  })

  it('updates bootedModel and re-emits ready when a later entry reports a different model (/model mid-session)', () => {
    const s = makeSession()
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    s._sessionId = 'uuid-observed-2'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    const transcriptPath = writeJournal(sessFile, [assistantLine('claude-sonnet-5', { ts: '2026-06-10T02:39:00.000Z' })])

    const readyEvents = []
    s.on('ready', (d) => readyEvents.push(d))

    s._clearTurnEndState()
    assert.equal(s.bootedModel, 'claude-sonnet-5')
    assert.equal(readyEvents.length, 1)

    appendJournal(transcriptPath, [assistantLine('claude-opus-5', { ts: '2026-06-10T02:40:00.000Z' })])
    s._clearTurnEndState()

    assert.equal(s.bootedModel, 'claude-opus-5', 'bootedModel follows the newer observation')
    assert.equal(readyEvents.length, 2, 'the change re-emitted ready a second time')
  })

  it('a turn ending with no new observation does not re-broadcast ready (no spurious traffic)', () => {
    const s = makeSession()
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    s._sessionId = 'uuid-stable'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine('claude-sonnet-5')])

    const readyEvents = []
    s.on('ready', (d) => readyEvents.push(d))

    s._clearTurnEndState()
    s._clearTurnEndState()
    s._clearTurnEndState()

    assert.equal(s.bootedModel, 'claude-sonnet-5')
    assert.equal(readyEvents.length, 1, 'only the FIRST turn-end actually changed bootedModel')
  })

  it('ignores the synthetic placeholder — bootedModel stays null, nothing is emitted', () => {
    const s = makeSession()
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    s._sessionId = 'uuid-synthetic'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine('<synthetic>', { text: 'API Error: 529 Overloaded' })])

    const readyEvents = []
    s.on('ready', (d) => readyEvents.push(d))

    s._clearTurnEndState()

    assert.equal(s.bootedModel, null, 'a synthetic entry must never be reported as an observation')
    assert.equal(readyEvents.length, 0, 'no observation landed, so no ready was emitted')
  })

  it('ignores a missing model field', () => {
    const s = makeSession()
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    s._sessionId = 'uuid-missing-model'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine(undefined)])

    s._clearTurnEndState()

    assert.equal(s.bootedModel, null)
  })

  it('a configured model option does NOT populate bootedModel before an observation (never dress up the request as an observation)', () => {
    // The session was created with an explicit model override, but the
    // transcript has nothing yet (no journal file at all — e.g. the very
    // first turn hasn't finished). bootedModel must stay null: only a real
    // transcript observation may set it, never `this.model`.
    const s = makeSession({ model: 'claude-opus-5' })
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    s._sessionId = 'uuid-configured'
    writeSessFile(fakePid, s._sessionId) // session file exists; no journal written

    assert.equal(s.model, 'claude-opus-5', 'precondition: configured model is set')
    s._clearTurnEndState()

    assert.equal(s.bootedModel, null, 'bootedModel must never be derived from this.model')
  })

  it('degrades silently (no throw, bootedModel unchanged) when there is no PTY pid yet', () => {
    const s = makeSession()
    // No s._term set at all — matches a session that hasn't spawned.
    assert.doesNotThrow(() => s._clearTurnEndState())
    assert.equal(s.bootedModel, null)
  })

  it('feeds the same model||bootedModel fallback session-manager/event-normalizer read (#3691 chain)', () => {
    // #3691 (session-info-booted-model.test.js) already pins the generic
    // `session.model || session.bootedModel || null` fallback used by
    // session-manager's listSessions and ws-history's sendSessionInfo. This
    // test only confirms claude-tui actually populates the field that chain
    // reads — the fallback logic itself is not re-tested here.
    const s = makeSession()
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    s._sessionId = 'uuid-list'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine('claude-sonnet-5')])

    s._clearTurnEndState()

    const reported = s.model || s.bootedModel || null
    assert.equal(reported, 'claude-sonnet-5')
  })
})
