// test-spawn-home-sandbox.mjs — redirect a SPAWNED child's view of home away
// from the developer's real `~/.claude` / `~/.gemini` / `~/.codex`, for the
// packages/server test suite.
//
// #7269: the in-process fs write sandbox (`test-fs-sandbox.mjs`, #4633/#7267)
// is a monkey-patch of THIS process's `node:fs` — it stops at the process
// boundary. The server suite spawns real provider binaries (or, in tests,
// stand-ins for them — `process.execPath` resolved in place of `claude`, a
// `node` script standing in for `codex`/`gemini`), and those child processes
// inherit the REAL `HOME` by default and can write into the developer's
// actual `~/.claude`/`~/.gemini`/`~/.codex` the instant they start, completely
// outside the fs guard's reach. Same #4633 harm, arriving by a route the fs
// sandbox structurally cannot cover (issue #7269, provenance: adversarial
// review of #7266).
//
// ── Why this is a SPAWN-time patch, not a `process.env.HOME` reassignment ───
//
// `_setup.mjs` deliberately does NOT override `process.env.HOME` for the test
// process itself, and #7269's own "Suggested fix" section says exactly why:
// several existing tests pass real `homedir()` / `process.env.HOME` to
// validation helpers that compare against the live `os.homedir()`
// (`validateCwdAllowed`, the `listFiles` home-fallback, environment-manager
// `workspaceRoots`) — rerouting HOME process-wide breaks those in a way
// unrelated to the bug class being fixed here. "This needs to be per-spawn,
// not process-wide" is the issue's own words.
//
// So this sandbox never touches `process.env.HOME`. It patches the live
// `node:child_process` CJS exports (spawn/spawnSync/exec/execSync/execFile/
// execFileSync/fork) so that, for each individual call, IF the env that call
// is about to hand a real child would carry the developer's REAL home, the
// env actually passed to the OS is substituted for one pointing at an
// isolated per-process temp dir instead — for that one child only. A test
// that already isolated its own HOME on purpose (`withEnv({ HOME: ... })`
// before calling a pure `_buildChildEnv()`/`buildSpawnEnv()` helper, or the
// `CHROXY_<PROVIDER>_HOME`-style auth-probe fixtures) is left alone, because
// none of those go through a real `child_process` launcher at all — and even
// the ones that do (an explicit non-real HOME in `options.env`) are treated as
// intentional and passed through untouched.
//
// ── Same #7262 rule as test-fs-sandbox.mjs ──────────────────────────────────
//
// This module MUST NOT ESM-import `node:child_process` (or the bare
// `'child_process'` specifier). Node lazily snapshots a built-in module's named
// ESM exports off its CJS `module.exports` the first time anything in the
// graph links it; an ESM import anywhere AHEAD of this module's patch takes
// that snapshot from the UNPATCHED object, and every named/namespace importer
// — which is most of `src/` (`import { spawn } from 'child_process'`,
// `import { execFileSync } from 'node:child_process'`) — silently bypasses the
// guard while default/CJS importers still see it patched. `createRequire`
// reaches the live CJS `module.exports` directly, without linking the
// synthetic ESM module, so patching happens before any snapshot could be
// taken — exactly the reasoning `test-fs-sandbox.mjs` documents for `node:fs`.
// This file's only imports are `node:module` and `node:util` (for
// `promisify.custom`, read as a property — `util` itself never touches
// `child_process`); neither pulls in anything that imports `child_process`.

import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)

/** Marks a patched function so a test can enumerate what was ACTUALLY installed. */
export const SPAWN_HOME_MARKER = Symbol.for('chroxy.testSpawnHomeSandbox')

/**
 * Every `child_process` export that can launch a real OS process. A category,
 * not a hand list that can quietly stop covering the module —
 * `SPAWN_EXEMPTIONS` below classifies everything else, and
 * `setup-spawn-home-sandbox.test.js` asserts the union covers the live
 * `node:child_process` surface exactly, the same shape `test-fs-sandbox.mjs`
 * uses for `fs` (docs/false-safety-guards.md's #1 recurring cause: "a
 * hardcoded list next to a set that grows").
 */
export const SPAWN_LAUNCHERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']

/**
 * The complement: every other function-valued export of `node:child_process`,
 * with the reason it needs no guard.
 */
export const SPAWN_EXEMPTIONS = {
  // The class instances the launchers above return; not itself a way to start
  // a process (`new ChildProcess()` still needs `.spawn()` called on it, which
  // is a private/internal API — zero call sites in this repo).
  ChildProcess: 'class',
  // Internal bootstrap hook a FORKED CHILD calls on itself to wire up IPC — it
  // does not launch anything; it runs a inside the already-spawned child.
  _forkChild: 'internal',
}

// Provider CLIs honour their OWN config-dir override, distinct from this
// repo's `CHROXY_<PROVIDER>_HOME` (which only steers auth-probes.js's own
// reads — see docs/troubleshooting and the provider-oauth-test-isolation
// memory). Nothing in this repo's own `buildSpawnEnv()`/`_buildChildEnv()`
// ever sets these (checked: zero call sites), so the only way one reaches a
// spawned child is an operator's shell exporting it directly. Scrubbed
// whenever HOME is being redirected, so a developer's real
// `CLAUDE_CONFIG_DIR`/`CODEX_HOME` export can't bypass the HOME-based
// isolation.
const PROVIDER_CONFIG_DIR_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CONFIG_DIR']

/**
 * Which argument in a `child_process` launcher call is the `options` object,
 * if any. Every one of spawn/spawnSync/exec/execSync/execFile/execFileSync/
 * fork takes AT MOST one plain-object argument (`options`) — the
 * command/file/modulePath is a string, `args` (when present) is an array, and
 * a trailing `callback` (exec/execFile's async form) is a function — so
 * scanning for "the one non-null, non-array, non-function object argument"
 * finds it without hand-coding each function's own arg position, which is
 * what keeps this a category rather than seven bespoke parsers.
 */
function findOptionsIndex(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a !== null && typeof a === 'object' && !Array.isArray(a)) return i
  }
  return -1
}

/** Where to insert a NEW options object when the call passed none at all. */
function insertionIndex(args) {
  const last = args[args.length - 1]
  // A trailing callback (exec/execFile's async form) means an inserted
  // options object goes immediately BEFORE it — `exec(cmd, cb)` becomes
  // `exec(cmd, options, cb)`, never `exec(cmd, cb, options)`.
  return typeof last === 'function' ? args.length - 1 : args.length
}

/**
 * Compute the env a launcher call should actually use, or `null` when no
 * redirect is needed (either the escape hatch is active, or the caller
 * already isolated BOTH `HOME` and `USERPROFILE` on their own).
 */
function computeOverrideEnv({ realHome, isolatedHome, allowEnv, existingEnv }) {
  if (allowEnv && process.env[allowEnv] === '1') return null
  const source = existingEnv || process.env
  const effectiveHome = source.HOME
  // #7946 review: checking HOME alone is not enough to conclude "the caller
  // already isolated this". A test that does `process.env.HOME = fakeHome`
  // (the pattern every HOME-reassigning test in this repo uses — see
  // auth-probes.test.js, claude-tui-session.test.js, byok-*.test.js) only
  // ever touches HOME, never USERPROFILE. A later spawn with NO explicit
  // `options.env` inherits `process.env` as-is: HOME now reads as
  // "already isolated" (a string, not realHome) so the ORIGINAL check
  // returned `null` here and skipped the redirect entirely — leaving
  // `USERPROFILE` (still the real, untouched value from `process.env`) to
  // reach the child unredirected. `os.homedir()` reads USERPROFILE, not
  // HOME, on win32, so that child's homedir() — and any real CLI's own
  // `%USERPROFILE%`-based config-dir resolution — would still resolve to the
  // developer's REAL Windows profile despite this guard reporting "already
  // isolated, nothing to do".
  const effectiveUserProfile = source.USERPROFILE
  const homeLooksIsolated = typeof effectiveHome === 'string' && effectiveHome !== realHome
  const userProfileStillReal = effectiveUserProfile === realHome
  if (homeLooksIsolated && userProfileStillReal) {
    // The caller isolated HOME but USERPROFILE is still the ambient real
    // value, which is every `{ ...process.env, HOME: x }` spawn on win32 CI.
    // Keep the caller's HOME and point USERPROFILE at it: replacing both
    // with the sandbox dir clobbers the caller's own isolation, and leaving
    // USERPROFILE alone leaks the real profile to os.homedir() on win32.
    const next = { ...source }
    next.USERPROFILE = effectiveHome
    return next
  }
  if (homeLooksIsolated) {
    // The caller already pointed this env somewhere that is not the real
    // home — a provider-auth fixture, `withEnv({ HOME: tmp })`, or a test
    // exercising its OWN isolation — and USERPROFILE isn't silently still
    // real either. Respect it.
    return null
  }
  const next = existingEnv ? { ...existingEnv } : { ...process.env }
  next.HOME = isolatedHome
  // Windows resolves `os.homedir()` from `USERPROFILE`, not `HOME`. Setting it
  // unconditionally is harmless on POSIX (an extra env var nothing reads) and
  // is what makes the redirect effective on `Server Windows Tests`, a required
  // check.
  next.USERPROFILE = isolatedHome
  for (const key of PROVIDER_CONFIG_DIR_VARS) delete next[key]
  return next
}

/**
 * Install the sandbox on the live `node:child_process` CJS exports object.
 *
 * @param {object} opts
 * @param {string} opts.realHome  The developer's actual home dir, captured
 *   BEFORE anything (this module included) could have redirected it — the
 *   same `REAL_HOME` the fs sandbox in `_setup.mjs` already captures for its
 *   own `protectedRoots`.
 * @param {string} opts.isolatedHome  Where a redirected child should land.
 * @param {string} [opts.allowEnv]  Same escape hatch as the fs sandbox: `'1'`
 *   disables the redirect for a test that genuinely needs the real home.
 * @returns {{installed: string[], skipped: Array<{name: string, reason: string}>}}
 */
export function installSpawnHomeSandbox({ realHome, isolatedHome, allowEnv }) {
  const cp = require('node:child_process')

  function wrap(original) {
    const patched = function guardedLauncher(...args) {
      const optIndex = findOptionsIndex(args)
      const existingOptions = optIndex === -1 ? undefined : args[optIndex]
      const overrideEnv = computeOverrideEnv({
        realHome,
        isolatedHome,
        allowEnv,
        existingEnv: existingOptions ? existingOptions.env : undefined,
      })
      if (overrideEnv === null) return original.apply(this, args)

      const nextArgs = args.slice()
      if (optIndex === -1) {
        const at = insertionIndex(args)
        nextArgs.splice(at, 0, { env: overrideEnv })
      } else {
        nextArgs[optIndex] = { ...existingOptions, env: overrideEnv }
      }
      return original.apply(this, nextArgs)
    }

    // `exec`/`execFile` are the only two launchers Node itself gives a custom
    // `util.promisify.custom` (production code in this repo relies on it —
    // `promisify(execFile)` all over `src/control-room/*` and
    // `session-pr-status.js`/`session-pr-threads.js`). Overwriting the module
    // property with a plain function drops that symbol, so `promisify(...)`
    // would fall back to generic promisify semantics — resolving with the bare
    // `stdout` value instead of `{ stdout, stderr }` — silently breaking every
    // one of those call sites' `const { stdout } = await execFileAsync(...)`.
    // Define our OWN custom-promisify that calls back through `patched` (not
    // `original`), so a promisified call still gets the HOME redirect.
    if (original[promisify.custom]) {
      patched[promisify.custom] = function guardedPromisified(...args) {
        return new Promise((resolvePromise, rejectPromise) => {
          patched.call(this, ...args, (err, stdout, stderr) => {
            if (err) {
              if (stdout !== undefined) err.stdout = stdout
              if (stderr !== undefined) err.stderr = stderr
              rejectPromise(err)
            } else {
              resolvePromise({ stdout, stderr })
            }
          })
        })
      }
    }

    return patched
  }

  const installed = []
  const skipped = []

  for (const name of SPAWN_LAUNCHERS) {
    const original = cp[name]
    if (typeof original !== 'function') {
      // None of these are conditionally present on any platform this repo
      // targets today, but the same "skip absent, don't assume present" shape
      // as the fs sandbox costs nothing and keeps the two guards consistent.
      skipped.push({ name, reason: 'absent' })
      continue
    }
    if (original[SPAWN_HOME_MARKER]) {
      skipped.push({ name, reason: 'already-guarded' })
      continue
    }
    const patched = wrap(original)
    patched[SPAWN_HOME_MARKER] = name
    cp[name] = patched
    installed.push(name)
  }

  return { installed, skipped }
}
