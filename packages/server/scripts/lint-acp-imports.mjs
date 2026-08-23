#!/usr/bin/env node
/**
 * Lint: no file under packages/server may import an `experimental/*` ACP
 * entry point, or the stale `@zed-industries/agent-client-protocol`
 * predecessor (#7318 review).
 *
 * ## Why this is a separate lint, not a `node:test` assertion
 *
 * The original version of this check lived inline in
 * `tests/acp-schema-drift.test.js`, hand-walking `src/` only. Four separate
 * defects, all real:
 *
 *   - **Scope**: `src/` only. The same forbidden import in `sidecar/agent.js`
 *     or `hooks/*.mjs` — both in packages/server's `package.json` `files`
 *     allowlist, so they SHIP — passed silently. The SDK's `./experimental/node`
 *     export is a standalone-agent adapter, making `sidecar/` (which ships as
 *     an isolated in-pod bundle) the single most likely landing site for a
 *     future ACP integration (#7306) to reach for it by accident.
 *   - **Extensions**: `/\.(m?js|jsx)$/` missed `.cjs`/`.ts`/`.mts`/`.cts`/`.tsx`
 *     and matched `.jsx`, which does not exist under packages/server.
 *   - **No collapse floor**: an empty walk returned `offenders === []`, which
 *     reads identical to a clean scan of everything. "Scanned nothing" and
 *     "scanned 900 clean files" must never be the same observable outcome —
 *     docs/false-safety-guards.md's least-solved failure mode.
 *   - **False positive on prose**: the old check matched raw source text, so a
 *     `src/` comment explaining why the SDK is used instead of
 *     `@zed-industries/agent-client-protocol` — exactly the kind of comment
 *     #7306 will write — failed the build for saying the right thing.
 *
 * Moving this to its own lint (mirroring the six other `scripts/lint-*.mjs`
 * gates already in this directory) gets a collapse floor, `git`-scoped
 * walking, comment-stripping, and a `lint-ignore` opt-out for free, instead of
 * re-deriving each one inline. The remaining five checks in
 * `tests/acp-schema-drift.test.js` stay a `node:test` file: they compare
 * in-memory data structures (the vendored snapshot vs. the installed SDK),
 * which is what that file format is for.
 *
 * ## What is banned
 *
 * Two literal substrings, matched on COMMENT-STRIPPED source (see
 * `lib/strip-comments.mjs` — string and template literals are left intact,
 * comments are blanked):
 *
 *   1. `@zed-industries/agent-client-protocol` — the stale predecessor.
 *   2. `@agentclientprotocol/sdk/experimental` — any `experimental/*` subpath.
 *      The SDK's own README says that surface "may change incompatibly in
 *      any SDK release"; only the default v1 entry point is sanctioned.
 *
 * Comment-stripping means a `src/` comment discussing either string (the
 * `#7306` scenario above) does NOT fail the build — only a real string
 * literal (an import specifier, a `require()` argument, or a stray mention in
 * a non-comment string) does.
 *
 * ## Scope
 *
 * `packages/server/` only, by default — the SDK is a `packages/server`-only
 * dependency (see #7318), so no other workspace package can meaningfully
 * import it. `--scan-root` overrides this for the fixture-driven proof test.
 * The walk is filtered to what `git` considers part of the repository (see
 * `gitKnownFiles`, the same technique `lint-entry-point-guard.mjs` uses):
 * gitignored build output is not scanned, but an untracked-and-not-ignored
 * file is, because it is on its way to being committed.
 *
 * ## Exit codes
 *
 *   0 — no forbidden ACP reference found
 *   1 — at least one offender
 *   2 — the lint could not do its job (bad flags, a stripper that will not
 *       load, an unreadable file, or fewer files walked than --min-files).
 *       Distinct from 1 on purpose: "the guard broke" must never read as
 *       "the guard passed", and must not read as "the code is dirty" either.
 *
 * ## Flags
 *
 *   --scan-root <path>  Tree to walk. Defaults to packages/server/. The proof
 *                       test points this at a fixture tree so production and
 *                       test run the SAME walk rather than two implementations
 *                       of one.
 *   --min-files <n>     Exit 2 if fewer than n files were walked. A FLOOR, not
 *                       a count — it only ever fails closed. Counted AFTER the
 *                       gitignore filter, so it tracks what was actually
 *                       checked.
 *   --dry-run           Print offenders without failing the exit code.
 *
 * A single site can be exempted with `// lint-ignore-acp-import` in a comment
 * on the line immediately above it.
 *
 * ## A note on this file's own text
 *
 * Comments are stripped before matching but STRING LITERALS ARE NOT (see
 * `lib/strip-comments.mjs`), so the two needles below are built by
 * concatenation rather than spelled as one contiguous literal — otherwise
 * this file would fail its own scan. `tests/lint-acp-imports.test.js` has the
 * opposite problem: it must author the FULL, realistic offending string as
 * fixture text to prove this lint catches it, so it is listed in
 * `TEST_EXEMPTIONS` instead of split — splitting fixture data that is
 * supposed to look like a real offending import would defeat the point of
 * the fixture. `lint-entry-point-guard.mjs` documents the same two-part
 * solution for the same reason.
 *
 * Issue: #7318 (review round after the initial merge to main).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, relative, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCAN_ROOT = resolve(__dirname, '..')

const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx']
const IGNORE_MARKER = 'lint-ignore-acp-import'

// Directories the walk never descends into. Over-denying is caught by
// --min-files; under-denying only costs time, so this errs toward small.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage',
  '.next', '.expo', '.turbo', 'target', 'Pods', '.venv', 'venv',
])

/** Bad usage, or a broken walk — the lint could not run. Exit 2, never 0 or 1. */
function usageError(message) {
  console.error(`lint-acp-imports: ${message}`)
  process.exit(2)
}

// Dynamic, so an unloadable stripper exits 2 ("the guard broke") rather than
// crashing out as 1 ("a forbidden import was found").
let stripComments
try {
  ({ stripComments } = await import('./lib/strip-comments.mjs'))
} catch (err) {
  usageError(`cannot load the comment stripper: ${err.message}`)
}

function parseArgs(argv) {
  const out = { scanRoot: null, minFiles: null, dryRun: false }
  const needsValue = (flag, value) => {
    if (value === undefined) usageError(`${flag} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--scan-root') out.scanRoot = needsValue(arg, argv[++i])
    else if (arg === '--min-files') out.minFiles = Number(needsValue(arg, argv[++i]))
    else if (arg === '--dry-run') out.dryRun = true
    else usageError(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (out.minFiles !== null && (!Number.isInteger(out.minFiles) || out.minFiles < 0)) {
    usageError('--min-files requires a non-negative integer')
  }
  return out
}

/**
 * The set of repo-relative (to `root`) paths git considers part of the
 * repository — tracked, plus untracked files that are not ignored. See
 * `lint-entry-point-guard.mjs`'s `gitKnownFiles` for the full rationale
 * (gitignored generated trees, like a stale Tauri server bundle, must not be
 * scanned or reported on).
 *
 * Returns null when git cannot answer, in which case nothing is filtered —
 * that direction only ever widens coverage, never hides one.
 */
function gitKnownFiles(root) {
  const res = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
  if (res.error || res.status !== 0) {
    console.error(
      'lint-acp-imports: git could not list the repository '
      + `(${res.error ? res.error.message : `exit ${res.status}`}); `
      + 'scanning the whole walk unfiltered, so generated output may be reported.',
    )
    return null
  }
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

// Built by concatenation so this file's own source never spells either
// needle as one contiguous literal — see "A note on this file's own text"
// above.
const ZED_PREDECESSOR = '@zed-industries' + '/agent-client-protocol'
const EXPERIMENTAL_SUBPATH = '@agentclientprotocol/sdk' + '/experimental'

const FORBIDDEN = [
  {
    kind: 'zed-industries-predecessor',
    needle: ZED_PREDECESSOR,
    hint: `references the stale ${ZED_PREDECESSOR} predecessor -- use @agentclientprotocol/sdk`,
  },
  {
    kind: 'experimental-entry-point',
    needle: EXPERIMENTAL_SUBPATH,
    hint: 'imports an experimental/* ACP entry point -- the SDK README says it may change incompatibly in any release; use the default v1 entry point',
  },
]

/**
 * The one file allowed to spell either needle as a contiguous literal: the
 * proof test for THIS lint, which must author realistic offending fixture
 * text to demonstrate detection. Mirrors `TEST_EXEMPTIONS` in
 * `lint-entry-point-guard.mjs` — kept separate from the walk's normal
 * filtering rather than special-cased inline, so it reads as a deliberate,
 * narrow, listed exception.
 */
const TEST_EXEMPTIONS = new Set(['tests/lint-acp-imports.test.js'])

/**
 * Is the marker a real directive on this line, rather than prose mentioning
 * it? The regex alone reads the RAW line, so the marker written as ordinary
 * text inside a template literal would satisfy it while being a string, not a
 * comment. Requiring the stripped line to be blank proves it really was one.
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

  for (const { kind, needle, hint } of FORBIDDEN) {
    let fromIndex = 0
    let idx
    while ((idx = code.indexOf(needle, fromIndex)) !== -1) {
      fromIndex = idx + 1
      const line = lineOf(code, idx)
      if (line > 1 && isIgnoreDirective(rawLines[line - 2], codeLines[line - 2])) continue
      hits.push({ file: rel, line, kind, hint, text: (rawLines[line - 1] || '').trim() })
    }
  }
  return hits
}

const args = parseArgs(process.argv.slice(2))
const root = resolve(args.scanRoot ?? DEFAULT_SCAN_ROOT)

if (!existsSync(root)) usageError(`--scan-root does not exist: ${root}`)

let files
try {
  files = walk(root).sort()
} catch (err) {
  usageError(`cannot walk ${root}: ${err.message}`)
}

const known = gitKnownFiles(root)
if (known) {
  files = files.filter((f) => known.has(relative(root, f).split(pathSep).join('/').normalize('NFC')))
}

// "Walked zero files" and "walked 897 clean files" must not be the same
// observable outcome.
if (files.length === 0) {
  usageError(`walked 0 files under ${root} — refusing to report a clean tree`)
}
if (args.minFiles !== null && files.length < args.minFiles) {
  usageError(`walked only ${files.length} file(s), expected at least ${args.minFiles}. `
    + 'Either the walk broke or --min-files is stale.')
}

const offenders = []
for (const file of files) {
  const rel = relative(root, file).split(pathSep).join('/')
  if (TEST_EXEMPTIONS.has(rel)) continue
  offenders.push(...findInFile(file, rel))
}

for (const o of offenders) {
  console.error(`${o.file}:${o.line}  [${o.kind}]  ${o.text}`)
}
if (offenders.length) {
  console.error('')
  console.error(`${offenders.length} forbidden ACP reference(s) found.`)
  console.error('')
  console.error('Only @agentclientprotocol/sdk is sanctioned, and only its default v1 entry')
  console.error(`point. Never the ${ZED_PREDECESSOR} predecessor and never an experimental/*`)
  console.error('subpath.')
  console.error('')
  console.error('If a site genuinely needs to reference one of these strings for something')
  console.error(`else, put a comment with ${IGNORE_MARKER} on the line above it and say why.`)
}

const failed = offenders.length > 0
if (!failed) {
  console.log(`OK: ${files.length} file(s) walked; no forbidden ACP reference found.`)
}
process.exit(failed && !args.dryRun ? 1 : 0)
