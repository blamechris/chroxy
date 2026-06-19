import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmDirRobust } from './test-helpers.js'

/**
 * #6114 — rmDirRobust re-recurses on the transient gc-race teardown codes so a
 * loose object git background gc writes AFTER the recursive walk passed its
 * subtree (the failure mode plain `rmSync(RM_RETRY)` can't recover, because its
 * internal retry only re-attempts the failing rmdir, never re-walks) is cleared
 * on the next pass.
 *
 * The race itself only reproduces under load on the self-hosted Linux runner, so
 * the re-recurse LOGIC is covered deterministically here via the `_rm` / `_sleep`
 * injection seams; a real-filesystem happy-path test proves it actually removes a
 * populated tree.
 */
describe('rmDirRobust (#6114)', () => {
  it('removes a populated directory tree on the real filesystem (happy path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-rmdir-'))
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x')
    writeFileSync(join(dir, 'top.txt'), 'y')
    rmDirRobust(dir)
    assert.equal(existsSync(dir), false)
  })

  it('re-recurses after a transient ENOTEMPTY, then succeeds (the gc-race fix)', () => {
    let calls = 0
    let slept = 0
    // Fail the first two attempts with ENOTEMPTY (gc re-created an object), then
    // succeed — exactly the dropped-flush-then-settled pattern.
    const _rm = () => {
      calls++
      if (calls <= 2) {
        const err = new Error("ENOTEMPTY: directory not empty, rmdir '/tmp/x/.git'")
        err.code = 'ENOTEMPTY'
        throw err
      }
    }
    rmDirRobust('/tmp/x', { _rm, _sleep: () => { slept++ } })
    assert.equal(calls, 3, 'should re-walk until the rm succeeds')
    assert.equal(slept, 2, 'should back off once per failed attempt')
  })

  it('surfaces a non-transient error immediately (no re-recurse on EACCES)', () => {
    let calls = 0
    const _rm = () => {
      calls++
      const err = new Error("EACCES: permission denied, rmdir '/tmp/locked'")
      err.code = 'EACCES'
      throw err
    }
    assert.throws(() => rmDirRobust('/tmp/locked', { _rm, _sleep: () => {} }), /EACCES/)
    assert.equal(calls, 1, 'a genuine error must not trigger the retry loop')
  })

  it('gives up (throws) after `attempts` persistent transient failures', () => {
    let calls = 0
    const _rm = () => {
      calls++
      const err = new Error('ENOTEMPTY: directory not empty')
      err.code = 'ENOTEMPTY'
      throw err
    }
    assert.throws(() => rmDirRobust('/tmp/busy', { attempts: 4, _rm, _sleep: () => {} }), /ENOTEMPTY/)
    assert.equal(calls, 4, 'should attempt exactly `attempts` times, then surface the failure')
  })
})
