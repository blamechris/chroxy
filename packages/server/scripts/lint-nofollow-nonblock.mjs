#!/usr/bin/env node
/**
 * Lint: every `O_NOFOLLOW` flags value that reaches an open also carries
 * `O_NONBLOCK`, or carries an allowlist reason (#7938).
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
 * ## The two checks
 *
 * The lint does not try to recognise "an open call" by its callee. Every way
 * of spelling one — `openSync`, `fs.open` (callback), `fsp.open`,
 * `fs.promises.open`, an alias, `deps.openSync`, a dependency-injection
 * parameter renamed to `doOpen`, a wrapper such as `openNoFollow` — is a call
 * whose argument carries the flags. So the lint follows the FLAGS VALUE
 * instead, in both directions:
 *
 *   1. FORWARD — every argument of every call (callee-agnostic) is evaluated
 *      as a flags expression. If any value it can take includes O_NOFOLLOW,
 *      every such value must also include O_NONBLOCK, or the call must carry
 *      the allowlist marker. Object/array/function/string arguments are not
 *      flags and are skipped here — the reverse check covers any O_NOFOLLOW
 *      inside them.
 *
 *   2. REVERSE — every O_NOFOLLOW reference in the source must be accounted
 *      for. A reference is accounted for when it sits lexically inside a call
 *      argument the forward check evaluated; or when the expression it is
 *      built into already carries O_NONBLOCK in every value (`export const F =
 *      O_RDONLY | O_NOFOLLOW | O_NONBLOCK`); or when it is stored under a name
 *      that is itself O_NOFOLLOW-named (`oNofollow: fsConstants.O_NOFOLLOW` in
 *      a deps object — every later use of that name is itself a reference, so
 *      the value is still followed); or when it is only feature-detected
 *      (`typeof`, a comparison, `!`, a condition). A reference stored in an
 *      ordinary local is followed to every use of that local. ANYTHING ELSE —
 *      a `return`, an `export`, an object property with an unrelated name, a
 *      renaming destructure, an array element — is a place the value leaves
 *      the lint's sight, and is a finding. This is what makes an unresolvable
 *      flow FAIL rather than pass: a flag passed into a function parameter, a
 *      flags const imported from another module, `this.flags`, and a
 *      `{ flags }` option bag all reach the reverse check even though the
 *      forward check cannot see the open that eventually consumes them.
 *
 * ## Flag-expression evaluation
 *
 * A flags expression is evaluated to the SET OF VALUES it can take, each
 * recorded as "has O_NOFOLLOW?" × "has O_NONBLOCK?" — not to one merged bag of
 * names, so `c ? O_NOFOLLOW : O_NONBLOCK` is a finding (one of its values has
 * O_NOFOLLOW and not O_NONBLOCK).
 *
 *   - `a | b` combines every value of `a` with every value of `b`.
 *   - `c ? a : b`, and `a || b` / `a ?? b`, are either side's values. The
 *     platform-fallback idiom `(fsConstants.O_NONBLOCK || 0)` — a falsy
 *     literal on the right — is read as its left side.
 *   - A name (identifier, `.property`, `['string']`, destructured or imported
 *     binding) is recognised by NAME: normalised (lower-cased, `_`/`$`
 *     removed) it contains `onofollow` / `ononblock` (`O_NOFOLLOW`,
 *     `fsConstants.O_NONBLOCK`, `oNofollow`). A predicate name (`has…`,
 *     `is…`, `can…`, `supports…`) never counts: `HAS_O_NONBLOCK` is a
 *     boolean, not the flag.
 *   - A local variable is resolved to every value assigned to it anywhere in
 *     the file: its initializer and each `x = …` are alternatives, wherever
 *     they sit. An `x |= …` is ORed into all of them only when it is (a) not
 *     nested in a branch, loop, try block, case, catch or closure, (b)
 *     positioned BEFORE the read being evaluated, and (c) the variable is
 *     never reassigned with `=`; otherwise it is only a "maybe" (adds that
 *     share the same guard text are applied together). The one conditional
 *     add read as certain is an O_NONBLOCK add guarded by a condition that
 *     names O_NONBLOCK itself (`if (hasONonBlock) flags |=
 *     fsConstants.O_NONBLOCK`): O_NONBLOCK is then missing only where the
 *     platform has no O_NONBLOCK. Any other write (`&=`, `^=`, `++`, a
 *     destructuring assignment) can clear bits, so it drops O_NONBLOCK from
 *     every value.
 *   - An O_NONBLOCK-named local whose resolved values carry no O_NONBLOCK at
 *     all (`const O_NONBLOCK = 0x800`, a hardcoded number that is O_EXCL on
 *     macOS) is NOT trusted by its name.
 *   - Anything else — a call, `&`, `~`, `-`, a computed element access — is
 *     OPAQUE: O_NOFOLLOW found anywhere inside it still counts (fail closed),
 *     O_NONBLOCK found inside it does NOT (`(f | NF) & ~O_NONBLOCK` masks it
 *     out).
 *
 * ## What this lint does not prove
 *
 * It guards against mistakes, not deliberate obfuscation: a hardcoded numeric
 * flag (`0x100` is O_NOFOLLOW on macOS), a computed property name
 * (`constants['O_' + 'NOFOLLOW']`), or a value laundered through JSON cannot
 * be traced by name. The NAME rule is the one place it trusts rather than
 * proves: an O_NONBLOCK-named property (`anything.O_NONBLOCK`), or an
 * O_NONBLOCK-named binding whose value it cannot see (a parameter, an
 * import, a call result), is taken at its word. Every flow approximation
 * above errs the other way — it can only add possible values, so it can
 * produce a false positive (a value overwritten before the open, two
 * DIFFERENT guards that are in fact correlated), never a false pass.
 *
 * ## Roster
 *
 * In the default mode the lint also reads every tracked code file under
 * `packages/` and `scripts/` OUTSIDE the scanned trees (tests excluded) and
 * fails if any of them references an O_NOFOLLOW-named symbol — a package that
 * starts using O_NOFOLLOW must be added to the sweep, not silently skipped.
 *
 * ## Allowlist
 *
 * `// lint-allow-nofollow-blocking: <reason>` on the line immediately above
 * the call, the reference, or the statement containing it — for a site where
 * blocking is PROVABLY impossible regardless of O_NONBLOCK (e.g. an
 * `O_DIRECTORY` open: a FIFO cannot satisfy it). The reason is required.
 *
 * ## Fail-closed
 *
 * Exit 2 — "the guard is broken, not necessarily the code" — when: nothing
 * was scanned; fewer than `--min-files` files were scanned; ZERO call
 * arguments carrying O_NOFOLLOW were found (this repo has several, so zero
 * means the detector broke — #7503); an unscanned file references
 * O_NOFOLLOW; a file fails to parse; or a flags expression is too deep to
 * evaluate.
 *
 * Exit codes: 0 clean · 1 at least one finding · 2 the lint could not do its job.
 *
 * Flags:
 *   --src-dir <path>     Directory to scan. REPEATABLE. Defaults to
 *                        packages/server/src AND packages/claude-hooks/src,
 *                        each enumerated via `git ls-files`.
 *   --min-files <n>      Fail (exit 2) if FEWER than n files were scanned.
 *   --roster-dir <path>  Directory whose files must NOT reference O_NOFOLLOW
 *                        (REPEATABLE). Defaults, in default mode only, to
 *                        every tracked file under packages/ and scripts/.
 *   --list-checked       Print every call argument the forward check verified.
 *   --dry-run            Print offenders without failing the exit code.
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
const SELF = fileURLToPath(import.meta.url)

const IGNORE_MARKER = 'lint-allow-nofollow-blocking'
const MARKER_RE = new RegExp(`^\\s*(?://|\\*)\\s*${IGNORE_MARKER}:\\s*\\S`)
const SOURCE_EXT_RE = /\.(?:c|m)?js$/
const ROSTER_EXT_RE = /\.(?:c|m)?(?:j|t)sx?$/
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.(?:c|m)?(?:j|t)sx?$/
const MAX_DEPTH = 64

const NF = 1
const NB = 2

class LintAbort extends Error {}

function usageError(message) {
  console.error(`lint-nofollow-nonblock: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const out = { srcDirs: [], rosterDirs: [], minFiles: null, dryRun: false, listChecked: false }
  const needsValue = (flag, value) => {
    if (value === undefined) usageError(`${flag} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--src-dir') out.srcDirs.push(needsValue(arg, argv[++i]))
    else if (arg === '--roster-dir') out.rosterDirs.push(needsValue(arg, argv[++i]))
    else if (arg === '--min-files') out.minFiles = Number(needsValue(arg, argv[++i]))
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--list-checked') out.listChecked = true
    else usageError(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (out.minFiles !== null && (!Number.isInteger(out.minFiles) || out.minFiles < 0)) {
    usageError('--min-files requires a non-negative integer')
  }
  return out
}

// ─── File enumeration ──────────────────────────────────────────────────────

function walk(dir, extRe) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full, extRe))
    else if (extRe.test(entry)) out.push(full)
  }
  return out.sort()
}

function gitLsFiles(relPaths) {
  try {
    return execFileSync('git', ['ls-files', '--', ...relPaths], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean)
  } catch (err) {
    usageError(`git ls-files failed for ${relPaths.join(' ')}: ${err.message}`)
  }
}

function listSourceFilesByGit(srcDir) {
  return gitLsFiles([relative(REPO_ROOT, srcDir)])
    .filter((l) => SOURCE_EXT_RE.test(l)).map((l) => join(REPO_ROOT, l)).sort()
}

// ─── Names ───────────────────────────────────────────────────────────────────

function normalizeName(text) {
  return text.toLowerCase().replace(/[_$]/g, '')
}
/** Name bits ignoring the predicate exclusion — for guards and the roster. */
function rawBits(text) {
  const n = normalizeName(text)
  return (n.includes('onofollow') ? NF : 0) | (n.includes('ononblock') ? NB : 0)
}
const PREDICATE_PREFIX_RE = /^(?:has|is|can|supports?)/
/** The flag bits a NAME stands for. A predicate (`hasONoFollow`) is a boolean, not a flag. */
function nameBits(text) {
  if (PREDICATE_PREFIX_RE.test(normalizeName(text))) return 0
  return rawBits(text)
}
const IDENTIFIER_LIKE_RE = /^[A-Za-z_$][\w$]*$/
function stringBits(text) {
  return IDENTIFIER_LIKE_RE.test(text) ? nameBits(text) : 0
}

// ─── Value sets ──────────────────────────────────────────────────────────────

const ZERO = () => ({ alts: new Set([0]), opaque: false })
function cross(a, b) {
  const alts = new Set()
  for (const x of a.alts) for (const y of b.alts) alts.add(x | y)
  return { alts, opaque: a.opaque || b.opaque }
}
function union(a, b) {
  return { alts: new Set([...a.alts, ...b.alts]), opaque: a.opaque || b.opaque }
}
const anyNF = (v) => [...v.alts].some((a) => a & NF)
const anyNB = (v) => [...v.alts].some((a) => a & NB)
const allNB = (v) => [...v.alts].every((a) => a & NB)
/** Every value that carries O_NOFOLLOW also carries O_NONBLOCK. */
const certified = (v) => [...v.alts].every((a) => !(a & NF) || (a & NB))

// ─── AST helpers ─────────────────────────────────────────────────────────────

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
    (typeof ts.isClassStaticBlockDeclaration === 'function' && ts.isClassStaticBlockDeclaration(node))
}

function scopeContainerOf(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur) || ts.isSourceFile(cur)) return cur
  }
  return null
}

function isAssignmentKind(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

const COMPARISON_KINDS = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword, ts.SyntaxKind.InKeyword,
])

function isTransparentWrapper(node) {
  return ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
    (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(node))
}

function isFalsyLiteral(node) {
  while (isTransparentWrapper(node)) node = node.expression
  if (ts.isNumericLiteral(node)) return Number(node.text) === 0
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isIdentifier(node) && node.text === 'undefined') return true
  if (ts.isVoidExpression(node)) return true
  return false
}

/** An argument shape that is never itself a flags bitmask. */
function isNonFlagShape(node) {
  return isFunctionLike(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) ||
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) ||
    ts.isClassExpression(node) || ts.isSpreadElement(node) || ts.isRegularExpressionLiteral(node)
}

/** Is `id` an identifier in a position where it READS a binding's value? */
function isValueIdentifier(id) {
  const p = id.parent
  if (!p) return false
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if (ts.isQualifiedName(p)) return false
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) ||
    ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return false
  if (ts.isVariableDeclaration(p) && p.name === id) return false
  // A destructuring DEFAULT (`{ flags = O_NOFOLLOW } = opts`) is a value; the
  // bound name and the property it is read from are not.
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false
  if (ts.isParameter(p) && p.name === id) return false
  if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === id) return false
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false
  // `export { a }` reads `a`; `export { a as b }` reads `a` (propertyName), not `b`.
  if (ts.isExportSpecifier(p)) return (p.propertyName ?? p.name) === id
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false
  if (ts.isBinaryExpression(p) && p.left === id && isAssignmentKind(p.operatorToken.kind)) return false
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return false
  if (ts.isMetaProperty(p)) return false
  return true
}

/** Is `node` only being tested (feature detection), never used as a flag value? */
function isDetectionContext(node) {
  let cur = node
  while (cur.parent && (isTransparentWrapper(cur.parent) ||
    (ts.isBinaryExpression(cur.parent) && cur.parent.operatorToken.kind === ts.SyntaxKind.AmpersandToken))) {
    cur = cur.parent
  }
  const p = cur.parent
  if (!p) return false
  if (ts.isTypeOfExpression(p)) return true
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true
  if (ts.isBinaryExpression(p)) {
    const k = p.operatorToken.kind
    if (COMPARISON_KINDS.has(k)) return true
    if (k === ts.SyntaxKind.AmpersandAmpersandToken && p.left === cur) return true
  }
  if (ts.isConditionalExpression(p) && p.condition === cur) return true
  if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === cur) return true
  if (ts.isForStatement(p) && p.condition === cur) return true
  return false
}

/** Walk up from a value reference through everything that only combines/transforms a value. */
function valueRoot(node) {
  let cur = node
  for (;;) {
    const p = cur.parent
    if (!p) return cur
    if (isTransparentWrapper(p)) { cur = p; continue }
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind
      if (!isAssignmentKind(k) && !COMPARISON_KINDS.has(k) && k !== ts.SyntaxKind.CommaToken) { cur = p; continue }
      if (k === ts.SyntaxKind.CommaToken && p.right === cur) { cur = p; continue }
    }
    if (ts.isConditionalExpression(p) && p.condition !== cur) { cur = p; continue }
    if (ts.isPrefixUnaryExpression(p) && p.operator !== ts.SyntaxKind.ExclamationToken &&
      p.operator !== ts.SyntaxKind.PlusPlusToken && p.operator !== ts.SyntaxKind.MinusMinusToken) { cur = p; continue }
    return cur
  }
}

function lineOf(node, sf) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function normText(node, sf) {
  return node.getText(sf).trim().replace(/\s+/g, ' ')
}

function enclosingStatement(node) {
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.parent && (ts.isBlock(cur.parent) || ts.isSourceFile(cur.parent) || ts.isCaseClause(cur.parent) ||
      ts.isDefaultClause(cur.parent) || ts.isModuleBlock(cur.parent))) return cur
  }
  return node
}

// ─── Per-file analysis ───────────────────────────────────────────────────────

function analyzeFile(filePath, keyRoot) {
  const source = readFileSync(filePath, 'utf8')
  const rel = relative(keyRoot, filePath).split(pathSep).join('/')
  // A name can only carry O_NOFOLLOW if its text says so, and cross-module
  // flows are caught where the value is BUILT (the reverse check) — so a file
  // that never spells "nofollow" has nothing for either check to find.
  if (!/nofollow/i.test(source)) return { findings: [], checked: [], refs: 0 }

  const rawLines = source.split('\n')
  let sf
  try {
    sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.JS)
  } catch (err) {
    usageError(`cannot parse ${filePath}: ${err.message}`)
  }
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) {
    const d = sf.parseDiagnostics[0]
    usageError(`cannot parse ${rel}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }

  const markerAbove = (node) => {
    const lines = new Set([lineOf(node, sf), lineOf(enclosingStatement(node), sf)])
    for (const line of lines) {
      const above = rawLines[line - 2]
      if (above !== undefined && MARKER_RE.test(above)) return true
    }
    return false
  }

  // ── Indexes: identifier occurrences and writes, by name ──
  const identifiersByName = new Map()
  const writesByName = new Map()
  const varDecls = [] // hoisted `var` declarations
  const addWrite = (target, kind, rhs, node) => {
    if (!writesByName.has(target.text)) writesByName.set(target.text, [])
    writesByName.get(target.text).push({ target, kind, rhs, node })
  }
  const collectDestructuringTargets = (pattern, node) => {
    const visit = (n) => {
      if (ts.isIdentifier(n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
        addWrite(n, 'kill', null, node)
        return
      }
      n.forEachChild(visit)
    }
    visit(pattern)
  }
  const indexVisit = (node) => {
    if (ts.isIdentifier(node)) {
      if (!identifiersByName.has(node.text)) identifiersByName.set(node.text, [])
      identifiersByName.get(node.text).push(node)
    } else if (ts.isBinaryExpression(node) && isAssignmentKind(node.operatorToken.kind)) {
      const k = node.operatorToken.kind
      const left = node.left
      if (ts.isIdentifier(left)) {
        if (k === ts.SyntaxKind.EqualsToken || k === ts.SyntaxKind.BarBarEqualsToken || k === ts.SyntaxKind.QuestionQuestionEqualsToken) {
          addWrite(left, 'base', node.right, node)
        } else if (k === ts.SyntaxKind.BarEqualsToken) {
          addWrite(left, 'add', node.right, node)
        } else {
          addWrite(left, 'kill', null, node)
        }
      } else if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) {
        collectDestructuringTargets(left, node)
      }
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)) {
      addWrite(node.operand, 'kill', null, node)
    } else if (ts.isVariableDeclarationList(node) &&
      (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      for (const d of node.declarations) varDecls.push(d)
    }
    node.forEachChild(indexVisit)
  }
  indexVisit(sf)

  // ── Scope resolution ──
  const bindingInName = (nameNode, name) => {
    if (ts.isIdentifier(nameNode)) return nameNode.text === name ? nameNode : null
    for (const el of nameNode.elements) {
      if (ts.isOmittedExpression(el)) continue
      if (ts.isIdentifier(el.name)) { if (el.name.text === name) return el; continue }
      const inner = bindingInName(el.name, name)
      if (inner) return inner
    }
    return null
  }
  const bindingFor = (decl, name) => {
    const b = bindingInName(decl.name, name)
    if (!b) return null
    return b === decl.name ? { kind: 'var', node: decl } : { kind: 'binding', node: b }
  }
  const findInStatements = (stmts, name, isFile) => {
    for (const s of stmts) {
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          const b = bindingFor(d, name)
          if (b) return b
        }
      } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name && s.name.text === name) {
        return { kind: 'opaque', node: s }
      } else if (isFile && ts.isImportDeclaration(s) && s.importClause) {
        const ic = s.importClause
        if (ic.name && ic.name.text === name) return { kind: 'opaque', node: ic }
        const nb = ic.namedBindings
        if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) return { kind: 'opaque', node: nb }
        if (nb && ts.isNamedImports(nb)) {
          for (const sp of nb.elements) if (sp.name.text === name) return { kind: 'import', node: sp }
        }
      }
    }
    return null
  }
  const findHoistedVar = (container, name) => {
    for (const d of varDecls) {
      if (scopeContainerOf(d) !== container) continue
      const b = bindingFor(d, name)
      if (b) return b
    }
    return null
  }
  const resolveCache = new Map()
  const resolveId = (id) => {
    if (resolveCache.has(id)) return resolveCache.get(id)
    const name = id.text
    let found = null
    for (let cur = id.parent; cur && !found; cur = cur.parent) {
      if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur) || ts.isModuleBlock(cur)) {
        found = findInStatements(cur.statements, name, ts.isSourceFile(cur))
      }
      if (!found && (ts.isForStatement(cur) || ts.isForOfStatement(cur) || ts.isForInStatement(cur)) &&
        cur.initializer && ts.isVariableDeclarationList(cur.initializer)) {
        for (const d of cur.initializer.declarations) { found = bindingFor(d, name); if (found) break }
      }
      if (!found && ts.isCatchClause(cur) && cur.variableDeclaration && bindingInName(cur.variableDeclaration.name, name)) {
        found = { kind: 'opaque', node: cur.variableDeclaration }
      }
      if (!found && isFunctionLike(cur)) {
        for (const p of cur.parameters) {
          const b = bindingInName(p.name, name)
          if (b) { found = b === p.name ? { kind: 'param', node: p } : { kind: 'binding', node: b }; break }
        }
        if (!found && ts.isFunctionExpression(cur) && cur.name && cur.name.text === name) found = { kind: 'opaque', node: cur }
        if (!found) found = findHoistedVar(cur, name)
      }
      if (!found && ts.isSourceFile(cur)) found = findHoistedVar(cur, name)
    }
    resolveCache.set(id, found)
    return found
  }

  // ── Evaluation ──
  const declCache = new Map()
  const visiting = new Set()

  const opaqueLeaf = (node, depth) => {
    let nf = false
    node.forEachChild((child) => {
      if (nf || isFunctionLike(child)) return
      if (anyNF(evaluate(child, depth + 1))) nf = true
    })
    return { alts: new Set([nf ? NF : 0]), opaque: true }
  }

  /** Guard signature of a write relative to its variable's scope, or null if unconditional. */
  const conditionOf = (writeNode, scopeRoot) => {
    const parts = []
    let nbDetected = true
    let child = writeNode
    for (let cur = writeNode.parent; cur && cur !== scopeRoot; child = cur, cur = cur.parent) {
      let guard = null
      let guardExpr = null
      if (ts.isIfStatement(cur) && child !== cur.expression) {
        guardExpr = cur.expression
        guard = `${child === cur.thenStatement ? 'if' : 'else'}(${normText(cur.expression, sf)})`
      } else if (ts.isConditionalExpression(cur) && child !== cur.condition) {
        guardExpr = cur.condition
        guard = `${child === cur.whenTrue ? '?' : ':'}(${normText(cur.condition, sf)})`
      } else if (ts.isBinaryExpression(cur) && child === cur.right &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(cur.operatorToken.kind)) {
        guardExpr = cur.left
        guard = `${cur.operatorToken.kind}(${normText(cur.left, sf)})`
      } else if ((ts.isForStatement(cur) || ts.isForOfStatement(cur) || ts.isForInStatement(cur) || ts.isWhileStatement(cur) ||
        ts.isDoStatement(cur)) && child === cur.statement) {
        // (a do-body runs once, but a `break`/`continue` inside it can skip the write)
        guard = `loop@${cur.pos}`
      } else if (ts.isTryStatement(cur) && child === cur.tryBlock) {
        // anything earlier in the try block can throw past the write
        guard = `try@${cur.pos}`
      } else if (ts.isCaseClause(cur) || ts.isDefaultClause(cur) || ts.isCatchClause(cur) || isFunctionLike(cur)) {
        guard = `branch@${cur.pos}`
      }
      if (guard === null) continue
      parts.push(guard)
      let mentionsNB = false
      if (guardExpr) {
        const scan = (n) => {
          if (mentionsNB) return
          if ((ts.isIdentifier(n) || ts.isStringLiteral(n)) && (rawBits(n.text) & NB)) mentionsNB = true
          n.forEachChild(scan)
        }
        scan(guardExpr)
      }
      if (!mentionsNB) nbDetected = false
    }
    return parts.length ? { sig: parts.join(' '), nbDetected } : null
  }

  /**
   * Every value `vd` can hold where it is READ at source position `usePos`.
   * Flow is approximated conservatively — every approximation ADDS values:
   * each initializer/`=` is a possible value wherever it sits; an `|=` is
   * ORed into all of them only when it is unconditional, sits BEFORE the
   * read, and the variable is never reassigned (otherwise the lint cannot
   * order the writes, so the add is only "maybe").
   */
  const evalVarDecl = (vd, depth, usePos) => {
    const name = vd.name.text
    const scopeRoot = scopeContainerOf(vd)
    const bases = []
    if (vd.initializer) bases.push(vd.initializer)
    const adds = []
    let kill = false
    for (const w of writesByName.get(name) ?? []) {
      const r = resolveId(w.target)
      if (!r || r.node !== vd) continue
      if (w.kind === 'base') bases.push(w.rhs)
      else if (w.kind === 'kill') kill = true
      else adds.push(w)
    }
    const reassigned = bases.length > 1
    const unconditional = []
    const groups = new Map()
    const addTo = (sig, v) => {
      if (!groups.has(sig)) groups.set(sig, [])
      groups.get(sig).push(v)
    }
    for (const w of adds) {
      const v = evaluate(w.rhs, depth + 1)
      if (w.node.pos > usePos) { addTo(`after-read@${w.node.pos}`, v); continue }
      const c = conditionOf(w.node, scopeRoot)
      const certain = !c || (c.nbDetected && allNB(v))
      if (!certain) addTo(c.sig, v)
      else if (reassigned) addTo('reassigned', v)
      else unconditional.push(v)
    }
    let result
    if (bases.length) {
      result = bases.map((b) => evaluate(b, depth + 1)).reduce(union)
    } else if (vd.parent && ts.isVariableDeclarationList(vd.parent) && vd.parent.parent &&
      (ts.isForOfStatement(vd.parent.parent) || ts.isForInStatement(vd.parent.parent))) {
      // `for (const f of list)` — f is some element of `list`; opaque, but an
      // O_NOFOLLOW anywhere in `list` still counts.
      const iterated = evaluate(vd.parent.parent.expression, depth + 1)
      result = { alts: new Set([anyNF(iterated) ? NF : 0]), opaque: true }
    } else {
      result = ZERO()
    }
    for (const v of unconditional) result = cross(result, v)
    for (const vs of groups.values()) result = cross(result, union(vs.reduce(cross), ZERO()))
    if (kill) result = { alts: new Set([...result.alts].map((a) => a & ~NB)), opaque: true }
    return result
  }

  const evalDecl = (decl, depth, usePos) => {
    // A var's value depends on where it is read (see evalVarDecl); the rest do not.
    const key = decl.kind === 'var' ? usePos : -1
    if (!declCache.has(decl.node)) declCache.set(decl.node, new Map())
    const perUse = declCache.get(decl.node)
    if (perUse.has(key)) return perUse.get(key)
    if (visiting.has(decl.node)) return ZERO() // a cycle contributes nothing new
    visiting.add(decl.node)
    let result
    if (decl.kind === 'var') {
      result = evalVarDecl(decl.node, depth, usePos)
    } else if (decl.kind === 'binding') {
      const el = decl.node
      const prop = el.propertyName
      const text = prop && (ts.isIdentifier(prop) || ts.isStringLiteral(prop)) ? prop.text : (ts.isIdentifier(el.name) ? el.name.text : '')
      result = { alts: new Set([nameBits(text)]), opaque: true }
    } else if (decl.kind === 'import') {
      const sp = decl.node
      result = { alts: new Set([nameBits((sp.propertyName ?? sp.name).text)]), opaque: true }
    } else {
      result = { alts: new Set([0]), opaque: true }
    }
    visiting.delete(decl.node)
    perUse.set(key, result)
    return result
  }

  function evaluate(node, depth = 0) {
    if (depth > MAX_DEPTH) {
      throw new LintAbort(`${rel}:${lineOf(node, sf)}: flags expression is too deep to evaluate (> ${MAX_DEPTH})`)
    }
    if (isTransparentWrapper(node)) return evaluate(node.expression, depth + 1)
    if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind
      if (k === ts.SyntaxKind.BarToken) return cross(evaluate(node.left, depth + 1), evaluate(node.right, depth + 1))
      if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) {
        if (isFalsyLiteral(node.right)) return evaluate(node.left, depth + 1)
        return union(evaluate(node.left, depth + 1), evaluate(node.right, depth + 1))
      }
      if (k === ts.SyntaxKind.AmpersandAmpersandToken) return union(ZERO(), evaluate(node.right, depth + 1))
      if (k === ts.SyntaxKind.CommaToken) return evaluate(node.right, depth + 1)
      if (k === ts.SyntaxKind.EqualsToken) return evaluate(node.right, depth + 1)
      if (k === ts.SyntaxKind.BarEqualsToken) return cross(evaluate(node.left, depth + 1), evaluate(node.right, depth + 1))
      return opaqueLeaf(node, depth)
    }
    if (ts.isConditionalExpression(node)) return union(evaluate(node.whenTrue, depth + 1), evaluate(node.whenFalse, depth + 1))
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || ts.isVoidExpression(node) ||
      node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword || ts.isTypeOfExpression(node)) return ZERO()
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return ZERO()
    // A call's RESULT (an fd, a FileHandle, a helper's return value) is
    // opaque but carries no O_NOFOLLOW evidence of its own: its ARGUMENTS
    // are checked by the forward pass like every other call's, and an
    // O_NOFOLLOW a helper `return`s is caught by the reverse pass where the
    // helper builds it. Propagating the arguments' O_NOFOLLOW into the
    // result would make every `fd` returned by an O_NOFOLLOW open look like
    // a flags value.
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
      return { alts: new Set([0]), opaque: true }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { alts: new Set([stringBits(node.text)]), opaque: false }
    }
    if (ts.isPropertyAccessExpression(node)) {
      return { alts: new Set([nameBits(node.name.text)]), opaque: false }
    }
    if (ts.isElementAccessExpression(node) &&
      (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
      return { alts: new Set([stringBits(node.argumentExpression.text)]), opaque: false }
    }
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined' || node.text === 'NaN' || node.text === 'Infinity') return ZERO()
      const own = nameBits(node.text)
      const decl = resolveId(node)
      let v = decl ? evalDecl(decl, depth + 1, node.pos) : { alts: new Set([0]), opaque: true }
      if (own & NF) v = cross(v, { alts: new Set([NF]), opaque: false })
      // A name is trusted for O_NONBLOCK only when resolution cannot see the
      // value, or the value it resolves to does carry O_NONBLOCK somewhere
      // (the `HAS ? fsConstants.O_NONBLOCK : 0` platform-fallback const).
      if ((own & NB) && (v.opaque || anyNB(v))) v = cross(v, { alts: new Set([NB]), opaque: false })
      return v
    }
    return opaqueLeaf(node, depth)
  }

  // ── 1. FORWARD: every argument of every call ──
  const consumed = new Set()
  const markConsumed = (node) => {
    consumed.add(node)
    node.forEachChild((c) => { if (!isFunctionLike(c)) markConsumed(c) })
  }
  const findings = []
  const checked = []
  const visitCalls = (node) => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      for (const arg of node.arguments) {
        if (isNonFlagShape(arg)) continue
        const v = evaluate(arg)
        markConsumed(arg)
        if (!anyNF(v)) continue
        const line = lineOf(node, sf)
        checked.push(`${rel}:${line}`)
        if (certified(v) || markerAbove(node)) continue
        const reason = 'carries O_NOFOLLOW but is missing O_NONBLOCK in at least one value it can take — a FIFO/device planted at this path would hang the open() forever' +
          (v.opaque ? ' (part of the flags expression could not be fully resolved, so O_NONBLOCK cannot be proven present)' : '')
        findings.push({ file: rel, line, text: `call \`${normText(node, sf).slice(0, 160)}\` — argument \`${normText(arg, sf).slice(0, 120)}\` ${reason}` })
      }
    }
    node.forEachChild(visitCalls)
  }
  visitCalls(sf)

  // ── 2. REVERSE: every O_NOFOLLOW reference must be accounted for ──
  const queue = []
  const visitRefs = (node) => {
    if (ts.isIdentifier(node)) {
      if ((nameBits(node.text) & NF) && isValueIdentifier(node)) queue.push(node)
    } else if (ts.isPropertyAccessExpression(node)) {
      if ((nameBits(node.name.text) & NF) &&
        !(ts.isBinaryExpression(node.parent) && node.parent.left === node && isAssignmentKind(node.parent.operatorToken.kind))) queue.push(node)
    } else if (ts.isElementAccessExpression(node)) {
      const a = node.argumentExpression
      if ((ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && (stringBits(a.text) & NF)) queue.push(node)
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent
      const structural = ts.isElementAccessExpression(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) ||
        (ts.isPropertyAssignment(p) && p.name === node) || ts.isLiteralTypeNode?.(p) || ts.isExternalModuleReference?.(p)
      if (!structural && (stringBits(node.text) & NF)) queue.push(node)
    } else if (ts.isBindingElement(node) || ts.isImportSpecifier(node)) {
      // A RENAME of an O_NOFOLLOW-named property/export to a name that is not
      // one: the value continues under a name the checks do not recognise.
      const from = node.propertyName
      if (from && (ts.isIdentifier(from) || ts.isStringLiteral(from)) && (nameBits(from.text) & NF) &&
        ts.isIdentifier(node.name) && !(nameBits(node.name.text) & NF)) queue.push(node)
    }
    node.forEachChild(visitRefs)
  }
  visitRefs(sf)
  const refs = queue.length

  const taintedDecls = new Set()
  const isExported = (declNode) => {
    for (let cur = declNode; cur && !ts.isSourceFile(cur); cur = cur.parent) {
      if (ts.isVariableStatement(cur)) return (ts.getCombinedModifierFlags(cur) & ts.ModifierFlags.Export) !== 0
      if (isFunctionLike(cur)) return false
    }
    return false
  }
  const taintUses = (declNode, name, origin) => {
    if (taintedDecls.has(declNode)) return
    taintedDecls.add(declNode)
    // `export const F = … | O_NOFOLLOW` — the importer is another module this
    // file's analysis cannot see, so the export itself is the escape.
    if (isExported(declNode)) {
      escape(origin, `is exported as \`${name}\``)
      return
    }
    for (const id of identifiersByName.get(name) ?? []) {
      if (!isValueIdentifier(id)) continue
      const r = resolveId(id)
      if (r && r.node === declNode) queue.push(id)
    }
  }
  const escape = (node, where) => {
    findings.push({
      file: rel,
      line: lineOf(node, sf),
      text: `O_NOFOLLOW value \`${normText(node, sf).slice(0, 120)}\` ${where}, where this lint cannot follow it to the open() that consumes it — build it with O_NONBLOCK in the same expression, pass it straight to the open, or allowlist with a reason`,
    })
  }

  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]
    if (consumed.has(n) || markerAbove(n)) continue
    if (ts.isBindingElement(n) || ts.isImportSpecifier(n)) {
      // A rename: follow every use of the new local name instead.
      taintUses(n, n.name.text, n)
      continue
    }
    if (isDetectionContext(n)) continue
    const root = valueRoot(n)
    if (certified(evaluate(root))) continue
    const p = root.parent
    if (ts.isVariableDeclaration(p) && p.initializer === root) {
      if (!ts.isIdentifier(p.name)) { escape(n, 'is destructured'); continue }
      if (nameBits(p.name.text) & NF) continue // name-tracked: its uses are references too
      taintUses(p, p.name.text, n)
      continue
    }
    if (ts.isBinaryExpression(p) && p.right === root && isAssignmentKind(p.operatorToken.kind)) {
      const left = p.left
      if (ts.isIdentifier(left)) {
        if (nameBits(left.text) & NF) continue
        const r = resolveId(left)
        if (!r) { escape(n, `is assigned to an undeclared name \`${left.text}\``); continue }
        taintUses(r.node, left.text, n)
        continue
      }
      if (ts.isPropertyAccessExpression(left) && (nameBits(left.name.text) & NF)) continue
      escape(n, `is stored into \`${normText(left, sf).slice(0, 60)}\``)
      continue
    }
    if ((ts.isPropertyAssignment(p) && p.initializer === root) || ts.isShorthandPropertyAssignment(p)) {
      const keyText = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : ''
      if (nameBits(keyText) & NF) continue // name-tracked property
      escape(n, `is stored in object property \`${keyText || normText(p.name, sf)}\``)
      continue
    }
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === root)) { escape(n, 'is returned from a function'); continue }
    if (ts.isExportAssignment(p) || ts.isExportSpecifier(p)) { escape(n, 'is exported'); continue }
    escape(n, `flows into a \`${ts.SyntaxKind[p.kind]}\``)
  }

  return { findings, checked, refs }
}

// ─── Roster: nothing outside the scanned trees may use O_NOFOLLOW ────────────

function rosterOffenders(files, scannedFiles) {
  // A file's directory being one of the scanned trees does NOT mean the file
  // itself was scanned — SOURCE_EXT_RE only matches .js/.mjs/.cjs, so a .ts/
  // .tsx/.jsx file sitting inside packages/server/src or
  // packages/claude-hooks/src is invisible to the primary pass. Exempting it
  // here too (by directory prefix, as before) would make it invisible to the
  // roster as well — the one file type change the roster exists to catch.
  // Membership is therefore checked against the exact set of files the
  // primary pass actually opened, not the directory they live in.
  const inScanned = (f) => scannedFiles.has(f)
  const offenders = []
  for (const file of files) {
    if (file === SELF || inScanned(file)) continue
    const relPath = relative(REPO_ROOT, file).split(pathSep).join('/')
    if (TEST_PATH_RE.test(relPath)) continue
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    if (!/o_?nofollow/i.test(text)) continue
    const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
    let hit = null
    const visit = (n) => {
      if (hit) return
      if ((ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
        IDENTIFIER_LIKE_RE.test(n.text) && (rawBits(n.text) & NF)) hit = n
      n.forEachChild(visit)
    }
    visit(sf)
    if (hit) offenders.push(`${relPath}:${sf.getLineAndCharacterOfPosition(hit.getStart(sf)).line + 1}`)
  }
  return offenders
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2))
const usingDefaultSrcDirs = args.srcDirs.length === 0
const srcDirs = (usingDefaultSrcDirs ? DEFAULT_SRC_DIRS : args.srcDirs).map((d) => resolve(d))
for (const dir of srcDirs) {
  if (!existsSync(dir)) usageError(`--src-dir does not exist: ${dir}`)
}
const rosterDirs = args.rosterDirs.map((d) => resolve(d))
for (const dir of rosterDirs) {
  if (!existsSync(dir)) usageError(`--roster-dir does not exist: ${dir}`)
}

const keyRoot = usingDefaultSrcDirs ? REPO_ROOT : srcDirs[0]
const allFindings = []
const allChecked = []
const scannedFiles = new Set()
let scanned = 0
let totalRefs = 0

try {
  for (const srcDir of srcDirs) {
    const files = usingDefaultSrcDirs ? listSourceFilesByGit(srcDir) : walk(srcDir, SOURCE_EXT_RE)
    for (const file of files) {
      scanned++
      scannedFiles.add(file)
      const { findings, checked, refs } = analyzeFile(file, keyRoot)
      allFindings.push(...findings)
      allChecked.push(...checked)
      totalRefs += refs
    }
  }
} catch (err) {
  if (err instanceof LintAbort) usageError(err.message)
  throw err
}

// "Scanned zero files" and "scanned N clean files" must never be the same
// observable outcome (docs/false-safety-guards.md).
if (scanned === 0) {
  usageError(`scanned 0 files under ${srcDirs.join(', ')} — refusing to report a clean tree`)
}
if (args.minFiles !== null && scanned < args.minFiles) {
  usageError(`scanned only ${scanned} file(s), expected at least ${args.minFiles}. Either the walk broke or --min-files is stale.`)
}
// This repo has several O_NOFOLLOW opens (open-nofollow.js, trusted-file-read.js,
// claude-hooks/config.js, claude-tui-session.js). Zero found means the detector
// broke, not that the code got safer (#7503).
if (allChecked.length === 0) {
  usageError(`found 0 call arguments carrying O_NOFOLLOW across ${scanned} file(s) under ${srcDirs.join(', ')} — the detector is broken, not the code`)
}

// The roster runs in default mode over every tracked file under packages/ and
// scripts/, or over explicit --roster-dir trees.
let rosterFiles = []
if (rosterDirs.length) {
  for (const d of rosterDirs) rosterFiles.push(...walk(d, ROSTER_EXT_RE))
} else if (usingDefaultSrcDirs) {
  rosterFiles = gitLsFiles(['packages', 'scripts']).filter((l) => ROSTER_EXT_RE.test(l)).map((l) => join(REPO_ROOT, l))
  if (rosterFiles.length === 0) usageError('the roster enumerated 0 files under packages/ and scripts/ — refusing to report it clean')
}
const outside = rosterOffenders(rosterFiles, scannedFiles)
if (outside.length) {
  for (const o of outside) console.error(`${o}  references O_NOFOLLOW but is outside every scanned tree`)
  usageError(`${outside.length} file(s) outside the scanned trees reference O_NOFOLLOW — add their tree to DEFAULT_SRC_DIRS (or --src-dir) so the lint actually checks them`)
}

if (args.listChecked) {
  for (const c of allChecked) console.log(`checked ${c}`)
}

for (const f of allFindings) {
  console.error(`${f.file}:${f.line}  ${f.text}`)
}
if (allFindings.length) {
  console.error('')
  console.error(`${allFindings.length} O_NOFOLLOW flow(s) are not provably paired with O_NONBLOCK and are not allowlisted.`)
  console.error('Add O_NONBLOCK to the flags (and verify the post-open code rejects a non-regular file via fstat before reading), or add')
  console.error(`// ${IGNORE_MARKER}: <reason> immediately above, only where blocking is provably impossible (e.g. an O_DIRECTORY open).`)
}

const failed = allFindings.length > 0
if (!failed) {
  console.log(`OK: ${scanned} file(s) scanned, ${allChecked.length} call argument(s) carrying O_NOFOLLOW checked, ${totalRefs} O_NOFOLLOW reference(s) traced, ${rosterFiles.length} roster file(s) clear — every O_NOFOLLOW flow carries O_NONBLOCK or an allowlist reason.`)
}
process.exit(failed && !args.dryRun ? 1 : 0)
