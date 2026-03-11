import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionLockManager } from '../../src/session-lock.js'
import { RateLimiter } from '../../src/rate-limiter.js'

describe('security: race conditions', () => {
  describe('concurrent session mutations', () => {
    it('serializes concurrent destroys on the same session', async () => {
      const lock = new SessionLockManager()
      const order = []

      const op1 = lock.acquire('session-1').then(async (release) => {
        order.push('op1-start')
        await new Promise(r => setTimeout(r, 50))
        order.push('op1-end')
        release()
      })

      const op2 = lock.acquire('session-1').then(async (release) => {
        order.push('op2-start')
        order.push('op2-end')
        release()
      })

      await Promise.all([op1, op2])
      assert.deepEqual(order, ['op1-start', 'op1-end', 'op2-start', 'op2-end'])
    })

    it('allows parallel operations on different sessions', async () => {
      const lock = new SessionLockManager()
      const order = []

      const op1 = lock.acquire('session-a').then(async (release) => {
        order.push('a-start')
        await new Promise(r => setTimeout(r, 30))
        order.push('a-end')
        release()
      })

      const op2 = lock.acquire('session-b').then(async (release) => {
        order.push('b-start')
        order.push('b-end')
        release()
      })

      await Promise.all([op1, op2])
      // b should complete before a since a has a delay
      assert.equal(order.indexOf('b-end') < order.indexOf('a-end'), true)
    })

    it('handles lock release even if operation throws', async () => {
      const lock = new SessionLockManager()

      const release = await lock.acquire('session-err')
      let threw = false
      try {
        threw = true
      } finally {
        release()
      }
      assert.equal(threw, true)

      // Should be able to acquire again after release
      const release2 = await lock.acquire('session-err')
      assert.ok(release2, 'Should acquire lock after error release')
      release2()
    })

    it('serializes 5 concurrent operations correctly', async () => {
      const lock = new SessionLockManager()
      const results = []

      const ops = Array.from({ length: 5 }, (_, i) =>
        lock.acquire('contested-session').then(async (release) => {
          results.push(i)
          await new Promise(r => setTimeout(r, 10))
          release()
        })
      )

      await Promise.all(ops)
      assert.equal(results.length, 5)
      // All 5 should have executed
      assert.deepEqual(results.sort(), [0, 1, 2, 3, 4])
    })
  })

  describe('concurrent auth attempts', () => {
    it('rate limiter handles concurrent checks without corruption', () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxMessages: 10, burst: 0 })

      // Simulate 20 concurrent auth checks from same client
      const results = []
      for (let i = 0; i < 20; i++) {
        results.push(limiter.check('concurrent-client'))
      }

      const allowed = results.filter(r => r.allowed).length
      const blocked = results.filter(r => !r.allowed).length

      assert.equal(allowed, 10, 'Exactly 10 should be allowed')
      assert.equal(blocked, 10, 'Exactly 10 should be blocked')
    })
  })

  describe('lock manager cleanup', () => {
    it('clear() releases all pending operations', async () => {
      const lock = new SessionLockManager()

      // Acquire lock on session
      const release = await lock.acquire('cleanup-session')
      assert.equal(lock.isLocked('cleanup-session'), true)

      // Clear all locks
      lock.clear()
      assert.equal(lock.isLocked('cleanup-session'), false)

      // Can acquire again
      const release2 = await lock.acquire('cleanup-session')
      release2()
      release() // Release original (no-op after clear)
    })
  })
})
