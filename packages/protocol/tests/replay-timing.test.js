import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  REPLAY_BACKPRESSURE_MAX_WAIT_MS,
  TRANSCRIPT_INACTIVITY_HEADROOM_MS,
  TRANSCRIPT_INACTIVITY_MS,
} from '../src/replay-timing.ts'
import * as barrel from '../src/index.ts'

/**
 * #7496 — the dashboard's transcript inactivity watchdog must outlast the
 * server's longest back-pressure park, or a healthy-but-congested replay is
 * reported as "Timed out loading transcript".
 *
 * The two numbers used to live in different packages (15 s in the dashboard,
 * 30 s in the server) with nothing relating them, so either could move and
 * nothing failed. They are now defined here, the watchdog derived from the park
 * ceiling. The behaviour is pinned where each side is exercised:
 *   - server:    tests/ws-history-backpressure-cap.test.js closes the socket at
 *                exactly REPLAY_BACKPRESSURE_MAX_WAIT_MS;
 *   - dashboard: transcript-viewer-actions.test.ts keeps the viewer `loading`
 *                through a silence of that length.
 * This file pins the relationship itself, against a MINIMUM written here as a
 * literal. The floor must not be computed from the constants under test: a
 * floor derived from them would move with them and could never go red.
 */

/** Smallest margin accepted between the park ceiling and the watchdog. */
const MIN_HEADROOM_MS = 5_000

describe('replay back-pressure vs. transcript watchdog (#7496)', () => {
  it('the watchdog is strictly above the park ceiling by at least MIN_HEADROOM_MS', () => {
    assert.ok(
      TRANSCRIPT_INACTIVITY_MS - REPLAY_BACKPRESSURE_MAX_WAIT_MS >= MIN_HEADROOM_MS,
      `watchdog ${TRANSCRIPT_INACTIVITY_MS}ms must exceed the park ceiling ${REPLAY_BACKPRESSURE_MAX_WAIT_MS}ms by >= ${MIN_HEADROOM_MS}ms`,
    )
  })

  it('the watchdog is DERIVED from the ceiling, so moving the ceiling moves it', () => {
    assert.equal(
      TRANSCRIPT_INACTIVITY_MS,
      REPLAY_BACKPRESSURE_MAX_WAIT_MS + TRANSCRIPT_INACTIVITY_HEADROOM_MS,
    )
  })

  it('both are positive finite millisecond counts (a NaN would make every comparison above vacuous)', () => {
    for (const v of [REPLAY_BACKPRESSURE_MAX_WAIT_MS, TRANSCRIPT_INACTIVITY_HEADROOM_MS, TRANSCRIPT_INACTIVITY_MS]) {
      assert.ok(Number.isFinite(v) && v > 0, `not a positive finite number: ${v}`)
    }
  })

  it('is reachable from the package entry point both clients import', () => {
    assert.equal(barrel.REPLAY_BACKPRESSURE_MAX_WAIT_MS, REPLAY_BACKPRESSURE_MAX_WAIT_MS)
    assert.equal(barrel.TRANSCRIPT_INACTIVITY_MS, TRANSCRIPT_INACTIVITY_MS)
  })
})
