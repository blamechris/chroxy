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
 * match), so this is the CONTAINER's boundary: its matches are produced inside
 * the container where no host realpath can reach them. What it cannot see is a
 * symlinked directory inside `/workspace` — lexically clean, resolves out. See
 * `_containerGlob` for that residual.
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
 */
const CONTAINER_RESOLVE_FN = [
  '__cx_resolve() {',
  '  local __p=$1 __d __b __t __n=0',
  `  while [ "$__n" -lt ${CONTAINER_RESOLVE_MAX_HOPS} ]; do`,
  '    if [ -d "$__p" ]; then ( unset CDPATH; cd -P -- "$__p" 2>/dev/null && pwd -P ) || return 1; return 0; fi',
  '    case $__p in */*) __d=${__p%/*}; __b=${__p##*/} ;; *) __d=.; __b=$__p ;; esac',
  '    [ -n "$__d" ] || __d=/',
  '    __d=$( unset CDPATH; cd -P -- "$__d" 2>/dev/null && pwd -P ) || return 1',
  '    __p=$__d/$__b',
  '    if [ -L "$__p" ]; then',
  '      __t=$(readlink -- "$__p") || return 1',
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
 * @param {{ target: string, body: string, setup?: string, workspace?: string }} opts
 *   `setup` runs AFTER the containment check and BEFORE the OK sentinel; it
 *   must be a single command whose non-zero exit means "could not proceed".
 */
export function buildConfinedContainerCommand({ target, body, setup = '', workspace = '/workspace' }) {
  const bail = (sentinel) => `{ printf '%s\\n' '${sentinel}'; exit 0; }`
  const lines = [
    CONTAINER_RESOLVE_FN,
    `__cx_ws=$(__cx_resolve ${shellQuote(workspace)}) || ${bail(CONTAINER_CONFINE_ERROR)}`,
    `__cx_target=$(__cx_resolve ${shellQuote(target)}) || ${bail(CONTAINER_CONFINE_ERROR)}`,
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
 * Withheld matches are dropped SILENTLY here — no sentinel, no count. That is
 * the #7341 rule and it is deliberate: anything that separates "matched, but
 * outside" from "matched nothing" is an existence oracle on a tool that
 * `ACCEPT_EDITS_TOOLS` auto-approves. An escaping `path` ARGUMENT is different
 * and does return an error — the caller named that directory outright, so
 * refusing it tells them nothing they did not already supply.
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
 */
export function buildConfinedGlobBody(pattern) {
  return [
    // Two statements, not `shopt -s nullglob globstar`: an image whose bash
    // predates globstar (3.2, still the system bash on macOS) makes the
    // combined form fail, and `nullglob` — the one that decides whether an
    // unmatched pattern is emitted VERBATIM — must not be lost with it.
    'shopt -s nullglob',
    'shopt -s globstar',
    // \x01 cannot appear in a path, so the first iteration always misses.
    '__cx_lastd=$\'\\001\'; __cx_lastv=n',
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
    '  [ "$__cx_lastv" = y ] || continue',
    '  if [ -L "$f" ]; then',
    '    __cx_r=$(__cx_resolve "$f") || continue',
    '    case $__cx_r in "$__cx_target"|"$__cx_target"/*) ;; *) continue ;; esac',
    '  fi',
    '  printf \'%s\\n\' "$f"',
    'done',
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
 * The tool_result message for a confinement failure. `reason` comes from
 * {@link parseConfinedContainerStdout}; `label` is the tool name.
 */
export function confinedContainerFailureMessage(label, reason, path) {
  const where = typeof path === 'string' && path.length > 0 ? ` ${path}` : ''
  if (reason === 'escape') {
    return `${label} refused:${where} resolves outside the workspace inside the container (symlinked path)`
  }
  return `${label} failed: could not resolve${where} inside the container (missing, inaccessible, or a symlink loop)`
}

/**
 * Derive the rg/grep flag fragments from a Grep tool input: case-insensitive
 * (`-i`), line numbers (`-n`, default on), and an optional `--glob` filter.
 */
export function buildGrepArgs(input) {
  const ci = input?.['-i'] === true ? '-i' : ''
  const ln = input?.['-n'] !== false ? '-n' : ''
  const globArg = typeof input?.glob === 'string' && input.glob.length > 0
    ? ` --glob ${shellQuote(input.glob)}` : ''
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
 * @param {{ pattern: string, root?: string, rootExpr?: string, ci: string, ln: string, globArg: string, maskExit?: boolean }} opts
 */
export function buildGrepCommand({ pattern, root, rootExpr, ci, ln, globArg, maskExit = false }) {
  const rootArg = typeof rootExpr === 'string' && rootExpr.length > 0 ? rootExpr : shellQuote(root)
  const rgCmd = `rg --no-config ${ci} ${ln} --no-heading${globArg} -e ${shellQuote(pattern)} -- ${rootArg}`
  const grepCmd = `grep -r ${ci} ${ln} -e ${shellQuote(pattern)} -- ${rootArg}`
  const core = `if command -v rg >/dev/null 2>&1; then ${rgCmd}; else ${grepCmd}; fi`
  return maskExit ? `${core}; true` : core
}
