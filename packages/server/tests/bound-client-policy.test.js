import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { registeredMessageTypes, registerMessageHandler, handleSessionMessage } from '../src/ws-message-handlers.js'
import {
  BOUND_ALLOWED_MESSAGE_TYPES,
  BOUND_DENIED_MESSAGE_TYPES,
  isBoundAllowedMessageType,
  refuseBoundMessage,
  sendBoundRefusal,
} from '../src/bound-client-policy.js'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener, addLogListener, removeLogListener, loggableValue } from '../src/logger.js'

const allowed = Object.keys(BOUND_ALLOWED_MESSAGE_TYPES)
const denied = Object.keys(BOUND_DENIED_MESSAGE_TYPES)
const registered = new Set(registeredMessageTypes)

describe('session-scoped message classification', () => {
  it('every registered message type is classified', () => {
    const unclassified = registeredMessageTypes.filter(
      (t) => !isBoundAllowedMessageType(t) && !Object.hasOwn(BOUND_DENIED_MESSAGE_TYPES, t),
    )
    assert.deepEqual(unclassified, [], 'classify each new handler in src/bound-client-policy.js')
  })

  it('every classified name is a real handler (no stale entries)', () => {
    const stale = [...allowed, ...denied].filter((t) => !registered.has(t))
    assert.deepEqual(stale, [])
  })

  it('no type is both allowed and denied', () => {
    const both = allowed.filter((t) => Object.hasOwn(BOUND_DENIED_MESSAGE_TYPES, t))
    assert.deepEqual(both, [])
  })

  it('every entry carries a reason', () => {
    for (const [t, why] of [...Object.entries(BOUND_ALLOWED_MESSAGE_TYPES), ...Object.entries(BOUND_DENIED_MESSAGE_TYPES)]) {
      assert.ok(typeof why === 'string' && why.length > 10, `${t} needs a reason`)
    }
  })

  it('host-wide and cross-session operations stay unavailable (independent of the lists)', () => {
    // Spelled out here rather than derived from the module under test, so moving
    // one of these into the allowed list is a visible change to this file too.
    const MUST_BE_UNAVAILABLE = [
      'submit_mcp_auth_code', 'restore_checkpoint', 'launch_web_task', 'teleport_web_task',
      'list_web_tasks', 'notification_prefs_get', 'notification_prefs_set', 'request_cost_summary',
      'list_repos', 'add_repo', 'remove_repo', 'list_directory', 'test_credential', 'list_providers',
      'get_credentials_status', 'byok_get_credentials_status', 'github_webhook_config_request',
      'set_permission_rules', 'create_session', 'resume_conversation', 'write_file', 'git_commit',
      'host_status_request', 'revoke_token', 'pair_approve', 'daemon_update_action', 'set_prompt_evaluator_skip_pattern',
    ]
    for (const t of MUST_BE_UNAVAILABLE) {
      assert.equal(isBoundAllowedMessageType(t), false, `${t} must not be available to a session-scoped connection`)
    }
  })

  it('only own entries are allowed (prototype names are not)', () => {
    assert.equal(isBoundAllowedMessageType('__proto__'), false)
    assert.equal(isBoundAllowedMessageType('constructor'), false)
    assert.equal(isBoundAllowedMessageType('toString'), false)
    assert.equal(isBoundAllowedMessageType(undefined), false)
    assert.equal(isBoundAllowedMessageType(42), false)
  })
})

describe('the refusal reply', () => {
  function run(msg) {
    const sent = []
    const ctx = {
      transport: { send: (_ws, m) => sent.push(m) },
      sessions: { sessionManager: { getSession: (id) => (id === 'sess-a' ? { name: 'A' } : null) } },
    }
    const refused = refuseBoundMessage({}, { id: 'c1', boundSessionId: 'sess-a' }, msg, ctx)
    return { refused, sent }
  }

  it('does not echo a requestId that is not a string', () => {
    for (const requestId of [{ a: 1 }, 7, ['x'], null, true]) {
      const { sent } = run({ type: 'revoke_token', requestId })
      assert.equal(sent.length, 1)
      assert.equal('requestId' in sent[0], false, JSON.stringify(requestId))
    }
  })

  it('does not echo a type or requestId longer than 128 characters, and echoes one of exactly 128', () => {
    const long = 'x'.repeat(129)
    const over = run({ type: long, requestId: long })
    assert.equal(over.sent.length, 1)
    assert.equal('requestType' in over.sent[0], false)
    assert.equal('requestId' in over.sent[0], false)
    const edge = 'y'.repeat(128)
    const at = run({ type: edge, requestId: edge })
    assert.equal(at.sent[0].requestType, edge)
    assert.equal(at.sent[0].requestId, edge)
  })

  it('refuses a missing or non-string type without echoing it', () => {
    for (const msg of [{}, { requestId: 'r' }, { type: 5 }, { type: null }, { type: { a: 1 } }]) {
      const { refused, sent } = run(msg)
      assert.equal(refused, true, JSON.stringify(msg))
      assert.equal(sent[0].code, 'SESSION_TOKEN_MISMATCH')
      assert.equal('requestType' in sent[0], false)
    }
  })

  it('keeps a type containing a newline on one log line', () => {
    const lines = []
    const listener = (entry) => lines.push(entry.message)
    addLogListener(listener)
    try {
      run({ type: 'revoke_token\n[INFO] [ws] forged line' })
    } finally {
      removeLogListener(listener)
    }
    const mine = lines.filter((l) => l.includes('forged line'))
    assert.equal(mine.length, 1)
    assert.equal(mine[0].includes('\n'), false)
  })

  it('loggableValue quotes, caps and escapes a client-supplied value', () => {
    assert.equal(loggableValue('a\nb'), '"a\\nb"')
    assert.equal(loggableValue('z'.repeat(500)).length, 130)
    assert.equal(loggableValue(42), 'number')
    assert.equal(loggableValue(undefined), 'undefined')
  })

  it('sendBoundRefusal replies without consulting the allowlist', () => {
    const sent = []
    const ctx = { transport: { send: (_ws, m) => sent.push(m) }, sessions: {} }
    sendBoundRefusal({}, { id: 'c1', boundSessionId: 'sess-a' }, { type: 'client_visible' }, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].code, 'SESSION_TOKEN_MISMATCH')
  })
})

describe('dispatch for a session-scoped connection', () => {
  function makeCtx() {
    const sent = []
    const ctx = {
      transport: { send: (_ws, m) => sent.push(m) },
      sessions: { sessionManager: { getSession: (id) => (id === 'sess-a' ? { name: 'A' } : null) } },
    }
    return { ctx, sent }
  }

  for (const type of denied) {
    it(`refuses ${type} before its handler runs`, async () => {
      const { ctx, sent } = makeCtx()
      await handleSessionMessage({}, { id: 'c1', boundSessionId: 'sess-a' }, { type, requestId: 'r1' }, ctx)
      assert.equal(sent.length, 1, 'exactly one reply')
      assert.equal(sent[0].type, 'session_error')
      assert.equal(sent[0].code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(sent[0].requestType, type)
      assert.equal(sent[0].requestId, 'r1')
    })
  }

  it('refuses a handler that was registered but never classified', async () => {
    let ran = false
    registerMessageHandler('zz_unclassified_probe', () => { ran = true })
    const { ctx, sent } = makeCtx()
    await handleSessionMessage({}, { id: 'c1', boundSessionId: 'sess-a' }, { type: 'zz_unclassified_probe' }, ctx)
    assert.equal(ran, false)
    assert.equal(sent[0].code, 'SESSION_TOKEN_MISMATCH')
    // An unscoped connection still reaches it.
    await handleSessionMessage({}, { id: 'c2' }, { type: 'zz_unclassified_probe' }, ctx)
    assert.equal(ran, true)
  })

  it('treats an empty or non-string binding as scoped, never as unscoped', async () => {
    for (const boundSessionId of ['', 0, false]) {
      let ran = false
      registerMessageHandler('zz_unclassified_probe', () => { ran = true })
      const { ctx, sent } = makeCtx()
      await handleSessionMessage({}, { id: 'c1', boundSessionId }, { type: 'zz_unclassified_probe' }, ctx)
      assert.equal(ran, false, `binding ${JSON.stringify(boundSessionId)}`)
      assert.equal(sent[0].code, 'SESSION_TOKEN_MISMATCH')
    }
  })

  it('dispatches an allowed type for a scoped connection and any type for an unscoped one', async () => {
    let seen = 0
    registerMessageHandler('client_visible', () => { seen++ })
    const { ctx } = makeCtx()
    await handleSessionMessage({}, { id: 'c1', boundSessionId: 'sess-a' }, { type: 'client_visible' }, ctx)
    await handleSessionMessage({}, { id: 'c2' }, { type: 'client_visible' }, ctx)
    assert.equal(seen, 2)
  })
})

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return { ws, messages }
}

describe('session-scoped connection over a real socket', () => {
  let server
  let pm
  afterEach(() => {
    if (server) { server.close(); server = null }
    if (pm) { pm.destroy(); pm = null }
  })

  async function start() {
    pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const { manager } = createMockSessionManager([
      { id: 'session-1', name: 'One', cwd: '/tmp/project-1' },
      { id: 'session-2', name: 'Two', cwd: '/tmp/project-2' },
    ])
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, pairingManager: pm })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return server.httpServer.address().port
  }

  async function authed(port, token) {
    const c = await connect(port)
    c.ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => c.messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    return c
  }

  const PROBES = [
    { type: 'notification_prefs_set', requestId: 'p1', prefs: { enabled: false } },
    { type: 'notification_prefs_get', requestId: 'p2' },
    { type: 'list_repos' },
    { type: 'list_directory', path: '/tmp' },
    { type: 'request_cost_summary' },
    { type: 'list_web_tasks' },
    { type: 'set_permission_rules', requestId: 'p3', rules: [{ tool: 'Write', decision: 'allow' }] },
    { type: 'restore_checkpoint', checkpointId: 'cp-1', mode: 'files' },
  ]

  for (const probe of PROBES) {
    it(`refuses ${probe.type} for a scoped token and not for the primary token`, async () => {
      const port = await start()
      const scopedToken = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
      const scoped = await authed(port, scopedToken)
      scoped.ws.send(JSON.stringify(probe))
      const refusal = await waitFor(
        () => scoped.messages.find((m) => m.type === 'session_error' && m.requestType === probe.type),
        { label: `refusal of ${probe.type}` },
      )
      assert.equal(refusal.code, 'SESSION_TOKEN_MISMATCH')
      scoped.ws.close()

      const primary = await authed(port, 'primary-tok')
      primary.ws.send(JSON.stringify(probe))
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(primary.messages.some((m) => m.type === 'session_error' && m.requestType === probe.type), false)
      primary.ws.close()
    })
  }

  // Issue #9039: a refused request always gets the one refusal reply, whatever
  // its shape or the server's state, and the refusal does nothing.
  async function scopedClient() {
    const port = await start()
    const scopedToken = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    return authed(port, scopedToken)
  }
  const refusalFor = (c, type) => waitFor(
    () => c.messages.find((m) => m.type === 'session_error' && m.requestType === type),
    { label: `refusal of ${type}` },
  )

  it('replies to a scoped revoke_token with a refusal and does not revoke', async () => {
    let revoked = 0
    const scoped = await scopedClient()
    server._tokenManager = { revoke: () => { revoked++ } }
    scoped.ws.send(JSON.stringify({ type: 'revoke_token', requestId: 'rv1' }))
    const refusal = await refusalFor(scoped, 'revoke_token')
    assert.equal(refusal.message, 'Not available to a session-scoped connection')
    assert.equal(refusal.code, 'SESSION_TOKEN_MISMATCH')
    assert.equal(refusal.requestId, 'rv1')
    assert.equal(revoked, 0)
    scoped.ws.close()
  })

  it('refuses every denied type with the same reply even when the request is malformed', async () => {
    const scoped = await scopedClient()
    for (const type of denied) {
      scoped.ws.send(JSON.stringify({ type, requestId: `bare-${type}` }))
    }
    for (const type of denied) {
      const refusal = await refusalFor(scoped, type)
      assert.equal(refusal.message, 'Not available to a session-scoped connection', type)
      assert.equal(refusal.requestId, `bare-${type}`)
    }
    assert.equal(scoped.messages.some((m) => m.type === 'error' && m.code === 'INVALID_MESSAGE'), false)
    scoped.ws.close()
  })

  it('refuses an unknown type, and the refusal names only the connection\'s own session', async () => {
    const scoped = await scopedClient()
    scoped.ws.send(JSON.stringify({ type: 'zz_not_a_real_type' }))
    const refusal = await refusalFor(scoped, 'zz_not_a_real_type')
    assert.equal(refusal.boundSessionId, 'session-1')
    const text = JSON.stringify(refusal)
    assert.equal(text.includes('session-2'), false)
    assert.equal(text.includes('Two'), false)
    scoped.ws.close()
  })

  it('refuses a request with no type, or a non-string type, with the same reply', async () => {
    const scoped = await scopedClient()
    scoped.ws.send(JSON.stringify({ requestId: 'nt1' }))
    scoped.ws.send(JSON.stringify({ type: 5, requestId: 'nt2' }))
    for (const id of ['nt1', 'nt2']) {
      const refusal = await waitFor(
        () => scoped.messages.find((m) => m.type === 'session_error' && m.requestId === id),
        { label: `refusal of ${id}` },
      )
      assert.equal(refusal.code, 'SESSION_TOKEN_MISMATCH')
      assert.equal('requestType' in refusal, false)
    }
    assert.equal(scoped.messages.some((m) => m.type === 'error' && m.code === 'INVALID_MESSAGE'), false)
    scoped.ws.close()
  })

  it('names only its own session even when the request names another', async () => {
    const scoped = await scopedClient()
    scoped.ws.send(JSON.stringify({ type: 'zz', sessionId: 'session-2', requestId: 'o1' }))
    const refusal = await waitFor(
      () => scoped.messages.find((m) => m.type === 'session_error' && m.requestId === 'o1'),
      { label: 'refusal naming another session' },
    )
    assert.equal('sessionId' in refusal, false)
    assert.equal(refusal.boundSessionId, 'session-1')
    assert.equal(JSON.stringify(refusal).includes('session-2'), false)
    scoped.ws.close()
  })

  it('caps a flood of refused requests with the rate limiter', async () => {
    const scoped = await scopedClient()
    const total = 160
    for (let i = 0; i < total; i++) scoped.ws.send(JSON.stringify({ type: 'revoke_token', requestId: `f${i}` }))
    await waitFor(
      () => scoped.messages.filter((m) => m.type === 'session_error' || m.type === 'rate_limited').length >= total,
      { label: 'every flood request answered' },
    )
    const refusals = scoped.messages.filter((m) => m.type === 'session_error').length
    const limited = scoped.messages.filter((m) => m.type === 'rate_limited').length
    assert.equal(refusals, 120)
    assert.equal(limited, total - 120)
    scoped.ws.close()
  })

  it('still replies with the refusal while the server is draining', async () => {
    const scoped = await scopedClient()
    server.setDraining(true)
    scoped.ws.send(JSON.stringify({ type: 'revoke_token', requestId: 'dr1' }))
    const refusal = await refusalFor(scoped, 'revoke_token')
    assert.equal(refusal.requestId, 'dr1')
    scoped.ws.close()
  })
})
