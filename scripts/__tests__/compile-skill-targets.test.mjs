#!/usr/bin/env node
/**
 * compile-skill-targets.test.mjs — node test harness for deriveDescription()
 * in scripts/compile-skill-targets.mjs.
 *
 * No external test framework. Each `test()` block runs in series and pushes
 * pass/fail into a counter. Exit status is 0 if all pass, 1 otherwise.
 *
 * Run from repo root:
 *   node scripts/__tests__/compile-skill-targets.test.mjs
 *
 * Importing the module must NOT run its CLI main() — the module guards the
 * invocation behind an "invoked directly" check so it is safe to import here.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const helperPath = resolve(__dirname, '..', 'compile-skill-targets.mjs')

const { deriveDescription } = await import(helperPath)

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

// A long single sentence with no early period and clearly numbered words, so a
// mid-word cut is detectable: "word001 word002 … word040" (8-char stride).
const numberedWords = (n) =>
  Array.from({ length: n }, (_, i) => `word${String(i + 1).padStart(3, '0')}`).join(' ')

// --- Test 1: long description truncates on a WORD boundary (the #6259 bug) ---
await test('truncates a long single sentence on a word boundary, not mid-word', async () => {
  const body = numberedWords(40) // 319 chars, no period
  const desc = deriveDescription(body, 'demo')

  assert(desc.endsWith('...'), `should end with ellipsis, got: ${JSON.stringify(desc)}`)
  assert(desc.length <= 160, `should respect the 160-char cap, got length ${desc.length}`)

  // The text before the ellipsis must end on a COMPLETE numbered word — a
  // mid-word cut (e.g. "word0...") is the bug we are fixing.
  const visible = desc.slice(0, -3).trimEnd()
  const lastToken = visible.split(' ').pop()
  assert(
    /^word\d{3}$/.test(lastToken),
    `last token before ellipsis must be a whole word, got: ${JSON.stringify(lastToken)}`,
  )
})

// --- Test 2: pathological single over-long word still hard-cuts (no space) ---
await test('hard-cuts a single over-long word with no space to break on', async () => {
  const body = 'x'.repeat(200) // one 200-char "word", no boundary to back off to
  const desc = deriveDescription(body, 'demo')

  assert(desc.endsWith('...'), `should end with ellipsis, got length ${desc.length}`)
  assert(desc.length === 160, `should hard-cut to the cap (157 + '...'), got length ${desc.length}`)
})

// --- Test 3: first sentence is extracted when a period is within the cap ----
await test('extracts the first sentence when it ends within the cap', async () => {
  const body = 'First sentence here. Second sentence that should be dropped.'
  const desc = deriveDescription(body, 'demo')
  assert(desc === 'First sentence here.', `got: ${JSON.stringify(desc)}`)
})

// --- Test 4: a short paragraph passes through unchanged (no ellipsis) -------
await test('passes a short paragraph through without an ellipsis', async () => {
  const body = 'A short skill description'
  const desc = deriveDescription(body, 'demo')
  assert(desc === 'A short skill description', `got: ${JSON.stringify(desc)}`)
  assert(!desc.endsWith('...'), 'short descriptions must not be truncated')
})

// --- Test 5: heading-only / empty body falls back to the project label ------
await test('falls back to a project label when there is no prose', async () => {
  const body = '# Heading only\n\n---\n'
  const desc = deriveDescription(body, 'my-skill')
  assert(desc === 'Project skill: /my-skill', `got: ${JSON.stringify(desc)}`)
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
