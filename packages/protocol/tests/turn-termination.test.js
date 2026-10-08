import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TURN_TERMINATION_REASONS,
  isTurnTerminationReason,
  describeTurnTermination,
} from '../src/turn-termination.ts'
import { ServerToolResultSchema } from '../src/schemas/server/stream.ts'

/**
 * #7376 — the wire field that tells a client a tool was cut off by a terminated
 * turn (not that the command ran and failed), and the shared wording for it.
 */

describe('ServerToolResultSchema.terminatedReason (#7376)', () => {
  const base = { type: 'tool_result', toolUseId: 'tu-1', result: 'x' }

  it('is optional: an older server that never sends it still parses', () => {
    const r = ServerToolResultSchema.safeParse(base)
    assert.ok(r.success)
    assert.equal('terminatedReason' in r.data, false)
  })

  it('carries a known reason through the parse (a stripped field would silently revert the UI to red)', () => {
    const r = ServerToolResultSchema.safeParse({ ...base, isError: true, terminatedReason: 'permission_mode_switch' })
    assert.ok(r.success)
    assert.equal(r.data.terminatedReason, 'permission_mode_switch')
    assert.equal(r.data.isError, true)
  })

  it('accepts a reason this client has never heard of (forward compatibility)', () => {
    const r = ServerToolResultSchema.safeParse({ ...base, terminatedReason: 'a_reason_from_the_future' })
    assert.ok(r.success, 'a newer server must not make this tool_result fail to parse')
    assert.equal(r.data.terminatedReason, 'a_reason_from_the_future')
  })

  it('rejects a non-string reason', () => {
    assert.equal(ServerToolResultSchema.safeParse({ ...base, terminatedReason: 7 }).success, false)
  })
})

describe('describeTurnTermination (#7376)', () => {
  it('every known reason is recognised and worded', () => {
    for (const reason of TURN_TERMINATION_REASONS) {
      assert.ok(isTurnTerminationReason(reason), reason)
      const d = describeTurnTermination(reason)
      assert.ok(d.cause.length > 0, `${reason} has a cause`)
      assert.ok(d.summary.length > 0, `${reason} has a summary`)
    }
  })

  it('the permission-mode switch names itself and the next step', () => {
    const { summary } = describeTurnTermination('permission_mode_switch')
    assert.ok(/Turn ended/.test(summary) && /permission-mode switch/.test(summary), summary)
    assert.ok(/before this tool returned a result/.test(summary), summary)
    assert.ok(/Check whether it took effect before retrying/.test(summary), summary)
  })

  it('Stop is worded as a Stop, not as a fault', () => {
    const { summary } = describeTurnTermination('user_stop')
    assert.ok(/^Stopped/.test(summary), summary)
    assert.equal(/terminated/i.test(summary), false)
    assert.ok(/Check whether it took effect before retrying/.test(summary), summary)
  })

  it('no reason asserts the tool did not run or tells the user to blindly re-send (the server cannot know)', () => {
    for (const r of [...TURN_TERMINATION_REASONS, 'from_the_future', undefined]) {
      const { summary } = describeTurnTermination(r)
      assert.equal(/did not (finish|run|execute)/i.test(summary), false, `${String(r)}: ${summary}`)
      assert.equal(/Re-send to retry/.test(summary), false, `${String(r)}: ${summary}`)
      assert.ok(/check/i.test(summary), `${String(r)}: ${summary}`)
    }
  })

  it('a daemon restart does NOT claim the tool failed to run (the outcome is unknown)', () => {
    const { summary } = describeTurnTermination('daemon_restart')
    assert.ok(/may or may not/.test(summary), summary)
    assert.equal(/Re-send to retry/.test(summary), false, 'blindly re-sending could repeat a side effect')
  })

  it('an unrecognised or missing reason degrades to the generic sentence', () => {
    for (const r of ['from_the_future', undefined, null, 5, '']) {
      assert.equal(isTurnTerminationReason(r), false)
      const d = describeTurnTermination(r)
      assert.ok(/Turn ended before this tool returned a result/.test(d.summary), String(r))
      assert.ok(/Check whether it took effect before retrying/.test(d.summary), String(r))
    }
  })
})
