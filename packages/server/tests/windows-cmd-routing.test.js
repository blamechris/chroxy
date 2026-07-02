import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { prepareSpawn } from '../src/utils/win-spawn.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = (p) => readFileSync(resolve(here, '../src', p), 'utf-8')

/**
 * #6484 — the binary resolver can hand a `.cmd` shim (npm-only Windows host) to
 * spawn sites that don't use prepareSpawn, hitting Node 24's `.cmd` EINVAL. This
 * PR routes the remaining provider spawn sites through prepareSpawn:
 *   - jsonl-subprocess-session.js (codex/gemini/deepseek/ollama base class)
 *   - doctor.js checkClaudeTuiCliVersion (default exec) + checkBinary
 *
 * WHY NO child_process MOCK HERE: `node --test` runs test files CONCURRENTLY, and
 * `mock.module('child_process')` patches the loader process-wide — it leaks the
 * mocked spawn/execFileSync into whatever subprocess-spawning test file happens
 * to overlap, flaking unrelated suites (MCPFleet, sidecar, …) non-deterministically.
 * So the routing is proved two safe, deterministic ways instead:
 *   1. prepareSpawn's transform on the exact provider binaries (pure — no globals,
 *      platform passed as an arg). The escaping itself is covered by win-spawn.test.js.
 *   2. a source guard that each call site invokes prepareSpawn on its resolved
 *      binary and spawns `spawnSpec.command`/`.args` (not the originals).
 * The full doctor + jsonl-subprocess suites additionally prove the wiring on POSIX
 * (a mis-wire — e.g. spawning `bin` instead of `spawnSpec.command` — would break
 * those real spawns, since prepareSpawn returns `command === bin` on POSIX).
 */

describe('Windows .cmd routing — prepareSpawn on provider binaries (#6484)', () => {
  const PROVIDER_SHIMS = [
    'C:\\npm\\codex.cmd',
    'C:\\npm\\gemini.cmd',
    'C:\\npm\\deepseek.cmd',
    'C:\\npm\\ollama.cmd',
    'C:\\npm\\claude.cmd', // doctor's claude-tui drift backstop
  ]

  it('routes every provider .cmd shim through cmd.exe /d /s /c with verbatim args on win32', () => {
    for (const shim of PROVIDER_SHIMS) {
      const spec = prepareSpawn(shim, ['--version'], { platform: 'win32' })
      assert.match(spec.command, /cmd\.exe$/i, `${shim} → cmd.exe`)
      assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c'])
      assert.equal(spec.options.windowsVerbatimArguments, true)
      assert.ok(spec.args[3].includes(shim.split('\\').pop()), 'the shim is inside the escaped line')
    }
  })

  it('leaves a resolved .exe untouched on win32', () => {
    const spec = prepareSpawn('C:\\npm\\codex.exe', ['--version'], { platform: 'win32' })
    assert.equal(spec.command, 'C:\\npm\\codex.exe')
    assert.deepEqual(spec.args, ['--version'])
    assert.deepEqual(spec.options, {})
  })

  it('leaves a .cmd untouched on POSIX (no cmd.exe routing off Windows)', () => {
    const spec = prepareSpawn('/weird/codex.cmd', ['--version'], { platform: 'linux' })
    assert.equal(spec.command, '/weird/codex.cmd')
    assert.deepEqual(spec.args, ['--version'])
    assert.deepEqual(spec.options, {})
  })
})

describe('Windows .cmd routing — call sites invoke prepareSpawn (#6484)', () => {
  it('jsonl-subprocess-session spawns prepareSpawn(resolvedBinary) output', () => {
    const s = src('jsonl-subprocess-session.js')
    assert.match(s, /import \{ prepareSpawn \} from '\.\/utils\/win-spawn\.js'/, 'imports prepareSpawn')
    assert.match(s, /prepareSpawn\(Klass\.resolvedBinary, args\)/, 'routes the resolved binary')
    // Spawns the ROUTED command/args (not the originals), spreading its options.
    assert.match(s, /spawn\(spawnSpec\.command, spawnSpec\.args/, 'spawns spawnSpec.command/.args')
    assert.match(s, /\.\.\.spawnSpec\.options/, 'spreads spawnSpec.options')
  })

  it('doctor.js routes both execFileSync sites (default exec + checkBinary)', () => {
    const s = src('doctor.js')
    assert.match(s, /import \{ prepareSpawn \} from '\.\/utils\/win-spawn\.js'/, 'imports prepareSpawn')
    // The claude-tui drift backstop's default exec.
    assert.match(s, /const s = prepareSpawn\(bin, args\)[\s\S]*?execFileSync\(s\.command, s\.args/, 'default exec routed')
    // checkBinary.
    assert.match(s, /prepareSpawn\(resolved, args\)[\s\S]*?execFileSync\(spawnSpec\.command, spawnSpec\.args/, 'checkBinary routed')
  })
})
