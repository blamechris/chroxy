#!/usr/bin/env node
/**
 * Lint: every `new SessionManager(...)` call in `packages/server/tests/`
 * must include `stateFilePath`. Otherwise the manager defaults to
 * `~/.chroxy/session-state.json` and the test silently writes to the
 * developer's (or CI runner's) real user state file.
 *
 * The sandbox guard in `tests/_setup.mjs` (loaded via `node --import`)
 * patches the write-side of `fs` to throw if any path resolves under the
 * real `~/.chroxy` or `~/.claude` tree — it does NOT override `HOME`. The
 * explicit `stateFilePath` option is still required so the intent is
 * obvious in review and a future setup-hook regression cannot reintroduce
 * the original bug class.
 *
 * Issue: #4633. Prior incidents: #2314, #429, 2026-05-30 contamination.
 *
 * ## Comment/string-awareness and the loud-unparseable rule (#7567)
 *
 * The offender check walks each `new SessionManager(...)` call to its
 * matching `)` and then asks whether `stateFilePath` appears inside. That
 * walk is a small string/paren state machine, and it used to have no idea
 * what a comment was: a single apostrophe in a `//` or `/* *\/` comment that
 * happened to sit inside the call's paren range opened a phantom string that
 * never closed, the walk ran off the end and returned -1, and the caller then
 * SILENTLY dropped the site (`if (closeParen === -1) continue`). A
 * `new SessionManager(...)` missing `stateFilePath` next to an apostrophe-in-a-
 * comment therefore sailed straight through the guard — the exact false-safety
 * class `docs/false-safety-guards.md` catalogues, where "cannot check this"
 * and "nothing to check here" are the same observable outcome.
 *
 * Four changes close it:
 *   1. Comments are blanked up front with the shared, parser-backed stripper
 *      (`./lib/strip-comments.mjs`, #7248 — it preserves every offset, so
 *      `file:line` stays exact). Quotes inside a comment can no longer toggle
 *      string state, and a `new SessionManager(` that lives inside a comment is
 *      no longer matched at all (which is what the old `isInsideComment` helper
 *      was for — now redundant).
 *   2. String / template / regex literal VALUES are blanked too
 *      (`blankStringLiterals` below, also parser-backed so a regex literal is
 *      never mistaken for a comment or division). The shared comment stripper
 *      deliberately leaves strings intact, but this lint must not: a
 *      `new SessionManager({` written inside an assertion-message STRING (there
 *      is one in environment-session-wiring.test.js) is prose, not a
 *      construction site, and matching the needle there both mis-reported it
 *      and — once (3) makes the walk loud — would fail the real tree. Property
 *      KEYS are the exception and stay intact: blanking the quoted key in
 *      `new SessionManager({ 'stateFilePath': … })` would erase the very
 *      identifier the check looks for and falsely flag a correct site.
 *   3. The construction site is found with a whitespace-tolerant regex
 *      (`\bnew\s+${ctor}\b\s*\(`) rather than a fixed `new ${ctor}(` substring.
 *      The substring demanded the `(` immediately after the name, so a legal
 *      `new SessionManager (…)` or a `new SessionManager /* x *\/(…)` (the
 *      comment blanked to spaces) was never found — again a missing option
 *      silently skipped.
 *   4. A site whose parens STILL cannot be balanced after (1) and (2) (a
 *      genuinely malformed construction the walker cannot verify) is collected
 *      into `unparseable` and reported LOUDLY with a distinct diagnostic and a
 *      non-zero exit — it is never silently skipped. "The lint could not check
 *      this" must fail, not pass.
 *
 * Exit codes:
 *   0 — every `new SessionManager(...)` in tests passes `stateFilePath`
 *   1 — at least one offender found (printed with file:line)
 *   2 — the lint could not do its job: bad flags, a missing/empty tests dir,
 *       an unloadable parser, or a construction site whose parens cannot be
 *       balanced (so its required option cannot be verified). Distinct from 1
 *       on purpose — "the guard failed" must never read as "the guard passed",
 *       and it must not read as "the code is dirty" either. Never silenced by
 *       DRY_RUN.
 *
 * Flags:
 *   --tests-dir <path>  Directory to scan. Defaults to `packages/server/tests`.
 *
 * Set `DRY_RUN=1` to list offenders without failing the exit code (does NOT
 * silence an unparseable site — that stays loud).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Dynamic, so an unloadable dependency exits 2 ("the lint could not run")
// rather than 1 ("the tree is dirty"). A static import cannot be caught, and an
// uncaught ESM resolution error exits 1. Same reasoning as lint-config-dir.mjs.
let stripComments
let ts
try {
  ({ stripComments } = await import('./lib/strip-comments.mjs'))
  ts = (await import('typescript')).default
} catch (err) {
  console.error(`lint-tests-state-file-path: cannot load a parser dependency: ${err.message}`)
  process.exit(2)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TESTS_DIR = resolve(__dirname, '..', 'tests')

/** Bad usage / the lint could not run. Exit 2, never 0 and never 1. */
function usageError(message) {
  console.error(`lint-tests-state-file-path: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const out = { testsDir: null }
  const needsValue = (flag, value) => {
    if (value === undefined) usageError(`${flag} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--tests-dir') out.testsDir = needsValue(arg, argv[++i])
    // An unknown flag must not be silently ignored, or `--testdir /tmp/fixture`
    // (a typo) would scan the real tests/ and report on the wrong tree.
    else usageError(`unknown argument ${JSON.stringify(arg)}`)
  }
  return out
}

function walk(dir, acc = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (st.isFile() && p.endsWith('.test.js')) acc.push(p)
  }
  return acc
}

// A string/template literal that is a PROPERTY KEY, not a value. Blanking a
// key erases the very identifier the offender check looks for: a legal
// `new SessionManager({ 'stateFilePath': tmpStateFile() })` would have its
// quoted key blanked to spaces and be FALSELY reported as an offender (#7567
// review). Value/argument strings stay blanked — that is what keeps a
// `new SessionManager({` written inside an assertion-message string from being
// mis-detected as a construction site.
function isPropertyKey(node) {
  const p = node.parent
  if (!p) return false
  // `{ ['stateFilePath']: v }` — the literal is the computed name.
  if (ts.isComputedPropertyName(p)) return true
  // The literal is the `name` of a property-like member: `{ 'k': v }`,
  // `{ 'k'() {} }`, class fields/accessors, enum members, TS signatures.
  const nameHolders = [
    ts.isPropertyAssignment,
    ts.isPropertySignature,
    ts.isPropertyDeclaration,
    ts.isMethodDeclaration,
    ts.isMethodSignature,
    ts.isGetAccessorDeclaration,
    ts.isSetAccessorDeclaration,
    ts.isEnumMember,
  ]
  return nameHolders.some((is) => is(p)) && p.name === node
}

// Blank string / template / regex literal spans to spaces, preserving newlines
// and every offset (same contract as stripComments). Parser-backed, so a `/`
// that starts a regex literal is never confused with division or a comment —
// the exact regex-blindness #7248 warned about. Template INTERPOLATION
// expressions (`${ ... }`) are real code and stay intact; only the literal text
// tokens (head/middle/tail and the surrounding backticks) are blanked. Property
// KEYS are left intact too (see isPropertyKey).
function blankStringLiterals(src, fileName) {
  // setParentNodes so isPropertyKey can inspect node.parent.
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const spans = []
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        if (!isPropertyKey(node)) spans.push([node.getStart(sf), node.getEnd()])
        break
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        spans.push([node.getStart(sf), node.getEnd()])
        break
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  spans.sort((a, b) => a[0] - b[0])

  let out = ''
  let cursor = 0
  for (const [start, end] of spans) {
    if (start < cursor) continue
    out += src.slice(cursor, start)
    out += src.slice(start, end).replace(/[^\n]/g, ' ')
    cursor = end
  }
  out += src.slice(cursor)

  if (out.length !== src.length) {
    // A length change would shift every offset, so `file:line` would be wrong in
    // a way nothing downstream can detect — fail rather than mis-report.
    throw new Error(`blanking string literals in ${fileName} changed its length (${src.length} -> ${out.length}).`)
  }
  return out
}

// Walk from an opening `(` to its matching `)`. This is a PURE paren counter:
// comments AND string/template/regex literals are already blanked to spaces by
// the caller before this sees the source, so every `(` and `)` left standing is
// real code. It deliberately does NOT track string state — the old quote
// tracking was dead once blanking runs, and worse, a stray quote surviving a TS
// regex-misparse edge could falsely open a phantom string and drive a SPURIOUS
// exit-2 on valid code (#7567 review). A -1 return means the construction is
// genuinely unbalanced, which the caller treats as loud-unparseable rather than
// a silent skip.
function findMatchingParen(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// Constructor → required option in tests. Each entry pins a state-bearing
// class whose default writes under `~/.chroxy/`. Adding more entries here is
// the right move when a new class joins the bug class.
const RULES = [
  { ctor: 'SessionManager', requiredOpt: 'stateFilePath', helper: 'tmpStateFile()' },
  { ctor: 'CheckpointManager', requiredOpt: 'checkpointsDir', helper: 'a tmp directory (mkdtempSync)' },
]

const args = parseArgs(process.argv.slice(2))
const TESTS_DIR = resolve(args.testsDir ?? DEFAULT_TESTS_DIR)
if (!existsSync(TESTS_DIR)) usageError(`tests dir does not exist: ${TESTS_DIR}`)
// A path that exists but is a FILE would sail past existsSync and then make
// walk()'s readdirSync throw ENOTDIR uncaught — exit 1, i.e. "the tree is
// dirty", when the truth is "you pointed me at a bad dir" (exit 2).
if (!statSync(TESTS_DIR).isDirectory()) usageError(`--tests-dir is not a directory: ${TESTS_DIR}`)

const offenders = []
const unparseable = []
let scanned = 0
for (const file of walk(TESTS_DIR)) {
  scanned++
  const raw = readFileSync(file, 'utf8')
  // Blank comments then string literals (offsets preserved by both) BEFORE the
  // paren walk, so a quote in a comment cannot open a phantom string, a
  // `new SessionManager(` inside a comment or string is not matched at all, and
  // a paren inside a string cannot skew the depth count. A parser throw is
  // "could not read this file", exit 2 — not an offender (1), not a clean pass.
  let src
  try {
    src = blankStringLiterals(stripComments(raw, file), file)
  } catch (err) {
    usageError(`cannot pre-process ${file}: ${err.message}`)
  }
  for (const { ctor, requiredOpt } of RULES) {
    // A plain `indexOf('new ${ctor}(')` demanded the `(` IMMEDIATELY after the
    // class name, so a legal `new SessionManager (…)` (space) or
    // `new SessionManager /* x */(…)` (comment blanked to spaces → several
    // spaces before the paren) never matched — a site MISSING stateFilePath was
    // silently skipped, "cannot even find it" reading as "nothing to check"
    // (#7567 review). Tolerate whitespace between `new`, the name, and `(`. The
    // `\b` on both sides of the name stop `renew SessionManager(` and
    // `new SessionManagerFoo(` from matching.
    const siteRe = new RegExp(`\\bnew\\s+${ctor}\\b\\s*\\(`, 'g')
    let m
    while ((m = siteRe.exec(src)) !== null) {
      const idx = m.index
      const openParen = idx + m[0].length - 1 // the matched `(`
      const closeParen = findMatchingParen(src, openParen)
      const before = src.slice(0, idx)
      const line = before.split('\n').length
      if (closeParen === -1) {
        // Comments and strings are already blanked, so this is a genuinely
        // unbalanced construction — the walker cannot see the call body, so it
        // cannot verify the required option. That MUST be loud, never a silent
        // `continue`: "cannot check this" is not "nothing to check here", which
        // is exactly how a missing-stateFilePath site used to escape (#7567).
        unparseable.push({ file, line, ctor })
        continue
      }
      const callBody = src.slice(idx, closeParen + 1)
      const optRe = new RegExp(`\\b${requiredOpt}\\b`)
      if (!optRe.test(callBody)) {
        offenders.push({ file, line, ctor, requiredOpt })
      }
    }
  }
}

// Scanning zero files must not read as a clean tree — a renamed or empty tests
// dir would otherwise exit 0 without having checked anything.
if (scanned === 0) {
  usageError(`scanned 0 .test.js files under ${TESTS_DIR} — refusing to report a clean tree`)
}

let exitCode = 0

if (offenders.length) {
  console.error('ERROR: the following test sites construct state-bearing classes without an explicit tmp-path option:')
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  (missing ${o.requiredOpt} in new ${o.ctor}(...))`)
  }
  console.error('')
  for (const { ctor, requiredOpt, helper } of RULES) {
    console.error(`Fix for ${ctor}: pass \`${requiredOpt}: ${helper}\` in the constructor options.`)
  }
  console.error('Pattern: see packages/server/tests/session-manager.test.js (`tmpStateFile()` helper).')
  console.error('Background: issue #4633, packages/server/tests/_setup.mjs.')
  exitCode = process.env.DRY_RUN === '1' ? 0 : 1
}

if (unparseable.length) {
  console.error('')
  console.error('ERROR: could not balance the parentheses of these construction sites, so their required tmp-path option cannot be verified:')
  for (const u of unparseable) {
    console.error(`  ${u.file}:${u.line}  (new ${u.ctor}(...) — unbalanced parens; cannot check)`)
  }
  console.error('')
  console.error('A site the lint cannot parse must NOT be silently skipped — "cannot check" is not "nothing to check" (#7567, docs/false-safety-guards.md).')
  console.error('Fix the source so the call parses, or extend the walker to handle this shape.')
  // Loud regardless of DRY_RUN, and it overrides the offender exit: a guard
  // that could not fully do its job must fail even harder than a dirty tree.
  exitCode = 2
}

if (exitCode === 0) {
  console.log(`OK: every ${RULES.map(r => 'new ' + r.ctor + '(...)').join(' / ')} in tests includes its required tmp-path option`)
}
process.exit(exitCode)
