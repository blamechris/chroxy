import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSpy, createMockSession, createMockSessionManager, withEnv, nsCtx, makeSessionIndexCtx, assertCtxShape } from './test-helpers.js'
import { CTX_NAMESPACE_NAMES, CTX_NAMESPACES } from '../src/ws-handler-context.js'
import { EventEmitter } from 'node:events'

describe('createSpy', () => {
  it('records calls and arguments', () => {
    const spy = createSpy()
    spy('a', 1)
    spy('b', 2)
    assert.equal(spy.callCount, 2)
    assert.deepStrictEqual(spy.calls[0], ['a', 1])
    assert.deepStrictEqual(spy.calls[1], ['b', 2])
  })

  it('tracks lastCall', () => {
    const spy = createSpy()
    assert.equal(spy.lastCall, null)
    spy('first')
    assert.deepStrictEqual(spy.lastCall, ['first'])
    spy('second')
    assert.deepStrictEqual(spy.lastCall, ['second'])
  })

  it('returns undefined by default', () => {
    const spy = createSpy()
    assert.equal(spy(), undefined)
  })

  it('uses provided implementation for return value', () => {
    const spy = createSpy((x) => x * 2)
    assert.equal(spy(5), 10)
    assert.equal(spy.callCount, 1)
  })

  it('resets recorded calls', () => {
    const spy = createSpy()
    spy('a')
    spy('b')
    assert.equal(spy.callCount, 2)
    spy.reset()
    assert.equal(spy.callCount, 0)
    assert.deepStrictEqual(spy.calls, [])
    assert.equal(spy.lastCall, null)
  })

  it('records calls with no arguments', () => {
    const spy = createSpy()
    spy()
    assert.deepStrictEqual(spy.calls[0], [])
  })
})

describe('createMockSession', () => {
  it('extends EventEmitter', () => {
    const session = createMockSession()
    assert.ok(session instanceof EventEmitter)
  })

  it('has default properties', () => {
    const session = createMockSession()
    assert.equal(session.isReady, true)
    assert.equal(session.model, 'claude-sonnet-4-6')
    assert.equal(session.permissionMode, 'approve')
  })

  it('has spy methods', () => {
    const session = createMockSession()
    session.sendMessage('hello')
    assert.equal(session.sendMessage.callCount, 1)
    assert.deepStrictEqual(session.sendMessage.lastCall, ['hello'])
  })

  it('spy methods are independent', () => {
    const session = createMockSession()
    session.setModel('opus')
    session.setPermissionMode('auto')
    assert.equal(session.setModel.callCount, 1)
    assert.equal(session.setPermissionMode.callCount, 1)
    assert.deepStrictEqual(session.setModel.lastCall, ['opus'])
    assert.deepStrictEqual(session.setPermissionMode.lastCall, ['auto'])
  })

  it('accepts overrides', () => {
    const session = createMockSession({
      sendMessage: createSpy(() => 'custom'),
      model: 'claude-opus-4-7',
    })
    assert.equal(session.sendMessage('test'), 'custom')
    assert.equal(session.model, 'claude-opus-4-7')
  })

  it('includes respondToQuestion and respondToPermission spies', () => {
    const session = createMockSession()
    session.respondToQuestion('yes')
    session.respondToPermission('req-1', 'allow')
    assert.equal(session.respondToQuestion.callCount, 1)
    assert.deepStrictEqual(session.respondToPermission.lastCall, ['req-1', 'allow'])
  })

  it('emits events normally', () => {
    const session = createMockSession()
    let received = null
    session.on('test', (data) => { received = data })
    session.emit('test', 'payload')
    assert.equal(received, 'payload')
  })
})

describe('createMockSessionManager', () => {
  it('extends EventEmitter', () => {
    const { manager } = createMockSessionManager()
    assert.ok(manager instanceof EventEmitter)
  })

  it('creates empty manager by default', () => {
    const { manager, sessionsMap } = createMockSessionManager()
    assert.equal(sessionsMap.size, 0)
    assert.deepStrictEqual(manager.listSessions(), [])
    assert.equal(manager.firstSessionId, null)
  })

  it('populates sessions from input array', () => {
    const sessions = [
      { id: 's1', name: 'Session 1', cwd: '/home' },
      { id: 's2', name: 'Session 2', cwd: '/tmp', isRunning: true },
    ]
    const { manager, sessionsMap } = createMockSessionManager(sessions)
    assert.equal(sessionsMap.size, 2)
    assert.ok(sessionsMap.has('s1'))
    assert.ok(sessionsMap.has('s2'))
    assert.equal(manager.firstSessionId, 's1')
  })

  it('getSession returns entry from sessionsMap', () => {
    const { manager } = createMockSessionManager([
      { id: 's1', name: 'Test', cwd: '/tmp' },
    ])
    const entry = manager.getSession('s1')
    assert.ok(entry)
    assert.equal(entry.name, 'Test')
    assert.equal(entry.cwd, '/tmp')
    assert.equal(manager.getSession('nonexistent'), undefined)
  })

  it('listSessions returns session metadata', () => {
    const { manager } = createMockSessionManager([
      { id: 's1', name: 'A', cwd: '/a', type: 'sdk', isRunning: true },
    ])
    const list = manager.listSessions()
    assert.equal(list.length, 1)
    assert.equal(list[0].sessionId, 's1')
    assert.equal(list[0].name, 'A')
    assert.equal(list[0].type, 'sdk')
    assert.equal(list[0].isBusy, true)
  })

  it('has default stub methods', () => {
    const { manager } = createMockSessionManager()
    assert.deepStrictEqual(manager.getHistory(), [])
    assert.equal(manager.isBudgetPaused(), false)
  })

  it('overrides simple methods', () => {
    const { manager } = createMockSessionManager([], {
      getHistory: () => ['entry1'],
    })
    assert.deepStrictEqual(manager.getHistory(), ['entry1'])
  })

  it('overrides getter-only properties like firstSessionId', () => {
    const { manager } = createMockSessionManager(
      [{ id: 's1', name: 'A', cwd: '/a' }],
      { firstSessionId: () => 'custom-id' },
    )
    assert.equal(manager.firstSessionId, 'custom-id')
  })

  it('session entries contain mock sessions with spy methods', () => {
    const { sessionsMap } = createMockSessionManager([
      { id: 's1', name: 'Test', cwd: '/tmp' },
    ])
    const entry = sessionsMap.get('s1')
    entry.session.sendMessage('hello')
    assert.equal(entry.session.sendMessage.callCount, 1)
  })

  it('emits events normally', () => {
    const { manager } = createMockSessionManager()
    let received = null
    manager.on('test', (data) => { received = data })
    manager.emit('test', 'payload')
    assert.equal(received, 'payload')
  })
})

describe('withEnv', () => {
  const TEST_KEY = 'CHROXY_TEST_WITH_ENV_KEY'

  it('applies overrides inside fn and restores afterwards (sync)', () => {
    delete process.env[TEST_KEY]
    const result = withEnv({ [TEST_KEY]: 'inside' }, () => {
      assert.equal(process.env[TEST_KEY], 'inside')
      return 42
    })
    assert.equal(result, 42)
    assert.equal(process.env[TEST_KEY], undefined)
  })

  it('restores the prior value (not just deletes) when key pre-existed', () => {
    process.env[TEST_KEY] = 'original'
    try {
      withEnv({ [TEST_KEY]: 'override' }, () => {
        assert.equal(process.env[TEST_KEY], 'override')
      })
      assert.equal(process.env[TEST_KEY], 'original')
    } finally {
      delete process.env[TEST_KEY]
    }
  })

  it('deletes the key when override is undefined', () => {
    process.env[TEST_KEY] = 'start'
    try {
      withEnv({ [TEST_KEY]: undefined }, () => {
        assert.equal(process.env[TEST_KEY], undefined)
      })
      assert.equal(process.env[TEST_KEY], 'start')
    } finally {
      delete process.env[TEST_KEY]
    }
  })

  it('restores env after sync fn throws', () => {
    delete process.env[TEST_KEY]
    assert.throws(() => {
      withEnv({ [TEST_KEY]: 'boom' }, () => {
        assert.equal(process.env[TEST_KEY], 'boom')
        throw new Error('sync boom')
      })
    }, /sync boom/)
    assert.equal(process.env[TEST_KEY], undefined)
  })

  it('awaits async fn before restoring env', async () => {
    delete process.env[TEST_KEY]
    const p = withEnv({ [TEST_KEY]: 'async-inside' }, async () => {
      await new Promise(r => setTimeout(r, 5))
      // still inside the async fn — env must still be set
      assert.equal(process.env[TEST_KEY], 'async-inside')
      return 'async-result'
    })
    // before awaiting, env should still be set (Promise not yet resolved)
    assert.equal(process.env[TEST_KEY], 'async-inside')
    const result = await p
    assert.equal(result, 'async-result')
    assert.equal(process.env[TEST_KEY], undefined)
  })

  it('restores env after async fn rejects', async () => {
    delete process.env[TEST_KEY]
    await assert.rejects(
      withEnv({ [TEST_KEY]: 'reject-inside' }, async () => {
        await new Promise(r => setTimeout(r, 5))
        throw new Error('async boom')
      }),
      /async boom/,
    )
    assert.equal(process.env[TEST_KEY], undefined)
  })
})

// #5558: namespaced handler-ctx builder + shape assert
describe('nsCtx', () => {
  it('creates all five namespace buckets even when empty', () => {
    const ctx = nsCtx()
    for (const ns of CTX_NAMESPACE_NAMES) {
      assert.ok(ctx[ns] && typeof ctx[ns] === 'object', `missing namespace ${ns}`)
    }
  })

  it('routes each known field into its declared namespace', () => {
    const send = () => {}
    const sm = { getSession: () => null }
    const cfg = { foo: 1 }
    const ctx = nsCtx({ send, sessionManager: sm, config: cfg, draining: true })
    assert.equal(ctx.transport.send, send)
    assert.equal(ctx.sessions.sessionManager, sm)
    assert.equal(ctx.services.config, cfg)
    assert.equal(ctx.runtime.draining, true)
    // none of these should leak to the top level
    assert.equal(ctx.send, undefined)
    assert.equal(ctx.sessionManager, undefined)
    assert.equal(ctx.config, undefined)
  })

  it('keeps unknown keys (test-injection seams + debug fields) at the top level', () => {
    const ctx = nsCtx({ evaluateDraft: () => 'x', _sent: [], scanConversations: () => [] })
    assert.equal(typeof ctx.evaluateDraft, 'function')
    assert.ok(Array.isArray(ctx._sent))
    assert.equal(typeof ctx.scanConversations, 'function')
  })

  it('merges a pre-built transport bag from makeSessionIndexCtx', () => {
    const ctx = nsCtx({ send: () => {}, ...makeSessionIndexCtx() })
    assert.ok(ctx.transport.clients instanceof Map)
    assert.equal(typeof ctx.transport.subscribeClient, 'function')
    assert.equal(typeof ctx.transport.send, 'function')
    // clientManager is not a ctx field — stays top-level
    assert.ok(ctx.clientManager)
  })

  it('treats `permissions` as a field, not a namespace, even when its value is an object', () => {
    const perm = { resolvePermission: () => {} }
    const ctx = nsCtx({ permissions: perm })
    // must land at ctx.permissions.permissions (the handler), not be merged
    assert.equal(ctx.permissions.permissions, perm)
    assert.equal(ctx.permissions.resolvePermission, undefined)
  })

  it('a fully-populated nsCtx passes deep assertCtxShape', () => {
    const flat = {}
    for (const ns of CTX_NAMESPACE_NAMES) {
      for (const key of CTX_NAMESPACES[ns]) flat[key] = null
    }
    const ctx = nsCtx(flat)
    assert.doesNotThrow(() => assertCtxShape(ctx, { deep: true }))
  })
})

describe('assertCtxShape', () => {
  it('throws naming a missing namespace (shallow)', () => {
    assert.throws(() => assertCtxShape({ transport: {}, sessions: {}, permissions: {}, services: {} }),
      /missing the 'runtime' namespace/)
  })

  it('throws when given a non-object', () => {
    assert.throws(() => assertCtxShape(null), /expected a ctx object/)
  })

  it('deep mode throws naming a missing key inside a namespace', () => {
    const ctx = nsCtx({ send: () => {} })  // transport.send present, rest of transport empty
    assert.throws(() => assertCtxShape(ctx, { deep: true }), /ctx\.transport is missing required key/)
  })

  it('returns the ctx for chaining', () => {
    const ctx = nsCtx()
    assert.equal(assertCtxShape(ctx), ctx)
  })
})
