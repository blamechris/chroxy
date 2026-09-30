/**
 * Roster coverage for `stripInheritedChroxySecrets` (#7360, widened for #8113).
 *
 * The fix for #7360 is a shared helper (`utils/spawn-env.js`'s
 * `stripInheritedChroxySecrets`) rather than a per-builder copy — the same
 * "wired to only some of its callers" shape `docs/false-safety-guards.md`
 * catalogues. A helper that exists but that a NEW builder can silently
 * forget to call is no safer than no helper at all, so this file enumerates
 * every source file under `src/` that copies the FULL parent env — the
 * shape that would otherwise forward an ambiently-inherited
 * CHROXY_PORT/CHROXY_HOOK_SECRET (and, per #8113, the primary API_TOKEN)
 * straight through — and requires each one to either call the helper or
 * carry a documented exemption below.
 *
 * #8113 (found during #7360/#8111's own security review) is why this file
 * looks the way it does. The original discovery regexes only matched an
 * object-literal SPREAD (`{ ...process.env }`) or `Object.assign({}, …)`
 * with a literal empty-object target; `byok-tool-executor.js`'s
 * `buildSafeBashEnv()` copied via `Object.entries(process.env)` — a
 * DIFFERENT spelling — and escaped both this roster and the PR's original
 * `grep -rn '\.\.\.process\.env'` sweep, leaking the daemon's full-authority
 * primary bearer token into every BYOK-session Bash/Grep tool call. The same
 * review also demonstrated, with a real mutant, that even a file the roster
 * DOES flag can defeat "direction 1" by calling the helper on a decoy object
 * (`stripInheritedChroxySecrets({})`) instead of the one actually returned —
 * the roster stayed green while the dedicated behavioral test correctly went
 * red. Two independent hardenings follow from that, addressed separately
 * below (search for "#8113" for each).
 *
 * Three things are checked, deliberately kept separate because they close
 * different gaps:
 *   1. DISCOVERY is widened to every known copy-spelling (spread,
 *      Object.assign with any target, Object.entries, Object.keys,
 *      structuredClone, and a direct `env: process.env` reference with no
 *      copy at all) — proven against an inline fixture per spelling, not
 *      just against whatever real files happen to exist today.
 *   2. The STATIC per-file check ("direction 1") no longer accepts a bare
 *      textual match of the helper's name — it requires the strip call's
 *      argument to be a plain identifier (not an object literal, so
 *      `stripInheritedChroxySecrets({})` no longer counts), AND requires
 *      that same identifier to be CONSUMED (returned, assigned to a `.env`
 *      property, or handed to a `spawn`-style `env:` option) inside the
 *      SAME ENCLOSING FUNCTION as the strip call — not merely somewhere
 *      later in the file (#8114: a file-wide match let two decoys through —
 *      (a) re-merging the untouched `process.env` back over the stripped
 *      copy in the same return, and (b) stripping one variable but
 *      returning a different, unstripped one, "caught" only because an
 *      unrelated later function happened to `return` a same-named
 *      variable). A consuming statement that ALSO re-copies the raw,
 *      unstripped `process.env` (e.g. `return { ...process.env, ...env }`)
 *      is rejected regardless of spread order — object spread only
 *      overwrites keys the later source actually HAS, so a source missing
 *      a deleted key can never un-leak it back out. Both directions of the
 *      EXEMPT map are still checked, as before. The enclosing-function
 *      boundary is found with a real parse (`ts.createSourceFile`, the
 *      TypeScript compiler API already a `packages/server` devDependency —
 *      #8141), not a hand-rolled brace scanner: a regex literal containing
 *      `{` or an unterminated template literal used to desync a
 *      brace-nesting stack and fall back to "search the rest of the file",
 *      reproducing the exact pre-#8114 bug from the inside of its own fix.
 *      A real parser has no such desync class.
 *   3. A BEHAVIORAL check directly calls the three builders that are plain,
 *      side-effect-free functions (`buildSpawnEnv`, `defaultBuildEnv`,
 *      `buildSafeBashEnv`) with ambient secrets set, and asserts on their
 *      actual return value — proof that does not depend on reading the
 *      source text at all, for exactly the builders where doing so is cheap
 *      and safe. The other three builders are instance methods
 *      (`ClaudeTuiSession`/`UserShellSession`/`MCPClient`) whose constructors
 *      carry enough side-effecting setup (timers, hook managers, sink dirs)
 *      that duplicating safe construction+teardown here would itself become
 *      a second hand-rolled mirror of their own dedicated test files — the
 *      exact defect class §2's static check exists to catch. Static check 2
 *      covers those three; sections 2 and 3 together give every non-exempt
 *      builder at least one execution-independent AND one (where safe)
 *      execution-dependent proof.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { withEnv } from './test-helpers.js'
import { buildSpawnEnv } from '../src/utils/spawn-env.js'
import { defaultBuildEnv } from '../src/statusline.js'
import { buildSafeBashEnv } from '../src/byok-tool-executor.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(__dirname, '..', 'src')

// Files that copy the full parent env but are NOT required to route through
// stripInheritedChroxySecrets, with the reason each is safe as-is. Keyed by
// path relative to src/. A stale entry here (the file no longer matches the
// discovery pattern) fails test 2 below, so this list cannot silently rot.
const EXEMPT = {
  'supervisor.js':
    'the daemon forking ITSELF (server-cli-child.js) on auto-restart, not a ' +
    '"provider" spawn — the new process is a full chroxy daemon that ' +
    'generates its own per-session secrets independently, and the actual ' +
    'leak-prevention boundary is enforced at THAT daemon\'s own ' +
    '_buildChildEnv-style builders (this fix) when it goes on to spawn a ' +
    'provider, not at the self-fork step.',
  'ws-file-ops/git.js':
    'spawns the `git` binary only, for dashboard repo staging/diff ' +
    'operations — not an AI provider, an MCP server, or an arbitrary ' +
    'operator command, and not a permission-hook consumer.',
  'ws-file-ops/reader.js':
    'spawns `git rev-parse`/similar read-only repo-introspection calls only ' +
    '— same reasoning as ws-file-ops/git.js.',
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Discovery — every known copy-spelling, widened per #8113
// ───────────────────────────────────────────────────────────────────────────

// Matches an object literal that spreads the ENTIRE parent env — the shape
// that forwards whatever the daemon process itself inherited, ambient
// CHROXY_PORT/CHROXY_HOOK_SECRET included. Deliberately does NOT match a
// scoped read like `process.env.FOO` (extremely common and not this file's
// concern).
const FULL_ENV_COPY_RE = /\.\.\.\s*process\.env\b/

// `Object.assign(<target>, process.env, …)` for ANY target — not just a
// literal `{}` (the pre-#8113 regex required `{}` specifically and would
// have missed `Object.assign(out, process.env)`). The negative lookahead
// deliberately EXCLUDES `Object.assign(process.env, …)` — process.env as the
// FIRST (target) argument is a MUTATION of the daemon's own live env, the
// OPPOSITE direction from copying it for a spawned child, and a real,
// demonstrated case in this codebase: `server-cli.js` (~line 894) does
// exactly `Object.assign(process.env, getChroxyHostEnv())` to seed
// non-sensitive host-identity vars into its OWN env at startup. Without this
// exclusion that line would need a permanent EXEMPT entry despite never
// actually copying anything FOR a child; the negative-fixture test below
// pins that this exclusion is deliberate, not an oversight.
// `process.env` may be ANY source argument after the target — second, third or
// later (`Object.assign({}, base, process.env)`), and the call may span lines.
// A property read inside an argument (`{ cwd: process.env.HOME }`) is not a
// whole-env copy, hence the trailing `(?!\s*[.[])`.
// The scan stays inside this call's own argument list (one level of nested
// parens allowed): this codebase writes no semicolons, so an unbounded scan
// would run on into later statements.
const OBJECT_ASSIGN_COPY_RE = /Object\.assign\(\s*(?!process\.env\b)(?:[^()]|\([^()]*\))*?\bprocess\.env\b(?!\s*[.[])/

// `for (const [k, v] of Object.entries(process.env))` — the #8113 shape
// itself (`byok-tool-executor.js`'s pre-fix `buildSafeBashEnv`).
const OBJECT_ENTRIES_RE = /Object\.entries\(\s*process\.env\s*\)/

// `for (const k of Object.keys(process.env))` — enumeration-then-copy (or
// worse, enumeration-then-IN-PLACE-mutation of process.env itself, which
// would be a distinct and more severe bug this roster does not itself
// distinguish — either way it is not a scoped single-key read, so it is
// treated the same as the other full-copy shapes here).
const OBJECT_KEYS_RE = /Object\.keys\(\s*process\.env\s*\)/

// `structuredClone(process.env)` — a full deep copy in one call.
const STRUCTURED_CLONE_RE = /structuredClone\(\s*process\.env\s*\)/

// `env: process.env` as a spawn/exec option — NOT a copy at all, which is
// WORSE than every shape above: a builder that deletes a key from this
// object would be mutating the daemon's own live `process.env` in place.
// Not observed anywhere in src/ today (grepped as part of #8113's audit);
// kept so a future instance of the worst version of this bug is caught by
// the SAME discovery pass rather than needing a fresh grep to notice it.
const DIRECT_ENV_REF_RE = /\benv\s*:\s*process\.env\s*[,}]/

const COPY_PATTERNS = [
  ['spread ({ ...process.env })', FULL_ENV_COPY_RE],
  ['Object.assign(target, process.env)', OBJECT_ASSIGN_COPY_RE],
  ['Object.entries(process.env)', OBJECT_ENTRIES_RE],
  ['Object.keys(process.env)', OBJECT_KEYS_RE],
  ['structuredClone(process.env)', STRUCTURED_CLONE_RE],
  ['direct env: process.env reference (no copy)', DIRECT_ENV_REF_RE],
]

function stripComments(source) {
  // Block comments (incl. JSDoc) first, then line comments. Good enough for
  // this repo's own source (not a general-purpose parser) — the false
  // positive this exists to avoid is a JSDoc line that quotes a pattern in
  // prose (byok-mcp-trust.js references byok-mcp-client.js's shape in its
  // header comment without containing the code itself).
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Does this (comment-stripped) source text contain ANY known copy-spelling? */
function matchesFullEnvCopy(code) {
  return COPY_PATTERNS.some(([, re]) => re.test(code))
}

function matchingPatternNames(code) {
  return COPY_PATTERNS.filter(([, re]) => re.test(code)).map(([name]) => name)
}

function listJsFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

function discoverFullEnvCopiers() {
  const found = []
  for (const absPath of listJsFiles(SRC_DIR)) {
    const relPath = relative(SRC_DIR, absPath).split('\\').join('/') // POSIX-normalize for Windows
    const raw = readFileSync(absPath, 'utf8')
    const code = stripComments(raw)
    if (matchesFullEnvCopy(code)) {
      found.push({ relPath, code })
    }
  }
  return found
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Static per-file check, strengthened against #8113 AND #8114
// ───────────────────────────────────────────────────────────────────────────

/**
 * A bare textual match of the helper's NAME (`/stripInheritedChroxySecrets\(/`)
 * is what the #8113 review defeated: `stripInheritedChroxySecrets({})` reads
 * as "the helper was called" while doing nothing to the real env object.
 * #8113 tightened the call-site match to require a plain identifier
 * argument, and #8114 scoped the "identifier reappears" search to the strip
 * call's ENCLOSING FUNCTION (not the rest of the file) plus a re-merge check
 * — both against a hand-rolled brace scanner (`findBraceScopes`) that walked
 * the source char-by-char, skipping quoted strings and template literals by
 * its own ad hoc rules.
 *
 * #8141: that scanner has no concept of a regex literal, and no recovery
 * once an `inTemplateText` flag goes true with no closing backtick found —
 * either one desyncs its brace-nesting stack, so the REAL enclosing
 * function's closing brace is never recorded and the search silently falls
 * back to "search the rest of the file", reproducing the exact pre-#8114 bug
 * from inside the fix meant to close it. The fix is to stop hand-rolling a
 * tokenizer: `ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true,
 * ts.ScriptKind.JS)` (the TypeScript compiler API, already a
 * `packages/server` devDependency — no new dependency) parses plain JS into
 * a real AST with real node boundaries, so a regex literal or a malformed
 * template literal is either a single well-understood node or a parse error
 * — never a silent brace-count desync.
 *
 * The check itself is unchanged in what it decides, only in how it finds
 * the boundary to decide within:
 *
 *   1. Find every `CallExpression` whose callee is the identifier
 *      `stripInheritedChroxySecrets` with exactly one argument that is
 *      itself a plain `Identifier` (an object-literal argument, e.g.
 *      `stripInheritedChroxySecrets({})`, simply isn't a match — no regex
 *      capture-group trick needed). The helper's own DECLARATION
 *      (`function stripInheritedChroxySecrets(env) { … }`, or a method of
 *      that name) is a `FunctionDeclaration`/`MethodDeclaration` node, not a
 *      `CallExpression` — it is never a candidate at all, so nothing needs
 *      the old regex's separate "is this text preceded by `function`, or
 *      followed by `{`" exclusion.
 *   2. Walk `node.parent` up from the call to the nearest enclosing
 *      function-like node — `FunctionDeclaration`, `FunctionExpression`,
 *      `ArrowFunction`, `MethodDeclaration`, `GetAccessor`, `SetAccessor`,
 *      or `Constructor`. This bounds the "identifier reappears" search to
 *      that function's own body, exactly as #8114 intended, using the
 *      parser's real node boundaries instead of a counted brace.
 *   3. Within that function body, "consumed" is still the same three
 *      spellings from #8114 (every real builder in this file uses only the
 *      first; the other two are forward-looking for a builder shape that
 *      does not exist here yet):
 *        - `return IDENT` / `return { ...IDENT, … }`
 *        - `SOMETHING.env = IDENT` / `SOMETHING.env = { ...IDENT, … }`
 *        - `env: IDENT` / `env: { ...IDENT, … }` as an object property
 *      A bare shorthand `{ env }` (property name equal to the identifier, no
 *      colon) is still deliberately NOT recognized, for the same reason as
 *      before: under-recognizing a hypothetical safe shape is the
 *      conservative failure mode, over-recognizing an unsafe one is not.
 *   4. A candidate consuming node is rejected if its own source text (via
 *      `node.getText(sourceFile)`) contains a fresh, raw copy of
 *      `process.env` — `reintroducesRawEnvCopy`, reusing the same
 *      `COPY_PATTERNS` discovery already recognizes — regardless of spread
 *      order, for the same reason as #8114: object spread only overwrites
 *      keys the LATER source actually has, so a stripped copy (missing the
 *      deleted keys entirely) can never remove what a raw `process.env`
 *      spread elsewhere in the same statement still has.
 */

function isFunctionLikeNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  )
}

/** Walk `node.parent` up to the nearest enclosing function-like node, or `null` at the top of the file. */
function findEnclosingFunctionLike(node) {
  let cur = node.parent
  while (cur) {
    if (isFunctionLikeNode(cur)) return cur
    cur = cur.parent
  }
  return null
}

/**
 * Is `node` a `stripInheritedChroxySecrets(ident)` CALL site — as opposed to
 * the helper's own declaration, which is a different node kind entirely and
 * is never a `CallExpression`?
 */
function isStripCallSite(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'stripInheritedChroxySecrets' &&
    node.arguments.length === 1 &&
    ts.isIdentifier(node.arguments[0])
  )
}

function isIdentifierNamed(node, name) {
  return !!node && ts.isIdentifier(node) && node.text === name
}

/** Does `node` (an object literal) spread `ident` as one of its properties (`{ ...ident, … }`)? */
function objectLiteralSpreadsIdent(node, ident) {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.some((p) => ts.isSpreadAssignment(p) && isIdentifierNamed(p.expression, ident))
  )
}

/** Is `exprNode` the bare identifier `ident`, or an object literal spreading it? */
function consumesIdent(exprNode, ident) {
  if (!exprNode) return false
  if (isIdentifierNamed(exprNode, ident)) return true
  if (objectLiteralSpreadsIdent(exprNode, ident)) return true
  return false
}

/** Does `statementText` contain a fresh, raw copy of `process.env`? */
function reintroducesRawEnvCopy(statementText) {
  return COPY_PATTERNS.some(([, re]) => re.test(statementText))
}

/**
 * Every candidate "consuming" node for `ident` inside `root` (the strip
 * call's enclosing function body — a `Block`, or a bare expression for an
 * arrow function's implicit-return form): a `ReturnStatement` whose
 * expression consumes `ident`, an assignment to a `.env` property whose RHS
 * consumes `ident`, or an `env:` object-literal property whose initializer
 * consumes `ident`.
 */
function findConsumingSites(root, ident) {
  const sites = []

  function visit(node) {
    if (ts.isReturnStatement(node) && consumesIdent(node.expression, ident)) {
      sites.push(node)
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'env' &&
      consumesIdent(node.right, ident)
    ) {
      sites.push(node)
    } else if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'env' &&
      consumesIdent(node.initializer, ident)
    ) {
      sites.push(node)
    }
    ts.forEachChild(node, visit)
  }

  if (ts.isBlock(root)) {
    visit(root)
  } else {
    // Arrow function implicit-return expression body: the body IS the
    // returned value, so it is itself a candidate "return" site.
    if (consumesIdent(root, ident)) sites.push(root)
    visit(root)
  }
  return sites
}

function stripAppliedToItsOwnReturnValue(code) {
  const sourceFile = ts.createSourceFile('roster-check.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let found = false

  function visit(node) {
    if (found) return
    if (isStripCallSite(node)) {
      const ident = node.arguments[0].text
      const fn = findEnclosingFunctionLike(node)
      if (fn && fn.body) {
        for (const site of findConsumingSites(fn.body, ident)) {
          if (!reintroducesRawEnvCopy(site.getText(sourceFile))) {
            found = true
            break
          }
        }
      }
    }
    if (!found) ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

// ───────────────────────────────────────────────────────────────────────────
// Suites
// ───────────────────────────────────────────────────────────────────────────

describe('spawn-env inherited-secrets roster (#7360 / #8113)', () => {
  const copiers = discoverFullEnvCopiers()

  it('sanity: discovery actually finds the known copiers (the widened patterns still match real code)', () => {
    const relPaths = copiers.map((c) => c.relPath).sort()
    // A minimum known set — if this shrinks unexpectedly, the discovery
    // regex broke (or comment-stripping over-matched) rather than every
    // builder having genuinely stopped copying the full env.
    for (const expected of [
      'utils/spawn-env.js',
      'built-in-tools/bash-exec.js', // #8111 review — executeBash's fallback when a caller passes no env
      'claude-tui-session.js',
      'user-shell-session.js',
      'byok-mcp-client.js',
      'statusline.js',
      'byok-tool-executor.js', // #8113 — the Object.entries(process.env) miss
      'supervisor.js',
      'ws-file-ops/git.js',
      'ws-file-ops/reader.js',
    ]) {
      assert.ok(relPaths.includes(expected), `expected ${expected} to be discovered as a full-env copier; got: ${relPaths.join(', ')}`)
    }
    // byok-mcp-trust.js only MENTIONS the pattern inside a doc comment quoting
    // byok-mcp-client.js — proves comment-stripping actually works, not just
    // that the regex is loose enough to match anything.
    assert.ok(!relPaths.includes('byok-mcp-trust.js'),
      'byok-mcp-trust.js only references the pattern in a comment; comment-stripping should exclude it')
    // server-cli.js does `Object.assign(process.env, getChroxyHostEnv())`
    // (~line 894) — a MUTATION of the daemon's own live env, not a copy FOR a
    // spawned child. Proves the OBJECT_ASSIGN_COPY_RE lookahead's exclusion
    // holds against the REAL file, not just the isolated fixture above.
    assert.ok(!relPaths.includes('server-cli.js'),
      'server-cli.js only mutates its OWN process.env (Object.assign(process.env, …)); it must not be discovered as a copier needing EXEMPT')
  })

  it('sanity: the discovered set is EXACTLY the known roster — no unexpected extra file matched the widened patterns', () => {
    // Stronger than the subset check above: an exact match means a future
    // false positive from the widened patterns (a legitimate scoped use that
    // happens to match one of the six spellings) surfaces here immediately,
    // by name, rather than silently inflating direction 1's pass/fail set.
    const relPaths = copiers.map((c) => c.relPath).sort()
    const expectedExact = [
      'built-in-tools/bash-exec.js',
      'byok-mcp-client.js',
      'byok-tool-executor.js',
      'claude-tui-session.js',
      'statusline.js',
      'supervisor.js',
      'user-shell-session.js',
      'utils/spawn-env.js',
      'ws-file-ops/git.js',
      'ws-file-ops/reader.js',
    ].sort()
    assert.deepEqual(
      relPaths,
      expectedExact,
      'the set of files matching a full-env-copy pattern changed — if a NEW ' +
      'file was legitimately added, route it through stripInheritedChroxySecrets ' +
      'or add it to EXEMPT with a reason, then add it to this exact list too',
    )
  })

  it('byok-tool-executor.js is specifically discovered via the Object.entries(process.env) pattern (#8113 regression pin)', () => {
    const entry = copiers.find((c) => c.relPath === 'byok-tool-executor.js')
    assert.ok(entry, 'byok-tool-executor.js must be discovered at all')
    assert.ok(
      matchingPatternNames(entry.code).includes('Object.entries(process.env)'),
      'byok-tool-executor.js must specifically be caught by the Object.entries spelling — the one that escaped the original #7360 sweep',
    )
  })

  it('direction 1: every discovered full-env copier applies the strip to the value it actually returns, or is EXEMPT with a reason', () => {
    const uncovered = copiers.filter(({ relPath, code }) => {
      if (Object.prototype.hasOwnProperty.call(EXEMPT, relPath)) return false
      return !stripAppliedToItsOwnReturnValue(code)
    })
    assert.deepEqual(
      uncovered.map((c) => c.relPath),
      [],
      'every file that copies the full parent env into a child must call ' +
      'stripInheritedChroxySecrets() on an identifier that is later actually ' +
      'returned — a call on a throwaway object (e.g. a literal `{}`) does not ' +
      'count — or be added to EXEMPT in this test with a documented reason',
    )
  })

  it('direction 2: every EXEMPT entry still names a real discovered copier (no stale exemptions)', () => {
    const discoveredPaths = new Set(copiers.map((c) => c.relPath))
    const stale = Object.keys(EXEMPT).filter((p) => !discoveredPaths.has(p))
    assert.deepEqual(
      stale,
      [],
      'these EXEMPT entries no longer match any discovered full-env copier ' +
      '(the file was fixed, renamed, or no longer copies the full env) — ' +
      'remove the stale exemption instead of leaving it describing nothing',
    )
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Fixture pins for the static check's OWN logic (#8114 / #8141)
// ───────────────────────────────────────────────────────────────────────────
//
// `stripAppliedToItsOwnReturnValue` pins its own scoping/re-merge behavior
// directly, reproduced as inline fixtures rather than needing to mutate a
// real production file (which the RED-evidence steps below do separately,
// once, as a mutation-testing proof rather than a standing test) — a
// checker this size is itself a plausible false-safety-guard candidate
// (docs/false-safety-guards.md) if its own behavior is never independently
// exercised. The two decoys below the #8113/#8114 set are #8141's own
// adversarial repro: a regex literal or an unterminated template literal
// that desynced the PREVIOUS hand-rolled brace scanner into treating an
// unrelated function's `return` as the real call site's own consumption —
// the exact pre-#8114 bug, reproduced from inside the fix meant to close
// it. The `ts.createSourceFile` walk that replaced the scanner has no such
// desync class: a regex literal and a malformed template literal are each
// either a single well-formed node or a parse-error node, never a silent
// brace-count drift.
describe('direction 1 static check — scoping + re-merge fixtures (#8114 / #8141)', () => {
  it('accepts the shape every real builder in this file uses: strip then bare return', () => {
    const src = `
function buildEnv() {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  return env
}
`
    assert.ok(stripAppliedToItsOwnReturnValue(src), 'strip-then-bare-return must be accepted')
  })

  it('accepts a return that spreads the stripped identifier alongside unrelated (non-process.env) sources', () => {
    // The real shape in utils/spawn-env.js's buildSpawnEnv: the returned
    // object literal spreads the stripped copy plus other, unrelated
    // sources — never raw process.env itself.
    const src = `
function buildEnv() {
  const parentEnv = { ...process.env }
  stripInheritedChroxySecrets(parentEnv)
  return { ...parentEnv, ...getChroxyHostEnv(), ...extras }
}
`
    assert.ok(stripAppliedToItsOwnReturnValue(src), 'spreading the stripped identifier with unrelated sources must be accepted')
  })

  it('accepts assignment to a `.env` property and to an inline `env:` option, not just `return`', () => {
    const propertyAssignment = `
function buildEnv(opts) {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  opts.env = env
}
`
    const spawnOption = `
function run() {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  spawn(cmd, args, { env: env, cwd })
}
`
    assert.ok(stripAppliedToItsOwnReturnValue(propertyAssignment), '.env = ident must be accepted')
    assert.ok(stripAppliedToItsOwnReturnValue(spawnOption), 'env: ident must be accepted')
  })

  it('rejects decoy (a): re-merging raw process.env back over the stripped copy in the same return', () => {
    // Verbatim from #8114: `...process.env` reintroduces the very keys
    // `stripInheritedChroxySecrets` deleted, because spread only overwrites
    // keys the LATER source actually has.
    const src = `
function buildEnv() {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  return { ...process.env, ...env }
}
`
    assert.ok(!stripAppliedToItsOwnReturnValue(src), 'a return that re-merges raw process.env must be rejected')
  })

  it("rejects decoy (a) in the file that DEFINES the helper — the definition's own `return env` must not count", () => {
    // utils/spawn-env.js both defines stripInheritedChroxySecrets (whose body
    // returns its argument) and calls it. The definition's signature matched
    // the call regex first, and its `return env` satisfied the check before
    // the real, re-merging call site was reached.
    const src = `
export function stripInheritedChroxySecrets(env) {
  delete env.API_TOKEN
  return env
}

export function buildSpawnEnv() {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  return { ...process.env, ...env }
}
`
    assert.ok(!stripAppliedToItsOwnReturnValue(src), 'the helper definition must not satisfy the check for a re-merging call site')
  })

  it('rejects decoy (a) with the spread order flipped — the re-merge is not fixed by spreading the stripped copy last', () => {
    // `delete`d keys are simply ABSENT from the stripped copy, not set to
    // undefined — spreading it last can't remove a key that a raw
    // process.env spread earlier already added, and spreading raw
    // process.env last just re-adds whatever the stripped copy doesn't
    // have. Order is a red herring either way.
    const src = `
function buildEnv() {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  return { ...env, ...process.env }
}
`
    assert.ok(!stripAppliedToItsOwnReturnValue(src), 'a re-merge must be rejected regardless of spread order')
  })

  it('rejects decoy (a) via the `.env =` assignment spelling too, not just `return`', () => {
    const src = `
function buildEnv(opts) {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  opts.env = { ...process.env, ...env }
}
`
    assert.ok(!stripAppliedToItsOwnReturnValue(src), 'a re-merging .env assignment must be rejected')
  })

  it('rejects decoy (b): stripping one variable but returning a different, unstripped one', () => {
    // The `return raw` here never mentions `env` at all — #8114's point is
    // that the OLD checker still passed this because it searched the whole
    // FILE, not this function, for a later `return … env`, and coincidence
    // is enough to defeat a file-wide match. The adjacent unrelated
    // function below reproduces that trap in the most demanding place: an
    // off-by-one in the scoping (see M2 in the roster's own review notes)
    // would find its `return env` immediately, so this fixture is placed
    // to catch exactly that regression, not just the original bug.
    const src = `
function buildEnv() {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  const raw = { ...process.env }
  return raw
}

function unrelatedHelper() {
  const env = 'not-the-same-thing-at-all'
  return env
}
`
    assert.ok(!stripAppliedToItsOwnReturnValue(src), 'returning a different, unstripped variable must be rejected even when an unrelated later function returns a same-named one')
  })

  it('rejects decoy (b) even when the unrelated same-named return is many functions further below', () => {
    const filler = '// filler line so the unrelated return is genuinely far away, not adjacent\n'.repeat(40)
    const src = `
function buildEnv() {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  const raw = { ...process.env }
  return raw
}

${filler}
function unrelatedHelperFarBelow() {
  const env = 'not-the-same-thing-at-all'
  return env
}
`
    assert.ok(!stripAppliedToItsOwnReturnValue(src), 'distance does not matter to a scoped check — only the enclosing braces do')
  })

  // #8141: the hand-rolled brace scanner this check used to run on has no
  // concept of a regex literal and no recovery from an unterminated template
  // literal. Either one desyncs its brace-nesting stack, so the REAL
  // enclosing function's closing brace is never recorded and the search
  // falls back to end-of-file — reproducing decoy (b) (strip one variable,
  // return a different unstripped one) "caught" only by an unrelated later
  // function's coincidental same-named `return`, exactly like the pre-#8114
  // bug. These two are the adversarial repro from #8141 itself.
  it('rejects decoy (b) hidden behind a regex literal containing a stray `{` (#8141)', () => {
    const src = `
function buildEnv() {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  const re = /{not a real brace/
  const raw = { ...process.env }
  return raw
}

function unrelatedHelper() {
  const env = 'not-the-same-thing-at-all'
  return env
}
`
    assert.ok(!stripAppliedToItsOwnReturnValue(src), 'a regex literal containing a stray { must not desync scoping into treating an unrelated function\'s return as this call\'s own')
  })

  it('rejects decoy (b) hidden behind an unterminated template literal (#8141)', () => {
    const src = `
function buildEnv() {
  const env = { ...process.env }
  stripInheritedChroxySecrets(env)
  const s = \`unterminated template literal starts here and never closes
  const raw = { ...process.env }
  return raw
}

function unrelatedHelper() {
  const env = 'not-the-same-thing-at-all'
  return env
}
`
    assert.ok(!stripAppliedToItsOwnReturnValue(src), 'an unterminated template literal must not desync scoping into treating an unrelated function\'s return as this call\'s own')
  })
})

describe('discovery pattern coverage — one fixture per known copy-spelling (#8113)', () => {
  const POSITIVE_FIXTURES = {
    'spread ({ ...process.env })': 'const env = { ...process.env }',
    'Object.assign with a literal {} target': 'const env = Object.assign({}, process.env)',
    'Object.assign with an identifier target (the pre-#8113 blind spot)': 'Object.assign(out, process.env)',
    'Object.assign with process.env as a LATER source (3-arg form)': 'const env = Object.assign({}, base, process.env)',
    'Object.assign with process.env second and extras third': 'const env = Object.assign({}, process.env, extras)',
    'Object.assign spanning lines': 'const env = Object.assign(\n  {},\n  defaults,\n  process.env,\n)',
    'Object.assign with a nested call before process.env': 'const env = Object.assign({}, getChroxyHostEnv(), process.env)',
    'Object.entries(process.env) (the #8113 shape itself)':
      'for (const [k, v] of Object.entries(process.env)) { out[k] = v }',
    'Object.keys(process.env)': 'for (const k of Object.keys(process.env)) { out[k] = process.env[k] }',
    'structuredClone(process.env)': 'const env = structuredClone(process.env)',
    'a direct env: process.env reference (no copy at all — worse)':
      "spawn(cmd, args, { env: process.env, stdio: 'pipe' })",
  }

  for (const [label, snippet] of Object.entries(POSITIVE_FIXTURES)) {
    it(`flags the "${label}" spelling`, () => {
      assert.ok(matchesFullEnvCopy(snippet), `expected the discovery patterns to flag: ${snippet}`)
    })
  }

  it('does NOT flag a scoped single-key read (process.env.FOO) — not the leak shape this file guards', () => {
    assert.ok(!matchesFullEnvCopy('const x = process.env.FOO'))
  })

  it('does NOT flag Object.assign reading a single key inside an argument ({ cwd: process.env.HOME })', () => {
    assert.ok(!matchesFullEnvCopy('Object.assign(opts, { cwd: process.env.HOME, x: process.env["Y"] })'))
  })

  it('does NOT run past the call: an unrelated Object.assign followed later by process.env (no semicolons)', () => {
    assert.ok(!matchesFullEnvCopy('Object.assign(opts, defaults)\nlog(process.env === undefined)'))
    assert.ok(!matchesFullEnvCopy('Object.assign(opts, defaults)\nconst home = process.env.HOME'))
  })

  it("does NOT flag Object.assign(process.env, computedVars) — mutating the daemon's OWN env is the opposite direction from copying it FOR a spawned child (the real server-cli.js:894 shape)", () => {
    assert.ok(!matchesFullEnvCopy('Object.assign(process.env, getChroxyHostEnv())'))
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. Behavioral proof for the builders that are safe to call directly
// ───────────────────────────────────────────────────────────────────────────
//
// These three calls do not depend on the source-text checks above at all —
// they exercise the REAL exported function with a REAL ambient value and
// assert on what actually comes back. Applying the #8113 decoy mutant
// (`stripInheritedChroxySecrets({})`) to any of these three sources fails
// ITS OWN test here directly, independent of section 2's static check.

describe('behavioral proof: directly-callable builders actually strip ambient secrets (#8113)', () => {
  it('buildSpawnEnv("claude") strips an ambient CHROXY_PORT/CHROXY_HOOK_SECRET when called with no extras', () => {
    withEnv({ CHROXY_PORT: '19999', CHROXY_HOOK_SECRET: 'ambient-foreign-session-secret' }, () => {
      const env = buildSpawnEnv('claude')
      assert.equal(env.CHROXY_PORT, undefined)
      assert.equal(env.CHROXY_HOOK_SECRET, undefined)
    })
  })

  it('statusline.js defaultBuildEnv() strips an ambient CHROXY_PORT/CHROXY_HOOK_SECRET', () => {
    withEnv({ CHROXY_PORT: '19999', CHROXY_HOOK_SECRET: 'ambient-foreign-session-secret' }, () => {
      const env = defaultBuildEnv()
      assert.equal(env.CHROXY_PORT, undefined)
      assert.equal(env.CHROXY_HOOK_SECRET, undefined)
    })
  })

  it('byok-tool-executor.js buildSafeBashEnv() strips an ambient API_TOKEN/CHROXY_PORT/CHROXY_HOOK_SECRET (#8113)', () => {
    withEnv({
      API_TOKEN: 'primary-bearer-token',
      CHROXY_PORT: '19999',
      CHROXY_HOOK_SECRET: 'ambient-foreign-session-secret',
    }, () => {
      const env = buildSafeBashEnv()
      assert.equal(env.API_TOKEN, undefined)
      assert.equal(env.CHROXY_PORT, undefined)
      assert.equal(env.CHROXY_HOOK_SECRET, undefined)
    })
  })
})
