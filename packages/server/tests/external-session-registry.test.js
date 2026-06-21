// #5969 (epic #5422 phase 4): ExternalSessionRegistry — a point-in-time view
// of LIVE external Claude Code sessions, derived from the /api/events stream
// (no client state), for the Control Room mission-control read-only section.
//
// Pins:
//   - status derives from turn-in-flight: user_prompt_submit → running,
//     stop / session_end → not running
//   - subagent_start/stop arithmetic per (source, sessionId), floored at 0
//   - session_end removes the entry; project/cwd latest-non-empty-wins
//   - getSessions() shape (name fallback, sort newest-first), keys isolated
//     across sources AND sessions
//   - stale entries expire after the TTL (lazy sweep, injected clock)
//   - hard cap: oldest-touched evicted first, size stays bounded
//   - events without a sessionId are ignored

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ExternalSessionRegistry,
  EXTERNAL_SESSION_TTL_MS,
  EXTERNAL_SESSION_MAX_ENTRIES,
} from '../src/external-session-registry.js'

function makeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

describe('ExternalSessionRegistry', () => {
  it('surfaces a session_start as an idle read-only entry', () => {
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'cli', 's1', { project: 'chroxy', cwd: '/home/me/chroxy' })
    const sessions = r.getSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].sessionId, 's1')
    assert.equal(sessions[0].name, 'chroxy')
    assert.equal(sessions[0].cwd, '/home/me/chroxy')
    assert.equal(sessions[0].status, 'idle')
    assert.equal(sessions[0].subagents, 0)
  })

  it('flips status running on user_prompt_submit and back to idle on stop', () => {
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'cli', 's1', {})
    r.record('user_prompt_submit', 'cli', 's1', {})
    assert.equal(r.getSessions()[0].status, 'running')
    r.record('stop', 'cli', 's1', {})
    assert.equal(r.getSessions()[0].status, 'idle')
  })

  it('counts subagents floored at 0', () => {
    const r = new ExternalSessionRegistry()
    r.record('subagent_start', 'cli', 's1', {})
    r.record('subagent_start', 'cli', 's1', {})
    assert.equal(r.getSessions()[0].subagents, 2)
    r.record('subagent_stop', 'cli', 's1', {})
    assert.equal(r.getSessions()[0].subagents, 1)
    r.record('subagent_stop', 'cli', 's1', {})
    r.record('subagent_stop', 'cli', 's1', {}) // extra stop after restart
    assert.equal(r.getSessions()[0].subagents, 0)
  })

  it('session_end removes the entry', () => {
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'cli', 's1', {})
    assert.equal(r.size, 1)
    r.record('session_end', 'cli', 's1', {})
    assert.equal(r.size, 0)
    assert.deepEqual(r.getSessions(), [])
  })

  it('keeps project/cwd as latest-non-empty-wins', () => {
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'cli', 's1', { project: 'p1', cwd: '/a' })
    r.record('user_prompt_submit', 'cli', 's1', {}) // no project/cwd → keep
    let s = r.getSessions()[0]
    assert.equal(s.project, 'p1')
    assert.equal(s.cwd, '/a')
    r.record('stop', 'cli', 's1', { project: 'p2' }) // newer project wins
    s = r.getSessions()[0]
    assert.equal(s.project, 'p2')
    assert.equal(s.cwd, '/a')
  })

  it('derives a name from cwd basename, then a short id, when project is absent', () => {
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'cli', 'abcdef0123456789', { cwd: '/home/me/widget-app' })
    assert.equal(r.getSessions()[0].name, 'widget-app')
    r.record('session_start', 'cli', 'zyxwvu9876543210', {})
    const byId = r.getSessions().find((s) => s.sessionId === 'zyxwvu9876543210')
    assert.equal(byId.name, 'external:zyxwvu98')
  })

  it('isolates keys across sources AND sessions', () => {
    const r = new ExternalSessionRegistry()
    r.record('subagent_start', 'cli', 's1', {})
    r.record('subagent_start', 'vscode', 's1', {}) // same sessionId, other source
    r.record('subagent_start', 'cli', 's2', {})
    assert.equal(r.size, 3)
  })

  it('sorts getSessions newest-activity first', () => {
    const clock = makeClock()
    const r = new ExternalSessionRegistry({ now: clock.now })
    r.record('session_start', 'cli', 'old', {})
    clock.advance(5000)
    r.record('session_start', 'cli', 'new', {})
    const ids = r.getSessions().map((s) => s.sessionId)
    assert.deepEqual(ids, ['new', 'old'])
  })

  it('expires stale entries after the TTL (lazy sweep)', () => {
    const clock = makeClock()
    const r = new ExternalSessionRegistry({ now: clock.now })
    r.record('session_start', 'cli', 's1', {})
    clock.advance(EXTERNAL_SESSION_TTL_MS + 1)
    assert.deepEqual(r.getSessions(), [])
  })

  it('caps tracked entries, evicting oldest-touched first', () => {
    const r = new ExternalSessionRegistry({ maxEntries: 3 })
    r.record('session_start', 'cli', 'a', {})
    r.record('session_start', 'cli', 'b', {})
    r.record('session_start', 'cli', 'c', {})
    r.record('session_start', 'cli', 'd', {}) // evicts 'a'
    const ids = r.getSessions().map((s) => s.sessionId).sort()
    assert.deepEqual(ids, ['b', 'c', 'd'])
    assert.ok(r.size <= 3)
  })

  it('ignores events without a sessionId', () => {
    const r = new ExternalSessionRegistry()
    assert.equal(r.record('session_start', 'cli', '', {}), false)
    assert.equal(r.record('session_start', 'cli', undefined, {}), false)
    assert.equal(r.size, 0)
  })

  it('exports sane defaults', () => {
    assert.equal(EXTERNAL_SESSION_TTL_MS, 2 * 60 * 60 * 1000)
    assert.equal(EXTERNAL_SESSION_MAX_ENTRIES, 1000)
  })
})
