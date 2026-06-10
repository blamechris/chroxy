// #5413 Phase 4: subagent counting wired into POST /api/events.
//
// Pins:
//   - subagent_start/subagent_stop fold into the per-(source, sessionId)
//     aggregate; the notification body carries the running count and
//     `data.subagents` (the key the Discord sink renders) is set
//   - notification events mention active subagents when > 0 and stay
//     untouched when 0
//   - session_end resets the count
//   - sessions are isolated; events without a sessionId are not counted
//     and carry no `subagents` key
//
// Uses handleEventIngest directly with a mock server object (same pattern
// as event-ingest.test.js). No SessionManager, no real state paths.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { handleEventIngest } from '../src/event-ingest.js'
import { SubagentCounter } from '../src/subagent-counter.js'

const SECRET = 'subagent-test-secret'
const VALID_TS = 1_750_000_000_000

function makePushManager() {
  const calls = []
  return {
    calls,
    hasConfiguredSinks: () => true,
    send: (category, title, body, data) => {
      calls.push({ category, title, body, data })
      return Promise.resolve(true)
    },
  }
}

describe('event ingest subagent counting', () => {
  let httpServer
  let url
  let mockServer

  beforeEach(async () => {
    mockServer = {
      _ingestSecret: SECRET,
      _subagentCounter: new SubagentCounter(),
      pushManager: makePushManager(),
    }
    httpServer = createServer((req, res) => handleEventIngest(mockServer, req, res))
    httpServer.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    url = `http://127.0.0.1:${httpServer.address().port}/api/events`
  })

  afterEach(() => httpServer.close())

  async function post(event) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SECRET}` },
      body: JSON.stringify(event),
    })
    return res
  }

  function lastCall() {
    return mockServer.pushManager.calls.at(-1)
  }

  const base = { source: 'claude-hooks', sessionId: 'sess-1', ts: VALID_TS }

  it('subagent_start increments and stamps body + data.subagents', async () => {
    assert.equal((await post({ ...base, type: 'subagent_start' })).status, 200)
    assert.equal((await post({ ...base, type: 'subagent_start' })).status, 200)
    const call = lastCall()
    assert.equal(call.category, 'session_activity')
    assert.equal(call.body, 'A subagent is running (2 active)')
    assert.equal(call.data.subagents, 2)
  })

  it('subagent_stop decrements and floors at zero', async () => {
    await post({ ...base, type: 'subagent_start' })
    await post({ ...base, type: 'subagent_stop' })
    assert.equal(lastCall().body, 'A subagent completed (0 active)')
    assert.equal(lastCall().data.subagents, 0)
    await post({ ...base, type: 'subagent_stop' })
    assert.equal(lastCall().data.subagents, 0)
  })

  it('notification events mention active subagents when > 0', async () => {
    await post({ ...base, type: 'subagent_start' })
    await post({ ...base, type: 'notification' })
    assert.equal(lastCall().body, 'Claude is waiting — 1 subagent active')
    assert.equal(lastCall().data.subagents, 1)

    await post({ ...base, type: 'subagent_start' })
    await post({ ...base, type: 'notification', data: { message: 'Custom waiting text' } })
    assert.equal(lastCall().body, 'Custom waiting text — 2 subagents active')
  })

  it('notification body is untouched when no subagents are active', async () => {
    await post({ ...base, type: 'notification' })
    assert.equal(lastCall().body, 'Claude is waiting')
    assert.equal(lastCall().data.subagents, 0)
  })

  it('session_end resets the count for that session', async () => {
    await post({ ...base, type: 'subagent_start' })
    await post({ ...base, type: 'session_end' })
    assert.equal(lastCall().data.subagents, 0)
    await post({ ...base, type: 'notification' })
    assert.equal(lastCall().body, 'Claude is waiting')
  })

  it('counts are isolated per session', async () => {
    await post({ ...base, type: 'subagent_start' })
    await post({ ...base, sessionId: 'sess-2', type: 'notification' })
    assert.equal(lastCall().body, 'Claude is waiting')
    assert.equal(lastCall().data.subagents, 0)
  })

  it('events without a sessionId are not counted, carry no subagents key, and get no body suffix', async () => {
    const res = await post({ source: 'claude-hooks', type: 'subagent_start', ts: VALID_TS })
    assert.equal(res.status, 200)
    assert.equal('subagents' in lastCall().data, false)
    assert.equal(lastCall().body, 'A subagent is running')
    assert.equal(mockServer._subagentCounter.size, 0)
  })

  it('lazily constructs a counter when none is pre-seeded', async () => {
    delete mockServer._subagentCounter
    await post({ ...base, type: 'subagent_start' })
    assert.ok(mockServer._subagentCounter instanceof SubagentCounter)
    assert.equal(mockServer._subagentCounter.getCount('claude-hooks', 'sess-1'), 1)
  })
})
