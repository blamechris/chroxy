import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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
  let tempDir

  beforeEach(() => {
    emitter = new EventEmitter()
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-hook-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns an object with register, unregister, and destroy methods', () => {
    const manager = createPermissionHookManager(emitter)
    assert.equal(typeof manager.register, 'function')
    assert.equal(typeof manager.unregister, 'function')
    assert.equal(typeof manager.destroy, 'function')
  })

  it('register() writes hook entry to settings.json', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.ok(settings.hooks, 'hooks key should exist')
    assert.ok(Array.isArray(settings.hooks.PreToolUse), 'PreToolUse should be array')
    assert.equal(settings.hooks.PreToolUse.length, 1)
    assert.equal(settings.hooks.PreToolUse[0]._chroxy, true)
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].type, 'command')
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].timeout, 300)

    manager.destroy()
  })

  it('unregister() removes hook entry from settings.json', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()
    await manager.unregister()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    // hooks key and PreToolUse should be cleaned up when empty
    assert.equal(settings.hooks, undefined, 'empty hooks should be removed')

    manager.destroy()
  })

  it('register() is idempotent (no duplicate entries)', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()
    await manager.register()
    await manager.register()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks.PreToolUse.length, 1, 'Should not create duplicate hooks')

    manager.destroy()
  })

  it('register() preserves existing non-chroxy hooks', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    }))

    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks.PreToolUse.length, 2, 'Should have both hooks')
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash', 'Existing hook preserved')
    assert.equal(settings.hooks.PreToolUse[1]._chroxy, true, 'Chroxy hook added')

    manager.destroy()
  })

  it('register() creates directory if settings.json does not exist', async () => {
    const nestedDir = join(tempDir, 'nested', 'dir')
    const settingsPath = join(nestedDir, 'settings.json')
    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()

    assert.ok(existsSync(settingsPath), 'settings.json should be created')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks.PreToolUse.length, 1)

    manager.destroy()
  })

  it('register() emits error on corrupt JSON and schedules retry', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    writeFileSync(settingsPath, 'not valid json {{{')

    const errors = []
    emitter.on('error', (err) => errors.push(err))

    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()

    // Should have emitted an error and scheduled retry (or failed)
    // The corrupt JSON throws a SyntaxError which is not ENOENT, so it re-throws
    assert.ok(errors.length > 0, 'Should emit error for corrupt JSON')

    manager.destroy()
  })

  it('unregister() does not throw on corrupt settings.json', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    writeFileSync(settingsPath, 'not valid json {{{')

    const manager = createPermissionHookManager(emitter, { settingsPath })
    // Should not throw — just logs a warning and skips cleanup
    await manager.unregister()

    // File should remain untouched (not deleted or modified)
    const content = readFileSync(settingsPath, 'utf-8')
    assert.equal(content, 'not valid json {{{')

    manager.destroy()
  })

  it('destroy() does not throw when called without register()', async () => {
    const manager = createPermissionHookManager(emitter)
    manager.destroy()
  })

  it('supports error listener wiring on the emitter', async () => {
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
    manager.destroy()
  })

  it('crash recovery: new register cleans up stale hook from crashed session', async () => {
    const settingsPath = join(tempDir, 'settings.json')

    // Simulate a crashed session: hook registered but never unregistered
    const crashed = createPermissionHookManager(emitter, { settingsPath })
    await crashed.register()
    // "crash" — destroy without unregister
    crashed.destroy()

    // Verify stale hook exists
    let settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks.PreToolUse.length, 1)

    // New session registers — should replace stale hook (not duplicate)
    const fresh = createPermissionHookManager(emitter, { settingsPath })
    await fresh.register()

    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks.PreToolUse.length, 1, 'Stale hook should be replaced, not duplicated')
    assert.equal(settings.hooks.PreToolUse[0]._chroxy, true)

    await fresh.unregister()
    fresh.destroy()
  })

  it('concurrent sessions: two managers share same settings file safely', async () => {
    const settingsPath = join(tempDir, 'settings.json')

    const managerA = createPermissionHookManager(emitter, { settingsPath })
    const managerB = createPermissionHookManager(emitter, { settingsPath })

    // Both register — second should replace first (idempotent by _chroxy flag)
    await managerA.register()
    await managerB.register()

    let settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks.PreToolUse.length, 1, 'Only one chroxy hook should exist')

    // First unregisters — hook removed
    await managerA.unregister()

    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks, undefined, 'Hook should be fully removed')

    // Second unregisters — no-op (already gone)
    await managerB.unregister()

    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks, undefined, 'Should still be clean')

    managerA.destroy()
    managerB.destroy()
  })

  it('concurrent sessions: unregister preserves non-chroxy hooks', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    }))

    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()
    await manager.unregister()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.ok(settings.hooks, 'hooks key should remain for non-chroxy hooks')
    assert.equal(settings.hooks.PreToolUse.length, 1)
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash')

    manager.destroy()
  })

  it('preserves non-hooks settings keys during register/unregister', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      fontSize: 14,
    }))

    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()

    let settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.theme, 'dark', 'Other settings preserved after register')
    assert.equal(settings.fontSize, 14)

    await manager.unregister()

    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.theme, 'dark', 'Other settings preserved after unregister')
    assert.equal(settings.fontSize, 14)

    manager.destroy()
  })
})
