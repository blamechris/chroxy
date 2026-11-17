// test-pty-home-sandbox.mjs — the node-pty sibling of test-spawn-home-sandbox.mjs
// (#7949).
//
// #7946's spawn-home sandbox patches `node:child_process`. node-pty is a native
// addon with its own `spawn` that never goes through `child_process`, so a real
// node-pty spawn (`claude-tui-session.js` runs the real `claude` TUI,
// `user-shell-session.js` runs the user's `$SHELL`) would hand the developer's
// REAL home to the child, outside both that sandbox and the in-process fs guard.
// No test spawns a real PTY today; this closes the gap before one does.
//
// Approach: REDIRECT (not throw), the same decision as the child_process
// sandbox, and by the same function — `computeOverrideEnv` is imported from
// there, so the two cannot disagree about what "carries the real home" means
// (HOME and USERPROFILE, provider config-dir vars scrubbed, an already-isolated
// env respected, the CHROXY_TEST_ALLOW_REAL_HOME_WRITES escape hatch honoured).
// A throw would make the first legitimate PTY integration test fail for a
// reason its author did not cause; a redirect lets it run, safely.
//
// ── How the patch reaches every import shape ────────────────────────────────
// The source loads node-pty with `await import('node-pty')` (both call sites),
// and node-pty is CJS. Whatever the shape — dynamic `import()`, a static
// default/named import, or `createRequire(...)('node-pty')` — Node's loader
// ends in `Module._load('node-pty')`. This hooks `Module._load` and, the first
// time node-pty's entry point comes back, replaces `spawn`/`fork`/`createTerminal`
// on its (one) `module.exports`. ESM named/default bindings read that same
// object after `_load` returns, so they see the patch. It is a hook rather than
// an eager `require('node-pty')` so a process that never touches node-pty never
// loads the native addon, and so an environment without it (Docker
// `--ignore-scripts`, or a `node:module` resolve hook simulating that, as
// node-pty-production-import.test.js does) behaves exactly as without the
// sandbox.
//
// Not covered: reaching past the entry point (`require('node-pty/lib/unixTerminal')`
// and constructing `UnixTerminal` directly). Nothing in src/ does that.
//
// Same #7262 rule as the sibling: only `node:module` is imported (via
// createRequire); no ESM import of anything the sandbox patches.

import { createRequire } from 'node:module'
import { computeOverrideEnv } from './test-spawn-home-sandbox.mjs'

const require = createRequire(import.meta.url)
const Module = require('node:module')

export const PTY_HOME_MARKER = Symbol.for('chroxy.testPtyHomeSandbox')
export const PTY_LAUNCHERS = ['spawn', 'fork', 'createTerminal']

const NODE_PTY_ENTRY = /[\\/]node-pty[\\/]lib[\\/]index\.js$/

function isNodePtyEntry(request, parent) {
  if (typeof request !== 'string' || !request.includes('node-pty')) return false
  try {
    return NODE_PTY_ENTRY.test(Module._resolveFilename(request, parent))
  } catch {
    return false
  }
}

/**
 * @param {object} opts
 * @param {string} opts.realHome
 * @param {string} opts.isolatedHome
 * @param {string} [opts.allowEnv]
 * @returns {{patched: () => string[]}} names patched so far (empty until node-pty is first loaded)
 */
export function installPtyHomeSandbox({ realHome, isolatedHome, allowEnv }) {
  const patchedNames = []

  function patchExports(exp) {
    for (const name of PTY_LAUNCHERS) {
      const original = exp[name]
      if (typeof original !== 'function' || original[PTY_HOME_MARKER]) continue
      const guarded = function guardedPtySpawn(file, args, opt) {
        const overrideEnv = computeOverrideEnv({
          realHome,
          isolatedHome,
          allowEnv,
          existingEnv: opt ? opt.env : undefined,
        })
        if (overrideEnv === null) return original.call(this, file, args, opt)
        return original.call(this, file, args, { ...opt, env: overrideEnv })
      }
      guarded[PTY_HOME_MARKER] = name
      exp[name] = guarded
      patchedNames.push(name)
    }
  }

  if (!Module._load[PTY_HOME_MARKER]) {
    const originalLoad = Module._load
    const hooked = function chroxyPtyHomeLoad(request, parent, ...rest) {
      const exp = originalLoad.call(this, request, parent, ...rest)
      if (exp && typeof exp === 'object' && isNodePtyEntry(request, parent)) patchExports(exp)
      return exp
    }
    hooked[PTY_HOME_MARKER] = true
    Module._load = hooked
  }

  return { patched: () => patchedNames.slice() }
}
