import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { REPLAY_BACKPRESSURE_MAX_WAIT_MS } from '@chroxy/protocol'
import { scheduleAfterDrain } from '../src/ws-history.js'

/**
 * #7496 — the park ceiling the dashboard's transcript watchdog is derived from.
 *
 * `scheduleAfterDrain` parks a replay on a congested socket and, once the drain
 * has been blocked for the cap, closes it (1013) so the client reconnects. The
 * dashboard's transcript inactivity watchdog is derived from the SAME shared
 * constant (`TRANSCRIPT_INACTIVITY_MS` in @chroxy/protocol), so the ordering
 * "watchdog > longest park" only holds while this loop really parks for that
 * long. These tests pin the server half: the socket is closed at EXACTLY the
 * shared value — not one tick earlier, not still open one tick later. A
 * hardcoded number in ws-history.js that drifts from the shared constant goes
 * red here, which is what keeps the client's derivation honest.
 *
 * The cap was exported "for direct unit testing" (#5328) and had no test.
 */

/** A socket whose send buffer never drains. */
function stuckSocket() {
  const closes = []
  return {
    readyState: 1,
    bufferedAmount: 10 * 1024 * 1024,
    close(code, reason) { closes.push({ code, reason }); this.readyState = 3 },
    closes,
  }
}

describe('scheduleAfterDrain park ceiling (#7496)', () => {
  afterEach(() => mock.timers.reset())

  it('closes a never-draining socket at exactly REPLAY_BACKPRESSURE_MAX_WAIT_MS, and not before', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const ws = stuckSocket()
    let resumed = false
    scheduleAfterDrain(ws, () => { resumed = true })

    // One poll interval short of the ceiling: still parked, nothing emitted, open.
    mock.timers.tick(REPLAY_BACKPRESSURE_MAX_WAIT_MS - 40)
    assert.equal(ws.closes.length, 0, 'closed before the shared ceiling')
    assert.equal(ws.readyState, 1)

    // The first poll at or past the ceiling closes it with 1013.
    mock.timers.tick(40)
    assert.equal(ws.closes.length, 1, 'not closed at the shared ceiling')
    assert.equal(ws.closes[0].code, 1013)
    assert.equal(resumed, false, 'the replay must not resume on a socket that never drained')
  })

  it('CONTROL: a socket that drains before the ceiling resumes the replay and is NOT closed', () => {
    // Without this, a `scheduleAfterDrain` that closed every parked socket
    // immediately would satisfy the test above's close assertion.
    mock.timers.enable({ apis: ['setTimeout', 'Date', 'setImmediate'] })
    const ws = stuckSocket()
    let resumed = false
    scheduleAfterDrain(ws, () => { resumed = true })

    mock.timers.tick(REPLAY_BACKPRESSURE_MAX_WAIT_MS - 1000)
    ws.bufferedAmount = 0
    mock.timers.tick(40)

    assert.equal(resumed, true)
    assert.equal(ws.closes.length, 0)
  })
})
