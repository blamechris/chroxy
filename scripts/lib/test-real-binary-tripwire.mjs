// test-real-binary-tripwire.mjs — #8096: catches a test that reaches a REAL,
// host-installed `cloudflared`/`claude`/`codex`/`gemini` instead of a fixture.
//
// The #8096 investigation found pre-existing tests that resolved, hashed and
// exec'd the developer's REAL `cloudflared` (cloudflare-provenance.test.js's
// #6937 spawn tests) and the REAL `cloudflared`/`claude` (doctor-binary-
// provenance*.test.js) — not because anyone intended it, but because a bare
// PATH-resolved name or a fixed well-known install path (`/opt/homebrew/bin/…`)
// is indistinguishable from a fixture at the call site unless something checks.
// Fixing the three known call sites (#8096 items 1-3) closes the doors found
// so far; this module is the backstop so the NEXT one goes red immediately,
// legibly, instead of quietly shelling out to the host again.
//
// ── What this guards ─────────────────────────────────────────────────────
//
// A `child_process` launcher call whose resolved command is:
//   - a BARE name (no path separator — resolved via the OS's own PATH search,
//     exactly how `resolveBinary()`/`_spawnCloudflared()` fall back) matching
//     one of GUARDED_BASENAMES, OR
//   - an ABSOLUTE (or otherwise separator-containing) path whose basename
//     matches GUARDED_BASENAMES AND which sits under a real package-manager
//     install prefix (REAL_INSTALL_PREFIXES) — a fixture written under
//     `os.tmpdir()`/the repo's own scratch dirs never matches a prefix here,
//     so `makeGateShim()`-style fixtures (named e.g. `gate-shim.mjs`, not
//     `cloudflared`/`claude`/…) are untouched regardless of where they live,
//     and a REAL binary under a fixture-shaped tmp path (never happens in
//     practice, but matters for the "narrow" contract) is untouched too.
//
// `node`, `git`, `sh`, `which`, `where`, `xattr`, etc. are never in
// GUARDED_BASENAMES, so ordinary test plumbing (a spawned `node` fixture
// script, `resolveBinary()`'s own `which`/`where` probe, a throwaway git repo)
// is unaffected regardless of its resolved path — this is deliberately NOT a
// blanket "tests may never touch child_process" guard; see docs/false-safety-
// guards.md and this repo's own CLAUDE.md ("every guard must be proven to
// fail") for why a guard that is too broad is exactly as unproven as one that
// is too narrow until something demonstrates the boundary.
//
// ── Bypass ───────────────────────────────────────────────────────────────
//
// `process.env.CHROXY_TEST_ALLOW_REAL_BINARY === '1'` disables the guard
// entirely, for the rare test that deliberately, knowingly exercises a real
// provider binary. Two existing files set it themselves, right where they
// already decide a real spawn is intentional:
//   - `tests/tunnel.integration.test.js` — opt-in `CHROXY_TEST_REAL_CLOUDFLARED=1`
//     (#8096 item 3).
//   - `tests/integration/codex-spawn-argv.integration.test.js` — a PRE-EXISTING,
//     deliberate real-`codex` integration test (#3873) that auto-detects a
//     locally-installed `codex` and runs against it with no env var required.
//     Its own resolved `CODEX_BIN` is an absolute path under
//     `/opt/homebrew/bin` on a Homebrew host, which — absent this — would trip
//     the SAME guard this file installs for an already-reviewed, intentional
//     integration test outside this issue's scope. It sets the flag itself,
//     once, right after computing `SHOULD_RUN`.
// Nothing else in this repo's test suite is known to legitimately need it as
// of #8096 — the full suite ran clean under this guard with normal PATH once
// those two call sites were accounted for (see the PR for the two-run proof).
//
// ── #7262-style import rule ──────────────────────────────────────────────
//
// Same rule as `test-spawn-home-sandbox.mjs` (which this module also
// imports SPAWN_LAUNCHERS from — a plain string array, not `child_process`
// itself, so importing it does not link the synthetic ESM module early):
// this file must not ESM-import `node:child_process`, or ANYTHING that
// transitively does, ahead of the patch below. `node:module`, `node:os` and
// `node:path` are safe — none of them import `child_process`.

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { SPAWN_LAUNCHERS, findOptionsIndex } from './test-spawn-home-sandbox.mjs'

const require = createRequire(import.meta.url)

/** Marks a patched function so a test can enumerate what was ACTUALLY installed. */
export const REAL_BINARY_MARKER = Symbol.for('chroxy.testRealBinaryTripwire')

export const REAL_BINARY_ERROR_CODE = 'CHROXY_TEST_REAL_BINARY'

/**
 * Binary basenames this guard cares about. Deliberately the small,
 * security-sensitive set `verify-binary.js`'s own docblock names as "external
 * provider binaries chroxy execs, resolved off PATH": `claude`, `codex`,
 * `gemini`, plus `cloudflared` (folded into the same provenance gate since
 * #6858). NOT a stand-in for "every executable" — see the module docblock.
 */
export const GUARDED_BASENAMES = new Set(['cloudflared', 'claude', 'codex', 'gemini'])

/**
 * Real, host-wide package-manager / installer locations. Matches the set
 * `verify-provenance.js`'s package-tree classifier and this repo's
 * `CLAUDE_BINARY_CANDIDATES`/`CLOUDFLARED_CANDIDATES` fixed-path lists already
 * treat as "a real install", so this guard's idea of "real" tracks the
 * production code's, not a separate guess.
 */
export const REAL_INSTALL_PREFIXES = Object.freeze([
  '/opt/homebrew/',
  '/usr/local/',
  join(homedir(), '.local') + sep,
  join(homedir(), '.npm-global') + sep,
  join(homedir(), '.bun') + sep,
  join(homedir(), '.volta') + sep,
  join(homedir(), 'Library', 'pnpm') + sep,
])

/** `true` when `cmd` has no path separator — resolved via the OS's PATH search. */
function isBareName(cmd) {
  return !cmd.includes('/') && !cmd.includes('\\')
}

// Windows npm shims/native installers append an extension the bare
// GUARDED_BASENAMES entries don't carry (`claude.cmd`, `cloudflared.exe`).
// Stripped case-insensitively before comparison so the guard's coverage
// doesn't quietly stop at the platform this module was written on.
const EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']
function stripExeExtension(name) {
  const lower = name.toLowerCase()
  for (const ext of EXECUTABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return name.slice(0, name.length - ext.length)
  }
  return name
}

/**
 * `exec`/`execSync` take a single SHELL COMMAND STRING (`'which cloudflared'`),
 * not a `(file, args)` pair — every other launcher's first argument IS the
 * command/file/modulePath directly. This is a best-effort first-token split
 * (whitespace, with a leading matched quote stripped), sufficient for the
 * plain `'cmd arg arg'` shape every call site in this repo actually uses; it
 * is not a shell-grammar parser and does not need to be one to cover the
 * calls this guard exists for — see the module docblock.
 */
function firstShellToken(cmdString) {
  const trimmed = cmdString.trim()
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1)
    if (end > 0) return trimmed.slice(1, end)
  }
  const spaceIdx = trimmed.search(/\s/)
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
}

/**
 * Extract "the command this call would resolve/exec", one per launcher shape:
 *   - spawn/spawnSync/execFile/execFileSync/fork: args[0] IS the file/module.
 *   - exec/execSync: args[0] is a shell command STRING; see firstShellToken.
 * Returns null when args[0] isn't a usable string (malformed call — let the
 * real function's own validation report that; not this guard's job).
 */
function resolveCommandArg(launcherName, args) {
  const first = args[0]
  if (typeof first !== 'string' || first.length === 0) return null
  if (launcherName === 'exec' || launcherName === 'execSync') return firstShellToken(first)
  return first
}

/**
 * The `PATH` a launcher call would ACTUALLY resolve a bare command name
 * against: the call's own `options.env.PATH` when it passed one (an explicit
 * `env` always replaces, never merges with, `process.env` — see
 * `resolveEffectivePath`'s doc), else this process's own `process.env.PATH`.
 * Reuses `findOptionsIndex` from `test-spawn-home-sandbox.mjs` rather than a
 * second "which arg is options" parser (same reasoning that module gives for
 * exporting it).
 */
function resolveEffectivePath(args) {
  const optIndex = findOptionsIndex(args)
  const options = optIndex === -1 ? undefined : args[optIndex]
  const env = options && options.env
  if (env && typeof env === 'object') return env.PATH
  return process.env.PATH
}

/**
 * `true` when `cmd` is a guarded real binary per the module docblock's rule,
 * IGNORING PATH — a pure name/path-shape check. `guard()` below additionally
 * consults `resolveEffectivePath` for the bare-name case: a bare name whose
 * call scoped PATH to empty (or omitted it from a replacement `env`) can never
 * resolve to anything, real or otherwise, so it is not flagged even though its
 * NAME matches — see `cloudflare-provenance.test.js`'s #6937 tests, which
 * deliberately spawn bare `cloudflared` with `env: { PATH: '' }` specifically
 * so the OS can't find the real one (#8096 fix 1); this function alone can't
 * tell that call apart from the mutant that reverts it (dropping the empty
 * PATH so a real ambient PATH resolves it again), which is exactly why that
 * distinction lives in `guard()`, where the call's actual args are in hand.
 */
export function isGuardedRealBinary(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return false
  const base = stripExeExtension(basename(cmd)).toLowerCase()
  if (!GUARDED_BASENAMES.has(base)) return false
  if (isBareName(cmd)) return true
  return REAL_INSTALL_PREFIXES.some((prefix) => cmd.startsWith(prefix))
}

/**
 * Install the tripwire on the live `node:child_process` CJS exports object.
 * Safe to install alongside (before or after) `installSpawnHomeSandbox` —
 * each layer wraps whatever `cp[name]` currently is and calls through to it,
 * so the two compose regardless of install order.
 *
 * @param {object} [opts]
 * @param {string} [opts.allowEnv] Env var name whose value `'1'` disables the
 *   guard entirely. Defaults to `CHROXY_TEST_ALLOW_REAL_BINARY`.
 * @returns {{installed: string[], skipped: Array<{name: string, reason: string}>}}
 */
export function installRealBinaryTripwire({ allowEnv = 'CHROXY_TEST_ALLOW_REAL_BINARY' } = {}) {
  const cp = require('node:child_process')

  function makeError(launcherName, cmd) {
    const err = new Error(
      `[chroxy-test-real-binary] BLOCKED ${launcherName}(${JSON.stringify(cmd)}) — this call would ` +
      `resolve/exec a REAL, host-installed provider binary (or cloudflared) instead of a fixture (#8096).\n` +
      `  Point this test at a fixture (a fake, always-present absolute path, or a scoped-empty PATH plus\n` +
      `  empty candidates so resolution can never fall through to a real install), or set\n` +
      `  process.env.${allowEnv} = '1' if a real binary is genuinely, deliberately intended here.\n` +
      `  See scripts/lib/test-real-binary-tripwire.mjs and issue #8096.`,
    )
    err.code = REAL_BINARY_ERROR_CODE
    return err
  }

  function wrap(launcherName, original) {
    const guard = (args) => {
      if (process.env[allowEnv] === '1') return null
      const cmd = resolveCommandArg(launcherName, args)
      if (cmd === null) return null
      if (!isGuardedRealBinary(cmd)) return null
      // A guarded BARE name is only a live risk if the effective PATH this
      // exact call would search is non-empty — an empty (or absent-from-a-
      // replacement-env) PATH means the OS's own search can't find ANYTHING,
      // real binary or not, so flagging it would punish the fix (#8096 fix 1's
      // `env: { PATH: '' }`) instead of the defect. An absolute path under a
      // real install prefix has no such out: it names a specific file on disk
      // regardless of PATH, so it is always flagged.
      if (isBareName(cmd)) {
        const effectivePath = resolveEffectivePath(args)
        if (!(typeof effectivePath === 'string' && effectivePath.length > 0)) return null
      }
      return cmd
    }

    const patched = function guardedLauncher(...args) {
      const hit = guard(args)
      if (hit !== null) throw makeError(launcherName, hit)
      return original.apply(this, args)
    }

    // Same reasoning as `installSpawnHomeSandbox`: `exec`/`execFile` carry a
    // custom `util.promisify.custom` in Node itself, and this repo's
    // production code relies on the `{ stdout, stderr }` promisified shape
    // (`src/control-room/*`, session-pr-status.js). Preserve it, routed
    // through `patched` (not `original`) so a promisified call is guarded too.
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

    // Forward any OTHER marker symbol `original` already carries (this repo's
    // `installSpawnHomeSandbox`'s `SPAWN_HOME_MARKER`, most concretely) onto
    // `patched`. This module composes on top of the spawn-home sandbox — each
    // layer wraps whatever `cp[name]` currently is — and without this,
    // `setup-spawn-home-sandbox.test.js`'s own "every guarded launcher
    // actually carries the sandbox marker on the LIVE module" coverage test
    // goes red the moment this tripwire installs on top of it: the live
    // `cp[name]` is then THIS module's `patched` function, which never had
    // `SPAWN_HOME_MARKER` set on it directly (only the function it CLOSES
    // OVER does), so a plain `cp[name][SPAWN_HOME_MARKER]` lookup no longer
    // finds it — the mark is real but invisible from outside the closure.
    // Skips symbols already set above (`REAL_BINARY_MARKER`, `promisify.custom`)
    // so this can never clobber either.
    for (const sym of Object.getOwnPropertySymbols(original)) {
      if (!(sym in patched)) patched[sym] = original[sym]
    }

    return patched
  }

  const installed = []
  const skipped = []

  for (const name of SPAWN_LAUNCHERS) {
    const original = cp[name]
    if (typeof original !== 'function') {
      skipped.push({ name, reason: 'absent' })
      continue
    }
    if (original[REAL_BINARY_MARKER]) {
      skipped.push({ name, reason: 'already-guarded' })
      continue
    }
    const patched = wrap(name, original)
    patched[REAL_BINARY_MARKER] = name
    cp[name] = patched
    installed.push(name)
  }

  return { installed, skipped }
}
