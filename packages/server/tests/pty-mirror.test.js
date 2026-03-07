import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * PtyMirror tests — exercises the class API.
 * node-pty may or may not be available; tests adapt accordingly.
 */

describe('PtyMirror', () => {
  let PtyMirror

  before(async () => {
    const mod = await import('../src/pty-mirror.js')
    PtyMirror = mod.PtyMirror
  })

  it('exports PtyMirror class', () => {
    assert.ok(PtyMirror)
    assert.equal(typeof PtyMirror, 'function')
  })

  it('has static available property', () => {
    // May be true or false depending on whether node-pty is installed
    assert.equal(typeof PtyMirror.available, 'boolean')
  })

  it('creates instance with default options', () => {
    const mirror = new PtyMirror({})
    assert.equal(mirror.alive, false)
    assert.equal(mirror.pid, null)
    assert.deepEqual(mirror.dimensions, { cols: 120, rows: 40 })
  })

  it('creates instance with custom options', () => {
    const mirror = new PtyMirror({ cols: 80, rows: 24, cwd: '/tmp' })
    assert.deepEqual(mirror.dimensions, { cols: 80, rows: 24 })
  })

  it('emits error when node-pty is not available and spawn is called', () => {
    // This test only runs when node-pty is NOT available
    if (PtyMirror.available) {
      // Skip — node-pty is installed, can't test unavailable path easily
      return
    }
    const mirror = new PtyMirror({})
    const errors = []
    mirror.on('error', (e) => errors.push(e))
    const result = mirror.spawn()
    assert.equal(result, false)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('node-pty'))
  })

  it('refuses to spawn twice when process exists', () => {
    if (!PtyMirror.available) return

    const mirror = new PtyMirror({ cwd: process.cwd() })
    // Listen for errors (spawn may fail if `claude` binary not found)
    const errors = []
    mirror.on('error', (e) => errors.push(e))

    const result1 = mirror.spawn()
    if (!result1) return // claude binary not found, skip

    const result2 = mirror.spawn()
    assert.equal(result2, false)
    assert.ok(errors.some(e => e.message.includes('already spawned')))
    mirror.destroy()
  })

  it('refuses to spawn after destroy', () => {
    const mirror = new PtyMirror({})
    mirror.destroy()
    const errors = []
    mirror.on('error', (e) => errors.push(e))
    const result = mirror.spawn()
    assert.equal(result, false)
    assert.ok(errors.some(e => e.message.includes('destroyed')))
  })

  it('destroy is idempotent', () => {
    const mirror = new PtyMirror({})
    mirror.destroy()
    mirror.destroy() // Should not throw
    assert.equal(mirror.alive, false)
  })

  it('write is a no-op when not spawned', () => {
    const mirror = new PtyMirror({})
    // Should not throw
    mirror.write('test')
    assert.equal(mirror.alive, false)
  })

  it('resize is a no-op when not spawned', () => {
    const mirror = new PtyMirror({})
    // Should not throw
    mirror.resize(80, 24)
    // Dimensions update even without a process
    assert.equal(mirror.alive, false)
  })
})
