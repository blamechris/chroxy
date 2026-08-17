#!/usr/bin/env node
/**
 * Lint: "was this module run directly?" has exactly three implementations, and
 * no file outside them may answer that question by hand (#7235).
 *
 * ## Why this exists
 *
 * #7198 was the same guard hand-rolled in four files, three of which were
 * WRONG. Its failure mode is silence: the guard reads false, `main()` never
 * runs, the process exits 0, and nothing distinguishes that from a clean no-op.
 * #7213 removed the copies; #7222 added a drift gate
 * (`scripts/__tests__/is-entry-point.test.mjs`) keeping the three that cannot be
 * merged identical to each other.
 *
 * That closed the INSTANCE, not the FAILURE MODE. The drift gate iterates a
 * hardcoded three-element `GUARD_COPIES` list, so a FOURTH copy appearing
 * anywhere is invisible to it — "the list that stopped growing", which
 * docs/false-safety-guards.md names as its own recurring defect (#7192, #7197).
 * This lint is the half the drift gate cannot cover: it looks at the whole
 * repo and fails on any entry-point determination that is not one of the three.
 *
 * The two gates are complements, not duplicates. The drift gate says "the three
 * agree"; this one says "there are only three".
 *
 * ## What is banned
 *
 * Reading the interpreter's script slot — argv index 1 — in any of these
 * spellings, on comment-stripped source:
 *
 *   1. `argv1-index`       — the index read. The shape all four #7198 copies had.
 *   2. `argv1-at`          — the same read spelled `.at(1)`.
 *   3. `argv1-destructure` — `const [, script] = process.argv`, which binds the
 *                            same slot without ever naming the index.
 *   4. `import-meta-main`  — Node's native answer, and unusable here. It landed
 *                            in 22.18.0; the declared engines floor is
 *                            `"node": ">=22"`, so on 22.0–22.17 it is plain
 *                            `undefined` — a falsy guard on a SUPPORTED runtime,
 *                            which is exactly the silent exit-0 no-op above,
 *                            reintroduced as a version skew no CI job pinned to
 *                            `node-version: 22` would ever show. See the header
 *                            of scripts/lib/is-entry-point.mjs; when the floor
 *                            moves to >=22.18 this rule is what should be
 *                            deleted first.
 *
 * The fix for any of them is the same: import `isEntryPoint` from
 * `src/utils/is-entry-point.js` (server) or `scripts/lib/is-entry-point.mjs`
 * (repo scripts).
 *
 * ## NOT matched, deliberately
 *
 *   - `require.main === module`. The CommonJS idiom compares module objects, so
 *     the symlink trap that produced #7198 cannot reach it. It is correct; there
 *     is nothing to ban.
 *   - `process.argv.slice(2)` and friends. Ordinary argument parsing never
 *     touches the script slot.
 *   - A rest element in the first position — `const [, ...rest] = process.argv`.
 *     It reaches the slot, but as argument collection rather than as an identity
 *     comparison, and flagging it would cost a false positive in a REQUIRED
 *     check for a shape no guard has ever been written in. A guard hiding there
 *     would still have to compare `rest[0]` against something, which review sees.
 *   - `.sh` sources. `scripts/docker-entrypoint.sh` passes a config path as the
 *     first argument to `node -e`, where argv index 1 means something else
 *     entirely. Shell is not scanned and this file's name does not claim it is
 *     (#7239's lesson: a gate must not overclaim in its own title).
 *   - Anything inside a `//` or block comment. This matters — every copy of the
 *     guard, and this file, discuss the banned shapes in prose.
 *
 * ## Exemptions
 *
 * `SANCTIONED` is the three guard copies — imported from
 * `scripts/lib/entry-point-guard-copies.mjs`, the SAME list the drift gate
 * iterates, so the two gates cannot end up disagreeing about which files they
 * are talking about — plus the tests that must drive argv[1] to assert anything.
 *
 * It is checked in BOTH directions: an entry whose file has no guard left in it
 * FAILS as stale, the same ratchet `lint-config-dir.mjs` applies to its
 * baseline. An allowlist that keeps granting an exemption nothing needs is how
 * the next regression lands unnoticed.
 *
 * Note the asymmetry that makes a hardcoded list safe HERE and unsafe in the
 * drift gate: this list is the set of things EXEMPT from a repo-wide walk. If it
 * falls behind, a sanctioned file starts failing — loudly, in a required check.
 * The drift gate's list was the set of things CHECKED, so falling behind made it
 * quieter. Same data structure, opposite failure direction. Sharing the list
 * means the safe direction now covers the unsafe one.
 *
 * A single site can also be exempted with `// lint-ignore-entry-point-guard` in
 * a comment on the line immediately above it.
 *
 * ## A note on this file's own text
 *
 * Comments are stripped before matching but STRING LITERALS ARE NOT, so no
 * message or regex below may spell the banned shapes literally in a string, or
 * the lint fails itself. The rule patterns are regex literals (escaped, so they
 * do not match themselves) and the diagnostics say "argv[1]" without the
 * `process.` prefix. That is load-bearing, not styling.
 *
 * ## Exit codes
 *
 *   0 — no hand-rolled guard outside the sanctioned set
 *   1 — at least one offender, or a stale allowlist entry
 *   2 — the lint could not do its job (bad flags, missing root, a sanctioned
 *       path that does not exist, or too few files walked). Distinct from 1 on
 *       purpose: "the guard broke" must never read as "the guard passed", and
 *       must not read as "the code is dirty" either.
 *
 * ## Flags
 *
 *   --repo-root <path>  Tree to walk. Defaults to the repo root. The tests point
 *                       it at a fixture tree so production and test run the
 *                       SAME walk rather than two implementations of one.
 *   --allow <relpath>   Replace the sanctioned allowlist. REPEATABLE.
 *   --min-files <n>     Exit 2 if fewer than n files were walked. A FLOOR, not a
 *                       count — it only ever fails closed.
 *   --dry-run           Print offenders without failing the exit code.
 *
 * Issue: #7235. Background: #7198, #7213, #7222, #7226.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stripComments } from './lib/strip-comments.mjs'
// The repo-root module, not a local copy: the drift gate in
// scripts/__tests__/is-entry-point.test.mjs imports the same list, so the two
// gates cannot end up talking about different sets of files. See its header.
import { GUARD_COPIES } from '../../../scripts/lib/entry-point-guard-copies.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']
const IGNORE_MARKER = 'lint-ignore-entry-point-guard'

// Directories the walk never descends into. Over-denying is caught by
// --min-files; under-denying only costs time, so this errs toward small.
// `.claude` is here for a specific reason: the main checkout keeps live git
// worktrees under `.claude/worktrees/`, and walking those would scan several
// entire copies of the repo.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage',
  '.next', '.expo', '.turbo', 'target', 'Pods', '.venv', 'venv',
])

/**
 * Tests that must drive argv[1] to have anything to assert.
 *
 * The first two pin the guard itself. `lint-entry-point-guard.test.js` carries
 * the offending shapes as fixture text and proves THIS lint against them by
 * running it as a child process — that exemption is the one hole in the walk,
 * and it is listed here rather than hidden so a reader can see how narrow it is.
 *
 * Kept separate from GUARD_COPIES because these are not guards: adding a file
 * here exempts it from the walk, while adding one there also opts it into the
 * drift gate's character-for-character comparison.
 */
const TEST_EXEMPTIONS = [
  'scripts/__tests__/is-entry-point.test.mjs',
  'packages/server/tests/is-entry-point.test.js',
  'packages/server/tests/lint-entry-point-guard.test.js',
]

/** The complete set of files allowed to determine entry-point-ness by hand. */
const SANCTIONED = [...GUARD_COPIES, ...TEST_EXEMPTIONS]

/** Bad usage, or a broken walk — the lint could not run. Exit 2, never 0 or 1. */
function usageError(message) {
  console.error(`lint-entry-point-guard: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const out = { repoRoot: null, allow: [], minFiles: null, dryRun: false }
  const needsValue = (flag, value) => {
    if (value === undefined) usageError(`${flag} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--repo-root') out.repoRoot = needsValue(arg, argv[++i])
    else if (arg === '--allow') out.allow.push(needsValue(arg, argv[++i]))
    else if (arg === '--min-files') out.minFiles = Number(needsValue(arg, argv[++i]))
    else if (arg === '--dry-run') out.dryRun = true
    // An unknown flag must never be silently ignored: a typo'd --repo-root would
    // otherwise walk the REAL repo and report on something the caller never
    // asked about, green (#7239).
    else usageError(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (out.minFiles !== null && (!Number.isInteger(out.minFiles) || out.minFiles < 0)) {
    usageError('--min-files requires a non-negative integer')
  }
  return out
}

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walk(join(dir, ent.name), out)
    } else if (ent.isFile() && SCANNED_EXTENSIONS.some((ext) => ent.name.endsWith(ext))) {
      out.push(join(dir, ent.name))
    }
  }
  return out
}

// There is deliberately NO cheap prefilter over the raw text here. One was
// written — skip any file whose raw source contains neither `argv` nor
// `import.meta.main` — and it is unsound in the one direction that matters: a
// comment INSIDE the expression (`import.me/* */ta.main`) leaves the raw text
// without the substring while the stripped text still matches a rule, so the
// file is skipped and the lint reports clean. That is "silently skipped an
// input", the fourth false-safety mode in docs/false-safety-guards.md. It bought
// 260ms on a 1900-file walk (0.14s vs 0.40s), which is not a price worth paying
// for a gate that runs once per push. Strip everything, match everything.

// Every rule matches against comment-stripped source, and `\s*` spans newlines,
// so a shape broken across lines is caught the same as a one-liner.
const RULES = [
  {
    kind: 'argv1-index',
    re: /\bprocess\s*\.\s*argv\s*\[\s*1\s*\]/g,
    hint: 'reads the script slot directly',
  },
  {
    kind: 'argv1-at',
    re: /\bprocess\s*\.\s*argv\s*\.\s*at\s*\(\s*1\s*\)/g,
    hint: 'reads the script slot via .at(1)',
  },
  {
    kind: 'import-meta-main',
    re: /\bimport\s*\.\s*meta\s*\.\s*main\b/g,
    hint: 'is `undefined` on Node 22.0-22.17, which this package still supports',
  },
]

// `const [, script] = process.argv` binds the script slot without naming an
// index, so no amount of index-matching finds it. Captured as the bracket body
// and decided by position below.
const DESTRUCTURE_RE = /\b(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*process\s*\.\s*argv\b/g

/**
 * Does an array-destructuring pattern bind position 1 to a plain name?
 *
 * `[, script]` and `[node, script]` do. `[,, cmd]` (a hole at 1) and
 * `[, ...rest]` (documented above as out of scope) do not.
 */
function bindsScriptSlot(bracketBody) {
  const elements = bracketBody.split(',')
  if (elements.length < 2) return false
  const atOne = elements[1].trim()
  return atOne !== '' && !atOne.startsWith('...')
}

/** Is the marker a real directive on this line, rather than prose mentioning it? */
function isIgnoreDirective(rawLine) {
  return new RegExp(`^\\s*(?://|\\*|/\\*)\\s*${IGNORE_MARKER}\\b`).test(rawLine)
}

/** 1-based line number of `index` within `text`. */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

function findInFile(file, rel) {
  const raw = readFileSync(file, 'utf8')
  const code = stripComments(raw)
  const rawLines = raw.split('\n')
  const hits = []

  const record = (kind, index, hint) => {
    const line = lineOf(code, index)
    // The marker sits on the line ABOVE the offending site, matching the
    // convention the other lints use.
    if (line > 1 && isIgnoreDirective(rawLines[line - 2])) return
    hits.push({ file: rel, line, kind, hint, text: (rawLines[line - 1] || '').trim() })
  }

  for (const { kind, re, hint } of RULES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(code)) !== null) record(kind, m.index, hint)
  }

  DESTRUCTURE_RE.lastIndex = 0
  let d
  while ((d = DESTRUCTURE_RE.exec(code)) !== null) {
    if (bindsScriptSlot(d[1])) {
      record('argv1-destructure', d.index, 'binds the script slot by position')
    }
  }

  return hits
}

const args = parseArgs(process.argv.slice(2))
const root = resolve(args.repoRoot ?? REPO_ROOT)
const sanctioned = args.allow.length ? args.allow : SANCTIONED

if (!existsSync(root)) usageError(`--repo-root does not exist: ${root}`)

// A sanctioned path that no longer exists means the allowlist is describing a
// tree that is gone. Exit 2 rather than 1: nothing about the CODE is wrong, the
// GUARD's premises are.
for (const rel of sanctioned) {
  if (!existsSync(join(root, rel))) {
    usageError(`sanctioned path does not exist under ${root}: ${rel}. `
      + 'The allowlist is stale — fix it before trusting this run.')
  }
}

let files
try {
  files = walk(root).sort()
} catch (err) {
  usageError(`cannot walk ${root}: ${err.message}`)
}

// "Walked zero files" and "walked 1963 clean files" must not be the same
// observable outcome — docs/false-safety-guards.md calls that the least-solved
// failure mode in this repo.
if (files.length === 0) {
  usageError(`walked 0 files under ${root} — refusing to report a clean tree`)
}
if (args.minFiles !== null && files.length < args.minFiles) {
  usageError(`walked only ${files.length} file(s), expected at least ${args.minFiles}. `
    + 'Either the walk broke or --min-files is stale.')
}

const exempt = new Set(sanctioned)
const offenders = []
const guardedSanctioned = new Set()

for (const file of files) {
  const rel = relative(root, file).split(pathSep).join('/')
  const hits = findInFile(file, rel)
  if (!hits.length) continue
  if (exempt.has(rel)) {
    guardedSanctioned.add(rel)
    continue
  }
  offenders.push(...hits)
}

// The other direction of the ratchet: an exemption nothing needs is an
// exemption the next regression hides behind.
const staleAllowlist = sanctioned.filter((rel) => !guardedSanctioned.has(rel))

for (const o of offenders) {
  console.error(`${o.file}:${o.line}  [${o.kind}]  ${o.text}`)
}
if (offenders.length) {
  console.error('')
  console.error(`${offenders.length} hand-rolled entry-point determination(s) outside the ${sanctioned.length} sanctioned file(s).`)
  console.error('')
  console.error('Deciding "was this module run directly?" by hand is #7198: three of the four')
  console.error('copies were wrong, and the failure is SILENT — the guard reads false, main()')
  console.error('never runs, and the process exits 0. Import the shared guard instead:')
  console.error('')
  console.error("  server sources:  import { isEntryPoint } from './utils/is-entry-point.js'")
  console.error("  repo scripts:    import { isEntryPoint } from './lib/is-entry-point.mjs'")
  console.error('')
  console.error(`If a site genuinely needs argv[1] for something else, put a \`// ${IGNORE_MARKER}\``)
  console.error('comment on the line above it and say why.')
}

for (const rel of staleAllowlist) {
  console.error(`${rel}: allowlisted as a sanctioned guard but contains none — remove the entry.`)
}
if (staleAllowlist.length) {
  console.error('')
  console.error('A sanctioned copy that lost its guard is either a bug or a deletion nobody')
  console.error('updated the allowlist for. Either way the exemption now shields whatever')
  console.error('lands in that file next.')
}

const failed = offenders.length > 0 || staleAllowlist.length > 0
if (!failed) {
  console.log(`OK: ${files.length} file(s) walked; entry-point-ness is decided in ${sanctioned.length} sanctioned file(s) only.`)
}
process.exit(failed && !args.dryRun ? 1 : 0)
