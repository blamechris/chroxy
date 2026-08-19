/**
 * Server test setup — enforces isolation from the developer's real user state
 * (`~/.chroxy/`, `~/.claude/`). Loaded once per test process via Node's
 * `--import` flag (wired in `package.json` test scripts).
 *
 * See issue #4633 and `feedback_test_state_contamination.md`. The 2026-05-30
 * incident clobbered the user's live `~/.chroxy/session-state.json` with
 * test fixture data because individual tests forgot to pass a temp
 * `stateFilePath`. This file installs a sandbox guard that throws the
 * moment any test attempts to write to the real `~/.chroxy/` or `~/.claude/`
 * trees, so the next forgetter fails LOUDLY at the offending call site
 * instead of silently corrupting the developer's live state 76 days later.
 *
 * The guard monkey-patches every `fs` function that takes a PATH and mutates
 * the filesystem: any call whose resolved path falls under the real
 * `~/.chroxy/` or `~/.claude/` throws `CHROXY_TEST_SANDBOX` with a stack trace
 * pointing at the caller. It is a CATEGORY now, not a list (#7267) — 61 methods
 * across the sync, callback and `promises` surfaces, all expanded from the one
 * table in `scripts/lib/test-fs-sandbox.mjs`, which
 * `packages/claude-hooks/tests/_setup.mjs` installs from too.
 *
 * It was a hand-written list until #7267, and the list was the bug. Measured
 * under this harness before that change, these reached the real tree
 * unimpeded: `unlinkSync` (52 call sites under `src/`, more than `openSync`),
 * `rmSync`, `rmdirSync`, `cpSync`, `copyFileSync`, `symlinkSync`, `linkSync`,
 * `chmodSync`, the whole `promises` half of the same, and — worst — the entire
 * CALLBACK surface including plain `fs.writeFile(path, data, cb)`. `cpSync`
 * does not merely bypass the guard: it creates the destination's parent
 * directories, so a probe aimed at a NON-EXISTENT path under `~/.chroxy` left a
 * real directory in the developer's live config dir. `truncateSync` read as
 * covered, but only incidentally — it opens with `r+` and tripped `openSync`.
 *
 * "Category" is enforced, not asserted: `FS_EXEMPTIONS` in the shared module
 * classifies every remaining `fs` function with a reason, and
 * `tests/setup-sandbox-binding-forms.test.js` fails if their union stops
 * covering the live `fs` surface. A Node upgrade that adds a path-taking
 * mutator turns the suite red instead of quietly widening the hole.
 *
 * Read-side fs calls are untouched by design, so tests that legitimately
 * *read* the developer's real config (e.g. provider detection in
 * `providers.test.js`) keep working.
 *
 * We deliberately do NOT override `process.env.HOME` globally. Several
 * existing tests pass real `homedir()` / `process.cwd()` paths to
 * validation helpers (`validateCwdAllowed`, `listFiles` home-fallback,
 * environment manager workspaceRoots) that compare against the live
 * `os.homedir()`. Rerouting HOME up-front breaks those tests in a way
 * that's unrelated to the bug class we're fixing.
 *
 * NOTE (#7052): this block used to add "a bare `new SessionManager()` is still
 * caught — its first `writeFileSync` for the default
 * `~/.chroxy/session-state.json` trips the guard". That is no longer true, and
 * saying so would be a false-safety claim. `defaultStateFile()` is now
 * `configPath('session-state.json')`, which follows the CHROXY_CONFIG_DIR
 * redirect installed below, so the write lands in this process's tmp dir and
 * the guard never fires. The same applies to binary-trust.json, checkpoints and
 * the permission rules. The OUTCOME is still safe — those writes go to a temp
 * directory, not the developer's home — but this guard no longer NAMES the
 * offending test. `scripts/lint-tests-state-file-path.sh` is now the check that
 * catches a missing `stateFilePath`, and it reports the call site.
 *
 * Tests that need to mutate `process.env.HOME` for their own purposes
 * (e.g. `claude-tui-session.test.js`, `byok-credentials.test.js`) are fine
 * — the guard locks onto the *real* home recorded at process startup, not
 * whatever HOME currently is.
 *
 * Opt-out for the rare test that legitimately needs to write to the real
 * home (none expected): set `process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = '1'`
 * scoped to the test, then restore.
 */

import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { installFsWriteSandbox } from '../../../scripts/lib/test-fs-sandbox.mjs'

// CRITICAL: Patch `node:fs` via the CJS object obtained from `createRequire`,
// NOT via an ESM default import. ESM `import fs from 'node:fs'` returns a
// Module Namespace Exotic Object whose property writes do NOT propagate to
// later `import { writeFileSync } from 'node:fs'` consumers.
// `createRequire('node:fs')` gives us the live CJS `module.exports` — the
// object the default import also resolves to, so patching it covers both.
//
// Named and namespace importers (`import { writeFileSync } from 'fs'`,
// `import * as fs from 'fs'`) are covered for a DIFFERENT and more fragile
// reason: Node builds the `node:fs` synthetic ESM module LAZILY, snapshotting
// its named exports off `module.exports` the first time some ESM module
// imports it. As long as that first link happens AFTER this file's body runs,
// the snapshot is taken from the already-patched object and every binding form
// sees the guard. Node's `--import` flag orders this file ahead of the test's
// own graph, which is what makes that hold.
//
// #7262: NOTHING EVALUATED BEFORE THIS FILE'S BODY MAY ESM-IMPORT `node:fs`.
// In practice that means this file must not import it — but the condition is
// wider than this file, and stating it as "never import fs here" would be too
// narrow: a transitive import through any module this file pulls in, or an
// earlier `--import` hook, disarms the guard identically. This file's ONE local
// import — `scripts/lib/test-fs-sandbox.mjs` — is held to the same rule and
// reaches `fs` through its own `createRequire`; every further import added here
// inherits the obligation, transitively.
//
// ESM imports are evaluated before the module body, so a single
// `import { mkdtempSync } from 'node:fs'` up top links the synthetic module
// against the UNPATCHED exports — and named/namespace consumers (45 modules
// under `src/` at the time of writing) silently bypass the sandbox while it
// still reports success for CJS and default importers. That line lived here
// for months. Take what you need off the `fs` object below instead — the tmp
// config dir is created with `fs.mkdtempSync` for exactly this reason. The same
// applies to `node:fs/promises`: it is a
// separate synthetic module with the same lazy-link behaviour, and importing
// it here disarms the promises half (measured).
//
// The rule extends to `scripts/lib/test-fs-sandbox.mjs`, imported below: it is
// linked as part of THIS file's graph, so an ESM `node:fs` import there would
// disarm the sandbox identically. It reaches `fs` through its own
// `createRequire` for that reason, and the structural check in
// `tests/setup-sandbox-binding-forms.test.js` walks the graph rather than
// trusting either comment.
//
// `tests/setup-sandbox-binding-forms.test.js` pins every binding form
// behaviourally and fails if any of this is undone.
const require = createRequire(import.meta.url)
const fs = require('node:fs')

// --- Capture the real home and arm the guard ---------------------------------
// Order matters: the guard is installed BEFORE the tmp config dir is created,
// so even this bootstrap's own `mkdtempSync` runs through it. `homedir()` is
// read here, at process startup, and the guard locks onto THAT — tests that
// mutate `process.env.HOME` for their own purposes (`claude-tui-session.test.js`,
// `byok-credentials.test.js`) neither widen nor narrow it.
const REAL_HOME = homedir()

export const { installed: SANDBOX_INSTALLED, skipped: SANDBOX_SKIPPED } = installFsWriteSandbox({
  protectedRoots: [resolve(REAL_HOME, '.chroxy'), resolve(REAL_HOME, '.claude')],
  // Bare files that live NEXT TO the protected dirs (`~/.claude.json` from
  // byok-mcp-config) rather than inside them.
  protectedFiles: [resolve(REAL_HOME, '.claude.json')],
  allowEnv: 'CHROXY_TEST_ALLOW_REAL_HOME_WRITES',
  message: (method, target) =>
    `[chroxy-test-sandbox] BLOCKED ${method} to real user-state path: ${target}\n` +
    `  This test attempted to write to (or move from/to) the developer's actual ~/.chroxy or ~/.claude tree.\n` +
    `  Pass a temp path explicitly (e.g. stateFilePath: tmpStateFile()) or set\n` +
    `  process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = '1' if the write is intentional.\n` +
    `  See packages/server/tests/_setup.mjs and issue #4633.`,
})

// --- Redirect CHROXY_CONFIG_DIR to a per-process tmp dir ----------------------
// Production helpers (models.js, connection-info.js, checkpoint-manager.js)
// already honour `CHROXY_CONFIG_DIR`. Pointing it at a tmp dir up-front means
// every code path that defaults to `~/.chroxy/...` lands in the tmp dir
// instead — no per-test plumbing required, no real-home writes possible.
// Tests that explicitly need to override it (e.g. supervisor.test.js) can
// still set it in their own beforeEach and restore in afterEach — Node's
// env reads are dynamic.
if (!process.env.CHROXY_CONFIG_DIR) {
  process.env.CHROXY_CONFIG_DIR = fs.mkdtempSync(join(tmpdir(), 'chroxy-test-cfg-'))
}

// --- Default the credential-store to "no keychain" ----------------------------
// #5154: the credential store encrypts credentials.json with an OS-keychain
// data key when a keychain is available. On a developer's macOS box that means
// tests would shell out to `security` and pollute the REAL login keychain — the
// keychain analogue of the #4633 home-write contamination the fs guard above
// blocks. Set the escape-hatch env so every server test exercises the
// plaintext-0600 fallback (deterministic on every host, zero real-keychain
// access). Critically, this bootstrap sets an ENV flag rather than importing
// credential-store/keychain: it must NOT pull `keychain.js` into the module
// graph, or `keychain-mock.test.js` could no longer `mock.module('child_process')`
// before it imports keychain. credential-store reads this flag lazily at call
// time. The encryption suite injects an in-memory keychain via
// `_setCredentialKeychainForTests(...)`, which takes precedence over this flag.
process.env.CHROXY_CRED_DISABLE_KEYCHAIN = '1'

// --- Default the api-token keychain (keychain.js) to "no keychain" ------------
// Sibling of the credential-store flag above, for the OTHER keychain consumer:
// `keychain.js` stores the daemon api-token under service 'chroxy' / account
// 'api-token' by shelling out to the real `security`/`secret-tool`. That path is
// NOT covered by CHROXY_CRED_DISABLE_KEYCHAIN. Without this flag, any test that
// exercises keychain.js (or boots server-cli, which migrates the token on
// startup) shells out to the REAL OS keychain — polluting it, and on a developer
// box with a broken login keychain popping a modal "a keychain cannot be found
// to store 'api-token'" prompt for EVERY access (the user had to Cancel a dozen+
// on 2026-06-16). keychain.js reads this flag lazily, so the two tests that
// genuinely drive its code path opt back in: keychain.test.js (real round-trip,
// only under CHROXY_TEST_REAL_KEYCHAIN=1) and keychain-mock.test.js (mocked
// child_process — never touches the real keychain). See
// `server_suite_real_keychain_prompts.md`.
process.env.CHROXY_DISABLE_KEYCHAIN = '1'

// --- Scrub Discord webhook env -------------------------------------------------
// #5413: PushManager always registers a DiscordWebhookSink that activates the
// moment a webhook URL resolves. A developer with the webhook exported in
// their shell would otherwise have every PushManager-touching test posting to
// their REAL Discord channel — the network analogue of the home-write
// contamination above.
//
// Set a syntactically INVALID sentinel instead of deleting (#5427 review S1):
// the resolver short-circuits on any non-empty env value, so the sentinel
// also stops the fallthrough to the developer's real
// ~/.chroxy/credentials.json `discordWebhookUrl` — which would configure a
// LIVE sink in every PushManager test and let `_persistState` swallow the
// #4633 sandbox-guard throw on the real-home state write. `_configuredUrl()`
// rejects the sentinel shape, so the sink reads as unconfigured everywhere.
// Tests that exercise the env path set the var themselves in beforeEach and
// restore it after.
process.env.CHROXY_DISCORD_WEBHOOK_URL = 'invalid://chroxy-test-scrub-not-a-webhook'

// --- Diagnostic ---------------------------------------------------------------
// Quiet by default; set CHROXY_TEST_SANDBOX_DEBUG=1 to see the protected
// paths once per process.
if (process.env.CHROXY_TEST_SANDBOX_DEBUG === '1') {
  console.error(`[chroxy-test-sandbox] guarded write paths under: ${REAL_HOME}/.chroxy, ${REAL_HOME}/.claude`)
}
