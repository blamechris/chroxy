// utils/win-spawn.js — Windows-safe child_process spawning for batch shims.
//
// Background (#windows-native): when the binary resolver lands on a `.cmd`/`.bat`
// shim — e.g. an npm-global `claude.cmd` on a host with no native `claude.exe` —
// `child_process.spawn(cmd, args)` is BROKEN on Windows two different ways:
//
//   1. Node 24's CVE-2024-27980 fix makes spawning a `.cmd`/`.bat` WITHOUT a
//      shell throw `EINVAL` outright.
//   2. `{ shell: true }` with an args array concatenates argv WITHOUT quoting
//      (DEP0190), so any argument containing a space or shell metacharacter is
//      corrupted. claude's `--append-system-prompt <text>` is full of both, so
//      this is not a theoretical edge — it silently mangles the system prompt.
//
// node-pty does NOT share this problem (it routes through conpty / cmd.exe
// internally and runs a `.cmd` fine — verified), so ClaudeTuiSession's PTY spawn
// needs no wrapping. This helper exists only for the plain-subprocess providers
// (cli-session.js and its DockerSession subclass).
//
// The `.cmd`/`.bat` escaping is the battle-tested cmd.exe algorithm popularised
// by `cross-spawn` (https://qntm.org/cmd), which npm itself relies on. Each token
// is wrapped and its embedded quotes/backslashes fixed for the target program's
// CommandLineToArgvW parse, then cmd metacharacters are escaped — DOUBLED for a
// `.cmd`/`.bat`, because the npm shim forwards `%*` through a SECOND cmd parse
// before the real program sees the bytes. win-spawn.test.js round-trips
// adversarial args (embedded quotes, `& % ^ < > !`, trailing/embedded
// backslashes) through a realistic `%*`-forwarding shim to prove fidelity.
//
// On POSIX, and for a directly-runnable `.exe`/`.com` on Windows, the command +
// args pass through unchanged.

// cmd.exe metacharacters that must be caret-escaped when not inside the program's
// own quoting. (Same set cross-spawn uses.)
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/**
 * True if `command` is a Windows batch shim (`.cmd`/`.bat`) — the only forms that
 * need cmd.exe routing on the child_process path.
 * @param {string} command
 * @returns {boolean}
 */
export function isBatchShim(command) {
  return typeof command === 'string' && /\.(?:cmd|bat)$/i.test(command)
}

function escapeCommand(command) {
  return command.replace(CMD_META, '^$1')
}

function escapeArgument(arg, doubleEscapeMeta) {
  let a = `${arg}`
  // Sequences of backslashes followed by a `"`: double the backslashes and
  // escape the quote (CommandLineToArgvW rules).
  a = a.replace(/(\\*)"/g, '$1$1\\"')
  // A trailing run of backslashes would escape our own closing quote — double it.
  a = a.replace(/(\\*)$/, '$1$1')
  a = `"${a}"`
  // Escape cmd metacharacters (including the wrapping quotes just added).
  a = a.replace(CMD_META, '^$1')
  // A `.cmd`/`.bat` is parsed by cmd TWICE (the `/c` line, then the shim's `%*`
  // expansion), so metacharacters need a second escaping pass to survive both.
  if (doubleEscapeMeta) a = a.replace(CMD_META, '^$1')
  return a
}

/**
 * Adapt a (command, args) pair for `child_process.spawn` on the current
 * platform. On Windows, a `.cmd`/`.bat` command is rewritten to run under
 * `cmd.exe /d /s /c "<escaped command line>"` with `windowsVerbatimArguments`
 * so Node does not re-quote our already-escaped line. Everything else is
 * returned verbatim.
 *
 * Usage:
 *   const { command, args, options } = prepareSpawn(CLAUDE, argv)
 *   spawn(command, args, { ...baseOptions, ...options })
 *
 * @param {string}   command
 * @param {string[]} [args]
 * @param {object}   [opts]
 * @param {NodeJS.Platform} [opts.platform=process.platform] - override for tests
 * @returns {{ command: string, args: string[], options: object }}
 */
export function prepareSpawn(command, args = [], { platform = process.platform } = {}) {
  if (platform !== 'win32' || !isBatchShim(command)) {
    return { command, args, options: {} }
  }
  const comspec = process.env.COMSPEC || 'cmd.exe'
  const line = [escapeCommand(command), ...args.map((a) => escapeArgument(a, true))].join(' ')
  return {
    command: comspec,
    // `/d` skips AutoRun, `/s` makes cmd strip exactly the single outer quote
    // pair (so our inner quoting is preserved verbatim), `/c` runs then exits.
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  }
}
