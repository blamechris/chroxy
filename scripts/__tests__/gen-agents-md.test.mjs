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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

// --- summary --------------------------------------------------------------
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  }
  process.exit(1)
}
process.exit(0)
