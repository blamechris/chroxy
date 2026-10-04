/**
 * EventNormalizer error mapping — `stream_stall` timeoutMs forwarding (#8223)
 *
 * claude-tui's two silence watchdogs (90s before the first output, 5 minutes
 * mid-turn) share the `stream_stall` code. The error carries `timeoutMs` — the
 * window that actually fired — and the normalizer must put it on the wire so the
 * clients can word the chip from it instead of from the `auth_ok` stall window.
 * Without this the field dies here: the normalizer rebuilds the envelope from a
 * fixed set of fields.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventNormalizer } from '../src/event-normalizer.js'

describe('EventNormalizer error mapping — stream_stall timeoutMs (#8223)', () => {
  const ctx = { sessionId: 'sess-1', mode: 'multi', getSessionEntry: () => null }
  const wire = (data) => new EventNormalizer().normalize('error', data, ctx).messages[0].msg

  it('forwards timeoutMs on a stream_stall error', () => {
    const msg = wire({ code: 'stream_stall', message: 'No response from claude TUI within 90 seconds. Try sending again.', timeoutMs: 90_000 })
    assert.equal(msg.code, 'stream_stall')
    assert.equal(msg.timeoutMs, 90_000)
  })

  it('omits timeoutMs when the producer sent none (older producers, cli/sdk stalls)', () => {
    assert.equal('timeoutMs' in wire({ code: 'stream_stall', message: 'stalled' }), false)
  })

  for (const bad of [0, -5, 1.5, NaN, Infinity, '90000', null, {}]) {
    it(`drops a malformed timeoutMs (${JSON.stringify(bad) ?? String(bad)})`, () => {
      assert.equal('timeoutMs' in wire({ code: 'stream_stall', message: 'stalled', timeoutMs: bad }), false)
    })
  }

  it('does not put timeoutMs on an error that is not a stream_stall', () => {
    assert.equal('timeoutMs' in wire({ code: 'AUTH_REQUIRED', message: 'x', timeoutMs: 90_000 }), false)
    assert.equal('timeoutMs' in wire({ message: 'x', timeoutMs: 90_000 }), false)
  })
})
