import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  surveyWsl,
  runWslAction,
  WSL_ACTIONS,
  parseWslList,
  decodeWslOutput,
} from '../src/control-room/wsl.js'

/**
 * Tests for the #6138 WSL2 distro survey + actions (epic #5530). wsl.exe is
 * stubbed via injected seams (+ a simulated `win32` platform) so no real WSL /
 * Windows is needed.
 */

const NOW = () => new Date('2026-06-20T12:00:00.000Z')
const WIN = () => 'win32'

// A realistic `wsl.exe -l -v` table (clean UTF-8 form).
const SAMPLE = [
  '  NAME            STATE           VERSION',
  '* Ubuntu          Running         2',
  '  Debian          Stopped         2',
  '  legacy          Stopped         1',
].join('\n')

describe('parseWslList()', () => {
  it('parses name/state/version, marks the default, drops the header', () => {
    const out = parseWslList(SAMPLE)
    assert.deepEqual(out.map((d) => d.name), ['Ubuntu', 'Debian', 'legacy'])
    assert.equal(out[0].isDefault, true)
    assert.equal(out[0].state, 'Running')
    assert.equal(out[0].version, 2)
    assert.equal(out[1].isDefault, false)
    assert.equal(out[2].version, 1)
  })

  it('decodes the UTF-16-as-bytes form (NUL-interleaved)', () => {
    // Simulate wsl.exe's UTF-16LE output arriving as latin1 bytes (NUL between
    // every character). The parser must strip NULs and still parse.
    const nul = String.fromCharCode(0)
    const utf16ish = SAMPLE.split('').map((c) => c + nul).join('')
    const out = parseWslList(utf16ish)
    assert.deepEqual(out.map((d) => d.name), ['Ubuntu', 'Debian', 'legacy'])
    assert.equal(out[0].isDefault, true)
  })

  it('returns [] on empty/garbage', () => {
    assert.deepEqual(parseWslList(''), [])
    assert.deepEqual(parseWslList(null), [])
    // A header-only listing has no distro rows.
    assert.deepEqual(parseWslList('  NAME   STATE   VERSION'), [])
  })

  it('tolerates a missing/unparseable version → null', () => {
    const out = parseWslList('  NAME   STATE   VERSION\n* Ubuntu   Running')
    assert.equal(out.length, 1)
    assert.equal(out[0].version, null)
  })
})

describe('decodeWslOutput()', () => {
  it('decodes a UTF-16LE buffer (the real wsl.exe encoding) — preserves non-ASCII', () => {
    const text = '* Ubuntü   Running   2'
    const buf = Buffer.from(text, 'utf16le')
    assert.equal(decodeWslOutput(buf), text)
  })
  it('decodes a plain UTF-8 buffer when no NUL bytes are present', () => {
    assert.equal(decodeWslOutput(Buffer.from('hello', 'utf8')), 'hello')
  })
  it('passes a string through unchanged; tolerates junk', () => {
    assert.equal(decodeWslOutput('already a string'), 'already a string')
    assert.equal(decodeWslOutput(null), '')
  })
})

describe('surveyWsl()', () => {
  it('lists distros + the default on a Windows host', async () => {
    const snap = await surveyWsl({ _execFile: async () => ({ stdout: SAMPLE }), _platform: WIN, _now: NOW })
    assert.equal(snap.available, true)
    assert.equal(snap.distros.length, 3)
    assert.equal(snap.defaultDistro, 'Ubuntu')
    assert.equal(snap.generatedAt, '2026-06-20T12:00:00.000Z')
  })

  it('decodes a real UTF-16LE Buffer from wsl.exe (preserves a non-ASCII name)', async () => {
    // The production exec uses encoding:'buffer'; prove the survey decodes it.
    const utf16 = Buffer.from('  NAME   STATE   VERSION\n* Ubuntü   Running   2', 'utf16le')
    const snap = await surveyWsl({ _execFile: async () => ({ stdout: utf16 }), _platform: WIN, _now: NOW })
    assert.equal(snap.available, true)
    assert.deepEqual(snap.distros.map((d) => d.name), ['Ubuntü'])
    assert.equal(snap.defaultDistro, 'Ubuntü')
  })

  it('degrades to available:false (quiet) off Windows without execing', async () => {
    let execed = false
    const snap = await surveyWsl({ _execFile: async () => { execed = true; return { stdout: SAMPLE } }, _platform: () => 'darwin', _now: NOW })
    assert.equal(snap.available, false)
    assert.equal(execed, false, 'must not shell out to wsl.exe off Windows')
    assert.match(snap.note, /only available on Windows/)
    assert.deepEqual(snap.distros, [])
  })

  it('degrades to available:false when wsl.exe is missing on Windows', async () => {
    const snap = await surveyWsl({ _execFile: async () => { throw new Error('spawn wsl.exe ENOENT') }, _platform: WIN, _now: NOW })
    assert.equal(snap.available, false)
    assert.match(snap.note, /not available on this host/)
    assert.deepEqual(snap.distros, [])
  })

  it('defaultDistro is null when no distro is marked default', async () => {
    const noDefault = '  NAME   STATE   VERSION\n  Ubuntu   Running   2'
    const snap = await surveyWsl({ _execFile: async () => ({ stdout: noDefault }), _platform: WIN, _now: NOW })
    assert.equal(snap.defaultDistro, null)
    assert.equal(snap.distros.length, 1)
  })
})

describe('runWslAction()', () => {
  it('exports the supported actions', () => {
    assert.deepEqual(WSL_ACTIONS, ['start', 'terminate'])
  })

  it('starts a distro and returns running', async () => {
    const calls = []
    const status = await runWslAction({ action: 'start', distro: 'Ubuntu', _execFile: async (f, a) => { calls.push([f, ...a]); return { stdout: '' } } })
    assert.equal(status, 'running')
    assert.deepEqual(calls, [['wsl.exe', '-d', 'Ubuntu', '-e', 'true']])
  })

  it('terminates a distro and returns stopped', async () => {
    const calls = []
    const status = await runWslAction({ action: 'terminate', distro: 'Ubuntu', _execFile: async (f, a) => { calls.push([f, ...a]); return { stdout: '' } } })
    assert.equal(status, 'stopped')
    assert.deepEqual(calls, [['wsl.exe', '--terminate', 'Ubuntu']])
  })

  it('rejects an unsupported action / missing distro', async () => {
    await assert.rejects(() => runWslAction({ action: 'nuke', distro: 'Ubuntu', _execFile: async () => ({ stdout: '' }) }), /Unsupported WSL action/)
    await assert.rejects(() => runWslAction({ action: 'start', distro: '', _execFile: async () => ({ stdout: '' }) }), /requires a distro/)
  })

  it('propagates a wsl.exe failure', async () => {
    await assert.rejects(
      () => runWslAction({ action: 'terminate', distro: 'Ubuntu', _execFile: async () => { throw new Error('There is no distribution with the supplied name') } }),
      /no distribution/,
    )
  })
})
