/**
 * FS-agnostic / shell-agnostic PURE transforms for the built-in tools, shared
 * by the host implementations (file-ops.js, byok-tool-executor.js) and the
 * container re-encodings (docker-byok-session.js) so the tool SEMANTICS have a
 * single source of truth and can't drift (audit P2-9 / #5882).
 *
 * Byte I/O stays provider-specific: the host reads/writes via node:fs; the
 * container shells out via `docker exec`. Only the pure string/command shaping
 * lives here.
 */

/**
 * Quote a string for inclusion in a `bash -c` command via single-quote shell
 * escaping (no expansion at all inside); embedded single quotes become `'\''`.
 * Identical output to the per-file copies for string inputs.
 */
function shellQuote(s) {
  if (typeof s !== 'string') return "''"
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ---------------------------------------------------------------------------
// Edit — strict-unique-match string replacement
// ---------------------------------------------------------------------------

/**
 * Apply Claude Code's Edit semantics to an in-memory string. PURE — the caller
 * does the byte I/O (host fs read/write, or `cat`/`tee` via docker exec).
 *
 * Contract:
 *   - non-string / empty oldString            → { ok:false, code:'EINVAL' }
 *   - non-string newString                     → { ok:false, code:'EINVAL' }
 *   - oldString === newString                  → { ok:false, code:'NO_CHANGE' }
 *   - oldString not present                    → { ok:false, code:'NOT_FOUND' }
 *   - >1 match without replaceAll              → { ok:false, code:'NOT_UNIQUE', matchCount }
 *   - otherwise                                → { ok:true, next, replacements }
 *
 * Replacement is LITERAL in both the single and replaceAll paths (split/join
 * and slice), so a newString containing `$&`/`$1`/`$\`` is inserted verbatim —
 * unlike `String.prototype.replace`, whose `$`-pattern interpretation was a
 * latent footgun in the old host single-edit path. Each `code` carries a default
 * `message`, but callers may map the code to their own (path-ful) wording.
 *
 * @param {string} content
 * @param {{ oldString?: string, newString?: string, replaceAll?: boolean }} opts
 */
export function applyEdit(content, { oldString, newString, replaceAll = false } = {}) {
  if (typeof oldString !== 'string' || oldString.length === 0) {
    return { ok: false, code: 'EINVAL', message: 'oldString is required and must be non-empty' }
  }
  if (typeof newString !== 'string') {
    return { ok: false, code: 'EINVAL', message: 'newString must be a string' }
  }
  if (oldString === newString) {
    return { ok: false, code: 'NO_CHANGE', message: 'oldString and newString are identical' }
  }

  // Count occurrences without allocating a full split for huge files — an
  // indexOf walk is O(n) and predictable. Advance by oldString.length so the
  // count is NON-overlapping, matching what `split(oldString).join(...)`
  // actually replaces (so `replacements` and the NOT_UNIQUE guard agree with
  // the replaceAll path — e.g. 'aa' in 'aaaa' is 2, not the overlapping 3).
  let matchCount = 0
  let from = 0
  let at
  while ((at = content.indexOf(oldString, from)) !== -1) {
    matchCount++
    from = at + oldString.length
  }

  if (matchCount === 0) {
    return { ok: false, code: 'NOT_FOUND', message: 'oldString not found' }
  }
  if (matchCount > 1 && !replaceAll) {
    return {
      ok: false,
      code: 'NOT_UNIQUE',
      matchCount,
      message: `oldString matched ${matchCount} sites; pass replaceAll=true or add surrounding context to make it unique`,
    }
  }

  let next
  if (replaceAll) {
    next = content.split(oldString).join(newString)
  } else {
    const at = content.indexOf(oldString)
    next = content.slice(0, at) + newString + content.slice(at + oldString.length)
  }
  return { ok: true, next, replacements: matchCount }
}

// ---------------------------------------------------------------------------
// Read — line-numbered output shape
// ---------------------------------------------------------------------------

/** Width the 1-indexed line number is right-padded to (then `→` then the line). */
export const READ_LINE_NUMBER_PAD = 5

/** Default line cap applied when no positive `limit` is given. */
export const DEFAULT_READ_LINE_LIMIT = 2_000

/**
 * Slice `text` by a 1-indexed line range and render Claude Code's line-numbered
 * Read shape (`<pad>→<line>`). PURE. (The container produces the same shape via
 * an in-container `awk 'printf "%5d→%s"'` after a `sed | head` slice, mirroring
 * READ_LINE_NUMBER_PAD — it can't reuse this JS because the slice happens
 * in-container to avoid transferring the whole file.)
 *
 * @param {string} text
 * @param {{ offset?: number, limit?: number, maxLines?: number }} opts
 * @returns {{ content: string, totalLines: number, linesReturned: number, truncatedByLimit: boolean }}
 */
export function formatNumberedLines(text, { offset, limit, maxLines = DEFAULT_READ_LINE_LIMIT } = {}) {
  const allLines = text.split('\n')
  const totalLines = allLines.length
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) - 1 : 0
  const requestedCount = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), maxLines)
    : maxLines
  const slice = allLines.slice(start, start + requestedCount)
  const content = slice
    .map((line, i) => `${String(start + i + 1).padStart(READ_LINE_NUMBER_PAD)}→${line}`)
    .join('\n')
  return {
    content,
    totalLines,
    linesReturned: slice.length,
    truncatedByLimit: slice.length < totalLines - start,
  }
}

// ---------------------------------------------------------------------------
// Glob / Grep — shell command builders
// ---------------------------------------------------------------------------

/**
 * Shell metacharacters a Glob pattern must never contain — the `for f in
 * <pattern>` expansion would otherwise run an attacker payload (#4070). Glob
 * patterns legitimately need only `* ? [] {} / .` alnum `_ -`.
 */
export const GLOB_PATTERN_SHELL_METACHARS = /[$`;|&><()\\\n\r]/

/**
 * SECURITY (#7341) — reject a Glob `pattern` that OBVIOUSLY escapes the
 * workspace, so the model gets a clear `EINVAL` instead of a puzzling
 * "No matches".
 *
 * THIS IS NOT THE SECURITY BOUNDARY, and the history of the file is the reason
 * it says so this loudly. It began as one — a check that tried to predict what
 * bash would do with the pattern — and three review rounds walked past it six
 * times (whitespace word-splitting, brace expansion, a glob matching the `..`
 * entry, quote removal, a brace body with no top-level comma, POSIX bracket
 * sub-expressions). The replacement modelled bash properly: a real brace
 * expander and a glob-to-regex segment matcher. That was worse. It was
 * measurably wrong (46 of 515 enumerated bracket segments answered "cannot
 * reach `..`" for segments bash expands straight to `..`) and it was a denial
 * of service (a 4 KB pattern of `{a,b}` groups and stars backtracked for 12.9
 * SECONDS of blocked event loop, on a tool auto-approved in `acceptEdits`).
 *
 * Both problems came from the same source: modelling a shell. So the model is
 * gone. Containment is enforced entirely on the OUTPUT — `confineGlobMatches`
 * realpaths every match on the host, `globMatchEscapesRoot` filters every match
 * on the container — and all six historical bypasses were re-confirmed closed
 * at that layer, by fuzzing real bash. What remains here is a linear scan whose
 * only job is a good error message, and which cannot be wrong in a way that
 * matters: a false negative just yields "No matches" from the layer below.
 *
 * @param {string} pattern
 * @returns {string|null} A reason string when the pattern obviously escapes.
 */
export function globPatternEscapeReason(pattern) {
  if (typeof pattern !== 'string') return 'not a string'
  // Whitespace: the CONTAINER interpolates the pattern unquoted into
  // `for f in <pattern>`, so a space there is several patterns. Rejected on
  // both paths so one input cannot mean two things depending on the backend.
  if (/\s/.test(pattern)) {
    return 'whitespace — use ** or a wildcard instead of a literal space'
  }
  // Word starts: the beginning, or after a `{` or `,` — brace expansion makes
  // each alternative its own word. No expansion is performed; these anchors are
  // a cheap approximation, which is all a message needs to be.
  if (/(^|[{,])~/.test(pattern)) return 'home-directory (~) expansion'
  if (/(^|[{,])[/\\]/.test(pattern)) return 'absolute path'
  // Windows: `C:\x`, `C:/x` and the drive-relative `C:x` are all absolute
  // enough to leave the workspace, and none of them starts with a separator.
  // #6928 is the same lesson one layer down — a `/`-shaped path evading a
  // guard that only knew about `\`, or the reverse.
  if (/(^|[{,])[A-Za-z]:/.test(pattern)) return 'absolute path'
  // A literal `..` path segment. Segments are delimited by either separator
  // and by brace punctuation. This deliberately does NOT try to work out
  // whether a glob such as `.*` could EXPAND to `..` — that computation is
  // what produced both the false accepts and the DoS, and the output layer
  // catches the real thing regardless.
  for (const segment of pattern.split(/[/\\{},]/)) {
    if (segment === '..') return 'parent-directory (..) traversal'
  }
  return null
}

/**
 * SECURITY (#7341) — does a glob MATCH, as produced, point outside the root it
 * was expanded in? Purely lexical, and deliberately so: it inspects what the
 * expansion ACTUALLY produced instead of predicting what it will produce.
 *
 * That distinction is the whole lesson of this fix. Two review rounds found
 * six ways past a guard that tried to model bash's expansion — quote removal,
 * whitespace word-splitting, a brace body with no top-level comma, a glob that
 * matches the `..` entry, POSIX bracket sub-expressions, and nested braces.
 * Every one of them is invisible in the source text and every one of them is
 * plainly visible in the OUTPUT, as a leading `/` or a `..` segment. Checking
 * the output needs no model of the shell and therefore has no round seven.
 *
 * The host does strictly better than this (`confineGlobMatches` realpaths each
 * match). What this cannot see is a symlinked directory inside `/workspace` —
 * lexically clean, resolves out. That is no longer a residual: since #7354 the
 * container resolves every match physically in-container
 * ({@link buildConfinedGlobBody}), and this stays in FRONT of it as the layer
 * that needs nothing from the guest's userland.
 */
export function globMatchEscapesRoot(match) {
  if (typeof match !== 'string') return true
  // Both separators and the Windows drive/UNC forms. Splitting on `/` alone is
  // #6928 exactly — a guard that knew one separator and let the other through.
  // The container is Linux today, so the Windows arms are contract rather than
  // live defence; a validator whose JSDoc claims "absolute" must mean it.
  if (/^[/\\]/.test(match)) return true
  if (/^[A-Za-z]:/.test(match)) return true
  return match.split(/[/\\]/).includes('..')
}

/** The tool_result message for a pattern rejected by {@link globPatternEscapeReason}. */
export function globPatternEscapeMessage(reason) {
  return `EINVAL: glob pattern escapes the workspace root (${reason}). Patterns are relative to the workspace; use the "path" argument to search a subdirectory.`
}

/**
 * SECURITY (#7898 round 4) — hard ceilings on `pattern` BEFORE it reaches
 * either backend's matcher: the host's hand-written case-check parser
 * (`compileCaseCheck`/`parseSegmentTokens`/`advanceToken` in
 * byok-tool-executor.js) and the container's bash brace expansion
 * (`buildConfinedGlobBody`). Nothing upstream of this point bounds `pattern`
 * at all — not the tool's JSON-schema `input_schema` (a bare `{ type:
 * 'string' }`, no `maxLength`), not {@link GLOB_PATTERN_SHELL_METACHARS}, not
 * {@link globPatternEscapeReason} (both are fixed-cost linear scans that
 * don't look at length or nesting). This is the first and only place either
 * is checked, which is why both backends call it.
 *
 * Two independent, cheap (each a single linear scan, no recursion) checks:
 *
 * - **Length.** Every cost this file's review history has found in the host
 *   matcher is polynomial in `pattern.length` (P) for a BOUNDED P — see the
 *   worst-case bound written above {@link compileCaseCheck} — so bounding P
 *   bounds all of them at once, including constructs no round has found yet.
 *   2,000 characters is generous: the longest pattern in this file's own test
 *   suite, deliberately adversarial (`'{*a,*b}'.repeat(30)`), is 210; a real
 *   pattern is rarely more than a few dozen.
 *
 * - **Brace nesting depth.** #7898 round 4 — chain-nested braces
 *   (`{a,{b,{c,d}}}`, extended: `{x1,{x2,{x3,...}}}`) are the one construct
 *   round 3's "self-limiting" dismissal ("depth d needs ~2^d characters",
 *   true only for a BALANCED binary tree of alternatives) got wrong: a
 *   right-leaning CHAIN needs only ~4 characters per extra level, so nesting
 *   depth is near-linear in pattern length, not exponential. Two independent
 *   defects follow, both measured directly against `compileCaseCheck`/
 *   `caseCheckPasses` on this machine:
 *     1. `parseSegmentTokens` re-scans the shrinking remainder at every
 *        nesting level (`findMatchingBrace` + `splitTopLevelCommas`, each
 *        O(remaining length)), so PARSE time alone is O(depth²): 0.16ms at
 *        depth 10 (48 chars), 18.72ms at depth 1000 (6,890 chars), 301.88ms
 *        at depth 4000 (30,890 chars) — quadratic scaling confirmed (~4x
 *        time per ~2x length). This runs UNCONDITIONALLY per Glob call, in
 *        `confineGlobMatches`, before a single match is even checked.
 *     2. Both `parseSegmentTokens` (parse) and `advanceToken`/`advanceTokens`
 *        (match, the `alt` branch recursing into nested options) are
 *        RECURSIVE with one JS call frame per nesting level, and neither has
 *        a depth check — a pattern nested deep enough throws an uncaught
 *        `RangeError: Maximum call stack size exceeded`. Measured on Node
 *        22.23.2: parsing survives to ~depth 5,505 (~38,000 chars) before
 *        overflowing; MATCHING overflows far sooner, at ~depth 2,000 (~14,500
 *        chars), because `advanceToken`/`advanceTokens` mutually recurse with
 *        a shallower frame budget than `parseSegmentTokens`'s single
 *        self-recursion. `executeBuiltinTool`'s outer try/catch turns this
 *        into a caught `Tool Glob failed: Maximum call stack size exceeded`
 *        rather than crashing the daemon — but the exact depth that overflows
 *        depends on how much OTHER stack is already in use by the async call
 *        chain when a real Glob call runs, which is neither deterministic nor
 *        portable, so it cannot be treated as an implicit safety bound.
 *   32 levels is far above anything a legitimate pattern needs (the task's
 *   own `{a,{b,{c,d}}}` example is depth 3) and leaves a >60x margin below
 *   the measured match-time overflow point, so the ceiling is reached and
 *   refused long before either the quadratic parse cost or the recursion
 *   depth becomes a problem — regardless of how much stack the caller has
 *   already used.
 *
 * FAIL CLOSED: this runs BEFORE `fs.glob`'s own walk starts (host) and before
 * the container `docker exec` is issued, so an over-budget pattern costs
 * nothing beyond this scan — no walk, no case-check compile, no container
 * round-trip.
 *
 * @param {string} pattern
 * @returns {string|null} A reason string when the pattern is too complex.
 */
export const GLOB_PATTERN_MAX_LENGTH = 2_000
export const GLOB_PATTERN_MAX_BRACE_DEPTH = 32

export function globPatternComplexityReason(pattern) {
  if (typeof pattern !== 'string') return 'not a string'
  if (pattern.length > GLOB_PATTERN_MAX_LENGTH) {
    return `longer than ${GLOB_PATTERN_MAX_LENGTH} characters (${pattern.length})`
  }
  // A plain linear scan, no recursion — and a SAFE upper bound on the real
  // parser's recursion depth even though it does not distinguish a bracket
  // expression's literal '{'/'}' members from real brace syntax: every
  // recursion `parseSegmentTokens` actually performs happens on a MATCHED
  // '{'...'}' pair, which this counter always sees too (an unmatched '{' —
  // what `findMatchingBrace` treats as a literal and never recurses into —
  // can only make this counter's depth reading HIGHER than the true parse
  // depth, never lower). Over-rejecting a pattern that merely contains many
  // literal, unmatched '{' characters is an acceptable false positive for a
  // guard whose only job is to never under-count real recursion.
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '{') {
      depth++
      if (depth > GLOB_PATTERN_MAX_BRACE_DEPTH) {
        return `"{" nesting deeper than ${GLOB_PATTERN_MAX_BRACE_DEPTH} levels`
      }
    } else if (c === '}' && depth > 0) {
      depth--
    }
  }
  return null
}

/** The tool_result message for a pattern rejected by {@link globPatternComplexityReason}. */
export function globPatternComplexityMessage(reason) {
  return `EINVAL: glob pattern is too complex (${reason}). Narrow the search with "path", or split it into more than one simpler Glob call.`
}

// ---------------------------------------------------------------------------
// Container path confinement (#7354) — resolve INSIDE the container
// ---------------------------------------------------------------------------

/**
 * SECURITY (#7354) — the sentinel the container-side confinement preamble
 * prints as the FIRST line of stdout when the target resolved inside the
 * workspace and the body is about to run.
 *
 * It exists so the host can tell "the guard ran and passed" apart from "the
 * guard did not run at all". Without it, a command that lost the preamble
 * would be indistinguishable from one that passed it — success and
 * not-checking would be the same observable, which is the defect class
 * `docs/false-safety-guards.md` is a catalogue of.
 */
export const CONTAINER_CONFINE_OK = '__chroxy_confine_ok__'

/** Printed when the target resolved OUTSIDE the workspace. */
export const CONTAINER_CONFINE_ESCAPE = '__chroxy_confine_escape__'

/** Printed when the target could not be resolved at all (fail closed). */
export const CONTAINER_CONFINE_ERROR = '__chroxy_confine_error__'

/**
 * SECURITY (#7354) — the trailer the Glob body prints as its LAST line,
 * carrying the number of matches the in-container resolution WITHHELD.
 *
 * Withheld matches stay invisible to the MODEL (see {@link buildConfinedGlobBody}
 * — distinguishing "matched, but outside" from "matched nothing" is an existence
 * oracle on a tool `acceptEdits` auto-approves). They must not be invisible to
 * the OPERATOR. A containment that fires silently and reports success is the
 * exact shape `docs/false-safety-guards.md` catalogues: the daemon log line the
 * host writes from this count is the difference between "the guard held" and
 * "nothing was there", which is otherwise unobservable from outside the
 * container.
 *
 * The count is a count, never a path: the names and link targets of what was
 * withheld would put the very thing containment refused into the daemon log.
 *
 * #7357 — this line is STILL `\n`-terminated (unlike the matches above it,
 * which are NUL-delimited): it is host-authored fixed text, never a filename,
 * so it cannot itself contain a stray delimiter, and keeping it human-legible
 * on its own line is what let {@link splitWithheldTrailer} stay a boundary
 * split rather than a scan.
 */
export const CONTAINER_CONFINE_WITHHELD = '__chroxy_confine_withheld__'

/** Matches the trailer line emitted by {@link buildConfinedGlobBody}. */
const WITHHELD_TRAILER_RE = new RegExp(`^${CONTAINER_CONFINE_WITHHELD} (\\d+)$`)

/**
 * Max symlink hops `__cx_resolve` follows before giving up (ELOOP guard).
 * Linux's own limit is 40; matching it means we refuse exactly what the
 * kernel refuses rather than inventing a stricter one.
 */
const CONTAINER_RESOLVE_MAX_HOPS = 40

/**
 * SECURITY (#7354) — the bash source of `__cx_resolve`, which resolves a path
 * to its PHYSICAL location inside the container: every symlinked directory
 * component via `cd -P`, and a symlinked leaf via a bounded `readlink` loop.
 *
 * Why this has to run in the container at all: `globMatchEscapesRoot` and
 * `remapToContainerPath` are both LEXICAL. `esc/passwd`, where `/workspace/esc`
 * is a symlink to `/etc` in the CONTAINER's filesystem, has no leading `/` and
 * no `..` segment — it is lexically spotless and resolves out. The host cannot
 * see that link (it is not on the host's filesystem), so the only place the
 * question can be answered is inside the container. That is the whole of #7354.
 *
 * UTILITIES: `cd -P`, `pwd -P`, `case`, `${x%/*}` and `local` are bash
 * builtins/syntax, and `execInEnvironment` already invokes `bash -c` (the
 * existing Glob command uses `shopt`, so bash is a standing requirement, not a
 * new one). The ONLY external program is `readlink`, and it is reached only
 * when a component is actually a symlink — it ships in GNU coreutils (the
 * default `node:22-slim` image) and in busybox (alpine). If it is missing the
 * `$(readlink ...)` fails, the function returns non-zero, and the caller emits
 * CONTAINER_CONFINE_ERROR: unresolvable is refused, never waved through.
 *
 * `unset CDPATH` before every `cd`: with CDPATH set, bash's `cd` ECHOES the
 * directory it landed in on stdout, which would corrupt the `$( ... )` capture
 * (project memory: cdpath_corrupts_cd_pwd_capture).
 *
 * Contract: prints the physical path and returns 0, or prints nothing and
 * returns non-zero. A MISSING LEAF still resolves — its parent directory does,
 * and the leaf is appended — so `Read` of a file that is not there keeps
 * reporting the tool's own "No such file", not a containment error. A missing
 * or unreadable PARENT is a failure, which is correct for these three tools:
 * Read/Glob/Grep only ever name a path that must already exist.
 *
 * OPTIONAL SECOND ARG (#7897) — `$2`, non-empty to opt in, empty/absent (every
 * pre-#7897 caller) to keep the contract above byte-for-byte. It widens
 * exactly one case: a missing PARENT hit while resolving a FOLLOWED SYMLINK's
 * TARGET (`$__n -gt 0` — at least one `readlink` hop already happened), never
 * the original `$1`'s own first-hop parent, which stays a hard failure
 * regardless of this flag. The host's component-wise resolver
 * (`resolveTargetComponentwiseAsync`, utils/componentwise-resolver.js) hits
 * ENOENT and switches to a purely lexical tail-append with no further
 * filesystem access; `__cx_resolve` had no equivalent, so a dangling symlink
 * whose target's own parent is ALSO missing (`sub/target.ts -> ./gone/x.ts`,
 * `gone` not just `x.ts` absent) failed the `cd -P` on that missing parent and
 * the whole match was withheld — a real undermatch against the host for a
 * shape #7355/#7357's single-level fixture never exercised. `__cx_resolve_new`
 * (below) already implements exactly this "peel trailing components until one
 * exists, resolve that prefix physically, re-append the rest lexically"
 * walk for CREATE-mode paths, so the fallback reuses it rather than growing a
 * second copy (`__cx_resolve_new`'s own doc: "reused, not reimplemented — a
 * second resolution loop is a second thing to drift") — at the point of
 * failure `$__p` is always already absolute (built from a prior hop's
 * `pwd -P`), which is exactly what `__cx_resolve_new` requires. Gated to
 * `$__n -gt 0` rather than applied unconditionally so the original path's own
 * missing-parent case — Read/Grep naming a path with no such directory at
 * all — keeps failing exactly as before; only Glob's per-match symlink
 * resolution ({@link buildConfinedGlobBody}) passes the flag.
 */
const CONTAINER_RESOLVE_FN = [
  '__cx_resolve() {',
  '  local __p=$1 __cx_lenient=${2:-} __d __b __t __cd __n=0',
  `  while [ "$__n" -lt ${CONTAINER_RESOLVE_MAX_HOPS} ]; do`,
  '    if [ -d "$__p" ]; then ( unset CDPATH; cd -P -- "$__p" 2>/dev/null && pwd -P ) || return 1; return 0; fi',
  '    case $__p in */*) __d=${__p%/*}; __b=${__p##*/} ;; *) __d=.; __b=$__p ;; esac',
  '    [ -n "$__d" ] || __d=/',
  '    if ! __cd=$( unset CDPATH; cd -P -- "$__d" 2>/dev/null && pwd -P ); then',
  // #7897 — only past the first hop (already inside a followed symlink's
  // target, never the original `$1`) and only when the caller opted in.
  '      if [ "$__n" -gt 0 ] && [ -n "$__cx_lenient" ]; then __cx_resolve_new "$__p" && return 0; fi',
  '      return 1',
  '    fi',
  '    __d=$__cd',
  '    __p=$__d/$__b',
  '    if [ -L "$__p" ]; then',
  // The `--` first, then WITHOUT it (Copilot, PR #7867): the image is a user
  // opt, there is no allowlist, and a BusyBox `readlink` that did not honour
  // `--` would refuse every legitimate symlink in an Alpine container. Dropping
  // `--` costs nothing here and cannot recreate #7295: by this line `$__p` is
  // `$__d/$__b` where `__d` came from `pwd -P`, so it ALWAYS begins with `/`
  // and can never be read as an option. The `--` stays first so the guarantee
  // does not rest on that invariant where a utility honours the terminator.
  '      __t=$(readlink -- "$__p" 2>/dev/null || readlink "$__p") || return 1',
  '      case $__t in /*) __p=$__t ;; *) __p=$__d/$__t ;; esac',
  '      __n=$((__n+1))',
  '      continue',
  '    fi',
  '    printf \'%s\\n\' "$__p"',
  '    return 0',
  '  done',
  '  return 1',
  '}',
].join('\n')

/**
 * SECURITY (#7876) — the bash source of `__cx_resolve_new`, the CREATE-mode
 * resolver for container Write/Edit: the DEEPEST-EXISTING-ANCESTOR walk.
 *
 * `__cx_resolve` is right for Read/Glob/Grep because they only ever name a path
 * whose parent exists. Write names paths that may be several levels short of
 * existing (`esc/new/deeper/file.txt`) and `mkdir -p`s the gap, so resolving
 * the whole path fails outright — and resolving nothing leaves `mkdir -p` free
 * to walk through `esc -> /etc`. This walk:
 *
 *   1. peels components off the END of the lexical path until what is left
 *      EXISTS. "Exists" is `[ -e ] || [ -L ]`, never `-e` alone: `-e` follows
 *      the link, so a DANGLING link reads as absent, the walk steps past it,
 *      and the later `mkdir -p` / `>` goes through it to wherever it points
 *      (`>` CREATES a dangling link's target). Stopping on the link hands it to
 *      `__cx_resolve`, which resolves it to its target — outside is an escape,
 *      unresolvable is a failure, never a pass;
 *   2. refuses any peeled component that is `..`, `.` or empty (`//`, a
 *      trailing `/`). `remapToContainerPath` already collapses those lexically,
 *      and this refusal deliberately does not trust it: the peeled remainder is
 *      re-appended WITHOUT resolution, so a `..` in it would be resolved by the
 *      kernel only at `mkdir` time — after the containment check. The remainder
 *      cannot be absolute: it is built from components, none of which contain
 *      `/`;
 *   3. resolves the existing prefix physically with `__cx_resolve` (reused, not
 *      reimplemented — a second resolution loop is a second thing to drift);
 *   4. prints `<resolved-prefix>/<remainder>`. When the whole path exists the
 *      remainder is empty and this is exactly `__cx_resolve target`, i.e. the
 *      Read route.
 *
 * Every component the caller's body creates afterwards is created under the
 * RESOLVED prefix, never under the lexical alias, so a link swapped on the
 * alias after the check does not redirect the write. A link swapped INSIDE the
 * already-resolved prefix between the check and the write is the same
 * check-then-use window the host-side tools and #7354 accept.
 *
 * Absolute paths only: every caller hands it a `/workspace/...` path from
 * `remapToContainerPath`, and refusing a relative one keeps the walk's
 * termination (it always reaches `/`, which exists) unconditional.
 */
const CONTAINER_RESOLVE_NEW_FN = [
  '__cx_resolve_new() {',
  '  local __p=$1 __rest= __c __r',
  '  case $__p in /*) ;; *) return 1 ;; esac',
  '  while ! { [ -e "$__p" ] || [ -L "$__p" ]; }; do',
  '    __c=${__p##*/}',
  '    case $__c in \'\'|.|..) return 1 ;; esac',
  '    __rest=$__c${__rest:+/$__rest}',
  '    __p=${__p%/*}',
  '    [ -n "$__p" ] || __p=/',
  '  done',
  '  __r=$(__cx_resolve "$__p") || return 1',
  '  if [ -z "$__rest" ]; then printf \'%s\\n\' "$__r"; return 0; fi',
  '  case $__r in */) printf \'%s%s\\n\' "$__r" "$__rest" ;; *) printf \'%s/%s\\n\' "$__r" "$__rest" ;; esac',
  '}',
].join('\n')

/**
 * Resolver per confinement mode — see {@link buildConfinedContainerCommand}.
 *
 * `'read'` now carries `CONTAINER_RESOLVE_NEW_FN` too (#7897): `__cx_resolve`'s
 * optional lenient fallback calls `__cx_resolve_new`, and Glob
 * ({@link buildConfinedGlobBody}) — the only caller that opts in — runs in
 * 'read' mode. The top-level `__cx_ws`/`__cx_target` resolution in `'read'`
 * mode is unaffected: neither call passes the lenient flag, so `__cx_resolve`
 * behaves exactly as before for them, and `__cx_resolve_new` being merely
 * DEFINED (not called) costs nothing.
 */
const CONFINE_MODES = new Map([
  ['read', { fns: [CONTAINER_RESOLVE_FN, CONTAINER_RESOLVE_NEW_FN], resolver: '__cx_resolve' }],
  ['create', { fns: [CONTAINER_RESOLVE_FN, CONTAINER_RESOLVE_NEW_FN], resolver: '__cx_resolve_new' }],
])

/**
 * SECURITY (#7354) — wrap `body` in the container-side confinement preamble.
 *
 * The emitted script resolves `workspace` and `target` physically, refuses
 * unless the resolved target is the resolved workspace or under it, and only
 * then prints {@link CONTAINER_CONFINE_OK} and runs `body`. `body` receives the
 * RESOLVED target in `"$__cx_target"` and must use it in place of the lexical
 * path — the same thing the host does (`safeResolveRoot` hands bash the
 * realpath, not the symlinked alias), so a link swapped after the check cannot
 * redirect the read.
 *
 * FAIL CLOSED, in both directions: every bail prints a sentinel and `exit 0`,
 * so the failure arrives as a parseable reply rather than as a non-zero exit
 * that `execInEnvironment` turns into a thrown Error; and the host refuses any
 * stdout whose first line is not one of the three sentinels, so a reply it
 * cannot account for is an error and never "no matches".
 *
 * `mode` picks how `target` is resolved; the workspace is always resolved with
 * `__cx_resolve` and the containment `case` is the same in both:
 *   - `'read'` (default) — `__cx_resolve`: the parent must exist. Read, Glob and
 *     Grep; their emitted script is unchanged by the existence of `'create'`.
 *   - `'create'` (#7876) — `__cx_resolve_new`, the deepest-existing-ancestor
 *     walk, for a target that may not exist yet. Write and Edit. The body must
 *     create anything it creates under `"$__cx_target"` (e.g.
 *     `mkdir -p "${__cx_target%/*}"`), never under the lexical path.
 *
 * @param {{ target: string, body: string, setup?: string, workspace?: string, mode?: 'read'|'create' }} opts
 *   `setup` runs AFTER the containment check and BEFORE the OK sentinel; it
 *   must be a single command whose non-zero exit means "could not proceed".
 */
export function buildConfinedContainerCommand({ target, body, setup = '', workspace = '/workspace', mode = 'read' }) {
  const confine = CONFINE_MODES.get(mode)
  // An unknown mode is a caller bug. Falling back to either resolver would pick
  // a containment policy the caller did not ask for, silently.
  if (!confine) throw new Error(`buildConfinedContainerCommand: unknown mode ${JSON.stringify(mode)}`)
  const bail = (sentinel) => `{ printf '%s\\n' '${sentinel}'; exit 0; }`
  const lines = [
    ...confine.fns,
    `__cx_ws=$(__cx_resolve ${shellQuote(workspace)}) || ${bail(CONTAINER_CONFINE_ERROR)}`,
    `__cx_target=$(${confine.resolver} ${shellQuote(target)}) || ${bail(CONTAINER_CONFINE_ERROR)}`,
    `case $__cx_target in "$__cx_ws"|"$__cx_ws"/*) ;; *) ${bail(CONTAINER_CONFINE_ESCAPE)} ;; esac`,
  ]
  if (setup) lines.push(`${setup} || ${bail(CONTAINER_CONFINE_ERROR)}`)
  lines.push(`printf '%s\\n' '${CONTAINER_CONFINE_OK}'`)
  lines.push(body)
  return lines.join('\n')
}

/**
 * SECURITY (#7354) — the container-side Glob body: expand `pattern` under the
 * already-confined `"$__cx_target"` and emit only the matches that RESOLVE
 * inside it.
 *
 * The pattern route needs its own layer because the search root is clean and
 * the MATCH is what leaves: `{"pattern":"esc/*"}` produces `esc/passwd`, which
 * `globMatchEscapesRoot` reads as perfectly in-bounds.
 *
 * Withheld matches are dropped silently AS FAR AS THE MODEL IS CONCERNED — the
 * tool_result is indistinguishable from "matched nothing". That is the #7341
 * rule and it is deliberate: anything that separates "matched, but outside"
 * from "matched nothing" is an existence oracle on a tool that
 * `ACCEPT_EDITS_TOOLS` auto-approves. An escaping `path` ARGUMENT is different
 * and does return an error — the caller named that directory outright, so
 * refusing it tells them nothing they did not already supply.
 *
 * Silent to the model is NOT silent to the operator. The body counts what it
 * withheld and prints {@link CONTAINER_CONFINE_WITHHELD} as a trailer, which
 * the host strips (never forwarding it) and writes to the daemon log. A guard
 * whose only successful outcome is an ordinary-looking success leaves an
 * operator no way to tell it from a guard that was never wired — the shape
 * `docs/false-safety-guards.md` exists to catalogue.
 *
 * COST: one subshell per unique directory, not per match. The last directory's
 * verdict is memoised in two plain variables (glob output is sorted, so runs of
 * matches share a directory) rather than in a bash-4 associative array, and the
 * entry itself is resolved only when the glob already found it to be a symlink
 * — the same shape as the host's `confineGlobMatches`.
 *
 * FAIL CLOSED: a match whose resolution fails is withheld, never emitted.
 *
 * `pattern` MUST already be validated against GLOB_PATTERN_SHELL_METACHARS AND
 * {@link globPatternEscapeReason} by the caller — it is interpolated UNQUOTED so
 * the shell expands it, which is the whole point of the tool and also why
 * containment cannot be delegated to `shellQuote`.
 *
 * This replaced an unconfined `buildGlobCommand` (#7354). The old builder was
 * deleted rather than left beside it: an exported "same thing, no resolution"
 * variant is how a guard comes to be wired to only some of its callers
 * (`docs/false-safety-guards.md`, #7262), and it had exactly one caller.
 *
 * #7357 — matches are NUL-delimited (`printf '%s\0'`), not `\n`-delimited. A
 * filename may legally contain a newline; a `\n`-joined stream can't tell "one
 * match with an embedded newline" apart from "two matches", so the HOST's
 * parser ({@link splitWithheldTrailer}, then the caller's `split('\0')`) would
 * silently turn one real match into two lines — one of them a path that does
 * not exist as spelled. NUL is the one byte a POSIX filename cannot contain,
 * so it is the only delimiter that is unambiguous for every legal match. The
 * withheld-count TRAILER stays `\n`-terminated (see {@link CONTAINER_CONFINE_WITHHELD}) —
 * it is fixed host-authored text, not a filename, so it carries no ambiguity
 * and is the one line the host can split on safely.
 *
 * #7896 — a purely LITERAL match (no `*`/`?`/`[`/`{`) must be existence-checked
 * too. `nullglob` only suppresses a pattern that CONTAINS a wildcard
 * metacharacter and fails to expand; a fully literal `pattern` is never
 * subject to pathname expansion at all, so bash hands the `for` loop the
 * literal word verbatim whether or not anything on disk matches it. The host
 * (`fs.glob`, via `byok-tool-executor.js`'s `runGlob`) always verifies
 * existence, so a literal pattern with no real match must be withheld here the
 * same way — `[ -e "$f" ]`, skipped for a symlink entry since the `-L` branch
 * below already existence-checks (and resolves) it, including the dangling
 * case that legitimately has no target.
 *
 * #7897 — resolving a symlink MATCH now passes `__cx_resolve`'s lenient flag
 * (`"$f" 1`), so a dangling symlink whose target's own parent is also missing
 * (`deep/x.ts -> ./gone/y.ts`, `gone` absent, not just `y.ts`) resolves
 * lexically past that point instead of failing outright — the same "ENOENT
 * stops filesystem access, lexically append the rest" rule the host's
 * `resolveTargetComponentwiseAsync` already applies (see `__cx_resolve`'s doc).
 * The containment check on the next line is UNCHANGED and still the only
 * thing that decides keep-vs-withhold: a lenient resolution that lands outside
 * `$__cx_target` is withheld exactly like any other escaping symlink target,
 * so this only closes an undermatch, never opens an escape.
 */
export function buildConfinedGlobBody(pattern) {
  return [
    // Two statements, not `shopt -s nullglob globstar`: an image whose bash
    // predates globstar (3.2, still the system bash on macOS) makes the
    // combined form fail, and `nullglob` — the one that decides whether an
    // unmatched pattern is emitted VERBATIM — must not be lost with it.
    'shopt -s nullglob',
    // `2>/dev/null` is not cosmetic. On a bash with no `globstar` (3.2) the
    // option name is rejected on STDERR, and the caller's "no stdout AND
    // stderr" branch then turns every empty Glob — including one whose matches
    // were all WITHHELD — into `Glob failed: ...` instead of `No matches`.
    // Losing globstar degrades `**` to `*`, which is the intended degradation;
    // turning containment into a container error is not.
    'shopt -s globstar 2>/dev/null',
    // \x01 cannot appear in a path, so the first iteration always misses.
    '__cx_lastd=$\'\\001\'; __cx_lastv=n; __cx_withheld=0',
    `for f in ${pattern}; do`,
    '  case $f in */*) __cx_d=${f%/*} ;; *) __cx_d=. ;; esac',
    '  if [ "$__cx_d" != "$__cx_lastd" ]; then',
    '    if __cx_r=$(__cx_resolve "$__cx_d"); then',
    '      case $__cx_r in "$__cx_target"|"$__cx_target"/*) __cx_lastv=y ;; *) __cx_lastv=n ;; esac',
    '    else',
    '      __cx_lastv=n',
    '    fi',
    '    __cx_lastd=$__cx_d',
    '  fi',
    '  if [ "$__cx_lastv" != y ]; then __cx_withheld=$((__cx_withheld+1)); continue; fi',
    '  if [ -L "$f" ]; then',
    '    if ! __cx_r=$(__cx_resolve "$f" 1); then __cx_withheld=$((__cx_withheld+1)); continue; fi',
    '    case $__cx_r in "$__cx_target"|"$__cx_target"/*) ;; *) __cx_withheld=$((__cx_withheld+1)); continue ;; esac',
    // #7896 — nullglob only suppresses a WILDCARD pattern that fails to
    // expand; a purely literal `pattern` reaches this loop verbatim even when
    // nothing on disk matches it. A symlink entry (handled above, including
    // dangling) is excluded here since it is not `-e`-testable by definition
    // when dangling and was already existence-checked (via resolution) above.
    '  elif [ ! -e "$f" ]; then',
    '    __cx_withheld=$((__cx_withheld+1)); continue',
    '  fi',
    '  printf \'%s\\0\' "$f"',
    'done',
    // The operator's trace. Always emitted, including as `... 0`, so the host
    // can tell "nothing was withheld" from "the trailer never arrived" — the
    // same reason the OK sentinel exists.
    `printf '%s %s\\n' '${CONTAINER_CONFINE_WITHHELD}' "$__cx_withheld"`,
  ].join('\n')
}

/**
 * SECURITY (#7354) — host side of {@link buildConfinedContainerCommand}: split
 * the sentinel off the container's stdout.
 *
 * ONLY the three sentinels are accepted. Anything else — an empty reply, a
 * banner some image prints on shell startup, a truncated stream — is
 * `{ ok:false, reason:'unparseable' }`, which callers surface as an error.
 * Treating it as "no matches" instead would be the catalogue's second recurring
 * cause verbatim: "cannot check this" silently treated as "nothing to check".
 *
 * @param {string} stdout
 * @returns {{ ok: true, body: string } | { ok: false, reason: 'escape'|'error'|'unparseable' }}
 */
export function parseConfinedContainerStdout(stdout) {
  if (typeof stdout !== 'string') return { ok: false, reason: 'unparseable' }
  const nl = stdout.indexOf('\n')
  const first = nl === -1 ? stdout : stdout.slice(0, nl)
  const rest = nl === -1 ? '' : stdout.slice(nl + 1)
  if (first === CONTAINER_CONFINE_OK) return { ok: true, body: rest }
  if (first === CONTAINER_CONFINE_ESCAPE) return { ok: false, reason: 'escape' }
  if (first === CONTAINER_CONFINE_ERROR) return { ok: false, reason: 'error' }
  return { ok: false, reason: 'unparseable' }
}

/**
 * SECURITY (#7354) — split the {@link CONTAINER_CONFINE_WITHHELD} trailer off a
 * confined Glob body.
 *
 * The trailer NEVER reaches the model: stripping it here is what keeps the
 * no-oracle rule while still giving the daemon log a count. It is always the
 * last thing in the body, so it is matched positionally rather than by
 * scanning — a file literally named `__chroxy_confine_withheld__ 3` in the
 * middle of the results cannot be mistaken for it.
 *
 * #7357 — matches above the trailer are NUL-delimited (see
 * {@link buildConfinedGlobBody}), so the trailer is found by locating the
 * LAST `\0` rather than the last `\n`: everything before and including it is
 * the (still NUL-delimited) match stream, untouched; everything after it is
 * the trailer's own `\n`-terminated line. When there are zero matches the
 * body is just the trailer line with no NUL at all, which the `lastIndexOf`
 * fallback (`-1` → treat the whole body as the trailer candidate) handles the
 * same way.
 *
 * `withheld: null` means the trailer was absent, which is reported as "unknown"
 * rather than as zero. The count is observability, not containment (the
 * withholding already happened in the container), so a missing trailer must not
 * read as "nothing was withheld" — that is the catalogue's "cannot check this
 * treated as nothing to check" one register down.
 *
 * @param {string} body
 * @returns {{ body: string, withheld: number | null }}
 */
export function splitWithheldTrailer(body) {
  if (typeof body !== 'string') return { body: '', withheld: null }
  const lastNul = body.lastIndexOf('\0')
  const matches = lastNul === -1 ? '' : body.slice(0, lastNul + 1)
  const trailerPart = lastNul === -1 ? body : body.slice(lastNul + 1)
  const trailerLine = trailerPart.endsWith('\n') ? trailerPart.slice(0, -1) : trailerPart
  const match = WITHHELD_TRAILER_RE.exec(trailerLine)
  if (!match) return { body, withheld: null }
  return { body: matches, withheld: Number(match[1]) }
}

/**
 * The tool_result message for a confinement failure. `reason` comes from
 * {@link parseConfinedContainerStdout}; `label` is the tool name.
 */
export function confinedContainerFailureMessage(label, reason, path) {
  const where = typeof path === 'string' && path.length > 0 ? ` ${path}` : ''
  if (reason === 'escape') {
    return `${label} refused:${where} resolves outside the workspace inside the container (symlinked path)`
  }
  // `unparseable` is NOT a fact about the path (Copilot, PR #7867). The error
  // sentinel says the container resolved the path and failed; an unparseable
  // reply says the container's verdict never arrived — the guard may not have
  // run at all, stdout may have been truncated, an image may have printed a
  // banner. Collapsing the two sends an operator to look at the file when the
  // thing to look at is the container. The refusal is the same either way; the
  // diagnosis is not.
  if (reason === 'unparseable') {
    return `${label} failed: the container returned no valid confinement verdict${where} — the reply was missing or malformed, so the guard's result is unknown and the output was withheld rather than reported as no matches`
  }
  return `${label} failed: could not resolve${where} inside the container (missing, inaccessible, or a symlink loop)`
}

/**
 * Derive the rg/grep flag fragments from a Grep tool input: case-insensitive
 * (`-i`), line numbers (`-n`, default on), and an optional `--glob` filter.
 * `--glob` is ripgrep-specific and is threaded only into `buildGrepCommand`'s
 * `rg` branch — the `grep -r` fallback (used when `rg` is absent) has no
 * `--glob` equivalent and silently ignores `globArg` (GNU grep's nearest
 * analog is `--include`, not implemented here); `ci`/`ln`/`pattern`/`root`
 * apply identically on both branches.
 *
 * SECURITY (#7928): `glob` is model-controlled, same as `pattern`/`root`
 * (#7295) — but unlike those two, it is bound to a NAMED flag (`--glob`)
 * rather than a bare positional, which `argv-safety.js` documents as
 * generally the safer shape (case 3: fuse the value into the same token as
 * the flag, `--flag=<value>`, so it can never be split into a separate argv
 * element). `--glob <value>` (the space-separated form this used to emit) is
 * only as safe as `--glob`'s DECLARED ARITY, and that must be measured, not
 * assumed — the same rule `cliHelpFlagArity`'s doc states for every other CLI
 * in this repo. Measured against ripgrep 15.2.0 (`-g GLOB, --glob=GLOB`,
 * required-arg): the space form already consumed a hostile next token
 * (`--pre=<script>`, `-e`, `--files`, `-h`, `--help`, `-V`, `--version`) as
 * the glob's own value in every case — none reached rg's own option parser as
 * a distinct flag, so no `--pre` execution and no help/version short-circuit.
 *
 * That measurement is still not a fix: it is a fact about one rg build, and
 * `--glob`'s arity is not documented as part of any argv contract this repo
 * controls. The `--glob=<value>` JOINED form below removes the question
 * entirely rather than resting on it — `shellQuote(input.glob)` still closes
 * SHELL injection (unchanged), and butting it directly against `--glob=` with
 * no space fuses both into one shell word, so word-splitting can never hand
 * the value to rg as a second, independent argv element regardless of what
 * `--glob` requires. Proven by `tests/built-in-tools/grep-argv-injection.test.js`.
 */
export function buildGrepArgs(input) {
  const ci = input?.['-i'] === true ? '-i' : ''
  const ln = input?.['-n'] !== false ? '-n' : ''
  const globArg = typeof input?.glob === 'string' && input.glob.length > 0
    ? ` --glob=${shellQuote(input.glob)}` : ''
  return { ci, ln, globArg }
}

/**
 * Build the bash command that greps `pattern` under `root`, preferring ripgrep
 * and falling back to `grep -r` only when rg is truly absent (an `if/then/else`,
 * NOT `rg || grep`, so a no-match rg exit-1 doesn't re-run the search). Both
 * exit 1 on "no matches"; pass `maskExit:true` when the runner rejects on
 * non-zero (the container's `execInEnvironment`) so that case isn't a failure.
 *
 * SECURITY (#7295): BOTH model/caller-controlled interpolations are kept out
 * of a bare positional slot — the pattern by `-e`, and the root by the `--`
 * terminator after it. `shellQuote` closes SHELL injection only: bash eats the
 * quotes, and rg/grep then run their OWN option parser over an argv element
 * that still begins with `-`. Measured against ripgrep 15.1.0, a positional
 * `--pre=<path>` value makes rg EXECUTE `<path>` as a per-file preprocessor,
 * and — with the root swallowed into the pattern slot, leaving rg zero paths —
 * blocks forever reading stdin. Program execution plus a hung tool call,
 * through `Grep`.
 *
 * That matters because of WHERE this sits. `Grep` gets a reduced (secrets-only)
 * permission floor via `SECRET_READ_FLOOR_TOOLS`, is auto-approved in
 * `acceptEdits` mode via `ACCEPT_EDITS_TOOLS`, and can carry a standing
 * auto-allow rule via `ELIGIBLE_TOOLS` — while `Bash`, which owns this
 * capability honestly, is refused a whitelist outright by `NEVER_AUTO_ALLOW`.
 *
 * The `--` is defence in depth, not a live fix: both callers already guarantee
 * an absolute root (`safeResolveRoot` on the host, `remapToContainerPath` in
 * the container). It is here so the builder does not depend on an invariant it
 * neither states nor tests — a third caller passing a raw client path would
 * otherwise restore the identical `--pre=` execution through the root slot.
 * MEASURED: `rg -e TODO '--pre=<script>'` executes the script (rc=0, marker
 * written); with `--` before it, rc=2 and no execution.
 *
 * `--no-config` is both hardening and a correctness fix. rg reads the file named
 * by `RIPGREP_CONFIG_PATH` and applies it as flags — including `--pre`, so an env
 * that reaches the daemon reinstates the execution this function exists to stop.
 * It is not client-reachable today (`buildSafeBashEnv` copies the daemon's own
 * env, which nothing mutates at runtime), but it also breaks ordinary searching:
 * MEASURED, a config containing `--pre=/bin/echo` turned a matching search into
 * rc=1 no-match, silently. Machine-parsed output must not depend on a developer's
 * personal rg config. `grep` has no equivalent to disable.
 *
 * `-e` and not a leading-dash REJECTION: `-Wall` and `--force` are legitimate
 * search patterns, so rejecting them would be a functional regression. See
 * `utils/argv-safety.js` (bind-to-a-named-flag); rg and grep accept the
 * two-token `-e <value>` form, measured. Proven red-before-green by
 * `tests/built-in-tools/grep-argv-injection.test.js`, which spawns the built
 * command and asserts the preprocessor never runs.
 *
 * `rootExpr` (#7354) replaces the quoted literal root with a shell EXPRESSION —
 * the container passes `"$__cx_target"`, the variable the confinement preamble
 * left the physically-resolved root in. It exists so the container can search
 * the resolved path rather than the symlinked alias it was handed, which is
 * exactly what the host already does (`buildGrepCommand` is called with
 * `safeResolveRoot`'s realpath). The caller owns the quoting of that expression;
 * the `--` terminator — the part that carries the #7295 property — is unchanged
 * either way, so a root that still begins with `-` cannot reach rg's own option
 * parser through this door.
 *
 * `globArg` (#7928) is `buildGrepArgs`'s third model-controlled interpolation,
 * and is a THIRD, distinct case from `pattern`/`root` above: it is bound to a
 * named flag rather than a bare positional, so `buildGrepArgs` fuses it into
 * one token (`--glob=<value>`, argv-safety.js case 3) instead of using a `-e`-
 * style two-token bind or a `--` terminator — either of those needs a
 * positional slot to terminate INTO, which `--glob` does not have. See
 * `buildGrepArgs`'s own doc for the measurement (ripgrep 15.2.0, required-arg)
 * and why the fix does not rest on it.
 *
 * @param {{ pattern: string, root?: string, rootExpr?: string, ci: string, ln: string, globArg: string, maskExit?: boolean }} opts
 */
export function buildGrepCommand({ pattern, root, rootExpr, ci, ln, globArg, maskExit = false }) {
  const rootArg = typeof rootExpr === 'string' && rootExpr.length > 0 ? rootExpr : shellQuote(root)
  const rgCmd = `rg --no-config ${ci} ${ln} --no-heading${globArg} -e ${shellQuote(pattern)} -- ${rootArg}`
  const grepCmd = `grep -r ${ci} ${ln} -e ${shellQuote(pattern)} -- ${rootArg}`
  const core = `if command -v rg >/dev/null 2>&1; then ${rgCmd}; else ${grepCmd}; fi`
  return maskExit ? `${core}; true` : core
}
