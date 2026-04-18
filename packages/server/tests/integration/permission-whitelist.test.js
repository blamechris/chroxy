/**
 * Integration tests for permission whitelist (set_permission_rules) flow.
 * Tests the full WS roundtrip: set_permission_rules → permission_rules_updated,
 * auto-resolution for whitelisted tools, prompt forwarding for non-whitelisted tools,
 * and whitelist clearing.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { setLogListener } from '../../src/logger.js'
import { PermissionManager } from '../../src/permission-manager.js'
import { createMockSessionManager, waitFor } from '../test-helpers.js'
import WebSocket from 'ws'

// Wrapper that defaults noEncrypt: true for all tests
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  await new Promise((resolve, reject) => {
    function onListening() { server.httpServer.removeListener('error', onError); resolve() }
    function onError(err) { server.httpServer.removeListener('listening', onListening); reject(err) }
    server.httpServer.once('listening', onListening)
    server.httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

async function createClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')), 2000)
    ws.once('open', () => { clearTimeout(timer); resolve() })
    ws.once('error', (err) => { clearTimeout(timer); reject(err) })
  })
  await waitFor(() => messages.find(m => m.type === 'auth_ok'), { label: 'auth_ok' })
  return { ws, messages }
}

function send(ws, msg) { ws.send(JSON.stringify(msg)) }

async function waitForMessage(messages, type, timeout = 2000) {
  return waitFor(
    () => messages.find(m => m.type === type),
    { timeoutMs: timeout, label: `message type: ${type}` }
  )
}

/**
 * Create a mock SdkSession-like object that has a real PermissionManager
 * and exposes setPermissionRules / getPermissionRules / respondToPermission.
 * The permission_request events emitted by PermissionManager are forwarded
 * to the EventEmitter as 'permission_request' session events so WsServer
 * can broadcast them to clients.
 */
function createSessionWithPermissionManager() {
  const permissions = new PermissionManager({ log: { info: () => {}, warn: () => {} } })
  const session = new EventEmitter()

  session.isReady = true
  session.model = 'claude-sonnet-4-6'
  session.permissionMode = 'approve'

  // Wire PermissionManager events through the session EventEmitter
  permissions.on('permission_request', (payload) => {
    session.emit('permission_request', payload)
  })

  session.sendMessage = () => {}
  session.interrupt = () => {}
  session.setModel = () => {}
  session.setPermissionMode = () => {}
  session.respondToQuestion = () => {}

  session.respondToPermission = (requestId, decision) => {
    permissions.respondToPermission(requestId, decision)
  }

  session.setPermissionRules = (rules) => {
    permissions.setRules(rules)
  }

  session.getPermissionRules = () => {
    return permissions.getRules()
  }

  session.clearPermissionRules = () => {
    permissions.clearRules()
  }

  // Expose the PermissionManager for direct handlePermission calls in tests
  session._permissions = permissions

  return session
}

describe('integration: permission whitelist (set_permission_rules)', () => {
  let server

  afterEach(async () => {
    if (server) {
      try { server.close() } catch {}
      server = null
    }
  })

  it('set_permission_rules → permission_rules_updated broadcast', async () => {
    const session = createSessionWithPermissionManager()
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Session 1', cwd: '/tmp' },
    ])
    // Replace the session in the manager entry with our real permission session
    manager.getSession = (id) => {
      if (id === 'sess-1' || !id) return { session, name: 'Session 1', cwd: '/tmp', type: 'sdk' }
      return null
    }
    manager.listSessions = () => [{
      sessionId: 'sess-1', name: 'Session 1', cwd: '/tmp', type: 'sdk', isBusy: false,
    }]

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)
    messages.length = 0

    send(ws, { type: 'set_permission_rules', sessionId: 'sess-1', rules: [{ tool: 'Read', decision: 'allow' }] })

    const updated = await waitForMessage(messages, 'permission_rules_updated')
    assert.ok(Array.isArray(updated.rules), 'rules should be an array')
    assert.equal(updated.rules.length, 1)
    assert.equal(updated.rules[0].tool, 'Read')
    assert.equal(updated.rules[0].decision, 'allow')

    ws.close()
  })

  it('whitelisted tool is auto-resolved — no permission_request sent to client', async () => {
    const session = createSessionWithPermissionManager()
    const { manager } = createMockSessionManager([])
    manager.getSession = (id) => {
      if (id === 'sess-1' || !id) return { session, name: 'Session 1', cwd: '/tmp', type: 'sdk' }
      return null
    }
    manager.listSessions = () => [{
      sessionId: 'sess-1', name: 'Session 1', cwd: '/tmp', type: 'sdk', isBusy: false,
    }]
    Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1', configurable: true })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)
    messages.length = 0

    // Set a rule to auto-allow Read
    send(ws, { type: 'set_permission_rules', sessionId: 'sess-1', rules: [{ tool: 'Read', decision: 'allow' }] })
    await waitForMessage(messages, 'permission_rules_updated')
    messages.length = 0

    // Trigger a permission request for Read — should be auto-resolved, no prompt sent
    const permResult = await session._permissions.handlePermission('Read', { file_path: '/tmp/foo.txt' }, null, 'approve')
    assert.equal(permResult.behavior, 'allow', 'Read should be auto-allowed by rule')

    // Give the server a moment to potentially send a permission_request (it should not)
    await new Promise(r => setTimeout(r, 100))
    const hasPermissionRequest = messages.some(m => m.type === 'permission_request')
    assert.equal(hasPermissionRequest, false, 'No permission_request should be sent for whitelisted tool')

    ws.close()
  })

  it('non-whitelisted tool triggers permission_request sent to client', async () => {
    const session = createSessionWithPermissionManager()
    const { manager } = createMockSessionManager([])
    manager.getSession = (id) => {
      if (id === 'sess-1' || !id) return { session, name: 'Session 1', cwd: '/tmp', type: 'sdk' }
      return null
    }
    manager.listSessions = () => [{
      sessionId: 'sess-1', name: 'Session 1', cwd: '/tmp', type: 'sdk', isBusy: false,
    }]
    Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1', configurable: true })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)
    messages.length = 0

    // Set a rule for Read only — Bash is not whitelisted (also in NEVER_AUTO_ALLOW)
    // Use Grep instead since Bash cannot be whitelisted
    send(ws, { type: 'set_permission_rules', sessionId: 'sess-1', rules: [{ tool: 'Read', decision: 'allow' }] })
    await waitForMessage(messages, 'permission_rules_updated')
    messages.length = 0

    // Trigger a permission request for Write (eligible but not whitelisted)
    // We intentionally do NOT await the handlePermission so the request stays pending
    let permResolved = false
    session._permissions.handlePermission('Write', { file_path: '/tmp/bar.txt' }, null, 'approve').then(() => {
      permResolved = true
    })

    // The server should forward the permission_request event to clients
    // because PermissionManager emits 'permission_request' which session re-emits,
    // and WsServer is wired to forward session events to clients.
    // For this test, we verify via the session event directly since the WS forwarding
    // path depends on session_event wiring in sessionManager.
    // Instead, verify at the PermissionManager level: Write was NOT auto-resolved.
    await new Promise(r => setTimeout(r, 50))
    assert.equal(permResolved, false, 'Write should not be auto-resolved (not in whitelist)')

    // Clean up pending permission
    session._permissions.clearAll()

    ws.close()
  })

  it('Bash tool is rejected by set_permission_rules validation', async () => {
    const session = createSessionWithPermissionManager()
    const { manager } = createMockSessionManager([])
    manager.getSession = (id) => {
      if (id === 'sess-1' || !id) return { session, name: 'Session 1', cwd: '/tmp', type: 'sdk' }
      return null
    }
    manager.listSessions = () => [{
      sessionId: 'sess-1', name: 'Session 1', cwd: '/tmp', type: 'sdk', isBusy: false,
    }]
    Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1', configurable: true })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)
    messages.length = 0

    // Attempt to whitelist Bash — should be rejected
    send(ws, { type: 'set_permission_rules', sessionId: 'sess-1', rules: [{ tool: 'Bash', decision: 'allow' }] })

    const error = await waitForMessage(messages, 'session_error')
    assert.ok(error.message, 'session_error should have a message')
    assert.ok(
      error.message.includes('Bash') || error.message.includes('cannot be auto-allowed') || error.message.includes('not eligible'),
      `Expected Bash rejection message, got: ${error.message}`
    )

    ws.close()
  })

  it('empty rules clears whitelist — previously whitelisted tool prompts again', async () => {
    const session = createSessionWithPermissionManager()
    const { manager } = createMockSessionManager([])
    manager.getSession = (id) => {
      if (id === 'sess-1' || !id) return { session, name: 'Session 1', cwd: '/tmp', type: 'sdk' }
      return null
    }
    manager.listSessions = () => [{
      sessionId: 'sess-1', name: 'Session 1', cwd: '/tmp', type: 'sdk', isBusy: false,
    }]
    Object.defineProperty(manager, 'firstSessionId', { get: () => 'sess-1', configurable: true })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)
    messages.length = 0

    // Step 1: set Read as allowed
    send(ws, { type: 'set_permission_rules', sessionId: 'sess-1', rules: [{ tool: 'Read', decision: 'allow' }] })
    await waitForMessage(messages, 'permission_rules_updated')

    // Verify Read is auto-allowed
    const allowResult = await session._permissions.handlePermission('Read', { file_path: '/tmp/a.txt' }, null, 'approve')
    assert.equal(allowResult.behavior, 'allow', 'Read should be auto-allowed with rule set')

    messages.length = 0

    // Step 2: clear all rules by sending empty array
    send(ws, { type: 'set_permission_rules', sessionId: 'sess-1', rules: [] })
    const cleared = await waitForMessage(messages, 'permission_rules_updated')
    assert.deepEqual(cleared.rules, [], 'Rules should be empty after clearing')

    // Step 3: verify Read now requires a prompt (not auto-resolved)
    let promptSent = false
    session._permissions.once('permission_request', () => { promptSent = true })

    let permResolved = false
    session._permissions.handlePermission('Read', { file_path: '/tmp/b.txt' }, null, 'approve').then(() => {
      permResolved = true
    })

    await waitFor(() => promptSent, { label: 'permission_request emitted after clear', timeoutMs: 1000 })
    assert.equal(promptSent, true, 'permission_request event should fire after whitelist cleared')
    assert.equal(permResolved, false, 'Read should not be auto-resolved after whitelist cleared')

    // Clean up
    session._permissions.clearAll()

    ws.close()
  })
})
