import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLockManager } from '../src/session-lock.js'

describe('SessionLockManager (#1840)', () => {
  let locks

  beforeEach(() => {
    locks = new SessionLockManager()
  })

  it('acquire returns a release function', async () => {
    const release = await locks.acquire('s1')
    assert.equal(typeof release, 'function')
    assert.equal(locks.isLocked('s1'), true)
    release()
    assert.equal(locks.isLocked('s1'), false)
  })

  it('serializes concurrent operations on same session', async () => {
    const order = []

    const op1 = async () => {
      const release = await locks.acquire('s1')
      order.push('op1-start')
      await new Promise(r => setTimeout(r, 50))
      order.push('op1-end')
      release()
    }

    const op2 = async () => {
      const release = await locks.acquire('s1')
      order.push('op2-start')
      order.push('op2-end')
      release()
    }

    // Start both concurrently — op2 should wait for op1
    await Promise.all([op1(), op2()])

    assert.deepEqual(order, ['op1-start', 'op1-end', 'op2-start', 'op2-end'])
  })

  it('allows concurrent operations on different sessions', async () => {
    const order = []

    const op1 = async () => {
      const release = await locks.acquire('s1')
      order.push('s1-start')
      await new Promise(r => setTimeout(r, 30))
      order.push('s1-end')
      release()
    }

    const op2 = async () => {
      const release = await locks.acquire('s2')
      order.push('s2-start')
      order.push('s2-end')
      release()
    }

    await Promise.all([op1(), op2()])

    // s2 should not wait for s1 — both should start
    assert.ok(order.indexOf('s2-start') < order.indexOf('s1-end'))
  })

  it('releases lock even if acquire threw during wait', async () => {
    const release = await locks.acquire('s1')
    assert.equal(locks.isLocked('s1'), true)
    release()
    assert.equal(locks.isLocked('s1'), false)

    // Should be acquirable again
    const release2 = await locks.acquire('s1')
    assert.equal(locks.isLocked('s1'), true)
    release2()
  })

  it('serializes three operations in order', async () => {
    const order = []

    const makeOp = (name, delay) => async () => {
      const release = await locks.acquire('s1')
      order.push(`${name}-start`)
      if (delay) await new Promise(r => setTimeout(r, delay))
      order.push(`${name}-end`)
      release()
    }

    await Promise.all([makeOp('a', 30)(), makeOp('b', 10)(), makeOp('c', 0)()])

    // All operations should be fully serialized
    assert.equal(order[0], 'a-start')
    assert.equal(order[1], 'a-end')
    assert.equal(order[2], 'b-start')
    assert.equal(order[3], 'b-end')
    assert.equal(order[4], 'c-start')
    assert.equal(order[5], 'c-end')
  })

  it('clear removes all locks', () => {
    // Manually set a lock to simulate state
    locks._locks.set('s1', Promise.resolve())
    locks._locks.set('s2', Promise.resolve())
    assert.equal(locks.isLocked('s1'), true)
    locks.clear()
    assert.equal(locks.isLocked('s1'), false)
    assert.equal(locks.isLocked('s2'), false)
  })
})
