/**
 * #8374 -- a `stopped` permission outcome reaches a client that advertised the
 * capability, through the REAL handshake and the REAL replay.
 *
 * The first cut gated the replay on `ws.clientCapabilities`. The handshake stores
 * capabilities on the client RECORD (`clients.get(ws)`), never on the raw socket,
 * so the gate downgraded EVERY client to `expired` -- and the unit test that
 * handed `sendHistoryEntry` a hand-built `{ clientCapabilities }` object passed
 * regardless. This drives a real WsServer over a real socket, authenticating with
 * the capability list the stock clients actually send (`CLIENT_CAPABILITIES`, the
 * constant both connection stores put in their auth frame; the stores' own frames
 * are pinned in the dashboard and app suites).
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { CLIENT_CAPABILITIES } from '@chroxy/protocol'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession } from './test-helpers.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
}

const OUTCOME = { type: 'permission_outcome', requestId: 'perm-1', tool: 'Bash', description: 'ls -la', outcome: 'stopped', timestamp: 1, _seq: 1 }

function makeManager() {
  const sessions = new Map()
  const manager = new EventEmitter()
  for (const id of ['sess-1', 'sess-2']) {
    const session = createMockSession()
    session.isReady = true
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    session.resumeSessionId = null
    sessions.set(id, { session, name: id, cwd: '/tmp' })
  }
  manager.getSession = (id) => sessions.get(id) || null
  // Fresh copies per call: the server must not mutate what it stores.
  manager.getHistory = (id) => (id === 'sess-1' ? [{ ...OUTCOME }] : [])
  manager.isHistoryTruncated = () => false
  manager.listSessions = () => [...sessions].map(([sessionId, e]) => ({ sessionId, name: e.name, cwd: e.cwd, isBusy: false, provider: 'claude-sdk' }))
  Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1' })
  return manager
}

async function until(fn, label, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timeout: ${label}`)
}

async function connect(port, capabilities) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(JSON.stringify({ type: 'auth', token: 'tok', ...(capabilities ? { capabilities } : {}) }))
  await until(() => messages.find((m) => m.type === 'auth_ok'), 'auth_ok')
  return { ws, messages }
}

describe('permission_outcome stopped through the real handshake (#8374)', () => {
  let server
  afterEach(() => { server?.close(); server = null })

  async function boot() {
    server = new WsServer({ port: 0, apiToken: 'tok', sessionManager: makeManager(), authRequired: true })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return server.httpServer.address().port
  }

  const outcomeFrames = (messages) => messages.filter((m) => m.type === 'permission_outcome')

  for (const kind of ['desktop', 'mobile']) {
    it(`a ${kind} client authenticating with its stock capability list gets "stopped" on the connect replay and on a switch`, async () => {
      const port = await boot()
      const { ws, messages } = await connect(port, [...CLIENT_CAPABILITIES[kind]])
      const connectFrame = await until(() => outcomeFrames(messages)[0], 'connect replay outcome')
      assert.equal(connectFrame.outcome, 'stopped', 'the connect-time replay')
      messages.length = 0
      ws.send(JSON.stringify({ type: 'switch_session', sessionId: 'sess-2' }))
      await until(() => messages.find((m) => m.type === 'session_switched'), 'switch to sess-2')
      messages.length = 0
      ws.send(JSON.stringify({ type: 'switch_session', sessionId: 'sess-1' }))
      const switched = await until(() => outcomeFrames(messages)[0], 'switch replay outcome')
      assert.equal(switched.outcome, 'stopped', 'the switch-back replay (what the real smoke exercises)')
      ws.close()
    })
  }

  it('CONTROL: a client advertising no capabilities gets "expired" (its record is kept)', async () => {
    const port = await boot()
    const { ws, messages } = await connect(port, undefined)
    const frame = await until(() => outcomeFrames(messages)[0], 'connect replay outcome')
    assert.equal(frame.outcome, 'expired')
    assert.equal(frame.requestId, 'perm-1')
    ws.close()
  })
})
