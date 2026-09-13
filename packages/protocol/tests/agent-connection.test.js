import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentConnectionSchema } from '../src/agent-connection.ts'
import { CreateSessionSchema } from '../src/schemas/client.ts'
import { ServerProviderListSchema, ServerSessionListEntrySchema } from '../src/schemas/server.ts'

const CONNECTION = {
  version: 1,
  id: 'codex-native',
  label: 'Codex subscription',
  provider: 'openai',
  runtime: { id: 'codex', version: null },
  accountRef: null,
  authentication: { requested: 'native', observed: 'unknown' },
  entitlement: { route: 'subscription', status: 'unknown' },
  model: { requested: null, resolved: null },
  execution: { host: 'daemon', inference: 'remote' },
  readiness: {
    state: 'unknown',
    reasonCode: 'READINESS_UNVERIFIED',
    message: 'Verified when the runtime starts.',
    recoveryAction: null,
  },
  provenance: {
    source: 'configured',
    observedAt: '2026-09-13T00:00:00.000Z',
    expiresAt: null,
  },
}

describe('AgentConnection wire contract (#7821)', () => {
  it('accepts the same bounded descriptor in provider and session snapshots', () => {
    assert.equal(AgentConnectionSchema.safeParse(CONNECTION).success, true)
    assert.equal(ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{ name: 'codex', connections: [CONNECTION] }],
    }).success, true)
    assert.equal(ServerSessionListEntrySchema.safeParse({
      sessionId: 'session-1',
      name: 'One',
      agentConnection: CONNECTION,
    }).success, true)
  })

  it('accepts a bounded explicit connectionId on create_session', () => {
    assert.equal(CreateSessionSchema.safeParse({
      type: 'create_session',
      provider: 'codex',
      connectionId: CONNECTION.id,
    }).success, true)
    assert.equal(CreateSessionSchema.safeParse({
      type: 'create_session',
      connectionId: '-starts-with-option',
    }).success, false)
  })

  it('rejects secret-bearing and unbounded descriptors at the wire boundary', () => {
    assert.equal(AgentConnectionSchema.safeParse({ ...CONNECTION, token: 'secret' }).success, false)
    assert.equal(AgentConnectionSchema.safeParse({ ...CONNECTION, label: 'x'.repeat(201) }).success, false)
  })
})
