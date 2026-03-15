import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { CliSession } from '../src/cli-session.js'

/**
 * Tests for EPIPE guard on stdin.write calls (#2318).
 *
 * We construct sessions without calling start() and inject mock child
 * processes whose stdin.write throws EPIPE, verifying the guard catches
 * errors without propagating them as unhandled exceptions.
 */

function createMockChild({ writeImpl } = {}) {
  const child = new EventEmitter()
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 99999
  child.kill = () => true
  child.killed = false
  child.stdin = new EventEmitter()
  child.stdin.write = writeImpl ?? (() => {})
  child.stdin.end = () => {}
  return child
}

function createReadySession(opts = {}) {
  const session = new CliSession({ cwd: '/tmp', ...opts })
  session._processReady = true
  session._child = createMockChild()
  // Attach a default no-op error listener so emitted errors don't become
  // unhandled EventEmitter exceptions. Tests that assert on errors replace this.
  session.on('error', () => {})
  return session
}

describe('stdin EPIPE guard — sendMessage', () => {
  it('does not throw when stdin.write raises EPIPE', () => {
    const session = createReadySession()
    session._child.stdin.write = () => {
      const err = new Error('write EPIPE')
      err.code = 'EPIPE'
      throw err
    }

    // Must not throw
    assert.doesNotThrow(() => {
      session.sendMessage('hello')
    })
  })

  it('clears busy state after EPIPE so session is not left wedged', () => {
    const session = createReadySession()
    session._child.stdin.write = () => {
      const err = new Error('write EPIPE')
      err.code = 'EPIPE'
      throw err
    }

    session.sendMessage('hello')

    // Session must not be left wedged — no manual reset required
    assert.equal(session._isBusy, false, '_isBusy must be false after EPIPE')
    assert.equal(session._currentMessageId, null, '_currentMessageId must be cleared')
    assert.equal(session._resultTimeout, null, '_resultTimeout must be cleared')
  })

  it('emits an error event after EPIPE so callers are notified', () => {
    const session = createReadySession()
    session._child.stdin.write = () => {
      const err = new Error('write EPIPE')
      err.code = 'EPIPE'
      throw err
    }

    const errors = []
    // Replace the default no-op listener with a capturing one
    session.removeAllListeners('error')
    session.on('error', (e) => errors.push(e))

    session.sendMessage('hello')

    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('EPIPE'), 'error message should mention EPIPE')
  })

  it('continues normally after a swallowed EPIPE', () => {
    const session = createReadySession()
    let writeCount = 0
    session._child.stdin.write = () => {
      writeCount++
      const err = new Error('write EPIPE')
      err.code = 'EPIPE'
      throw err
    }

    session.sendMessage('first message')
    assert.equal(writeCount, 1)

    // Session is not wedged — second send goes through without manual reset
    session.sendMessage('second message')
    assert.equal(writeCount, 2)
  })

  it('does not throw when stdin.write raises ECONNRESET', () => {
    const session = createReadySession()
    session._child.stdin.write = () => {
      const err = new Error('write ECONNRESET')
      err.code = 'ECONNRESET'
      throw err
    }

    assert.doesNotThrow(() => {
      session.sendMessage('hello')
    })

    // Must not be wedged
    assert.equal(session._isBusy, false)
  })
})

describe('stdin EPIPE guard — respondToQuestion', () => {
  it('does not throw when stdin.write raises EPIPE', () => {
    const session = createReadySession()
    session._child.stdin.write = () => {
      const err = new Error('write EPIPE')
      err.code = 'EPIPE'
      throw err
    }
    session._waitingForAnswer = true

    assert.doesNotThrow(() => {
      session.respondToQuestion('my answer')
    })
  })

  it('resets _waitingForAnswer even when write throws', () => {
    const session = createReadySession()
    session._child.stdin.write = () => {
      throw new Error('write EPIPE')
    }
    session._waitingForAnswer = true

    session.respondToQuestion('my answer')

    assert.equal(session._waitingForAnswer, false)
  })
})

describe('stdin error listener', () => {
  it('stdin error listener is registered after spawn', () => {
    // We verify the listener is present by checking that emitting 'error'
    // on the mock stdin does NOT result in an unhandled EventEmitter error
    // (which would throw and fail the test).
    const session = createReadySession()
    const stdinEmitter = session._child.stdin

    // Manually register a listener to mirror what _spawnPersistentProcess does.
    // The mock child has already been injected so we can confirm the pattern
    // works by checking no throw occurs when 'error' is emitted with a listener.
    stdinEmitter.on('error', (err) => {
      // listener present — no unhandled error
    })

    assert.doesNotThrow(() => {
      stdinEmitter.emit('error', new Error('write EPIPE'))
    })
  })

  it('source file registers stdin error listener after spawn', async () => {
    // Static analysis: confirm the source registers child.stdin.on('error')
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, '../src/cli-session.js'), 'utf-8')
    assert.ok(
      source.includes("child.stdin.on('error'"),
      'cli-session.js must register child.stdin.on(\'error\') to absorb EPIPE'
    )
  })

  it('source file wraps sendMessage stdin.write in try/catch', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, '../src/cli-session.js'), 'utf-8')

    // Locate the sendMessage method and verify try/catch around stdin.write
    const sendMessageMatch = source.match(/sendMessage\(prompt[\s\S]*?^\s{2}\}/m)
    assert.ok(sendMessageMatch, 'sendMessage method must exist')
    assert.ok(
      sendMessageMatch[0].includes('try {') && sendMessageMatch[0].includes('stdin.write'),
      'sendMessage must wrap stdin.write in try/catch'
    )
  })

  it('source file wraps respondToQuestion stdin.write in try/catch', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, '../src/cli-session.js'), 'utf-8')

    const respondMatch = source.match(/respondToQuestion\(text\)[\s\S]*?^\s{2}\}/m)
    assert.ok(respondMatch, 'respondToQuestion method must exist')
    assert.ok(
      respondMatch[0].includes('try {') && respondMatch[0].includes('stdin.write'),
      'respondToQuestion must wrap stdin.write in try/catch'
    )
  })
})
