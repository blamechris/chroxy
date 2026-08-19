/**
 * Test sandbox for @chroxy/claude-hooks (same intent as
 * packages/server/tests/_setup.mjs, #4633): tests must NEVER read from or
 * write to the real ~/.chroxy or ~/.claude trees.
 *
 * Two layers:
 *   1. temp HOME — `os.homedir()` follows $HOME, so default-path code
 *      (defaultSettingsPath, configDir) resolves into a throwaway dir
 *   2. write guard — every path-taking `fs` mutator throws CHROXY_TEST_SANDBOX
 *      if anything still targets the REAL home's .chroxy/.claude (belt and
 *      braces against env leaking out of a spawned process)
 *
 * ── #7268: this used to be a SECOND, narrower guard ─────────────────────────
 *
 * Layer 2 was a hand-written list here and a different hand-written list in the
 * server's `_setup.mjs`, and they drifted in both directions. This file patched
 * `rmSync`/`unlinkSync` that the server did not; the server patched
 * `openSync`, `appendFileSync` and four `promises` methods that this file did
 * not. `openSync` was the load-bearing omission: `installer.js` writes
 * atomically as `openSync -> writeSync -> fsyncSync -> renameSync`, so only the
 * final `renameSync` was intercepted and a partial write that never reached the
 * rename went straight to the real `~/.claude`. The errors also carried no
 * `code`, only a message prefix, so a caller matching `err.code` — including a
 * probe written against the server's convention — read a FIRED guard as an
 * unrelated failure.
 *
 * Both halves are gone: the list, the installer and the error shape all come
 * from `scripts/lib/test-fs-sandbox.mjs` now, which is the same code the server
 * installs. Divergence is no longer something anyone has to remember.
 *
 * ── #7262: reach `node:fs` through `createRequire`, NEVER an ESM import ─────
 *
 * This file previously opened with `import fs from 'node:fs'` plus
 * `import { mkdtempSync } from 'node:fs'`. Both are ESM imports, and ESM
 * imports are evaluated before the module body — which links the `node:fs`
 * synthetic module and snapshots its named exports off the UNPATCHED
 * `module.exports`. The patches then landed on an object that named and
 * namespace importers no longer read, so the guard covered exactly two of the
 * four binding forms:
 *
 *   require / default import  -> guarded      namespace / named import -> NOT
 *
 * Measured on this package before the fix, writing to the real `~/.chroxy`:
 * cjs GUARDED, default GUARDED, namespace ENOENT, named ENOENT. The default
 * import was the patch TARGET and still did not save the other two, because
 * linking is what does the damage, not which form you patch.
 *
 * The rule now covers `scripts/lib/test-fs-sandbox.mjs` too — it is linked as
 * part of this file's graph, so an ESM `node:fs` import there would disarm the
 * guard identically. It uses `createRequire` for that reason, and
 * `tests/sandbox.test.js` walks the graph rather than trusting this comment.
 */

import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

import { installFsWriteSandbox } from '../../../scripts/lib/test-fs-sandbox.mjs'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

// Captured BEFORE layer 1 relocates HOME — the guard must lock onto the
// developer's actual home, not the throwaway one.
const REAL_HOME = homedir()

export const { installed: SANDBOX_INSTALLED, skipped: SANDBOX_SKIPPED } = installFsWriteSandbox({
  protectedRoots: [resolve(REAL_HOME, '.chroxy'), resolve(REAL_HOME, '.claude')],
  protectedFiles: [resolve(REAL_HOME, '.claude.json')],
  // Same opt-out name the server uses, so one escape hatch is documented once.
  // Nothing in this package's suite needs it except its own probe cleanup,
  // which has to delete under the protected root to prove nothing leaked.
  allowEnv: 'CHROXY_TEST_ALLOW_REAL_HOME_WRITES',
  message: (method, target) =>
    `CHROXY_TEST_SANDBOX: ${method} to real user state blocked: ${target}\n` +
    `Tests must use temp paths (env overrides) — see tests/_setup.mjs`,
})

// Layer 1: relocate HOME before any test module resolves default paths.
const SANDBOX_HOME = fs.mkdtempSync(join(tmpdir(), 'chroxy-hooks-home-'))
process.env.HOME = SANDBOX_HOME
process.env.USERPROFILE = SANDBOX_HOME
