import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer } from '../src/ws-server.js'
import { createMockSessionManager } from './test-helpers.js'

// #7977: the deferred (post-approval) replies echo the create's requestId.
function makeWs() {
  const messages = []
  return { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)), _messages: messages }
}

describe('post-approval replies echo the create requestId (#7977)', () => {
  let server

  function setup() {
    const { manager } = createMockSessionManager()
    manager.createSession = () => 'sess-approved'
    manager.getSession = () => ({ name: 'shell', cwd: '/tmp', session: { resumeSessionId: null } })
    manager.getSessionPreset = () => null
    server = new WsServer({ port: 0, apiToken: 'tok', authRequired: false, noEncrypt: true, sessionManager: manager, config: { userShell: { enabled: true, requireApproval: true } } })
    const ws = makeWs()
    const client = { id: 'c-req', authenticated: true, isPrimaryToken: true, subscribedSessionIds: new Set(), boundSessionId: null, authToken: 'tok', encryptionState: null }
    server.clients.set(ws, client)
    return ws
  }

  after(() => { try { server?.close() } catch { /* never started */ } })

  it('completeShellApproval puts the stored requestId on the session_switched', () => {
    const ws = setup()
    server.completeShellApproval({ clientId: 'c-req', createSessionOptions: { provider: 'user-shell' }, tokenClass: 'primary', requestId: 'ac-req-11' })
    const switched = ws._messages.find((m) => m.type === 'session_switched')
    assert.ok(switched, 'requester is told the create landed')
    assert.equal(switched.requestId, 'ac-req-11')
  })

  it('completeShellApproval omits requestId when the held create had none', () => {
    const ws = setup()
    server.completeShellApproval({ clientId: 'c-req', createSessionOptions: { provider: 'user-shell' }, tokenClass: 'primary' })
    const switched = ws._messages.find((m) => m.type === 'session_switched')
    assert.ok(switched)
    assert.equal('requestId' in switched, false)
  })

  it('notifyShellDenied puts the stored requestId on SHELL_APPROVAL_DENIED', () => {
    const ws = setup()
    server.notifyShellDenied({ clientId: 'c-req', requestId: 'ac-req-12' })
    const err = ws._messages.find((m) => m.type === 'session_error')
    assert.equal(err.code, 'SHELL_APPROVAL_DENIED')
    assert.equal(err.requestId, 'ac-req-12')
  })
})
