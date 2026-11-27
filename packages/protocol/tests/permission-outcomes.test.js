import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PERMISSION_NO_DECISION_REASON_OUTCOMES,
  permissionOutcomeForReason,
} from '../src/index.ts'

describe('permission no-decision reasons (#8952)', () => {
  it('maps every reason in the table to its outcome', () => {
    for (const [reason, outcome] of Object.entries(PERMISSION_NO_DECISION_REASON_OUTCOMES)) {
      assert.equal(permissionOutcomeForReason(reason), outcome, reason)
    }
  })

  it('reads a cleared prompt as expired and a stop as stopped', () => {
    assert.equal(permissionOutcomeForReason('cleared'), 'expired')
    assert.equal(permissionOutcomeForReason('stopped'), 'stopped')
  })

  it('returns null for a real decision, an unknown reason and a non-string', () => {
    for (const r of ['user', 'auto_mode', '', 'toString', '__proto__', undefined, null, 7]) {
      assert.equal(permissionOutcomeForReason(r), null, String(r))
    }
  })

  it('is frozen', () => {
    assert.equal(Object.isFrozen(PERMISSION_NO_DECISION_REASON_OUTCOMES), true)
  })
})
