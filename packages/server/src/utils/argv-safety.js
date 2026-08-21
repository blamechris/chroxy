/**
 * Argv option-injection guards (#7290, #7291).
 *
 * `execFile`/`spawn` with an array argv already stops SHELL injection — no
 * shell ever sees the string. It does NOT stop ARGUMENT injection: the spawned
 * program still runs its own option parser over that array, so a value that
 * begins with `-` is read as an OPTION rather than as the datum it was meant
 * to be. That is a distinct class, and it needs a distinct guard.
 *
 * There are exactly two correct fixes, and which one applies is decided by
 * whether a leading `-` is LEGITIMATE for that datum:
 *
 *   1. The value can never legitimately start with `-` (a git ref, a branch,
 *      a container name) → REJECT it. `isSafeArgvValue` / `assertSafeArgvValue`.
 *
 *   2. The value legitimately can (a user's chat message — "- first point")
 *      → do not reject; terminate option parsing with a `--` separator placed
 *      BEFORE the value, and put every flag the command needs BEFORE the `--`.
 *
 * `--` is NOT interchangeable with (1). It ends option parsing at ITS OWN
 * position, so it cannot retroactively protect a value that precedes it.
 * Measured against git 2.54.0 while fixing #7290:
 *
 *     git diff --stat --        still applies --stat
 *     git diff --exit-code --   still exits 1
 *     git diff -O/etc/nope --   still reads the orderfile
 *
 * so `['diff', base, '--']` is not a fix for a dash-leading `base`, and
 * `--literal-pathspecs` (#7281/#7289) does not help either — that constrains
 * the PATHSPEC language, and a revision is not a pathspec.
 */

/**
 * True when `value` is safe to place in an argv slot whose contents would
 * otherwise be option-parsed.
 *
 * Rejects, in order: a non-string, the empty string, a leading `-`, and any
 * NUL / CR / LF. The control characters matter because several CLIs (and git's
 * own `--stdin` modes) treat a newline as a record separator, so an embedded
 * one can smuggle a second argument into a single slot.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeArgvValue(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('-') &&
    !/[\0\n\r]/.test(value)
}

/**
 * Throwing form of {@link isSafeArgvValue}, for call sites that must refuse
 * rather than fall back.
 *
 * @param {unknown} value
 * @param {string} [kind] - noun for the error message, e.g. 'branch', 'ref'.
 * @throws {Error} when `value` would be option-parsed.
 */
export function assertSafeArgvValue(value, kind = 'value') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`empty ${kind}`)
  }
  if (!isSafeArgvValue(value)) {
    throw new Error(`unsafe ${kind}: ${JSON.stringify(value)}`)
  }
}

/**
 * Does a CLI's `--help` output advertise `flag` as a flag in its OWN right?
 *
 * A bare `help.includes('--remote')` is a false-safety guard: it reports
 * success without checking, because it also matches `--remote-control`. That
 * is not hypothetical — measured against the installed Claude Code CLI while
 * fixing #7291, whose help text carries `--remote-control` and
 * `--remote-control-session-name-prefix` and NO `--remote`:
 *
 *     help.includes('--remote')   -> true    (wrong: opens the gate)
 *     cliHelpAdvertisesFlag(...)  -> false   (right)
 *
 * The trailing `(?![\w-])` is the whole point — the flag must not be followed
 * by another word character or a hyphen, which is what distinguishes a flag
 * from a longer flag that merely starts the same way.
 *
 * @param {unknown} helpText - captured stdout of `<cli> --help`.
 * @param {string} flag - the exact flag, including leading dashes, e.g. '--remote'.
 * @returns {boolean}
 */
export function cliHelpAdvertisesFlag(helpText, flag) {
  if (typeof helpText !== 'string' || typeof flag !== 'string' || !flag) return false
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?![\\w-])`).test(helpText)
}
