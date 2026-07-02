import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSpawn, isBatchShim } from '../src/utils/win-spawn.js'

const isWindows = process.platform === 'win32'

describe('isBatchShim', () => {
  it('matches .cmd and .bat (case-insensitive)', () => {
    assert.equal(isBatchShim('C:\\x\\claude.cmd'), true)
    assert.equal(isBatchShim('C:\\x\\claude.CMD'), true)
    assert.equal(isBatchShim('C:\\x\\thing.bat'), true)
  })

  it('does not match .exe / .com / extensionless / non-strings', () => {
    assert.equal(isBatchShim('C:\\x\\claude.exe'), false)
    assert.equal(isBatchShim('C:\\x\\claude.com'), false)
    assert.equal(isBatchShim('/usr/local/bin/claude'), false)
    assert.equal(isBatchShim(undefined), false)
    assert.equal(isBatchShim(null), false)
  })
})

describe('prepareSpawn (passthrough cases)', () => {
  it('returns command/args unchanged on POSIX', () => {
    const r = prepareSpawn('/usr/local/bin/claude', ['-p', 'hi there'], { platform: 'linux' })
    assert.equal(r.command, '/usr/local/bin/claude')
    assert.deepEqual(r.args, ['-p', 'hi there'])
    assert.deepEqual(r.options, {})
  })

  it('returns a directly-runnable .exe unchanged on Windows', () => {
    const r = prepareSpawn('C:\\x\\claude.exe', ['--model', 'm'], { platform: 'win32' })
    assert.equal(r.command, 'C:\\x\\claude.exe')
    assert.deepEqual(r.args, ['--model', 'm'])
    assert.deepEqual(r.options, {})
  })

  it('does NOT route a .cmd on POSIX (only Windows needs cmd.exe)', () => {
    const r = prepareSpawn('/weird/claude.cmd', ['a'], { platform: 'linux' })
    assert.equal(r.command, '/weird/claude.cmd')
    assert.deepEqual(r.args, ['a'])
  })
})

describe('prepareSpawn (.cmd routing on Windows)', () => {
  it('routes a .cmd through cmd.exe /d /s /c with verbatim args', () => {
    const r = prepareSpawn('C:\\x\\claude.cmd', ['-p', 'hi'], { platform: 'win32' })
    const comspec = process.env.COMSPEC || 'cmd.exe'
    assert.equal(r.command, comspec)
    assert.equal(r.args[0], '/d')
    assert.equal(r.args[1], '/s')
    assert.equal(r.args[2], '/c')
    // The whole command line is wrapped in exactly one outer quote pair so cmd
    // /s strips it and preserves our inner escaping.
    assert.ok(r.args[3].startsWith('"') && r.args[3].endsWith('"'), `not outer-quoted: ${r.args[3]}`)
    assert.ok(r.args[3].includes('claude.cmd'))
    assert.equal(r.options.windowsVerbatimArguments, true)
  })

  it('routes .bat the same way', () => {
    const r = prepareSpawn('C:\\x\\tool.bat', [], { platform: 'win32' })
    assert.equal(r.command, process.env.COMSPEC || 'cmd.exe')
    assert.equal(r.options.windowsVerbatimArguments, true)
  })
})

// The escaping is only meaningful when actually parsed by cmd.exe + the program's
// CommandLineToArgvW. This Windows-only integration test builds a realistic
// `%*`-forwarding shim (exactly how an npm `claude.cmd` forwards argv to node)
// and asserts adversarial args round-trip byte-for-byte.
describe('prepareSpawn round-trips args through a real .cmd shim', { skip: isWindows ? false : 'windows-only' }, () => {
  it('preserves quotes, metacharacters and backslashes verbatim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-winspawn-'))
    try {
      const printArgv = join(dir, 'printargv.mjs')
      const shim = join(dir, 'forward.cmd')
      writeFileSync(printArgv, "console.log('ARGV_JSON=' + JSON.stringify(process.argv.slice(2)))\n")
      // Mirrors an npm shim: forwards %* to node, which parses via CommandLineToArgvW.
      writeFileSync(shim, '@echo off\r\nnode "%~dp0printargv.mjs" %*\r\n')

      const args = [
        '--model', 'claude-opus-4-8',
        '--append-system-prompt', 'You are "helpful" & smart; use 100% effort (a^b) <tag> !x! %PATH%',
        '-p', 'plain prompt with spaces',
        'trailing\\',
      ]

      const spec = prepareSpawn(shim, args)
      const res = spawnSync(spec.command, spec.args, {
        ...spec.options,
        encoding: 'utf8',
      })

      assert.equal(res.status, 0, `shim exited non-zero: ${res.stderr}`)
      const m = res.stdout.match(/ARGV_JSON=(.*)/)
      assert.ok(m, `no ARGV_JSON in output: ${res.stdout}`)
      const got = JSON.parse(m[1])
      assert.deepEqual(got, args)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
