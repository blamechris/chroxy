import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ServerAuthOkSchema, ServerToolResultSchema, ServerToolStartSchema, ServerUserQuestionSchema,
  ServerErrorSchema, ServerHostStatusSnapshotSchema, ServerSessionErrorSchema, ServerMessageSchema,
} from '../src/schemas/index.ts'

// #8551: fields producers already send, now declared. Each block checks the field is KEPT
// on parse (zod strips undeclared keys on the strict objects), typed, and optional.

const ok = (schema, v) => schema.safeParse(v).success

const AUTH_OK = {
  type: 'auth_ok', clientId: 'c', serverMode: 'cli', serverVersion: '1', latestVersion: null,
  serverCommit: 'abc', cwd: null, connectedClients: [], encryption: 'disabled',
  protocolVersion: 1, minProtocolVersion: 1, maxProtocolVersion: 1,
}

describe('auth_ok handshake fields', () => {
  it('parses without them (older servers) and keeps them when present', () => {
    assert.equal(ok(ServerAuthOkSchema, AUTH_OK), true)
    const full = {
      ...AUTH_OK, defaultCwd: '/home/x', webFeatures: { available: true, remote: true, teleport: false },
      features: { environments: false },
    }
    const parsed = ServerAuthOkSchema.parse(full)
    assert.equal(parsed.defaultCwd, '/home/x')
    assert.deepEqual(parsed.webFeatures, full.webFeatures)
    assert.deepEqual(parsed.features, { environments: false })
  })
  it('accepts a null defaultCwd (session-bound client) and an unknown feature flag', () => {
    assert.equal(ok(ServerAuthOkSchema, { ...AUTH_OK, defaultCwd: null }), true)
    assert.equal(ServerAuthOkSchema.parse({ ...AUTH_OK, features: { environments: true, later: true } }).features.later, true)
  })
  it('rejects wrong types', () => {
    assert.equal(ok(ServerAuthOkSchema, { ...AUTH_OK, defaultCwd: 5 }), false)
    assert.equal(ok(ServerAuthOkSchema, { ...AUTH_OK, webFeatures: { available: 'yes', remote: true, teleport: false } }), false)
    assert.equal(ok(ServerAuthOkSchema, { ...AUTH_OK, features: { environments: 'yes' } }), false)
  })
})

describe('tool_result images', () => {
  const base = { type: 'tool_result', toolUseId: 't', result: 'r' }
  it('keeps images and still parses without them', () => {
    assert.equal(ok(ServerToolResultSchema, base), true)
    const images = [{ mediaType: 'image/png', data: 'AAAA' }]
    assert.deepEqual(ServerToolResultSchema.parse({ ...base, images }).images, images)
  })
  it('rejects a non-array or a malformed image', () => {
    assert.equal(ok(ServerToolResultSchema, { ...base, images: 'x' }), false)
    assert.equal(ok(ServerToolResultSchema, { ...base, images: [{ mediaType: 'image/png' }] }), false)
  })
})

describe('server_error correlationId', () => {
  const base = { type: 'server_error', message: 'm', recoverable: true }
  it('keeps it and still parses without it', () => {
    assert.equal(ok(ServerErrorSchema, base), true)
    assert.equal(ServerErrorSchema.parse({ ...base, correlationId: 'ab12cd34' }).correlationId, 'ab12cd34')
  })
  it('rejects a non-string', () => assert.equal(ok(ServerErrorSchema, { ...base, correlationId: 7 }), false))
})

describe('host_status_snapshot requestId', () => {
  const base = {
    type: 'host_status_snapshot', generatedAt: new Date().toISOString(), root: '/r',
    summary: { live: 0, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 }, repos: [],
  }
  it('keeps it, allows null, and parses without it', () => {
    assert.equal(ok(ServerHostStatusSnapshotSchema, base), true)
    assert.equal(ServerHostStatusSnapshotSchema.parse({ ...base, requestId: 'q1' }).requestId, 'q1')
    assert.equal(ok(ServerHostStatusSnapshotSchema, { ...base, requestId: null }), true)
  })
  it('rejects a non-string', () => assert.equal(ok(ServerHostStatusSnapshotSchema, { ...base, requestId: 3 }), false))
})

describe('replayed entry timestamp / messageId', () => {
  it('tool_start, tool_result and user_question keep a numeric timestamp and parse without', () => {
    const cases = [
      [ServerToolStartSchema, { type: 'tool_start', messageId: 'm', toolUseId: 't', tool: 'Bash', input: null }],
      [ServerToolResultSchema, { type: 'tool_result', toolUseId: 't', result: 'r' }],
      [ServerUserQuestionSchema, { type: 'user_question', toolUseId: 't', questions: [] }],
    ]
    for (const [schema, base] of cases) {
      assert.equal(ok(schema, base), true, base.type)
      assert.equal(schema.parse({ ...base, timestamp: 123 }).timestamp, 123, base.type)
      assert.equal(ok(schema, { ...base, timestamp: 'now' }), false, base.type)
    }
  })
  it('message keeps messageId', () => {
    const base = { type: 'message', messageType: 'response', content: 'c', timestamp: 1 }
    assert.equal(ok(ServerMessageSchema, base), true)
    assert.equal(ServerMessageSchema.parse({ ...base, messageId: 'mid' }).messageId, 'mid')
    assert.equal(ok(ServerMessageSchema, { ...base, messageId: 4 }), false)
  })
})

describe('session_error attemptedSessionId / activityId', () => {
  const base = { type: 'session_error', message: 'm' }
  it('keeps both and still parses without', () => {
    assert.equal(ok(ServerSessionErrorSchema, base), true)
    const p = ServerSessionErrorSchema.parse({ ...base, attemptedSessionId: 's', activityId: 'a' })
    assert.equal(p.attemptedSessionId, 's')
    assert.equal(p.activityId, 'a')
  })
  it('rejects non-strings (passthrough would otherwise let any value by)', () => {
    assert.equal(ok(ServerSessionErrorSchema, { ...base, attemptedSessionId: 1 }), false)
    assert.equal(ok(ServerSessionErrorSchema, { ...base, activityId: {} }), false)
  })
})
