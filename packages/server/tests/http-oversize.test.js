import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { sendOversizeResponse } from '../src/http-oversize.js'

/**
 * Unit coverage for the shared oversize-body 413 responder (#5433). Locks the
 * contract the three capped HTTP readers depend on: stop consuming + pause the
 * request, write a 413 with `Connection: close`, and destroySoon the socket on
 * 'finish' as a belt-and-braces teardown — without ever throwing.
 */

function makeReq() {
  const req = new EventEmitter()
  req.removeAllListenersCalledWith = []
  const origRemoveAll = req.removeAllListeners.bind(req)
  req.removeAllListeners = (name) => { req.removeAllListenersCalledWith.push(name); return origRemoveAll(name) }
  req.paused = false
  req.pause = () => { req.paused = true }
  return req
}

function makeRes({ writeHeadThrows = false } = {}) {
  const res = new EventEmitter()
  const socket = { destroyed: false, destroySoonCalled: 0, destroySoon() { this.destroySoonCalled++ } }
  res.socket = socket
  res.writeHeadArgs = null
  res.endArg = null
  res.writeHead = (status, headers) => {
    if (writeHeadThrows) throw new Error('socket gone')
    res.writeHeadArgs = [status, headers]
  }
  res.end = (body) => { res.endArg = body; res.emit('finish') }
  return res
}

describe('sendOversizeResponse', () => {
  it('stops consuming the request and writes a 413 with Connection: close', () => {
    const req = makeReq()
    const res = makeRes()
    sendOversizeResponse(req, res)
    assert.ok(req.removeAllListenersCalledWith.includes('data'), 'drops the data listeners')
    assert.equal(req.paused, true, 'pauses the request (TCP backpressure)')
    assert.equal(res.writeHeadArgs[0], 413)
    assert.equal(res.writeHeadArgs[1]['Connection'], 'close')
    assert.equal(res.writeHeadArgs[1]['Content-Type'], 'application/json')
  })

  it('sends the default JSON payload, overridable by the caller', () => {
    const res1 = makeRes()
    sendOversizeResponse(makeReq(), res1)
    assert.deepEqual(JSON.parse(res1.endArg), { error: 'body too large' })

    const res2 = makeRes()
    sendOversizeResponse(makeReq(), res2, { error: 'too big', max: 1024 })
    assert.deepEqual(JSON.parse(res2.endArg), { error: 'too big', max: 1024 })
  })

  it('destroySoons the socket on response finish', () => {
    const res = makeRes()
    sendOversizeResponse(makeReq(), res)
    // res.end() emits 'finish' synchronously in the mock.
    assert.equal(res.socket.destroySoonCalled, 1)
  })

  it('does not destroySoon an already-destroyed socket', () => {
    const res = makeRes()
    res.socket.destroyed = true
    sendOversizeResponse(makeReq(), res)
    assert.equal(res.socket.destroySoonCalled, 0)
  })

  it('never throws if writeHead fails (socket already torn down)', () => {
    const req = makeReq()
    const res = makeRes({ writeHeadThrows: true })
    assert.doesNotThrow(() => sendOversizeResponse(req, res))
    // The request was still paused / drained before the write attempt.
    assert.equal(req.paused, true)
  })
})
