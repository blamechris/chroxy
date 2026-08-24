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
 * Ceilings on brace expansion so a `{a,b}{a,b}{a,b}...` bomb cannot make the
 * validator itself the denial of service. Exceeding either is a REJECT, not a
 * skip — "too complex to check" must never mean "checked and fine" (the
 * `docs/false-safety-guards.md` cannot-check-so-nothing-to-check class).
 */
const GLOB_MAX_BRACE_WORDS = 256
const GLOB_MAX_BRACE_DEPTH = 8

/**
 * Expand bash brace syntax into the list of words the shell would actually
 * glob. This has to be a REAL expansion, not a set of regexes anchored at `{`
 * and `,`: brace expansion runs FIRST, so `.{.,x}/etc/*` becomes the word
 * `../etc/*` — a traversal whose source text contains no `..` substring at all
 * for a regex to find. MEASURED against bash; the first cut of this guard used
 * anchored regexes and that pattern walked straight through it.
 *
 * @returns {string[]|null} The expanded words, or null when a ceiling is hit.
 */
function expandBraces(word, depth = 0) {
  if (depth > GLOB_MAX_BRACE_DEPTH) return null
  const open = word.indexOf('{')
  if (open === -1) return [word]

  // Find the matching `}` for this `{`, tracking nesting.
  let level = 0
  let close = -1
  for (let i = open; i < word.length; i++) {
    if (word[i] === '{') level++
    else if (word[i] === '}') {
      level--
      if (level === 0) { close = i; break }
    }
  }
  // Unbalanced `{` — bash leaves it literal, so we do too.
  if (close === -1) return [word]

  // Split the body on top-level commas only.
  const body = word.slice(open + 1, close)
  const alts = []
  let cur = ''
  let d = 0
  for (const ch of body) {
    if (ch === '{') d++
    else if (ch === '}') d--
    if (ch === ',' && d === 0) { alts.push(cur); cur = '' } else cur += ch
  }
  alts.push(cur)
  // A body with no top-level comma is not an expansion in bash (`{a}` stays
  // literal `{a}`), so keep the braces rather than silently dropping them.
  if (alts.length === 1) {
    const rest = expandBraces(word.slice(close + 1), depth + 1)
    if (rest === null) return null
    const head = word.slice(0, close + 1)
    return rest.map((r) => head + r)
  }

  const prefix = word.slice(0, open)
  const suffix = word.slice(close + 1)
  const out = []
  for (const alt of alts) {
    const sub = expandBraces(prefix + alt + suffix, depth + 1)
    if (sub === null) return null
    for (const w of sub) {
      if (out.length >= GLOB_MAX_BRACE_WORDS) return null
      out.push(w)
    }
  }
  return out
}

/**
 * Does this single path SEGMENT, read as a shell glob, match the string `..`?
 *
 * The reason a substring search for `..` is not enough: a glob MATCHES the
 * `..` directory entry. MEASURED on bash 3.2 and 5.x, `.*` expands to `. ..`,
 * so a pattern using `.*` as a DIRECTORY segment twice over reaches
 * `../../etc/passwd` while containing no `..` token at all. `..*` and `.?`
 * match the entry too.
 *
 * The leading-dot rule is what keeps this from rejecting everything: POSIX
 * requires a leading `.` to be matched EXPLICITLY, so `*`, `?` and `[.]*` do
 * NOT match `..` (measured — `[.]*` expands to nothing). Only a segment whose
 * first character is a literal `.` is a candidate, which is why `.env*`,
 * `.github` and `.[a-z]*` keep working while `.*` does not.
 */
function segmentMatchesDotDot(segment) {
  if (segment[0] !== '.') return false
  if (segment === '..') return true
  let re = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch === '*') { re += '[^/]*'; continue }
    if (ch === '?') { re += '[^/]'; continue }
    if (ch === '[') {
      // Scan for the closing `]`. A `]` immediately after `[` or `[!`/`[^` is
      // a literal member, per POSIX.
      let j = i + 1
      if (segment[j] === '!' || segment[j] === '^') j++
      if (segment[j] === ']') j++
      while (j < segment.length && segment[j] !== ']') j++
      if (j >= segment.length) { re += '\\['; continue }   // unterminated — literal `[`
      const body = segment.slice(i + 1, j).replace(/^!/, '^')
      re += `[${body}]`
      i = j
      continue
    }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  try {
    return new RegExp(`^${re}$`).test('..')
  } catch {
    return true   // unparseable class — FAIL CLOSED
  }
}

/**
 * SECURITY (#7341): reject a Glob `pattern` that can expand OUTSIDE the
 * workspace root. `GLOB_PATTERN_SHELL_METACHARS` is a *shell-injection*
 * denylist and was mistaken for containment — it permits `~`, `/`, `..` and
 * whitespace, so `Glob {"pattern":"~/.ssh/*"}` and
 * `{"pattern":"../../../../etc/pass*"}` both returned real files through a
 * tool that is classified read-only and is therefore auto-approved in
 * `acceptEdits` mode (`ACCEPT_EDITS_TOOLS`), rule-whitelistable
 * (`ELIGIBLE_TOOLS`) and given only the reduced secrets floor
 * (`SECRET_READ_FLOOR_TOOLS`). The protected-path floor could not catch it
 * either: `PROTECTED_PATH_INPUT_FIELDS` is `['file_path','path',
 * 'notebook_path']` and `pattern` is not a member — the same
 * guard-one-field-not-its-sibling shape as #7262, here between `Glob`'s
 * validated `path` and its unvalidated `pattern`.
 *
 * It works on the words bash would actually glob, in bash's own order —
 * whitespace split, then brace expansion, then tilde — because every shortcut
 * short of that has a bypass:
 *   - whitespace: the pattern is interpolated UNQUOTED, so `* /etc/pass*` is
 *     two patterns and the second one escapes. A space can never match a
 *     literal space in a filename here for exactly the same reason, so
 *     rejecting it costs nothing.
 *   - braces: `.{.,x}/etc/*` expands to `../etc/*`, which no regex over the
 *     source text can see.
 *   - globs that match `..`: `.*` matches the `..` entry, so using it as a
 *     directory segment walks up with no `..` token in the source text.
 *
 * This is the SYNTACTIC half of the fix and it is the only half the container
 * Glob can have (its matches are produced inside the container, out of reach
 * of a host realpath). The host adds a second, stronger layer: every expanded
 * match is realpath-confined in `runGlob`, which is what closes the one escape
 * no pattern inspection can see — a symlinked DIRECTORY inside the workspace
 * (`esc -> /etc`, pattern `esc/pass*`, every character of which is legal).
 *
 * @param {string} pattern
 * @returns {string|null} A reason string when the pattern can escape, else null.
 */
export function globPatternEscapeReason(pattern) {
  if (typeof pattern !== 'string') return 'not a string'
  if (/\s/.test(pattern)) {
    return 'whitespace (unquoted, the shell would read it as several patterns)'
  }
  const words = expandBraces(pattern)
  if (words === null) return 'brace expansion too large to verify'
  for (const word of words) {
    if (word.startsWith('~')) return 'home-directory (~) expansion'
    if (word.startsWith('/')) return 'absolute path'
    for (const segment of word.split('/')) {
      if (segmentMatchesDotDot(segment)) return 'parent-directory (..) traversal'
    }
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
  if (match.startsWith('/')) return true
  return match.split('/').includes('..')
}

/** The tool_result message for a pattern rejected by {@link globPatternEscapeReason}. */
export function globPatternEscapeMessage(reason) {
  return `EINVAL: glob pattern escapes the workspace root (${reason}). Patterns are relative to the workspace; use the "path" argument to search a subdirectory.`
}

/**
 * Build the bash command that lists files matching `pattern` under `root`.
 *
 * CONTAINER-ONLY since #7341. The host Glob no longer shells out at all — it
 * uses `node:fs/promises`'s `glob`, which has no tilde expansion, no word
 * splitting, no quote removal and no brace-body quirks to model, so the entire
 * "what will bash do with this string" question disappears. The container
 * cannot run JS inside itself, so it keeps this, and pairs it with
 * {@link globMatchEscapesRoot} over the RESULTS.
 *
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
