import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'node:url'
import { defaultShell, writeFileRestricted, forceKill, isWindows } from '../src/platform.js'

const PLATFORM_JS = resolve(fileURLToPath(import.meta.url), '../../src/platform.js')

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
import { writeFileRestricted } from ${JSON.stringify(PLATFORM_JS)}
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

        const result = spawnSync(process.execPath, ['--import', shim, runner], { encoding: 'utf-8' })
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
import { writeFileRestricted } from ${JSON.stringify(PLATFORM_JS)}
try {
  writeFileRestricted(${JSON.stringify(filePath)}, 'payload', { tmpSuffix: '.tmp-12345' })
  process.exit(0)
} catch {
  process.exit(2)
}
`
        writeFileRestricted(shim, shimSrc)
        writeFileRestricted(runner, runnerSrc)
        const result = spawnSync(process.execPath, ['--import', shim, runner], { encoding: 'utf-8' })
        assert.strictEqual(result.status, 2, `expected non-zero exit; stderr=${result.stderr}`)

        const observed = readFileSync(sentinelPath, 'utf-8')
        assert.strictEqual(observed, `${filePath}.tmp-12345`, 'tmpSuffix must drive the intermediate path')
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
    }
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
  })
})
