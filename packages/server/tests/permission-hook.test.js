import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// Lock serialization and manager lifecycle are tested without filesystem access.
// Tests that exercise register/unregister against settings.json require a
// configurable settings path to avoid contaminating ~/.claude/settings.json
// on the host machine (see #429).

// Import the module under test
import { withSettingsLock, createPermissionHookManager } from '../src/permission-hook.js'

describe('withSettingsLock', () => {
  it('executes a synchronous function', async () => {
    let called = false
    await withSettingsLock(() => { called = true })
    assert.equal(called, true)
  })

  it('executes an async function', async () => {
    let called = false
    await withSettingsLock(async () => {
      await new Promise(r => setTimeout(r, 10))
      called = true
    })
    assert.equal(called, true)
  })

  it('returns the function result', async () => {
    const result = await withSettingsLock(() => 42)
    assert.equal(result, 42)
  })

  it('propagates errors', async () => {
    await assert.rejects(
      () => withSettingsLock(() => { throw new Error('test error') }),
      { message: 'test error' }
    )
  })

  it('serializes concurrent calls', async () => {
    const order = []
    const p1 = withSettingsLock(async () => {
      order.push('start-1')
      await new Promise(r => setTimeout(r, 50))
      order.push('end-1')
    })
    const p2 = withSettingsLock(async () => {
      order.push('start-2')
      await new Promise(r => setTimeout(r, 10))
      order.push('end-2')
    })
    await Promise.all([p1, p2])
    assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2'])
  })

  it('continues after a failed lock holder', async () => {
    const p1 = withSettingsLock(() => { throw new Error('fail') }).catch(() => {})
    let called = false
    const p2 = withSettingsLock(() => { called = true })
    await Promise.all([p1, p2])
    assert.equal(called, true, 'Second lock holder should still execute after first fails')
  })
})

describe('createPermissionHookManager', () => {
  let emitter

  beforeEach(() => {
    emitter = new EventEmitter()
  })

  it('returns an object with register, unregister, and destroy methods', () => {
    const manager = createPermissionHookManager(emitter)
    assert.equal(typeof manager.register, 'function')
    assert.equal(typeof manager.unregister, 'function')
    assert.equal(typeof manager.destroy, 'function')
  })

  // NOTE: register()/unregister()/idempotency tests removed — they wrote to
  // the real ~/.claude/settings.json and contaminated other running sessions.
  // These will return once #429 lands a configurable settingsPath parameter.

  it('destroy() does not throw when called without register()', async () => {
    const manager = createPermissionHookManager(emitter)
    manager.destroy()
    // Verifies destroy() is safe to call before any registration
  })

  it('supports error listener wiring on the emitter', async () => {
    // Verify the emitter accepts an error listener without throwing.
    // Actual error-path testing (retry failures, fs errors) requires
    // fs mocking — tracked in #430.
    const errors = []
    emitter.on('error', (err) => errors.push(err))

    const manager = createPermissionHookManager(emitter)
    assert.equal(typeof manager.register, 'function')
    assert.equal(typeof manager.destroy, 'function')
    manager.destroy()
  })

  it('destroy() is safe to call multiple times', async () => {
    const manager = createPermissionHookManager(emitter)
    manager.destroy()
    manager.destroy() // should not throw
  })
})
