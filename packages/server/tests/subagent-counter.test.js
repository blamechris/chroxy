// #5413 Phase 4: SubagentCounter — server-side counts derived from the
// event stream (no client state).
//
// Pins:
//   - start/stop arithmetic per (source, sessionId), floored at 0
//   - session_end clears the entry
//   - keys are isolated across sources AND sessions
//   - stale entries expire after the TTL (lazy sweep, injected clock)
//   - hard cap: oldest-touched entries evicted first, size stays bounded
//   - events without a sessionId are not counted
//
// #5463 — per-project aggregation (the Discord embed is keyed per project,
// not per session):
//   - getProjectTotal sums the live sessions of one project, across sources
//   - session_end and TTL expiry subtract that session's contribution
//   - entries without a project never leak into any project total

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SubagentCounter,
  SUBAGENT_ENTRY_TTL_MS,
  SUBAGENT_MAX_ENTRIES,
} from '../src/subagent-counter.js'

function makeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

describe('SubagentCounter', () => {
  it('counts starts and stops per (source, sessionId)', () => {
    const counter = new SubagentCounter()
    assert.equal(counter.record('subagent_start', 'claude-hooks', 's1'), 1)
    assert.equal(counter.record('subagent_start', 'claude-hooks', 's1'), 2)
    assert.equal(counter.record('subagent_stop', 'claude-hooks', 's1'), 1)
    assert.equal(counter.getCount('claude-hooks', 's1'), 1)
  })

  it('floors at zero when stops outnumber starts', () => {
    const counter = new SubagentCounter()
    assert.equal(counter.record('subagent_stop', 'claude-hooks', 's1'), 0)
    assert.equal(counter.record('subagent_stop', 'claude-hooks', 's1'), 0)
    assert.equal(counter.getCount('claude-hooks', 's1'), 0)
  })

  it('isolates sources and sessions', () => {
    const counter = new SubagentCounter()
    counter.record('subagent_start', 'claude-hooks', 's1')
    counter.record('subagent_start', 'claude-hooks', 's2')
    counter.record('subagent_start', 'other-tool', 's1')
    assert.equal(counter.getCount('claude-hooks', 's1'), 1)
    assert.equal(counter.getCount('claude-hooks', 's2'), 1)
    assert.equal(counter.getCount('other-tool', 's1'), 1)
    assert.equal(counter.getCount('other-tool', 's2'), 0)
  })

  it('session_end clears the entry', () => {
    const counter = new SubagentCounter()
    counter.record('subagent_start', 'claude-hooks', 's1')
    counter.record('subagent_start', 'claude-hooks', 's1')
    assert.equal(counter.record('session_end', 'claude-hooks', 's1'), 0)
    assert.equal(counter.getCount('claude-hooks', 's1'), 0)
    assert.equal(counter.size, 0)
  })

  it('returns null for uncounted types and missing sessionIds', () => {
    const counter = new SubagentCounter()
    assert.equal(counter.record('session_start', 'claude-hooks', 's1'), null)
    assert.equal(counter.record('notification', 'claude-hooks', 's1'), null)
    assert.equal(counter.record('subagent_start', 'claude-hooks', undefined), null)
    assert.equal(counter.record('subagent_start', 'claude-hooks', ''), null)
    assert.equal(counter.size, 0)
  })

  it('expires stale entries after the TTL', () => {
    const clock = makeClock()
    const counter = new SubagentCounter({ now: clock.now })
    counter.record('subagent_start', 'claude-hooks', 's1')
    assert.equal(counter.getCount('claude-hooks', 's1'), 1)
    clock.advance(SUBAGENT_ENTRY_TTL_MS + 1)
    assert.equal(counter.getCount('claude-hooks', 's1'), 0)
    assert.equal(counter.size, 0)
  })

  it('a touch refreshes the TTL', () => {
    const clock = makeClock()
    const counter = new SubagentCounter({ now: clock.now })
    counter.record('subagent_start', 'claude-hooks', 's1')
    clock.advance(SUBAGENT_ENTRY_TTL_MS - 1000)
    counter.record('subagent_start', 'claude-hooks', 's1') // touch
    clock.advance(SUBAGENT_ENTRY_TTL_MS - 1000)
    assert.equal(counter.getCount('claude-hooks', 's1'), 2)
  })

  it('lazy sweep prunes expired entries on later records', () => {
    const clock = makeClock()
    const counter = new SubagentCounter({ now: clock.now })
    counter.record('subagent_start', 'claude-hooks', 'old')
    clock.advance(SUBAGENT_ENTRY_TTL_MS + 1)
    counter.record('subagent_start', 'claude-hooks', 'fresh')
    assert.equal(counter.size, 1)
    assert.equal(counter.getCount('claude-hooks', 'fresh'), 1)
  })

  it('caps tracked entries and evicts the least recently touched', () => {
    const clock = makeClock()
    const counter = new SubagentCounter({ now: clock.now, maxEntries: 3 })
    counter.record('subagent_start', 'src', 'a')
    counter.record('subagent_start', 'src', 'b')
    counter.record('subagent_start', 'src', 'c')
    counter.record('subagent_start', 'src', 'a') // touch a → b is now oldest
    counter.record('subagent_start', 'src', 'd')
    assert.ok(counter.size <= 3)
    assert.equal(counter.getCount('src', 'b'), 0, 'least recently touched evicted')
    assert.equal(counter.getCount('src', 'a'), 2)
    assert.equal(counter.getCount('src', 'd'), 1)
  })

  it('defaults are sane', () => {
    assert.ok(SUBAGENT_ENTRY_TTL_MS >= 60 * 60 * 1000)
    assert.ok(SUBAGENT_MAX_ENTRIES >= 100)
  })
})

describe('SubagentCounter — per-project totals (#5463)', () => {
  it('sums live sessions of one project and isolates other projects', () => {
    const counter = new SubagentCounter()
    counter.record('subagent_start', 'claude-hooks', 'a', 'proj1')
    counter.record('subagent_start', 'claude-hooks', 'a', 'proj1')
    counter.record('subagent_start', 'claude-hooks', 'b', 'proj1')
    counter.record('subagent_start', 'claude-hooks', 'c', 'proj2')
    assert.equal(counter.getProjectTotal('proj1'), 3)
    assert.equal(counter.getProjectTotal('proj2'), 1)
    assert.equal(counter.getProjectTotal('proj3'), 0)
  })

  it('spans sources — the embed project key has no source dimension', () => {
    const counter = new SubagentCounter()
    counter.record('subagent_start', 'claude-hooks', 's1', 'proj1')
    counter.record('subagent_start', 'other-tool', 's1', 'proj1')
    assert.equal(counter.getProjectTotal('proj1'), 2)
  })

  it('session_end subtracts only that session\'s contribution', () => {
    const counter = new SubagentCounter()
    counter.record('subagent_start', 'claude-hooks', 'a', 'proj1')
    counter.record('subagent_start', 'claude-hooks', 'a', 'proj1')
    counter.record('subagent_start', 'claude-hooks', 'b', 'proj1')
    counter.record('session_end', 'claude-hooks', 'a', 'proj1')
    assert.equal(counter.getProjectTotal('proj1'), 1)
    counter.record('session_end', 'claude-hooks', 'b', 'proj1')
    assert.equal(counter.getProjectTotal('proj1'), 0)
  })

  it('TTL expiry subtracts an abandoned session\'s contribution', () => {
    const clock = makeClock()
    const counter = new SubagentCounter({ now: clock.now })
    counter.record('subagent_start', 'claude-hooks', 'abandoned', 'proj1')
    clock.advance(SUBAGENT_ENTRY_TTL_MS - 1000)
    counter.record('subagent_start', 'claude-hooks', 'live', 'proj1')
    assert.equal(counter.getProjectTotal('proj1'), 2)
    clock.advance(2000) // 'abandoned' is past the TTL, 'live' is not
    assert.equal(counter.getProjectTotal('proj1'), 1)
    assert.equal(counter.size, 1, 'expired entry dropped during the scan')
  })

  it('LRU eviction subtracts the evicted session\'s contribution', () => {
    const counter = new SubagentCounter({ maxEntries: 2 })
    counter.record('subagent_start', 'src', 'a', 'proj1')
    counter.record('subagent_start', 'src', 'b', 'proj1')
    counter.record('subagent_start', 'src', 'c', 'proj1') // evicts a
    assert.equal(counter.getProjectTotal('proj1'), 2)
  })

  it('entries without a project never leak into a project total', () => {
    const counter = new SubagentCounter()
    counter.record('subagent_start', 'claude-hooks', 'no-project')
    counter.record('subagent_start', 'claude-hooks', 'with-project', 'proj1')
    assert.equal(counter.getProjectTotal('proj1'), 1)
    assert.equal(counter.getProjectTotal(''), 0)
    assert.equal(counter.getProjectTotal(null), 0)
    assert.equal(counter.getProjectTotal(undefined), 0)
  })

  it('a later event without a project keeps the entry\'s known project', () => {
    const counter = new SubagentCounter()
    counter.record('subagent_start', 'claude-hooks', 's1', 'proj1')
    counter.record('subagent_start', 'claude-hooks', 's1') // e.g. missing cwd
    assert.equal(counter.getProjectTotal('proj1'), 2)
  })

  it('per-session reads are unchanged by the project dimension', () => {
    const counter = new SubagentCounter()
    counter.record('subagent_start', 'claude-hooks', 'a', 'proj1')
    counter.record('subagent_start', 'claude-hooks', 'b', 'proj1')
    assert.equal(counter.getCount('claude-hooks', 'a'), 1)
    assert.equal(counter.getCount('claude-hooks', 'b'), 1)
  })
})
