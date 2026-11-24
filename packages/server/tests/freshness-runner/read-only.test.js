/**
 * Read-only mode writes the ledger and delivers nothing. Asserted three ways:
 * the runner's source is scanned for imports and names that would send
 * anything, a full run over fixtures is made with every network and
 * child-process entry point trapped and every write recorded, and the source
 * files the run read are compared before and after. Each is shown to fail on a
 * mutant that does the forbidden thing.
 *
 * What this proves: the entry points reached through the default `fs`, `net`,
 * `http`, `https`, `dgram`, `dns`, `tls` and `child_process` objects and
 * `fetch`, on the path the fixtures exercise. A named import of one of them
 * would bypass the dynamic trap, and the static scan is what covers that.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cleanupTmp } from '../freshness-core/helpers/harness.js'
import { REAL_RUNNER, RUNNER_DIR, SRC, T0, cleanupVariants, install, ledgerRecords, must, mustKillRunner, runMain, snapshot, tickArgs, trapped, withEnv, world } from './helpers/runner-harness.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}) =>
  describe(name, () => {
    it('holds on the real code', async () => {
      await check(REAL_RUNNER)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKillRunner(check, label, edits))
  })

const edit = (file, from, to) => ({ file, from, to })
const R = 'freshness-runner/run-tick.js'
const ALLOWED_BUILTINS = ['node:fs', 'node:path', 'node:util', 'node:url', 'node:crypto']
const ALLOWED_RELATIVE = ['freshness-runner', 'freshness/index.js', 'freshness-sources/index.js', 'config-dir.js', 'utils/claude-config-dir.js', 'utils/is-entry-point.js']
const FORBIDDEN_WORDS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|child_process|keychain|keytar|libsecret|dpapi|credential|credentials|password|passwd|apikey|api_key|webhook|discord)\b/i

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** What a source text imports that is not allowed, and every forbidden name it uses. */
export function scanSource(file, text) {
  const code = stripComments(text)
  const violations = []
  const specs = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g), ...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g), ...code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  for (const spec of specs) {
    if (spec.startsWith('.')) {
      const target = path.relative(SRC, path.resolve(path.dirname(file), spec)).split(path.sep).join('/')
      if (!ALLOWED_RELATIVE.some((a) => target === a || target.startsWith(`${a}/`))) violations.push(`imports ${spec}`)
    } else if (!ALLOWED_BUILTINS.includes(spec)) {
      violations.push(`imports ${spec}`)
    }
  }
  const word = FORBIDDEN_WORDS.exec(code)
  if (word) violations.push(`uses ${word[0]}`)
  return violations
}

const shipped = () => fs.readdirSync(RUNNER_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(RUNNER_DIR, f))

proves('static: nothing shipped under src/freshness-runner imports a network, process, credential or delivery module or names one', () => {
  const files = shipped()
  assert.ok(files.length >= 4, 'the scan covers the module')
  for (const f of files) assert.deepEqual(scanSource(f, fs.readFileSync(f, 'utf8')), [], path.basename(f))
})

const INJECTED = {
  'a socket module': "import net from 'node:net'",
  'a dynamic http import': "const h = () => import('node:http')",
  'a child process import': "import cp from 'node:child_process'",
  'a child process require': "const cp = require('node:child_process')",
  'a package import': "import keytar from 'keytar'",
  'an import of the session manager': "import { SessionManager } from '../session-manager.js'",
  'an import of the discord sink': "import { send } from '../discord-sink.js'",
  'a bare fetch': "const f = () => fetch('http://example.invalid')",
  'a websocket': 'const w = new WebSocket("ws://x")',
}
for (const [label, line] of Object.entries(INJECTED)) {
  proves(`static: the scan flags ${label}`, () => {
    const file = path.join(RUNNER_DIR, 'run-tick.js')
    assert.notDeepEqual(scanSource(file, fs.readFileSync(file, 'utf8') + '\n' + line + '\n'), [])
  })
}

/** A full read-only run over fixtures, trapped; every source and ledger path is a temp path. */
function fullRun(M) {
  const w = world()
  const i = install()
  const before = snapshot(w.root)
  const { result, hits, writes } = trapped(() => runMain(M, tickArgs(w), { packageRoot: i.pkg, now: T0 }))
  return { w, i, before, result, hits, writes }
}

proves(
  'a read-only run makes no network or child-process call and writes only the ledger',
  (M) => {
    const { w, i, before, result, hits, writes } = must(() => fullRun(M), 'the run')
    assert.equal(result.code, 0, result.err)
    assert.deepEqual(hits, [], 'no network or child-process entry point was called')
    const ledgerDir = path.resolve(w.ledgerDir)
    const outside = [...new Set(writes)].filter((p) => p !== ledgerDir && !p.startsWith(ledgerDir + path.sep))
    assert.deepEqual(outside, [], 'nothing outside the ledger directory was written')
    assert.ok(writes.some((p) => p.startsWith(ledgerDir)), 'the ledger was written')
    // The sources are exactly as they were.
    const after = snapshot(w.root)
    for (const [file, bytes] of Object.entries(before)) assert.equal(after[file], bytes, `${file} is unchanged`)
    assert.deepEqual(Object.keys(after).filter((f) => !(f in before)).filter((f) => !f.startsWith('ledger')), [], 'no other file appeared')
    assert.ok(ledgerRecords(w).some((r) => r.kind === 'check'), 'the ledger holds the checks')
    assert.deepEqual(Object.keys(JSON.parse(result.out)).sort(), ['build', 'failed', 'ledger', 'mode', 'slot_start', 'sources'])
    assert.equal(JSON.parse(result.out).mode, 'read-only')
    assert.ok(i.pkg)
  },
  {
    'a fetch is made': [edit(R, 'const sources = []', "try { fetch('http://127.0.0.1:9/') } catch {}\n  const sources = []")],
    'a socket is opened': [edit(R, 'const sources = []', "try { net.connect(9, '127.0.0.1') } catch {}\n  const sources = []"), edit(R, "import path from 'node:path'", "import path from 'node:path'\nimport net from 'node:net'")],
    'an http request is made': [edit(R, 'const sources = []', "try { http.request('http://127.0.0.1:9/') } catch {}\n  const sources = []"), edit(R, "import path from 'node:path'", "import path from 'node:path'\nimport http from 'node:http'")],
    'a process is spawned': [edit(R, 'const sources = []', "try { cp.execFileSync('true') } catch {}\n  const sources = []"), edit(R, "import path from 'node:path'", "import path from 'node:path'\nimport cp from 'node:child_process'")],
    'the state file is written': [edit(R, 'const sources = []', "fs.appendFileSync(paths.stateFile, ' ')\n  const sources = []"), edit(R, "import path from 'node:path'", "import path from 'node:path'\nimport fs from 'node:fs'")],
    'a file is written beside the ledger': [edit(R, 'const sources = []', "fs.writeFileSync(path.join(path.dirname(ledger), 'outbox.json'), '{}')\n  const sources = []"), edit(R, "import path from 'node:path'", "import path from 'node:path'\nimport fs from 'node:fs'")],
  },
)

proves(
  'a run twice in one slot ticks once, and a source whose tick fails does not stop the others',
  (M) => {
    const w = world()
    const i = install()
    const first = runMain(M, tickArgs(w), { packageRoot: i.pkg, now: T0 })
    const second = runMain(M, tickArgs(w), { packageRoot: i.pkg, now: T0 + 60_000 })
    assert.equal(first.code, 0, first.err)
    assert.equal(second.code, 0, second.err)
    assert.equal(JSON.parse(second.out).sources.every((s) => s.skipped === 'closed'), true)
    assert.equal(ledgerRecords(w).filter((r) => r.kind === 'tick').length, 6)
    // A source with no adapter fails its tick; the other two still ran.
    const w2 = world()
    const run = must(() => M.runTick({ ledgerDir: w2.ledgerDir, build: { install: 'pinned', commit: 'a'.repeat(40), daemon_version: '0.11.10' }, stateFile: w2.stateFile, registryDir: w2.registryDir, projectsDir: w2.projectsDir, now: T0, adapters: [M.createStateFileAdapter({ path: w2.stateFile })] }))
    assert.deepEqual(run.failed, ['claude-session-registry', 'claude-transcript'])
    assert.deepEqual(run.sources.filter((s) => s.ok).map((s) => s.source), ['chroxy-state-file'])
    assert.deepEqual(run.sources.filter((s) => !s.ok).map((s) => [s.error, s.code]), [['Error', null], ['Error', null]])
  },
  {
    'a failing source stops the run': [edit(R, "sources.push({ source, ok: false, error: err?.name ?? 'Error', code: typeof err?.code === 'string' ? err.code : null })", 'throw err')],
    'the failure code is not reported': [edit(R, "code: typeof err?.code === 'string' ? err.code : null", 'code: undefined')],
    'a failing source is counted as ok': [edit(R, 'failed: sources.filter((s) => !s.ok).map((s) => s.source)', 'failed: []')],
  },
)

proves(
  'default paths resolve as the daemon resolves them, and each can be overridden',
  (M) => {
    const root = fs.realpathSync.native(world().root)
    const cfg = path.join(root, 'chroxy-home')
    const claude = path.join(root, 'claude-home')
    fs.mkdirSync(claude)
    const d = withEnv({ CHROXY_CONFIG_DIR: cfg, CLAUDE_CONFIG_DIR: claude }, () => M.defaultSourcePaths(process.env))
    assert.deepEqual(d, { stateFile: path.join(cfg, 'session-state.json'), registryDir: path.join(claude, 'sessions'), projectsDir: path.join(claude, 'projects') })
  },
  {
    'the state file has another name': [edit(R, "configPath('session-state.json')", "configPath('state.json')")],
    'the registry is read from the projects directory': [edit(R, "path.join(claudeConfigDir(env), 'sessions')", "path.join(claudeConfigDir(env), 'projects')")],
    'the projects directory ignores the claude config dir': [edit(R, 'projectsDir: claudeProjectsDir(env)', "projectsDir: path.join(path.dirname(configPath('x')), 'projects')")],
  },
)
