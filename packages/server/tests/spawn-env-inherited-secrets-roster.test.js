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
 *      EXEMPT map are still checked, as before.
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
 * argument — `(\w+)` — which already rejects a literal `{}`/`{ }` argument
 * outright (curly braces are not word characters, so the capture group
 * simply fails to match at that call site).
 *
 * #8114: the REMAINING check — that same identifier reappearing in a later
 * `return` — was scoped to "later in the FILE", not "later in the enclosing
 * FUNCTION". Two decoys passed as a result, reproduced verbatim from the
 * issue:
 *   (a) `const env = { ...process.env }; stripInheritedChroxySecrets(env);
 *       return { ...process.env, ...env }` — re-merges the untouched
 *       original over the stripped copy. The identifier DOES reappear in a
 *       `return` in the same function, so scoping alone does not catch
 *       this one — it needs its own check (below).
 *   (b) strip one copy, `return` a DIFFERENT, unstripped variable — caught
 *       only because some unrelated LATER function in the file happened to
 *       `return` a same-named variable, which a file-wide match can't tell
 *       apart from the real one.
 *
 * Two independent tightenings fix these, both still heuristic rather than a
 * real parser (see `findBraceScopes` for what that heuristic does and does
 * not handle):
 *
 *   (b) SCOPE the "identifier reappears" search to the strip call's
 *       ENCLOSING FUNCTION, not the rest of the file. `findBraceScopes`
 *       walks the (comment-stripped) source once, skipping over
 *       single/double-quoted strings and backtick template literals
 *       (including nested `${ … }` interpolation) so braces inside them
 *       never perturb the brace count, and classifies every matched
 *       `{ … }` pair as a function body or not (arrow functions, function
 *       declarations/expressions, methods, getters/setters, constructors —
 *       as opposed to `if`/`for`/`while`/`switch`/`catch`/`do`/`else`
 *       blocks, a bare block, an object literal, or a class body).
 *       `enclosingFunctionEnd` then finds the nearest enclosing
 *       function-body scope for the strip call and bounds the search to
 *       its closing brace, so a same-named `return` in some OTHER function
 *       — however far below — can no longer be mistaken for this one's.
 *   (a) Within that bounded region, a candidate consuming statement is
 *       rejected if it ALSO contains a fresh, raw copy of `process.env`
 *       (any of the same `COPY_PATTERNS` discovery already recognizes) —
 *       `reintroducesRawEnvCopy` — regardless of where in the statement it
 *       sits: object spread only overwrites keys the LATER source actually
 *       has, so a stripped copy (missing the deleted keys entirely) spread
 *       either before OR after the raw original can never remove what the
 *       raw original still has. `{ ...process.env, ...env }` and
 *       `{ ...env, ...process.env }` are both rejected for this reason.
 *
 * "Consumed" is checked for three spellings, per #8114's own review
 * discussion — every real builder in this file uses only the first, the
 * other two are forward-looking for a builder shape that does not exist
 * here yet:
 *   - `return IDENT` / `return { ...IDENT, … }` (every current builder)
 *   - `SOMETHING.env = IDENT` / `SOMETHING.env = { ...IDENT, … }`
 *   - `env: IDENT` / `env: { ...IDENT, … }` as an object property (e.g. an
 *     inline `spawn(cmd, args, { env: IDENT })` options argument)
 * A bare shorthand `{ env }` (property name equal to the identifier, no
 * colon) is deliberately NOT recognized — that would require distinguishing
 * "an object literal that happens to mention the identifier" from "an
 * object literal that names it as a property" without a real parser, and
 * no builder here needs it. Under-recognizing a hypothetical safe shape is
 * the conservative failure mode; over-recognizing an unsafe one is not.
 */

// Keywords whose `KEYWORD (…) {` is a control-flow block, not a function
// body — the token immediately before the `(` that pairs with a `{`'s
// preceding `)` is checked against this set. `for await (…) {` is
// special-cased separately (the token right before its `(` is `await`, not
// `for`).
const CONTROL_FLOW_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch'])

/**
 * Advance past a single/double-quoted string literal starting at `code[i]`
 * (a quote character), honoring backslash escapes. A real JS string of
 * either kind can't contain a raw newline, so hitting one first means the
 * literal is malformed — bail out at the newline rather than scanning
 * unboundedly.
 */
function skipQuotedString(code, i) {
  const quote = code[i]
  let j = i + 1
  while (j < code.length) {
    const c = code[j]
    if (c === '\\') { j += 2; continue }
    if (c === quote) return j + 1
    if (c === '\n') return j + 1
    j += 1
  }
  return j
}

/**
 * Walk backward from `closeIdx` (the index of a `)`) to find its matching
 * `(`. A plain depth counter — it does NOT skip over quoted strings or
 * template literals encountered along the way, so a parameter default or
 * condition containing a literal unbalanced paren inside a string (e.g.
 * `foo(x = ')') {`) would defeat it. Not observed in this codebase's
 * builder signatures/conditions, and not worth a backward string-scanner
 * for a heuristic this scoped.
 */
function findMatchingOpenParen(code, closeIdx) {
  let depth = 0
  for (let idx = closeIdx; idx >= 0; idx -= 1) {
    const c = code[idx]
    if (c === ')') depth += 1
    else if (c === '(') {
      depth -= 1
      if (depth === 0) return idx
    }
  }
  return -1
}

/** The `[A-Za-z_$][\w$]*` token ending at (exclusive of) `end`, scanning backward. */
function wordEndingAt(code, end) {
  let start = end
  while (start > 0 && /[\w$]/.test(code[start - 1])) start -= 1
  return code.slice(start, end)
}

/**
 * Is the `{` at `code[i]` a function-body opener? See the big doc comment
 * above for the classification this implements.
 */
function isFunctionBodyOpener(code, i) {
  let j = i - 1
  while (j >= 0 && /\s/.test(code[j])) j -= 1
  if (j < 0) return false
  if (code[j] === '>' && code[j - 1] === '=') return true // arrow function: `=> {`
  if (code[j] !== ')') return false // bare block / class body / object literal / etc.
  const openParen = findMatchingOpenParen(code, j)
  if (openParen < 0) return false
  let k = openParen - 1
  while (k >= 0 && /\s/.test(code[k])) k -= 1
  if (k < 0) return false
  const token = wordEndingAt(code, k + 1)
  if (CONTROL_FLOW_KEYWORDS.has(token)) return false
  if (token === 'await') {
    // `for await (…) {` — the token right before '(' is 'await'; check one
    // token further back for the 'for' that actually makes it a loop.
    let k2 = k - token.length
    while (k2 >= 0 && /\s/.test(code[k2])) k2 -= 1
    if (k2 >= 0 && wordEndingAt(code, k2 + 1) === 'for') return false
  }
  return true
}

/**
 * Scan `code` (already comment-stripped by the caller) once, returning
 * every matched `{ … }` pair as `{ start, end, isFunctionBody }` (`start`/
 * `end` are the indices of the `{` and its matching `}`). Braces inside
 * single/double-quoted strings and backtick template literals — including
 * nested `${ … }` interpolation, to arbitrary depth — are skipped so they
 * never perturb the count.
 */
function findBraceScopes(code) {
  const scopes = []
  const stack = []
  let inTemplateText = false
  let i = 0
  while (i < code.length) {
    if (inTemplateText) {
      const c = code[i]
      if (c === '\\') { i += 2; continue }
      if (c === '`') { inTemplateText = false; i += 1; continue }
      if (c === '$' && code[i + 1] === '{') {
        stack.push({ kind: 'templateInterp' })
        inTemplateText = false
        i += 2
        continue
      }
      i += 1
      continue
    }
    const ch = code[i]
    if (ch === '\'' || ch === '"') { i = skipQuotedString(code, i); continue }
    if (ch === '`') { inTemplateText = true; i += 1; continue }
    if (ch === '{') {
      stack.push({ kind: 'brace', open: i, isFunctionBody: isFunctionBodyOpener(code, i) })
      i += 1
      continue
    }
    if (ch === '}') {
      const top = stack.pop()
      if (!top) { i += 1; continue } // unbalanced; defensive, keep scanning
      if (top.kind === 'templateInterp') {
        inTemplateText = true // interpolation closed — back to raw template text
      } else {
        scopes.push({ start: top.open, end: i, isFunctionBody: top.isFunctionBody })
      }
      i += 1
      continue
    }
    i += 1
  }
  return scopes
}

/**
 * The nearest enclosing function-body scope's end index for `pos`, or
 * `code.length` if `pos` is not inside any recognized function body (a
 * fallback that reproduces the pre-#8114 "search the rest of the file"
 * behavior rather than throwing, for a call site this heuristic can't
 * place — not expected for any real file in this roster).
 */
function enclosingFunctionEnd(scopes, pos, codeLength) {
  const containing = scopes
    .filter((s) => s.start < pos && pos < s.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))
  const fn = containing.find((s) => s.isFunctionBody)
  return fn ? fn.end : codeLength
}

/** Does `statementText` contain a fresh, raw copy of `process.env`? */
function reintroducesRawEnvCopy(statementText) {
  return COPY_PATTERNS.some(([, re]) => re.test(statementText))
}

/**
 * Is `ident` consumed — returned, assigned to a `.env` property, or handed
 * to an `env:` option — somewhere in `region` (the strip call's enclosing
 * function, from just after the call to the function's closing brace),
 * WITHOUT that same statement also re-copying the raw `process.env`?
 */
function identSafelyConsumed(ident, region) {
  const patterns = [
    new RegExp(`return\\b[^\\n;]*\\b${ident}\\b[^\\n;]*`, 'g'),
    new RegExp(`[^\\n;]*\\.env\\s*=[^\\n;]*\\b${ident}\\b[^\\n;]*`, 'g'),
    new RegExp(`[^\\n;]*\\benv\\s*:[^\\n;]*\\b${ident}\\b[^\\n;]*`, 'g'),
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(region))) {
      if (!reintroducesRawEnvCopy(m[0])) return true
    }
  }
  return false
}

function stripAppliedToItsOwnReturnValue(code) {
  const scopes = findBraceScopes(code)
  const callRe = /stripInheritedChroxySecrets\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g
  let m
  while ((m = callRe.exec(code))) {
    const ident = m[1]
    const fnEnd = enclosingFunctionEnd(scopes, m.index, code.length)
    const region = code.slice(callRe.lastIndex, fnEnd)
    if (identSafelyConsumed(ident, region)) return true
  }
  return false
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
// Fixture pins for the static check's OWN logic (#8114)
// ───────────────────────────────────────────────────────────────────────────
//
// `stripAppliedToItsOwnReturnValue` is a hand-rolled heuristic, not a real
// parser — the two decoys below are exactly what defeated its PREVIOUS
// (file-wide) version, reproduced as inline fixtures so the checker's own
// scoping/re-merge logic is pinned directly, without needing to mutate a
// real production file (which the RED-evidence steps below do separately,
// once, as a mutation-testing proof rather than a standing test). A checker
// this size is itself a plausible false-safety-guard candidate
// (docs/false-safety-guards.md) if its own behavior is never independently
// exercised.
describe('direction 1 static check — scoping + re-merge fixtures (#8114)', () => {
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
