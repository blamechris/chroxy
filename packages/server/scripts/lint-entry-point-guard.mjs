#!/usr/bin/env node
/**
 * Lint: "was this module run directly?" has exactly three implementations, and
 * no file outside them may answer that question by hand (#7235).
 *
 * ## Why this exists
 *
 * #7198 and the #7213 sweep found the same guard hand-rolled in four files,
 * across three spellings, and ALL FOUR were wrong the same way — including the
 * `pathToFileURL` form, which looks more careful than the others and is equally
 * broken. Its failure mode is silence: the guard reads false, `main()` never
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
 *   - Anything git does not consider part of the repository — gitignored build
 *     output and ignored local scratch files. An untracked file that is NOT
 *     ignored is still scanned, deliberately: it is on its way to being
 *     committed. A guard has to be COMMITTED to matter, and
 *     `packages/desktop/src-tauri/server-bundle/` is a generated copy of the
 *     whole server that lags the source by however long since it was last built.
 *     See `gitKnownFiles`.
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
 *   --guard-copy <rel>  Which sanctioned files are guard COPIES, subject to the
 *                       equal-site-count check. REPEATABLE. Defaults to
 *                       GUARD_COPIES; empty when --allow is given alone.
 *   --min-files <n>     Exit 2 if fewer than n files were walked. A FLOOR, not a
 *                       count — it only ever fails closed. Counted AFTER the
 *                       gitignore filter, so it tracks what was actually checked.
 *   --dry-run           Print offenders without failing the exit code.
 *
 * Issue: #7235, and #7247's review + post-merge fix. Background: #7198, #7213,
 * #7222, #7226.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, relative, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The repo-root module, not a local copy: the drift gate in
// scripts/__tests__/is-entry-point.test.mjs imports the same list, so the two
// gates cannot end up talking about different sets of files. See its header.
import { GUARD_COPIES } from '../../../scripts/lib/entry-point-guard-copies.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx']
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

// Dynamic, so an unloadable stripper exits 2 ("the guard broke") rather than
// crashing out as 1 ("a hand-rolled guard was found"). A static import cannot be
// caught, and an uncaught ESM resolution error exits 1 — which the CI step would
// report as dirty code.
let stripComments
try {
  ({ stripComments } = await import('./lib/strip-comments.mjs'))
} catch (err) {
  usageError(`cannot load the comment stripper: ${err.message}`)
}

function parseArgs(argv) {
  const out = { repoRoot: null, allow: [], guardCopies: [], minFiles: null, dryRun: false }
  const needsValue = (flag, value) => {
    if (value === undefined) usageError(`${flag} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--repo-root') out.repoRoot = needsValue(arg, argv[++i])
    else if (arg === '--allow') out.allow.push(needsValue(arg, argv[++i]))
    else if (arg === '--guard-copy') out.guardCopies.push(needsValue(arg, argv[++i]))
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

/**
 * The set of repo-relative paths git considers part of the repository —
 * tracked, plus untracked files that are not ignored.
 *
 * The walk alone is not the right set. `packages/desktop/src-tauri/server-bundle/`
 * is GENERATED (gitignored at .gitignore:60) and holds a stale, pre-#7217 copy
 * of the whole server — including two of the original buggy guards. A fresh CI
 * checkout has no bundle, so CI stayed green while every developer who had built
 * the desktop app got a red Server Lint from files they never wrote. That is a
 * false positive in a required check, coming from output that cannot contain a
 * fourth guard in any meaningful sense: a guard has to be COMMITTED to matter.
 *
 * A name in SKIP_DIRS would have fixed this one directory and left the next
 * generated tree to rediscover it — the hardcoded-list failure this whole lint
 * exists to prevent. Asking git is the actual rule.
 *
 * Returns null when git cannot answer (not a repository, git absent), in which
 * case nothing is filtered. That direction is deliberate: no filter means
 * scanning MORE files, never fewer, so an unavailable git cannot hide a guard.
 * It is also what lets the tests point --repo-root at a plain fixture tree and
 * still exercise this exact code path.
 */
function gitKnownFiles(root) {
  const res = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
  if (res.error || res.status !== 0) {
    // Fail-open, but never SILENTLY. Without this line the only difference
    // between "filtered" and "git could not answer" is a file count the reader
    // has no baseline for — and on a checkout git refuses to read (the
    // "dubious ownership" safe.directory error is the common one on self-hosted
    // runners and in containers) the developer gets the exact #7247 red back
    // with nothing pointing at the cause.
    console.error(
      'lint-entry-point-guard: git could not list the repository '
      + `(${res.error ? res.error.message : `exit ${res.status}`}); `
      + 'scanning the whole walk unfiltered, so generated output may be reported.',
    )
    return null
  }
  // Normalised to NFC because the two sides are produced by different things.
  // macOS git defaults to core.precomposeunicode=true and emits NFC, while
  // readdirSync returns the on-disk bytes, which for a file created in NFD stay
  // NFD. A raw === between them fails, the file is dropped, and a hand-rolled
  // guard inside it goes UNREPORTED — the silently-skipped-an-input mode this
  // file's header rejects the cheap prefilter for. Linux git does not
  // precompose, so this divergence is macOS-only and CI would never show it.
  //
  // Case is NOT folded. On a case-insensitive filesystem an unrecorded
  // case-only rename (plain `mv Thing.js thing.js`, which leaves `git status`
  // clean) still drops the file locally. Folding case would be wrong on the
  // case-sensitive filesystems CI runs on, where two such paths are genuinely
  // different files, so the divergence is left to CI — which is case-sensitive
  // and does catch it.
  return new Set(res.stdout.split('\0').filter(Boolean).map((f) => f.normalize('NFC')))
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
// 260ms on a 1900-file walk, which is not a price worth paying for a gate that
// runs once per push. Strip everything, match everything.

// Every rule anchors on the IDENTIFIER `argv`, never on `process.argv`.
//
// The first draft required the literal `process` before it, and #7247's review
// proved that hole live: `import { argv } from 'node:process'` is Node's own
// documented named-export idiom, and TWO scripts in this repo already use it
// (scripts/merge-updater-feeds.mjs, packages/server/scripts/spike-mcp-elicitation-shim.mjs).
// Both are executable and guard-less today, so the next guard written in either
// one would have been written as `argv[1]` — invisible to a `process.`-anchored
// rule, and wrong in the #7198 way. Anchoring on `argv` also picks up
// `globalThis.process.argv[1]`, `process?.argv[1]`, and any aliased holder for
// free, because none of them change the identifier.
//
// `\s*` spans newlines, so a shape broken across lines is caught the same as a
// one-liner. `(?:\?\.)?` covers the optional-chaining spellings.
const RULES = [
  {
    kind: 'argv1-index',
    re: /\bargv\s*(?:\?\.)?\s*\[\s*1\s*\]/g,
    hint: 'reads the script slot directly',
  },
  {
    kind: 'argv1-at',
    re: /\bargv\s*\??\s*\.\s*at\s*\(\s*1\s*\)/g,
    hint: 'reads the script slot via .at(1)',
  },
  {
    kind: 'import-meta-main',
    re: /\bimport\s*\.\s*meta\s*\??\.\s*main\b/g,
    hint: 'is `undefined` on Node 22.0-22.17, which this package still supports',
  },
]

// `const [, script] = process.argv` binds the script slot without naming an
// index, so no amount of index-matching finds it. Captured as the bracket body
// and decided by position below. The optional `<holder>.` covers `= process.argv`
// and `= argv` alike.
const DESTRUCTURE_RE = /\b(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*(?:[\w$]+\s*\??\.\s*)*\bargv\b/g

// Names bound to the argv array, so `const a = process.argv` … `a[1]` is caught
// too. This mirrors `homeBoundVarsIn` in lint-config-dir.mjs, which exists
// because the same two-statement split defeated a single-line rule there.
const ARGV_ALIAS_RE = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\s*\??\.\s*)*\bargv\b\s*(?![.[])/g
const ARGV_IMPORT_ALIAS_RE = /\bargv\s+as\s+([\w$]+)/g

/** Local names that hold the argv array itself. */
function argvAliasesIn(code) {
  const names = new Set()
  for (const re of [ARGV_ALIAS_RE, ARGV_IMPORT_ALIAS_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(code)) !== null) names.add(m[1])
  }
  return names
}

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

/**
 * Is the marker a real directive on this line, rather than prose mentioning it?
 *
 * Two conditions, and the second is not redundant. The regex alone reads the RAW
 * line, so the marker written as ordinary text inside a template literal —
 * `` `// lint-ignore-entry-point-guard` `` on its own line — satisfies it while
 * being a string, not a comment. Requiring the stripper to have blanked that
 * line proves it really was one.
 */
function isIgnoreDirective(rawLine, codeLine) {
  if (!new RegExp(`^\\s*(?://|\\*|/\\*)\\s*${IGNORE_MARKER}\\b`).test(rawLine)) return false
  return codeLine !== undefined && codeLine.trim() === ''
}

/** 1-based line number of `index` within `text`. */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

function findInFile(file, rel) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    // An unreadable file is "could not check", never "nothing to check". Without
    // this the EACCES escapes uncaught, node exits 1, and the CI step reports it
    // as a hand-rolled guard that does not exist.
    usageError(`cannot read ${rel}: ${err.message}`)
  }

  let code
  try {
    code = stripComments(raw, file)
  } catch (err) {
    usageError(`cannot strip comments from ${rel}: ${err.message}`)
  }

  const rawLines = raw.split('\n')
  const codeLines = code.split('\n')
  const hits = []
  const seenIndex = new Set()

  const record = (kind, index, hint) => {
    // Several rules can match the same site (an alias whose name is `argv`, say).
    // Report it once.
    if (seenIndex.has(index)) return
    seenIndex.add(index)
    const line = lineOf(code, index)
    // The marker sits on the line ABOVE the offending site, matching the
    // convention the other lints use.
    if (line > 1 && isIgnoreDirective(rawLines[line - 2], codeLines[line - 2])) return
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

  // `const a = process.argv` … `a[1]`, which no rule above can see because the
  // read never names `argv`.
  for (const alias of argvAliasesIn(code)) {
    const aliasRe = new RegExp(`\\b${alias}\\s*(?:\\?\\.)?\\s*\\[\\s*1\\s*\\]`, 'g')
    let a
    while ((a = aliasRe.exec(code)) !== null) {
      record('argv1-alias', a.index, `\`${alias}\` holds the argv array`)
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

// Drop generated output git does not consider part of the repository. See
// gitKnownFiles: a null return means git could not answer, and nothing is
// filtered, which only ever widens coverage.
const known = gitKnownFiles(root)
if (known) {
  files = files.filter((f) => known.has(relative(root, f).split(pathSep).join('/').normalize('NFC')))
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
const hitCountByGuardCopy = new Map()
// Which of the sanctioned files are guard COPIES (subject to the count check
// below) rather than tests. Explicit rather than "the first N of --allow", so a
// caller pointing the lint at a fixture tree says what it means.
const guardCopySet = new Set(
  args.guardCopies.length ? args.guardCopies : (args.allow.length ? [] : GUARD_COPIES),
)
for (const rel of guardCopySet) {
  if (!exempt.has(rel)) usageError(`--guard-copy ${rel} is not in the sanctioned set`)
}

for (const file of files) {
  const rel = relative(root, file).split(pathSep).join('/')
  const hits = findInFile(file, rel)
  if (!hits.length) continue
  if (exempt.has(rel)) {
    guardedSanctioned.add(rel)
    if (guardCopySet.has(rel)) hitCountByGuardCopy.set(rel, hits.length)
    continue
  }
  offenders.push(...hits)
}

// The exemption above is WHOLE-FILE, which #7247's review showed is a hole:
// sidecar/agent.js is 1339 lines of in-pod application that merely CONTAINS the
// guard, and a second, hand-rolled guard added anywhere else in it would be
// exempt from this walk and invisible to the drift gate, which only extracts the
// one body. So the three guard copies are held to the same COUNT.
//
// No hardcoded number is needed, which is the point: the drift gate already
// proves the three bodies are character-for-character identical, so they must
// contain the same number of sites. If one grows an extra, it stops matching its
// siblings — and if the guard itself changes, all three move together and this
// stays quiet. A ratchet that maintains itself.
const guardCounts = [...hitCountByGuardCopy.entries()]
const countMismatch = guardCounts.length > 1
  && new Set(guardCounts.map(([, n]) => n)).size > 1

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
  console.error('Deciding "was this module run directly?" by hand is #7198: it was written in')
  console.error('four files, ALL FOUR were wrong, and the failure is SILENT — the guard reads')
  console.error('false, main() never runs, and the process exits 0. Import the shared guard:')
  console.error('')
  console.error("  server sources:  import { isEntryPoint } from './utils/is-entry-point.js'")
  console.error("  repo scripts:    import { isEntryPoint } from './lib/is-entry-point.mjs'")
  console.error('')
  console.error(`If a site genuinely needs the interpreter's script path for something else,`)
  console.error(`put a \`// ${IGNORE_MARKER}\` comment on the line above it and say why.`)
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

if (countMismatch) {
  console.error('')
  for (const [rel, n] of guardCounts) console.error(`  ${rel}: ${n} site(s)`)
  console.error('')
  console.error('The sanctioned guard copies disagree on how many sites they contain, but the')
  console.error('drift gate holds their bodies identical — so the copy with more has picked up')
  console.error('a SECOND, hand-rolled determination outside the shared body. The whole-file')
  console.error('exemption would otherwise hide it. Remove the extra site.')
}

const failed = offenders.length > 0 || staleAllowlist.length > 0 || countMismatch
if (!failed) {
  console.log(`OK: ${files.length} file(s) walked; entry-point-ness is decided in ${sanctioned.length} sanctioned file(s) only.`)
}
process.exit(failed && !args.dryRun ? 1 : 0)
