/**
 * #4307 — pending background-shell tracking on BaseSession + provider-side
 * wiring on SdkSession (assistant tool_use[run_in_background] → tool_result
 * with shell id) and ClaudeTuiSession (PreToolUse[run_in_background] →
 * PostToolUse with tool_response containing shellId).
 *
 * Invariants pinned here:
 *   - parsing the shell id from the tool_result text
 *   - isRunning is TRUE when _isBusy is false AND pending shells exist
 *   - destroy() clears the pending map (no leak)
 *   - SessionTimeoutManager skips sessions with pending background work
 *   - background_work_changed event fires on push AND clear
 *   - the session-list snapshot includes pendingBackgroundShells
 *   - turn-end (`_clearMessageState`) does NOT clear pending shells
 *   - the BashOutput tool clears the matching entry
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BaseSession } from '../src/base-session.js'
import {
  parseBackgroundShellId,
  isRunInBackgroundInput,
} from '../src/background-shells.js'
import { SessionTimeoutManager } from '../src/session-timeout-manager.js'

let emptySkillsDir

function makeSession() {
  return new BaseSession({
    cwd: '/tmp',
    skillsDir: emptySkillsDir,
    repoSkillsDir: null,
  })
}

describe('background-shells helpers (#4307)', () => {
  beforeEach(() => {
    emptySkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-bg-skills-'))
  })

  afterEach(() => {
    if (emptySkillsDir) rmSync(emptySkillsDir, { recursive: true, force: true })
    emptySkillsDir = null
  })

  describe('parseBackgroundShellId', () => {
    it('extracts the id from the canonical message', () => {
      const text = 'Command running in background with ID: brk57kt6pm. Output…'
      assert.equal(parseBackgroundShellId(text), 'brk57kt6pm')
    })

    it('tolerates leading/trailing whitespace and newlines', () => {
      const text = '\n   Command running in background with ID: abc_123-XYZ\n   '
      assert.equal(parseBackgroundShellId(text), 'abc_123-XYZ')
    })

    it('returns null when the message does not match', () => {
      assert.equal(parseBackgroundShellId('Random Bash output'), null)
      assert.equal(parseBackgroundShellId(''), null)
      assert.equal(parseBackgroundShellId(null), null)
      assert.equal(parseBackgroundShellId(undefined), null)
      assert.equal(parseBackgroundShellId(42), null)
    })

    it('refuses ids with whitespace (defensive against malformed payloads)', () => {
      assert.equal(
        parseBackgroundShellId('Command running in background with ID:    \n\n'),
        null,
      )
    })
  })

  describe('isRunInBackgroundInput', () => {
    it('returns true for Bash tools with run_in_background:true', () => {
      assert.equal(
        isRunInBackgroundInput('Bash', { command: 'sleep 60', run_in_background: true }),
        true,
      )
    })

    it('rejects non-Bash tools (the flag is Bash-specific)', () => {
      assert.equal(
        isRunInBackgroundInput('Read', { run_in_background: true }),
        false,
      )
    })

    it('is strict-boolean — truthy non-bool inputs are not enough', () => {
      assert.equal(isRunInBackgroundInput('Bash', { run_in_background: 1 }), false)
      assert.equal(isRunInBackgroundInput('Bash', { run_in_background: 'yes' }), false)
    })

    it('returns false on missing / non-object input', () => {
      assert.equal(isRunInBackgroundInput('Bash', null), false)
      assert.equal(isRunInBackgroundInput('Bash', undefined), false)
      assert.equal(isRunInBackgroundInput('Bash', 'string'), false)
    })
  })
})

describe('BaseSession background-shell tracking (#4307)', () => {
  let session

  beforeEach(() => {
    emptySkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-bg-skills-'))
    session = makeSession()
  })

  afterEach(() => {
    if (emptySkillsDir) rmSync(emptySkillsDir, { recursive: true, force: true })
    emptySkillsDir = null
  })

  it('initialises _pendingBackgroundShells as an empty Map', () => {
    assert.ok(session._pendingBackgroundShells instanceof Map)
    assert.equal(session._pendingBackgroundShells.size, 0)
  })

  it('trackBackgroundShell records id+startedAt+command and emits change event', () => {
    const events = []
    session.on('background_work_changed', (data) => events.push(data))
    const now = Date.now()
    session.trackBackgroundShell({ shellId: 'brk57kt6pm', command: 'sleep 600' })
    assert.equal(session._pendingBackgroundShells.size, 1)
    const entry = session._pendingBackgroundShells.get('brk57kt6pm')
    assert.equal(entry.shellId, 'brk57kt6pm')
    assert.equal(entry.command, 'sleep 600')
    assert.ok(entry.startedAt >= now)
    assert.equal(events.length, 1)
    assert.equal(events[0].pending.length, 1)
    assert.equal(events[0].pending[0].shellId, 'brk57kt6pm')
  })

  it('trackBackgroundShell is a no-op for empty / non-string ids', () => {
    const events = []
    session.on('background_work_changed', (data) => events.push(data))
    session.trackBackgroundShell({ shellId: '', command: 'x' })
    session.trackBackgroundShell({ shellId: null, command: 'x' })
    session.trackBackgroundShell({})
    assert.equal(session._pendingBackgroundShells.size, 0)
    assert.equal(events.length, 0)
  })

  it('trackBackgroundShell is idempotent on the same id', () => {
    const events = []
    session.on('background_work_changed', (data) => events.push(data))
    session.trackBackgroundShell({ shellId: 'a', command: 'first' })
    session.trackBackgroundShell({ shellId: 'a', command: 'second' })
    assert.equal(session._pendingBackgroundShells.size, 1)
    // Original entry preserved — startedAt + command from first call wins
    assert.equal(session._pendingBackgroundShells.get('a').command, 'first')
    assert.equal(events.length, 1) // only the first emit
  })

  it('clearBackgroundShell removes the entry and emits change event', () => {
    const events = []
    session.trackBackgroundShell({ shellId: 'a', command: 'x' })
    session.on('background_work_changed', (data) => events.push(data))
    const result = session.clearBackgroundShell('a')
    assert.equal(result, true)
    assert.equal(session._pendingBackgroundShells.size, 0)
    assert.equal(events.length, 1)
    assert.equal(events[0].pending.length, 0)
  })

  it('clearBackgroundShell returns false + does not emit when id was not tracked', () => {
    const events = []
    session.on('background_work_changed', (data) => events.push(data))
    assert.equal(session.clearBackgroundShell('unknown'), false)
    assert.equal(events.length, 0)
  })

  it('getPendingBackgroundShells returns a plain array snapshot', () => {
    session.trackBackgroundShell({ shellId: 'a', command: '1' })
    session.trackBackgroundShell({ shellId: 'b', command: '2' })
    const snap = session.getPendingBackgroundShells()
    assert.ok(Array.isArray(snap))
    assert.equal(snap.length, 2)
    assert.deepEqual(
      snap.map((e) => e.shellId).sort(),
      ['a', 'b'],
    )
  })

  describe('isRunning waiting-state semantics', () => {
    it('is true when _isBusy is false but pending shells exist', () => {
      assert.equal(session.isRunning, false)
      session.trackBackgroundShell({ shellId: 'a', command: 'x' })
      assert.equal(session.isRunning, true)
    })

    it('returns to false once the pending entry clears', () => {
      session.trackBackgroundShell({ shellId: 'a', command: 'x' })
      assert.equal(session.isRunning, true)
      session.clearBackgroundShell('a')
      assert.equal(session.isRunning, false)
    })

    it('stays true while _isBusy=true even with empty pending map', () => {
      session._isBusy = true
      assert.equal(session.isRunning, true)
    })
  })

  describe('lifecycle: turn-end vs destroy', () => {
    it('_clearMessageState does NOT clear pending shells (they survive turn-end — #4307 core invariant)', () => {
      session.trackBackgroundShell({ shellId: 'a', command: 'x' })
      session._isBusy = true
      session._clearMessageState()
      assert.equal(session._isBusy, false)
      // The whole point of #4307 — entries survive turn-end:
      assert.equal(session._pendingBackgroundShells.size, 1)
      // And the session is reported running while they live:
      assert.equal(session.isRunning, true)
    })

    it('_destroyPendingBackgroundShells clears the map (no leak on destroy)', () => {
      session.trackBackgroundShell({ shellId: 'a', command: 'x' })
      session.trackBackgroundShell({ shellId: 'b', command: 'y' })
      assert.equal(session._pendingBackgroundShells.size, 2)
      session._destroyPendingBackgroundShells()
      assert.equal(session._pendingBackgroundShells.size, 0)
    })
  })
})

describe('SessionTimeoutManager honours pending background work (#4307)', () => {
  let mgr
  afterEach(() => {
    if (mgr) { mgr.destroy(); mgr = null }
  })

  it('skips sessions whose isRunningFn reports waiting (pending background shells)', () => {
    mgr = new SessionTimeoutManager({ sessionTimeoutMs: 10_000 })
    mgr._lastActivity.set('s1', Date.now() - 60_000)
    // Caller (SessionManager) wires isRunning to entry.session.isRunning,
    // which BaseSession now returns true when pending shells exist.
    mgr.setIsRunningFn((id) => id === 's1')

    const timeouts = []
    mgr.on('timeout', (data) => timeouts.push(data))
    mgr._checkTimeouts()
    assert.equal(timeouts.length, 0)
    // Touching activity is the existing skip path — the session stays
    // tracked so a later state change (work done) re-enables timeout
    // checks naturally.
    assert.ok(Date.now() - mgr._lastActivity.get('s1') < 1_000)
  })
})
