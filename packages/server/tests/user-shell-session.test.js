import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UserShellSession, resolveShell } from '../src/user-shell-session.js'
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

describe('resolveShell (#6646)', () => {
  const WIN_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

  it('POSIX: honours $SHELL when it exists', () => {
    assert.equal(
      resolveShell({ platform: 'linux', env: { SHELL: '/usr/bin/fish' }, exists: (p) => p === '/usr/bin/fish' }),
      '/usr/bin/fish',
    )
  })

  it('POSIX: falls back through zsh/bash/sh, then /bin/sh as last resort', () => {
    assert.equal(
      resolveShell({ platform: 'linux', env: {}, exists: (p) => p === '/bin/bash' }),
      '/bin/bash',
    )
    assert.equal(
      resolveShell({ platform: 'linux', env: {}, exists: () => false }),
      '/bin/sh',
    )
  })

  it('Windows: prefers Windows PowerShell 5.1 at the fixed System32 path', () => {
    assert.equal(
      resolveShell({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: (p) => p === WIN_PS }),
      WIN_PS,
    )
  })

  it('Windows: an explicit $SHELL that exists wins (pin pwsh.exe)', () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    assert.equal(
      resolveShell({ platform: 'win32', env: { SHELL: pwsh, SystemRoot: 'C:\\Windows' }, exists: (p) => p === pwsh }),
      pwsh,
    )
  })

  it('Windows: falls back to COMSPEC/cmd.exe (defaultShell) when PowerShell is absent', () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe'
    assert.equal(
      resolveShell({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', COMSPEC: cmd }, exists: () => false }),
      cmd,
    )
    assert.equal(
      resolveShell({ platform: 'win32', env: {}, exists: () => false }),
      'cmd.exe',
      'bare cmd.exe when COMSPEC is unset',
    )
  })

  it('never returns a POSIX /bin path on Windows (the #6646 spawn-failure regression)', () => {
    const resolved = resolveShell({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: (p) => p === WIN_PS })
    assert.doesNotMatch(resolved, /^\/bin\//, 'a /bin/* shell would fail node-pty spawn on Windows')
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

  it('destroy (POSIX) SIGTERMs the live PTY, clears timers, and stops being runnable', () => {
    const s = makeLiveShell()
    s._isWindowsOverride = false // force the POSIX branch regardless of test host
    const term = s._term
    s.destroy()
    assert.deepEqual(term._calls.kill, ['SIGTERM'])
    assert.equal(s._destroying, true)
    assert.equal(s._shellAlive, false)
    assert.equal(s._term, null)
    assert.equal(s._mirrorTimer, null)
  })

  it('destroy (Windows) reaps the whole tree via taskkill, no SIGTERM/grace timer (#6646)', () => {
    const s = makeLiveShell()
    s._isWindowsOverride = true // force the Windows branch regardless of test host
    const treeKills = []
    s._killProcessTree = (t, opts) => treeKills.push({ pid: t.pid, opts })
    const term = s._term
    s.destroy()
    assert.deepEqual(treeKills, [{ pid: 4242, opts: { force: true } }],
      'the whole descendant tree is force-reaped in one taskkill /T /F')
    assert.deepEqual(term._calls.kill, [], 'no direct SIGTERM/SIGKILL — the tree-kill is the teardown')
    assert.equal(s._killTimer, null, 'no POSIX grace-escalation timer on Windows')
    assert.equal(s._term, null)
    assert.equal(s._shellAlive, false)
  })

  it('_reapTerm (start destroy-race): POSIX SIGTERMs, Windows tree-kills (#6646)', () => {
    // POSIX branch — direct SIGTERM, no tree-kill.
    const posix = makeLiveShell()
    posix._isWindowsOverride = false
    const posixTree = []
    posix._killProcessTree = (t) => posixTree.push(t.pid)
    posix._reapTerm(posix._term)
    assert.deepEqual(posix._term._calls.kill, ['SIGTERM'])
    assert.equal(posixTree.length, 0, 'POSIX never tree-kills')

    // Windows branch — tree-kill, no direct signal.
    const win = makeLiveShell()
    win._isWindowsOverride = true
    const winTree = []
    win._killProcessTree = (t, opts) => winTree.push({ pid: t.pid, opts })
    win._reapTerm(win._term)
    assert.deepEqual(winTree, [{ pid: 4242, opts: { force: true } }])
    assert.deepEqual(win._term._calls.kill, [], 'Windows reaps the tree, no direct kill')

    // null term is a no-op (never reached in practice, but defensive).
    assert.doesNotThrow(() => posix._reapTerm(null))
  })

  it('destroy after exit does not double-kill (either platform)', () => {
    for (const onWindows of [false, true]) {
      const s = makeLiveShell()
      s._isWindowsOverride = onWindows
      const treeKills = []
      s._killProcessTree = (t) => treeKills.push(t.pid)
      const term = s._term
      s._onShellExit({ exitCode: 0 }, 'exit')
      s.destroy()
      assert.equal(term._calls.kill.length, 0, 'no signal — PTY already exited')
      assert.equal(treeKills.length, 0, 'no taskkill — PTY already exited')
    }
  })

  describe('_buildShellEnv secret stripping (#6311)', () => {
    it('strips the primary API_TOKEN from the shell PTY env', () => {
      const prev = process.env.API_TOKEN
      process.env.API_TOKEN = 'primary-bearer-token'
      try {
        const s = new UserShellSession({ cwd: '/tmp' })
        const env = s._buildShellEnv()
        assert.equal(env.API_TOKEN, undefined,
          'the full-authority API_TOKEN must never reach the interactive shell env')
        assert.equal(env.TERM, 'xterm-256color', 'TERM is forced for the PTY')
        assert.equal(env.PATH, process.env.PATH,
          'the operator process env still passes through (it is their shell), minus secrets')
      } finally {
        if (prev === undefined) delete process.env.API_TOKEN
        else process.env.API_TOKEN = prev
      }
    })
  })

  describe('forceTerminalRepaint (#6313)', () => {
    it('toggles the PTY width and restores it (two SIGWINCH resizes), returning true', () => {
      const s = makeLiveShell()
      s._ptyCols = 80
      s._ptyRows = 24
      const ok = s.forceTerminalRepaint()
      assert.equal(ok, true)
      assert.deepEqual(s._term._calls.resize, [[79, 24], [80, 24]], 'shrink one column then restore')
      assert.equal(s._ptyCols, 80, 'the authoritative width is unchanged after the toggle')
    })

    it('toggles UP from the 1-column floor (never a no-op resize)', () => {
      const s = makeLiveShell()
      s._ptyCols = 1
      s._ptyRows = 24
      assert.equal(s.forceTerminalRepaint(), true)
      assert.deepEqual(s._term._calls.resize, [[2, 24], [1, 24]], 'grow to 2 then restore to 1')
    })

    it('returns false and does not resize when there is no live PTY', () => {
      const s = new UserShellSession({ cwd: '/tmp' })
      assert.equal(s.forceTerminalRepaint(), false)
    })
  })
})
