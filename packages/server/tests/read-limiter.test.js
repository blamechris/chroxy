import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createReadLimiter, ReadLimitError, ReadCancelledError } from '../src/utils/read-limiter.js'

// A read the test releases by hand, so ordering is deterministic.
function gate() {
  let release
  let fail
  const done = new Promise((res, rej) => { release = res; fail = rej })
  return { done, release, fail }
}
const tick = () => new Promise((r) => setImmediate(r))

describe('read limiter', () => {
  it('runs at most maxConcurrent reads at once and starts queued ones as slots free', async () => {
    const lim = createReadLimiter({ maxConcurrent: 2, maxPerClient: 10, maxQueued: 10 })
    const gates = [gate(), gate(), gate()]
    let started = 0
    const ps = gates.map((g, i) => lim.submit({ key: `k${i}`, clientKey: `c${i}` }, async () => { started++; await g.done; return i }))
    await tick()
    assert.equal(started, 2)
    assert.deepEqual(lim.stats(), { running: 2, queued: 1, outstanding: 3 })
    gates[0].release()
    assert.equal(await ps[0], 0)
    await tick()
    assert.equal(started, 3)
    gates[1].release(); gates[2].release()
    assert.deepEqual(await Promise.all(ps), [0, 1, 2])
    assert.deepEqual(lim.stats(), { running: 0, queued: 0, outstanding: 0 })
  })

  it('refuses a client that already has maxPerClient reads outstanding, without affecting others', async () => {
    const lim = createReadLimiter({ maxConcurrent: 1, maxPerClient: 2, maxQueued: 10 })
    const g = gate()
    const a1 = lim.submit({ key: 'a1', clientKey: 'A' }, () => g.done)
    const a2 = lim.submit({ key: 'a2', clientKey: 'A' }, () => g.done)
    await assert.rejects(lim.submit({ key: 'a3', clientKey: 'A' }, () => g.done), (e) => e instanceof ReadLimitError && e.scope === 'client')
    const b1 = lim.submit({ key: 'b1', clientKey: 'B' }, () => g.done)
    g.release()
    await Promise.all([a1, a2, b1])
  })

  it('refuses once the queue is full', async () => {
    const lim = createReadLimiter({ maxConcurrent: 1, maxPerClient: 10, maxQueued: 2 })
    const g = gate()
    const ps = [0, 1, 2].map((i) => lim.submit({ key: `k${i}`, clientKey: `c${i}` }, () => g.done))
    await assert.rejects(lim.submit({ key: 'k3', clientKey: 'c3' }, () => g.done), (e) => e instanceof ReadLimitError && e.scope === 'queue')
    g.release()
    await Promise.all(ps)
  })

  it('coalesces concurrent requests for the same key into one read', async () => {
    const lim = createReadLimiter({ maxConcurrent: 4, maxPerClient: 1, maxQueued: 4 })
    const g = gate()
    let reads = 0
    const run = async () => { reads++; await g.done; return { messages: [1, 2, 3] } }
    const p1 = lim.submit({ key: 'same', clientKey: 'A' }, run)
    const p2 = lim.submit({ key: 'same', clientKey: 'B' }, run)
    const p3 = lim.submit({ key: 'same', clientKey: 'A' }, run) // same client, same read: not a second slot
    g.release()
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    assert.equal(reads, 1)
    assert.equal(r1, r2)
    assert.equal(r1, r3)
  })

  it('reads afresh once the previous read has finished', async () => {
    const lim = createReadLimiter()
    let reads = 0
    await lim.submit({ key: 'k', clientKey: 'A' }, async () => ++reads)
    await lim.submit({ key: 'k', clientKey: 'A' }, async () => ++reads)
    assert.equal(reads, 2)
  })

  it('a caller that aborts stops waiting; a queued read nobody waits for never starts', async () => {
    const lim = createReadLimiter({ maxConcurrent: 1, maxPerClient: 10, maxQueued: 10 })
    const g = gate()
    const first = lim.submit({ key: 'first', clientKey: 'A' }, () => g.done)
    const ac = new AbortController()
    let queuedRan = false
    const queued = lim.submit({ key: 'queued', clientKey: 'B', signal: ac.signal }, async () => { queuedRan = true })
    await tick()
    ac.abort()
    await assert.rejects(queued, (e) => e instanceof ReadCancelledError)
    assert.deepEqual(lim.stats(), { running: 1, queued: 0, outstanding: 1 })
    g.release()
    await first
    await tick()
    assert.equal(queuedRan, false)
  })

  it('tells a running read to stop when its last waiter leaves, and frees the slot', async () => {
    const lim = createReadLimiter({ maxConcurrent: 1, maxPerClient: 10, maxQueued: 10 })
    const ac = new AbortController()
    let sawAbort = false
    const slow = lim.submit({ key: 'slow', clientKey: 'A', signal: ac.signal }, (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { sawAbort = true; reject(new ReadCancelledError()) })
    }))
    await tick()
    ac.abort()
    await assert.rejects(slow, (e) => e instanceof ReadCancelledError)
    await tick()
    assert.equal(sawAbort, true)
    assert.deepEqual(lim.stats(), { running: 0, queued: 0, outstanding: 0 })
    // The slot is usable again.
    assert.equal(await lim.submit({ key: 'next', clientKey: 'A' }, async () => 'ok'), 'ok')
  })

  it('keeps a shared read running while any caller still waits on it', async () => {
    const lim = createReadLimiter()
    const g = gate()
    let sawAbort = false
    const run = async (signal) => { signal.addEventListener('abort', () => { sawAbort = true }); return g.done.then(() => 'done') }
    const ac = new AbortController()
    const p1 = lim.submit({ key: 'k', clientKey: 'A', signal: ac.signal }, run)
    const p2 = lim.submit({ key: 'k', clientKey: 'B' }, run)
    await tick()
    ac.abort()
    await assert.rejects(p1, (e) => e instanceof ReadCancelledError)
    g.release()
    assert.equal(await p2, 'done')
    assert.equal(sawAbort, false)
  })

  it('an already-aborted caller is refused without being admitted', async () => {
    const lim = createReadLimiter()
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(lim.submit({ key: 'k', clientKey: 'A', signal: ac.signal }, async () => 1), (e) => e instanceof ReadCancelledError)
    assert.deepEqual(lim.stats(), { running: 0, queued: 0, outstanding: 0 })
  })

  it('propagates a read failure to every waiter and frees the slot', async () => {
    const lim = createReadLimiter({ maxConcurrent: 1, maxPerClient: 5, maxQueued: 5 })
    const g = gate()
    const p1 = lim.submit({ key: 'k', clientKey: 'A' }, () => g.done)
    const p2 = lim.submit({ key: 'k', clientKey: 'B' }, () => g.done)
    g.fail(new Error('boom'))
    await assert.rejects(p1, /boom/)
    await assert.rejects(p2, /boom/)
    assert.equal(await lim.submit({ key: 'next', clientKey: 'A' }, async () => 'ok'), 'ok')
  })

  it('rejects invalid limits', () => {
    for (const bad of [0, -1, 1.5, NaN, '2']) {
      assert.throws(() => createReadLimiter({ maxConcurrent: bad }), RangeError)
    }
  })
})
