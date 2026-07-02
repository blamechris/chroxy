import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as realChildProcess from 'child_process'
import { waitFor } from './test-helpers.js'

/**
 * #6484 — the binary resolver can hand a `.cmd` shim (npm-only Windows host) to
 * spawn sites that don't use prepareSpawn, hitting Node 24's `.cmd` EINVAL. This
 * verifies the doctor `checkBinary` call site now routes a resolved `.cmd`
 * through cmd.exe on win32 (and passes an `.exe` / POSIX binary through
 * unchanged), mirroring cli-session.js. The prepareSpawn escaping itself is
 * covered by win-spawn.test.js; here we assert the WIRING at the call site.
 *
 * We stub process.platform and mock child_process + resolve-binary, then
 * fresh-import doctor.js so its top-level `import { execFileSync }` binds to the
 * mock. mock.reset() + a restored platform run after each case.
 */
describe('Windows .cmd routing — doctor checkBinary (#6484)', () => {
  const origPlatform = process.platform
  afterEach(() => {
    mock.reset()
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  async function loadDoctor(tag) {
    // Cache-bust so each case gets a fresh module bound to the current mocks.
    return import(`../src/doctor.js?win-routing-${tag}`)
  }

  function stub({ platform, resolved }) {
    const calls = []
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    // doctor.js imports the bare 'child_process' specifier — mock exactly that,
    // keeping every real export (spawn/exec/… are needed by the transitive graph)
    // and overriding only execFileSync to capture the routed command.
    mock.module('child_process', {
      namedExports: {
        ...realChildProcess,
        execFileSync: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return 'codex 1.2.3' },
      },
    })
    mock.module('../src/utils/resolve-binary.js', {
      namedExports: { resolveBinary: () => resolved },
    })
    return calls
  }

  it('routes a resolved .cmd through cmd.exe /d /s /c on win32', async (t) => {
    const calls = stub({ platform: 'win32', resolved: 'C:\\npm\\codex.cmd' })
    const { checkBinary } = await loadDoctor(t.name.replace(/\W/g, ''))
    checkBinary('codex', ['--version'], { parseVersion: (o) => o, required: false, installHint: 'npm i -g codex' })
    assert.equal(calls.length, 1, 'execFileSync called once')
    assert.match(calls[0].cmd, /cmd\.exe$/i, 'command is cmd.exe (COMSPEC)')
    assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c'], 'cmd.exe run flags')
    assert.equal(calls[0].opts.windowsVerbatimArguments, true, 'verbatim args set')
    assert.ok(calls[0].args[3].includes('codex.cmd'), 'the shim is inside the escaped line')
  })

  it('passes a resolved .exe through unchanged on win32', async (t) => {
    const calls = stub({ platform: 'win32', resolved: 'C:\\npm\\codex.exe' })
    const { checkBinary } = await loadDoctor(t.name.replace(/\W/g, ''))
    checkBinary('codex', ['--version'], { parseVersion: (o) => o, required: false, installHint: '' })
    assert.equal(calls.length, 1)
    assert.match(calls[0].cmd, /codex\.exe$/i, 'runs the .exe directly, not cmd.exe')
    assert.deepEqual(calls[0].args, ['--version'], 'args unchanged')
  })

  it('passes a resolved .cmd through unchanged on POSIX (no cmd.exe)', async (t) => {
    const calls = stub({ platform: 'linux', resolved: '/weird/codex.cmd' })
    const { checkBinary } = await loadDoctor(t.name.replace(/\W/g, ''))
    checkBinary('codex', ['--version'], { parseVersion: (o) => o, required: false, installHint: '' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].cmd, '/weird/codex.cmd', 'POSIX runs the path directly')
    assert.deepEqual(calls[0].args, ['--version'])
  })

  it("routes checkClaudeTuiCliVersion's default exec through cmd.exe for a .cmd on win32", async (t) => {
    const calls = stub({ platform: 'win32', resolved: 'C:\\npm\\claude.cmd' })
    const { checkClaudeTuiCliVersion } = await loadDoctor(t.name.replace(/\W/g, ''))
    // No injected `exec` → the default (prepareSpawn-routed) path runs.
    checkClaudeTuiCliVersion()
    assert.equal(calls.length, 1, 'the claude --version drift check ran')
    assert.match(calls[0].cmd, /cmd\.exe$/i, 'claude.cmd routed through cmd.exe')
    assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c'])
  })
})

describe('Windows .cmd routing — jsonl-subprocess-session (#6484)', () => {
  const origPlatform = process.platform
  afterEach(() => {
    mock.reset()
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  it('routes a resolved .cmd provider binary through cmd.exe on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    let captured = null
    // Capture the spawn call, then throw so the session's existing try/catch
    // handles it — no fake child stream plumbing needed to assert the wiring.
    mock.module('child_process', {
      namedExports: {
        ...realChildProcess,
        spawn: (cmd, args, opts) => { captured = { cmd, args, opts }; throw new Error('captured-spawn') },
      },
    })
    const { JsonlSubprocessSession } = await import('../src/jsonl-subprocess-session.js?win-6484-jsonl')
    class CmdProvider extends JsonlSubprocessSession {
      static get binaryCandidates() { return ['C:\\npm\\codex.cmd'] }
      static get resolvedBinary() { return 'C:\\npm\\codex.cmd' }
      static get apiKeyEnv() { return 'CODEX_TEST_KEY' }
      static get providerName() { return 'codex' }
      static get displayLabel() { return 'Codex' }
      static get messageIdPrefix() { return 'codex' }
      _buildArgs(text) { return ['exec', text] }
      _buildChildEnv() { return process.env }
    }
    const s = new CmdProvider({ cwd: '/tmp' })
    s._processReady = true
    s.on('error', () => {}) // swallow the intentional spawn-throw
    s.sendMessage('hi') // not awaited — spawns, our mock captures + throws, caught
    await waitFor(() => captured != null, { label: 'spawn captured' })
    assert.match(captured.cmd, /cmd\.exe$/i, 'codex.cmd routed through cmd.exe')
    assert.deepEqual(captured.args.slice(0, 3), ['/d', '/s', '/c'], 'cmd.exe run flags')
    assert.equal(captured.opts.windowsVerbatimArguments, true, 'verbatim args set')
    assert.ok(captured.args[3].includes('codex.cmd'), 'the shim is inside the escaped line')
    s.destroy?.()
  })
})
