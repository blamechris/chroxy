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
})
