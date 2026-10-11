import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { ClientMessageSchema } from '../src/ws-schemas.js'
import { setLogListener } from '../src/logger.js'
import { createMockSession, waitFor } from './test-helpers.js'

// #7140 — `orchestration_run_action` carries `cancel` only. The engine never
// had a user-held pause, so `pause` / `resume` were buttons that could only
// ever produce an error. They are gone from the wire enum; an OLD client that
// still sends one must get an explicit rejection at the wire, never silence and
// never an ack.

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

const base = { type: 'orchestration_run_action', runId: 'run_1', requestId: 'orch-action-1' }

describe('#7140 orchestration_run_action wire schema', () => {
  it('accepts cancel (positive control: the schema path under test is reached)', () => {
    assert.equal(ClientMessageSchema.safeParse({ ...base, action: 'cancel' }).success, true)
  })

  for (const action of ['pause', 'resume']) {
    it(`rejects ${action}: the engine cannot serve it`, () => {
      assert.equal(ClientMessageSchema.safeParse({ ...base, action }).success, false)
    })
  }
})

describe('#7140 a stale client sending pause/resume over a real socket', () => {
  let server
  let ws

  afterEach(() => {
    try { ws?.close() } catch { /* already closed */ }
    ws = null
    if (server) {
      server.close()
      server = null
    }
  })

  async function connect() {
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: createMockSession(),
      authRequired: false,
    })
    server.start('127.0.0.1')
    await new Promise((resolve) => {
      if (server.httpServer.listening) resolve()
      else server.httpServer.once('listening', resolve)
    })
    const port = server.httpServer.address().port
    const messages = []
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('message', (data) => { messages.push(JSON.parse(data.toString())) })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    return messages
  }

  for (const action of ['pause', 'resume']) {
    it(`${action} gets an INVALID_MESSAGE error with a reason, and no ack`, async () => {
      const messages = await connect()
      ws.send(JSON.stringify({ ...base, action }))
      const err = await waitFor(() => messages.find((m) => m.type === 'error'), { label: 'error reply' })
      assert.equal(err.code, 'INVALID_MESSAGE')
      assert.ok(
        typeof err.details === 'string' && err.details.length > 0,
        'the rejection must say why, not just that it happened',
      )
      assert.ok(
        !messages.some((m) => m.type === 'orchestration_action_ack'),
        'an action the engine cannot serve must never be acked',
      )
    })
  }
})
