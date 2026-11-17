import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PrincipalSessionsSnapshotSchema, ClientMessageSchema,
  ServerPrincipalSessionsSnapshotResultSchema, PRINCIPAL_SESSIONS_SNAPSHOT_MAX,
} from '../src/schemas/index.ts'

const row = {
  sessionId: 's',
  name: 'One',
  provider: 'claude-sdk',
  status: { isBusy: true, busyReason: 'turn', starting: false },
  declaredStatus: { state: 'blocked', summary: 'waiting', blockedOn: 'review', updatedAt: 1_800_000_000_000, source: 'api' },
  model: { requested: null, observed: 'claude-sonnet-4' },
  blockers: [{ code: 'turn_active' }, { code: 'queued_prompts', detail: { count: 2 } }],
  leaseHolder: null,
  lastActivityAt: 1_800_000_000_000,
}
const ok = { type: 'principal_sessions_snapshot_result', requestId: 'r', generatedAt: 1_800_000_000_001, sessions: [row], truncated: false }

describe('principal_sessions_snapshot (#9120)', () => {
  it('the request is a member of the client message union', () => {
    assert.ok(ClientMessageSchema.options.map((o) => o.shape.type.value).includes('principal_sessions_snapshot'))
  })

  it('needs a requestId; sessionIds is optional but never empty and capped at 32', () => {
    const base = { type: 'principal_sessions_snapshot', requestId: 'r' }
    assert.equal(PrincipalSessionsSnapshotSchema.safeParse(base).success, true)
    assert.equal(PrincipalSessionsSnapshotSchema.safeParse({ ...base, sessionIds: ['s'] }).success, true)
    assert.equal(PrincipalSessionsSnapshotSchema.safeParse({ ...base, sessionIds: [] }).success, false)
    assert.equal(PrincipalSessionsSnapshotSchema.safeParse({ ...base, sessionIds: new Array(33).fill('s') }).success, false)
    assert.equal(PrincipalSessionsSnapshotSchema.safeParse({ ...base, requestId: '' }).success, false)
    assert.equal(PrincipalSessionsSnapshotSchema.safeParse({ type: 'principal_sessions_snapshot' }).success, false)
  })

  it('the result carries a freshness stamp, the rows and a truncation flag, and is capped at 100 rows', () => {
    assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse(ok).success, true)
    assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse({ ...ok, generatedAt: undefined }).success, false)
    assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse({ ...ok, truncated: undefined }).success, false)
    assert.equal(PRINCIPAL_SESSIONS_SNAPSHOT_MAX, 100)
    assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse({ ...ok, sessions: new Array(101).fill(row) }).success, false)
    assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse({ ...ok, sessions: new Array(100).fill(row) }).success, true)
  })

  it('a row whose read failed (null fields, unavailable blocker) still parses; a row with no blockers field does not', () => {
    const failed = { ...row, name: null, provider: null, status: null, declaredStatus: null, model: null, lastActivityAt: null, blockers: [{ code: 'unavailable' }] }
    assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse({ ...ok, sessions: [failed] }).success, true)
    const { blockers: _drop, ...noBlockers } = row
    assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse({ ...ok, sessions: [noBlockers] }).success, false)
  })

  it('a blocker code a newer daemon adds still parses, and an unknown busy reason does not', () => {
    assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse({ ...ok, sessions: [{ ...row, blockers: [{ code: 'quorum_pending' }] }] }).success, true)
    assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse({ ...ok, sessions: [{ ...row, status: { ...row.status, busyReason: 'sleeping' } }] }).success, false)
  })
})
