#!/usr/bin/env node
/**
 * Lint: every argv sink is gated, catalogued, or provably safe (#7868).
 *
 * `utils/argv-safety.js` documents three correct shapes for a value that
 * reaches a spawned program's argv and is not a compile-time constant:
 *
 *   1. reject a leading dash / NUL / CR / LF — `assertSafeArgvValue` /
 *      `isSafeArgvValue`.
 *   2. a `--` terminator placed BEFORE the value, in a positional slot.
 *   3. the value fused into one argv token behind a fixed, non-dash-leading
 *      prefix (`--flag=<value>`, `key=<value>`) — the token can never be
 *      mistaken for a separate option regardless of the value's content.
 *
 * It had no gate: a sweep found the same defect four times (#7290, #7291,
 * #7295, #7342), each fixed one-off, each catching the ones before it missed.
 * This lint turns "someone remembers to sweep" into something CI enforces.
 *
 * ## What is scanned
 *
 * Every `spawn` / `spawnSync` / `execFile` / `execFileSync` call site in
 * `packages/server/src` (`node:child_process` / `child_process`, static or
 * dynamic `import`, named or namespace-imported), PLUS every function whose
 * name is `_buildArgs` or matches `/^build\w*Args$/` — the documented argv-
 * building contract point (`JsonlSubprocessSession._buildArgs`: "argv passed
 * to spawn()"). The second half matters because argv construction and the
 * actual `spawn()` call are routinely in DIFFERENT functions (a subclass
 * builds the array; the base class spawns it days — sometimes files — later),
 * which a lint scoped only to literal `spawn(...)` call sites would miss
 * entirely. `buildCodexArgs` / `GeminiSession._buildArgs` are exactly this
 * shape, and the acceptance criteria for this issue name a mutation to
 * `buildCodexArgs` as the thing this lint must catch — it does not call
 * `spawn` itself.
 *
 * `exec` / `execSync` (the shell-STRING form) are deliberately NOT scanned:
 * that is shell-metacharacter injection, a different class with a different
 * fix (quoting, or avoiding a shell entirely), not argv-option injection.
 *
 * ## What counts as a "sink"
 *
 * The args array passed to a scanned call, or returned by a scanned
 * `_buildArgs`-shaped function, resolved as far as static analysis can:
 *   - an array literal,
 *   - a `const name = [...]` (or a ternary of two array literals, matching
 *     `buildCodexArgs`'s `threadId ? [...] : [...]`) followed by `name.push(...)`
 *     calls in the same function, in source order.
 * Anything else (a spread, a value returned from another function, a bare
 * identifier with no local declaration) cannot be resolved — the WHOLE call
 * is a sink requiring a guard or a catalogue entry, because the lint cannot
 * see what is inside it.
 *
 * Each resolved element is either PROVABLY CONSTANT (a string/number/boolean
 * literal, a template literal with no `${}`, or an identifier bound to a
 * module-scope `const` that is itself provably constant — recursively, one
 * level at a time) or FLAGGED. A flagged element must be one of:
 *   (a) shape 1 — the same value (matched by dotted identifier path, e.g.
 *       `spec.gitRepo.url`) is passed to `assertSafeArgvValue` / `isSafeArgvValue`
 *       (imported from `utils/argv-safety.js`) anywhere in the file, OR to a
 *       locally-defined one-hop WRAPPER function that itself calls one of
 *       those guards on ITS OWN first parameter (this is how `git-ops.js`'s
 *       `assertSafeRef` and `environments/backends/k8s.js`'s
 *       `assertGitRepoFieldSafe` are recognised without hardcoding their
 *       names). A template literal / string-concat that is NOT shape 3 is
 *       decomposed and each embedded expression must independently satisfy
 *       this (the `` `${baseSha}..${headRef}` `` pattern in `git-ops.js`).
 *   (b) shape 2 — a literal `'--'` element appears earlier in the SAME
 *       resolved array (same ternary branch's elements plus the shared push
 *       sequence).
 *   (c) shape 3 — the element is a template literal / `+`-concatenation whose
 *       leftmost static text is non-empty and does not start with `-`, so the
 *       resulting token can never be option-parsed regardless of the
 *       interpolated value.
 *   (d) an inline `// argv-safety-ignore: <reason>` comment on the line
 *       immediately above the flagged statement, OR
 *   (e) a matching entry in the `AUDITED_SINKS` catalogue exported by
 *       `utils/argv-safety.js` (`--catalogue` overrides the file read).
 *
 * ## Both directions (#7199, #7216, #7544, #7639)
 *
 * `AUDITED_SINKS` is checked both ways: every catalogued `{file, match}` must
 * still match some real, still-unresolved finding (otherwise the code moved
 * on and the entry is stale — remove it), and every real finding that isn't
 * shape 1/2/3/marker must be catalogued or it fails the build. A list that
 * only ever grows, or that nothing re-derives against the code, is exactly
 * the "roster checked in only one direction" shape docs/false-safety-guards.md
 * catalogues.
 *
 * Files are enumerated via `git ls-files` (not a filesystem walk) when
 * scanning the real repo (no `--src-dir` override) — a renamed/emptied source
 * root must fail loudly rather than silently report a clean tree, and
 * `git ls-files` cannot pass through anything the walk itself renamed away
 * from `packages/server/src`. `--src-dir` (used by the fixture tests) instead
 * walks the filesystem directly, since a fixture tree is not a git checkout.
 * Either path counts files scanned: 0 is a hard exit 2, and `--min-files` is
 * an additional floor for the real run.
 *
 * Exit codes:
 *   0 — no un-catalogued/un-guarded sink, and no stale catalogue entry.
 *   1 — at least one offender.
 *   2 — the lint could not do its job (bad flags, nothing scanned, the
 *       catalogue module failed to load, a source file failed to parse).
 *       Distinct from 1 on purpose — "the guard is broken" must never read as
 *       "the guard passed" or as "the code is dirty".
 *
 * Flags:
 *   --src-dir <path>   Directory to scan. REPEATABLE. Defaults to
 *                      packages/server/src, enumerated via `git ls-files`.
 *   --catalogue <path> Module exporting `AUDITED_SINKS`. Defaults to
 *                      packages/server/src/utils/argv-safety.js.
 *   --min-files <n>    Fail (exit 2) if fewer than n files were scanned.
 *   --dry-run          Print offenders without failing the exit code.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep as pathSep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

let ts
try {
  ({ default: ts } = await import('typescript'))
} catch (err) {
  console.error(`lint-argv-sinks: cannot load typescript: ${err.message}`)
  process.exit(2)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DEFAULT_SRC_DIR = join(REPO_ROOT, 'packages', 'server', 'src')
const DEFAULT_CATALOGUE = join(DEFAULT_SRC_DIR, 'utils', 'argv-safety.js')

const CHILD_PROCESS_SOURCES = new Set(['child_process', 'node:child_process'])
const SPAWN_APIS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync'])
const GUARD_MODULE_SUFFIX = 'utils/argv-safety.js'
// `isGitShaRef` is a THIRD, stricter guard exported by argv-safety.js (hex-SHA
// only — a subset of what isSafeArgvValue accepts). supervisor.js validates
// its `known-good-ref` file contents with it before using the value in a git
// argv; recognising it here means that call site needs no catalogue entry.
const GUARD_NAMES = new Set(['assertSafeArgvValue', 'isSafeArgvValue', 'isGitShaRef'])
const IGNORE_MARKER = 'argv-safety-ignore'
// `_buildArgs` is JsonlSubprocessSession's documented contract name
// ("argv passed to spawn()"). `build*Args` (buildCodexArgs, buildClaudeCliArgs,
// buildGrepArgs) and `*Argv` (gitChangedServerFilesArgv, cloudflaredCreateArgv)
// are the same shape by two different local naming conventions — a function
// whose whole job is to return an argv array for a caller elsewhere to spawn.
const BUILD_ARGS_NAME = /^(?:_buildArgs|build\w*Args|\w*Argv)$/

/** Bad usage — the lint could not run. Exit 2, never 0 and never 1. */
function usageError(message) {
  console.error(`lint-argv-sinks: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const out = { srcDirs: [], catalogue: null, minFiles: null, dryRun: false }
  const needsValue = (flag, value) => {
    if (value === undefined) usageError(`${flag} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--src-dir') out.srcDirs.push(needsValue(arg, argv[++i]))
    else if (arg === '--catalogue') out.catalogue = needsValue(arg, argv[++i])
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

function functionName(fn) {
  if (!fn) return null
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return fn.name.text
  if ((ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) && fn.parent && ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)) return fn.parent.name.text
  return null
}

function normText(node, source) {
  return source.slice(node.pos, node.end).trim().replace(/\s+/g, ' ')
}

function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

/** Dotted identifier path for an Identifier / non-computed PropertyAccessExpression chain, else null. */
function pathKeyOf(node) {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const base = pathKeyOf(node.expression)
    return base === null ? null : `${base}.${node.name.text}`
  }
  return null
}

// ─── Import tracking ────────────────────────────────────────────────────────

/**
 * @returns {{ spawnApiLocals: Map<string,string>, spawnNamespaces: Set<string>,
 *             guardLocals: Set<string> }}
 */
function collectImports(sourceFile) {
  const spawnApiLocals = new Map()
  const spawnNamespaces = new Set()
  const guardLocals = new Set()

  const fromChildProcess = (moduleText) => CHILD_PROCESS_SOURCES.has(moduleText)
  const fromArgvSafety = (moduleText) => moduleText.replace(/\\/g, '/').endsWith(GUARD_MODULE_SUFFIX)

  const handleNamedBindings = (namedBindings, moduleText) => {
    if (!namedBindings) return
    if (ts.isNamespaceImport(namedBindings)) {
      if (fromChildProcess(moduleText)) spawnNamespaces.add(namedBindings.name.text)
      return
    }
    if (ts.isNamedImports(namedBindings)) {
      for (const spec of namedBindings.elements) {
        const imported = (spec.propertyName ?? spec.name).text
        const local = spec.name.text
        if (fromChildProcess(moduleText) && SPAWN_APIS.has(imported)) spawnApiLocals.set(local, imported)
        if (fromArgvSafety(moduleText) && GUARD_NAMES.has(imported)) guardLocals.add(local)
      }
    }
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const moduleText = stmt.moduleSpecifier.text
      handleNamedBindings(stmt.importClause?.namedBindings, moduleText)
    }
  }

  // Dynamic `const { execFileSync } = await import('child_process')`.
  forEachDescendant(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer || !node.name) return
    if (!ts.isObjectBindingPattern(node.name)) return
    let call = node.initializer
    if (ts.isAwaitExpression(call)) call = call.expression
    if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return
    const arg = call.arguments[0]
    if (!arg || !ts.isStringLiteral(arg) || !CHILD_PROCESS_SOURCES.has(arg.text)) return
    for (const el of node.name.elements) {
      if (!ts.isIdentifier(el.propertyName ?? el.name) || !ts.isIdentifier(el.name)) continue
      const imported = (el.propertyName ?? el.name).text
      const local = el.name.text
      if (SPAWN_APIS.has(imported)) spawnApiLocals.set(local, imported)
    }
  })

  return { spawnApiLocals, spawnNamespaces, guardLocals }
}

// ─── Module-scope constant resolution ──────────────────────────────────────

function collectModuleConstants(sourceFile) {
  const map = new Map()
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
    if (!isConst) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) map.set(decl.name.text, decl.initializer)
    }
  }
  return map
}

function isConstantExpr(node, moduleConstants, depth = 0) {
  if (depth > 6) return false
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return true
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isNoSubstitutionTemplateLiteral(node)) return true
  if (ts.isParenthesizedExpression(node)) return isConstantExpr(node.expression, moduleConstants, depth + 1)
  if (ts.isIdentifier(node)) {
    const init = moduleConstants.get(node.text)
    if (!init) return false
    return isConstantExpr(init, moduleConstants, depth + 1)
  }
  return false
}

// ─── Shape 3: fused, non-dash-leading token ────────────────────────────────

/**
 * Concatenate the LEADING literal segments of a left-associated `+`-chain (in
 * source order), stopping at the first non-literal operand. `('--flag' +
 * '=') + value` and `'--flag=' + value` must produce the same prefix, so this
 * flattens the whole chain rather than only inspecting `node.left`.
 */
function leadingFixedPrefix(node) {
  const flat = []
  const flatten = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      flatten(n.left)
      flatten(n.right)
    } else {
      flat.push(n)
    }
  }
  flatten(node)
  let prefix = ''
  for (const part of flat) {
    if (ts.isStringLiteral(part) || ts.isNoSubstitutionTemplateLiteral(part)) prefix += part.text
    else break
  }
  return prefix
}

/**
 * Shape 3 is safe because the flag/key NAME is completely fixed and
 * DELIMITED — a target CLI's parser matches the flag by the characters up to
 * and including `=`, and an argv array element is never re-tokenised (no
 * shell, one element per string), so nothing after that `=` can be read as a
 * different flag no matter what the interpolated value contains. The
 * fixed-and-delimited part is what makes it safe, not whether it happens to
 * start with `-` — case 3's own examples (`--prompt=`, `--model=`) do.
 *
 * A prefix that does NOT end in `=` (a bare `-${value}`, say) does not have
 * this property: everything after the dash would be attacker-controlled with
 * no delimiter, which is exactly the shape a getopt-style parser can read as
 * more flag characters. That case is not shape 3 — it needs shape 1 or 2.
 */
function isFusedSafeToken(node) {
  if (ts.isTemplateExpression(node)) return node.head.text.endsWith('=')
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return leadingFixedPrefix(node).endsWith('=')
  }
  return false
}

/** Non-constant sub-expressions embedded in a template/`+`-concat that is NOT shape 3. */
function decomposeDynamicParts(node) {
  if (ts.isTemplateExpression(node)) return node.templateSpans.map((s) => s.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts = []
    const walk = (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        walk(n.left)
        walk(n.right)
      } else if (!ts.isStringLiteral(n) && !ts.isNoSubstitutionTemplateLiteral(n)) {
        parts.push(n)
      }
    }
    walk(node)
    return parts
  }
  return [node]
}

// ─── Shape 1: guard call, direct or one-hop wrapper ────────────────────────

/**
 * Every guarded path key in the file: a direct `assertSafeArgvValue(x, ...)`
 * / `isSafeArgvValue(x)` call, or a call to a locally-defined wrapper whose
 * own body calls one of those guards on its first parameter.
 */
function collectGuardedPathKeys(sourceFile, guardLocals) {
  const guardedDirect = new Set()
  const wrapperNames = new Set()

  if (guardLocals.size) {
    forEachDescendant(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
      if (!guardLocals.has(node.expression.text)) return
      const key = node.arguments[0] && pathKeyOf(node.arguments[0])
      if (key !== null && key !== undefined) guardedDirect.add(key)
    })

    forEachDescendant(sourceFile, (fn) => {
      if (!isFunctionLike(fn)) return
      const name = functionName(fn)
      if (!name) return
      const params = fn.parameters
      if (!params.length || !ts.isIdentifier(params[0].name)) return
      const paramName = params[0].name.text
      if (!fn.body) return
      let calls = false
      forEachChildSkipFunctions(fn.body, (node) => {
        if (calls || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
        if (!guardLocals.has(node.expression.text)) return
        const arg = node.arguments[0]
        if (arg && ts.isIdentifier(arg) && arg.text === paramName) calls = true
      })
      if (calls) wrapperNames.add(name)
    })
  }

  const guardedViaWrapper = new Set()
  if (wrapperNames.size) {
    forEachDescendant(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
      if (!wrapperNames.has(node.expression.text)) return
      const key = node.arguments[0] && pathKeyOf(node.arguments[0])
      if (key !== null && key !== undefined) guardedViaWrapper.add(key)
    })
  }

  return new Set([...guardedDirect, ...guardedViaWrapper])
}

function isShape1Guarded(node, guardedPathKeys) {
  const key = pathKeyOf(node)
  return key !== null && guardedPathKeys.has(key)
}

// ─── Array / push resolution ────────────────────────────────────────────────

function isSpreadyArrayLiteral(arr) {
  return arr.elements.some((e) => ts.isSpreadElement(e))
}

/**
 * Resolve an identifier's array value within `scopeFn` (or the module, if
 * scopeFn is null): a `const name = <ArrayLiteral | Conditional-of-two-
 * ArrayLiterals>` plus any `name.push(...)` calls that follow it in source
 * order, within the same function (not crossing into a nested one).
 *
 * @returns {Array<Array<import('typescript').Expression>>|null} one element
 *   array per reachable branch, or null if unresolvable (opaque).
 */
function resolveIdentifierArrayBranches(name, scopeFn, sourceFile) {
  let declInit = null
  let declPos = -1
  const visitDecl = (node) => {
    if (declInit) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      declInit = node.initializer
      declPos = node.pos
    }
  }
  if (scopeFn) {
    forEachChildSkipFunctions(scopeFn.body ?? scopeFn, visitDecl)
  } else {
    for (const stmt of sourceFile.statements) {
      visitDecl(stmt)
      forEachChildSkipFunctions(stmt, visitDecl)
    }
  }

  if (!declInit) return null

  let branchInits
  if (ts.isArrayLiteralExpression(declInit)) {
    if (isSpreadyArrayLiteral(declInit)) return null
    branchInits = [[...declInit.elements]]
  } else if (ts.isConditionalExpression(declInit)) {
    const a = declInit.whenTrue
    const b = declInit.whenFalse
    if (!ts.isArrayLiteralExpression(a) || !ts.isArrayLiteralExpression(b)) return null
    if (isSpreadyArrayLiteral(a) || isSpreadyArrayLiteral(b)) return null
    branchInits = [[...a.elements], [...b.elements]]
  } else {
    return null
  }

  const pushed = []
  let opaquePush = false
  const visitPush = (node) => {
    if (opaquePush) return
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return
    const call = node.expression
    if (!ts.isPropertyAccessExpression(call.expression)) return
    if (!ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== name) return
    if (call.expression.name.text !== 'push') return
    if (call.pos <= declPos) return
    if (call.arguments.some((a) => ts.isSpreadElement(a))) { opaquePush = true; return }
    pushed.push(...call.arguments)
  }
  if (scopeFn) {
    forEachChildSkipFunctions(scopeFn.body ?? scopeFn, visitPush)
  } else {
    for (const stmt of sourceFile.statements) {
      visitPush(stmt)
      forEachChildSkipFunctions(stmt, visitPush)
    }
  }
  if (opaquePush) return null

  return branchInits.map((elems) => [...elems, ...pushed])
}

/** @returns {Array<Array<import('typescript').Expression>>|null} */
function resolveArgvBranches(argExpr, scopeFn, sourceFile) {
  if (ts.isArrayLiteralExpression(argExpr)) {
    if (isSpreadyArrayLiteral(argExpr)) return null
    return [[...argExpr.elements]]
  }
  if (ts.isIdentifier(argExpr)) {
    return resolveIdentifierArrayBranches(argExpr.text, scopeFn, sourceFile)
  }
  return null
}

/** Find `const <name> = <init>` within scopeFn (or module scope), not crossing into a nested function. */
function findLocalConstInit(name, scopeFn, sourceFile) {
  let init = null
  const visit = (node) => {
    if (init) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      init = node.initializer
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
  return init
}

function calleeMatchesBuildArgsName(callee) {
  if (ts.isIdentifier(callee)) return BUILD_ARGS_NAME.test(callee.text)
  if (ts.isPropertyAccessExpression(callee)) return BUILD_ARGS_NAME.test(callee.name.text)
  return false
}

// `prepareSpawn(command, args, ...)` (utils/win-spawn.js) re-escapes each argv
// element for a Windows `.cmd`/`.bat` shim's cmd.exe relay. It does not
// reorder, drop, or reinterpret elements — each input element maps 1:1 to an
// output element, just quote/escape-wrapped — so tracing an argv sink THROUGH
// it does not weaken the audit; it just means the real construction to look
// at is prepareSpawn's own second argument, not `<result>.args`.
const ARGV_PASSTHROUGH_WRAPPERS = new Set(['prepareSpawn'])

/**
 * Is `argExpr` (the args argument at a spawn-like call site) delegated to a
 * `_buildArgs` / `build*Args`-shaped function that this lint audits
 * separately, at that function's OWN definition (pass 2 below)? This is the
 * dominant shape in this codebase: a provider subclass overrides
 * `_buildArgs(text)` to build the array, and the base class spawns it (often
 * through the `prepareSpawn` wrapper above) — two different functions, and
 * frequently two different files/classes via virtual dispatch that a
 * per-call-site analysis cannot trace. Recognising the CONTRACT NAME instead
 * of tracing the dispatch is what makes this tractable; both sides of it
 * (this call, and the function it defers to) are still checked.
 */
function resolvesToAuditedBuildArgs(argExpr, scopeFn, sourceFile, depth = 0) {
  if (depth > 3) return false
  if (ts.isCallExpression(argExpr) && calleeMatchesBuildArgsName(argExpr.expression)) return true
  if (ts.isIdentifier(argExpr)) {
    const init = findLocalConstInit(argExpr.text, scopeFn, sourceFile)
    return !!init && ts.isCallExpression(init) && calleeMatchesBuildArgsName(init.expression)
  }
  if (ts.isPropertyAccessExpression(argExpr) && ts.isIdentifier(argExpr.expression)) {
    const init = findLocalConstInit(argExpr.expression.text, scopeFn, sourceFile)
    if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return false
    if (!ARGV_PASSTHROUGH_WRAPPERS.has(init.expression.text)) return false
    const inner = init.arguments[1]
    return !!inner && resolvesToAuditedBuildArgs(inner, scopeFn, sourceFile, depth + 1)
  }
  return false
}

// ─── Finding evaluation ─────────────────────────────────────────────────────

/**
 * @param {import('typescript').Expression} elem
 * @param {Array<import('typescript').Expression>} branchElements
 * @param {number} index
 * @param {Set<string>} guardedPathKeys
 * @param {Map<string,import('typescript').Expression>} moduleConstants
 * @returns {boolean}
 */
function isGuardedElement(elem, branchElements, index, guardedPathKeys, moduleConstants) {
  if (isFusedSafeToken(elem)) return true
  for (let j = 0; j < index; j++) {
    const prior = branchElements[j]
    if (ts.isStringLiteral(prior) && prior.text === '--') return true
  }
  if (ts.isTemplateExpression(elem) || (ts.isBinaryExpression(elem) && elem.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
    const parts = decomposeDynamicParts(elem)
    return parts.every((p) => isConstantExpr(p, moduleConstants) || isShape1Guarded(p, guardedPathKeys))
  }
  return isShape1Guarded(elem, guardedPathKeys)
}

function isIgnoreMarkerAbove(node, sourceFile, rawLines) {
  const line = lineOf(node, sourceFile)
  const above = rawLines[line - 2] // line is 1-based; line-2 is the 0-based index of the line above
  if (above === undefined) return false
  return new RegExp(`^\\s*(?://|\\*)\\s*${IGNORE_MARKER}:\\s*\\S`).test(above)
}

/**
 * @typedef {{ file: string, line: number, text: string, catalogueKey: string }} Finding
 */

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

  const { spawnApiLocals, spawnNamespaces, guardLocals } = collectImports(sourceFile)
  const moduleConstants = collectModuleConstants(sourceFile)
  const guardedPathKeys = collectGuardedPathKeys(sourceFile, guardLocals)

  const findings = []
  let sinksScanned = 0

  const evaluateBranches = (branches, siteNode, calleeLabel) => {
    if (branches === null) {
      sinksScanned++
      const line = lineOf(siteNode, sourceFile)
      if (isIgnoreMarkerAbove(siteNode, sourceFile, rawLines)) return
      findings.push({
        file: rel,
        line,
        text: `${calleeLabel}(...) — argv could not be statically resolved (not an array literal, a local push-built array, or a two-branch ternary of either)`,
        catalogueKey: normText(siteNode, source).slice(0, 200),
      })
      return
    }
    for (const elements of branches) {
      elements.forEach((elem, idx) => {
        if (isConstantExpr(elem, moduleConstants)) return
        sinksScanned++
        if (isGuardedElement(elem, elements, idx, guardedPathKeys, moduleConstants)) return
        if (isIgnoreMarkerAbove(elem, sourceFile, rawLines)) return
        findings.push({
          file: rel,
          line: lineOf(elem, sourceFile),
          text: `${calleeLabel}(...) argv element \`${normText(elem, source)}\` is not provably constant and is not gated`,
          catalogueKey: normText(elem, source).slice(0, 200),
        })
      })
    }
  }

  // 1. Literal spawn-API call sites.
  forEachDescendant(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return
    let api = null
    if (ts.isIdentifier(node.expression) && spawnApiLocals.has(node.expression.text)) {
      api = spawnApiLocals.get(node.expression.text)
    } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
      spawnNamespaces.has(node.expression.expression.text) && SPAWN_APIS.has(node.expression.name.text)) {
      api = node.expression.name.text
    }
    if (!api) return
    const argsArg = node.arguments[1]
    if (!argsArg) return // called with no argv array — nothing to check
    const scopeFn = enclosingFunction(node)
    if (resolvesToAuditedBuildArgs(argsArg, scopeFn, sourceFile)) return // audited at its own definition (pass 2)
    const branches = resolveArgvBranches(argsArg, scopeFn, sourceFile)
    evaluateBranches(branches, node, api)
  })

  // 2. `_buildArgs` / `build*Args`-shaped functions: inspect their return value.
  forEachDescendant(sourceFile, (fn) => {
    if (!isFunctionLike(fn)) return
    const name = functionName(fn)
    if (!name || !BUILD_ARGS_NAME.test(name)) return
    if (!fn.body || !ts.isBlock(fn.body)) return
    for (const stmt of fn.body.statements) {
      if (!ts.isReturnStatement(stmt) || !stmt.expression) continue
      const branches = resolveArgvBranches(stmt.expression, fn, sourceFile)
      evaluateBranches(branches, stmt, `${name} (return)`)
    }
  })

  return { findings, sinksScanned }
}

// ─── Catalogue ──────────────────────────────────────────────────────────────

async function loadCatalogue(path) {
  let mod
  try {
    const url = pathToFileURL(resolve(path))
    url.search = `t=${Date.now()}`
    mod = await import(url.href)
  } catch (err) {
    usageError(`cannot load catalogue module ${path}: ${err.message}`)
  }
  const list = mod.AUDITED_SINKS
  if (!Array.isArray(list)) usageError(`${path} does not export an AUDITED_SINKS array`)
  for (const [i, entry] of list.entries()) {
    if (typeof entry?.file !== 'string' || typeof entry?.match !== 'string' || typeof entry?.reason !== 'string' || !entry.reason.trim()) {
      usageError(`AUDITED_SINKS[${i}] must be { file, match, reason } with a non-empty reason`)
    }
  }
  return list
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2))
const usingDefaultSrcDirs = args.srcDirs.length === 0
const srcDirs = (usingDefaultSrcDirs ? [DEFAULT_SRC_DIR] : args.srcDirs).map((d) => resolve(d))
for (const dir of srcDirs) {
  if (!existsSync(dir)) usageError(`--src-dir does not exist: ${dir}`)
}
const catalogue = await loadCatalogue(args.catalogue ?? DEFAULT_CATALOGUE)

const keyRoot = srcDirs[0]
const allFindings = []
let scanned = 0
let totalSinks = 0

for (const srcDir of srcDirs) {
  const files = usingDefaultSrcDirs ? listFilesByGit(srcDir) : listFilesByWalk(srcDir)
  for (const file of files) {
    scanned++
    const { findings, sinksScanned } = analyzeFile(file, keyRoot)
    totalSinks += sinksScanned
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

// Direction 1: every real finding is catalogued (or fails).
const usedCatalogueIdx = new Set()
const uncatalogued = []
for (const f of allFindings) {
  const idx = catalogue.findIndex((c) => c.file === f.file && f.catalogueKey.includes(c.match))
  if (idx === -1) {
    uncatalogued.push(f)
  } else {
    usedCatalogueIdx.add(idx)
  }
}

// Direction 2: every catalogue entry still matches something real.
const staleCatalogue = catalogue.filter((_, i) => !usedCatalogueIdx.has(i))

for (const f of uncatalogued) {
  console.error(`${f.file}:${f.line}  ${f.text}`)
}
if (uncatalogued.length) {
  console.error('')
  console.error(`${uncatalogued.length} argv sink(s) are neither provably safe (assertSafeArgvValue / '--' terminator / fused flag token) nor catalogued.`)
  console.error('Guard the value, or add a { file, match, reason } entry to AUDITED_SINKS in utils/argv-safety.js.')
}
for (const c of staleCatalogue) {
  console.error(`AUDITED_SINKS: ${c.file} / ${JSON.stringify(c.match)} matches no current finding — remove the entry.`)
}

const failed = uncatalogued.length > 0 || staleCatalogue.length > 0
if (!failed) {
  console.log(`OK: ${scanned} file(s) scanned, ${totalSinks} argv element(s)/sink(s) checked, ${catalogue.length} catalogue entry(ies) all live.`)
}
process.exit(failed && !args.dryRun ? 1 : 0)
