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
 * The guard monkey-patches the write-side of `fs` (sync + promises): any
 * call whose resolved path falls under the real `~/.chroxy/` or `~/.claude/`
 * throws `CHROXY_TEST_SANDBOX` with a stack trace pointing at the caller.
 * Read-side fs calls are untouched, so tests that legitimately *read* the
 * developer's real config (e.g. provider detection in
 * `providers.test.js`) keep working.
 *
 * We deliberately do NOT override `process.env.HOME` globally. Several
 * existing tests pass real `homedir()` / `process.cwd()` paths to
 * validation helpers (`validateCwdAllowed`, `listFiles` home-fallback,
 * environment manager workspaceRoots) that compare against the live
 * `os.homedir()`. Rerouting HOME up-front breaks those tests in a way
 * that's unrelated to the bug class we're fixing. A bare
 * `new SessionManager()` is still caught — its first `writeFileSync` for
 * the default `~/.chroxy/session-state.json` trips the guard.
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
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// CRITICAL: Patch `node:fs` via the CJS object obtained from `createRequire`,
// NOT via an ESM default import. ESM `import fs from 'node:fs'` returns a
// Module Namespace Exotic Object whose property writes do NOT propagate to
// later `import { writeFileSync } from 'node:fs'` consumers — those bindings
// are snapshotted at link-time from the CJS module's original exports.
// `createRequire('node:fs')` gives us the live CJS `module.exports`; any
// production code that does `import { writeFileSync } from 'fs'` then sees
// our patched value because the ESM named exports are derived from this same
// object at link time. This must run BEFORE any other module imports `node:fs`
// — Node's `--import` flag in `package.json` enforces that ordering.
const require = createRequire(import.meta.url)
const fs = require('node:fs')

// --- Redirect CHROXY_CONFIG_DIR to a per-process tmp dir ----------------------
// Production helpers (models.js, connection-info.js, checkpoint-manager.js)
// already honour `CHROXY_CONFIG_DIR`. Pointing it at a tmp dir up-front means
// every code path that defaults to `~/.chroxy/...` lands in the tmp dir
// instead — no per-test plumbing required, no real-home writes possible.
// Tests that explicitly need to override it (e.g. supervisor.test.js) can
// still set it in their own beforeEach and restore in afterEach — Node's
// env reads are dynamic.
if (!process.env.CHROXY_CONFIG_DIR) {
  process.env.CHROXY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'chroxy-test-cfg-'))
}

// --- Capture the real home for the guard --------------------------------------
const REAL_HOME = homedir()
const PROTECTED_ROOTS = [
  resolve(REAL_HOME, '.chroxy') + sep,
  resolve(REAL_HOME, '.claude') + sep,
]
// Also guard the bare files (e.g. `~/.claude.json` from byok-mcp-config)
// because they live next to the dirs we protect.
const PROTECTED_FILES = new Set([
  resolve(REAL_HOME, '.claude.json'),
])

// --- Sandbox guard ------------------------------------------------------------
function isProtected(rawPath) {
  if (process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES === '1') return false
  if (typeof rawPath !== 'string' && !(rawPath instanceof URL) && !(rawPath instanceof Buffer)) {
    return false
  }
  let p
  try {
    // `fileURLToPath` handles cross-platform quirks (Windows `file:///C:/...`
    // yields `C:\...`, percent-encoded segments are decoded). Falling back to
    // `.pathname` would leave a leading slash on Windows and break comparison
    // against `os.homedir()`-derived paths.
    if (rawPath instanceof URL) p = fileURLToPath(rawPath)
    else if (rawPath instanceof Buffer) p = rawPath.toString('utf8')
    else p = rawPath
    p = resolve(p)
  } catch {
    return false
  }
  if (PROTECTED_FILES.has(p)) return true
  for (const root of PROTECTED_ROOTS) {
    if (p === root.slice(0, -1) || p.startsWith(root)) return true
  }
  return false
}

function makeGuardError(method, target) {
  const err = new Error(
    `[chroxy-test-sandbox] BLOCKED ${method} to real user-state path: ${target}\n` +
    `  This test attempted to write to (or move from/to) the developer's actual ~/.chroxy or ~/.claude tree.\n` +
    `  Pass a temp path explicitly (e.g. stateFilePath: tmpStateFile()) or set\n` +
    `  process.env.CHROXY_TEST_ALLOW_REAL_HOME_WRITES = '1' if the write is intentional.\n` +
    `  See packages/server/tests/_setup.mjs and issue #4633.`,
  )
  err.code = 'CHROXY_TEST_SANDBOX'
  return err
}

const origWriteFileSync = fs.writeFileSync
fs.writeFileSync = function patchedWriteFileSync(target, ...rest) {
  if (isProtected(target)) throw makeGuardError('writeFileSync', String(target))
  return origWriteFileSync.call(this, target, ...rest)
}

const origAppendFileSync = fs.appendFileSync
fs.appendFileSync = function patchedAppendFileSync(target, ...rest) {
  if (isProtected(target)) throw makeGuardError('appendFileSync', String(target))
  return origAppendFileSync.call(this, target, ...rest)
}

const origRenameSync = fs.renameSync
fs.renameSync = function patchedRenameSync(oldPath, newPath) {
  // Check BOTH paths: a `renameSync('~/.chroxy/session-state.json', '/tmp/x')`
  // would silently relocate real user state without tripping a newPath-only
  // guard. The whole point of the sandbox is to prevent that.
  if (isProtected(oldPath) || isProtected(newPath)) {
    throw makeGuardError('renameSync', `${String(oldPath)} -> ${String(newPath)}`)
  }
  return origRenameSync.call(this, oldPath, newPath)
}

const origMkdirSync = fs.mkdirSync
fs.mkdirSync = function patchedMkdirSync(target, ...rest) {
  // Blocks any new directory under the real ~/.chroxy or ~/.claude. The
  // top-level dirs themselves (PROTECTED_ROOTS) already exist, so a
  // `mkdirSync('~/.chroxy', { recursive: true })` no-ops in practice —
  // but we still flag it to surface unexpected callers in tests.
  if (isProtected(target)) throw makeGuardError('mkdirSync', String(target))
  return origMkdirSync.call(this, target, ...rest)
}

const origCreateWriteStream = fs.createWriteStream
fs.createWriteStream = function patchedCreateWriteStream(target, ...rest) {
  if (isProtected(target)) throw makeGuardError('createWriteStream', String(target))
  return origCreateWriteStream.call(this, target, ...rest)
}

const origOpenSync = fs.openSync
fs.openSync = function patchedOpenSync(target, flags, ...rest) {
  // `flags` can be a string ('w', 'a', 'wx', 'w+', 'a+', 'ax') or a number
  // (constants OR'd together: O_WRONLY=1, O_RDWR=2, O_CREAT=64, O_APPEND=1024…).
  // We only block when the open is for writing; pure reads are fine.
  let isWrite = false
  if (typeof flags === 'string') {
    isWrite = /[wa+]/.test(flags)
  } else if (typeof flags === 'number') {
    // O_WRONLY = 1, O_RDWR = 2, O_CREAT = 64, O_APPEND = 1024, O_TRUNC = 512
    isWrite = (flags & 1) !== 0 || (flags & 2) !== 0 || (flags & 64) !== 0
  }
  if (isWrite && isProtected(target)) throw makeGuardError('openSync', String(target))
  return origOpenSync.call(this, target, flags, ...rest)
}

if (fs.promises) {
  const origWriteFile = fs.promises.writeFile
  fs.promises.writeFile = function patchedWriteFile(target, ...rest) {
    if (isProtected(target)) return Promise.reject(makeGuardError('promises.writeFile', String(target)))
    return origWriteFile.call(this, target, ...rest)
  }

  const origAppendFile = fs.promises.appendFile
  fs.promises.appendFile = function patchedAppendFile(target, ...rest) {
    if (isProtected(target)) return Promise.reject(makeGuardError('promises.appendFile', String(target)))
    return origAppendFile.call(this, target, ...rest)
  }

  const origRename = fs.promises.rename
  fs.promises.rename = function patchedRename(oldPath, newPath) {
    // Mirror the sync guard: a rename OUT of ~/.chroxy is still data loss.
    if (isProtected(oldPath) || isProtected(newPath)) {
      return Promise.reject(makeGuardError('promises.rename', `${String(oldPath)} -> ${String(newPath)}`))
    }
    return origRename.call(this, oldPath, newPath)
  }

  const origMkdir = fs.promises.mkdir
  fs.promises.mkdir = function patchedMkdir(target, ...rest) {
    if (isProtected(target)) return Promise.reject(makeGuardError('promises.mkdir', String(target)))
    return origMkdir.call(this, target, ...rest)
  }

  const origOpen = fs.promises.open
  fs.promises.open = function patchedOpen(target, flags, ...rest) {
    let isWrite = false
    if (typeof flags === 'string') isWrite = /[wa+]/.test(flags)
    else if (typeof flags === 'number') isWrite = (flags & 1) !== 0 || (flags & 2) !== 0 || (flags & 64) !== 0
    if (isWrite && isProtected(target)) {
      return Promise.reject(makeGuardError('promises.open', String(target)))
    }
    return origOpen.call(this, target, flags, ...rest)
  }
}

// --- Default the credential-store to "no keychain" ----------------------------
// #5154: the credential store encrypts credentials.json with an OS-keychain
// data key when a keychain is available. On a developer's macOS box that means
// tests would shell out to `security` and pollute the REAL login keychain — the
// keychain analogue of the #4633 home-write contamination the fs guard above
// blocks. Set the escape-hatch env so every server test exercises the
// plaintext-0600 fallback (deterministic on every host, zero real-keychain
// access). credential-store reads this lazily at call time, so — unlike
// importing the module here — it does NOT pull keychain.js into the graph early
// and therefore does not defeat `mock.module('child_process')` in the keychain
// unit tests. The encryption suite injects an in-memory keychain via
// `_setCredentialKeychainForTests(...)`, which takes precedence over this flag.
process.env.CHROXY_CRED_DISABLE_KEYCHAIN = '1'

// --- Diagnostic ---------------------------------------------------------------
// Quiet by default; set CHROXY_TEST_SANDBOX_DEBUG=1 to see the protected
// paths once per process.
if (process.env.CHROXY_TEST_SANDBOX_DEBUG === '1') {
  console.error(`[chroxy-test-sandbox] guarded write paths under: ${REAL_HOME}/.chroxy, ${REAL_HOME}/.claude`)
}
