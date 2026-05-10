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

  it('register() strips orphan chroxy entries that lost the _chroxy flag (#3714)', async () => {
    // Simulate the bad state we found in the wild: multiple chroxy
    // permission-hook.sh entries without the _chroxy:true marker, plus
    // potentially a properly-marked one. The legacy filter
    // (`!entry._chroxy`) only catches the marked one, so the orphans
    // accumulate forever and cause every Bash call to trigger 3+
    // simultaneous /permission requests → timeouts → "Hook ... asked
    // for confirmation" surfaced to the user instead of the prompt UI.
    const settingsPath = join(tempDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          // Two orphans (no _chroxy flag) pointing at the chroxy install path
          { matcher: '', hooks: [{ type: 'command', command: '/Applications/Chroxy.app/Contents/Resources/server/hooks/permission-hook.sh', timeout: 300 }] },
          { matcher: '', hooks: [{ type: 'command', command: '/Applications/Chroxy.app/Contents/Resources/server/hooks/permission-hook.sh', timeout: 300 }] },
          // A properly-marked one
          { _chroxy: true, matcher: '', hooks: [{ type: 'command', command: '/Applications/Chroxy.app/Contents/Resources/server/hooks/permission-hook.sh', timeout: 300 }] },
          // An unrelated user hook that must NOT be touched
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    }))

    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    // After register: exactly one chroxy entry (the freshly added one),
    // plus the user's unrelated hook. The 3 prior chroxy entries (orphans
    // + marked) are all stripped before re-adding.
    const chroxyEntries = settings.hooks.PreToolUse.filter(e => e._chroxy)
    assert.equal(chroxyEntries.length, 1, 'exactly one chroxy entry after orphan cleanup')
    assert.equal(settings.hooks.PreToolUse.length, 2, 'unrelated user hook preserved')
    const userHook = settings.hooks.PreToolUse.find(e => !e._chroxy)
    assert.equal(userHook.matcher, 'Bash', 'user hook untouched')
    assert.equal(userHook.hooks[0].command, 'echo hi')

    manager.destroy()
  })

  it('register() strips orphan chroxy entries with Windows-style backslash paths (#3715 review)', async () => {
    // The path-match regex accepts both `/` and `\\` separators so the
    // orphan cleanup works regardless of which separator the previous
    // chroxy install used to write the entry. (Earlier draft of the
    // predicate had a forward-slash-only `includes()` pre-filter that
    // would have skipped this entry — Copilot caught it.)
    const settingsPath = join(tempDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'C:\\Program Files\\chroxy\\packages\\server\\hooks\\permission-hook.sh' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    }))

    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const chroxyEntries = settings.hooks.PreToolUse.filter(e => e._chroxy)
    assert.equal(chroxyEntries.length, 1, 'orphan with backslash path was stripped, then a single marked entry was added')
    const userHook = settings.hooks.PreToolUse.find(e => !e._chroxy)
    assert.equal(userHook.hooks[0].command, 'echo hi', 'unrelated user hook preserved')

    manager.destroy()
  })

  it('register() does not strip user hooks that share the basename but live elsewhere (#3714)', async () => {
    // Defensive: the path-match arm must require the chroxy install layout,
    // not just the basename. A user with their own permission-hook.sh in
    // an unrelated path should keep it untouched.
    const settingsPath = join(tempDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: '/home/user/dotfiles/hooks/permission-hook.sh' }] },
        ],
      },
    }))

    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks.PreToolUse.length, 2, 'user hook preserved + chroxy hook added')
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, '/home/user/dotfiles/hooks/permission-hook.sh')
    assert.equal(settings.hooks.PreToolUse[1]._chroxy, true)

    manager.destroy()
  })

  it('unregister() also strips orphan chroxy entries (#3714)', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: '/Applications/Chroxy.app/Contents/Resources/server/hooks/permission-hook.sh' }] },
          { matcher: '', hooks: [{ type: 'command', command: '/Applications/Chroxy.app/Contents/Resources/server/hooks/permission-hook.sh' }] },
        ],
      },
    }))

    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.unregister()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    // Both orphans removed; hooks key cleaned up since empty.
    assert.equal(settings.hooks, undefined)

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

  it('destroy() returns a promise', async () => {
    const manager = createPermissionHookManager(emitter)
    const result = manager.destroy()
    assert.ok(result instanceof Promise, 'destroy() should return a Promise')
    await result
  })

  it('destroy() before register completes leaves no hook in settings (race guard)', async () => {
    // Simulate the race: register() acquires lock slot, destroy() fires while
    // still in the queue, then the lock is finally executed.
    const settingsPath = join(tempDir, 'settings.json')

    // Hold the settings lock with a slow operation
    let releaseLock
    const lockHeld = new Promise((resolve) => { releaseLock = resolve })

    // Grab the lock first so register() must queue
    const { withSettingsLock: lockFn } = await import('../src/permission-hook.js')
    const blocker = lockFn(() => lockHeld)

    const manager = createPermissionHookManager(emitter, { settingsPath })

    // Fire register() — it queues behind the blocker
    const registerPromise = manager.register()

    // Call destroy() while register is still pending
    const destroyPromise = manager.destroy()

    // Release the lock — register() and then unregister() will run in sequence
    releaseLock()
    await blocker.catch(() => {})
    await registerPromise.catch(() => {})
    await destroyPromise

    // The hook should NOT be present — either register was skipped or
    // destroy's chained unregister cleaned it up
    let settings = {}
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      // File may not exist if register was fully skipped — that's fine
    }
    const hooks = settings.hooks?.PreToolUse || []
    const chrHooks = hooks.filter((h) => h._chroxy)
    assert.equal(chrHooks.length, 0, 'No dead chroxy hook should remain after destroy-during-register race')
  })

  it('destroy() after register completes still removes hook cleanly', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    const manager = createPermissionHookManager(emitter, { settingsPath })

    await manager.register()

    // Hook should be present
    let settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(settings.hooks.PreToolUse.length, 1, 'Hook registered')

    // Normal destroy — chains unregister after completed register
    await manager.destroy()

    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const chrHooks = (settings.hooks?.PreToolUse || []).filter((h) => h._chroxy)
    assert.equal(chrHooks.length, 0, 'Hook removed by destroy()')
  })

  it('destroying flag prevents register write when lock was contended', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    const manager = createPermissionHookManager(emitter, { settingsPath })

    // Manually set destroying before register fires inside the lock
    // to simulate the exact scenario described in issue #2365
    let releaseLock
    const lockHeld = new Promise((resolve) => { releaseLock = resolve })
    const { withSettingsLock: lockFn } = await import('../src/permission-hook.js')
    const blocker = lockFn(() => lockHeld)

    // register() queues
    const registerPromise = manager.register()

    // destroy() sets destroying = true immediately
    const destroyPromise = manager.destroy()

    // Release blocker — register callback runs with destroying = true,
    // should skip the write
    releaseLock()
    await blocker.catch(() => {})
    await registerPromise.catch(() => {})
    await destroyPromise

    let settings = {}
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      // No file created — register was skipped entirely (best case)
    }
    const hooks = settings.hooks?.PreToolUse || []
    assert.equal(hooks.filter((h) => h._chroxy).length, 0,
      'destroy() during contended register must not leave a dead hook')
  })
})
