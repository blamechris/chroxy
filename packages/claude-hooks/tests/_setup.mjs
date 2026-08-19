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
 * `rmSync`/`unlinkSync` that the server did not; the server patched `openSync`,
 * `appendFileSync`, `chmodSync` and four `promises` methods that this file did
 * not.
 *
 * The `openSync` gap was LATENT, not reachable through `installHooks` — and the
 * distinction matters, because #7268 originally claimed otherwise and the claim
 * was wrong. `installer.js` writes atomically as
 * `mkdirSync -> openSync -> writeSync -> fsyncSync -> chmodSync -> renameSync`,
 * and `mkdirSync` WAS on this file's list, so the sequence aborted at step one.
 * Measured against a fake protected home with exactly the old list installed:
 * the guard fired once, on `mkdirSync`, and no directory, temp file or partial
 * write was produced. `openSync` was covered the way `truncateSync` was covered
 * on the server side — by accident, through a neighbour — which is precisely the
 * kind of coverage #7267 replaces with the deliberate kind.
 *
 * The error shape was the half that HAD already cost something: these threw a
 * plain `Error` with the token only in the message and no `code`, so a caller
 * matching `err.code` — including a probe written against the server's
 * convention — read a FIRED guard as an unrelated failure. That produced a
 * false "unguarded" reading during the #7266 review.
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
 * guard identically. It uses `createRequire` for that reason.
 *
 * The STRUCTURAL check on that rule lives only in the server package
 * (`setup-sandbox-binding-forms.test.js`), which walks the shared module — the
 * file both packages depend on. There is deliberately none here, and this file
 * is therefore the one residual edge: reaching the server's comment stripper
 * from this package would couple two packages' test trees to buy a better error
 * message. What catches a regression here instead is behavioural — every probe
 * in `tests/sandbox.test.js` fails at once — and that suite's failure message
 * names this cause explicitly.
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

export const {
  installed: SANDBOX_INSTALLED,
  skipped: SANDBOX_SKIPPED,
  isProtected: SANDBOX_IS_PROTECTED,
} = installFsWriteSandbox({
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
