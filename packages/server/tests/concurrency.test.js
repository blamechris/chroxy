import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

let runWithConcurrency

describe('runWithConcurrency (#1075)', () => {
  before(async () => {
    const mod = await import('../src/utils/concurrency.js')
    runWithConcurrency = mod.runWithConcurrency
  })

  it('runs all tasks and returns results in order', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ]
    const results = await runWithConcurrency(tasks, 2)
    assert.deepStrictEqual(results, ['a', 'b', 'c'])
  })

  it('respects concurrency limit', async () => {
    let running = 0
    let maxRunning = 0

    const makeTask = (val) => async () => {
      running++
      if (running > maxRunning) maxRunning = running
      await new Promise(r => setTimeout(r, 10))
      running--
      return val
    }

    const tasks = [makeTask(1), makeTask(2), makeTask(3), makeTask(4), makeTask(5)]
    const results = await runWithConcurrency(tasks, 2)

    assert.deepStrictEqual(results, [1, 2, 3, 4, 5])
    assert.ok(maxRunning <= 2, `max concurrent was ${maxRunning}, expected <= 2`)
  })

  it('handles empty task array', async () => {
    const results = await runWithConcurrency([], 3)
    assert.deepStrictEqual(results, [])
  })

  it('handles limit larger than task count', async () => {
    const tasks = [() => Promise.resolve('x')]
    const results = await runWithConcurrency(tasks, 10)
    assert.deepStrictEqual(results, ['x'])
  })

  it('propagates errors from tasks', async () => {
    const tasks = [
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve('ok2'),
    ]
    await assert.rejects(
      () => runWithConcurrency(tasks, 2),
      { message: 'boom' }
    )
  })
})
