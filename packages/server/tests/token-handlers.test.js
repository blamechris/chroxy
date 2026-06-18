import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tokenHandlers } from '../src/handlers/token-handlers.js'

/**
 * #6006 — the operator panic button handler (`revoke_token`). Gated on the
 * PRIMARY token; on success it fires TokenManager.revoke() (whose downstream
 * sever + force-re-auth behavior is covered by ws-server-auth.test.js). Here we
 * assert the gate + trigger wiring in isolation.
 */

const handleRevokeToken = tokenHandlers.revoke_token

function makeCtx({ tokenManager } = {}) {
  const sent = []
  const ctx = {
    transport: { send: (_ws, msg) => sent.push(msg) },
    services: { tokenManager },
  }
  return { ctx, sent }
}

const WS = {} // opaque socket handle

describe('revoke_token handler (#6006)', () => {
  it('fires TokenManager.revoke() for a primary-token client', () => {
    let revoked = 0
    const { ctx, sent } = makeCtx({ tokenManager: { revoke: () => { revoked++ } } })
    handleRevokeToken(WS, { id: 'c1', isPrimaryToken: true }, { type: 'revoke_token' }, ctx)
    assert.equal(revoked, 1, 'revoke() called once')
    assert.equal(sent.length, 0, 'no error sent on success (de-auth + token_rotated is the ack)')
  })

  it('rejects a non-primary (paired) client with NOT_AUTHORIZED and does NOT revoke', () => {
    let revoked = 0
    const { ctx, sent } = makeCtx({ tokenManager: { revoke: () => { revoked++ } } })
    handleRevokeToken(WS, { id: 'c2', isPrimaryToken: false }, { type: 'revoke_token' }, ctx)
    assert.equal(revoked, 0, 'revoke() NOT called for a non-primary client')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'error')
    assert.equal(sent[0].code, 'NOT_AUTHORIZED')
  })

  it('rejects a client whose isPrimaryToken is undefined (strict === true gate)', () => {
    let revoked = 0
    const { ctx, sent } = makeCtx({ tokenManager: { revoke: () => { revoked++ } } })
    handleRevokeToken(WS, { id: 'c3' }, { type: 'revoke_token' }, ctx)
    assert.equal(revoked, 0)
    assert.equal(sent[0].code, 'NOT_AUTHORIZED')
  })

  it('returns REVOKE_UNAVAILABLE when no TokenManager is configured (--no-auth)', () => {
    const { ctx, sent } = makeCtx({ tokenManager: null })
    handleRevokeToken(WS, { id: 'c4', isPrimaryToken: true }, { type: 'revoke_token' }, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].code, 'REVOKE_UNAVAILABLE')
  })

  it('returns REVOKE_UNAVAILABLE when the manager lacks a revoke() method', () => {
    const { ctx, sent } = makeCtx({ tokenManager: { rotate: () => {} } })
    handleRevokeToken(WS, { id: 'c5', isPrimaryToken: true }, { type: 'revoke_token' }, ctx)
    assert.equal(sent[0].code, 'REVOKE_UNAVAILABLE')
  })
})
