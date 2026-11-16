import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PrincipalPendingPermissionsSchema, ClientMessageSchema,
  ServerPrincipalPendingPermissionsResultSchema, PRINCIPAL_PENDING_PERMISSIONS_MAX,
  ServerPermissionResolvedSchema, PERMISSION_RESOLVED_BY_KIND_VALUES,
} from '../src/schemas/index.ts'

const request = {
  requestId: 'perm-1', sessionId: 's', tool: 'Bash', floored: false, explicitConsent: false, nonDelegable: false,
  origin: 'in_process', createdAt: 1_800_000_000_000, expiresAt: 1_800_000_300_000, description: 'ls',
}

describe('principal_pending_permissions (#9119)', () => {
  it('the request is a member of the client message union', () => {
    assert.ok(ClientMessageSchema.options.map((o) => o.shape.type.value).includes('principal_pending_permissions'))
  })

  it('needs a requestId; sessionIds is optional but never empty and capped at 32', () => {
    const ok = { type: 'principal_pending_permissions', requestId: 'r' }
    assert.equal(PrincipalPendingPermissionsSchema.safeParse(ok).success, true)
    assert.equal(PrincipalPendingPermissionsSchema.safeParse({ ...ok, sessionIds: ['s'] }).success, true)
    assert.equal(PrincipalPendingPermissionsSchema.safeParse({ ...ok, sessionIds: [] }).success, false)
    assert.equal(PrincipalPendingPermissionsSchema.safeParse({ ...ok, sessionIds: new Array(33).fill('s') }).success, false)
    assert.equal(PrincipalPendingPermissionsSchema.safeParse({ ...ok, requestId: '' }).success, false)
    assert.equal(PrincipalPendingPermissionsSchema.safeParse({ type: 'principal_pending_permissions' }).success, false)
  })

  it('the result carries the verdicts, a deadline and a freshness stamp, and is capped at 100', () => {
    const ok = { type: 'principal_pending_permissions_result', requestId: 'r', generatedAt: 1_800_000_000_001, permissions: [request], truncated: false }
    assert.equal(ServerPrincipalPendingPermissionsResultSchema.safeParse(ok).success, true)
    assert.equal(ServerPrincipalPendingPermissionsResultSchema.safeParse({ ...ok, generatedAt: undefined }).success, false)
    assert.equal(ServerPrincipalPendingPermissionsResultSchema.safeParse({ ...ok, truncated: undefined }).success, false)
    assert.equal(PRINCIPAL_PENDING_PERMISSIONS_MAX, 100)
    assert.equal(ServerPrincipalPendingPermissionsResultSchema.safeParse({ ...ok, permissions: new Array(101).fill(request) }).success, false)
    assert.equal(ServerPrincipalPendingPermissionsResultSchema.safeParse({ ...ok, permissions: new Array(100).fill(request) }).success, true)
    // a request the daemon cannot date still parses (null), and an unknown origin does not
    assert.equal(ServerPrincipalPendingPermissionsResultSchema.safeParse({ ...ok, permissions: [{ ...request, createdAt: null, expiresAt: null }] }).success, true)
    assert.equal(ServerPrincipalPendingPermissionsResultSchema.safeParse({ ...ok, permissions: [{ ...request, origin: 'elsewhere' }] }).success, false)
  })
})

describe('permission_resolved resolvedBy (#9119)', () => {
  const base = { type: 'permission_resolved', requestId: 'r', decision: 'allow' }

  it('is optional: a frame without it, from an older daemon, still parses', () => {
    const parsed = ServerPermissionResolvedSchema.safeParse(base)
    assert.equal(parsed.success, true)
    assert.equal('resolvedBy' in parsed.data, false)
  })

  it('carries a class and, for an agent, a label', () => {
    for (const kind of PERMISSION_RESOLVED_BY_KIND_VALUES) {
      const parsed = ServerPermissionResolvedSchema.safeParse({ ...base, resolvedBy: { kind } })
      assert.equal(parsed.success, true, kind)
      assert.deepEqual(parsed.data.resolvedBy, { kind })
    }
    assert.deepEqual(PERMISSION_RESOLVED_BY_KIND_VALUES, ['user', 'agent', 'rule', 'timeout', 'auto_mode', 'abort', 'cleared'])
    const agent = ServerPermissionResolvedSchema.safeParse({ ...base, resolvedBy: { kind: 'agent', label: 'supervisor' } })
    assert.deepEqual(agent.data.resolvedBy, { kind: 'agent', label: 'supervisor' })
  })

  it('a kind a newer daemon adds does not fail the frame, and no other field survives the parse', () => {
    const parsed = ServerPermissionResolvedSchema.safeParse({ ...base, resolvedBy: { kind: 'quorum', clientId: 'c-1' } })
    assert.equal(parsed.success, true)
    assert.deepEqual(parsed.data.resolvedBy, { kind: 'quorum' })
  })
})
