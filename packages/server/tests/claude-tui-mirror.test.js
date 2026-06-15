// #5835 Phase 1: the claude-tui live-mirror coalescer. Unit-tests the
// _feedTerminalMirror → _flushTerminalMirror → terminal_output emit path and
// _clearTerminalMirror teardown WITHOUT spawning a PTY (the coalescer is pure
// buffer + timer + emit). Timers are faked so the 50ms flush is deterministic.
import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CLAUDE_TUI_PTY_SIZE } from '@chroxy/protocol'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

// Track the temp skillsDirs makeSession() mints so they don't accumulate under
// /tmp across the suite (best-effort cleanup).
const _tmpDirs = []
afterEach(() => {
  while (_tmpDirs.length) {
    try { rmSync(_tmpDirs.pop(), { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

function makeSession() {
  const skillsDir = mkdtempSync(join(tmpdir(), 'tui-mirror-skills-'))
  _tmpDirs.push(skillsDir)
  return new ClaudeTuiSession({ cwd: '/tmp', port: 0, skillsDir, repoSkillsDir: null })
}

test('coalesces onData chunks into one terminal_output flush per tick', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const s = makeSession()
    s.setTerminalMirrorActive(true) // #5837: coalescer is gated on a subscriber
    const emitted = []
    s.on('terminal_output', (e) => emitted.push(e.data))

    s._feedTerminalMirror('a')
    s._feedTerminalMirror('b')
    s._feedTerminalMirror('c')
    assert.equal(emitted.length, 0, 'nothing flushes before the timer fires')

    mock.timers.tick(ClaudeTuiSession.MIRROR_FLUSH_MS)
    assert.deepEqual(emitted, ['abc'], 'one coalesced flush of all buffered bytes')

    // Buffer + timer reset — a later chunk flushes on its own next tick.
    s._feedTerminalMirror('d')
    mock.timers.tick(ClaudeTuiSession.MIRROR_FLUSH_MS)
    assert.deepEqual(emitted, ['abc', 'd'])
  } finally {
    mock.timers.reset()
  }
})

test('preserves raw bytes (ANSI intact) — no stripping in the mirror path', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const s = makeSession()
    s.setTerminalMirrorActive(true) // #5837
    const emitted = []
    s.on('terminal_output', (e) => emitted.push(e.data))
    s._feedTerminalMirror('\x1b[?1049h\x1b[31mred\x1b[0m')
    mock.timers.tick(ClaudeTuiSession.MIRROR_FLUSH_MS)
    assert.deepEqual(emitted, ['\x1b[?1049h\x1b[31mred\x1b[0m'])
  } finally {
    mock.timers.reset()
  }
})

test('_clearTerminalMirror cancels a pending flush and drops the buffer', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const s = makeSession()
    s.setTerminalMirrorActive(true) // #5837
    const emitted = []
    s.on('terminal_output', (e) => emitted.push(e.data))
    s._feedTerminalMirror('x')
    s._clearTerminalMirror()
    mock.timers.tick(ClaudeTuiSession.MIRROR_FLUSH_MS * 2)
    assert.equal(emitted.length, 0, 'cleared before flush → nothing emitted, no leaked timer')
  } finally {
    mock.timers.reset()
  }
})

test('flush with an empty buffer is a no-op (stray flush after teardown)', () => {
  const s = makeSession()
  const emitted = []
  s.on('terminal_output', (e) => emitted.push(e.data))
  s._flushTerminalMirror()
  assert.equal(emitted.length, 0)
})

// #5837: the coalescer is gated on having a subscriber. Default OFF.

test('mirror is inactive by default — _feedTerminalMirror does no work and emits nothing', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const s = makeSession()
    const emitted = []
    s.on('terminal_output', (e) => emitted.push(e.data))
    s._feedTerminalMirror('a')
    s._feedTerminalMirror('b')
    assert.equal(s._mirrorBuffer, '', 'nothing buffered while inactive')
    assert.equal(s._mirrorTimer, null, 'no flush timer armed while inactive')
    mock.timers.tick(ClaudeTuiSession.MIRROR_FLUSH_MS)
    assert.equal(emitted.length, 0, 'no terminal_output when nobody is subscribed')
  } finally {
    mock.timers.reset()
  }
})

test('setTerminalMirrorActive(true) turns the coalescer on; (false) turns it off + drops pending', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const s = makeSession()
    const emitted = []
    s.on('terminal_output', (e) => emitted.push(e.data))

    s.setTerminalMirrorActive(true)
    s._feedTerminalMirror('hi')
    mock.timers.tick(ClaudeTuiSession.MIRROR_FLUSH_MS)
    assert.deepEqual(emitted, ['hi'], 'active → coalesces + flushes')

    // Going inactive drops any pending buffer/timer (no trailing flush for nobody).
    s._feedTerminalMirror('pending')
    s.setTerminalMirrorActive(false)
    assert.equal(s._mirrorBuffer, '', 'pending buffer dropped on deactivate')
    assert.equal(s._mirrorTimer, null, 'pending timer cleared on deactivate')
    mock.timers.tick(ClaudeTuiSession.MIRROR_FLUSH_MS)
    assert.deepEqual(emitted, ['hi'], 'nothing else flushes after deactivate')

    // And feeding while inactive again is a no-op.
    s._feedTerminalMirror('more')
    mock.timers.tick(ClaudeTuiSession.MIRROR_FLUSH_MS)
    assert.deepEqual(emitted, ['hi'])
  } finally {
    mock.timers.reset()
  }
})

test('setTerminalMirrorActive is idempotent for the same value', () => {
  const s = makeSession()
  s.setTerminalMirrorActive(true)
  // Re-asserting true must not clear an in-flight buffer.
  s._feedTerminalMirror('x')
  s.setTerminalMirrorActive(true)
  assert.equal(s._mirrorBuffer, 'x', 'same-value activate is a no-op, buffer intact')
})

// #5835 Phase 2: resize sync. resizeTerminal clamps, records the size (so it
// survives a respawn), applies it to a live PTY, and emits terminal_resize.

test('getTerminalSize defaults to the shared PTY size before any resize', () => {
  const s = makeSession()
  assert.deepEqual(s.getTerminalSize(), { cols: CLAUDE_TUI_PTY_SIZE.cols, rows: CLAUDE_TUI_PTY_SIZE.rows })
})

test('resizeTerminal records the new size, returns it, and emits terminal_resize', () => {
  const s = makeSession()
  const events = []
  s.on('terminal_resize', (e) => events.push(e))
  const applied = s.resizeTerminal(160, 48)
  assert.deepEqual(applied, { cols: 160, rows: 48 })
  assert.deepEqual(s.getTerminalSize(), { cols: 160, rows: 48 })
  assert.deepEqual(events, [{ cols: 160, rows: 48 }])
})

test('resizeTerminal drives a live PTY via _term.resize', () => {
  const s = makeSession()
  const calls = []
  s._term = { resize: (c, r) => calls.push([c, r]) }
  s._ptyExited = false
  s.resizeTerminal(100, 40)
  assert.deepEqual(calls, [[100, 40]])
})

test('resizeTerminal clamps out-of-range / non-integer dimensions', () => {
  const s = makeSession()
  assert.deepEqual(s.resizeTerminal(0, 0), { cols: 1, rows: 1 }, 'floor clamps to 1')
  assert.deepEqual(s.resizeTerminal(9999, 9999), { cols: 1000, rows: 1000 }, 'ceiling clamps to 1000')
  assert.deepEqual(s.resizeTerminal(80.9, 24.9), { cols: 80, rows: 24 }, 'floored to ints')
})

test('resizeTerminal is a no-op (null, no emit) when the size is unchanged', () => {
  const s = makeSession()
  s.resizeTerminal(120, 30)
  const events = []
  s.on('terminal_resize', (e) => events.push(e))
  const again = s.resizeTerminal(120, 30)
  assert.equal(again, null, 'unchanged size returns null so the caller skips a redundant broadcast')
  assert.equal(events.length, 0, 'no terminal_resize emitted for a no-op resize')
})

test('resizeTerminal survives a PTY-less / exited session (size still recorded)', () => {
  const s = makeSession()
  s._term = null
  const applied = s.resizeTerminal(200, 50)
  assert.deepEqual(applied, { cols: 200, rows: 50 }, 'size recorded for the next spawn even with no live PTY')
  assert.deepEqual(s.getTerminalSize(), { cols: 200, rows: 50 })
})

test('a _term.resize throw is swallowed (no crash) and the size is still recorded', () => {
  const s = makeSession()
  s._term = { resize: () => { throw new Error('pty gone') } }
  s._ptyExited = false
  const applied = s.resizeTerminal(90, 30)
  assert.deepEqual(applied, { cols: 90, rows: 30 })
  assert.deepEqual(s.getTerminalSize(), { cols: 90, rows: 30 })
})

// #5835 Phase 3: writeTerminalInput forwards raw bytes to the live PTY as-is.

test('writeTerminalInput writes raw bytes verbatim to a live PTY', () => {
  const s = makeSession()
  const writes = []
  s._term = { write: (d) => writes.push(d) }
  s._ptyExited = false
  s._destroying = false
  assert.equal(s.writeTerminalInput('a'), true)
  assert.equal(s.writeTerminalInput('\x03'), true) // Ctrl-C control byte, untransformed
  assert.equal(s.writeTerminalInput('\x1b[A'), true) // arrow-up escape sequence
  assert.deepEqual(writes, ['a', '\x03', '\x1b[A'])
})

test('writeTerminalInput is a no-op with no live PTY / after exit / during teardown', () => {
  const s = makeSession()
  s._term = null
  assert.equal(s.writeTerminalInput('x'), false)
  const writes = []
  s._term = { write: (d) => writes.push(d) }
  s._ptyExited = true
  assert.equal(s.writeTerminalInput('x'), false)
  s._ptyExited = false
  s._destroying = true
  assert.equal(s.writeTerminalInput('x'), false)
  assert.deepEqual(writes, [], 'nothing reaches a dead/exiting/tearing-down PTY')
})

test('writeTerminalInput ignores empty / non-string data', () => {
  const s = makeSession()
  const writes = []
  s._term = { write: (d) => writes.push(d) }
  s._ptyExited = false
  s._destroying = false
  assert.equal(s.writeTerminalInput(''), false)
  assert.equal(s.writeTerminalInput(undefined), false)
  assert.equal(s.writeTerminalInput(42), false)
  assert.deepEqual(writes, [])
})

test('a _term.write throw is swallowed (no crash), returns false', () => {
  const s = makeSession()
  s._term = { write: () => { throw new Error('pty gone') } }
  s._ptyExited = false
  s._destroying = false
  assert.equal(s.writeTerminalInput('x'), false)
})
