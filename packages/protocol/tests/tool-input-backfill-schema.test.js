import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServerToolInputBackfillSchema } from '../src/schemas/index.ts'

// #8415: the reconcile-only frame a delta replay sends for a held tool card.
const ok = (v) => ServerToolInputBackfillSchema.safeParse(v).success
const BASE = { type: 'tool_input_backfill', sessionId: 's1', messageId: 'tool-1', input: { command: 'ls' } }

describe('tool_input_backfill schema', () => {
  it('accepts a plain-object input, with or without toolUseId', () => {
    assert.equal(ok(BASE), true)
    assert.equal(ok({ ...BASE, toolUseId: 'tu-1' }), true)
    assert.equal(ok({ ...BASE, input: {} }), true)
  })
  it('rejects an array, null or primitive input', () => {
    for (const input of [[1], null, 'ls', 5, true, undefined]) {
      assert.equal(ok({ ...BASE, input }), false, `input ${JSON.stringify(input)}`)
    }
  })
  it('rejects a missing messageId or sessionId', () => {
    const { messageId, ...noMessage } = BASE
    const { sessionId, ...noSession } = BASE
    assert.equal(ok(noMessage), false)
    assert.equal(ok(noSession), false)
  })
  it('keeps the declared fields and strips undeclared ones', () => {
    const parsed = ServerToolInputBackfillSchema.parse({ ...BASE, toolUseId: 'tu-1', historySeq: 9, extra: 1 })
    assert.deepEqual(parsed, { ...BASE, toolUseId: 'tu-1' })
  })
})
