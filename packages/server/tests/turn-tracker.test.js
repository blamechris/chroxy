// #5541: TurnTracker — server-side "turn in flight" state derived from the
// ingest event stream (no client state), modeled on SubagentCounter.
//
// A turn is the span from UserPromptSubmit (user_prompt_submit) to Stop
// (stop). While a turn is in flight the main agent is BUSY — the Discord
// status embed must NOT show "Ready for input" even if subagents are still
// running. The tracker answers `anyTurnInFlight(project)` so the sink can
// rescope its GAP C idle-hold logic.
//
// Pins (mirrors subagent-counter.test.js shape):
//   - user_prompt_submit sets, stop clears, per (source, sessionId)
//   - session_end clears the entry (a session that ends mid-turn is done)
//   - keys are isolated across sources AND sessions
//   - stale entries expire after the TTL (lazy sweep, injected clock)
//   - hard cap: oldest-touched entries evicted first, size stays bounded
//   - events without a sessionId are not tracked
//   - anyTurnInFlight aggregates per project, across sources
//   - a fresh tracker (daemon restart) reports no turn in flight

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TurnTracker,
  TURN_ENTRY_TTL_MS,
  TURN_MAX_ENTRIES,
} from '../src/turn-tracker.js'

function makeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

describe('TurnTracker', () => {
  it('user_prompt_submit sets and stop clears a turn per (source, sessionId)', () => {
    const tracker = new TurnTracker()
    assert.equal(tracker.record('user_prompt_submit', 'claude-hooks', 's1'), true)
    assert.equal(tracker.isInFlight('claude-hooks', 's1'), true)
    assert.equal(tracker.record('stop', 'claude-hooks', 's1'), false)
    assert.equal(tracker.isInFlight('claude-hooks', 's1'), false)
  })

  it('isolates sources and sessions', () => {
    const tracker = new TurnTracker()
    tracker.record('user_prompt_submit', 'claude-hooks', 's1')
    assert.equal(tracker.isInFlight('claude-hooks', 's1'), true)
    assert.equal(tracker.isInFlight('claude-hooks', 's2'), false)
    assert.equal(tracker.isInFlight('other-tool', 's1'), false)
  })

  it('session_end clears the entry', () => {
    const tracker = new TurnTracker()
    tracker.record('user_prompt_submit', 'claude-hooks', 's1')
    assert.equal(tracker.record('session_end', 'claude-hooks', 's1'), false)
    assert.equal(tracker.isInFlight('claude-hooks', 's1'), false)
    assert.equal(tracker.size, 0)
  })

  it('returns null for unrelated types and missing sessionIds', () => {
    const tracker = new TurnTracker()
    assert.equal(tracker.record('subagent_start', 'claude-hooks', 's1'), null)
    assert.equal(tracker.record('notification', 'claude-hooks', 's1'), null)
    assert.equal(tracker.record('user_prompt_submit', 'claude-hooks', undefined), null)
    assert.equal(tracker.record('user_prompt_submit', 'claude-hooks', ''), null)
    assert.equal(tracker.size, 0)
  })

  it('stop on an unknown session is harmless (stays cleared)', () => {
    const tracker = new TurnTracker()
    assert.equal(tracker.record('stop', 'claude-hooks', 's1'), false)
    assert.equal(tracker.isInFlight('claude-hooks', 's1'), false)
    assert.equal(tracker.size, 0)
  })

  it('expires stale in-flight entries after the TTL', () => {
    const clock = makeClock()
    const tracker = new TurnTracker({ now: clock.now })
    tracker.record('user_prompt_submit', 'claude-hooks', 's1')
    assert.equal(tracker.isInFlight('claude-hooks', 's1'), true)
    clock.advance(TURN_ENTRY_TTL_MS + 1)
    assert.equal(tracker.isInFlight('claude-hooks', 's1'), false)
    assert.equal(tracker.size, 0)
  })

  it('lazy sweep prunes expired entries on later records', () => {
    const clock = makeClock()
    const tracker = new TurnTracker({ now: clock.now })
    tracker.record('user_prompt_submit', 'claude-hooks', 'old')
    clock.advance(TURN_ENTRY_TTL_MS + 1)
    tracker.record('user_prompt_submit', 'claude-hooks', 'fresh')
    assert.equal(tracker.size, 1)
    assert.equal(tracker.isInFlight('claude-hooks', 'fresh'), true)
  })

  it('caps tracked entries and evicts the least recently touched', () => {
    const tracker = new TurnTracker({ maxEntries: 3 })
    tracker.record('user_prompt_submit', 'src', 'a')
    tracker.record('user_prompt_submit', 'src', 'b')
    tracker.record('user_prompt_submit', 'src', 'c')
    tracker.record('user_prompt_submit', 'src', 'a') // touch a → b oldest
    tracker.record('user_prompt_submit', 'src', 'd')
    assert.ok(tracker.size <= 3)
    assert.equal(tracker.isInFlight('src', 'b'), false, 'least recently touched evicted')
    assert.equal(tracker.isInFlight('src', 'a'), true)
    assert.equal(tracker.isInFlight('src', 'd'), true)
  })

  it('defaults are sane', () => {
    assert.ok(TURN_ENTRY_TTL_MS >= 60 * 60 * 1000)
    assert.ok(TURN_MAX_ENTRIES >= 100)
  })

  it('a fresh tracker reports no turn in flight (daemon-restart fallback)', () => {
    const tracker = new TurnTracker()
    assert.equal(tracker.anyTurnInFlight('proj1'), false)
    assert.equal(tracker.isInFlight('claude-hooks', 's1'), false)
  })
})

describe('TurnTracker — per-project aggregate (#5541)', () => {
  it('anyTurnInFlight is true while any session of the project has a turn', () => {
    const tracker = new TurnTracker()
    tracker.record('user_prompt_submit', 'claude-hooks', 'a', 'proj1')
    tracker.record('user_prompt_submit', 'claude-hooks', 'b', 'proj1')
    assert.equal(tracker.anyTurnInFlight('proj1'), true)
    assert.equal(tracker.anyTurnInFlight('proj2'), false)
    // One session ends its turn — the other still keeps the project busy.
    tracker.record('stop', 'claude-hooks', 'a', 'proj1')
    assert.equal(tracker.anyTurnInFlight('proj1'), true)
    tracker.record('stop', 'claude-hooks', 'b', 'proj1')
    assert.equal(tracker.anyTurnInFlight('proj1'), false)
  })

  it('spans sources — the embed project key has no source dimension', () => {
    const tracker = new TurnTracker()
    tracker.record('user_prompt_submit', 'claude-hooks', 's1', 'proj1')
    tracker.record('user_prompt_submit', 'other-tool', 's1', 'proj1')
    tracker.record('stop', 'claude-hooks', 's1', 'proj1')
    // The other source still has a turn in flight for the project.
    assert.equal(tracker.anyTurnInFlight('proj1'), true)
  })

  it('session_end subtracts only that session from the project aggregate', () => {
    const tracker = new TurnTracker()
    tracker.record('user_prompt_submit', 'claude-hooks', 'a', 'proj1')
    tracker.record('user_prompt_submit', 'claude-hooks', 'b', 'proj1')
    tracker.record('session_end', 'claude-hooks', 'a', 'proj1')
    assert.equal(tracker.anyTurnInFlight('proj1'), true)
    tracker.record('session_end', 'claude-hooks', 'b', 'proj1')
    assert.equal(tracker.anyTurnInFlight('proj1'), false)
  })

  it('TTL expiry clears an abandoned mid-turn session from the aggregate', () => {
    const clock = makeClock()
    const tracker = new TurnTracker({ now: clock.now })
    tracker.record('user_prompt_submit', 'claude-hooks', 'abandoned', 'proj1')
    clock.advance(TURN_ENTRY_TTL_MS - 1000)
    tracker.record('user_prompt_submit', 'claude-hooks', 'live', 'proj1')
    assert.equal(tracker.anyTurnInFlight('proj1'), true)
    clock.advance(2000) // 'abandoned' past TTL, 'live' not
    assert.equal(tracker.anyTurnInFlight('proj1'), true)
    tracker.record('stop', 'claude-hooks', 'live', 'proj1')
    assert.equal(tracker.anyTurnInFlight('proj1'), false)
    assert.equal(tracker.size, 0, 'expired entry dropped during the scan')
  })

  it('entries without a project never leak into a project aggregate', () => {
    const tracker = new TurnTracker()
    tracker.record('user_prompt_submit', 'claude-hooks', 'no-project')
    tracker.record('user_prompt_submit', 'claude-hooks', 'with-project', 'proj1')
    assert.equal(tracker.anyTurnInFlight('proj1'), true)
    assert.equal(tracker.anyTurnInFlight(''), false)
    assert.equal(tracker.anyTurnInFlight(null), false)
    assert.equal(tracker.anyTurnInFlight(undefined), false)
  })

  it('a later event without a project keeps the entry\'s known project', () => {
    const tracker = new TurnTracker()
    tracker.record('user_prompt_submit', 'claude-hooks', 's1', 'proj1')
    // Re-submit without a derivable project (e.g. missing cwd) — still proj1.
    tracker.record('user_prompt_submit', 'claude-hooks', 's1')
    assert.equal(tracker.anyTurnInFlight('proj1'), true)
  })
})
