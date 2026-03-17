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

describe('CliSession._pendingQueue — drain via _clearMessageState', () => {
  it('drains all 3 queued messages in FIFO order after each result', async () => {
    const written = []
    const mockChild = createMockChild()
    mockChild.stdin = new Writable({ write(chunk, enc, cb) { written.push(chunk.toString()); cb() } })

    const session = createSession()
    session._processReady = false

    // Queue 3 messages while process is not ready
    session.sendMessage('msg-1')
    session.sendMessage('msg-2')
    session.sendMessage('msg-3')

    assert.equal(session._pendingQueue.length, 3)

    // Process becomes ready — send the first queued message (spawn-time drain)
    session._processReady = true
    session._child = mockChild
    const first = session._pendingQueue.shift()
    session.sendMessage(first.prompt, first.attachments, first.options || {})
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null

    // msg-1 was written; msg-2 and msg-3 still queued
    assert.equal(written.length, 1)
    assert.equal(JSON.parse(written[0].trim()).message.content[0].text, 'msg-1')
    assert.equal(session._pendingQueue.length, 2)

    // Simulate result for msg-1: _clearMessageState schedules drain via nextTick
    session._isBusy = true  // set as if sendMessage ran
    session._clearMessageState()
    // Wait for the nextTick drain to execute
    await new Promise(r => process.nextTick(r))
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null

    assert.equal(written.length, 2, 'msg-2 should have been written after msg-1 result')
    assert.equal(JSON.parse(written[1].trim()).message.content[0].text, 'msg-2')
    assert.equal(session._pendingQueue.length, 1)

    // Simulate result for msg-2: _clearMessageState schedules drain via nextTick
    session._isBusy = true
    session._clearMessageState()
    // Wait for the nextTick drain to execute
    await new Promise(r => process.nextTick(r))
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null

    assert.equal(written.length, 3, 'msg-3 should have been written after msg-2 result')
    assert.equal(JSON.parse(written[2].trim()).message.content[0].text, 'msg-3')
    assert.equal(session._pendingQueue.length, 0)
  })

  it('does not drain when process is not ready (mid-respawn)', async () => {
    const written = []
    const mockChild = createMockChild()
    mockChild.stdin = new Writable({ write(chunk, enc, cb) { written.push(chunk.toString()); cb() } })

    const session = createSession()
    session._processReady = true
    session._child = mockChild

    // Queue a message manually (simulate pre-spawn queuing)
    session._pendingQueue.push({ prompt: 'queued', attachments: undefined, options: {} })

    // Process goes down mid-session
    session._processReady = false

    // _clearMessageState called while process is down (e.g. crash cleanup)
    session._isBusy = true
    session._clearMessageState()

    // Wait past the nextTick to confirm nothing was drained
    await new Promise(r => process.nextTick(r))

    // Queue should remain untouched since process is not ready
    assert.equal(session._pendingQueue.length, 1)
    assert.equal(written.length, 0)
  })

  it('does not drain after destroy() is called', async () => {
    const written = []
    const mockChild = createMockChild()
    mockChild.stdin = new Writable({ write(chunk, enc, cb) { written.push(chunk.toString()); cb() } })

    const session = createSession()
    session._processReady = true
    session._child = mockChild

    // Queue a message
    session._pendingQueue.push({ prompt: 'should-not-send', attachments: undefined, options: {} })

    // Trigger a drain, then immediately destroy before nextTick fires
    session._isBusy = true
    session._clearMessageState()
    session._destroying = true

    // Wait past the nextTick — drain should be suppressed by _destroying guard
    await new Promise(r => process.nextTick(r))

    assert.equal(written.length, 0, 'no message should be written after destroy()')
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

describe('CliSession._pendingQueue — spawn-time while-loop drain (#2459)', () => {
  it('sends the first queued message and keeps the rest in queue (not discarded)', () => {
    const session = createSession()
    session._processReady = false

    // Queue 3 messages while process is not ready
    session.sendMessage('msg-1')
    session.sendMessage('msg-2')
    session.sendMessage('msg-3')
    assert.equal(session._pendingQueue.length, 3)

    // Simulate _spawnPersistentProcess completing: set ready + mock child
    const written = []
    const mockChild = createMockChild()
    mockChild.stdin = new Writable({ write(chunk, enc, cb) { written.push(chunk.toString()); cb() } })
    session._child = mockChild

    // Simulate the while-loop drain from _spawnPersistentProcess
    session._processReady = true
    while (session._pendingQueue.length > 0 && !session._isBusy) {
      const pending = session._pendingQueue.shift()
      session.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    }

    // First message written to stdin
    assert.equal(written.length, 1)
    assert.equal(JSON.parse(written[0].trim()).message.content[0].text, 'msg-1')

    // Remaining 2 messages still in queue — NOT silently dropped
    assert.equal(session._pendingQueue.length, 2)
    assert.equal(session._pendingQueue[0].prompt, 'msg-2')
    assert.equal(session._pendingQueue[1].prompt, 'msg-3')

    // Cleanup
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null
  })

  it('does not lose queued messages when _isBusy blocks the loop', () => {
    const session = createSession()
    session._processReady = false

    session.sendMessage('alpha')
    session.sendMessage('beta')
    assert.equal(session._pendingQueue.length, 2)

    const errors = []
    session.on('error', (e) => errors.push(e))

    // Simulate spawn with the while-loop drain
    const written = []
    const mockChild = createMockChild()
    mockChild.stdin = new Writable({ write(chunk, enc, cb) { written.push(chunk.toString()); cb() } })
    session._child = mockChild
    session._processReady = true

    while (session._pendingQueue.length > 0 && !session._isBusy) {
      const pending = session._pendingQueue.shift()
      session.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    }

    // Only 1 message sent, no "Already processing" errors
    assert.equal(written.length, 1)
    assert.equal(errors.filter(e => e.message.includes('Already processing')).length, 0,
      'while-loop with _isBusy guard must NOT emit "Already processing" errors')

    // beta still in queue, waiting for result → _clearMessageState → nextTick drain
    assert.equal(session._pendingQueue.length, 1)
    assert.equal(session._pendingQueue[0].prompt, 'beta')

    // Cleanup
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null
  })

  it('does not drain when _isBusy is already true before spawn', () => {
    const session = createSession()
    session._processReady = false

    session.sendMessage('should-stay')
    assert.equal(session._pendingQueue.length, 1)

    // Simulate spawn with _isBusy already set (e.g. race condition)
    const written = []
    const mockChild = createMockChild()
    mockChild.stdin = new Writable({ write(chunk, enc, cb) { written.push(chunk.toString()); cb() } })
    session._child = mockChild
    session._processReady = true
    session._isBusy = true

    while (session._pendingQueue.length > 0 && !session._isBusy) {
      const pending = session._pendingQueue.shift()
      session.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    }

    // Nothing drained — _isBusy blocked the loop
    assert.equal(written.length, 0)
    assert.equal(session._pendingQueue.length, 1)
    assert.equal(session._pendingQueue[0].prompt, 'should-stay')
  })

  it('full chain: spawn drain + _clearMessageState drains all 3 queued messages', async () => {
    const written = []
    const mockChild = createMockChild()
    mockChild.stdin = new Writable({ write(chunk, enc, cb) { written.push(chunk.toString()); cb() } })

    const session = createSession()
    session._processReady = false

    // Queue 3 messages while process is not ready
    session.sendMessage('first')
    session.sendMessage('second')
    session.sendMessage('third')
    assert.equal(session._pendingQueue.length, 3)

    // Simulate spawn + while-loop drain
    session._child = mockChild
    session._processReady = true
    while (session._pendingQueue.length > 0 && !session._isBusy) {
      const pending = session._pendingQueue.shift()
      session.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    }
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null

    // first sent
    assert.equal(written.length, 1)
    assert.equal(JSON.parse(written[0].trim()).message.content[0].text, 'first')

    // Simulate result for 'first' → _clearMessageState drains 'second'
    session._isBusy = true
    session._clearMessageState()
    await new Promise(r => process.nextTick(r))
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null

    assert.equal(written.length, 2)
    assert.equal(JSON.parse(written[1].trim()).message.content[0].text, 'second')

    // Simulate result for 'second' → _clearMessageState drains 'third'
    session._isBusy = true
    session._clearMessageState()
    await new Promise(r => process.nextTick(r))
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null

    assert.equal(written.length, 3)
    assert.equal(JSON.parse(written[2].trim()).message.content[0].text, 'third')
    assert.equal(session._pendingQueue.length, 0)
  })
})
