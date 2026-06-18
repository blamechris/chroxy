import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { flushAndDestroy } from '../src/server-cli-child.js'

// #5308 (WP-0.2) — the supervised child must flush session state on every
// shutdown/crash path. flushAndDestroy() is the shared sequence behind the IPC
// `shutdown` handler and the uncaughtException/unhandledRejection handlers.
// Importing the module is side-effect-free (entry-point guard) so we can unit
// test the sequence directly with fakes.

function makeFakes() {
  const calls = []
  const sessionManager = {
    serializeState: () => calls.push('serializeState'),
    destroyAll: () => calls.push('destroyAll'),
  }
  const wsServer = {
    broadcastShutdown: (reason, eta) => calls.push(`broadcast:${reason}:${eta}`),
    close: () => calls.push('close'),
  }
  const logger = { error: () => {}, info: () => {}, warn: () => {} }
  return { calls, sessionManager, wsServer, logger }
}

describe('server-cli-child flushAndDestroy (#5308 WP-0.2)', () => {
  it('serializes state BEFORE destroying, then closes the WS', () => {
    const { calls, sessionManager, wsServer, logger } = makeFakes()
    flushAndDestroy(sessionManager, wsServer, 'shutdown', logger)
    // Order matters: serialize must precede destroyAll (losing restored state is
    // worse than a partial write), and close comes last.
    assert.deepEqual(calls, ['broadcast:shutdown:0', 'serializeState', 'destroyAll', 'close'])
  })

  it('forwards the reason to broadcastShutdown (crash path)', () => {
    const { calls, sessionManager, wsServer, logger } = makeFakes()
    flushAndDestroy(sessionManager, wsServer, 'crash', logger)
    assert.ok(calls.includes('broadcast:crash:0'), 'crash reason broadcast with ETA 0')
    assert.equal(calls.indexOf('serializeState') < calls.indexOf('destroyAll'), true)
  })

  it('still destroys + closes when serializeState throws (failure isolated)', () => {
    const { calls, wsServer, logger } = makeFakes()
    const sessionManager = {
      serializeState: () => { throw new Error('disk full') },
      destroyAll: () => calls.push('destroyAll'),
    }
    let logged = false
    logger.error = () => { logged = true }
    flushAndDestroy(sessionManager, wsServer, 'crash', logger)
    assert.ok(logged, 'serialize failure is logged')
    assert.ok(calls.includes('destroyAll'), 'destroyAll still runs after a serialize throw')
    assert.ok(calls.includes('close'), 'wsServer.close still runs')
  })

  it('tolerates null sessionManager / wsServer (pre-start crash)', () => {
    assert.doesNotThrow(() => flushAndDestroy(null, null, 'crash', { error: () => {} }))
  })

  it('isolates a destroyAll throw from wsServer.close', () => {
    const { calls, wsServer, logger } = makeFakes()
    const sessionManager = {
      serializeState: () => calls.push('serializeState'),
      destroyAll: () => { throw new Error('boom') },
    }
    flushAndDestroy(sessionManager, wsServer, 'shutdown', logger)
    assert.ok(calls.includes('serializeState'))
    assert.ok(calls.includes('close'), 'close runs even if destroyAll throws')
  })
})
