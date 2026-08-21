/**
 * Argv option-injection guards (#7290, #7291).
 *
 * `execFile`/`spawn` with an array argv already stops SHELL injection — no
 * shell ever sees the string. It does NOT stop ARGUMENT injection: the spawned
 * program still runs its own option parser over that array, so a value that
 * begins with `-` is read as an OPTION rather than as the datum it was meant
 * to be. That is a distinct class, and it needs a distinct guard.
 *
 * There are three correct fixes. Which one applies is decided by whether a
 * leading `-` is LEGITIMATE for that datum, and by how the target CLI parses
 * the slot — so it is a per-CLI question, answered by MEASURING, not assumed:
 *
 *   1. The value can never legitimately start with `-` (a git ref, a branch,
 *      a container name) → REJECT it. `isSafeArgvValue` / `assertSafeArgvValue`.
 *
 *   2. The value legitimately can (a user's chat message — "- first point"),
 *      and it sits in a POSITIONAL slot → do not reject; terminate option
 *      parsing with a `--` separator placed BEFORE the value, and put every
 *      flag the command needs BEFORE the `--`. This is what the `claude`
 *      web-task argv does.
 *
 *   3. The value legitimately can, and it is the ARGUMENT TO A NAMED FLAG that
 *      the CLI declares as requiring one → `=`-join the long form,
 *      `--flag=<value>`, binding the value to the flag in a single token.
 *      Neither (1) nor (2) works here. Measured against gemini-cli 0.45.2,
 *      whose `-p/--prompt` and `-m/--model` use yargs `requiresArg`:
 *
 *          gemini -p "- first bullet"       usage error, exit 1
 *          gemini -p -- --list-extensions   usage error, exit 1  (`--` BREAKS it)
 *          gemini --prompt="- first bullet" parses, value taken literally
 *
 *      So a blanket "add `--` everywhere" sweep would be a REGRESSION on such
 *      a CLI. Beware short-circuiting flags when probing: `gemini -p --version`
 *      prints a version because yargs handles `--version` before it validates
 *      `requiresArg`, which makes it look like injection when it is not. Probe
 *      with a flag that does not short-circuit.
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
 * The boundaries are the whole point — the flag must be delimited on BOTH
 * sides by something that is not a word character or a hyphen, which is what
 * distinguishes a flag from a longer flag sharing its prefix or its suffix.
 * A trailing-only test still returns true for `x--remote`, for `---remote`,
 * and — the exact mirror of the defect this function exists to prevent — for
 * a `-O` probe against a help line advertising `--O <file>`.
 *
 * @param {unknown} helpText - captured stdout of `<cli> --help`.
 * @param {string} flag - the exact flag, including leading dashes, e.g. '--remote'.
 * @returns {boolean}
 */
export function cliHelpAdvertisesFlag(helpText, flag) {
  if (typeof helpText !== 'string' || typeof flag !== 'string' || !flag) return false
  return new RegExp(`(?<![\\w-])${escapeForRegExp(flag)}(?![\\w-])`).test(helpText)
}

/** Escape a flag so it can be interpolated into a RegExp body. */
function escapeForRegExp(flag) {
  return flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * How does a CLI's `--help` say `flag` is called — specifically, does it take
 * a REQUIRED argument?
 *
 * This decides whether fix shape (2), the `--` separator, is safe, and the
 * distinction is not cosmetic. Measured against the repo's commander 12.1.0
 * with a client prompt of `--dangerously-skip-permissions`:
 *
 *     declared as       ['--remote', prompt]   ['--remote', '--', prompt]
 *     --remote          INJECTS                safe
 *     --remote [name]   INJECTS                safe
 *     --remote <name>   safe — swallowed as    INJECTS — the `--` becomes the
 *                       the flag's own value   flag's value, freeing the
 *                                              prompt to be option-parsed
 *
 * So against a required-argument flag the separator is not merely useless, it
 * is strictly WORSE than omitting it. No single argv shape is correct under
 * both arities, so a caller must know which it faces and fail closed when it
 * cannot tell.
 *
 * @param {unknown} helpText - captured stdout of `<cli> --help`.
 * @param {string} flag - the exact flag, e.g. '--remote'.
 * @returns {'absent'|'boolean'|'optional'|'required'}
 */
export function cliHelpFlagArity(helpText, flag) {
  if (!cliHelpAdvertisesFlag(helpText, flag)) return 'absent'
  // Inspect what follows the flag on its own help line, skipping any alias
  // list (`--remote, -r <name>`).
  const re = new RegExp(`(?<![\\w-])${escapeForRegExp(flag)}(?![\\w-])((?:,\\s*-[\\w-]+)*)([^\\n]*)`)
  const m = re.exec(helpText)
  if (!m) return 'boolean'
  // Only a metavar BEFORE the description column counts. Two spaces or a tab
  // start the description in every help format we target, so a `<file>` in
  // prose ("same as --output <file>") is not mistaken for this flag's own.
  const head = m[2].split(/ {2,}|\t/)[0]
  if (/^[ =]*<[^>]+>/.test(head)) return 'required'
  if (/^[ =]*\[[^\]]+\]/.test(head)) return 'optional'
  return 'boolean'
}
