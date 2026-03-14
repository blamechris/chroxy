import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createClientSender } from '../src/ws-client-sender.js'

describe('ws-client-sender backpressure monitoring (#2205)', () => {
  let warnings
  let errors
  let log
  let send

  beforeEach(() => {
    warnings = []
    errors = []
    log = {
      warn: (msg) => warnings.push(msg),
      error: (msg) => errors.push(msg),
    }
  })

  function makeWs(bufferedAmount = 0) {
    const sent = []
    let closed = false
    let closeCode = null
    let closeReason = null
    return {
      send: (data) => sent.push(data),
      close: (code, reason) => { closed = true; closeCode = code; closeReason = reason },
      bufferedAmount,
      _sent: sent,
      get _closed() { return closed },
      get _closeCode() { return closeCode },
      get _closeReason() { return closeReason },
    }
  }

  function makeClient(id = 'test-client') {
    return { id, _seq: 0 }
  }

  describe('warning threshold', () => {
    it('logs warning when bufferedAmount exceeds warn threshold', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 1000, warnThrottleMs: 0 })
      const ws = makeWs(200) // above 100 byte warn threshold
      const client = makeClient()

      send(ws, client, { type: 'test' })

      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /bufferedAmount 200/)
      assert.match(warnings[0], /test-client/)
    })

    it('does not log warning when bufferedAmount is below warn threshold', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 1000, warnThrottleMs: 0 })
      const ws = makeWs(50)
      const client = makeClient()

      send(ws, client, { type: 'test' })

      assert.equal(warnings.length, 0)
    })

    it('still sends the message even when warning is logged', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 1000, warnThrottleMs: 0 })
      const ws = makeWs(200)
      const client = makeClient()

      send(ws, client, { type: 'test' })

      assert.equal(ws._sent.length, 1)
      assert.equal(ws._closed, false)
    })
  })

  describe('eviction threshold', () => {
    it('closes client when bufferedAmount exceeds evict threshold', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 500, warnThrottleMs: 0 })
      const ws = makeWs(600) // above 500 byte evict threshold
      const client = makeClient()

      send(ws, client, { type: 'test' })

      assert.equal(ws._closed, true)
      assert.equal(ws._closeCode, 4008)
      assert.match(ws._closeReason, /slow client/)
    })

    it('logs warning when evicting', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 500, warnThrottleMs: 0 })
      const ws = makeWs(600)
      const client = makeClient()

      send(ws, client, { type: 'test' })

      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /evicting/)
      assert.match(warnings[0], /test-client/)
    })

    it('does not close when bufferedAmount is between warn and evict thresholds', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 500, warnThrottleMs: 0 })
      const ws = makeWs(300) // between 100 and 500
      const client = makeClient()

      send(ws, client, { type: 'test' })

      assert.equal(ws._closed, false)
      // Should warn but not evict
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /warning threshold/)
    })
  })

  describe('warning throttling', () => {
    it('throttles warnings to one per throttle interval', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 10000, warnThrottleMs: 30_000 })
      const ws = makeWs(200)
      const client = makeClient()

      // First warning should log
      send(ws, client, { type: 'a' })
      assert.equal(warnings.length, 1)

      // Second send immediately — should be throttled
      send(ws, client, { type: 'b' })
      assert.equal(warnings.length, 1, 'second warning should be throttled')

      // Third send — still throttled
      send(ws, client, { type: 'c' })
      assert.equal(warnings.length, 1, 'third warning should be throttled')
    })

    it('logs again after throttle interval expires', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 10000, warnThrottleMs: 100 })
      const ws = makeWs(200)
      const client = makeClient()

      // First warning
      send(ws, client, { type: 'a' })
      assert.equal(warnings.length, 1)

      // Simulate time passing by manipulating the stored timestamp
      client._lastBackpressureWarn = Date.now() - 200 // 200ms ago, exceeds 100ms throttle

      send(ws, client, { type: 'b' })
      assert.equal(warnings.length, 2, 'should log again after throttle interval')
    })

    it('does not throttle eviction warnings', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 500, warnThrottleMs: 30_000 })
      // Eviction-level buffered amount bypasses warn throttle (different code path)
      const ws = makeWs(600)
      const client = makeClient()
      client._lastBackpressureWarn = Date.now() // just warned

      send(ws, client, { type: 'test' })

      assert.equal(warnings.length, 1) // eviction log
      assert.match(warnings[0], /evicting/)
      assert.equal(ws._closed, true)
    })
  })

  describe('no client edge case', () => {
    it('skips backpressure monitoring when client is undefined', () => {
      send = createClientSender(log, { warnThreshold: 100, evictThreshold: 500, warnThrottleMs: 0 })
      const ws = makeWs(600) // above evict threshold

      // Should not throw or close — no client to monitor
      send(ws, undefined, { type: 'test' })

      assert.equal(warnings.length, 0)
      assert.equal(ws._closed, false)
    })
  })

  describe('default thresholds', () => {
    it('uses 64KB warn and 1MB evict thresholds by default', () => {
      send = createClientSender(log) // no opts
      const ws = makeWs(65 * 1024) // just above 64KB
      const client = makeClient()

      send(ws, client, { type: 'test' })

      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /warning threshold/)
      assert.equal(ws._closed, false)
    })
  })
})
