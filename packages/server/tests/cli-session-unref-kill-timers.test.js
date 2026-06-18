import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CliSession } from '../src/cli-session.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * #6043: the destroy()/respawn/interrupt force-kill fallback timers are
 * fire-and-forget safety nets cleared only when the child emits 'close'. They
 * must be .unref()'d so a pending one never gates process exit — in tests with a
 * mock child that never emits 'close' they otherwise pin the event loop for the
 * full timeout (3s/10s/5s), which is the leak behind the #6027/#6042 teardown.
 *
 * These tests assert the actual timer objects are unref'd at runtime
 * (timer.hasRef() === false) by capturing them through a setTimeout spy, plus a
 * source-level check that the unref guard is present at each site.
 */

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(chunk, enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = mock.fn(() => true)
  child.killed = false
  return child
}

function createSession(tmpDir) {
  const stateFilePath = join(tmpDir, `state-${Math.random().toString(36).slice(2)}.json`)
  return new CliSession({ cwd: '/tmp', stateFilePath })
}

/**
 * Run `fn` with `setTimeout` patched so every armed timer is captured. Returns
 * the list of captured Timeout objects. Restores the real setTimeout after.
 */
function captureTimers(fn) {
  const captured = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (cb, ms, ...args) => {
    const t = realSetTimeout(cb, ms, ...args)
    captured.push(t)
    return t
  }
  try {
    fn()
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  return captured
}

describe('#6043 cli-session force-kill timers are unref()-d', () => {
  let tmpDir
  const sessions = []

  function newSession() {
    if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'cli-unref-'))
    const s = createSession(tmpDir)
    sessions.push(s)
    return s
  }

  afterEach(() => {
    for (const s of sessions.splice(0)) {
      s._child = null
      try { const r = s.destroy(); if (r && typeof r.catch === 'function') r.catch(() => {}) } catch {}
    }
    if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null }
  })

  it('destroy() arms a force-kill timer that does not hold the event loop open', () => {
    const session = newSession()
    // Live mock child that never emits 'close' — the exact teardown leak case.
    session._child = createMockChild()

    const timers = captureTimers(() => session.destroy())

    // The force-kill timer is the (only) one armed inside the `if (this._child)`
    // block of destroy(); it must be unref'd.
    assert.ok(timers.length >= 1, 'destroy() should arm at least one timer')
    for (const t of timers) {
      if (typeof t.unref === 'function') {
        assert.equal(t.hasRef(), false, 'destroy() force-kill timer must not ref the loop')
      }
    }
  })

  it('destroy() force-kill timer still fires force-kill if the loop is alive', async () => {
    const session = newSession()
    const child = createMockChild()
    session._child = child

    // Speed the test up: patch setTimeout used inside destroy to fire near-immediately
    // while preserving unref(). We assert the kill path runs (process is "busy").
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (cb, _ms, ...args) => realSetTimeout(cb, 5, ...args)
    try {
      session.destroy()
      await new Promise((resolve) => realSetTimeout(resolve, 40))
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    assert.ok(child.kill.mock.callCount() >= 1,
      'force-kill should still fire while the loop is otherwise alive')
  })

  it('source unref()s the destroy, respawn, and interrupt timers', () => {
    const src = readFileSync(join(__dirname, '../src/cli-session.js'), 'utf-8')
    // Three distinct unref guards expected (destroy force-kill, respawn
    // force-kill, interrupt safety) — count the issue-tagged unref pattern.
    const unrefCount = (src.match(/if \(typeof \w[\w.]*\.unref === 'function'\) [\w.]*\.unref\(\)/g) || []).length
    assert.ok(unrefCount >= 3,
      `expected >=3 unref guards in cli-session.js for #6043, found ${unrefCount}`)
    assert.ok(src.includes('#6043'), 'expected #6043 rationale comments in cli-session.js')
  })
})

describe('#6043 supervisor force-kill timers are unref()-d', () => {
  it('source unref()s the drain and shutdown force-kill timers', () => {
    const src = readFileSync(join(__dirname, '../src/supervisor.js'), 'utf-8')
    const unrefCount = (src.match(/if \(typeof \w[\w.]*\.unref === 'function'\) [\w.]*\.unref\(\)/g) || []).length
    assert.ok(unrefCount >= 2,
      `expected >=2 #6043 unref guards in supervisor.js, found ${unrefCount}`)
    assert.ok(src.includes('#6043'), 'expected #6043 rationale comments in supervisor.js')
  })
})
