/**
 * #8151 round-2 review (Critical 1) — a standalone child-process script that
 * constructs the REAL ClaudeTuiSession or UserShellSession (no
 * `_ptyModOverride` test seam at all) and calls its real `start()`, so the
 * PRODUCTION `ptyMod = await import('node-pty')` line actually runs.
 *
 * Invoked by `node-pty-production-import.test.js` via `execFileSync` with
 * two `--import` hooks ahead of this file on the command line:
 *   1. `../_setup.mjs` — the same sandboxed test runner every other server
 *      test uses (fs write sandbox + CHROXY_CONFIG_DIR redirect), per the
 *      review's explicit requirement that this exercise "never touch real
 *      user state".
 *   2. `reject-node-pty-import.mjs` — a `node:module` resolve hook that
 *      makes `import('node-pty')` reject, simulating the official Docker
 *      image's missing native build (no linux prebuild).
 *
 * Usage: `node --import <setup> --import <hook> production-pty-import-child.mjs <claude-tui|user-shell>`
 *
 * Prints ONE line of JSON to stdout — `{ code, message }` from the rejected
 * `start()` — and always exits 0 (the parent test asserts on the JSON, not
 * the exit code; a non-zero exit would mean this harness script itself blew
 * up, which is reported separately via stderr passthrough).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2]
if (target !== 'claude-tui' && target !== 'user-shell') {
  console.error(`unknown target: ${target}`)
  process.exit(2)
}

async function main() {
  if (target === 'claude-tui') {
    const { ClaudeTuiSession } = await import('../../src/claude-tui-session.js')
    const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-skills-prodimport-'))
    try {
      // #8223: this child is a REAL process outside the parent's real-binary
      // tripwire, and `_spawnPty` now runs the pre-spawn `claude auth status`
      // probe before the node-pty import. Left to its default it would exec the
      // developer's real `claude` under the fake HOME, read "logged out", and
      // reject with AUTH_REQUIRED before ever reaching the import this harness
      // exists to exercise. A runner that fails keeps the probe fail-open and
      // hermetic: nothing real is launched, and start() proceeds to the import.
      const session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12353, skillsDir, repoSkillsDir: null,
        loginProbeRunner: async () => { throw new Error('login probe disabled in this fixture') },
      })
      session.on('error', () => {
        // _spawnPty's catch also emits — start()'s rejection (below) is what
        // this harness reports; an unhandled 'error' event would otherwise
        // crash this child process before that rejection is ever read.
      })
      try {
        await session.start()
        console.log(JSON.stringify({ unexpectedSuccess: true }))
      } catch (err) {
        console.log(JSON.stringify({ code: err.code, message: err.message }))
      }
    } finally {
      rmSync(skillsDir, { recursive: true, force: true })
    }
    return
  }

  const { UserShellSession } = await import('../../src/user-shell-session.js')
  const session = new UserShellSession({ cwd: '/tmp' })
  try {
    await session.start()
    console.log(JSON.stringify({ unexpectedSuccess: true }))
  } catch (err) {
    console.log(JSON.stringify({ code: err.code, message: err.message }))
  }
}

await main()
