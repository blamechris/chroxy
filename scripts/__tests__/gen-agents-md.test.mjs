#!/usr/bin/env node
/**
 * gen-agents-md.test.mjs — node test harness for scripts/gen-agents-md.mjs.
 *
 * The load-bearing assertion is the DRIFT check: the committed AGENTS.md must be
 * byte-identical to what the generator produces from the current CLAUDE.md. If
 * someone edits CLAUDE.md without regenerating (or hand-edits AGENTS.md), this
 * fails — the CI gate that keeps the AGENTS.md mirror honest.
 *
 * No external test framework. Run from repo root:
 *   node scripts/__tests__/gen-agents-md.test.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const scriptPath = resolve(__dirname, '..', 'gen-agents-md.mjs')

const { renderAgentsMd, readClaudeMd, readAgentsMd } = await import(scriptPath)

let pass = 0
let fail = 0
const failures = []

const test = async (name, fn) => {
  try {
    await fn()
    pass++
    process.stdout.write(`  ok ${name}\n`)
  } catch (err) {
    fail++
    failures.push({ name, err })
    process.stdout.write(`  FAIL ${name}: ${err.message}\n`)
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed')
}

// --- Test 1: the render embeds the full CLAUDE.md verbatim ----------------
await test('render includes the entire CLAUDE.md body unmodified', async () => {
  const claude = readClaudeMd()
  const out = renderAgentsMd(claude)
  assert(out.includes(claude), 'AGENTS.md must contain CLAUDE.md verbatim (no lossy rewrite)')
  assert(out.endsWith(claude), 'CLAUDE.md must be appended after the generated header')
})

// --- Test 2: the generated file carries the do-not-edit header -------------
await test('render prepends the auto-generated / do-not-edit header', async () => {
  const out = renderAgentsMd(readClaudeMd())
  assert(out.startsWith('<!--'), 'must open with the HTML-comment banner')
  assert(out.includes('AUTO-GENERATED FROM CLAUDE.md'), 'must state it is generated')
  assert(out.includes('node scripts/gen-agents-md.mjs'), 'must tell the reader how to regenerate')
})

// --- Test 3: DRIFT GATE — committed AGENTS.md matches the generator --------
await test('committed AGENTS.md is in sync with CLAUDE.md (drift gate)', async () => {
  const committed = readAgentsMd()
  assert(committed !== null, 'AGENTS.md is missing — run `node scripts/gen-agents-md.mjs`')
  const expected = renderAgentsMd(readClaudeMd())
  assert(
    committed === expected,
    'AGENTS.md is stale — run `node scripts/gen-agents-md.mjs` and commit AGENTS.md'
  )
})


// #7198 — the entry-point guard must survive a symlinked invocation path.
//
// Node's ESM loader resolves symlinks in `import.meta.url` but leaves
// `process.argv[1]` as the caller typed it, and `resolve()` does not follow
// symlinks. On macOS /tmp is a symlink to /private/tmp, so invoking
// `node /tmp/…/gen-agents-md.mjs` compared '/private/tmp/…' against '/tmp/…',
// the guard was false, and the script exited 0 having regenerated NOTHING.
// bump-version.sh calls this and trusts the exit code, so a release could
// silently skip the regeneration and still report success.
await test('runs through a symlinked invocation path (#7198)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genagents-'))
  try {
    // Mirror the real layout: the generator resolves CLAUDE.md / AGENTS.md
    // relative to its own parent directory, i.e. the repo root.
    const root = join(dir, 'root')
    const link = join(dir, 'link')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    symlinkSync(root, link)

    cpSync(scriptPath, join(root, 'scripts', 'gen-agents-md.mjs'))
    cpSync(resolve(__dirname, '..', '..', 'CLAUDE.md'), join(root, 'CLAUDE.md'))
    writeFileSync(join(root, 'AGENTS.md'), 'STALE\n')

    const run = spawnSync(process.execPath, [join(link, 'scripts', 'gen-agents-md.mjs')], { encoding: 'utf8' })
    assert(run.status === 0, `expected exit 0, got ${run.status}: ${run.stderr}`)
    assert(
      readFileSync(join(root, 'AGENTS.md'), 'utf8') !== 'STALE\n',
      'generator silently no-opped when invoked through a symlinked path'
    )

    // --check must FAIL on drift through that same path, not pass silently.
    writeFileSync(join(root, 'AGENTS.md'), 'STALE\n')
    const checked = spawnSync(process.execPath, [join(link, 'scripts', 'gen-agents-md.mjs'), '--check'], { encoding: 'utf8' })
    assert(checked.status === 1, `--check should exit 1 on drift, got ${checked.status}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- #7214: realpath failing must not silently skip the run -----------------
//
// The guard decides "am I the entry point?" from process.argv[1]. When it
// consulted realpath FIRST, any throw was read as "not the entry point", so a
// direct run exited 0 having done nothing — no regeneration, no --check, no
// diagnostic. Same silent no-op as #7198, different trigger.
//
// Reproducing that needs the filesystem to break in the window AFTER node has
// read the script and BEFORE the module body evaluates, which is where the
// guard runs. A `module.register` load hook sits exactly in that window: node
// only has to LOAD the file, not keep it readable afterwards.
const HOOKS = `
import { unlinkSync, chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
export async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (url.endsWith('/gen-agents-md.mjs')) {
    const p = fileURLToPath(url)
    if (process.env.CHROXY_BREAK === 'unlink') unlinkSync(p)
    else if (process.env.CHROXY_BREAK === 'eacces') chmodSync(dirname(p), 0o000)
  }
  return result
}
`
const REGISTER = `
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
`

const withBrokenRealpath = (breakMode, fn) => {
  // realpathSync the tmpdir: on macOS os.tmpdir() is /var/..., a symlink to
  // /private/var. Leaving it symlinked would ALSO trip #7198's non-canonical
  // path case, and the two triggers together are the residual this fix does
  // not claim to cover. Canonicalising isolates #7214.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'genagents-7214-'))
  const scriptsDir = join(dir, 'root', 'scripts')
  try {
    mkdirSync(scriptsDir, { recursive: true })
    cpSync(scriptPath, join(scriptsDir, 'gen-agents-md.mjs'))
    cpSync(resolve(__dirname, '..', '..', 'CLAUDE.md'), join(dir, 'root', 'CLAUDE.md'))
    writeFileSync(join(dir, 'root', 'AGENTS.md'), 'STALE\n')
    writeFileSync(join(dir, 'hooks.mjs'), HOOKS)
    writeFileSync(join(dir, 'register.mjs'), REGISTER)
    fn(spawnSync(
      process.execPath,
      ['--import', join(dir, 'register.mjs'), join(scriptsDir, 'gen-agents-md.mjs'), '--check'],
      { encoding: 'utf8', env: { ...process.env, CHROXY_BREAK: breakMode } },
    ))
  } finally {
    chmodSync(scriptsDir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
}

// Positive control for the two tests below. If the hook does NOT actually break
// realpath, both assertions pass for the wrong reason: the guard works normally,
// --check sees the stale AGENTS.md, and exits 1 either way. That is the vacuous
// pass this whole file exists to distrust, so prove the trigger fires first.
await test('the load hook genuinely breaks realpath (positive control)', async () => {
  withBrokenRealpath('unlink', (run) => {
    assert(run.status !== null, `child did not run at all: ${run.error && run.error.message}`)
  })
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'genagents-ctl-'))
  try {
    const probe = join(dir, 'probe.mjs')
    writeFileSync(probe, 'process.exit(0)\n')
    writeFileSync(join(dir, 'hooks.mjs'), HOOKS.replace(/gen-agents-md\.mjs/g, 'probe.mjs'))
    writeFileSync(join(dir, 'register.mjs'), REGISTER)
    spawnSync(process.execPath, ['--import', join(dir, 'register.mjs'), probe], {
      encoding: 'utf8',
      env: { ...process.env, CHROXY_BREAK: 'unlink' },
    })
    let threw = false
    try {
      realpathSync(probe)
    } catch {
      threw = true
    }
    assert(threw, 'the unlink hook did not make realpathSync throw — the tests below would pass vacuously')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('--check detects drift when the script is unlinked after launch (#7214)', async () => {
  withBrokenRealpath('unlink', (run) =>
    assert(run.status === 1, `--check must exit 1 on drift; got ${run.status} (0 = the silent no-op this guards)`))
})

// chmod 0000 does not deny root, so as root realpath would succeed and this
// would pass without exercising the EACCES path at all — vacuously. Skipped
// rather than silently weakened.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  process.stdout.write('  skip --check detects drift when realpath fails with EACCES (#7214): running as root\n')
} else {
  await test('--check detects drift when realpath fails with EACCES (#7214)', async () => {
    withBrokenRealpath('eacces', (run) =>
      assert(run.status === 1, `--check must exit 1 on drift; got ${run.status} (0 = the silent no-op this guards)`))
  })
}

// --- summary --------------------------------------------------------------
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  }
  process.exit(1)
}
process.exit(0)
