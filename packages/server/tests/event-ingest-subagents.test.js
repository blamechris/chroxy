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
// #5463 — per-project aggregation: events that carry a project are stamped
// with the PROJECT total (sum over that project's live sessions), so a
// second session emitting into the same project (worktree agents remapped
// by GAP B) can't overwrite the embed's count with its own unrelated number
// — and, concretely, a zero from session B can't fire session A's armed
// idle count→0 ready re-ping. Pinned both at the ingest level (stamped
// data.subagents) and end-to-end through a real DiscordWebhookSink.
//
// Uses handleEventIngest directly with a mock server object (same pattern
// as event-ingest.test.js). No SessionManager, no real state paths.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleEventIngest } from '../src/event-ingest.js'
import { SubagentCounter } from '../src/subagent-counter.js'
import { DiscordWebhookSink } from '../src/notifications/discord-webhook-sink.js'

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

  // -- #5463: per-project aggregation --------------------------------------

  const inProj = (sessionId, event) => ({ source: 'claude-hooks', project: 'proj1', sessionId, ts: VALID_TS, ...event })

  it('stamps the project total, not the emitting session\'s own count', async () => {
    await post(inProj('sess-A', { type: 'subagent_start' }))
    await post(inProj('sess-A', { type: 'subagent_start' }))
    // Session B (e.g. a worktree agent remapped to the parent project)
    // reports activity with ZERO subagents of its own — pre-#5463 this
    // stamped subagents: 0 and fired A's armed count→0 ready re-ping.
    await post(inProj('sess-B', { type: 'post_tool_use' }))
    assert.equal(lastCall().data.subagents, 2, 'B\'s event carries the project total')
    assert.equal(lastCall().body, 'Tool use completed — 2 subagents active')
  })

  it('subagent events from a second session add to the project total', async () => {
    await post(inProj('sess-A', { type: 'subagent_start' }))
    await post(inProj('sess-B', { type: 'subagent_start' }))
    assert.equal(lastCall().data.subagents, 2)
    assert.equal(lastCall().body, 'A subagent is running (2 active)')
  })

  it('session_end subtracts only the ending session\'s contribution', async () => {
    await post(inProj('sess-A', { type: 'subagent_start' }))
    await post(inProj('sess-A', { type: 'subagent_start' }))
    await post(inProj('sess-B', { type: 'subagent_start' }))
    await post(inProj('sess-B', { type: 'session_end' }))
    assert.equal(lastCall().data.subagents, 2, 'A\'s contribution survives B\'s end')
    await post(inProj('sess-A', { type: 'session_end' }))
    assert.equal(lastCall().data.subagents, 0)
  })

  it('projects are isolated from each other', async () => {
    await post(inProj('sess-A', { type: 'subagent_start' }))
    await post({ source: 'claude-hooks', project: 'proj2', sessionId: 'sess-C', type: 'post_tool_use', ts: VALID_TS })
    assert.equal(lastCall().data.subagents, 0)
  })

  it('events without a project fall back to the per-session count', async () => {
    await post(inProj('sess-A', { type: 'subagent_start' }))
    await post(inProj('sess-B', { type: 'subagent_start' }))
    await post({ source: 'claude-hooks', sessionId: 'sess-A', type: 'notification', ts: VALID_TS })
    assert.equal(lastCall().data.subagents, 1, 'no project → the session\'s own count')
  })
})

// #5463 end-to-end: two sessions in one project, driven through POST
// /api/events into a REAL DiscordWebhookSink (mocked fetch). Session A is
// idle-armed with 2 running subagents; session B's activity must NOT fire
// the count→0 ready re-ping — only A's own last subagent_stop may.
describe('event ingest → Discord sink: cross-session re-ping (#5463)', () => {
  const SECRET2 = 'subagent-e2e-secret'
  const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789_abcdefghijklmnopqrstuvwx'
  let httpServer
  let url
  let mockServer
  let sink
  let statePath
  let deliveries
  let fetchCalls
  let originalFetch

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    fetchCalls = []
    let autoId = 0
    globalThis.fetch = async (fetchUrl, options = {}) => {
      fetchCalls.push({ url: String(fetchUrl), method: options.method || 'GET', body: options.body })
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ id: `m${++autoId}` }),
      }
    }
    statePath = join(mkdtempSync(join(tmpdir(), 'ingest-discord-e2e-')), 'state.json')
    sink = new DiscordWebhookSink({
      statePath,
      resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
      sleepImpl: async () => {},
      heartbeatIntervalMs: 0,
      updateThrottleMs: 0,
    })
    deliveries = []
    mockServer = {
      _ingestSecret: SECRET2,
      _subagentCounter: new SubagentCounter(),
      pushManager: {
        hasConfiguredSinks: () => true,
        send: (category, title, body, data) => {
          const p = sink.send({ category, title, body, data })
          deliveries.push(p)
          return p
        },
      },
    }
    httpServer = createServer((req, res) => handleEventIngest(mockServer, req, res))
    httpServer.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    url = `http://127.0.0.1:${httpServer.address().port}/api/events`
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    sink.destroy?.()
    httpServer.close()
  })

  // post() must hit the local HTTP server with the REAL fetch — the mocked
  // global is reserved for the sink's Discord calls.
  async function post(event) {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SECRET2}` },
      body: JSON.stringify(event),
    })
    assert.equal(res.status, 200)
    // The ingest dispatch is fire-and-forget; settle sink delivery before
    // asserting on the Discord calls.
    await Promise.all(deliveries)
  }

  const ev = (sessionId, type, data = {}) => ({
    source: 'claude-hooks', project: 'proj1', sessionId, ts: VALID_TS, type,
    ...(Object.keys(data).length > 0 ? { data } : {}),
  })

  function readState() {
    return JSON.parse(readFileSync(statePath, 'utf-8')).projects.proj1
  }

  it('B\'s zero-count activity does not fire A\'s armed ready re-ping; A\'s last stop does', async () => {
    // Session A online, spins up 2 subagents, then goes idle (armed embed).
    await post(ev('sess-A', 'session_start'))
    await post(ev('sess-A', 'subagent_start'))
    await post(ev('sess-A', 'subagent_start'))
    await post(ev('sess-A', 'notification', { notificationType: 'idle_prompt' }))
    assert.equal(readState().state, 'idle')
    assert.equal(readState().subagents, 2)
    const armedMessageId = readState().messageId

    // Session B (worktree agent remapped into proj1 by GAP B) reports tool
    // activity. Its own count is 0 — pre-#5463 the stamped 0 looked like
    // "all subagents done" and re-pinged Ready for input.
    fetchCalls.length = 0
    await post(ev('sess-B', 'post_tool_use'))
    assert.ok(!fetchCalls.some((c) => c.method === 'DELETE'), 'no re-ping repost (DELETE+POST)')
    assert.deepEqual(fetchCalls.map((c) => c.method), ['PATCH'], 'count refresh PATCHes in place')
    assert.equal(readState().state, 'idle', 'embed stays armed')
    assert.equal(readState().subagents, 2, 'A\'s running subagents still shown')
    assert.equal(readState().messageId, armedMessageId, 'same message — nobody was pinged')

    // A's first subagent finishes → still one running → no re-ping.
    fetchCalls.length = 0
    await post(ev('sess-A', 'subagent_stop'))
    assert.deepEqual(fetchCalls.map((c) => c.method), ['PATCH'])
    assert.equal(readState().subagents, 1)

    // A's LAST subagent finishes → project total hits 0 → ready re-ping.
    fetchCalls.length = 0
    await post(ev('sess-A', 'subagent_stop'))
    assert.deepEqual(fetchCalls.map((c) => c.method), ['DELETE', 'POST'], 'count→0 re-pings')
    assert.equal(readState().state, 'idle')
    assert.equal(readState().subagents, 0)
  })

  it('B ending its session does not zero A\'s armed count', async () => {
    await post(ev('sess-A', 'session_start'))
    await post(ev('sess-A', 'subagent_start'))
    await post(ev('sess-B', 'subagent_start'))
    await post(ev('sess-A', 'notification', { notificationType: 'idle_prompt' }))
    assert.equal(readState().subagents, 2)

    // B's subagent finishes and B's session ends — A's subagent still runs.
    fetchCalls.length = 0
    await post(ev('sess-B', 'subagent_stop'))
    assert.ok(!fetchCalls.some((c) => c.method === 'DELETE'), 'total is 1, not 0 — no re-ping')
    assert.equal(readState().state, 'idle')
    assert.equal(readState().subagents, 1)
  })
})
