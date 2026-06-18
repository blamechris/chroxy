import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UserShellSession } from '../src/user-shell-session.js'
import { getProvider, validateProviderClass } from '../src/providers.js'

/**
 * #5983 (epic #5982) — UserShellSession: a PTY-only $SHELL session. These tests
 * exercise the terminal surface + lifecycle WITHOUT spawning a real shell (a
 * fake PTY is injected as `_term`). start()'s real node-pty spawn is covered by
 * the provider-registration contract + manual/integration testing.
 */

function makeFakeTerm() {
  const calls = { write: [], resize: [], kill: [] }
  return {
    pid: 4242,
    write(data) { calls.write.push(data) },
    resize(c, r) { calls.resize.push([c, r]) },
    kill(sig) { calls.kill.push(sig) },
    onData() {},
    onExit() {},
    on() {},
    _calls: calls,
  }
}

// Build a session with a live injected PTY, skipping the real spawn.
function makeLiveShell() {
  const s = new UserShellSession({ cwd: '/tmp' })
  s._term = makeFakeTerm()
  s._shellAlive = true
  return s
}

describe('UserShellSession — class contract (#5983)', () => {
  it('is registered as the user-shell provider and passes the interface check', () => {
    assert.equal(getProvider('user-shell'), UserShellSession)
    assert.doesNotThrow(() => validateProviderClass(UserShellSession, 'user-shell'))
  })

  it('declares isUserShell=true and isClaudeTui=false (gates + mailbox fence)', () => {
    assert.equal(UserShellSession.isUserShell, true)
    assert.equal(UserShellSession.isClaudeTui, false, 'must NOT be a mailbox-injection / isTui target')
  })

  it('has PTY-only capabilities (no Claude semantics)', () => {
    const c = UserShellSession.capabilities
    assert.equal(c.terminal, true)
    assert.equal(c.tools, false)
    assert.equal(c.permissions, false)
    assert.equal(c.streaming, false)
    assert.equal(c.resume, false)
  })

  it('fixes provider to user-shell via the opt picker', () => {
    const s = new UserShellSession({ cwd: '/tmp', model: 'ignored' })
    assert.equal(s._provider, 'user-shell')
  })

  it('sendMessage / interrupt are inert no-ops (no turns)', () => {
    const s = new UserShellSession({ cwd: '/tmp' })
    assert.equal(s.sendMessage('hi'), false)
    assert.equal(s.interrupt(), false)
  })
})

describe('UserShellSession — terminal surface (#5983)', () => {
  it('writeTerminalInput writes to a live PTY and no-ops on a dead one', () => {
    const s = makeLiveShell()
    assert.equal(s.writeTerminalInput('ls\r'), true)
    assert.deepEqual(s._term._calls.write, ['ls\r'])
    assert.equal(s.writeTerminalInput(''), false, 'empty data is a no-op')

    s._ptyExited = true
    assert.equal(s.writeTerminalInput('x'), false, 'no write after exit')
  })

  it('resizeTerminal clamps, applies, and emits terminal_resize; no-op on unchanged', () => {
    const s = makeLiveShell()
    const events = []
    s.on('terminal_resize', (d) => events.push(d))

    const applied = s.resizeTerminal(100, 40)
    assert.deepEqual(applied, { cols: 100, rows: 40 })
    assert.deepEqual(s._term._calls.resize.at(-1), [100, 40])
    assert.deepEqual(events.at(-1), { cols: 100, rows: 40 })
    assert.deepEqual(s.getTerminalSize(), { cols: 100, rows: 40 })

    assert.equal(s.resizeTerminal(100, 40), null, 'unchanged size is a no-op')
    assert.equal(s.resizeTerminal('x', 'y'), null, 'NaN is rejected, never reaches _term.resize')
  })

  it('coalesces PTY bytes into one terminal_output, gated on an active mirror', () => {
    const s = makeLiveShell()
    const out = []
    s.on('terminal_output', (d) => out.push(d.data))

    // Mirror inactive → no coalescing work, nothing emitted.
    s._feedTerminalMirror('ignored')
    s._flushTerminalMirror()
    assert.equal(out.length, 0)

    s.setTerminalMirrorActive(true)
    s._feedTerminalMirror('foo')
    s._feedTerminalMirror('bar')
    s._flushTerminalMirror()
    assert.deepEqual(out, ['foobar'], 'bytes coalesced into one frame')

    // Turning the mirror off drops any buffered bytes (nobody watching).
    s._feedTerminalMirror('dropped')
    s.setTerminalMirrorActive(false)
    s._flushTerminalMirror()
    assert.deepEqual(out, ['foobar'], 'buffer cleared on mirror-off, no trailing flush')
  })
})

describe('UserShellSession — lifecycle (#5983)', () => {
  it('isRunning reflects PTY liveness', () => {
    const s = new UserShellSession({ cwd: '/tmp' })
    assert.equal(s.isRunning, false, 'no PTY yet')
    s._shellAlive = true
    assert.equal(s.isRunning, true)
  })

  it('_onShellExit is idempotent, flips isRunning off, and emits a final marker — NO respawn', () => {
    const s = makeLiveShell()
    s.setTerminalMirrorActive(true)
    const out = []
    s.on('terminal_output', (d) => out.push(d.data))

    s._onShellExit({ exitCode: 0 }, 'exit')
    assert.equal(s.isRunning, false)
    assert.equal(s._ptyExited, true)
    assert.equal(out.length, 1)
    assert.match(out[0], /shell exited/)

    // Idempotent: a second exit signal (close/error firing after onExit) is a no-op.
    s._onShellExit(null, 'close')
    assert.equal(out.length, 1, 'no duplicate marker')
    // No respawn machinery exists — _term is left for destroy() to reap.
    assert.equal(typeof s.start, 'function')
  })

  it('destroy SIGTERMs the live PTY, clears timers, and stops being runnable', () => {
    const s = makeLiveShell()
    const term = s._term
    s.destroy()
    assert.deepEqual(term._calls.kill, ['SIGTERM'])
    assert.equal(s._destroying, true)
    assert.equal(s._shellAlive, false)
    assert.equal(s._term, null)
    assert.equal(s._mirrorTimer, null)
  })

  it('destroy after exit does not double-kill', () => {
    const s = makeLiveShell()
    const term = s._term
    s._onShellExit({ exitCode: 0 }, 'exit')
    s.destroy()
    assert.equal(term._calls.kill.length, 0, 'no SIGTERM — PTY already exited')
  })
})
