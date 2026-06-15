// #5835 Phase 1: the claude-tui live-mirror coalescer. Unit-tests the
// _feedTerminalMirror → _flushTerminalMirror → terminal_output emit path and
// _clearTerminalMirror teardown WITHOUT spawning a PTY (the coalescer is pure
// buffer + timer + emit). Timers are faked so the 50ms flush is deterministic.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

function makeSession() {
  const skillsDir = mkdtempSync(join(tmpdir(), 'tui-mirror-skills-'))
  return new ClaudeTuiSession({ cwd: '/tmp', port: 0, skillsDir, repoSkillsDir: null })
}

test('coalesces onData chunks into one terminal_output flush per tick', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const s = makeSession()
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
