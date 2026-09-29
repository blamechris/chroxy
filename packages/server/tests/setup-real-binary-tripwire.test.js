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
 * Every "throws" assertion below is safe regardless of what is actually
 * installed on the machine running this suite: the guard throws
 * SYNCHRONOUSLY, before `child_process`'s own launcher ever runs, so no real
 * process is created either way.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, exec, execSync, execFile, execFileSync, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, sep } from 'node:path'

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
} from '../../../scripts/lib/test-real-binary-tripwire.mjs'

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

  it('a bare `cloudflared` spawn() throws the tripwire error — no real process is ever created', () => {
    assert.throws(
      () => spawn('cloudflared', []),
      (err) => {
        assert.equal(err.code, REAL_BINARY_ERROR_CODE)
        assert.match(err.message, /cloudflared/)
        return true
      },
    )
  })

  it('an absolute /opt/homebrew/bin/cloudflared execFileSync() throws the tripwire error', () => {
    assert.throws(
      () => execFileSync('/opt/homebrew/bin/cloudflared', ['--version']),
      (err) => {
        assert.equal(err.code, REAL_BINARY_ERROR_CODE)
        return true
      },
    )
  })

  it('a bare `claude` spawnSync() and a real-prefix `codex`/`gemini` execFileSync() all throw', () => {
    assert.throws(() => spawnSync('claude', ['--version']), { code: REAL_BINARY_ERROR_CODE })
    assert.throws(() => execFileSync('/usr/local/bin/codex', ['--version']), { code: REAL_BINARY_ERROR_CODE })
    assert.throws(() => execFileSync('/opt/homebrew/bin/gemini', ['--version']), { code: REAL_BINARY_ERROR_CODE })
  })

  it('spawn/spawnSync/execFileSync with options.shell: true still throw — the guarded name is inside a shell command STRING, not args[0] literally (#8102)', () => {
    // Reproduces the reviewer's exact bypass: `spawn('cloudflared --version',
    // { shell: true })` — with `shell` truthy, args[0] is a shell command
    // LINE, not a literal filename, so the guard must split it the same way
    // exec/execSync's shell-string form already does.
    assert.throws(
      () => spawn('cloudflared --version', { shell: true, stdio: 'ignore' }),
      { code: REAL_BINARY_ERROR_CODE },
    )
    assert.throws(
      () => spawnSync('cloudflared --version', { shell: true, stdio: 'ignore' }),
      { code: REAL_BINARY_ERROR_CODE },
    )
    assert.throws(
      () => execFileSync('cloudflared --version', { shell: true }),
      { code: REAL_BINARY_ERROR_CODE },
    )
  })

  it('exec()/execSync() shell-command strings of a guarded binary throw — the exec branch of resolveCommandArg actually FIRES, not merely wraps', () => {
    // The wrap-marker test above proves exec/execSync were PATCHED; this proves
    // the patch reaches its decision (firstShellToken on a command string).
    // The absolute path is a real install prefix with no binary behind it, so a
    // regressed guard cannot reach a real program even under the normal PATH.
    assert.throws(() => execSync('claude --version', { stdio: 'ignore' }), { code: REAL_BINARY_ERROR_CODE })
    assert.throws(() => exec('cloudflared --version', () => {}), { code: REAL_BINARY_ERROR_CODE })
    assert.throws(() => execSync('/usr/local/bin/gemini --version', { stdio: 'ignore' }), { code: REAL_BINARY_ERROR_CODE })
  })

  it('a safe command with options.shell: true is unaffected (proves the shell:true branch is not a blanket refusal)', () => {
    assert.doesNotThrow(() => execFileSync('git --version', { shell: true, encoding: 'utf-8' }))
  })

  it('a promisified execFile() of a guarded binary still throws, not merely warns', async () => {
    const execFileAsync = promisify(execFile)
    await assert.rejects(
      () => execFileAsync('/opt/homebrew/bin/cloudflared', ['--version']),
      (err) => {
        assert.equal(err.code, REAL_BINARY_ERROR_CODE)
        return true
      },
    )
  })

  it('passes for node/git — this guard does not block ordinary test plumbing', () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--version'], { encoding: 'utf-8' }))
    assert.doesNotThrow(() => execFileSync('git', ['--version'], { encoding: 'utf-8' }))
  })

  it('a bare guarded name is NOT flagged when the call scopes PATH to empty — the #8096 fix-1 pattern', () => {
    // Mirrors cloudflare-provenance.test.js's #6937 tests: an empty PATH means
    // the OS's own search can't find anything, real binary or not, so this
    // must pass through to the real spawn() (which then ENOENTs on its own).
    // #8096: do NOT call `.kill()` here — with PATH empty the spawn fails
    // synchronously and `proc.pid` never gets assigned, and calling `.kill()`
    // on a ChildProcess that never actually started crashes the process
    // (measured). `cloudflare-provenance.test.js`'s own `reapChild()` helper
    // checks `pid === undefined` before ever calling `.kill()` for exactly
    // this reason — there is nothing to reap here either.
    assert.doesNotThrow(() => {
      const proc = spawn('cloudflared', [], { stdio: 'ignore', env: { PATH: '' } })
      proc.on('error', () => {})
      if (proc.pid !== undefined) proc.kill('SIGKILL')
    })
  })

  it('CHROXY_TEST_ALLOW_REAL_BINARY=1 disables the guard entirely', () => {
    const prev = process.env.CHROXY_TEST_ALLOW_REAL_BINARY
    process.env.CHROXY_TEST_ALLOW_REAL_BINARY = '1'
    try {
      // Same "don't kill a never-started process" reasoning as above.
      assert.doesNotThrow(() => {
        const proc = spawn('cloudflared', [], { stdio: 'ignore', env: { PATH: '' } })
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
