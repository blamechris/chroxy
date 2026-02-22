import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSpy, createMockSession } from './test-helpers.js'
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
    assert.equal(session.model, 'claude-sonnet-4-20250514')
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
      model: 'claude-opus-4-20250514',
    })
    assert.equal(session.sendMessage('test'), 'custom')
    assert.equal(session.model, 'claude-opus-4-20250514')
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
