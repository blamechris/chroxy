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
 * @param {{ cmd: string, args?: string[], containerCliPath: string }} spec
 * @returns {{ cmd: string, args: string[], remapped: boolean }}
 */
export function remapClaudeSpawn({ cmd, args = [], containerCliPath }) {
  const viaNode = JS_CLI_RE.test(containerCliPath)

  if (isNativeClaudeCommand(cmd)) {
    return viaNode
      ? { cmd: 'node', args: [containerCliPath, ...args], remapped: true }
      : { cmd: containerCliPath, args: [...args], remapped: true }
  }

  if (typeof args[0] === 'string' && args[0].includes('@anthropic-ai/claude-code/cli.js')) {
    // Old JS shape: swap the host script for the container's claude.
    return viaNode
      ? { cmd, args: [containerCliPath, ...args.slice(1)], remapped: true }
      : { cmd: containerCliPath, args: args.slice(1), remapped: true }
  }

  return { cmd, args: [...args], remapped: false }
}
