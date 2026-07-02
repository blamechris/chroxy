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

import { dirname, resolve } from 'node:path'
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

// --- summary --------------------------------------------------------------
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  }
  process.exit(1)
}
process.exit(0)
