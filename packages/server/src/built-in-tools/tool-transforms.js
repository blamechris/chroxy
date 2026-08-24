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
 * Word-start positions a bash expansion can begin at inside an interpolated
 * glob pattern: the start of the pattern, or — because brace expansion runs
 * FIRST and yields each alternative as its own word — immediately after a
 * `{` or a `,`. MEASURED (bash 3.2/5.x): `{~,.}/.ssh/config` tilde-expands to
 * the real home, and `{a,/etc}/passwd` yields `/etc/passwd`. A leading-only
 * check is therefore bypassable and this must anchor at all three positions.
 */
const GLOB_PATTERN_ABSOLUTE = /(^|[{,])\//
const GLOB_PATTERN_TILDE = /(^|[{,])~/
/**
 * A `..` that forms a whole path SEGMENT. Delimited on both sides so an
 * ordinary filename keeps working: `*~` (emacs backups) and `report..final.md`
 * are legitimate patterns and must not be rejected — only `..`, `../x`,
 * `x/../y` and the brace form `{.,..}/x` are traversal.
 */
const GLOB_PATTERN_DOTDOT = /(^|[/{,])\.\.($|[/},])/

/**
 * SECURITY (#7341): reject a Glob `pattern` that can expand OUTSIDE the
 * workspace root. `GLOB_PATTERN_SHELL_METACHARS` is a *shell-injection*
 * denylist and was mistaken for containment — it permits `~`, `/` and `..`,
 * so `Glob {"pattern":"~/.ssh/*"}` and `{"pattern":"../../../../etc/pass*"}`
 * both returned real files through a tool that is classified read-only and is
 * therefore auto-approved in `acceptEdits` mode (`ACCEPT_EDITS_TOOLS`),
 * rule-whitelistable (`ELIGIBLE_TOOLS`) and given only the reduced secrets
 * floor (`SECRET_READ_FLOOR_TOOLS`). The protected-path floor could not catch
 * it either: `PROTECTED_PATH_INPUT_FIELDS` is `['file_path','path',
 * 'notebook_path']` and `pattern` is not a member — the same
 * guard-one-field-not-its-sibling shape as #7262, here between `Glob`'s
 * validated `path` and its unvalidated `pattern`.
 *
 * This is the SYNTACTIC half of the fix and it is the only half the container
 * Glob can have (its matches are produced inside the container, out of reach
 * of a host realpath). The host adds a second, stronger layer: every expanded
 * match is realpath-checked against the workspace in `runGlob`, which is what
 * closes the one escape no pattern inspection can see — a symlinked DIRECTORY
 * inside the workspace (`esc -> /etc`, pattern `esc/pass*`, every character
 * of which is legal).
 *
 * @param {string} pattern
 * @returns {string|null} A reason string when the pattern can escape, else null.
 */
export function globPatternEscapeReason(pattern) {
  if (GLOB_PATTERN_ABSOLUTE.test(pattern)) return 'absolute path'
  if (GLOB_PATTERN_TILDE.test(pattern)) return 'home-directory (~) expansion'
  if (GLOB_PATTERN_DOTDOT.test(pattern)) return 'parent-directory (..) traversal'
  return null
}

/** The tool_result message for a pattern rejected by {@link globPatternEscapeReason}. */
export function globPatternEscapeMessage(reason) {
  return `EINVAL: glob pattern escapes the workspace root (${reason}). Patterns are relative to the workspace; use the "path" argument to search a subdirectory.`
}

/**
 * Build the bash command that lists files matching `pattern` under `root`.
 * `pattern` MUST already be validated against GLOB_PATTERN_SHELL_METACHARS AND
 * {@link globPatternEscapeReason} by the caller (it is interpolated unquoted so
 * the shell expands it — that expansion is the whole point, and is also why
 * containment cannot be delegated to `shellQuote`).
 */
export function buildGlobCommand(pattern, root) {
  return `shopt -s globstar nullglob; cd ${shellQuote(root)} && for f in ${pattern}; do printf '%s\\n' "$f"; done`
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
 * @param {{ pattern: string, root: string, ci: string, ln: string, globArg: string, maskExit?: boolean }} opts
 */
export function buildGrepCommand({ pattern, root, ci, ln, globArg, maskExit = false }) {
  const rgCmd = `rg --no-config ${ci} ${ln} --no-heading${globArg} -e ${shellQuote(pattern)} -- ${shellQuote(root)}`
  const grepCmd = `grep -r ${ci} ${ln} -e ${shellQuote(pattern)} -- ${shellQuote(root)}`
  const core = `if command -v rg >/dev/null 2>&1; then ${rgCmd}; else ${grepCmd}; fi`
  return maskExit ? `${core}; true` : core
}
