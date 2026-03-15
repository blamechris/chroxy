import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable, Readable } from 'node:stream'
import { CliSession } from '../src/cli-session.js'

/**
 * Tests for the _pendingQueue feature in CliSession.
 *
 * Verifies FIFO ordering, max-depth overflow guard, and that
 * the queue is drained in order when the process becomes ready.
 */

function createSession(opts = {}) {
  return new CliSession({ cwd: '/tmp', ...opts })
}

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(chunk, enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = () => true
  child.killed = false
  return child
}

// Create a session with a mock child that captures stdin writes
function createReadySession(opts = {}) {
  const session = createSession(opts)
  session._processReady = true
  session._child = createMockChild()
  return session
}

describe('CliSession._pendingQueue — initial state', () => {
  it('initialises as an empty array', () => {
    const session = createSession()
    assert.ok(Array.isArray(session._pendingQueue))
    assert.equal(session._pendingQueue.length, 0)
  })

  it('does not have _pendingMessage property', () => {
    const session = createSession()
    assert.ok(!Object.prototype.hasOwnProperty.call(session, '_pendingMessage'))
  })
})

describe('CliSession._pendingQueue — queuing when not ready', () => {
  it('enqueues a single message when process not ready', () => {
    const session = createSession()
    session._processReady = false

    session.sendMessage('first')

    assert.equal(session._pendingQueue.length, 1)
    assert.deepStrictEqual(session._pendingQueue[0], { prompt: 'first', attachments: undefined, options: {} })
    assert.equal(session._isBusy, false)
  })

  it('enqueues up to 3 messages in FIFO order', () => {
    const session = createSession()
    session._processReady = false

    session.sendMessage('msg-1')
    session.sendMessage('msg-2')
    session.sendMessage('msg-3')

    assert.equal(session._pendingQueue.length, 3)
    assert.equal(session._pendingQueue[0].prompt, 'msg-1')
    assert.equal(session._pendingQueue[1].prompt, 'msg-2')
    assert.equal(session._pendingQueue[2].prompt, 'msg-3')
  })

  it('preserves attachments and options in queued entry', () => {
    const session = createSession()
    session._processReady = false
    const attachments = [{ type: 'image', data: 'base64data' }]
    const options = { isVoice: true }

    session.sendMessage('with-attachments', attachments, options)

    assert.equal(session._pendingQueue.length, 1)
    assert.deepStrictEqual(session._pendingQueue[0].attachments, attachments)
    assert.deepStrictEqual(session._pendingQueue[0].options, options)
  })
})

describe('CliSession._pendingQueue — overflow guard', () => {
  it('emits error and discards the 4th message', () => {
    const session = createSession()
    session._processReady = false
    const errors = []
    session.on('error', (e) => errors.push(e))

    session.sendMessage('msg-1')
    session.sendMessage('msg-2')
    session.sendMessage('msg-3')
    // 4th should overflow
    session.sendMessage('msg-4-overflow')

    assert.equal(session._pendingQueue.length, 3, 'queue must stay at 3')
    assert.equal(errors.length, 1, 'exactly one error emitted')
    assert.ok(errors[0].message.includes('queue full'), `error message should mention "queue full", got: "${errors[0].message}"`)
    // The 4th message must NOT be in the queue
    assert.ok(!session._pendingQueue.some((m) => m.prompt === 'msg-4-overflow'))
  })

  it('does not emit error when queue is exactly at capacity (3) — only on overflow', () => {
    const session = createSession()
    session._processReady = false
    const errors = []
    session.on('error', (e) => errors.push(e))

    session.sendMessage('msg-1')
    session.sendMessage('msg-2')
    session.sendMessage('msg-3')

    // No error yet — still within limit
    assert.equal(errors.length, 0)
    assert.equal(session._pendingQueue.length, 3)
  })
})

describe('CliSession._pendingQueue — FIFO dequeue on ready', () => {
  it('sends the first queued message (shift) when process becomes ready', () => {
    const session = createSession()
    session._processReady = false

    session.sendMessage('first-pending')
    session.sendMessage('second-pending')

    assert.equal(session._pendingQueue.length, 2)

    // Now simulate _spawnPersistentProcess completing: set ready + mock child
    const written = []
    const mockChild = createMockChild()
    mockChild.stdin = new Writable({ write(chunk, enc, cb) { written.push(chunk.toString()); cb() } })

    session._processReady = true
    session._child = mockChild

    // Manually drain the first item (mirrors what _spawnPersistentProcess does)
    if (session._pendingQueue.length > 0) {
      const pending = session._pendingQueue.shift()
      session.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    }

    // First message written to stdin
    assert.equal(written.length, 1)
    const parsed = JSON.parse(written[0].trim())
    assert.equal(parsed.message.content[0].text, 'first-pending')

    // Second message still in queue (session is now busy)
    assert.equal(session._pendingQueue.length, 1)
    assert.equal(session._pendingQueue[0].prompt, 'second-pending')

    // Cleanup
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null
  })

  it('queue is empty after all messages drained one-by-one', () => {
    const session = createSession()
    session._processReady = false

    session.sendMessage('alpha')
    session.sendMessage('beta')

    assert.equal(session._pendingQueue.length, 2)

    // Drain first
    const mockChild = createMockChild()
    session._processReady = true
    session._child = mockChild
    let pending = session._pendingQueue.shift()
    session.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null

    // Simulate result — clear busy state, then drain second
    session._isBusy = false
    pending = session._pendingQueue.shift()
    session.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null

    assert.equal(session._pendingQueue.length, 0)
  })
})

describe('CliSession._pendingQueue — busy guard is unaffected', () => {
  it('still rejects send when busy, regardless of queue', () => {
    const session = createReadySession()
    session._isBusy = true
    const errors = []
    session.on('error', (e) => errors.push(e))

    session.sendMessage('should-fail')

    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('Already processing'))
    // Queue must not be touched
    assert.equal(session._pendingQueue.length, 0)
  })
})
