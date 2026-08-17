#!/usr/bin/env node
/**
 * Lint: `~/.chroxy` has exactly one resolver — `src/config-dir.js`.
 *
 * `CHROXY_CONFIG_DIR` is supposed to relocate the daemon's entire config/state
 * root. For a long time it relocated only half of it (#7052), and the reason is
 * visible in the two shapes this lint bans:
 *
 *   1. `join(homedir(), '.chroxy', …)` — a hardcoded home-rooted path that
 *      ignores the override outright. Sixteen module-scope constants and
 *      twenty-seven in-function sites had this.
 *
 *   2. `process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')` — an
 *      inline copy of the resolver. Sixteen modules grew one independently,
 *      *because* the shared constant could not be made to honor the env (a
 *      `const` freezes at import). Each copy is correct in isolation and each
 *      one is a place the convention can silently drift.
 *
 * Both are replaced by `configDir()` / `configPath(...segments)`, which read
 * the environment per call.
 *
 * NOT matched (and deliberately so):
 *   - `join(homedir(), 'AppData', 'Local')` in keychain.js — a Windows
 *     credential path, not chroxy state.
 *   - `join(homedir(), '.claude.json')` in byok-mcp-config.js — Claude Code's
 *     own config file, which chroxy reads but does not own.
 *   - anything inside a `//` line comment or a `/* *\/` block comment. This
 *     matters: `cli/schedule-cmd.js`'s doc block quotes the banned pattern in
 *     prose while explaining the migration.
 *
 * Allow-list / opt-out:
 *   - the OWNER file(s) (`--owner`, default `packages/server/src/config-dir.js`),
 *     exempt wholesale.
 *   - the baseline file (`lint-config-dir-baseline.txt`), one key per line,
 *     exempts a file that has not been migrated yet. The ratchet: a file may
 *     leave the baseline, never join it — and since #7239 that is ENFORCED by
 *     `--write-baseline` rather than left to review (see below).
 *   - `// lint-ignore-config-dir` in a COMMENT on the line immediately above an
 *     offending line whitelists that one site.
 *
 * ## Scope (#7239)
 *
 * The gate scanned only `packages/server/src`, while its CI step was named
 * "Check ~/.chroxy resolves through config-dir.js" — which overclaimed, because
 * live resolvers sit outside that tree. It now scans `packages/claude-hooks/src`
 * too. That package is deliberately zero-runtime-dep and CANNOT import the
 * server's accessor, so its one hand-rolled copy is baselined with a note rather
 * than "fixed"; the point is that a SECOND copy appearing there is now caught.
 *
 * Deliberately still out of scope, so the naming does not overclaim again:
 *   - `scripts/` (repo + package): the linter itself lives there and would scan
 *     its own pattern definitions. Shell resolvers there are covered by review,
 *     not by this gate.
 *   - `.ts` sources: no TypeScript package resolves a chroxy root today. The
 *     walk already accepts the extension list below, so adding one is a
 *     one-line change if that stops being true.
 *
 * ## Anti-evasion (#7239)
 *
 * The rules are line-oriented regexes, and adversarial fixture testing found
 * several shapes that slipped through. Each is now covered, and each has a
 * fixture in `tests/lint-config-dir.test.js` proving it is caught:
 *   - a two-step `const home = homedir()` … `join(home, '.chroxy')`
 *   - a template literal, `` `${homedir()}/.chroxy/x` ``
 *   - a combined segment, `join(homedir(), '.chroxy/logs/x')`
 *   - `process.env.HOME` / `env.HOME` in place of `homedir()`
 *   - `.mjs` / `.cjs` sources, previously invisible to the walk
 *   - an ignore marker that merely APPEARS in prose on the previous line
 *   - an unknown flag (a typo'd `--srcdir`) being ignored, so the lint silently
 *     scanned the real `src/` and reported OK
 *   - scanning ZERO files and exiting 0, indistinguishable from a clean tree
 *
 * Issue: #7052, #7239.
 *
 * Exit codes:
 *   0 — no un-baselined offenders, and no stale baseline entries
 *   1 — at least one offender, or a baseline entry that is now clean
 *   2 — the lint could not do its job (bad flags, nothing scanned). Distinct
 *       from 1 on purpose: "the guard failed" must never read as "the guard
 *       passed", and it must not read as "the code is dirty" either.
 *
 * Flags:
 *   --src-dir <path>    Directory to scan. REPEATABLE. Defaults to the two
 *                       roots above.
 *   --owner <path>      A file exempt wholesale. REPEATABLE. Defaults to
 *                       `<first --src-dir>/config-dir.js` when --src-dir is
 *                       given, else the server's config-dir.js.
 *   --baseline <path>   Override the baseline file.
 *   --min-files <n>     Fail (exit 2) if fewer than n files were scanned.
 *                       A FLOOR, not a count — it only ever fails closed.
 *   --write-baseline    Rewrite the baseline. REFUSES to add a file that is not
 *                       already listed unless --allow-baseline-growth is given.
 *   --allow-baseline-growth  Permit --write-baseline to add entries.
 *   --dry-run           Print offenders without failing the exit code.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const DEFAULT_SRC_DIRS = [
  join(REPO_ROOT, 'packages', 'server', 'src'),
  join(REPO_ROOT, 'packages', 'claude-hooks', 'src'),
]
const DEFAULT_OWNERS = [join(REPO_ROOT, 'packages', 'server', 'src', 'config-dir.js')]

const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs']
const IGNORE_MARKER = 'lint-ignore-config-dir'

/** Bad usage — the lint could not run. Exit 2, never 0 and never 1. */
function usageError(message) {
  console.error(`lint-config-dir: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const out = {
    srcDirs: [],
    owners: [],
    baseline: null,
    minFiles: null,
    writeBaseline: false,
    allowBaselineGrowth: false,
    dryRun: false,
  }
  const needsValue = (flag, value) => {
    if (value === undefined) usageError(`${flag} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--src-dir') out.srcDirs.push(needsValue(arg, argv[++i]))
    else if (arg === '--owner') out.owners.push(needsValue(arg, argv[++i]))
    else if (arg === '--baseline') out.baseline = needsValue(arg, argv[++i])
    else if (arg === '--min-files') out.minFiles = Number(needsValue(arg, argv[++i]))
    else if (arg === '--write-baseline') out.writeBaseline = true
    else if (arg === '--allow-baseline-growth') out.allowBaselineGrowth = true
    else if (arg === '--dry-run') out.dryRun = true
    // An unknown flag used to be SILENTLY IGNORED, so `--srcdir /tmp/fixture`
    // (a typo) scanned the real src/ and printed OK — a green run that never
    // looked at what the caller asked about.
    else usageError(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (out.minFiles !== null && (!Number.isInteger(out.minFiles) || out.minFiles < 0)) {
    usageError('--min-files requires a non-negative integer')
  }
  return out
}

function listSourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full))
    else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full)
  }
  return out.sort()
}

/**
 * Blank out comment spans so a doc block that *quotes* the banned pattern is
 * not itself an offender. Returns a line array of the same length, with
 * commented regions replaced by spaces (line numbers stay accurate).
 */
function stripComments(source) {
  const out = []
  let inBlock = false
  for (const line of source.split('\n')) {
    let kept = ''
    let i = 0
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i)
        if (end === -1) { i = line.length } else { inBlock = false; i = end + 2 }
        continue
      }
      if (line.startsWith('//', i)) break
      if (line.startsWith('/*', i)) { inBlock = true; i += 2; continue }
      kept += line[i]
      i++
    }
    out.push(kept)
  }
  return out
}

// A home-root expression. `process.env.HOME` is the same thing by another
// spelling (tests/smoke-test.mjs uses it) and evaded a `homedir()`-only rule.
const HOME_EXPR = /\bhomedir\s*\(\s*\)|\b(?:process\.)?env\.HOME\b/

// `.chroxy` as a path segment. Two spellings, because a quote-delimited rule
// missed both a combined segment ('.chroxy/logs/x' — the quote does not follow
// `.chroxy`) and a template literal (`${homedir()}/.chroxy/x` — no quote at all).
const CHROXY_SEGMENT = /['"`]\.chroxy(?=['"`/])|\/\.chroxy(?=['"`/]|$)/

// A module-scope binding whose initializer calls the accessor. Column-0 means
// top level: anything inside a function or class body is indented.
const MODULE_SCOPE_DECL = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/

// Matching only `configDir(` / `configPath(` was not enough. logger.js froze its
// log directory as `let _logDir = defaultLogDir()`, where `defaultLogDir()` is a
// same-file one-line wrapper around `configPath('logs')` — the exact shape this
// rule exists to catch, one level of indirection out of its reach. The
// migration had *replaced* a form rule 1 caught with a form nothing caught, and
// the lint then declared the tree clean.
//
// So the wrapper set is derived from the file rather than hardcoded: any
// same-file function whose body calls the accessor counts as the accessor. The
// `defaultX()` naming convention this issue established for these resolvers is
// included too, so a wrapper defined elsewhere and imported is still caught.
const ACCESSOR_NAMES = ['configDir', 'configPath']
const CALLS_ACCESSOR_DIRECTLY = /\b(?:configDir|configPath)\s*\(/

/** Names of same-file functions that (transitively) resolve through the accessor. */
function accessorWrappersIn(codeLines) {
  const names = new Set(ACCESSOR_NAMES)
  // Two passes so a wrapper-of-a-wrapper is caught regardless of definition order.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < codeLines.length; i++) {
      const decl = /^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(codeLines[i])
      if (!decl) continue
      // Scan the body until the closing brace at column 0.
      for (let j = i + 1; j < codeLines.length; j++) {
        if (/^\}/.test(codeLines[j])) break
        if ([...names].some((n) => new RegExp(`\\b${n}\\s*\\(`).test(codeLines[j]))) {
          names.add(decl[1])
          break
        }
      }
    }
  }
  return names
}

/**
 * Names bound to a home-root expression anywhere in the file.
 *
 * `const home = homedir()` on one line and `join(home, '.chroxy')` on another
 * is the same defect split across two statements, and the single-line rule could
 * not see it. The two-step idiom is already live in the tree
 * (`ws-file-ops/browser.js`, `devcontainer-config.js` — neither is a chroxy path
 * today, which is exactly why this needed closing before one becomes one).
 */
function homeBoundVarsIn(codeLines) {
  const names = new Set()
  for (const line of codeLines) {
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(line)
    if (m && HOME_EXPR.test(m[2])) names.add(m[1])
  }
  return names
}

/**
 * Is the ignore marker genuinely a directive on this line?
 *
 * It used to be a substring test against the raw previous line, so a comment
 * merely MENTIONING `lint-ignore-config-dir` — this file's own docstring does —
 * silently exempted whatever followed it.
 */
function isIgnoreDirective(rawLine) {
  return new RegExp(`^\\s*(?://|\\*|/\\*)\\s*${IGNORE_MARKER}\\b`).test(rawLine)
}

function findOffenders(srcDirs, ownerPaths, keyRoot) {
  const offenders = []
  const owners = new Set(ownerPaths.map((p) => resolve(p)))
  let scanned = 0

  for (const srcDir of srcDirs) {
    for (const file of listSourceFiles(srcDir)) {
      // Counted BEFORE the owner filter: this number answers "did the walk find
      // the tree?", not "how many files survived exemptions". A repo whose only
      // source file is the owner is legitimately nothing-to-check, and must not
      // be conflated with a walk that resolved to an empty directory.
      scanned++
      if (owners.has(resolve(file))) continue
      const rel = relative(keyRoot, file).split(pathSep).join('/')

      const source = readFileSync(file, 'utf8')
      const rawLines = source.split('\n')
      const code = stripComments(source)
      const wrappers = accessorWrappersIn(code)
      const homeVars = homeBoundVarsIn(code)
      const callsAccessor = (text) =>
        CALLS_ACCESSOR_DIRECTLY.test(text)
        || [...wrappers].some((n) => new RegExp(`\\b${n}\\s*\\(`).test(text))
        || /\bdefault[A-Z][\w$]*\s*\(/.test(text)
      const isHomeRooted = (text) =>
        HOME_EXPR.test(text)
        || [...homeVars].some((n) => new RegExp(`\\b${n}\\b`).test(text))

      code.forEach((line, idx) => {
        const prev = idx > 0 ? rawLines[idx - 1] : ''
        if (isIgnoreDirective(prev)) return
        const push = (kind) =>
          offenders.push({ file: rel, line: idx + 1, kind, text: rawLines[idx].trim() })

        if (isHomeRooted(line) && CHROXY_SEGMENT.test(line)) {
          // `env.CHROXY_CONFIG_DIR` too, not just `process.env.…` — cli/tokens-cmd.js
          // destructures `env` from its opts, and it is an inline copy all the same.
          const inlineResolver = /\benv\.CHROXY_CONFIG_DIR/.test(line)
          push(inlineResolver ? 'inline-resolver-copy' : 'hardcoded-home-path')
          return
        }

        // Calling the accessor is not enough — WHERE you call it decides whether
        // the env is read at the moment that matters. A module-scope
        // `const P = configPath('session-state.json')` is exactly as frozen as
        // the `join(homedir(), …)` it replaced: it evaluates once, at import,
        // and no later `beforeEach` can move it. The migration would otherwise
        // look complete while half the defect survived, which is the failure
        // this whole issue is made of.
        if (!MODULE_SCOPE_DECL.test(line)) return
        const initializer = /=\s*$/.test(line.trimEnd()) ? line + (code[idx + 1] ?? '') : line
        if (callsAccessor(initializer)) push('module-scope-capture')
      })
    }
  }
  return { offenders, scanned }
}

function readBaseline(path) {
  if (!existsSync(path)) return new Set()
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  )
}

const args = parseArgs(process.argv.slice(2))
const srcDirs = (args.srcDirs.length ? args.srcDirs : DEFAULT_SRC_DIRS).map((d) => resolve(d))
const owners = args.owners.length
  ? args.owners
  : (args.srcDirs.length ? [join(srcDirs[0], 'config-dir.js')] : DEFAULT_OWNERS)
const baselinePath = resolve(args.baseline ?? join(__dirname, 'lint-config-dir-baseline.txt'))

for (const dir of srcDirs) {
  if (!existsSync(dir)) usageError(`--src-dir does not exist: ${dir}`)
}

// Baseline keys are repo-relative for the real run (so a second scan root reads
// as `packages/claude-hooks/src/config.js`, not `../../claude-hooks/…`), and
// src-dir-relative when a caller points the lint at a fixture tree.
const keyRoot = args.srcDirs.length ? srcDirs[0] : REPO_ROOT

const { offenders, scanned } = findOffenders(srcDirs, owners, keyRoot)
const offendingFiles = new Set(offenders.map((o) => o.file))

// "Scanned zero files" and "scanned 298 clean files" used to be the same
// observable outcome. An empty or renamed source root exited 0, which is a
// guard reporting success without having checked anything —
// docs/false-safety-guards.md names this as the least-solved failure mode.
if (scanned === 0) {
  usageError(`scanned 0 files under ${srcDirs.join(', ')} — refusing to report a clean tree`)
}
if (args.minFiles !== null && scanned < args.minFiles) {
  usageError(`scanned only ${scanned} file(s), expected at least ${args.minFiles}. `
    + 'Either the walk broke or --min-files is stale.')
}

if (args.writeBaseline) {
  const existing = readBaseline(baselinePath)
  const added = [...offendingFiles].filter((f) => !existing.has(f)).sort()
  // The ratchet used to be a review-time convention, which meant a regenerate
  // could silently re-add whatever it found. Now it fails closed.
  if (added.length && !args.allowBaselineGrowth) {
    console.error('Refusing to grow the baseline (#7052 ratchet: a file may LEAVE, never join):')
    for (const f of added) console.error(`  + ${f}`)
    console.error('')
    console.error('Fix the file, or re-run with --allow-baseline-growth if this is a deliberate, reviewed exception.')
    process.exit(2)
  }
  const header = [
    '# Files that still resolve ~/.chroxy without going through src/config-dir.js.',
    '# Ratchet (#7052): a file may LEAVE this list, never join it.',
    '# Regenerate with: node scripts/lint-config-dir.mjs --write-baseline',
    '',
  ].join('\n')
  writeFileSync(baselinePath, header + [...offendingFiles].sort().join('\n') + '\n')
  console.log(`Wrote ${offendingFiles.size} file(s) to ${relative(process.cwd(), baselinePath)}`)
  process.exit(0)
}

const baseline = readBaseline(baselinePath)
const newOffenders = offenders.filter((o) => !baseline.has(o.file))
// A baselined file that is now clean must be removed, or the ratchet slips
// back: the entry would keep granting an exemption nothing needs, and the next
// regression in that file would land silently.
const staleBaseline = [...baseline].filter((f) => !offendingFiles.has(f)).sort()

for (const o of newOffenders) {
  console.error(`${o.file}:${o.line}  [${o.kind}]  ${o.text}`)
}
if (newOffenders.length) {
  console.error('')
  console.error(`${newOffenders.length} un-baselined site(s) resolve ~/.chroxy outside the owner module.`)
  console.error("Use configDir() / configPath(...) from './config-dir.js' — they read CHROXY_CONFIG_DIR per call.")
}

for (const f of staleBaseline) {
  console.error(`${f}: listed in the baseline but now clean — remove the entry.`)
}

const failed = newOffenders.length > 0 || staleBaseline.length > 0
if (!failed) {
  const exempt = baseline.size ? ` (${baseline.size} file(s) still baselined)` : ''
  console.log(`OK: ${scanned} file(s) scanned; ~/.chroxy resolves through the owner module${exempt}.`)
}
process.exit(failed && !args.dryRun ? 1 : 0)
