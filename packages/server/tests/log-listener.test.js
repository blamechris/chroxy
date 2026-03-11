import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { addLogListener, removeLogListener, createLogger, closeFileLogging } from '../src/logger.js'

describe('log listener isolation (#1951)', () => {
  beforeEach(() => {
    closeFileLogging()
  })

  test('multiple listeners receive log entries independently', () => {
    const entries1 = []
    const entries2 = []
    const listener1 = (entry) => entries1.push(entry)
    const listener2 = (entry) => entries2.push(entry)

    addLogListener(listener1)
    addLogListener(listener2)

    const log = createLogger('test')
    log.info('hello')

    assert.equal(entries1.length, 1)
    assert.equal(entries2.length, 1)
    assert.equal(entries1[0].message, 'hello')
    assert.equal(entries2[0].message, 'hello')

    removeLogListener(listener1)
    removeLogListener(listener2)
  })

  test('removing one listener does not affect the other', () => {
    const entries1 = []
    const entries2 = []
    const listener1 = (entry) => entries1.push(entry)
    const listener2 = (entry) => entries2.push(entry)

    addLogListener(listener1)
    addLogListener(listener2)

    removeLogListener(listener1)

    const log = createLogger('test')
    log.info('after remove')

    assert.equal(entries1.length, 0)
    assert.equal(entries2.length, 1)
    assert.equal(entries2[0].message, 'after remove')

    removeLogListener(listener2)
  })

  test('closeFileLogging clears all listeners', () => {
    const entries = []
    const listener = (entry) => entries.push(entry)
    addLogListener(listener)

    closeFileLogging()

    const log = createLogger('test')
    log.info('after close')

    assert.equal(entries.length, 0)
  })

  test('listener errors do not break other listeners', () => {
    const entries = []
    const badListener = () => { throw new Error('boom') }
    const goodListener = (entry) => entries.push(entry)

    addLogListener(badListener)
    addLogListener(goodListener)

    const log = createLogger('test')
    log.info('should survive')

    assert.equal(entries.length, 1)
    assert.equal(entries[0].message, 'should survive')

    removeLogListener(badListener)
    removeLogListener(goodListener)
  })
})
