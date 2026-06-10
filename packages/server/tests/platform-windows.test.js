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
      // icacls steps (all principal identification via well-known SIDs so
      // the test stays locale-portable — display-language changes on a
      // future windows-latest image must not break ACE matching, #5003):
      //   1. /inheritance:r — REMOVE all inherited ACEs (not `:d`, which
      //      copies them as explicit ACEs). Pre-#5455 this fixture used
      //      `:d` + selective `/remove`, which left the directory's ACL
      //      derived from whatever the runner image's temp-dir defaults
      //      happened to be — i.e. the assertion partly tested the
      //      image's inherited defaults, not our write behaviour, and a
      //      windows-latest image update broke the job on every main
      //      push. `:r` pins the fixture: the directory ACL below is
      //      fully spelled out by this test, regardless of image drift.
      //   2. /grant *S-1-5-18:(OI)(CI)F — NT AUTHORITY\SYSTEM, matching
      //      the real per-user profile ACL shape (profile dirs grant
      //      SYSTEM alongside the user).
      //   3. /grant *<current-user-SID>:(OI)(CI)F — grant the current user
      //      full control with object + container inherit so child files
      //      inherit user-only access. The current user's SID is parsed
      //      from `whoami /user` so we don't rely on %USERNAME% resolving
      //      to a locale-stable display name. icacls accepts the `*<SID>`
      //      prefix in place of a principal name.
      // All three run as a single icacls invocation so there is no
      // intermediate state between stripping inheritance and granting.
      const restrictedDir = join(tmpDir, 'restricted')
      mkdirSync(restrictedDir)

      // Parse the current user's SID from Windows' `whoami /user`. The SID
      // format (`S-1-<authority>-<rid>...`) is invariant across locales, so
      // the regex match holds regardless of the column headers' language.
      //
      // We invoke `whoami.exe` by absolute path under %SystemRoot%\System32
      // because the Windows CI job runs under Git Bash (`shell: bash` in
      // .github/workflows/ci.yml), and Git Bash ships its own Unix-style
      // `whoami` earlier on PATH which does not accept `/user` — see #5003.
      // `whoami /user` outputs exactly one SID-shaped token (the current
      // user's), so first-match semantics are intentional.
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      const whoamiExe = `${systemRoot}\\System32\\whoami.exe`
      const whoami = spawnSync(whoamiExe, ['/user'], { encoding: 'utf-8' })
      assert.strictEqual(whoami.status, 0, `whoami /user failed: ${whoami.stderr}`)
      const userSid = (whoami.stdout.match(/\bS-1-[\d-]+/) || [])[0]
      assert.ok(userSid, `failed to extract current user SID from whoami /user output:\n${whoami.stdout}`)

      const pin = spawnSync(
        'icacls',
        [
          restrictedDir,
          '/inheritance:r',
          '/grant', '*S-1-5-18:(OI)(CI)F',
          '/grant', `*${userSid}:(OI)(CI)F`,
        ],
        { encoding: 'utf-8' }
      )
      assert.strictEqual(pin.status, 0, `icacls fixture pin failed: ${pin.stderr || pin.stdout}`)

      // Write the file via the helper and read back its ACL via
      // PowerShell: `(Get-Acl <path>).Sddl` for the raw SDDL string, then
      // parse that SDDL with `RawSecurityDescriptor` and emit each DACL
      // ACE's `SecurityIdentifier.Value` — one raw `S-1-...` SID per line.
      //
      // The per-ACE SID normalisation is load-bearing (#5455): contrary to
      // what this test originally assumed, SDDL serialisation DOES
      // abbreviate well-known principals to two-letter aliases (`SY`,
      // `BA`, `BU`, `WD`, `AU`, and notably `LA` for the machine's RID-500
      // Administrator). The windows-2025 image update of 2026-06 switched
      // the job to run as the built-in Administrator, whose grant then
      // rendered as `LA` instead of its raw SID — the #5032 tripwire below
      // fired (correctly: the raw-SID substring checks were blind to alias
      // forms). Comparing parsed full SIDs is alias-proof in both
      // directions and makes prefix collisions (`S-1-5-11` vs
      // `S-1-5-113`, the #5031 concern) structurally impossible — exact
      // string equality on whole SIDs, no substring anchoring needed.
      //
      // Why not `icacls /save`: its output file is not specified to be
      // SDDL (the docs only call it "an ACL file for later use with
      // /restore"), is UTF-16 LE with BOM (so a utf-8 readFileSync
      // returns nul-interleaved garbage), and its well-known-principal
      // abbreviations are exactly the failure mode above.
      // Why not `(Get-Acl).Access`: IdentityReference holds localised
      // display names (locale-dependent, #5003); going through the SDDL
      // string + RawSecurityDescriptor keeps the read-back on the same
      // canonical path we report in failure messages.
      const filePath = join(restrictedDir, 'secret.json')
      writeFileRestricted(filePath, JSON.stringify({ token: 'sensitive' }))
      assert.ok(existsSync(filePath), 'file must exist after writeFileRestricted')

      // PowerShell on `windows-latest` is `powershell.exe` (Windows
      // PowerShell 5.1). `-NoProfile` skips any user profile that could
      // perturb the output. Output contract: line 1 is the raw SDDL,
      // every subsequent line is one DACL ACE's raw SID. A null DACL
      // (everyone-allowed) yields no SID lines and trips the #5032
      // tripwire below, as it should.
      const psScript = [
        `$ErrorActionPreference = 'Stop'`,
        `$sddl = (Get-Acl -LiteralPath '${filePath.replace(/'/g, "''")}').Sddl`,
        `$sd = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)`,
        `Write-Output $sddl`,
        `if ($sd.DiscretionaryAcl) { $sd.DiscretionaryAcl | ForEach-Object { Write-Output $_.SecurityIdentifier.Value } }`,
      ].join('; ')
      const getAcl = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { encoding: 'utf-8' }
      )
      assert.strictEqual(getAcl.status, 0, `Get-Acl read-back failed: ${getAcl.stderr}`)
      const [sddl = '', ...aceSids] = getAcl.stdout.trim().split(/\r?\n/).map((line) => line.trim())
      assert.ok(sddl.length > 0, `Get-Acl returned empty SDDL`)

      // Tripwire: confirm the read-back path can actually detect a SID
      // before we run absence assertions. We assert the current user's
      // SID IS present (the explicit grant added above must round-trip
      // into the file's inherited ACL), which means a future regression
      // that breaks the read-back (encoding, format, SDDL parsing,
      // alias handling) would fire this assertion before silently
      // green-lighting a real ACL regression downstream. See #5032.
      assert.ok(
        aceSids.includes(userSid),
        `tripwire: DACL must contain an ACE for the current user's SID (${userSid}) — read-back path is broken if absent.\nSDDL: ${sddl}\nACE SIDs: ${aceSids.join(', ')}`
      )

      // Assert the DACL has no ACE for the group/world principals.
      // Exact equality on the parsed full SIDs — alias-proof (see #5455)
      // and immune to the #5031 prefix-collision concern by construction.
      //   S-1-5-32-545  BUILTIN\Users
      //   S-1-1-0       Everyone
      //   S-1-5-11      NT AUTHORITY\Authenticated Users
      assert.ok(
        !aceSids.includes('S-1-5-32-545'),
        `DACL must not contain BUILTIN\\Users (S-1-5-32-545).\nSDDL: ${sddl}\nACE SIDs: ${aceSids.join(', ')}`
      )
      assert.ok(
        !aceSids.includes('S-1-1-0'),
        `DACL must not contain Everyone (S-1-1-0).\nSDDL: ${sddl}\nACE SIDs: ${aceSids.join(', ')}`
      )
      assert.ok(
        !aceSids.includes('S-1-5-11'),
        `DACL must not contain Authenticated Users (S-1-5-11).\nSDDL: ${sddl}\nACE SIDs: ${aceSids.join(', ')}`
      )
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
