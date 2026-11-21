import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PrincipalAdminGrantSchema, PrincipalAdminListSchema, PrincipalAdminRevokeSchema, PrincipalAdminDisableSchema, PrincipalAdminEnableSchema, ClientMessageSchema,
  ServerPrincipalAdminResultSchema,
} from '../src/schemas/index.ts'

describe('principal_admin_* client schemas (#9116)', () => {
  it('each is a member of the client message union', () => {
    const types = ClientMessageSchema.options.map((o) => o.shape.type.value)
    for (const t of ['principal_admin_grant', 'principal_admin_list', 'principal_admin_revoke']) assert.ok(types.includes(t), t)
  })

  it('grant: accepts the documented shape, rejects a missing label or scope, an oversized id list and a non-integer ttl', () => {
    const ok = { type: 'principal_admin_grant', requestId: 'r', label: 'sup', scope: 'observe', sessionIds: ['s'], cwdRoots: ['/r'], ttlMs: 1000 }
    assert.equal(PrincipalAdminGrantSchema.safeParse(ok).success, true)
    assert.equal(PrincipalAdminGrantSchema.safeParse({ ...ok, label: undefined }).success, false)
    assert.equal(PrincipalAdminGrantSchema.safeParse({ ...ok, scope: undefined }).success, false)
    assert.equal(PrincipalAdminGrantSchema.safeParse({ ...ok, sessionIds: new Array(65).fill('s') }).success, false)
    assert.equal(PrincipalAdminGrantSchema.safeParse({ ...ok, ttlMs: 1.5 }).success, false)
    assert.equal(PrincipalAdminGrantSchema.safeParse({ ...ok, ttlMs: -1 }).success, false)
  })

  it('list and revoke: accept their fields and reject other types', () => {
    assert.equal(PrincipalAdminListSchema.safeParse({ type: 'principal_admin_list' }).success, true)
    assert.equal(PrincipalAdminListSchema.safeParse({ type: 'principal_admin_revoke' }).success, false)
    assert.equal(PrincipalAdminRevokeSchema.safeParse({ type: 'principal_admin_revoke', principalId: 'p' }).success, true)
    assert.equal(PrincipalAdminRevokeSchema.safeParse({ type: 'principal_admin_revoke', label: 'l', requestId: 'r' }).success, true)
    assert.equal(PrincipalAdminRevokeSchema.safeParse({ type: 'principal_admin_revoke', principalId: 'x'.repeat(65) }).success, false)
  })
})

describe('principal_admin_disable / principal_admin_enable client schemas (S11)', () => {
  it('both are members of the client message union', () => {
    const types = ClientMessageSchema.options.map((o) => o.shape.type.value)
    for (const t of ['principal_admin_disable', 'principal_admin_enable']) assert.ok(types.includes(t), t)
  })

  it('accept { all: true } or { label } with an optional requestId, and reject other shapes', () => {
    for (const [schema, type] of [[PrincipalAdminDisableSchema, 'principal_admin_disable'], [PrincipalAdminEnableSchema, 'principal_admin_enable']]) {
      assert.equal(schema.safeParse({ type, all: true }).success, true)
      assert.equal(schema.safeParse({ type, label: 'sup', requestId: 'r' }).success, true)
      assert.equal(schema.safeParse({ type, all: false }).success, false, 'all is only ever the literal true')
      assert.equal(schema.safeParse({ type, label: 'x'.repeat(65) }).success, false)
      assert.equal(schema.safeParse({ type: 'principal_admin_list', all: true }).success, false)
    }
  })

  it('the result schema accepts the disable/enable ops, the disabled state and the switch summary', () => {
    const base = { type: 'principal_admin_result', requestId: 'r', ok: true, durable: false, message: 'not durable', disabled: { all: true, labels: [] } }
    assert.equal(ServerPrincipalAdminResultSchema.safeParse({ ...base, op: 'disable' }).success, true)
    assert.equal(ServerPrincipalAdminResultSchema.safeParse({ ...base, op: 'enable' }).success, true)
    assert.equal(ServerPrincipalAdminResultSchema.safeParse({ ...base, op: 'frobnicate' }).success, false)
  })
})

describe('principal_admin_result server schema (#9116)', () => {
  const entry = { principalId: 'p', label: 'l', tier: 'observe', scope: 'observe', constraints: { sessionIds: ['s'] }, createdAt: 1, expiresAt: 2, revokedAt: null, state: 'live' }
  it('accepts the list, revoke and grant-refusal replies', () => {
    const base = { type: 'principal_admin_result', requestId: null }
    assert.equal(ServerPrincipalAdminResultSchema.safeParse({ ...base, op: 'list', ok: true, health: { ok: true, status: 'ok', reason: null }, principals: [entry] }).success, true)
    assert.equal(ServerPrincipalAdminResultSchema.safeParse({ ...base, op: 'revoke', ok: true, principalId: 'p', alreadyRevoked: false, durable: true }).success, true)
    assert.equal(ServerPrincipalAdminResultSchema.safeParse({ ...base, op: 'grant', ok: false, code: 'PRINCIPALS_NOT_ENABLED', message: 'agent principals not yet enabled' }).success, true)
  })

  it('rejects an unknown op, an unknown state and a token field is not part of the shape', () => {
    const base = { type: 'principal_admin_result', requestId: null, ok: true }
    assert.equal(ServerPrincipalAdminResultSchema.safeParse({ ...base, op: 'mint' }).success, false)
    assert.equal(ServerPrincipalAdminResultSchema.safeParse({ ...base, op: 'list', principals: [{ ...entry, state: 'zombie' }] }).success, false)
    assert.equal('token' in ServerPrincipalAdminResultSchema.shape, false)
    assert.equal('tokenHash' in ServerPrincipalAdminResultSchema.shape.principals.unwrap().element.shape, false)
  })
})
