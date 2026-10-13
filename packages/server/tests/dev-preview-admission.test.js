import { it } from 'node:test'
import assert from 'node:assert/strict'
import { tsImport } from 'tsx/esm/api'
import { EventEmitter } from 'node:events'
import { WsServer } from '../src/ws-server.js'
import { DevPreviewManager } from '../src/dev-preview.js'

const { createDispatchTable } = await tsImport('../../store-core/src/dispatch-table.ts', import.meta.url)
const { isDevPreviewPending } = await tsImport('../../store-core/src/handlers/dev-preview.ts', import.meta.url)
const tick = () => new Promise(resolve => setImmediate(resolve))

it('a throttled preview settles only its admitted request and permits fresh consent after the limit resets', async () => {
  const ws = {}
  const client = { id: 'human', authenticated: true, isPrimaryToken: true, authToken: 'fixture-only', activeSessionId: 's1', rateLimitKey: 'fixture' }
  const clients = new Map([[ws, client]])
  const session = { cwd: '/tmp/preview-fixture' }
  let publications = 0
  const manager = new DevPreviewManager({
    getSession: () => ({ session }),
    pinTarget: async ({ port }) => ({
      socket: new EventEmitter(),
      target: { host: '127.0.0.1', port, pid: 100, command: 'fixture', cwd: session.cwd, started: 'fixture' },
      verify: async () => {},
      close() {},
    }),
    createProxy: async () => ({ close() {} }),
    tunnelFactory: () => {
      publications++
      const tunnel = new EventEmitter()
      tunnel.start = async () => ({ httpUrl: 'https://fixture.trycloudflare.com' })
      tunnel.stop = async () => {}
      return tunnel
    },
  })
  const table = createDispatchTable()
  let state = { messages: [], devPreviewRequests: [{ requestId: 'other', port: 4100, state: 'active' }] }
  const frames = []
  const adapter = {
    getActiveSessionId: () => 's1', hasSession: id => id === 's1',
    updateSession: (_id, fn) => { state = { ...state, ...fn(state) } },
    addMessage: () => {},
  }
  const send = (_, msg) => { frames.push(msg)
    table[msg.type]?.(msg, adapter) }
  let allowed = false
  const receiver = {
    clients, _authCtx: { clients }, _rateLimiter: { check: () => ({ allowed, retryAfterMs: 1000 }) },
    _send: send, _sendPreviewRefusal: WsServer.prototype._sendPreviewRefusal,
    sessionManager: {}, _handlerCtx: { services: { devPreview: manager }, transport: { send } },
  }
  const admit = async (requestId, port) => {
    state.devPreviewRequests = [...state.devPreviewRequests.filter(r => r.port !== port), { requestId, port, state: 'checking' }]
    frames.length = 0
    await WsServer.prototype._handleMessage.call(receiver, ws, { type: 'open_dev_preview', sessionId: 's1', port, requestId })
    await tick()
  }
  const request = id => state.devPreviewRequests.find(r => r.requestId === id)
  try {
    await admit('throttled', 3100)
    assert.ok(frames.some(m => m.type === 'rate_limited'), 'ordinary throttle notice remains visible')
    const failure = frames.find(m => m.type === 'dev_preview_status')
    assert.ok(failure, 'a throttled preview must receive its correlated terminal refusal')
    assert.equal(failure.requestId, 'throttled')
    assert.equal(failure.state, 'failed')
    assert.equal(failure.port, undefined)
    assert.equal(request('throttled').state, 'failed')
    assert.equal(isDevPreviewPending(request('throttled')), false, 'fresh consent is no longer disabled')
    assert.equal(request('other').state, 'active', 'an unrelated preview stays active')
    assert.equal(manager._requests.size, 0)
    assert.equal(publications, 0)

    frames.length = 0
    await WsServer.prototype._handleMessage.call(receiver, ws, { type: 'list_sessions' })
    assert.deepEqual(frames.map(m => m.type), ['rate_limited'], 'unrelated throttles do not fail preview requests')
    for (const bad of [{ requestId: '' }, { requestId: 'x'.repeat(129) }, { sessionId: '' }, { sessionId: 'x'.repeat(257) }]) {
      frames.length = 0
      await WsServer.prototype._handleMessage.call(receiver, ws, { type: 'open_dev_preview', sessionId: 's1', port: 3100, requestId: 'not-admitted', ...bad })
      assert.deepEqual(frames.map(m => m.type), ['rate_limited'], 'unsafe correlation fields remain excluded')
    }

    allowed = true
    await WsServer.prototype._handleMessage.call(receiver, ws, { type: 'close_dev_preview', sessionId: 's1', port: 3100 })
    assert.equal(isDevPreviewPending(request('throttled')), false, 'no-record Cancel cannot restore checking')
    await admit('ordinary-refusal', 5432)
    assert.equal(request('ordinary-refusal').state, 'failed')
    assert.equal(isDevPreviewPending(request('ordinary-refusal')), false)
    assert.ok(frames.some(m => m.type === 'dev_preview_status' && m.requestId === 'ordinary-refusal'))

    await admit('fresh', 3100)
    assert.equal(request('fresh').state, 'awaiting_consent', 'allowed traffic reaches the actual consent pipeline')
    assert.ok(frames.some(m => m.type === 'permission_request'))
    assert.equal(publications, 0)
    manager.respondToConsent(client, { requestId: 'fresh', decision: 'allow' })
    await tick()
    assert.equal(request('fresh').state, 'active')
    assert.equal(publications, 1, 'only a fresh explicit grant publishes')
  } finally {
    await manager.closeAll()
  }
})
