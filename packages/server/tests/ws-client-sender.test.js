import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createClientSender } from '../src/ws-client-sender.js'
import { createKeyPair, deriveSharedKey, decrypt, DIRECTION_SERVER, DIRECTION_CLIENT } from '@chroxy/store-core/crypto'

describe('createClientSender', () => {
  let log
  let send

  beforeEach(() => {
    log = { error: () => {} }
    send = createClientSender(log)
  })

  describe('plain send (no encryption)', () => {
    it('sends JSON-serialized message via ws.send', () => {
      const sent = []
      const ws = { send: (data) => sent.push(data) }
      const client = { _seq: 0 }
      const msg = { type: 'test', data: 'hello' }

      send(ws, client, msg)

      assert.equal(sent.length, 1)
      const parsed = JSON.parse(sent[0])
      assert.equal(parsed.type, 'test')
      assert.equal(parsed.data, 'hello')
      assert.equal(parsed.seq, 1)
    })

    it('increments sequence number on each send', () => {
      const sent = []
      const ws = { send: (data) => sent.push(data) }
      const client = { _seq: 0 }

      send(ws, client, { type: 'a' })
      send(ws, client, { type: 'b' })
      send(ws, client, { type: 'c' })

      assert.equal(JSON.parse(sent[0]).seq, 1)
      assert.equal(JSON.parse(sent[1]).seq, 2)
      assert.equal(JSON.parse(sent[2]).seq, 3)
      assert.equal(client._seq, 3)
    })

    it('sends without seq when client is undefined', () => {
      const sent = []
      const ws = { send: (data) => sent.push(data) }

      send(ws, undefined, { type: 'test' })

      const parsed = JSON.parse(sent[0])
      assert.equal(parsed.type, 'test')
      assert.equal(parsed.seq, undefined)
    })
  })

  describe('encrypted send', () => {
    it('encrypts message when client has encryptionState', () => {
      const serverKp = createKeyPair()
      const clientKp = createKeyPair()
      const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
      const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

      const sent = []
      const ws = { send: (data) => sent.push(data) }
      const client = {
        _seq: 0,
        encryptionState: {
          sharedKey: serverShared,
          sendNonce: 0,
        },
      }

      send(ws, client, { type: 'secret', payload: 'data' })

      assert.equal(sent.length, 1)
      const envelope = JSON.parse(sent[0])
      assert.equal(envelope.type, 'encrypted')
      assert.equal(typeof envelope.d, 'string')
      assert.equal(envelope.n, 0)

      // Decrypt and verify
      const parsed = decrypt(envelope, clientShared, 0, DIRECTION_SERVER)
      assert.equal(parsed.type, 'secret')
      assert.equal(parsed.payload, 'data')
      assert.equal(parsed.seq, 1)
    })

    it('increments sendNonce after each encrypted send', () => {
      const serverKp = createKeyPair()
      const clientKp = createKeyPair()
      const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)

      const sent = []
      const ws = { send: (data) => sent.push(data) }
      const client = {
        _seq: 0,
        encryptionState: {
          sharedKey: serverShared,
          sendNonce: 0,
        },
      }

      send(ws, client, { type: 'a' })
      send(ws, client, { type: 'b' })

      assert.equal(client.encryptionState.sendNonce, 2)
    })
  })

  describe('post-auth queue', () => {
    it('queues messages when encryptionPending and postAuthQueue exist', () => {
      const sent = []
      const ws = { send: (data) => sent.push(data) }
      const client = {
        _seq: 0,
        encryptionPending: true,
        postAuthQueue: [],
      }

      send(ws, client, { type: 'queued1' })
      send(ws, client, { type: 'queued2' })

      assert.equal(sent.length, 0)
      assert.equal(client.postAuthQueue.length, 2)
      assert.equal(client.postAuthQueue[0].type, 'queued1')
      assert.equal(client.postAuthQueue[1].type, 'queued2')
      // Sequence should not have been incremented
      assert.equal(client._seq, 0)
    })

    it('does not queue if encryptionPending is false', () => {
      const sent = []
      const ws = { send: (data) => sent.push(data) }
      const client = {
        _seq: 0,
        encryptionPending: false,
        postAuthQueue: [],
      }

      send(ws, client, { type: 'test' })

      assert.equal(sent.length, 1)
      assert.equal(client.postAuthQueue.length, 0)
    })
  })

  describe('flush overflow buffering', () => {
    it('buffers messages into _flushOverflow when client._flushing is true', () => {
      const sent = []
      const ws = { send: (data) => sent.push(data) }
      const client = {
        _seq: 0,
        _flushing: true,
      }

      send(ws, client, { type: 'overflow1' })
      send(ws, client, { type: 'overflow2' })

      assert.equal(sent.length, 0)
      assert.equal(client._flushOverflow.length, 2)
      assert.equal(client._flushOverflow[0].type, 'overflow1')
      assert.equal(client._seq, 0)
    })

    it('appends to existing _flushOverflow array', () => {
      const sent = []
      const ws = { send: (data) => sent.push(data) }
      const client = {
        _seq: 0,
        _flushing: true,
        _flushOverflow: [{ type: 'existing' }],
      }

      send(ws, client, { type: 'new' })

      assert.equal(client._flushOverflow.length, 2)
      assert.equal(client._flushOverflow[0].type, 'existing')
      assert.equal(client._flushOverflow[1].type, 'new')
    })

    it('drains _flushOverflow in order with strictly ascending _seq stamps (#2745)', () => {
      // End-to-end ordering check that exercises createClientSender's monotonic
      // _seq counter through the full flush-overflow path. Replays the production
      // sequence: messages arrive while _flushing=true (queued into _flushOverflow),
      // then ws-history-style drain re-sends them with _flushing=false so each gets
      // a stamped _seq.
      const sent = []
      const ws = { send: (data) => sent.push(data) }
      const client = { _seq: 0, _flushing: true }

      // Phase 1: enqueue 5 messages while flushing — they land in _flushOverflow,
      // _seq stays 0, nothing is written to the wire.
      const enqueued = [
        { type: 'msg', n: 1 },
        { type: 'msg', n: 2 },
        { type: 'msg', n: 3 },
        { type: 'msg', n: 4 },
        { type: 'msg', n: 5 },
      ]
      for (const m of enqueued) send(ws, client, m)
      assert.equal(sent.length, 0, 'no messages sent while _flushing=true')
      assert.equal(client._flushOverflow.length, 5)
      assert.equal(client._seq, 0, '_seq not advanced while buffered')

      // Phase 2: drain the overflow exactly the way ws-history.js does — clear the
      // flushing flag, snapshot+empty the queue, then re-feed each message through
      // the same sender so each one picks up its monotonic seq.
      const drained = client._flushOverflow.slice()
      client._flushOverflow = []
      client._flushing = false
      for (const m of drained) send(ws, client, m)

      // All 5 messages reached the wire in original order.
      assert.equal(sent.length, 5)
      const parsed = sent.map(s => JSON.parse(s))
      assert.deepEqual(parsed.map(p => p.n), [1, 2, 3, 4, 5], 'enqueue order preserved')

      // _seq is strictly ascending and matches the drain order.
      const seqs = parsed.map(p => p.seq)
      assert.deepEqual(seqs, [1, 2, 3, 4, 5], '_seq stamps strictly ascending from 1')
      assert.equal(client._seq, 5, 'client._seq advanced for each drained message')
    })
  })

  describe('error handling', () => {
    it('logs error when ws.send throws', () => {
      const errors = []
      log.error = (msg) => errors.push(msg)

      const ws = { send: () => { throw new Error('connection closed') } }
      const client = { _seq: 0 }

      // Should not throw
      send(ws, client, { type: 'test' })

      assert.equal(errors.length, 1)
      assert.match(errors[0], /Send error: connection closed/)
    })

    it('does not throw when ws.send fails', () => {
      log.error = () => {}
      const ws = { send: () => { throw new Error('fail') } }
      const client = { _seq: 0 }

      assert.doesNotThrow(() => {
        send(ws, client, { type: 'test' })
      })
    })

    it('still increments seq even when send fails', () => {
      log.error = () => {}
      const ws = { send: () => { throw new Error('fail') } }
      const client = { _seq: 0 }

      send(ws, client, { type: 'test' })
      assert.equal(client._seq, 1)
    })
  })
})
