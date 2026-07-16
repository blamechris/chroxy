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

const { deriveDescription, detectUncompiledAgents, emitPi, ALL_TARGETS } = await import(helperPath)

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

// Count visible glyphs (grapheme clusters), not UTF-16 code units — the unit the
// cap is measured in since #6261.
const countGraphemes = (s) =>
  [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length

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

// --- Test 6: the 160-char cap boundary (passthrough at 160, cut at 161) ----
// Pins the off-by-one most likely to regress on a future refactor of the cap:
// a no-period string of exactly 160 chars is returned untouched (no ellipsis),
// while 161 truncates on the word boundary and stays within the cap.
await test('passes a 160-char string through but truncates at 161 on a word boundary', async () => {
  const at160 = 'a'.repeat(80) + ' ' + 'b'.repeat(79) // length 160, no period
  const passthrough = deriveDescription(at160, 'demo')
  assert(passthrough === at160, `160-char string should pass through untouched, got length ${passthrough.length}`)
  assert(!passthrough.endsWith('...'), '160-char string must not get an ellipsis')

  const at161 = 'a'.repeat(80) + ' ' + 'b'.repeat(80) // length 161, no period
  const truncated = deriveDescription(at161, 'demo')
  assert(truncated.endsWith('...'), 'a 161-char string should be truncated')
  assert(truncated.length <= 160, `truncated string should respect the cap, got length ${truncated.length}`)
  assert(truncated === 'a'.repeat(80) + '...', `should cut at the word boundary, got: ${JSON.stringify(truncated)}`)
})

// --- Test 7: grapheme-aware cap — a ZWJ sequence counts as ONE glyph (#6261) -
// A "family" emoji is a single grapheme cluster but 7 code points / 11 UTF-16
// code units. 30 of them is 30 graphemes (well under the 160 cap) yet 330 code
// units (well over it). A code-unit cap would wrongly truncate — and slice a
// family mid-ZWJ-sequence; a grapheme cap leaves the string untouched.
await test('counts a ZWJ emoji sequence as one glyph and does not truncate under the cap', async () => {
  const family = '👨‍👩‍👧‍👦' // 1 grapheme, 7 code points, 11 UTF-16 code units
  const body = family.repeat(30) // 30 graphemes / 330 code units
  assert(countGraphemes(body) === 30 && body.length === 330, 'fixture sanity: 30 graphemes, 330 code units')
  const desc = deriveDescription(body, 'demo')
  assert(desc === body, `a 30-grapheme string must pass through untouched (a UTF-16 cap would truncate it), got length ${desc.length}`)
  assert(!desc.endsWith('...'), 'must not truncate a 30-grapheme description')
})

// --- Test 8: grapheme-aware cut — a space-less emoji run never splits a pair --
// 200 emoji with no spaces to break on must hard-cut on a cluster boundary. A
// UTF-16 slice at 157 units would bisect emoji #79's surrogate pair and leak a
// lone high surrogate; a grapheme cut keeps every emoji whole.
await test('hard-cuts a space-less emoji run on a cluster boundary, never a lone surrogate', async () => {
  const emoji = '😀' // 1 grapheme, 2 UTF-16 code units
  const body = emoji.repeat(200)
  const desc = deriveDescription(body, 'demo')
  assert(desc.endsWith('...'), `should truncate a 200-emoji run, got: ${JSON.stringify(desc.slice(0, 12))}…`)
  const visible = desc.slice(0, -3) // strip the ASCII ellipsis
  // Strip valid surrogate PAIRS; any surviving surrogate code unit is a lone
  // (split) surrogate — the signature of a mid-cluster cut.
  const stripped = visible.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
  assert(!/[\uD800-\uDFFF]/.test(stripped), 'a lone surrogate leaked — the cut sliced mid-cluster')
  assert([...visible].every((ch) => ch === emoji), 'every visible glyph must be a whole emoji')
  assert(countGraphemes(visible) <= 160, `visible text must respect the 160-grapheme cap, got ${countGraphemes(visible)}`)
})

// --- detectUncompiledAgents (#6571) ---------------------------------------
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pjoin } from 'node:path'

await test('detectUncompiledAgents flags ONLY codex (gemini is repo-local, never flagged even with ~/.gemini present)', () => {
  const home = mkdtempSync(pjoin(tmpdir(), 'skill-home-'))
  try {
    mkdirSync(pjoin(home, '.codex'))
    mkdirSync(pjoin(home, '.gemini')) // present but IRRELEVANT — gemini compiles into the repo, not ~/.gemini
    const out = detectUncompiledAgents(['claude'], home)
    assert(out.includes('codex'), `expected codex flagged, got ${JSON.stringify(out)}`)
    assert(!out.includes('gemini'), 'gemini is repo-local + in the default target list — a ~/.gemini dir must NOT be a hint')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('detectUncompiledAgents does NOT flag a target that IS selected', () => {
  const home = mkdtempSync(pjoin(tmpdir(), 'skill-home-'))
  try {
    mkdirSync(pjoin(home, '.codex'))
    const out = detectUncompiledAgents(['claude', 'gemini', 'codex'], home)
    assert(out.length === 0, `codex is selected, expected [], got ${JSON.stringify(out)}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('detectUncompiledAgents returns nothing when no agent home dirs exist', () => {
  const home = mkdtempSync(pjoin(tmpdir(), 'skill-home-'))
  try {
    const out = detectUncompiledAgents(['claude'], home)
    assert(out.length === 0, `no agent dirs present, expected [], got ${JSON.stringify(out)}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// --- Pi target (#6573) ----------------------------------------------------

await test('pi is a known compile target', () => {
  assert(ALL_TARGETS.includes('pi'), `expected 'pi' in ALL_TARGETS, got ${JSON.stringify(ALL_TARGETS)}`)
})

await test('emitPi writes ~/.pi/agent/skills/<name>/SKILL.md with name + description frontmatter', () => {
  const out = emitPi('demo-skill', '# Body\nDo the thing.\n', 'Does the thing.')
  assert(/[/\\]\.pi[/\\]agent[/\\]skills[/\\]demo-skill[/\\]SKILL\.md$/.test(out.path), `unexpected path: ${out.path}`)
  // Pi REQUIRES a `name` field matching the parent dir (unlike the claude emitter).
  assert(out.content.startsWith('---\nname: demo-skill\ndescription: '), `missing name/description frontmatter:\n${out.content}`)
  assert(out.content.includes('# Body\nDo the thing.'), 'body must pass through verbatim')
  assert(/\/skill:demo-skill/.test(out.note), `note should document /skill: invocation, got: ${out.note}`)
})

await test('emitPi warns when the body uses arg tokens Pi will not substitute', () => {
  const withArgs = emitPi('a', 'Summarize $ARGUMENTS please\n', 'x')
  assert(withArgs.warn && /not substituted/i.test(withArgs.warn), `expected an arg-token warning, got: ${withArgs.warn}`)
  const noArgs = emitPi('b', 'No args here\n', 'x')
  assert(!noArgs.warn, `expected no warning for an arg-free body, got: ${noArgs.warn}`)
})

await test('emitPi does not warn for an arg token inside a fenced code block (but does in prose)', () => {
  // Use `$1` — a token that DOES match the warn regex — so the test actually
  // exercises the code-fence stripping rather than passing trivially.
  const fenced = emitPi('c', 'Run it:\n```bash\necho $1\n```\n', 'x')
  assert(!fenced.warn, `a bare $1 inside a code fence must not warn, got: ${fenced.warn}`)
  const prose = emitPi('c', 'Pass echo $1 to the tool\n', 'x')
  assert(prose.warn && /not substituted/i.test(prose.warn), `a bare $1 in prose must warn, got: ${prose.warn}`)
})

await test('emitPi warns on a non-Pi-valid skill name (Pi rejects it at load)', () => {
  for (const bad of ['My_Skill', 'has space', '-leading', 'trailing-', 'double--hyphen', 'UPPER']) {
    const out = emitPi(bad, 'body\n', 'x')
    assert(out.warn && /not Pi-valid/.test(out.warn), `expected a name-format warning for "${bad}", got: ${out.warn}`)
  }
  const ok = emitPi('good-name-123', 'body\n', 'x')
  assert(!ok.warn || !/not Pi-valid/.test(ok.warn), `a valid kebab name must not warn, got: ${ok.warn}`)
})

await test('detectUncompiledAgents flags an installed-but-unselected pi (~/.pi)', () => {
  const home = mkdtempSync(pjoin(tmpdir(), 'skill-home-'))
  try {
    mkdirSync(pjoin(home, '.pi'))
    const out = detectUncompiledAgents(['claude', 'gemini'], home)
    assert(out.includes('pi'), `expected pi flagged, got ${JSON.stringify(out)}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
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
