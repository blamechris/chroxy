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
  // indexOf walk is O(n) and predictable.
  let matchCount = 0
  let idx = -1
  while ((idx = content.indexOf(oldString, idx + 1)) !== -1) matchCount++

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
 * Build the bash command that lists files matching `pattern` under `root`.
 * `pattern` MUST already be validated against GLOB_PATTERN_SHELL_METACHARS by
 * the caller (it is interpolated unquoted so the shell expands it).
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
 * @param {{ pattern: string, root: string, ci: string, ln: string, globArg: string, maskExit?: boolean }} opts
 */
export function buildGrepCommand({ pattern, root, ci, ln, globArg, maskExit = false }) {
  const rgCmd = `rg ${ci} ${ln} --no-heading${globArg} ${shellQuote(pattern)} ${shellQuote(root)}`
  const grepCmd = `grep -r ${ci} ${ln} ${shellQuote(pattern)} ${shellQuote(root)}`
  const core = `if command -v rg >/dev/null 2>&1; then ${rgCmd}; else ${grepCmd}; fi`
  return maskExit ? `${core}; true` : core
}
