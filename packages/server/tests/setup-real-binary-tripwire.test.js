/**
 * Real-binary tripwire for the server test suite (#8096).
 *
 * The #8096 investigation found tests that resolved, hashed and exec'd the
 * developer's REAL `cloudflared` (`cloudflare-provenance.test.js`'s #6937
 * spawn tests) and REAL `cloudflared`/`claude` (`doctor-binary-provenance*
 * .test.js`) — a bare PATH-resolved name, or a fixed well-known install path
 * like `/opt/homebrew/bin/cloudflared`, is indistinguishable from a fixture at
 * the call site unless something checks. Those three call sites are fixed
 * elsewhere in this PR; this file proves the BACKSTOP that goes red if the
 * next one reaches a real binary again — see
 * `scripts/lib/test-real-binary-tripwire.mjs` for the full design note.
 *
 * ── Stubbed child_process, not the real one (#8185) ─────────────────────
 *
 * Every test below that exercises a throw/pass-through DECISION installs
 * the tripwire's own `installRealBinaryTripwire()` onto a fresh,
 * `makeStubbedTripwire()`-built stand-in for `node:child_process` — a plain
 * object of recording, always-safe launcher stubs — via that function's
 * `target` seam, rather than relying on the real module `_setup.mjs` already
 * patched. If the guard regresses and fails to throw for a guarded binary,
 * the call falls through to the STUB underneath it, not a real launcher —
 * nothing is ever spawned, hashed, or exec'd for real, regardless of what
 * the guard actually decides. A regression then shows up as a RED,
 * legible assertion: either `assert.throws` itself fails (the guard didn't
 * throw), or the stub's recorded-calls array — asserted empty right next to
 * it — is no longer empty. Before #8185, the equivalent regression called
 * through to `require('node:child_process')`'s real `spawn`/`exec`/etc. and
 * started a real `codex exec` on a developer machine (confirmed once, during
 * review of #8184).
 *
 * The two tests that read `REAL_BINARY_TRIPWIRE_INSTALLED` /
 * `REAL_BINARY_TRIPWIRE_SKIPPED` (from `_setup.mjs`) or the top-level
 * `node:child_process` imports directly are the exception: they only inspect
 * what the REAL, production install already wired up (marker symbols, the
 * installed/skipped arrays) and never invoke a launcher, so there is nothing
 * for a stub to sit underneath.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, exec, execSync, execFile, execFileSync, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, sep } from 'node:path'

import { prepareSpawn } from '../src/utils/win-spawn.js'
import {
  REAL_BINARY_TRIPWIRE_INSTALLED,
  REAL_BINARY_TRIPWIRE_SKIPPED,
} from './_setup.mjs'
import {
  isGuardedRealBinary,
  GUARDED_BASENAMES,
  REAL_INSTALL_PREFIXES,
  REAL_BINARY_ERROR_CODE,
  REAL_BINARY_MARKER,
  installRealBinaryTripwire,
} from '../../../scripts/lib/test-real-binary-tripwire.mjs'

/**
 * Build a fresh, isolated stand-in for `node:child_process` — one recording,
 * always-safe stub function per launcher name — and install the SAME
 * `installRealBinaryTripwire()` wrapping logic onto it via its `target` seam
 * (#8185), instead of onto the real module.
 *
 * Each call records its full argument list into `calls.<launcherName>` and
 * returns an inert value (never throws, never touches a real process).
 * `stub.<launcherName>` is the TRIPWIRE-WRAPPED function — calling it runs
 * the exact same guard logic the real install runs; a guarded command still
 * throws before ever reaching the recording stub underneath, and a
 * non-guarded command reaches it and gets recorded.
 *
 * A fresh stub is built per call (never shared across tests) so one test's
 * recorded calls can never leak into another's "recorded zero calls"
 * assertion.
 */
function makeStubbedTripwire(installOpts = {}) {
  const calls = {
    spawn: [],
    spawnSync: [],
    exec: [],
    execSync: [],
    execFile: [],
    execFileSync: [],
    fork: [],
  }

  // A minimal stand-in for the `ChildProcess` instance spawn/fork normally
  // return — just enough surface for the handful of tests below that call
  // `.on('error', ...)` / check `.pid` / call `.kill()` on the result. `pid`
  // is always `undefined`, so every `if (proc.pid !== undefined) proc.kill(...)`
  // guard already in this file is a no-op against it, same as it already is
  // today against a real spawn that failed before a pid was ever assigned.
  function fakeChildProcess() {
    return { pid: undefined, on() {}, kill() {} }
  }

  function recordAndReturnChild(name) {
    return (...args) => {
      calls[name].push(args)
      return fakeChildProcess()
    }
  }

  // exec/execFile's async callback form: record, then — if a trailing
  // callback was actually passed — invoke it on the next tick with a
  // successful, empty result. Nothing currently exercised in this file
  // resolves through that callback (every exec/execFile use below is either
  // a throwing case, where the guard fires before the stub is ever reached,
  // or synchronous), but a stub that never calls back a provided callback
  // would hang a future async-passthrough test instead of failing it loudly.
  function recordAndMaybeCallback(name) {
    return (...args) => {
      calls[name].push(args)
      const cb = args[args.length - 1]
      if (typeof cb === 'function') process.nextTick(() => cb(null, '', ''))
      return fakeChildProcess()
    }
  }

  const target = {
    spawn: recordAndReturnChild('spawn'),
    fork: recordAndReturnChild('fork'),
    exec: recordAndMaybeCallback('exec'),
    execFile: recordAndMaybeCallback('execFile'),
    spawnSync(...args) {
      calls.spawnSync.push(args)
      return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
    },
    execSync(...args) {
      calls.execSync.push(args)
      return Buffer.from('')
    },
    execFileSync(...args) {
      calls.execFileSync.push(args)
      return Buffer.from('')
    },
  }

  const { installed, skipped } = installRealBinaryTripwire({ ...installOpts, target })
  return { stub: target, calls, installed, skipped }
}

describe('real-binary tripwire: pure isGuardedRealBinary() rule (#8096)', () => {
  it('flags a bare guarded name', () => {
    assert.equal(isGuardedRealBinary('cloudflared'), true)
    assert.equal(isGuardedRealBinary('claude'), true)
    assert.equal(isGuardedRealBinary('codex'), true)
    assert.equal(isGuardedRealBinary('gemini'), true)
  })

  it('flags an absolute path under a real install prefix', () => {
    assert.equal(isGuardedRealBinary('/opt/homebrew/bin/cloudflared'), true)
    assert.equal(isGuardedRealBinary('/usr/local/bin/claude'), true)
  })

  it('does NOT flag node/git/sh — this guard is narrow, not "no child_process at all"', () => {
    assert.equal(isGuardedRealBinary('node'), false)
    assert.equal(isGuardedRealBinary('git'), false)
    assert.equal(isGuardedRealBinary('sh'), false)
    assert.equal(isGuardedRealBinary('/opt/homebrew/bin/git'), false)
    assert.equal(isGuardedRealBinary('/opt/homebrew/opt/node@22/bin/node'), false)
  })

  it('does NOT flag a fixture path outside a real install prefix, even if it happens to be NAMED like a guarded binary', () => {
    assert.equal(isGuardedRealBinary('/tmp/some-test-fixture-dir/claude'), false)
    assert.equal(isGuardedRealBinary('/tmp/some-test-fixture-dir/gate-shim.mjs'), false)
  })

  it('GUARDED_BASENAMES is exactly the four provider/tunnel binaries this issue is about', () => {
    assert.deepEqual([...GUARDED_BASENAMES].sort(), ['claude', 'cloudflared', 'codex', 'gemini'])
  })

  it('REAL_INSTALL_PREFIXES is non-empty and every entry is an absolute, separator-terminated prefix', () => {
    // Cross-platform on purpose: some entries are hardcoded POSIX strings
    // (`/opt/homebrew/`, `/usr/local/`) that stay POSIX-shaped regardless of
    // the host running this suite, while others are built via `join(homedir(),
    // …) + sep` and come out platform-native — a `C:\Users\...\.local\` on
    // win32. `path.isAbsolute()` (the platform-adaptive default export)
    // recognizes BOTH shapes as absolute on every platform Node runs on —
    // verified directly: `path.win32.isAbsolute('/opt/homebrew/')` is `true`,
    // because a leading `/` is a rooted (if driveless) path on Windows too.
    // The terminator is checked against EITHER `sep` (native) or `/` (the
    // hardcoded entries), never just one — asserting only `sep` would fail
    // the two hardcoded POSIX entries on win32, and asserting only `/` is
    // exactly the bug this test previously had.
    assert.ok(REAL_INSTALL_PREFIXES.length > 0)
    for (const prefix of REAL_INSTALL_PREFIXES) {
      assert.ok(isAbsolute(prefix), `expected an absolute prefix, got ${prefix}`)
      assert.ok(
        prefix.endsWith(sep) || prefix.endsWith('/'),
        `expected a separator-terminated prefix so it can't match a sibling dir by accident, got ${prefix}`,
      )
    }
  })
})

describe('real-binary tripwire: installed for this process (#8096)', () => {
  it('is armed for this process (sanity: _setup.mjs actually installed it)', () => {
    assert.ok(
      REAL_BINARY_TRIPWIRE_INSTALLED.length > 0,
      'No child_process launcher was patched — the tripwire from #8096 is not installed.',
    )
    // Same category as test-spawn-home-sandbox.mjs guards.
    assert.deepEqual(
      [...REAL_BINARY_TRIPWIRE_INSTALLED].sort(),
      ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'],
    )
    assert.deepEqual(REAL_BINARY_TRIPWIRE_SKIPPED, [])
  })

  it('CONTROL: a non-guarded command passes through the tripwire and reaches the underlying stub — proves the stub really sits UNDER the wrapped functions, so every "recorded zero calls" assertion below is not vacuous (#8185)', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.doesNotThrow(() => {
      const proc = stub.spawn('echo', ['ok'], { stdio: 'ignore' })
      proc.on('error', () => {})
      if (proc.pid !== undefined) proc.kill('SIGKILL')
    })
    assert.equal(calls.spawn.length, 1, 'a non-guarded command must reach the stub underneath the tripwire')
    assert.deepEqual(calls.spawn[0][0], 'echo')
    assert.deepEqual(calls.spawn[0][1], ['ok'])
  })

  it('a bare `cloudflared` spawn() throws the tripwire error — and the stub it wraps never sees the call, so no real process is ever created', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.throws(
      () => stub.spawn('cloudflared', []),
      (err) => {
        assert.equal(err.code, REAL_BINARY_ERROR_CODE)
        assert.match(err.message, /cloudflared/)
        return true
      },
    )
    assert.equal(calls.spawn.length, 0, 'the tripwire must never reach the launcher underneath it for a guarded binary')
  })

  it('an absolute /opt/homebrew/bin/cloudflared execFileSync() throws the tripwire error', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.throws(
      () => stub.execFileSync('/opt/homebrew/bin/cloudflared', ['--version']),
      (err) => {
        assert.equal(err.code, REAL_BINARY_ERROR_CODE)
        return true
      },
    )
    assert.equal(calls.execFileSync.length, 0)
  })

  it('a bare `claude` spawnSync() and a real-prefix `codex`/`gemini` execFileSync() all throw', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.throws(() => stub.spawnSync('claude', ['--version']), { code: REAL_BINARY_ERROR_CODE })
    assert.throws(() => stub.execFileSync('/usr/local/bin/codex', ['--version']), { code: REAL_BINARY_ERROR_CODE })
    assert.throws(() => stub.execFileSync('/opt/homebrew/bin/gemini', ['--version']), { code: REAL_BINARY_ERROR_CODE })
    assert.equal(calls.spawnSync.length, 0)
    assert.equal(calls.execFileSync.length, 0)
  })

  it('spawn/spawnSync/execFileSync with options.shell: true still throw — the guarded name is inside a shell command STRING, not args[0] literally (#8102)', () => {
    // Reproduces the reviewer's exact bypass: `spawn('cloudflared --version',
    // { shell: true })` — with `shell` truthy, args[0] is a shell command
    // LINE, not a literal filename, so the guard must split it the same way
    // exec/execSync's shell-string form already does.
    const { stub, calls } = makeStubbedTripwire()
    assert.throws(
      () => stub.spawn('cloudflared --version', { shell: true, stdio: 'ignore' }),
      { code: REAL_BINARY_ERROR_CODE },
    )
    assert.throws(
      () => stub.spawnSync('cloudflared --version', { shell: true, stdio: 'ignore' }),
      { code: REAL_BINARY_ERROR_CODE },
    )
    assert.throws(
      () => stub.execFileSync('cloudflared --version', { shell: true }),
      { code: REAL_BINARY_ERROR_CODE },
    )
    assert.equal(calls.spawn.length, 0)
    assert.equal(calls.spawnSync.length, 0)
    assert.equal(calls.execFileSync.length, 0)
  })

  it('exec()/execSync() shell-command strings of a guarded binary throw — the exec branch of resolveCommandArg actually FIRES, not merely wraps', () => {
    // The wrap-marker test below proves exec/execSync were PATCHED; this proves
    // the patch reaches its decision (firstShellToken on a command string).
    // The absolute path is a real install prefix with no binary behind it, so a
    // regressed guard cannot reach a real program even under the normal PATH —
    // and now it cannot reach anything but the recording stub either way.
    const { stub, calls } = makeStubbedTripwire()
    assert.throws(() => stub.execSync('claude --version', { stdio: 'ignore' }), { code: REAL_BINARY_ERROR_CODE })
    assert.throws(() => stub.exec('cloudflared --version', () => {}), { code: REAL_BINARY_ERROR_CODE })
    assert.throws(() => stub.execSync('/usr/local/bin/gemini --version', { stdio: 'ignore' }), { code: REAL_BINARY_ERROR_CODE })
    assert.equal(calls.exec.length, 0)
    assert.equal(calls.execSync.length, 0)
  })

  it('a safe command with options.shell: true is unaffected (proves the shell:true branch is not a blanket refusal)', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.doesNotThrow(() => stub.execFileSync('git --version', { shell: true, encoding: 'utf-8' }))
    // The call must reach the launcher underneath — a tripwire that silently
    // swallowed it would also not throw.
    assert.equal(calls.execFileSync.length, 1)
  })

  it('a promisified execFile() of a guarded binary still throws, not merely warns', async () => {
    const { stub, calls } = makeStubbedTripwire()
    const execFileAsync = promisify(stub.execFile)
    await assert.rejects(
      () => execFileAsync('/opt/homebrew/bin/cloudflared', ['--version']),
      (err) => {
        assert.equal(err.code, REAL_BINARY_ERROR_CODE)
        return true
      },
    )
    assert.equal(calls.execFile.length, 0)
  })

  it('passes for node/git — this guard does not block ordinary test plumbing', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.doesNotThrow(() => stub.execFileSync(process.execPath, ['--version'], { encoding: 'utf-8' }))
    assert.doesNotThrow(() => stub.execFileSync('git', ['--version'], { encoding: 'utf-8' }))
    assert.equal(calls.execFileSync.length, 2, 'both calls must reach the launcher underneath the tripwire')
  })

  it('a bare guarded name is NOT flagged when the call scopes PATH to empty — the #8096 fix-1 pattern', () => {
    // Mirrors cloudflare-provenance.test.js's #6937 tests: an empty PATH means
    // the OS's own search can't find anything, real binary or not, so this
    // must pass through to the launcher underneath (the stub, which ENOENTs
    // on nothing — it just records the call and returns an inert value).
    const { stub } = makeStubbedTripwire()
    assert.doesNotThrow(() => {
      const proc = stub.spawn('cloudflared', [], { stdio: 'ignore', env: { PATH: '' } })
      proc.on('error', () => {})
      if (proc.pid !== undefined) proc.kill('SIGKILL')
    })
  })

  it('CHROXY_TEST_ALLOW_REAL_BINARY=1 disables the guard entirely', () => {
    const prev = process.env.CHROXY_TEST_ALLOW_REAL_BINARY
    process.env.CHROXY_TEST_ALLOW_REAL_BINARY = '1'
    try {
      const { stub } = makeStubbedTripwire()
      assert.doesNotThrow(() => {
        const proc = stub.spawn('cloudflared', [], { stdio: 'ignore', env: { PATH: '' } })
        proc.on('error', () => {})
        if (proc.pid !== undefined) proc.kill('SIGKILL')
      })
    } finally {
      if (prev === undefined) delete process.env.CHROXY_TEST_ALLOW_REAL_BINARY
      else process.env.CHROXY_TEST_ALLOW_REAL_BINARY = prev
    }
  })

  it('every patched launcher carries the marker symbol (proves the "already-guarded" skip path is real, not vacuous)', () => {
    const launchers = { spawn, spawnSync, exec, execSync, execFile, execFileSync, fork }
    for (const name of REAL_BINARY_TRIPWIRE_INSTALLED) {
      assert.equal(launchers[name][REAL_BINARY_MARKER], name, `${name} should carry the marker`)
    }
  })
})

describe('real-binary tripwire: guarded names past the first shell token, and the win-spawn cmd.exe wrapper (#8102)', () => {
  // The throwing cases below (through the win-spawn cmd.exe wrapper) throw synchronously, before the stub underneath ever
  // sees the call — same safety property the file's header note already establishes
  // for every other "throws" assertion in this file, now doubly so since
  // there is no real launcher anywhere in reach.

  it('a CHAINED command (`true && codex exec`) via exec() throws — the guarded name is past the first whitespace token, not at the start of the string', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.throws(() => stub.exec('true && codex exec', () => {}), { code: REAL_BINARY_ERROR_CODE })
    assert.equal(calls.exec.length, 0)
  })

  it('a CHAINED command hiding in the separate args ARRAY of a shell:true spawn() throws — `args[0]` alone ("true") is safe; the guarded name only appears once `args[0]` and the args array are joined the way Node itself joins them', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.throws(
      () => stub.spawn('true', ['&&', 'codex', 'exec'], { shell: true, stdio: 'ignore' }),
      { code: REAL_BINARY_ERROR_CODE },
    )
    assert.equal(calls.spawn.length, 0)
  })

  it('execFileSync with a shell PATH STRING (not just `shell: true`) throws — `options.shell` is truthy for any non-empty string too', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.throws(
      () => stub.execFileSync('claude -v', [], { shell: '/bin/sh' }),
      { code: REAL_BINARY_ERROR_CODE },
    )
    assert.equal(calls.execFileSync.length, 0)
  })

  it('a `$(...)` command SUBSTITUTION throws — the substituted command still execs a real subprocess, unlike a plain argument mention', () => {
    const { stub, calls } = makeStubbedTripwire()
    assert.throws(() => stub.exec('echo $(claude -v)', () => {}), { code: REAL_BINARY_ERROR_CODE })
    assert.equal(calls.exec.length, 0)
  })

  it("win-spawn.js's actual `cmd.exe /d /s /c \"<line>\"` wrapper shape throws — built with the REAL prepareSpawn(), not a hand-approximated shape", () => {
    // Forces the win32 branch regardless of the platform this suite actually
    // runs on (see win-spawn.test.js for the same {platform:'win32'} override
    // pattern). `claude.cmd` is the standard npm-global install shape this
    // guard exists to catch on a real Windows host.
    const { stub, calls } = makeStubbedTripwire()
    const spec = prepareSpawn('claude.cmd', ['--version'], { platform: 'win32' })
    assert.throws(
      () => stub.spawn(spec.command, spec.args, spec.options),
      { code: REAL_BINARY_ERROR_CODE },
    )
    assert.equal(calls.spawn.length, 0)
  })

  it('the cmd.exe wrapper shape is unaffected when the /c string names no guarded binary (proves this is shape-recognition, not "block every cmd.exe call")', () => {
    const { stub } = makeStubbedTripwire()
    const spec = prepareSpawn('somethingelse.cmd', ['--version'], { platform: 'win32' })
    assert.doesNotThrow(() => {
      const proc = stub.spawn(spec.command, spec.args, { ...spec.options, stdio: 'ignore' })
      proc.on('error', () => {})
      if (proc.pid !== undefined) proc.kill('SIGKILL')
    })
  })

  it('a bare `cmd`/`cmd.exe` call with NO `/c` flag is unaffected (e.g. launching an interactive shell) — proves this only recognizes the specific `/c "<line>"` shape', () => {
    const { stub } = makeStubbedTripwire()
    assert.doesNotThrow(() => {
      const proc = stub.spawn('cmd.exe', ['/k'], { stdio: 'ignore' })
      proc.on('error', () => {})
      if (proc.pid !== undefined) proc.kill('SIGKILL')
    })
  })

  it('DECISION: a guarded name mentioned as an ARGUMENT, not invoked in command position, does NOT trip (`spawn(\'echo cloudflared\', { shell: true })`) — this guard blocks a binary being EXEC\'D, not a string that merely names one', () => {
    // If this ever throws, the guard has regressed into a blanket substring
    // scan — exactly the "denies everything" shape docs/false-safety-
    // guards.md warns about (#7273) — and would start false-positiving on
    // any test that merely prints/logs/asserts-on the word "cloudflared".
    const { stub } = makeStubbedTripwire()
    assert.doesNotThrow(() => {
      const proc = stub.spawn('echo cloudflared', { shell: true, stdio: 'ignore' })
      proc.on('error', () => {})
      if (proc.pid !== undefined) proc.kill('SIGKILL')
    })
  })

  it('a literal, non-shell spawn() of an ordinary command is unaffected (`spawn("node", ["x.js"], { shell: false })`)', () => {
    const { stub } = makeStubbedTripwire()
    assert.doesNotThrow(() => {
      const proc = stub.spawn('node', ['x.js'], { shell: false, stdio: 'ignore' })
      proc.on('error', () => {})
      if (proc.pid !== undefined) proc.kill('SIGKILL')
    })
  })
})
