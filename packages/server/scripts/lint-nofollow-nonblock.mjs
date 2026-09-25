#!/usr/bin/env node
/**
 * Lint: every raw fs `open()`/`openSync()` whose flags include `O_NOFOLLOW`
 * also includes `O_NONBLOCK`, or carries an allowlist reason (#7938).
 *
 * `O_NOFOLLOW` refuses a symlink at the final path component; it says nothing
 * about a FIFO, character device, or other non-regular file an attacker can
 * plant at the same name. POSIX `open(2)` for a FIFO opened `O_RDONLY` with no
 * `O_NONBLOCK` blocks the calling thread until a writer connects — forever, if
 * none ever does. Three independently-hardened readers in one wave shipped
 * exactly this hang, each caught only by adversarial review after the fact:
 *
 *   - claude-hooks `resolveIngestSecret` (#7923) — wedged every hook invocation.
 *   - `trusted-file-read.js`'s credential-store read (#7924) — hung daemon
 *     startup and requests.
 *   - claude-tui's `_hookReadFile` (#7926) — pinned one libuv threadpool thread
 *     per planted FIFO name, exhausting the shared 4-thread pool process-wide.
 *
 * This lint turns "someone remembers to audit the next O_NOFOLLOW site" into
 * something CI enforces, the same shape as `lint-argv-sinks.mjs` did for the
 * argv-injection class (#7868).
 *
 * ## What is scanned
 *
 * Every `open()`/`openSync()` call in the given `--src-dir` trees (default:
 * `packages/server/src` AND `packages/claude-hooks/src`, so the sweep covers
 * every package known to use `O_NOFOLLOW` today, not just the server) whose
 * callee resolves — by import tracking — to a raw fs API:
 *
 *   - `openSync` named-imported from `fs`/`node:fs` (aliased or not).
 *   - `open` named-imported from `fs/promises`/`node:fs/promises` (aliased or
 *     not) — this is the `FileHandle`-returning async open.
 *   - `<ns>.openSync(...)` / `<ns>.promises.open(...)` where `<ns>` is a
 *     namespace or default import of `fs`/`node:fs`.
 *   - `<ns>.open(...)` where `<ns>` is a namespace/default import of
 *     `fs/promises`/`node:fs/promises`, or a `{ promises as <ns> }` import
 *     from `fs`/`node:fs`.
 *   - a bare call to an identifier literally named `open` or `openSync`,
 *     REGARDLESS of import provenance. This is a deliberate, narrow widening:
 *     `open-nofollow.js` — the ONE helper this whole file-ops surface routes
 *     symlink-refusing opens through (#7280) — takes its real `open` function
 *     as an injected dependency-injection PARAMETER (`{ ..., open, ... } =
 *     deps`) so tests can force its win32 emulation branch on every platform.
 *     That parameter shadows the module's own `import { open as fsOpen } from
 *     'fs/promises'`, so import-tracking alone can never see the call this
 *     lint most needs to check. Requiring the call be spelled exactly `open`/
 *     `openSync` (not a looser substring match) keeps this from flagging an
 *     unrelated same-named local elsewhere (`openConnection`, `openModal`,
 *     …) while still catching the DI-seam pattern used here.
 *
 * `openNoFollow()` itself (the wrapper `open-nofollow.js` exports) is
 * DELIBERATELY NOT treated as a sink at its CALL sites (`reader.js`,
 * `memory.js`, `byok-tool-executor.js`, …) — it is not imported from an fs
 * module, so import-tracking does not see it, and it should not: every caller
 * delegates uniformly to the ONE implementation this lint DOES check (via the
 * `open`-named-parameter rule above), so scrutinising each caller again would
 * be redundant. A caller passing `O_DIRECTORY` (`byok-tool-executor.js`) needs
 * no special-casing for exactly the reason the issue names: a FIFO cannot
 * satisfy `O_DIRECTORY`, so `openNoFollow`'s own unconditional `O_NONBLOCK`
 * covers it for free.
 *
 * A known, accepted gap: `trusted-file-read.js` destructures its own
 * dependency-injection open function as `openSync: doOpen` — a RENAMED local,
 * not spelled `open`/`openSync` — so this lint cannot trace it. That site is
 * independently verified correct (it carries `O_NONBLOCK` today) and has its
 * own dedicated FIFO regression test (`trusted-file-read.test.js`, "readTrusted
 * SecretFile — a FIFO at the path must not block the daemon"); this lint's
 * value is catching the NEXT such site before it needs the same rediscovery.
 *
 * ## Flag-expression evidence, not full value resolution
 *
 * The flags argument (`open()`/`openSync()`'s 2nd positional argument) is
 * walked as an AST tree, not a same-line regex — `--src-dir` fixtures below
 * include a multi-line call specifically to prove this. Detection is NAME
 * evidence, collected by walking every leaf of the flags expression:
 *
 *   - a `PropertyAccessExpression` (`fsConstants.O_NOFOLLOW`,
 *     `constants.O_NOFOLLOW`) is judged by its final `.name` text.
 *   - an `Identifier` is judged by its own text directly (so a destructured
 *     `const { O_NOFOLLOW } = fs.constants` is caught without needing to
 *     trace the destructuring source), AND — if it has a `const`/`let`
 *     declaration in the SAME function or module scope — resolved into that
 *     declaration's initializer PLUS every later `identifier |= <expr>` /
 *     `identifier = <expr>` compound-assignment in the same scope (union of
 *     all of them), recursively, up to a depth bound. This is what makes
 *     `const FLAGS = O_RDONLY | O_NOFOLLOW; openSync(p, FLAGS)` (a same-module
 *     const) and `let flags = O_RDONLY; if (x) flags |= O_NOFOLLOW; if (y)
 *     flags |= O_NONBLOCK; openSync(p, flags)` (claude-hooks/config.js's real
 *     shape) both resolve correctly.
 *   - `|`, `||`, and parenthesised sub-expressions are flattened uniformly —
 *     this lint collects NAMES referenced, not bit values, so it does not need
 *     to distinguish "OR" from "OR-else-fallback"; `(fsConstants.O_NONBLOCK ||
 *     0)` (the win32-fallback idiom used throughout this codebase) is walked
 *     the same as a plain `|`.
 *   - a `ConditionalExpression` (`cond ? a : b`) is walked into BOTH branches.
 *   - a bare identifier with NO local declaration (a function PARAMETER, or an
 *     import) cannot be traced further and is marked opaque — but its own
 *     name is still checked, so `oNofollow`/`hasONoFollow`-style
 *     DI-seam parameter names are still recognised as O_NOFOLLOW evidence
 *     even though the lint cannot see where they were bound.
 *   - anything else (a `CallExpression`, element access, spread, …) is opaque:
 *     no name evidence, but it also means the expression cannot be PROVEN
 *     free of a masking O_NONBLOCK, so see the unresolvable rule below.
 *   - a bare STRING literal (Node's fs also accepts `'r'`/`'ax'`/… mode
 *     strings) is not a flags bitmask at all — the call is skipped entirely,
 *     not flagged.
 *
 * A call is a CANDIDATE only if O_NOFOLLOW evidence was found somewhere in
 * the resolvable portion of its flags expression — an ordinary unrelated open
 * (a log file, a state file, …) is never flagged, however opaque its flags
 * construction is, because there is nothing here to suggest it has anything
 * to do with symlink refusal. Once a call IS a candidate:
 *
 *   - O_NONBLOCK evidence found anywhere in the same walk → GREEN, regardless
 *     of any opaque term elsewhere (positive evidence is positive evidence).
 *   - no O_NONBLOCK evidence, but an allowlist comment (see below) sits
 *     immediately above → GREEN.
 *   - otherwise → a FINDING. This covers both "fully resolved and genuinely
 *     missing O_NONBLOCK" and "the expression contains an opaque term we
 *     cannot prove doesn't already carry it" — the task is explicit that an
 *     unresolvable flags expression must never silently pass.
 *
 * ## Allowlist
 *
 * `// lint-allow-nofollow-blocking: <reason>` on the line immediately above
 * the call (or its containing statement) allowlists a finding — for a site
 * where blocking is PROVABLY impossible regardless of O_NONBLOCK, e.g. an
 * `O_DIRECTORY` open (a FIFO cannot satisfy `O_DIRECTORY`; the kernel returns
 * `ENOTDIR` immediately rather than blocking). The reason is required
 * (non-empty after the colon) — a bare marker with nothing after it does not
 * count, matching `lint-argv-sinks.mjs`'s `argv-safety-ignore` convention.
 *
 * ## Fail-closed
 *
 * Two independent "the guard is broken, not necessarily the code" exits:
 *   - 0 files scanned (a stale/renamed `--src-dir`).
 *   - 0 O_NOFOLLOW opens found across the WHOLE scan — this repo has many
 *     (open-nofollow.js, trusted-file-read.js, claude-hooks/config.js,
 *     claude-tui-session.js, …); a scanner reporting zero is the exact
 *     "success and not-checking are the same observable outcome" shape
 *     docs/false-safety-guards.md catalogues (#7503).
 *
 * Exit codes:
 *   0 — every O_NOFOLLOW open found also has O_NONBLOCK or an allowlist reason.
 *   1 — at least one offender.
 *   2 — the lint could not do its job (bad flags, nothing scanned, zero
 *       O_NOFOLLOW opens found, a source file failed to parse).
 *
 * Flags:
 *   --src-dir <path>   Directory to scan. REPEATABLE. Defaults to
 *                      packages/server/src AND packages/claude-hooks/src,
 *                      each enumerated via `git ls-files`.
 *   --min-files <n>    Fail (exit 2) if FEWER than n files were scanned in
 *                      total across every --src-dir.
 *   --dry-run          Print offenders without failing the exit code.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

let ts
try {
  ({ default: ts } = await import('typescript'))
} catch (err) {
  console.error(`lint-nofollow-nonblock: cannot load typescript: ${err.message}`)
  process.exit(2)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DEFAULT_SRC_DIRS = [
  join(REPO_ROOT, 'packages', 'server', 'src'),
  join(REPO_ROOT, 'packages', 'claude-hooks', 'src'),
]

const FS_SOURCES = new Set(['fs', 'node:fs'])
const FS_PROMISES_SOURCES = new Set(['fs/promises', 'node:fs/promises'])
const IGNORE_MARKER = 'lint-allow-nofollow-blocking'
/** Reserved names always treated as an fs open, regardless of provenance — see header. */
const RESERVED_OPEN_NAMES = new Set(['open', 'openSync'])
const MAX_RESOLVE_DEPTH = 8

function usageError(message) {
  console.error(`lint-nofollow-nonblock: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const out = { srcDirs: [], minFiles: null, dryRun: false }
  const needsValue = (flag, value) => {
    if (value === undefined) usageError(`${flag} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--src-dir') out.srcDirs.push(needsValue(arg, argv[++i]))
    else if (arg === '--min-files') out.minFiles = Number(needsValue(arg, argv[++i]))
    else if (arg === '--dry-run') out.dryRun = true
    else usageError(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (out.minFiles !== null && (!Number.isInteger(out.minFiles) || out.minFiles < 0)) {
    usageError('--min-files requires a non-negative integer')
  }
  return out
}

// ─── File enumeration ──────────────────────────────────────────────────────

function listFilesByWalk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listFilesByWalk(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out.sort()
}

function listFilesByGit(srcDir) {
  const rel = relative(REPO_ROOT, srcDir)
  let out
  try {
    out = execFileSync('git', ['ls-files', '--', rel], { cwd: REPO_ROOT, encoding: 'utf8' })
  } catch (err) {
    usageError(`git ls-files failed for ${rel}: ${err.message}`)
  }
  return out.split('\n').filter((l) => l.endsWith('.js')).map((l) => join(REPO_ROOT, l)).sort()
}

// ─── AST helpers ────────────────────────────────────────────────────────────

function parseFile(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.JS)
}

/** forEachChild, but does not descend into a nested function/method body. */
function forEachChildSkipFunctions(node, cb) {
  node.forEachChild((child) => {
    cb(child)
    if (isFunctionLike(child)) return
    forEachChildSkipFunctions(child, cb)
  })
}

function forEachDescendant(node, cb) {
  cb(node)
  node.forEachChild((child) => forEachDescendant(child, cb))
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
}

function enclosingFunction(node) {
  let cur = node.parent
  while (cur) {
    if (isFunctionLike(cur)) return cur
    cur = cur.parent
  }
  return null
}

function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function normText(node, source) {
  return source.slice(node.pos, node.end).trim().replace(/\s+/g, ' ')
}

// ─── Import tracking ────────────────────────────────────────────────────────

/**
 * @returns {{ openSyncLocals: Set<string>, openAsyncLocals: Set<string>,
 *             fsNamespaces: Set<string>, fsPromisesNamespaces: Set<string> }}
 */
function collectOpenImports(sourceFile) {
  const openSyncLocals = new Set()
  const openAsyncLocals = new Set()
  const fsNamespaces = new Set()
  const fsPromisesNamespaces = new Set()

  const handleNamedBindings = (namedBindings, moduleText) => {
    if (!namedBindings) return
    const fromFs = FS_SOURCES.has(moduleText)
    const fromFsPromises = FS_PROMISES_SOURCES.has(moduleText)
    if (ts.isNamespaceImport(namedBindings)) {
      if (fromFs) fsNamespaces.add(namedBindings.name.text)
      if (fromFsPromises) fsPromisesNamespaces.add(namedBindings.name.text)
      return
    }
    if (ts.isNamedImports(namedBindings)) {
      for (const spec of namedBindings.elements) {
        const imported = (spec.propertyName ?? spec.name).text
        const local = spec.name.text
        if (fromFs && imported === 'openSync') openSyncLocals.add(local)
        if (fromFsPromises && imported === 'open') openAsyncLocals.add(local)
        // `import { promises as fsp } from 'fs'` — fsp.open(...) is the async API.
        if (fromFs && imported === 'promises') fsPromisesNamespaces.add(local)
      }
    }
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const moduleText = stmt.moduleSpecifier.text
      handleNamedBindings(stmt.importClause?.namedBindings, moduleText)
      // `import fs from 'fs'` (default import) — same whole-module exposure
      // as a namespace import under Node's CJS/ESM interop.
      if (stmt.importClause?.name && !stmt.importClause.isTypeOnly) {
        if (FS_SOURCES.has(moduleText)) fsNamespaces.add(stmt.importClause.name.text)
        if (FS_PROMISES_SOURCES.has(moduleText)) fsPromisesNamespaces.add(stmt.importClause.name.text)
      }
    }
  }

  return { openSyncLocals, openAsyncLocals, fsNamespaces, fsPromisesNamespaces }
}

// ─── Flag-expression evidence collection ───────────────────────────────────

function normalizeName(text) {
  return text.toLowerCase().replace(/_/g, '')
}
function isNoFollowName(text) {
  return normalizeName(text).includes('onofollow')
}
function isNonBlockName(text) {
  return normalizeName(text).includes('ononblock')
}

/**
 * Every assignment CONTRIBUTING to `name`'s value within EXACTLY `scopeFn`
 * (or module scope, when `scopeFn` is `null`): the initializer of its
 * `const`/`let` declaration, plus the RHS of every later `name |= <expr>` /
 * `name = <expr>` in the SAME scope (not crossing into a nested function).
 * Returns `null` if no local declaration for `name` exists in exactly this
 * one scope.
 */
function resolveVarSourcesInScope(name, scopeFn, sourceFile) {
  let found = false
  const sources = []
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = true
      if (node.initializer) sources.push(node.initializer)
      return
    }
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === name) {
      const kind = node.operatorToken.kind
      if (kind === ts.SyntaxKind.BarEqualsToken || kind === ts.SyntaxKind.EqualsToken) {
        sources.push(node.right)
      }
    }
  }
  if (scopeFn) {
    forEachChildSkipFunctions(scopeFn.body ?? scopeFn, visit)
  } else {
    for (const stmt of sourceFile.statements) {
      visit(stmt)
      forEachChildSkipFunctions(stmt, visit)
    }
  }
  return found ? sources : null
}

/**
 * Resolve `name` starting at `scopeFn` and walking OUTWARD through each
 * enclosing function to module scope — a `let`/`const` declared at module
 * scope (or in an ancestor function) legitimately holds the value a nested
 * function's flags argument references; only a SIBLING/unrelated scope must
 * never be consulted. Returns `null` only when NO scope in the chain (own,
 * every ancestor, and module) declares `name` — a genuine function parameter
 * or outside binding, which the caller then treats as opaque.
 */
function resolveVarSources(name, scopeFn, sourceFile) {
  let cur = scopeFn
  for (;;) {
    const sources = resolveVarSourcesInScope(name, cur, sourceFile)
    if (sources !== null) return sources
    if (cur === null) return null
    cur = enclosingFunction(cur)
  }
}

/**
 * Walk `node` (a flags expression, or a fragment of one) collecting NAME
 * evidence. Mutates `evidence` = `{ hasNoFollow, hasNonBlock, opaque }`.
 */
function collectFlagEvidence(node, scopeFn, sourceFile, evidence, depth = 0) {
  if (depth > MAX_RESOLVE_DEPTH) { evidence.opaque = true; return }

  if (ts.isParenthesizedExpression(node)) {
    collectFlagEvidence(node.expression, scopeFn, sourceFile, evidence, depth + 1)
    return
  }
  if (ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    collectFlagEvidence(node.left, scopeFn, sourceFile, evidence, depth + 1)
    collectFlagEvidence(node.right, scopeFn, sourceFile, evidence, depth + 1)
    return
  }
  if (ts.isConditionalExpression(node)) {
    collectFlagEvidence(node.whenTrue, scopeFn, sourceFile, evidence, depth + 1)
    collectFlagEvidence(node.whenFalse, scopeFn, sourceFile, evidence, depth + 1)
    return
  }
  if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.UndefinedKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
    return // contributes no name
  }
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const name = node.name.text
    if (isNoFollowName(name)) evidence.hasNoFollow = true
    if (isNonBlockName(name)) evidence.hasNonBlock = true
    return
  }
  if (ts.isIdentifier(node)) {
    const name = node.text
    if (isNoFollowName(name)) evidence.hasNoFollow = true
    if (isNonBlockName(name)) evidence.hasNonBlock = true
    const sources = resolveVarSources(name, scopeFn, sourceFile)
    if (sources === null) {
      // No local declaration — a function parameter or an outside binding.
      // Its own name was already checked above; it cannot be traced further.
      evidence.opaque = true
      return
    }
    for (const src of sources) collectFlagEvidence(src, scopeFn, sourceFile, evidence, depth + 1)
    return
  }
  // CallExpression, ElementAccessExpression, SpreadElement, an arbitrary
  // expression we don't specifically model — no name evidence, and we can't
  // prove it isn't hiding one.
  evidence.opaque = true
}

/** @returns {{hasNoFollow: boolean, hasNonBlock: boolean, opaque: boolean}} */
function evaluateFlagsArg(flagsArg, scopeFn, sourceFile) {
  const evidence = { hasNoFollow: false, hasNonBlock: false, opaque: false }
  if (ts.isStringLiteral(flagsArg) || ts.isNoSubstitutionTemplateLiteral(flagsArg)) {
    return { notAFlagsExpr: true }
  }
  collectFlagEvidence(flagsArg, scopeFn, sourceFile, evidence)
  return evidence
}

// ─── Allowlist marker ───────────────────────────────────────────────────────

function isIgnoreMarkerAbove(node, sourceFile, rawLines) {
  const line = lineOf(node, sourceFile)
  const above = rawLines[line - 2] // line is 1-based; line-2 is the 0-based index of the line above
  if (above === undefined) return false
  return new RegExp(`^\\s*(?://|\\*)\\s*${IGNORE_MARKER}:\\s*\\S`).test(above)
}

// ─── Per-file analysis ──────────────────────────────────────────────────────

function analyzeFile(filePath, keyRoot) {
  const source = readFileSync(filePath, 'utf8')
  const rawLines = source.split('\n')
  let sourceFile
  try {
    sourceFile = parseFile(source, filePath)
  } catch (err) {
    usageError(`cannot parse ${filePath}: ${err.message}`)
  }
  const rel = relative(keyRoot, filePath).split(pathSep).join('/')

  const { openSyncLocals, openAsyncLocals, fsNamespaces, fsPromisesNamespaces } = collectOpenImports(sourceFile)

  const findings = []
  let noFollowOpensChecked = 0

  forEachDescendant(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return

    let isOpenCall = false
    if (ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (openSyncLocals.has(name) || openAsyncLocals.has(name) || RESERVED_OPEN_NAMES.has(name)) {
        isOpenCall = true
      }
    } else if (ts.isPropertyAccessExpression(node.expression) && !node.expression.questionDotToken) {
      const prop = node.expression.name.text
      const obj = node.expression.expression
      if (ts.isIdentifier(obj)) {
        if (fsNamespaces.has(obj.text) && prop === 'openSync') isOpenCall = true
        if (fsPromisesNamespaces.has(obj.text) && prop === 'open') isOpenCall = true
      } else if (ts.isPropertyAccessExpression(obj) && !obj.questionDotToken && prop === 'open') {
        // fs.promises.open(...)
        if (ts.isIdentifier(obj.expression) && fsNamespaces.has(obj.expression.text) && obj.name.text === 'promises') {
          isOpenCall = true
        }
      }
    }
    if (!isOpenCall) return

    const flagsArg = node.arguments[1]
    if (!flagsArg) return // open(path) with no explicit flags — nothing to check

    const scopeFn = enclosingFunction(node)
    const evidence = evaluateFlagsArg(flagsArg, scopeFn, sourceFile)
    if (evidence.notAFlagsExpr) return // a string mode specifier, e.g. 'ax' — not our concern
    if (!evidence.hasNoFollow) return // nothing suggests this open is O_NOFOLLOW-flavoured

    noFollowOpensChecked++
    if (evidence.hasNonBlock) return // green
    if (isIgnoreMarkerAbove(node, sourceFile, rawLines)) return // allowlisted

    const line = lineOf(node, sourceFile)
    const reason = evidence.opaque
      ? 'includes O_NOFOLLOW but the flags expression could not be fully resolved (an unresolvable term), and no O_NONBLOCK was found'
      : 'includes O_NOFOLLOW but is missing O_NONBLOCK — a FIFO/device planted at this path would hang this open() forever'
    findings.push({
      file: rel,
      line,
      text: `open(...) call \`${normText(node, source)}\` ${reason}`,
    })
  })

  return { findings, noFollowOpensChecked }
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2))
const usingDefaultSrcDirs = args.srcDirs.length === 0
const srcDirs = (usingDefaultSrcDirs ? DEFAULT_SRC_DIRS : args.srcDirs).map((d) => resolve(d))
for (const dir of srcDirs) {
  if (!existsSync(dir)) usageError(`--src-dir does not exist: ${dir}`)
}

const keyRoot = srcDirs[0]
const allFindings = []
let scanned = 0
let totalNoFollowChecked = 0

for (const srcDir of srcDirs) {
  const files = usingDefaultSrcDirs ? listFilesByGit(srcDir) : listFilesByWalk(srcDir)
  for (const file of files) {
    scanned++
    const { findings, noFollowOpensChecked } = analyzeFile(file, keyRoot)
    totalNoFollowChecked += noFollowOpensChecked
    allFindings.push(...findings)
  }
}

// "Scanned zero files" and "scanned N clean files" must never be the same
// observable outcome (docs/false-safety-guards.md).
if (scanned === 0) {
  usageError(`scanned 0 files under ${srcDirs.join(', ')} — refusing to report a clean tree`)
}
if (args.minFiles !== null && scanned < args.minFiles) {
  usageError(`scanned only ${scanned} file(s), expected at least ${args.minFiles}. Either the walk broke or --min-files is stale.`)
}
// Same principle, for the thing this lint actually checks: this repo has
// MANY O_NOFOLLOW opens today (open-nofollow.js, trusted-file-read.js,
// claude-hooks/config.js, claude-tui-session.js, …). Zero found means the
// detector broke, not that the code got safer (#7503).
if (totalNoFollowChecked === 0) {
  usageError(`found 0 O_NOFOLLOW-flavoured open() calls across ${scanned} file(s) under ${srcDirs.join(', ')} — the detector is broken, not the code`)
}

for (const f of allFindings) {
  console.error(`${f.file}:${f.line}  ${f.text}`)
}
if (allFindings.length) {
  console.error('')
  console.error(`${allFindings.length} O_NOFOLLOW open(s) are missing O_NONBLOCK and are not allowlisted.`)
  console.error(`Add O_NONBLOCK to the flags (and verify the post-open code rejects a non-regular file via fstat before reading), or add`)
  console.error(`// ${IGNORE_MARKER}: <reason> immediately above the call, only where blocking is provably impossible (e.g. an O_DIRECTORY open).`)
}

const failed = allFindings.length > 0
if (!failed) {
  console.log(`OK: ${scanned} file(s) scanned, ${totalNoFollowChecked} O_NOFOLLOW open(s) checked, all carry O_NONBLOCK or an allowlist reason.`)
}
process.exit(failed && !args.dryRun ? 1 : 0)
