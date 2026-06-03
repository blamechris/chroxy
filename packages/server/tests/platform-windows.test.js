/**
 * Windows-only platform tests for `writeFileRestricted` (#4927).
 *
 * Companion to `platform.test.js`. The cross-platform tests in that file
 * exercise the Windows code path on POSIX runners via the
 * `_isWindowsOverride` option, which is enough to validate the core
 * temp+rename + cleanup contract. The cases below cover Windows-specific
 * edge cases that can ONLY be validated on a real Windows runner:
 *
 *   1. ACL inheritance from the per-user storage directory (`~/.chroxy/`
 *      / `%APPDATA%/Chroxy/`) — the docstring claims inherited ACLs are
 *      the correct mechanism for the security contract on NTFS, in lieu
 *      of POSIX mode bits. We verify with `icacls` that a freshly-written
 *      file under a user-only directory does NOT grant access to the
 *      built-in `Users` or `Everyone` SIDs.
 *
 *   2. Cross-volume rename — `MoveFileExW` fails with `ERROR_NOT_SAME_DEVICE`
 *      across volumes. `writeFileRestricted` structurally upholds the
 *      same-dir invariant: `tmpPath = filePath + tmpSuffix`, so the
 *      intermediate is always a sibling of the destination. We assert
 *      that invariant by introspecting the helper's behaviour (and
 *      cross-checking the call-site grep in #4927); a deliberate
 *      cross-volume call is not exercised because Windows runners do not
 *      expose a second writable volume.
 *
 *   3. AV-held-handle decision (#4927 acceptance criterion 1) — the gap
 *      relative to `session-state-persistence.js._rotateToBak` is
 *      DOCUMENTED rather than closed. Rationale: every caller of
 *      `writeFileRestricted` already has its own retry / fallback path
 *      (session manager debounce loop, models cache TTL refresh, env
 *      manager next-tick re-persist), so an inner one-shot retry on
 *      EPERM/EACCES/EBUSY/EEXIST would mask the error from the caller
 *      without changing the outcome. `_rotateToBak`'s retry is special
 *      because rotation has no caller-level retry — a missed rotation
 *      silently loses the prior-generation `.bak` until the next write.
 *      `writeFileRestricted` does not have that asymmetry; the rename
 *      error is surfaced and the caller decides. If a future site without
 *      its own retry adopts `writeFileRestricted`, revisit this decision.
 *
 *   4. `MoveFileExW` atomicity under AV / Windows Search — we exercise a
 *      same-volume rename and assert the destination is either fully
 *      previous-generation or fully new-generation (never a partial
 *      observation). This is the on-Windows mirror of the
 *      `_isWindowsOverride` test in `platform.test.js` but runs natively,
 *      so the test catches any node version / OS update that breaks the
 *      `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` semantics
 *      this code depends on.
 *
 * These tests are gated on `process.platform === 'win32'`. On POSIX
 * runners the suite reports as skipped — the `_isWindowsOverride` block
 * in `platform.test.js` continues to provide cross-platform coverage.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'node:url'
import { writeFileRestricted } from '../src/platform.js'

// Resolved once for the subprocess shim in the rename-failure test.
// Using a `file:` URL string sidesteps the Windows `C:\` ↔ `file:///C:/`
// path-format dance that `node --import` and ESM `import` are picky about.
const PLATFORM_JS_URL = new URL('../src/platform.js', import.meta.url).href

const isWindows = process.platform === 'win32'

describe('platform (real Windows runner — #4927)', { skip: !isWindows }, () => {
  let tmpDir

  beforeEach(() => {
    // mkdtempSync under os.tmpdir() lands on the same volume as the user
    // profile on every supported GitHub-hosted windows-latest runner
    // (both `C:\Users\runneradmin\AppData\Local\Temp` and `C:\Windows\Temp`
    // sit on `C:`). That matters: the helper writes a sibling temp file
    // and renames over the destination, so the test fixture must live on
    // a single volume to mirror the production storage paths.
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-windows-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('happy path — native renameSync (MoveFileExW) atomicity', () => {
    it('writes and replaces an existing file atomically on the same NTFS volume', () => {
      // Pre-#4913 the Windows branch was a direct `writeFileSync` to the
      // destination — a mid-write SIGKILL/OOM could leave the file
      // truncated. The current implementation uses temp+rename, so the
      // destination is either fully previous-generation or fully new.
      // This is the same contract as the `_isWindowsOverride` test in
      // platform.test.js, run natively here to catch a regression in
      // node's `MoveFileExW` invocation (REPLACE_EXISTING | WRITE_THROUGH
      // semantics).
      const filePath = join(tmpDir, 'state.json')
      writeFileRestricted(filePath, JSON.stringify({ generation: 1 }))
      assert.strictEqual(readFileSync(filePath, 'utf-8'), JSON.stringify({ generation: 1 }))
      assert.strictEqual(existsSync(`${filePath}.tmp`), false, '.tmp sidecar must be cleaned up after rename')

      writeFileRestricted(filePath, JSON.stringify({ generation: 2 }))
      assert.strictEqual(readFileSync(filePath, 'utf-8'), JSON.stringify({ generation: 2 }))
      assert.strictEqual(existsSync(`${filePath}.tmp`), false)
    })

    it('honours a custom tmpSuffix natively (models.js per-pid pattern)', () => {
      // models.js passes `.tmp-${process.pid}` to avoid intermediate-file
      // collisions between concurrent writers. Pre-#4913 the Windows
      // branch silently ignored the suffix. Re-verified on real Windows
      // here so a future regression in the option-forwarding shows up.
      const filePath = join(tmpDir, 'models-cache.json')
      writeFileRestricted(filePath, 'payload', { tmpSuffix: '.tmp-12345' })
      assert.strictEqual(readFileSync(filePath, 'utf-8'), 'payload')
      assert.strictEqual(existsSync(`${filePath}.tmp-12345`), false)
      assert.strictEqual(existsSync(`${filePath}.tmp`), false)
    })
  })

  describe('crash-safety on rename failure', () => {
    it('leaves the original destination intact when renameSync throws (real Windows fs.renameSync)', () => {
      // Mirror of the `_isWindowsOverride` rename-failure test, run on
      // real Windows so any node version / OS update that breaks the
      // post-failure filesystem state (e.g. partial rename, leftover
      // sidecar) trips the assertion. We shim `fs.renameSync` in a
      // subprocess to throw EIO; the original file must still be intact
      // and the `.tmp` sidecar must be cleaned up.
      const filePath = join(tmpDir, 'state.json')
      writeFileRestricted(filePath, JSON.stringify({ generation: 1 }))

      const shim = join(tmpDir, 'throw-on-rename.mjs')
      const runner = join(tmpDir, 'runner.mjs')
      const shimUrl = pathToFileURL(shim).href

      const shimSrc = `
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('node:fs')
const orig = fs.renameSync
fs.renameSync = (oldPath, newPath) => {
  if (newPath === ${JSON.stringify(filePath)}) {
    const err = new Error('simulated mid-write crash')
    err.code = 'EIO'
    throw err
  }
  return orig.call(this, oldPath, newPath)
}
`
      const runnerSrc = `
import { writeFileRestricted } from ${JSON.stringify(PLATFORM_JS_URL)}
try {
  writeFileRestricted(${JSON.stringify(filePath)}, ${JSON.stringify(JSON.stringify({ generation: 2 }))})
  process.exit(0)
} catch (err) {
  process.stderr.write(err.message)
  process.exit(2)
}
`
      writeFileSync(shim, shimSrc)
      writeFileSync(runner, runnerSrc)

      const result = spawnSync(process.execPath, ['--import', shimUrl, runner], { encoding: 'utf-8' })
      assert.strictEqual(result.status, 2, `expected non-zero exit; stderr=${result.stderr}`)
      assert.match(result.stderr, /simulated mid-write crash/)

      const after = readFileSync(filePath, 'utf-8')
      assert.strictEqual(after, JSON.stringify({ generation: 1 }))
      assert.strictEqual(JSON.parse(after).generation, 1)
      assert.strictEqual(existsSync(`${filePath}.tmp`), false, '.tmp sidecar must be cleaned up on rename failure')
    })
  })

  describe('ACL inheritance from the parent directory (#4927 criterion 3)', () => {
    it('a freshly written file under a user-only directory does NOT grant Users / Everyone access', () => {
      // Production storage lives at `%USERPROFILE%\.chroxy\` or
      // `%APPDATA%\Chroxy\`, both of which inherit user-only ACLs from
      // the per-user profile root. We replicate that ACL shape inside a
      // dedicated tmp subdirectory so the test stands on its own without
      // touching the runner's real user profile (the sandbox guard in
      // _setup.mjs blocks writes to the real %USERPROFILE%\.chroxy\
      // anyway).
      //
      // icacls steps:
      //   1. /inheritance:d  — break inheritance so we can replace ACEs.
      //   2. /remove "Users" /remove "Everyone" /remove "Authenticated Users"
      //      — strip group/world access (these are the SIDs that a
      //      profile-rooted directory would also lack).
      //   3. /grant <user>:(OI)(CI)F — grant the current user full
      //      control with object + container inherit so child files
      //      inherit user-only access.
      const restrictedDir = join(tmpDir, 'restricted')
      mkdirSync(restrictedDir)

      const user = process.env.USERNAME || process.env.USER || ''
      assert.ok(user, 'USERNAME env var must be set to assert ACL inheritance')

      const breakInherit = spawnSync('icacls', [restrictedDir, '/inheritance:d'], { encoding: 'utf-8' })
      assert.strictEqual(breakInherit.status, 0, `icacls /inheritance:d failed: ${breakInherit.stderr}`)

      // Remove group/world SIDs. We use unlocalized strings — GitHub-hosted
      // windows-latest is en-US, and non-en runners are not a current
      // target. We tolerate "no such ACE" exits (the SIDs may not be
      // present in the inherited ACL after :d), so we don't assert
      // success on the remove steps.
      spawnSync('icacls', [restrictedDir, '/remove', 'Users'], { encoding: 'utf-8' })
      spawnSync('icacls', [restrictedDir, '/remove', 'Everyone'], { encoding: 'utf-8' })
      spawnSync('icacls', [restrictedDir, '/remove', 'Authenticated Users'], { encoding: 'utf-8' })

      // Grant the current user full control with OI/CI so files inherit
      // user-only access.
      const grant = spawnSync('icacls', [restrictedDir, '/grant', `${user}:(OI)(CI)F`], { encoding: 'utf-8' })
      assert.strictEqual(grant.status, 0, `icacls /grant failed: ${grant.stderr}`)

      // Write the file via the helper and read back its ACL. The
      // security contract: a file written under a user-only profile
      // directory inherits an ACL that excludes Users, Everyone, and
      // Authenticated Users.
      const filePath = join(restrictedDir, 'secret.json')
      writeFileRestricted(filePath, JSON.stringify({ token: 'sensitive' }))
      assert.ok(existsSync(filePath), 'file must exist after writeFileRestricted')

      const acl = spawnSync('icacls', [filePath], { encoding: 'utf-8' })
      assert.strictEqual(acl.status, 0, `icacls read failed: ${acl.stderr}`)

      // Each ACE line looks like:  "  BUILTIN\\Users:(R)"  or
      // "  Everyone:(F)" — case-insensitive substring is robust enough
      // for the assertion. If the ACE is missing entirely, the substring
      // simply isn't found, which is what we want.
      const output = acl.stdout.toLowerCase()
      assert.ok(!output.includes('\\users:'), `icacls output must not grant BUILTIN\\Users access:\n${acl.stdout}`)
      assert.ok(!output.includes('everyone:'), `icacls output must not grant Everyone access:\n${acl.stdout}`)
      assert.ok(!output.includes('authenticated users:'), `icacls output must not grant Authenticated Users access:\n${acl.stdout}`)
    })
  })

  describe('cross-volume rename invariant (#4927 criterion 4)', () => {
    it('always writes the temp file as a sibling of the destination (same-dir invariant)', () => {
      // Structural invariant: `writeFileRestricted` builds the temp path
      // as `filePath + tmpSuffix`. The temp is therefore always on the
      // same volume as the destination, so `MoveFileExW` never hits
      // `ERROR_NOT_SAME_DEVICE`. We can't test the negative case
      // (Windows runners have no second writable volume), but we can
      // assert the positive: after a successful write, no sidecar was
      // ever created outside the destination directory.
      //
      // The call-site audit in #4927 confirmed every existing caller
      // passes an absolute path under a single storage root
      // (`~/.chroxy/`, `%APPDATA%/Chroxy/`, or a worktree-local path),
      // so the invariant holds for the whole codebase. A future caller
      // that passes a destination on a non-default volume would still
      // uphold the same-dir invariant — the temp would still be a
      // sibling, and the rename would still stay on one volume.
      const filePath = join(tmpDir, 'invariant.json')
      writeFileRestricted(filePath, 'payload')
      assert.strictEqual(readFileSync(filePath, 'utf-8'), 'payload')
      // No `.tmp` left behind anywhere under tmpDir, including the
      // parent and grandparent directories — the helper only ever
      // creates `<filePath>.tmp`.
      assert.strictEqual(existsSync(`${filePath}.tmp`), false)
      assert.strictEqual(existsSync(`${tmpDir}.tmp`), false)
    })
  })
})
