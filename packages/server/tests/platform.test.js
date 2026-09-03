import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, renameSync, fsyncSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'node:url'
import { defaultShell, writeFileRestricted, forceKill, killProcessTree, parseDescendantPids, listDescendantPids, isWindows, isMac, cloudflaredInstallHint } from '../src/platform.js'

// Production code in `platform.js` imports from `'fs'` etc. via ESM — the
// subprocess shims below need to use `file:` URLs for both the `--import`
// argument and the `import` specifier inside the generated runner, otherwise
// Node's ESM loader on Windows rejects bare `C:\...` paths with
// `ERR_UNSUPPORTED_ESM_URL_SCHEME` (`Received protocol 'c:'`). On POSIX a
// bare absolute path happens to parse as a valid specifier, but `file:` URLs
// are the cross-platform contract and what the loader actually expects.
const PLATFORM_JS_URL = new URL('../src/platform.js', import.meta.url).href
const toFileUrl = (p) => pathToFileURL(p).href

describe('platform', () => {
  describe('isWindows', () => {
    it('is a boolean', () => {
      assert.strictEqual(typeof isWindows, 'boolean')
    })
  })

  describe('defaultShell()', () => {
    it('returns a non-empty string', () => {
      const shell = defaultShell()
      assert.strictEqual(typeof shell, 'string')
      assert.ok(shell.length > 0)
    })
  })

  describe('cloudflaredInstallHint()', () => {
    it('returns an actionable, platform-appropriate install hint (#6649)', () => {
      const hint = cloudflaredInstallHint()
      assert.strictEqual(typeof hint, 'string')
      assert.ok(hint.length > 0)
      if (isWindows) assert.match(hint, /winget install Cloudflare\.cloudflared/)
      else if (isMac) assert.match(hint, /brew install cloudflared/)
      else assert.match(hint, /pkg\.cloudflare\.com/)
    })
  })

  describe('writeFileRestricted()', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'platform-test-'))
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('writes file content correctly', () => {
      const filePath = join(tmpDir, 'test.txt')
      writeFileRestricted(filePath, 'hello world')
      const content = readFileSync(filePath, 'utf-8')
      assert.strictEqual(content, 'hello world')
    })

    it('overwrites existing file', () => {
      const filePath = join(tmpDir, 'test.txt')
      writeFileRestricted(filePath, 'first')
      writeFileRestricted(filePath, 'second')
      const content = readFileSync(filePath, 'utf-8')
      assert.strictEqual(content, 'second')
    })

    if (!isWindows) {
      it('sets 0o600 permissions on Unix', () => {
        const filePath = join(tmpDir, 'restricted.txt')
        writeFileRestricted(filePath, 'secret')
        const mode = statSync(filePath).mode & 0o777
        assert.strictEqual(mode, 0o600)
      })

      it('writes atomically via <path>.tmp + rename — leaves original intact and cleans up tmp when rename fails (#4850, #4874)', () => {
        // Simulates `renameSync` failing AFTER the tmp file is fully
        // written (EIO from the shim below). The contract under test is
        // two-part: (1) readers of `filePath` never see a half-written
        // version — they observe either the previous generation (this
        // test) or the new one once rename succeeds; (2) since #4874 the
        // intermediate `.tmp` is unlinked in-process when rename fails so
        // it does not leak across retries (environment-manager.js and
        // session-state-persistence.js used to hand-roll this cleanup).
        // The previous-generation guarantee is what protected callers
        // pre-#4874 when the process was killed mid-write (SIGKILL / OOM)
        // — same crash-safety contract, exercised here via a synthetic
        // rename failure rather than a real signal.
        //
        // We run the actual write in a subprocess because monkey-patching
        // `fs.renameSync` in-process doesn't propagate to `platform.js`'s
        // already-snapshotted ESM-from-CJS import binding (the same
        // reason `_setup.mjs` MUST run via `--import` to install the
        // sandbox guard before any other module loads `node:fs`). The
        // subprocess loads a tiny patch shim FIRST via `--import`, then
        // imports `platform.js` fresh, then calls `writeFileRestricted`
        // and exits non-zero so the parent can assert against the
        // post-crash filesystem state.
        const filePath = join(tmpDir, 'connection.json')
        writeFileRestricted(filePath, JSON.stringify({ generation: 1 }))

        const shim = join(tmpDir, 'throw-on-rename.mjs')
        const runner = join(tmpDir, 'runner.mjs')
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
        // Use the same writeFileRestricted to write the shim (atomic
        // already, which is fine — we're seeding fixtures, not testing
        // the seeding).
        writeFileRestricted(shim, shimSrc)
        writeFileRestricted(runner, runnerSrc)

        const result = spawnSync(process.execPath, ['--import', toFileUrl(shim), runner], { encoding: 'utf-8' })
        assert.strictEqual(result.status, 2, `expected non-zero exit; stderr=${result.stderr}`)
        assert.match(result.stderr, /simulated mid-write crash/)

        // Original file untouched — still version 1, intact JSON.
        const after = readFileSync(filePath, 'utf-8')
        assert.strictEqual(after, JSON.stringify({ generation: 1 }))
        const parsed = JSON.parse(after) // would throw if half-written
        assert.strictEqual(parsed.generation, 1)

        // The intermediate `.tmp` sidecar is cleaned up on rename failure
        // (#4874) so it does not leak across retries.
        const tmpPath = `${filePath}.tmp`
        assert.strictEqual(existsSync(tmpPath), false, '.tmp sidecar must be cleaned up on rename failure')
      })

      it('honours a custom tmpSuffix option and routes the intermediate file through it (#4874)', () => {
        // Two concurrent processes writing the same target with a per-pid
        // suffix must not race on the same intermediate file. We can't
        // truly fork here, but we can prove the suffix is honoured by
        // observing the intermediate path on a rename failure. The shim
        // also suppresses the cleanup unlink so the post-crash file is
        // still on disk for inspection.
        const filePath = join(tmpDir, 'models-cache.json')
        const shim = join(tmpDir, 'throw-on-rename-suffix.mjs')
        const runner = join(tmpDir, 'runner-suffix.mjs')
        const sentinelPath = join(tmpDir, 'observed-tmp-path.txt')
        const shimSrc = `
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('node:fs')
const origRename = fs.renameSync
const origUnlink = fs.unlinkSync
fs.renameSync = (oldPath, newPath) => {
  if (newPath === ${JSON.stringify(filePath)}) {
    fs.writeFileSync(${JSON.stringify(sentinelPath)}, oldPath)
    const err = new Error('simulated mid-write crash')
    err.code = 'EIO'
    throw err
  }
  return origRename.call(this, oldPath, newPath)
}
// Swallow the cleanup unlink so we can inspect the intermediate path later.
fs.unlinkSync = (p) => {
  if (typeof p === 'string' && p.includes('.tmp-')) return
  return origUnlink.call(this, p)
}
`
        const runnerSrc = `
import { writeFileRestricted } from ${JSON.stringify(PLATFORM_JS_URL)}
try {
  writeFileRestricted(${JSON.stringify(filePath)}, 'payload', { tmpSuffix: '.tmp-12345' })
  process.exit(0)
} catch {
  process.exit(2)
}
`
        writeFileRestricted(shim, shimSrc)
        writeFileRestricted(runner, runnerSrc)
        const result = spawnSync(process.execPath, ['--import', toFileUrl(shim), runner], { encoding: 'utf-8' })
        assert.strictEqual(result.status, 2, `expected non-zero exit; stderr=${result.stderr}`)

        const observed = readFileSync(sentinelPath, 'utf-8')
        assert.strictEqual(observed, `${filePath}.tmp-12345`, 'tmpSuffix must drive the intermediate path')
      })

      it('logs a warn when the cleanup-unlink fails with a non-ENOENT error and still re-throws the rename error (#4906)', () => {
        // Regression: #4904 hoisted the per-caller cleanup into
        // writeFileRestricted but dropped the warn that environment-manager.js
        // and session-state-persistence.js emitted on a non-ENOENT unlink
        // failure. The orphan `.tmp` was left on disk with no diagnostic
        // trail. This test pins the warn back in place via a subprocess
        // shim that fails BOTH rename and unlink — we then assert (a) the
        // rename error is surfaced to the caller, and (b) the
        // [platform] warn line for the unlink failure shows up on stderr.
        const filePath = join(tmpDir, 'observability.json')
        const shim = join(tmpDir, 'throw-on-rename-and-unlink.mjs')
        const runner = join(tmpDir, 'runner-cleanup-fail.mjs')
        const shimSrc = `
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('node:fs')
const origRename = fs.renameSync
const origUnlink = fs.unlinkSync
fs.renameSync = (oldPath, newPath) => {
  if (newPath === ${JSON.stringify(filePath)}) {
    const err = new Error('simulated mid-write crash')
    err.code = 'EIO'
    throw err
  }
  return origRename.call(this, oldPath, newPath)
}
fs.unlinkSync = (p) => {
  if (typeof p === 'string' && p === ${JSON.stringify(`${filePath}.tmp`)}) {
    const err = new Error('simulated cleanup failure')
    err.code = 'EACCES'
    throw err
  }
  return origUnlink.call(this, p)
}
`
        const runnerSrc = `
import { writeFileRestricted } from ${JSON.stringify(PLATFORM_JS_URL)}
try {
  writeFileRestricted(${JSON.stringify(filePath)}, 'payload')
  process.exit(0)
} catch (err) {
  process.stderr.write('RENAME_ERR=' + err.message + '\\n')
  process.exit(2)
}
`
        writeFileRestricted(shim, shimSrc)
        writeFileRestricted(runner, runnerSrc)
        const result = spawnSync(process.execPath, ['--import', toFileUrl(shim), runner], { encoding: 'utf-8' })
        assert.strictEqual(result.status, 2, `expected non-zero exit; stderr=${result.stderr}`)
        // (a) Original rename error surfaces to the caller — the
        //     cleanup-failure log MUST NOT mask it.
        assert.match(result.stderr, /RENAME_ERR=simulated mid-write crash/)
        // (b) Warn line for the cleanup unlink is on stderr, scoped to
        //     the [platform] logger and naming the orphaned tmp path.
        assert.match(result.stderr, /\[WARN\]\s+\[platform\]\s+Failed to remove orphaned/)
        assert.match(result.stderr, new RegExp(`${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp`))
        assert.match(result.stderr, /simulated cleanup failure/)
      })

      it('does NOT log on ENOENT cleanup-unlink — the tmp is already gone (#4906)', () => {
        // The bespoke cleanup wrappers explicitly suppressed ENOENT
        // because "tmp is already gone" is the desired post-condition,
        // not a failure worth a warn. Pin that exemption so we don't
        // start spamming logs when the tmp never made it to disk (e.g.,
        // writeFileSync threw before rename was attempted, or another
        // process unlinked it first).
        const filePath = join(tmpDir, 'enoent-cleanup.json')
        const shim = join(tmpDir, 'throw-on-rename-enoent-unlink.mjs')
        const runner = join(tmpDir, 'runner-enoent-cleanup.mjs')
        const shimSrc = `
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('node:fs')
const origRename = fs.renameSync
const origUnlink = fs.unlinkSync
fs.renameSync = (oldPath, newPath) => {
  if (newPath === ${JSON.stringify(filePath)}) {
    // Pre-emptively unlink so the cleanup path sees ENOENT.
    try { origUnlink.call(this, oldPath) } catch {}
    const err = new Error('simulated mid-write crash')
    err.code = 'EIO'
    throw err
  }
  return origRename.call(this, oldPath, newPath)
}
`
        const runnerSrc = `
import { writeFileRestricted } from ${JSON.stringify(PLATFORM_JS_URL)}
try {
  writeFileRestricted(${JSON.stringify(filePath)}, 'payload')
  process.exit(0)
} catch {
  process.exit(2)
}
`
        writeFileRestricted(shim, shimSrc)
        writeFileRestricted(runner, runnerSrc)
        const result = spawnSync(process.execPath, ['--import', toFileUrl(shim), runner], { encoding: 'utf-8' })
        assert.strictEqual(result.status, 2, `expected non-zero exit; stderr=${result.stderr}`)
        // ENOENT cleanup must stay silent — no platform warn at all.
        assert.doesNotMatch(result.stderr, /\[WARN\]\s+\[platform\]\s+Failed to remove orphaned/)
      })

      it('cleans up the .tmp sidecar on successful write (#4850)', () => {
        // Once `rename` succeeds the `.tmp` is gone (it WAS the temp,
        // now renamed onto the target). A leftover `.tmp` would mean we
        // were writing to the wrong path.
        const filePath = join(tmpDir, 'device-preferences.json')
        writeFileRestricted(filePath, 'final')
        assert.strictEqual(readFileSync(filePath, 'utf-8'), 'final')
        assert.strictEqual(existsSync(`${filePath}.tmp`), false)
      })

      it('cleans up the custom-suffix sidecar on successful write (#4874)', () => {
        // Same contract as the default `.tmp` cleanup, exercised via the
        // models.js `tmpSuffix: \`.tmp-${process.pid}\`` path so the
        // per-pid intermediate does not leak after a clean save.
        const filePath = join(tmpDir, 'models-cache.json')
        writeFileRestricted(filePath, 'final', { tmpSuffix: '.tmp-99999' })
        assert.strictEqual(readFileSync(filePath, 'utf-8'), 'final')
        assert.strictEqual(existsSync(`${filePath}.tmp-99999`), false)
      })

      it('preserves 0o600 on the renamed target (#4850)', () => {
        // chmod applies to the tmp before rename; the perms must
        // survive the rename onto the final path.
        const filePath = join(tmpDir, 'sensitive.json')
        writeFileRestricted(filePath, 'secret')
        const mode = statSync(filePath).mode & 0o777
        assert.strictEqual(mode, 0o600)
      })

      it('tightens perms when a stale tmp sidecar exists at a looser mode (#4907)', async () => {
        // Regression for "stale tmp preserves mode unless chmodSync
        // re-tightens": the `mode: 0o600` arg to `writeFileSync` is
        // ONLY honoured on file CREATION. If a prior run crashed before
        // rename and left a `.tmp` sidecar at e.g. 0o644,
        // `writeFileSync` opens with `O_TRUNC` and silently inherits
        // the stale mode. The explicit `chmodSync` in
        // `writeFileRestricted` must restore 0o600 before the rename so
        // the FINAL file is tight. This test asserts the final mode
        // bits only — it does NOT cover the transient exposure window
        // during the write (the bytes are on disk at the stale 0o644
        // briefly, before chmodSync runs). It would fail if someone
        // "cleaned up" the chmodSync as redundant.
        const filePath = join(tmpDir, 'sensitive.json')
        const tmpPath = `${filePath}.tmp`
        const { writeFileSync, chmodSync } = await import('fs')
        // Pre-seed the tmp sidecar at a looser mode.
        writeFileSync(tmpPath, 'stale', { mode: 0o644 })
        chmodSync(tmpPath, 0o644)
        assert.strictEqual(statSync(tmpPath).mode & 0o777, 0o644, 'baseline: tmp seeded at 0o644')

        writeFileRestricted(filePath, 'fresh')

        const finalMode = statSync(filePath).mode & 0o777
        assert.strictEqual(finalMode, 0o600, 'final file must be 0o600 even when tmp was pre-existing at 0o644')
      })
    }

    describe('Windows branch (cross-platform via _isWindowsOverride) — #4913', () => {
      // Before #4913 the Windows path of writeFileRestricted was a
      // direct `writeFileSync` to the destination, which meant a
      // mid-write SIGKILL / OOM could leave the file truncated and
      // unparseable. That regression was introduced when #4874 collapsed
      // the manual tmp+rename wrappers in `environment-manager.js` and
      // `models.js` onto this helper. The fix is to use the same
      // temp+rename pattern on Windows as on POSIX (only the chmod step
      // is skipped — Windows uses ACL inheritance from the parent
      // directory, not POSIX mode bits).
      //
      // We exercise the Windows branch on every host via the
      // `_isWindowsOverride` option (same hook pattern as
      // SessionStatePersistence's `isWindowsOverride`). A real Windows
      // CI runner is not currently available; if Windows-specific
      // atomicity edge cases (cross-volume rename, AV-held handles,
      // ACL inheritance) need verification, file a follow-up issue —
      // these tests cover the core temp+rename contract that the issue
      // was raised to restore.

      it('writes via <path>.tmp + rename — destination updates atomically (#4913)', () => {
        // Round-trip: a clean write through the forced-Windows branch
        // must leave the destination with the new content and clean up
        // the `.tmp` sidecar. This is the happy-path mirror of the
        // POSIX "atomic via .tmp + rename" test above.
        const filePath = join(tmpDir, 'env-state.json')
        writeFileRestricted(filePath, JSON.stringify({ generation: 1 }), { _isWindowsOverride: true })
        assert.strictEqual(readFileSync(filePath, 'utf-8'), JSON.stringify({ generation: 1 }))
        assert.strictEqual(existsSync(`${filePath}.tmp`), false, '.tmp sidecar must be cleaned up after rename')

        writeFileRestricted(filePath, JSON.stringify({ generation: 2 }), { _isWindowsOverride: true })
        assert.strictEqual(readFileSync(filePath, 'utf-8'), JSON.stringify({ generation: 2 }))
        assert.strictEqual(existsSync(`${filePath}.tmp`), false)
      })

      it('honours a custom tmpSuffix on the Windows branch (#4913)', () => {
        // The per-pid `tmpSuffix` contract used by models.js to avoid
        // intermediate-file collisions between concurrent writers must
        // also apply on Windows. Before #4913 the Windows branch
        // ignored `tmpSuffix` entirely.
        const filePath = join(tmpDir, 'models-cache.json')
        writeFileRestricted(filePath, 'payload', {
          tmpSuffix: '.tmp-12345',
          _isWindowsOverride: true,
        })
        assert.strictEqual(readFileSync(filePath, 'utf-8'), 'payload')
        assert.strictEqual(existsSync(`${filePath}.tmp-12345`), false, 'custom-suffix sidecar must be cleaned up after rename')
        assert.strictEqual(existsSync(`${filePath}.tmp`), false, 'default-suffix sidecar must not exist when a custom suffix is used')
      })

      it('leaves the original destination intact when rename fails mid-write (#4913)', () => {
        // The crash-safety contract: a `renameSync` failure (or a real
        // mid-write SIGKILL/OOM, which manifests as the rename never
        // happening) must leave the previous-generation destination
        // untouched and parseable. This is the Windows analogue of the
        // POSIX "atomic via .tmp + rename" test above; on any runner we
        // force the Windows branch via `_isWindowsOverride` and shim
        // `fs.renameSync` to throw EIO, replicating the post-crash
        // filesystem state we would see on Windows.
        //
        // Like the POSIX test, this runs in a subprocess because
        // monkey-patching `fs.renameSync` in-process does not propagate
        // to `platform.js`'s already-snapshotted ESM-from-CJS import
        // binding.
        const filePath = join(tmpDir, 'env-state.json')
        writeFileRestricted(filePath, JSON.stringify({ generation: 1 }), { _isWindowsOverride: true })

        const shim = join(tmpDir, 'win-throw-on-rename.mjs')
        const runner = join(tmpDir, 'win-runner.mjs')
        const shimSrc = `
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('node:fs')
const orig = fs.renameSync
fs.renameSync = (oldPath, newPath) => {
  if (newPath === ${JSON.stringify(filePath)}) {
    const err = new Error('simulated mid-write crash (windows branch)')
    err.code = 'EIO'
    throw err
  }
  return orig.call(this, oldPath, newPath)
}
`
        const runnerSrc = `
import { writeFileRestricted } from ${JSON.stringify(PLATFORM_JS_URL)}
try {
  writeFileRestricted(${JSON.stringify(filePath)}, ${JSON.stringify(JSON.stringify({ generation: 2 }))}, { _isWindowsOverride: true })
  process.exit(0)
} catch (err) {
  process.stderr.write(err.message)
  process.exit(2)
}
`
        writeFileRestricted(shim, shimSrc)
        writeFileRestricted(runner, runnerSrc)
        const result = spawnSync(process.execPath, ['--import', toFileUrl(shim), runner], { encoding: 'utf-8' })
        assert.strictEqual(result.status, 2, `expected non-zero exit; stderr=${result.stderr}`)
        assert.match(result.stderr, /simulated mid-write crash/)

        // The original destination is untouched — still generation 1,
        // and still parseable JSON. Pre-#4913 the Windows branch wrote
        // the new payload directly to `filePath`, so a crash mid-write
        // would have left it truncated and `JSON.parse` would throw.
        const after = readFileSync(filePath, 'utf-8')
        assert.strictEqual(after, JSON.stringify({ generation: 1 }))
        assert.strictEqual(JSON.parse(after).generation, 1)

        // The intermediate `.tmp` is cleaned up on rename failure so it
        // does not leak across retries — same contract as POSIX.
        assert.strictEqual(existsSync(`${filePath}.tmp`), false, '.tmp sidecar must be cleaned up on rename failure')
      })

      it('cleans up the custom-suffix intermediate when rename fails (#4913)', () => {
        // Without the cleanup, a sequence of failing writes would leak
        // one sidecar per attempt. This pins the explicit cleanup
        // contract on the Windows branch — same as POSIX (#4874).
        const filePath = join(tmpDir, 'env-state.json')
        const shim = join(tmpDir, 'win-throw-on-rename-cleanup.mjs')
        const runner = join(tmpDir, 'win-runner-cleanup.mjs')
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
  writeFileRestricted(${JSON.stringify(filePath)}, 'payload', { tmpSuffix: '.tmp-99999', _isWindowsOverride: true })
  process.exit(0)
} catch {
  process.exit(2)
}
`
        writeFileRestricted(shim, shimSrc)
        writeFileRestricted(runner, runnerSrc)
        const result = spawnSync(process.execPath, ['--import', toFileUrl(shim), runner], { encoding: 'utf-8' })
        assert.strictEqual(result.status, 2)
        assert.strictEqual(existsSync(`${filePath}.tmp-99999`), false, 'custom-suffix sidecar must be cleaned up on rename failure')
      })
    })

    describe('durable write (fsync) — #6914', () => {
      it('durable write produces the correct content and (POSIX) 0o600 perms', () => {
        // The security-critical opt-in path (the session-token REVOKE snapshot)
        // must still land byte-correct and owner-only — durability is layered on
        // TOP of the existing atomic-write contract, not a replacement for it.
        const filePath = join(tmpDir, 'session-tokens.json')
        writeFileRestricted(filePath, 'revoked-snapshot', { durable: true })
        assert.strictEqual(readFileSync(filePath, 'utf-8'), 'revoked-snapshot')
        assert.strictEqual(existsSync(`${filePath}.tmp`), false, '.tmp sidecar cleaned up after rename')
        if (!isWindows) {
          assert.strictEqual(statSync(filePath).mode & 0o777, 0o600, 'durable path preserves 0o600')
        }
      })

      it('fsyncs the temp file before the rename AND (POSIX) the directory after', () => {
        // The full atomic-durable recipe is two fsyncs on POSIX: the temp FILE
        // (so its bytes are on disk before the rename) and the containing
        // DIRECTORY (so the rename itself is durable). We can't see the fd→path
        // mapping, so we count invocations through the `_fsync` seam.
        const filePath = join(tmpDir, 'session-tokens.json')
        let fsyncCalls = 0
        writeFileRestricted(filePath, 'data', {
          durable: true,
          _fsync: (fd) => { fsyncCalls++; fsyncSync(fd) },
        })
        // POSIX: temp-file fsync + directory fsync = 2. Windows: temp-file fsync
        // only (no directory fsync; the durable rename comes from the OS).
        assert.strictEqual(fsyncCalls, isWindows ? 1 : 2)
        assert.strictEqual(readFileSync(filePath, 'utf-8'), 'data')
      })

      it('does NOT fsync on the default (non-durable) path — no perf regression for config/state writes', () => {
        // Opt-in by design: the ordinary fail-safe callers (config, models cache,
        // session state, mint/slide) must be byte-for-byte the old behaviour.
        const filePath = join(tmpDir, 'config.json')
        let fsyncCalls = 0
        writeFileRestricted(filePath, 'plain', { _fsync: () => { fsyncCalls++ } })
        assert.strictEqual(fsyncCalls, 0, 'the default path must never fsync')
        assert.strictEqual(readFileSync(filePath, 'utf-8'), 'plain')
      })

      it('treats a BENIGN fsync failure (EINVAL) as best-effort — the write still succeeds', () => {
        // A filesystem that cannot fsync a file/dir entry (some virtual / network
        // FS) surfaces EINVAL. That is not a durability failure we can act on — the
        // bytes are in the page cache and the rename happened — so the write must
        // still succeed rather than throw and fail the whole operation.
        const filePath = join(tmpDir, 'session-tokens.json')
        const benign = Object.assign(new Error('fsync not supported'), { code: 'EINVAL' })
        assert.doesNotThrow(() => {
          writeFileRestricted(filePath, 'best-effort', {
            durable: true,
            _fsync: () => { throw benign },
          })
        })
        assert.strictEqual(readFileSync(filePath, 'utf-8'), 'best-effort')
        assert.strictEqual(existsSync(`${filePath}.tmp`), false)
      })

      it('#7067: a POST-RENAME directory-fsync failure does NOT throw — the write already landed', () => {
        // The rename has already published the file, so the write SUCCEEDED; only
        // the durability of its directory entry is unproven. Throwing here told the
        // caller the write failed, and pairing.js turned that into "the session-token
        // revoke failed" for a revoke whose snapshot was already on disk — the
        // operator then retries or assumes the token is still live. Mirrors the
        // credential-store precedent (#6964/#7061), which reports rather than throws.
        if (isWindows) return // no directory fsync on Windows
        const filePath = join(tmpDir, 'session-tokens.json')
        const hard = Object.assign(new Error('dir fsync exploded'), { code: 'EIO' })
        let calls = 0
        let outcome
        assert.doesNotThrow(() => {
          outcome = writeFileRestricted(filePath, 'revoked-snapshot', {
            durable: true,
            // 1st call = the temp FILE (pre-rename) and must succeed; 2nd = the
            // containing DIRECTORY (post-rename) and is the limb under test.
            _fsync: (fd) => { calls++; if (calls === 1) return fsyncSync(fd); throw hard },
          })
        }, 'the file is on disk — reporting a failed write would be factually wrong')
        assert.strictEqual(calls, 2, 'both limbs ran: temp-file fsync then directory fsync')
        assert.strictEqual(readFileSync(filePath, 'utf-8'), 'revoked-snapshot', 'the write DID land')
        assert.strictEqual(existsSync(`${filePath}.tmp`), false, 'no orphaned sidecar')
        assert.strictEqual(
          typeof outcome?.durabilityUnconfirmed, 'string',
          'the caveat must be reported, not swallowed — the caller needs to distinguish it from a clean write',
        )
        assert.match(outcome.durabilityUnconfirmed, /EIO|dir fsync exploded/)
      })

      it('#7067: a clean durable write reports durabilityUnconfirmed: null', () => {
        const filePath = join(tmpDir, 'clean.json')
        const outcome = writeFileRestricted(filePath, 'ok', { durable: true })
        assert.strictEqual(outcome?.durabilityUnconfirmed, null, 'a clean write makes no caveat')
      })

      it('propagates a GENUINE fsync failure (EIO) and cleans up the temp — the durable caller reports failure', () => {
        // A real I/O error means we cannot promise durability, so the durable path
        // must surface it (→ session-token store save() returns false → revoke
        // reports persistFailed) rather than claim a false success. The failure
        // fires on the temp-file fsync BEFORE the rename, so the destination is
        // never created and the orphaned .tmp is cleaned up.
        const filePath = join(tmpDir, 'session-tokens.json')
        const hard = Object.assign(new Error('disk exploded'), { code: 'EIO' })
        assert.throws(
          () => writeFileRestricted(filePath, 'nope', { durable: true, _fsync: () => { throw hard } }),
          /disk exploded/,
        )
        assert.strictEqual(existsSync(filePath), false, 'destination must not exist after a pre-rename fsync failure')
        assert.strictEqual(existsSync(`${filePath}.tmp`), false, 'orphaned .tmp must be cleaned up')
      })
    })
  })

  describe('parseDescendantPids / listDescendantPids (#7606)', () => {
    // pid ppid — the shape of `ps -axo pid=,ppid=`. 100 is the tracked child;
    // 200/201 its children; 300 a grandchild; 400 an unrelated process.
    const TABLE = `
  100     1
  200   100
  201   100
  300   200
  400     1
  401   400
`
    it('returns every descendant, parents before children, and nothing else', () => {
      const got = parseDescendantPids(100, TABLE)
      assert.deepEqual([...got].sort(), [200, 201, 300])
      assert.ok(got.indexOf(200) < got.indexOf(300), 'parent 200 before its child 300')
    })

    it('returns [] for a pid with no children, and ignores malformed lines', () => {
      assert.deepEqual(parseDescendantPids(300, TABLE), [])
      assert.deepEqual(parseDescendantPids(100, 'PID PPID\nfoo bar\n'), [])
      assert.deepEqual(parseDescendantPids(100, ''), [])
    })

    it('survives a cyclic table without looping forever', () => {
      assert.deepEqual(parseDescendantPids(1, ' 1 2\n 2 1\n'), [2])
    })

    it('listDescendantPids uses the ps seam, and degrades to [] when ps throws or the pid is bogus', () => {
      assert.deepEqual(listDescendantPids(100, { ps: () => TABLE }).sort(), [200, 201, 300])
      assert.deepEqual(listDescendantPids(100, { ps: () => { throw new Error('no ps') } }), [])
      let called = false
      assert.deepEqual(listDescendantPids(undefined, { ps: () => { called = true; return TABLE } }), [])
      assert.deepEqual(listDescendantPids(0, { ps: () => { called = true; return TABLE } }), [])
      assert.equal(called, false, 'no ps call for a pid-less child')
    })
  })

  describe('killProcessTree() POSIX tree walk (#7606)', { skip: isWindows }, () => {
    const TABLE = '  100     1\n  200   100\n  300   200\n  400     1\n'
    const harness = () => {
      const events = []
      const child = { pid: 100, kill(sig) { events.push(['child', sig]) } }
      const kill = (pid, sig) => events.push([pid, sig])
      return { events, child, kill }
    }

    it('enumerates BEFORE signalling the child, then signals descendants deepest-first', () => {
      const { events, child, kill } = harness()
      let psCalledBeforeChildKill = null
      const ps = () => { psCalledBeforeChildKill = events.length === 0; return TABLE }
      killProcessTree(child, { ps, kill })
      assert.equal(psCalledBeforeChildKill, true, 'ps must run before the child is signalled — after it exits the ppid links are gone')
      assert.deepEqual(events, [['child', 'SIGTERM'], [300, 'SIGTERM'], [200, 'SIGTERM']])
    })

    it('force:true / forceKill send SIGKILL to the whole tree', () => {
      const a = harness()
      killProcessTree(a.child, { ps: () => TABLE, kill: a.kill, force: true })
      assert.deepEqual(a.events, [['child', 'SIGKILL'], [300, 'SIGKILL'], [200, 'SIGKILL']])
      const b = harness()
      forceKill(b.child, { ps: () => TABLE, kill: b.kill })
      assert.deepEqual(b.events, [['child', 'SIGKILL'], [300, 'SIGKILL'], [200, 'SIGKILL']])
    })

    it('never signals a process outside the tree', () => {
      const { events, child, kill } = harness()
      killProcessTree(child, { ps: () => TABLE, kill })
      assert.ok(!events.some(([pid]) => pid === 400 || pid === 1), JSON.stringify(events))
    })

    it('a descendant kill that throws (already gone) does not stop the rest', () => {
      const { events, child } = harness()
      const kill = (pid, sig) => { if (pid === 300) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); events.push([pid, sig]) }
      killProcessTree(child, { ps: () => TABLE, kill })
      assert.deepEqual(events, [['child', 'SIGTERM'], [200, 'SIGTERM']])
    })

    it('with no ps seam and a pid-less fake child, behaves exactly as before (direct kill only)', () => {
      const events = []
      killProcessTree({ kill: (sig) => events.push(sig) })
      assert.deepEqual(events, ['SIGTERM'])
    })

    // The real thing: sh -> node grandchild, kill the sh wrapper, the node
    // grandchild must die. `sh -c 'cmd; :'` forces sh to fork rather than
    // exec, so node really is a grandchild — the same shape as claude -> bash
    // -> `node --test` that leaked four 50 GB orphans (#7606).
    it('reaps the sh -> node grandchild on POSIX (#7606)', async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const isAlive = (pid) => {
        try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
      }
      const stamp = `${process.pid}-${Date.now()}`
      const pidFile = join(tmpdir(), `chroxy-treekill-${stamp}.pid`)
      const script = join(tmpdir(), `chroxy-treekill-${stamp}.cjs`)
      writeFileSync(
        script,
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e9)`,
      )
      const child = spawn('sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}; :`], { stdio: 'ignore' })
      let grandPid = null
      try {
        for (let i = 0; i < 150 && grandPid === null; i++) {
          try {
            const raw = readFileSync(pidFile, 'utf-8').trim()
            if (raw) grandPid = parseInt(raw, 10)
          } catch { /* not written yet */ }
          if (grandPid === null) await sleep(100)
        }
        assert.ok(Number.isInteger(grandPid) && grandPid > 0, 'grandchild should report a pid')
        assert.notEqual(grandPid, child.pid, 'sh must have forked, not exec\'d — otherwise this tests nothing')
        assert.ok(isAlive(grandPid), 'grandchild should be alive before forceKill')

        forceKill(child)

        let dead = false
        for (let i = 0; i < 80 && !dead; i++) {
          if (!isAlive(grandPid)) { dead = true; break }
          await sleep(100)
        }
        assert.ok(dead, 'forceKill must reap the node grandchild, not just the sh wrapper')
      } finally {
        try { forceKill(child) } catch {}
        try { if (grandPid) process.kill(grandPid, 'SIGKILL') } catch {}
        try { rmSync(script, { force: true }) } catch {}
        try { rmSync(pidFile, { force: true }) } catch {}
      }
    })
  })

  describe('forceKill()', () => {
    it('calls kill on the child object', () => {
      let killed = false
      let signal = null
      const fakeChild = {
        kill(sig) {
          killed = true
          signal = sig
        },
      }
      forceKill(fakeChild)
      assert.ok(killed)
      assert.strictEqual(signal, 'SIGKILL')
    })

    // #6643 — on Windows, forceKill must reap the WHOLE descendant tree, not
    // just the tracked pid. `.cmd` provider shims run under `cmd.exe /d /s /c`,
    // so the real node process is a GRANDCHILD; a naive TerminateProcess on the
    // cmd wrapper orphans it (still editing files / burning tokens after Stop).
    // Only validatable on a real Windows runner — spawn cmd.exe -> node, kill
    // the cmd wrapper, and assert the node grandchild dies too.
    it('reaps the whole child -> grandchild process tree on Windows (#6643)', { skip: !isWindows }, async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const isAlive = (pid) => {
        try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
      }
      const stamp = `${process.pid}-${Date.now()}`
      const pidFile = join(tmpdir(), `chroxy-treekill-${stamp}.pid`)
      const script = join(tmpdir(), `chroxy-treekill-${stamp}.cjs`)
      // Grandchild: record its own pid to a file, then stay alive.
      writeFileSync(
        script,
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e9)`,
      )
      // cmd.exe is the tracked child; `node <script>` is the grandchild — the
      // same shape as `cmd /c claude.cmd` -> node.
      const child = spawn('cmd.exe', ['/d', '/s', '/c', 'node', script], {
        stdio: 'ignore',
        windowsHide: true,
      })
      let grandPid = null
      try {
        // Wait (<=15s) for the grandchild to report its pid.
        for (let i = 0; i < 150 && grandPid === null; i++) {
          try {
            const raw = readFileSync(pidFile, 'utf-8').trim()
            if (raw) grandPid = parseInt(raw, 10)
          } catch { /* not written yet */ }
          if (grandPid === null) await sleep(100)
        }
        assert.ok(Number.isInteger(grandPid) && grandPid > 0, 'grandchild should report a pid')
        assert.ok(isAlive(grandPid), 'grandchild should be alive before forceKill')

        // Kill the tracked cmd wrapper — the node grandchild must die too.
        forceKill(child)

        let dead = false
        for (let i = 0; i < 80 && !dead; i++) {
          if (!isAlive(grandPid)) { dead = true; break }
          await sleep(100)
        }
        assert.ok(dead, 'forceKill must reap the node grandchild, not just the cmd wrapper')
      } finally {
        try { forceKill(child) } catch {}
        // Defensive: if the fix regressed and the grandchild survived, don't
        // leak a live node orphan on the runner.
        try { if (grandPid) process.kill(grandPid, 'SIGKILL') } catch {}
        try { rmSync(script, { force: true }) } catch {}
        try { rmSync(pidFile, { force: true }) } catch {}
      }
    })
  })

  describe('writeFileRestricted — Windows ACL + rename retry (#6644)', () => {
    let dir
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wfr-acl-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('stamps the owner-only ACL on the temp file before rename (Windows branch)', () => {
      const filePath = join(dir, 'sec.json')
      const stamped = []
      writeFileRestricted(filePath, 'secret', {
        _isWindowsOverride: true,
        _stampAcl: (p) => stamped.push(p),
      })
      // The DACL is stamped on the TEMP path — NTFS preserves it across the
      // same-dir rename, so the final file lands owner-only with no window.
      assert.deepEqual(stamped, [`${filePath}.tmp`])
      assert.equal(readFileSync(filePath, 'utf-8'), 'secret')
    })

    it('does NOT stamp an ACL on the POSIX branch (chmod handles it)', () => {
      const filePath = join(dir, 'sec-posix.json')
      const stamped = []
      writeFileRestricted(filePath, 'secret', {
        _isWindowsOverride: false,
        _stampAcl: (p) => stamped.push(p),
      })
      assert.equal(stamped.length, 0)
      assert.equal(readFileSync(filePath, 'utf-8'), 'secret')
    })

    it('retries the rename once on a Windows AV/Search lock (EBUSY) and succeeds', () => {
      const filePath = join(dir, 'sec-retry.json')
      let calls = 0
      writeFileRestricted(filePath, 'secret', {
        _isWindowsOverride: true,
        _stampAcl: () => {},
        _rename: (from, to) => {
          calls++
          if (calls === 1) { const e = new Error('locked'); e.code = 'EBUSY'; throw e }
          renameSync(from, to) // the retry actually moves it
        },
      })
      assert.equal(calls, 2, 'one failure + one successful retry')
      assert.equal(readFileSync(filePath, 'utf-8'), 'secret')
    })

    it('rethrows the original error and cleans up the temp file if the retry also fails', () => {
      const filePath = join(dir, 'sec-fail.json')
      let calls = 0
      assert.throws(() => writeFileRestricted(filePath, 'secret', {
        _isWindowsOverride: true,
        _stampAcl: () => {},
        _rename: () => { calls++; const e = new Error('still locked'); e.code = 'EPERM'; throw e },
      }), /still locked/)
      assert.equal(calls, 2, 'original attempt + one retry, both fail')
      assert.equal(existsSync(`${filePath}.tmp`), false, 'orphaned temp cleaned up')
    })

    it('does NOT retry on a non-retryable rename error', () => {
      const filePath = join(dir, 'sec-nospc.json')
      let calls = 0
      assert.throws(() => writeFileRestricted(filePath, 'secret', {
        _isWindowsOverride: true,
        _stampAcl: () => {},
        _rename: () => { calls++; const e = new Error('disk full'); e.code = 'ENOSPC'; throw e },
      }), /disk full/)
      assert.equal(calls, 1, 'non-retryable code → no retry')
    })
  })
})
