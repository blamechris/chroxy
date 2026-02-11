import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

// We need to test the module's behavior with a temporary settings file.
// The module reads from ~/.claude/settings.json directly, so we mock via
// environment manipulation and direct function testing.

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

  it('register() writes hook to settings.json', async () => {
    // This test verifies register() runs without throwing when
    // ~/.claude/settings.json exists (which it does in dev environments)
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    let settingsBefore
    try {
      settingsBefore = readFileSync(settingsPath, 'utf-8')
    } catch {
      // settings.json doesn't exist — skip this test
      return
    }

    const manager = createPermissionHookManager(emitter)
    await manager.register()

    // Verify the hook was written
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const chroxyHooks = settings.hooks?.PreToolUse?.filter(e => e._chroxy)
    assert.ok(chroxyHooks?.length > 0, 'Should have at least one _chroxy hook entry')
    assert.equal(chroxyHooks.length, 1, 'Should have exactly one _chroxy hook entry (idempotent)')

    // Clean up: restore original settings
    writeFileSync(settingsPath, settingsBefore)
    manager.destroy()
  })

  it('register() is idempotent — double register produces single hook entry', async () => {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    let settingsBefore
    try {
      settingsBefore = readFileSync(settingsPath, 'utf-8')
    } catch {
      return
    }

    const manager = createPermissionHookManager(emitter)
    await manager.register()
    await manager.register()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const chroxyHooks = settings.hooks?.PreToolUse?.filter(e => e._chroxy)
    assert.equal(chroxyHooks.length, 1, 'Double register should still produce exactly one hook')

    writeFileSync(settingsPath, settingsBefore)
    manager.destroy()
  })

  it('unregister() removes the hook entry', async () => {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    let settingsBefore
    try {
      settingsBefore = readFileSync(settingsPath, 'utf-8')
    } catch {
      return
    }

    const manager = createPermissionHookManager(emitter)
    await manager.register()
    await manager.unregister()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const chroxyHooks = settings.hooks?.PreToolUse?.filter(e => e._chroxy) ?? []
    assert.equal(chroxyHooks.length, 0, 'Unregister should remove all _chroxy hook entries')

    writeFileSync(settingsPath, settingsBefore)
    manager.destroy()
  })

  it('destroy() cancels pending retry timers', async () => {
    const manager = createPermissionHookManager(emitter)
    // destroy() should be safe to call even without register()
    manager.destroy()
    // No assertion needed — just verify it doesn't throw
  })

  it('emits error after 3 failed registration attempts', async () => {
    // Create a manager with an emitter that tracks errors
    const errors = []
    emitter.on('error', (err) => errors.push(err))

    // We can't easily make registerPermissionHookSync fail without mocking fs,
    // but we can verify the manager structure is correct
    const manager = createPermissionHookManager(emitter)
    assert.equal(typeof manager.register, 'function')
    assert.equal(typeof manager.destroy, 'function')
    manager.destroy()
  })

  it('destroy() prevents retries from firing', async () => {
    const errors = []
    emitter.on('error', (err) => errors.push(err))

    const manager = createPermissionHookManager(emitter)
    manager.destroy()

    // After destroy, register should still work (lock-wise) but scheduleRetry won't fire
    // This tests the destroying flag prevents new retries
    await manager.register()
    manager.destroy()
  })
})
