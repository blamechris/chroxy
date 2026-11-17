import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession, reportInputAdmission } from '../src/base-session.js'
import { buildSessionCiWatcher, DEFAULT_MAX_CONSECUTIVE_WAKES } from '../src/session-ci-watcher.js'

/**
 * #8326 — the wake -> push -> CI -> wake loop is bounded: after N consecutive
 * daemon wakes with no user-typed input between, the next is refused with
 * `wake-cap` while the push notification still goes out. Driven end to end
 * through the real SessionManager refusal seam and the real watcher builder.
 *
 * CRITICAL: every SessionManager here uses a temp stateFilePath (#4633).
 */

let tmpDir
function tmpStateFile() {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'ci-wake-cap-'))
  return join(tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

class SdkLikeSession extends BaseSession {
  static get capabilities() { return { daemonTurnInput: true } }
  constructor(opts = {}) {
    super({ cwd: '/tmp', ...opts })
    this.sent = []
  }
  sendMessage(prompt, attachments, sendOptions = {}) {
    this.sent.push(prompt)
    reportInputAdmission(sendOptions, { status: 'accepted', delivery: 'dispatch_started' })
  }
}

// claude-tui shape: the PTY route returns 'injected' synchronously and never
// reports admission (#8326 review: the cap used to count only via onAdmission).
class TuiLikeSession {
  static isClaudeTui = true
  constructor() { this.isRunning = false; this.writes = [] }
  writeTerminalInput(data) { this.writes.push(data); return true }
}

const sha = (n) => String(n).padStart(40, 'a')
const snap = (head, state) => ({
  sessionId: 's1',
  generatedAt: '2026-11-16T00:00:00.000Z',
  branch: 'fix/x',
  repo: { owner: 'blamechris', name: 'chroxy' },
  pr: { number: 1, title: 't', url: 'https://github.com/blamechris/chroxy/pull/1', headRefOid: head, isDraft: false },
  checks: state === 'pending'
    ? { state, counts: { total: 2, passed: 0, failed: 0, pending: 2, skipped: 0, unknown: 0 } }
    : { state, counts: { total: 2, passed: 0, failed: 2, pending: 0, skipped: 0, unknown: 0 } },
  merge: { mergeable: 'MERGEABLE', mergeStateStatus: null, reviewDecision: null },
  reason: null,
})

describe('consecutive daemon wake cap (#8326)', () => {
  let mgr, session, pushes, logs, current, watcher

  function build(config = {}) {
    watcher = buildSessionCiWatcher({
      config: { sessionCi: { discoveryIntervalMs: 1, ...config } },
      sessionManager: mgr,
      pushManager: { send: async (...args) => { pushes.push(args); return true } },
      logger: { debug() {}, info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
      survey: async () => current,
    })
  }
  // One failing-CI cycle on a fresh head: the run starts, then settles red.
  async function cycle(n) {
    // discoveryIntervalMs is floored to a positive value, so sleep past it
    // rather than rely on two ticks landing in different milliseconds.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
    current = snap(sha(n), 'pending')
    await pause()
    await watcher.tick()
    current = snap(sha(n), 'failure')
    await pause()
    await watcher.tick()
    // push notification is async inside; let it flush
    await new Promise((resolve) => setImmediate(resolve))
  }

  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    session = new SdkLikeSession()
    mgr._sessions.set('s1', { session, name: 'S1', cwd: '/repo' })
    pushes = []
    logs = []
  })

  it('defaults to 3', () => {
    assert.equal(DEFAULT_MAX_CONSECUTIVE_WAKES, 3)
  })

  it('refuses the wake after N consecutive daemon wakes with outcome wake-cap, and the push still goes out', async () => {
    build()
    for (let i = 1; i <= 3; i++) await cycle(i)
    assert.equal(session.sent.length, 3, 'three wakes land')
    assert.equal(pushes.length, 3)
    await cycle(4)
    assert.equal(session.sent.length, 3, 'the fourth is refused: nothing sent')
    assert.equal(mgr.getHistory('s1').filter((e) => e.messageType === 'user_input').length, 3, 'and nothing recorded')
    assert.equal(pushes.length, 4, 'the notification path is unaffected by the cap')
    assert.ok(logs.some((l) => l.includes('(wake: wake-cap)')), `outcome reported, logs: ${JSON.stringify(logs)}`)
  })

  it('honours sessionCi.maxConsecutiveWakes', async () => {
    build({ maxConsecutiveWakes: 1 })
    await cycle(1)
    await cycle(2)
    assert.equal(session.sent.length, 1)
    assert.equal(pushes.length, 2)
  })

  it('user-typed input (recordUserIntent) resets the count', async () => {
    build()
    for (let i = 1; i <= 3; i++) await cycle(i)
    mgr.recordUserIntent('s1')
    await cycle(4)
    assert.equal(session.sent.length, 4, 'a wake lands again after the user typed')
  })

  it('a daemon input does not reset the count', async () => {
    build()
    for (let i = 1; i <= 3; i++) await cycle(i)
    mgr.noteDaemonWake('s1')
    await cycle(4)
    assert.equal(session.sent.length, 3)
    assert.equal(mgr.daemonTurnRefusal('s1', { maxConsecutiveWakes: 3 }), 'wake-cap')
  })

  it('counts per session, and forgets a removed session', () => {
    mgr._sessions.set('s2', { session: new SdkLikeSession(), name: 'S2', cwd: '/repo' })
    for (let i = 0; i < 3; i++) mgr.noteDaemonWake('s1')
    assert.equal(mgr.daemonTurnRefusal('s1', { maxConsecutiveWakes: 3 }), 'wake-cap')
    assert.equal(mgr.daemonTurnRefusal('s2', { maxConsecutiveWakes: 3 }), null)
    mgr._cleanupSessionMaps('s1')
    assert.equal(mgr._daemonWakeCount.has('s1'), false)
  })

  it('is opt-in per call: no cap option means no cap', () => {
    for (let i = 0; i < 10; i++) mgr.noteDaemonWake('s1')
    assert.equal(mgr.daemonTurnRefusal('s1'), null)
  })

  it('ranks after budget-paused and user-stopped, before the provider reason', () => {
    for (let i = 0; i < 3; i++) mgr.noteDaemonWake('s1')
    session.daemonTurnRefusal = () => 'not-started'
    assert.equal(mgr.daemonTurnRefusal('s1', { maxConsecutiveWakes: 3 }), 'wake-cap')
    mgr.recordUserInterrupt('s1')
    assert.equal(mgr.daemonTurnRefusal('s1', { maxConsecutiveWakes: 3 }), 'user-stopped')
  })

  describe('claude-tui PTY route (#8326 review)', () => {
    beforeEach(() => {
      session = new TuiLikeSession()
      mgr._sessions.set('s1', { session, name: 'S1', cwd: '/repo' })
    })

    it('reaches wake-cap after N PTY wakes, push still sent, and resets on user input', async () => {
      build()
      for (let i = 1; i <= 3; i++) await cycle(i)
      assert.equal(session.writes.length, 3)
      await cycle(4)
      assert.equal(session.writes.length, 3, 'fourth PTY wake refused')
      assert.equal(pushes.length, 4)
      assert.ok(logs.some((l) => l.includes('(wake: wake-cap)')))
      mgr.recordUserIntent('s1')
      await cycle(5)
      assert.equal(session.writes.length, 4, 'user input re-enables the PTY wake')
    })
  })

  it('the SDK route counts exactly once per wake (no double count with recording)', async () => {
    build()
    await cycle(1)
    await cycle(2)
    assert.equal(session.sent.length, 2)
    assert.equal(mgr._daemonWakeCount.get('s1'), 2)
  })
})
