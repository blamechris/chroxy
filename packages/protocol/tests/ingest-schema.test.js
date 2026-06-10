import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  IngestEventSchema,
  IngestEventDataSchema,
  INGEST_EVENT_TYPES,
  INGEST_TS_MIN_MS,
  INGEST_TS_MAX_MS,
  INGEST_DATA_MAX_KEYS,
} from '../src/schemas/ingest.ts'

// #5413 Phase 3 — the POST /api/events envelope. STRICT by design: this is
// an authenticated but potentially tunnel-reachable HTTP surface, so unknown
// keys, unbounded strings, and nested data payloads must all be rejected.

const VALID_TS = 1_750_000_000_000 // mid-2025, inside the sanity bounds

function validEvent(overrides = {}) {
  return {
    source: 'claude-hooks',
    project: 'chroxy',
    sessionId: 'abc-123',
    type: 'session_start',
    data: { cwd: '/home/user/projects/chroxy', tool: 'Bash' },
    ts: VALID_TS,
    ...overrides,
  }
}

describe('IngestEventSchema (#5413 Phase 3)', () => {
  it('accepts a fully-populated valid event', () => {
    const result = IngestEventSchema.safeParse(validEvent())
    assert.ok(result.success, JSON.stringify(result.error?.issues))
  })

  it('accepts the minimal envelope (source, type, ts only)', () => {
    const result = IngestEventSchema.safeParse({
      source: 'claude-hooks',
      type: 'notification',
      ts: VALID_TS,
    })
    assert.ok(result.success)
  })

  it('accepts every enumerated event type', () => {
    for (const type of INGEST_EVENT_TYPES) {
      const result = IngestEventSchema.safeParse(validEvent({ type }))
      assert.ok(result.success, `type ${type} should validate`)
    }
  })

  it('is exported from the schemas entry point', async () => {
    const schemas = await import('../src/schemas/index.ts')
    assert.ok(schemas.IngestEventSchema, 'IngestEventSchema re-exported')
    assert.ok(schemas.INGEST_EVENT_TYPES, 'INGEST_EVENT_TYPES re-exported')
  })

  it('is exported from the main entry point (server + future hooks package import path)', async () => {
    const main = await import('../src/index.ts')
    assert.ok(main.IngestEventSchema, 'IngestEventSchema re-exported from main')
  })

  describe('type enum', () => {
    it('rejects unknown type values', () => {
      const result = IngestEventSchema.safeParse(validEvent({ type: 'pre_tool_use' }))
      assert.ok(!result.success)
    })

    it('rejects a non-string type', () => {
      const result = IngestEventSchema.safeParse(validEvent({ type: 42 }))
      assert.ok(!result.success)
    })
  })

  describe('strictness', () => {
    it('rejects unknown top-level keys', () => {
      const result = IngestEventSchema.safeParse(validEvent({ extra: 'nope' }))
      assert.ok(!result.success, 'strict envelope must reject unknown keys')
    })
  })

  describe('string bounds', () => {
    it('rejects an empty source', () => {
      assert.ok(!IngestEventSchema.safeParse(validEvent({ source: '' })).success)
    })

    it('rejects an oversized source (>64)', () => {
      assert.ok(!IngestEventSchema.safeParse(validEvent({ source: 'x'.repeat(65) })).success)
    })

    it('rejects an oversized project (>256)', () => {
      assert.ok(!IngestEventSchema.safeParse(validEvent({ project: 'p'.repeat(257) })).success)
    })

    it('rejects an oversized sessionId (>256)', () => {
      assert.ok(!IngestEventSchema.safeParse(validEvent({ sessionId: 's'.repeat(257) })).success)
    })
  })

  describe('ts sanity bounds (epoch ms)', () => {
    it('accepts the exact bounds', () => {
      assert.ok(IngestEventSchema.safeParse(validEvent({ ts: INGEST_TS_MIN_MS })).success)
      assert.ok(IngestEventSchema.safeParse(validEvent({ ts: INGEST_TS_MAX_MS })).success)
    })

    it('rejects seconds-precision timestamps (below 2020 in ms)', () => {
      assert.ok(!IngestEventSchema.safeParse(validEvent({ ts: 1_750_000_000 })).success)
    })

    it('rejects far-future, negative, and non-integer ts', () => {
      assert.ok(!IngestEventSchema.safeParse(validEvent({ ts: INGEST_TS_MAX_MS + 1 })).success)
      assert.ok(!IngestEventSchema.safeParse(validEvent({ ts: -1 })).success)
      assert.ok(!IngestEventSchema.safeParse(validEvent({ ts: VALID_TS + 0.5 })).success)
    })

    it('rejects a missing ts', () => {
      const event = validEvent()
      delete event.ts
      assert.ok(!IngestEventSchema.safeParse(event).success)
    })
  })

  describe('data bag caps', () => {
    it('rejects nested objects and arrays as values', () => {
      assert.ok(!IngestEventSchema.safeParse(validEvent({ data: { nested: { a: 1 } } })).success)
      assert.ok(!IngestEventSchema.safeParse(validEvent({ data: { arr: [1, 2] } })).success)
    })

    it('rejects oversized string values (>4096)', () => {
      assert.ok(!IngestEventSchema.safeParse(validEvent({ data: { msg: 'x'.repeat(4097) } })).success)
    })

    it('rejects non-finite numbers', () => {
      assert.ok(!IngestEventDataSchema.safeParse({ n: Infinity }).success)
    })

    it(`rejects more than ${INGEST_DATA_MAX_KEYS} keys`, () => {
      const data = {}
      for (let i = 0; i <= INGEST_DATA_MAX_KEYS; i++) data[`k${i}`] = 'v'
      assert.ok(!IngestEventSchema.safeParse(validEvent({ data })).success)
    })

    it(`accepts exactly ${INGEST_DATA_MAX_KEYS} keys of flat primitives`, () => {
      const data = {}
      for (let i = 0; i < INGEST_DATA_MAX_KEYS; i++) data[`k${i}`] = i % 2 === 0 ? 'v' : i
      assert.ok(IngestEventSchema.safeParse(validEvent({ data })).success)
    })

    it('rejects oversized keys (>128)', () => {
      assert.ok(!IngestEventDataSchema.safeParse({ ['k'.repeat(129)]: 'v' }).success)
    })
  })
})
