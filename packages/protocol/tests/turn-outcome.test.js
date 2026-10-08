import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TURN_OUTCOMES,
  isTurnOutcome,
  isMarkedTurnOutcome,
  describeTurnOutcome,
} from '../src/turn-outcome.ts'
import { ServerResultSchema } from '../src/schemas/server/stream.ts'

/**
 * #7326 -- how a TURN ended, as the `result` frame says it, and the wording both
 * clients show for the three outcomes that deserve a marker.
 */

describe('ServerResultSchema.turnOutcome (#7326)', () => {
  it('is optional: an older server that never sends it still parses, and the key stays absent', () => {
    const r = ServerResultSchema.safeParse({ type: 'result', cost: 0.01 })
    assert.ok(r.success)
    assert.equal('turnOutcome' in r.data, false)
  })

  for (const outcome of TURN_OUTCOMES) {
    it(`carries "${outcome}" through the parse (a stripped field would silently revert the UI to "finished")`, () => {
      const r = ServerResultSchema.safeParse({ type: 'result', turnOutcome: outcome, timestamp: 1700000000000 })
      assert.ok(r.success)
      assert.equal(r.data.turnOutcome, outcome)
      assert.equal(r.data.timestamp, 1700000000000)
    })
  }

  it('rejects a value outside the closed vocabulary', () => {
    assert.equal(ServerResultSchema.safeParse({ type: 'result', turnOutcome: 'max_tokens' }).success, false)
    assert.equal(ServerResultSchema.safeParse({ type: 'result', turnOutcome: '' }).success, false)
    assert.equal(ServerResultSchema.safeParse({ type: 'result', turnOutcome: null }).success, false)
  })
})

describe('turn outcome vocabulary (#7326)', () => {
  it('is exactly the four values that are a wire contract', () => {
    assert.deepEqual([...TURN_OUTCOMES], ['completed', 'truncated', 'refused', 'stopped'])
  })

  it('isTurnOutcome accepts the four and nothing else', () => {
    for (const v of TURN_OUTCOMES) assert.ok(isTurnOutcome(v), v)
    for (const v of ['end_turn', 'refusal', 'cancelled', 'Truncated', '', null, undefined, 3, {}]) {
      assert.equal(isTurnOutcome(v), false, String(v))
    }
  })

  it('isMarkedTurnOutcome excludes completed: a finished turn gets no marker', () => {
    assert.equal(isMarkedTurnOutcome('completed'), false)
    for (const v of ['truncated', 'refused', 'stopped']) assert.ok(isMarkedTurnOutcome(v), v)
    assert.equal(isMarkedTurnOutcome('something-newer'), false)
  })

  it('describeTurnOutcome words each marked outcome, and returns null for the rest', () => {
    assert.equal(describeTurnOutcome('truncated').label, 'Reply cut off')
    assert.equal(describeTurnOutcome('refused').label, 'The model declined')
    assert.equal(describeTurnOutcome('stopped').label, 'Stopped')
    for (const marked of ['truncated', 'refused', 'stopped']) {
      assert.ok(describeTurnOutcome(marked).detail.length > 0, `${marked}: a sentence for the tooltip`)
    }
    assert.equal(describeTurnOutcome('completed'), null)
    assert.equal(describeTurnOutcome(undefined), null)
    assert.equal(describeTurnOutcome('newer-server-value'), null)
  })
})
