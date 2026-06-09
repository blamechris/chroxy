import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { sleep, backoffDelay } from '../src/utils/sleep.js'

// #5371: shared cancellable sleep-with-abort + exponential-backoff helper that
// replaces the hand-rolled setTimeout/AbortController promise idiom copied
// across tunnel/base.js and push.js. The tunnel retry/recovery loops depend on
// the abort path REJECTING (so their catch{} can bail), so that contract is
// pinned here.

describe('sleep(ms, signal)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
  afterEach(() => mock.timers.reset())

  it('resolves only after the full delay elapses', async () => {
    let resolved = false
    const p = sleep(1000).then(() => { resolved = true })
    mock.timers.tick(999)
    await Promise.resolve()
    assert.equal(resolved, false, 'must not resolve before the delay elapses')
    mock.timers.tick(1)
    await p
    assert.equal(resolved, true)
  })

  it('rejects with an AbortError when the signal fires before the delay', async () => {
    const ac = new AbortController()
    const p = sleep(1000, ac.signal)
    ac.abort()
    await assert.rejects(p, (err) => err.name === 'AbortError')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(sleep(1000, ac.signal), (err) => err.name === 'AbortError')
  })

  it('clears the timer on abort so the timeout callback never runs', async () => {
    // The promise settles (rejects) on abort regardless of clearTimeout, so a
    // resolve-vs-reject assertion can't see a missing clearTimeout. Instead pin
    // it via removeEventListener, which is ONLY called from the timeout's
    // resolve callback: if the timer fired after abort it would be called once.
    const ac = new AbortController()
    const removed = mock.method(ac.signal, 'removeEventListener')
    const p = sleep(1000, ac.signal).then(() => 'resolved', () => 'aborted')
    ac.abort()
    mock.timers.tick(1000) // would fire the timeout callback if it weren't cleared
    assert.equal(await p, 'aborted')
    assert.equal(removed.mock.callCount(), 0, 'timeout callback must not run after abort (timer was cleared)')
  })

  it('removes the abort listener once the delay elapses (no leaked listener)', async () => {
    const ac = new AbortController()
    const removed = mock.method(ac.signal, 'removeEventListener')
    const p = sleep(10, ac.signal)
    mock.timers.tick(10)
    await p
    assert.ok(removed.mock.callCount() >= 1, 'abort listener must be removed on resolve')
  })

  it('works without a signal', async () => {
    const p = sleep(50)
    mock.timers.tick(50)
    await p // resolves, no throw
  })
})

describe('backoffDelay(attempt, base, max)', () => {
  it('is base * 2^(attempt-1) for 1-indexed attempts', () => {
    assert.equal(backoffDelay(1, 1000), 1000)
    assert.equal(backoffDelay(2, 1000), 2000)
    assert.equal(backoffDelay(3, 1000), 4000)
    assert.equal(backoffDelay(4, 1000), 8000)
  })

  it('caps at max when the computed delay would exceed it', () => {
    assert.equal(backoffDelay(10, 1000, 5000), 5000)
  })

  it('is uncapped when no max is given', () => {
    assert.equal(backoffDelay(5, 1000), 16000)
  })
})
