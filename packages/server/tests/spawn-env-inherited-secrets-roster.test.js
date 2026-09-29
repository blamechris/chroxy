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
 *      that same identifier to reappear in a `return` statement later in
 *      the file (so stripping a THROWAWAY object that is never returned
 *      also fails). Both directions of the EXEMPT map are still checked, as
 *      before.
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
// 2. Static per-file check, strengthened against the #8113 decoy mutant
// ───────────────────────────────────────────────────────────────────────────

/**
 * A bare textual match of the helper's NAME (`/stripInheritedChroxySecrets\(/`)
 * is what the #8113 review defeated: `stripInheritedChroxySecrets({})` reads
 * as "the helper was called" while doing nothing to the real env object.
 * Two tightenings, both required:
 *
 *   (a) the call's argument must be a plain identifier — `(\w+)` — which
 *       already rejects a literal `{}`/`{ }` argument outright (curly braces
 *       are not word characters, so the capture group simply fails to match
 *       at that call site).
 *   (b) that SAME identifier must reappear inside a `return` statement
 *       somewhere later in the file — either bare (`return env`) or spread
 *       inside a returned object literal (`return { ...parentEnv, … }`).
 *       This is a heuristic, not a real parser: it scans for the identifier
 *       as a whole word within the nearest-following `return` statement's
 *       line, which is sufficient for every builder in this file (each has
 *       exactly one primary env-builder function, and every one of them
 *       returns on a single line/statement) without needing to track
 *       balanced braces to find the enclosing function's true end.
 */
function stripAppliedToItsOwnReturnValue(code) {
  const callRe = /stripInheritedChroxySecrets\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g
  let m
  while ((m = callRe.exec(code))) {
    const ident = m[1]
    const after = code.slice(callRe.lastIndex)
    const returnRe = new RegExp(`return\\b[^\\n;]*\\b${ident}\\b`)
    if (returnRe.test(after)) return true
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
