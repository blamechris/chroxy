import { it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { exitAfterPreviewCleanup } from '../src/server-cli/preview-shutdown.js'

it('error exit waits for preview cleanup', async () => {
  let settle
  let exited = false
  exitAfterPreviewCleanup({ settleDevPreviews: () => new Promise(resolve => { settle = resolve }) }, { exit: () => { exited = true }, delayMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(exited, false)
  settle()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(exited, true)
})

it('the independent ceiling exits even when preview cleanup never settles', t => {
  t.after(() => mock.timers.reset())
  mock.timers.enable({ apis: ['setTimeout'] })
  let exits = 0
  exitAfterPreviewCleanup({ settleDevPreviews: () => new Promise(() => {}) }, { exit: () => { exits++ }, delayMs: 0, ceilingMs: 5500 })
  mock.timers.tick(5499)
  assert.equal(exits, 0)
  mock.timers.tick(1)
  mock.timers.tick(0)
  assert.equal(exits, 1)
})
