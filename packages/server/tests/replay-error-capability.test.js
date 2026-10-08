/**
 * #6630 review -- recorded errors are replayed only to a client that advertises
 * `history_error_replay_v1`, proven through a REAL WsServer handshake: the
 * capability list rides the client's own `auth` frame, lands on the client record,
 * and the post-auth history replay reads it from there. (A hand-built capability
 * set proves nothing about that path -- #8374.)
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { CLIENT_CAPABILITIES } from '@chroxy/protocol'
import { createMockSession, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

const TOKEN = 'test-token'

const HISTORY = [
  { type: 'message', messageType: 'response', content: 'Hello', messageId: 'm1', timestamp: 1, _seq: 1 },
  { type: 'message', messageType: 'error', content: 'Usage limit reached', code: undefined, timestamp: 2, _seq: 2 },
  { type: 'message', messageType: 'error', content: 'No response for 90 seconds', code: 'stream_stall', timeoutMs: 90000, timestamp: 3, _seq: 3 },
  { type: 'message', messageType: 'response', content: 'Done', messageId: 'm2', timestamp: 4, _seq: 4 },
]

function makeManager() {
  const session = createMockSession()
  const mgr = new EventEmitter()
  mgr.listSessions = () => [{ id: 'sess-1', name: 'Test', active: true }]
  mgr.getSession = (id) => (id === 'sess-1' ? { session, name: 'Test', cwd: '/tmp' } : null)
  Object.defineProperty(mgr, 'firstSessionId', { get: () => 'sess-1' })
  mgr.getHistory = () => HISTORY
  mgr.isHistoryTruncated = () => false
  mgr.getLatestHistorySeq = () => 4
  mgr.getOldestHistorySeq = () => 1
  mgr.recordUserInput = () => {}
  mgr.getFullHistoryAsync = async () => ({ entries: HISTORY, source: 'ring', truncated: false })
  mgr.getSessionContext = async () => null
  return mgr
}

/** Connect, authenticate with the given capabilities, and collect the replay. */
async function replayFor(server, port, capabilities) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN, ...(capabilities ? { capabilities } : {}) }))
  await waitFor(() => messages.find((m) => m.type === 'history_replay_end'), { timeoutMs: 3000, label: 'history_replay_end' })
  ws.close()
  return messages
}

describe('replayed errors follow the client capability (#6630 review)', () => {
  let server
  afterEach(async () => {
    if (server) { await server.close?.(); server = null }
  })

  async function start() {
    server = new WsServer({ port: 0, apiToken: TOKEN, sessionManager: makeManager(), authRequired: true })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return server.httpServer.address().port
  }

  const errorsIn = (messages) => messages.filter((m) => m.type === 'message' && m.messageType === 'error')
  const repliesIn = (messages) => messages.filter((m) => m.type === 'message' && m.messageType === 'response')

  it('the stock desktop client list is sent the recorded errors', async () => {
    const port = await start()
    const messages = await replayFor(server, port, [...CLIENT_CAPABILITIES.desktop])
    assert.deepEqual(errorsIn(messages).map((m) => m.content), ['Usage limit reached', 'No response for 90 seconds'])
    assert.equal(errorsIn(messages)[1].code, 'stream_stall')
    assert.deepEqual(repliesIn(messages).map((m) => m.content), ['Hello', 'Done'])
  })

  it('the stock mobile client list is sent the recorded errors', async () => {
    const port = await start()
    const messages = await replayFor(server, port, [...CLIENT_CAPABILITIES.mobile])
    assert.equal(errorsIn(messages).length, 2)
  })

  it('a client advertising nothing is sent the rest of the transcript and no error', async () => {
    const port = await start()
    const messages = await replayFor(server, port, undefined)
    assert.equal(errorsIn(messages).length, 0)
    assert.deepEqual(repliesIn(messages).map((m) => m.content), ['Hello', 'Done'])
  })

  it('a client advertising other capabilities, but not this one, is not sent them either', async () => {
    const port = await start()
    const messages = await replayFor(server, port, ['console', 'permission_outcome_stopped_v1'])
    assert.equal(errorsIn(messages).length, 0)
  })

  it('the replay still carries a consistent cursor for the client that did not get the errors', async () => {
    const port = await start()
    const messages = await replayFor(server, port, undefined)
    const end = messages.find((m) => m.type === 'history_replay_end')
    assert.equal(end.latestSeq, 4, 'latestSeq advances past the entries it was not sent')
  })
})
