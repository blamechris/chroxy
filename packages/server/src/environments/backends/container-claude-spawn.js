import { normalize } from 'path'

const JS_CLI_RE = /\.(?:c|m)?js$/i

/**
 * Is `p` the path of a claude executable (native binary), judged by its
 * basename on either path flavour? The SDK's own platform binary is named
 * `claude` (`claude.exe` on Windows), and so is the `claude` we pin through
 * `pathToClaudeCodeExecutable` (#7986).
 */
function isNativeClaudeCommand(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  const base = p.split(/[\\/]/).pop()
  return base === 'claude' || base === 'claude.exe'
}

const CLAUDE_CLI_JS_SUFFIX = '@anthropic-ai/claude-code/cli.js'

/**
 * Is `p` the claude-code cli.js? Separators are normalised first so a Windows
 * host path matches, and the path must END with the package's cli.js (a mere
 * substring elsewhere in an argument does not count), or equal the pinned path.
 */
function isClaudeJsScript(p, pinned) {
  if (typeof p !== 'string' || p.length === 0) return false
  if (isPinnedPath(p, pinned)) return true
  const norm = p.replace(/\\/g, '/')
  return norm === CLAUDE_CLI_JS_SUFFIX || norm.endsWith('/' + CLAUDE_CLI_JS_SUFFIX)
}

function isPinnedPath(cmd, pinned) {
  if (typeof cmd !== 'string' || cmd.length === 0) return false
  if (typeof pinned !== 'string' || pinned.length === 0) return false
  return normalize(cmd) === normalize(pinned)
}

/**
 * Map the SDK's spawn request for the claude CLI onto what the container can
 * exec (#8027). The SDK hands `spawnClaudeCodeProcess({ command, args })` HOST
 * paths, in one of two shapes:
 *
 *   - JS cli (old): `command` = `node`, `args[0]` = `<host>/@anthropic-ai/claude-code/cli.js`
 *   - native: `command` = absolute host path to a `claude` binary (a darwin
 *     Mach-O on a Mac, which a Linux container cannot exec), `args[0]` = a flag
 *
 * Both must run the container's own claude (`containerCliPath`), keeping every
 * other arg. The claude spawn is identified positively (the native shape by the
 * basename of `command`; the JS shape by `args[0]` naming the claude-code
 * cli.js), so any other command passes through untouched. The result does not
 * depend on how the host path is shaped, which is the point.
 *
 * A `containerCliPath` ending in .js/.mjs/.cjs is the npm-installed cli.js and
 * is run via `node`; any other path is itself the container's claude executable.
 *
 * `hostClaudePath` is the pinned host executable the caller gave the SDK as
 * `pathToClaudeCodeExecutable`; a `cmd` equal to it (after normalisation) is the
 * claude spawn whatever its basename (`claude.cmd`, a versioned file, ...).
 *
 * @param {{ cmd: string, args?: string[], containerCliPath: string, hostClaudePath?: string }} spec
 * @returns {{ cmd: string, args: string[], remapped: boolean }}
 */
export function remapClaudeSpawn({ cmd, args = [], containerCliPath, hostClaudePath }) {
  const viaNode = JS_CLI_RE.test(containerCliPath)

  if (isNativeClaudeCommand(cmd) || isPinnedPath(cmd, hostClaudePath)) {
    return viaNode
      ? { cmd: 'node', args: [containerCliPath, ...args], remapped: true }
      : { cmd: containerCliPath, args: [...args], remapped: true }
  }

  if (isClaudeJsScript(args[0], hostClaudePath)) {
    // JS shape (`node|bun <host cli.js> ...`): drop the host runtime and script
    // and run the container's claude, via node when it is a JS file.
    return viaNode
      ? { cmd: 'node', args: [containerCliPath, ...args.slice(1)], remapped: true }
      : { cmd: containerCliPath, args: args.slice(1), remapped: true }
  }

  return { cmd, args: [...args], remapped: false }
}
