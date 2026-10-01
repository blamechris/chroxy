/**
 * #8151 round-2 review (Critical 1) — a `node:module` `registerHooks`
 * resolve hook that makes `import('node-pty')` reject, for real, in a real
 * child process.
 *
 * The round-2 review found that the existing C4 tests
 * (claude-tui-session.test.js / user-shell-session.test.js) only exercised
 * the TEST-ONLY `_ptyModOverride` function branch — the PRODUCTION branch
 * (the literal `ptyMod = await import('node-pty')` line `lint-argv-sinks.mjs`
 * recognises) was never actually made to fail. Reverting only that
 * production catch left 2229 tests green, proving the coverage gap.
 *
 * This hook is loaded via `--import` (see
 * `production-pty-import-child.mjs`), ahead of the child's own module graph,
 * so the REAL dynamic `import('node-pty')` inside claude-tui-session.js /
 * user-shell-session.js goes through this resolve hook and rejects exactly
 * the way it would on a host with no node-pty native binding — without
 * mocking `_ptyModOverride` at all.
 *
 * Deliberately narrow: only the `node-pty` specifier is intercepted, so
 * every other import in the child process (including `tests/_setup.mjs`'s
 * own sandbox machinery, loaded via a separate `--import` ahead of this one)
 * resolves normally.
 */
import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'

// Optional: when set, append one line per resolve() call for 'node-pty' —
// lets a test prove how many times resolution was actually attempted
// (e.g. node-pty-probe.js's "probe once, cache the boolean" contract).
const countFile = process.env.PTY_RESOLVE_COUNT_FILE

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node-pty') {
      if (countFile) appendFileSync(countFile, '.')
      throw new Error('Cannot find module \'/app/node_modules/node-pty/build/Release/pty.node\' (simulated by reject-node-pty-import.mjs)')
    }
    return nextResolve(specifier, context)
  },
})
