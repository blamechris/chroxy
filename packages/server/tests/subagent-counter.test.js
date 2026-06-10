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
