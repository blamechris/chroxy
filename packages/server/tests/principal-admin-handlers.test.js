/**
 * The management handlers' own gate (agent-principals.md section 3.1): strict-primary,
 * unbound, not a principal, loopback. Called DIRECTLY with dispatch bypassed, so the
 * handler is shown to refuse on its own, and the refusal is the handler's FIRST statement
 * (it reads nothing from the context, which the recording context proves).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { principalAdminHandlers } from '../src/handlers/principal-admin-handlers.js'
import { BOUND_DENIED_MESSAGE_TYPES } from '../src/bound-client-policy.js'
import { PRINCIPAL_DENIED_MESSAGE_TYPES, PRINCIPAL_ALLOWED_MESSAGE_TYPES } from '../src/principal-policy.js'
import { registeredMessageTypes } from '../src/ws-message-handlers.js'
import { PRINCIPAL_BINDING_SENTINEL } from '../src/principal-binding.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal } from './helpers/principal-store-fixture.js'

const TYPES = ['principal_admin_grant', 'principal_admin_list', 'principal_admin_revoke']
const LOOPBACK_REQ = { socket: { remoteAddress: '127.0.0.1' }, headers: {} }

const host = (over = {}) => ({ id: 'h', isPrimaryToken: true, boundSessionId: null, _upgradeReq: LOOPBACK_REQ, loopbackAtUpgrade: true, ...over })
const MSG = { requestId: 'r1', label: 'x', scope: 'observe', principalId: 'pr-1' }

async function call(type, client, ctxOver = {}) {
  const sent = []
  const touched = []
  const ctx = {
    transport: { send: (_ws, m) => sent.push(m) },
    services: new Proxy({ ...ctxOver }, { get: (t, p) => { if (typeof p === 'string') touched.push(p); return t[p] } }),
  }
  await principalAdminHandlers[type]({}, client, { type, ...MSG }, ctx)
  return { sent, touched }
}

describe('registration and classification', () => {
  it('the three types are registered, denied to bound clients and principals, and allowed to neither', () => {
    let cases = 0
    for (const t of TYPES) {
      cases++
      assert.ok(registeredMessageTypes.includes(t), t)
      assert.ok(Object.hasOwn(BOUND_DENIED_MESSAGE_TYPES, t), `${t} must be in BOUND_DENIED_MESSAGE_TYPES`)
      assert.ok(Object.hasOwn(PRINCIPAL_DENIED_MESSAGE_TYPES, t), `${t} must be in PRINCIPAL_DENIED_MESSAGE_TYPES`)
      assert.equal(Object.hasOwn(PRINCIPAL_ALLOWED_MESSAGE_TYPES, t), false)
    }
    assert.ok(cases === 3)
  })
})

describe('the gate is the first statement: every non-strict-primary caller is refused and nothing else is read', () => {
  const cases = {
    'a paired (non-primary) client': host({ isPrimaryToken: false }),
    'a client with no primary flag': host({ isPrimaryToken: undefined }),
    'a session-bound primary': host({ boundSessionId: 'sess-1' }),
    'a principal that somehow holds isPrimaryToken': host({ principal: { principalId: 'p' } }),
    'a principal with the sentinel': host({ isPrimaryToken: false, principal: {}, boundSessionId: PRINCIPAL_BINDING_SENTINEL }),
    'a primary over a proxy-hinted upgrade': host({ _upgradeReq: { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4' } } }),
    'a primary over a remote socket': host({ _upgradeReq: { socket: { remoteAddress: '203.0.113.9' }, headers: {} } }),
    'a primary with no retained upgrade request': host({ _upgradeReq: undefined }),
    'a null client': null,
  }
  for (const type of TYPES) {
    for (const [name, client] of Object.entries(cases)) {
      it(`${type}: ${name} gets NOT_AUTHORIZED and the handler reads nothing`, async () => {
        const store = { list: () => { throw new Error('reached the store') }, revoke: () => { throw new Error('reached the store') } }
        const { sent, touched } = await call(type, client, { principalStore: store, endPrincipalConnections: () => { throw new Error('ended') } })
        assert.equal(sent.length, 1)
        assert.equal(sent[0].code, 'NOT_AUTHORIZED')
        assert.equal(sent[0].ok, false)
        assert.equal(sent[0].requestId, 'r1')
        assert.deepEqual(touched, [], 'the refusal must come before the handler touches any service')
      })
    }
  }

  it('positive control: the strict primary on loopback is NOT refused by the gate, on every type', async () => {
    const d = tempPrincipalDir()
    try {
      const store = testPrincipalStore(d.path)
      insertPrincipal(store)
      const ended = []
      let n = 0
      for (const type of TYPES) {
        const { sent } = await call(type, host(), { principalStore: store, endPrincipalConnections: (id, why) => ended.push([id, why]) })
        n++
        assert.notEqual(sent[0].code, 'NOT_AUTHORIZED', type)
      }
      assert.ok(n === 3)
      assert.deepEqual(ended, [['pr-1', 'revoked']])
    } finally { d.cleanup() }
  })
})

describe('grant refuses from the handler itself', () => {
  it('replies not-yet-enabled and calls nothing', async () => {
    const { sent, touched } = await call('principal_admin_grant', host(), { principalStore: { grant: () => { throw new Error('minted') } } })
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'PRINCIPALS_NOT_ENABLED')
    assert.equal(sent[0].message, 'agent principals not yet enabled')
    assert.deepEqual(touched, [])
  })
})

describe('list and revoke without a store', () => {
  it('answer UNAVAILABLE rather than pretending', async () => {
    for (const type of ['principal_admin_list', 'principal_admin_revoke']) {
      const { sent } = await call(type, host(), {})
      assert.equal(sent[0].code, 'UNAVAILABLE', type)
    }
  })
})
