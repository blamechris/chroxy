// #8063 review — found while closing #7123.
//
// #7123 strips `data.project` from the raw spread in `event-ingest.js` so it
// can no longer reach `pushManager.send`'s payload unclamped. But
// `DiscordWebhookSink._projectKey()` has TWO more fallbacks with the
// identical shape:
//
//   _projectKey(notification) {
//     const data = notification?.data || {}
//     const raw = data.project || data.sessionName || data.sessionId || 'chroxy'
//     const sanitized = String(raw).replace(/[^A-Za-z0-9._-]/g, '')
//     return sanitized.length > 0 ? sanitized : 'unknown'
//   }
//
// `data.sessionName` and `data.sessionId` are raw `IngestEventDataSchema`
// values — wire-legal up to 4096 chars, same as `data.project` was — and
// neither is stripped by the #7123 ingest-side fix (only `project` is).
// Worse, the envelope-level `event.sessionId` override in event-ingest.js
// (`...(event.sessionId ? { sessionId: event.sessionId } : {})`) only fires
// when `event.sessionId` is truthy, so a raw `data.sessionId` in the data bag
// survives whenever no envelope sessionId is given — and even when one IS
// given, `data.sessionName` still wins the `_projectKey` fallback chain over
// a perfectly valid short envelope `sessionId`.
//
// The fix clamps `_projectKey()`'s OUTPUT to `MAX_EXTERNAL_PROJECT_CHARS`
// (not `MAX_EXTERNAL_SESSION_ID_CHARS` — whichever field produced the raw
// value, the function's return value is always used downstream as a PROJECT
// identifier: the state-file map key and the per-project color-override
// lookup, never as a session id in its own right). This closes `project`,
// `sessionName`, `sessionId`, and any future fourth fallback in one place.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleEventIngest } from '../src/event-ingest.js'
import { SubagentCounter } from '../src/subagent-counter.js'
import { TurnTracker } from '../src/turn-tracker.js'
import { MAX_EXTERNAL_PROJECT_CHARS } from '../src/external-session-registry.js'
import { DiscordWebhookSink } from '../src/notifications/discord-webhook-sink.js'

const VALID_TS = 1_750_000_000_000
const SECRET = 'projectkey-clamp-secret'
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789_abcdefghijklmnopqrstuvwx'

/** Schema-legal (<=4096) but far over MAX_EXTERNAL_PROJECT_CHARS (256). */
const RAW_LONG_SESSION_NAME = 'n'.repeat(4096)
const RAW_LONG_SESSION_ID = 's'.repeat(4096)

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'))
}

describe('#8063 review: _projectKey bounds every fallback, not just project', () => {
  let sink
  let statePath

  beforeEach(() => {
    statePath = join(mkdtempSync(join(tmpdir(), 'projectkey-clamp-')), 'state.json')
    sink = new DiscordWebhookSink({
      statePath,
      resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
      sleepImpl: async () => {},
      heartbeatIntervalMs: 0,
      now: () => 1_000_000,
    })
  })

  afterEach(() => sink.destroy?.())

  it('PREMISE: a 4096-char sessionName/sessionId is schema-legal (16x MAX_EXTERNAL_PROJECT_CHARS)', () => {
    assert.equal(RAW_LONG_SESSION_NAME.length, 4096)
    assert.equal(RAW_LONG_SESSION_ID.length, 4096)
    assert.ok(RAW_LONG_SESSION_NAME.length > MAX_EXTERNAL_PROJECT_CHARS * 4)
  })

  it('bounds a key derived from a raw 4096-char data.sessionName', () => {
    const key = sink._projectKey({ data: { sessionName: RAW_LONG_SESSION_NAME } })
    assert.ok(key.length <= MAX_EXTERNAL_PROJECT_CHARS, `key is ${key.length} chars`)
    assert.equal(key, 'n'.repeat(MAX_EXTERNAL_PROJECT_CHARS))
  })

  it('bounds a key derived from a raw 4096-char data.sessionId', () => {
    const key = sink._projectKey({ data: { sessionId: RAW_LONG_SESSION_ID } })
    assert.ok(key.length <= MAX_EXTERNAL_PROJECT_CHARS, `key is ${key.length} chars`)
    assert.equal(key, 's'.repeat(MAX_EXTERNAL_PROJECT_CHARS))
  })

  it('bounds a key even when sanitization runs first (non-charset input)', () => {
    // The sanitizer strips everything outside [A-Za-z0-9._-] — confirms the
    // clamp is applied to the SANITIZED string, not a pre-sanitize slice that
    // could still exceed the cap once metacharacters are stripped down.
    const raw = ('*'.repeat(2000)) + 'n'.repeat(3000)
    const key = sink._projectKey({ data: { sessionName: raw } })
    assert.ok(key.length <= MAX_EXTERNAL_PROJECT_CHARS, `key is ${key.length} chars`)
  })

  it('CONTROL: a short sessionName yields the identical key as before the fix (no rewrite of existing state)', () => {
    assert.equal(sink._projectKey({ data: { sessionName: 'alpha' } }), 'alpha')
  })

  it('CONTROL: a short sessionId yields the identical key as before the fix', () => {
    assert.equal(sink._projectKey({ data: { sessionId: 'sess-123' } }), 'sess-123')
  })

  it('CONTROL: a key at exactly the cap is untouched (boundary is inclusive)', () => {
    const exact = 'q'.repeat(MAX_EXTERNAL_PROJECT_CHARS)
    assert.equal(sink._projectKey({ data: { sessionName: exact } }), exact)
  })

  it('CONTROL: a key one char over the cap is truncated by exactly one char', () => {
    const overByOne = 'q'.repeat(MAX_EXTERNAL_PROJECT_CHARS + 1)
    const key = sink._projectKey({ data: { sessionName: overByOne } })
    assert.equal(key.length, MAX_EXTERNAL_PROJECT_CHARS)
    assert.equal(key, 'q'.repeat(MAX_EXTERNAL_PROJECT_CHARS))
  })

  it('CONTROL: an explicit short project still wins the fallback chain and is untouched', () => {
    assert.equal(
      sink._projectKey({ data: { project: 'myproject', sessionName: RAW_LONG_SESSION_NAME } }),
      'myproject',
    )
  })

  it('CONTROL: the "chroxy" and "unknown" defaults are unaffected by the clamp', () => {
    assert.equal(sink._projectKey({ data: {} }), 'chroxy')
    assert.equal(sink._projectKey({ data: { sessionName: '***' } }), 'unknown')
  })
})

// End-to-end: the exact two envelopes the review reproduced, driven through
// the real HTTP handler and the real DiscordWebhookSink, asserting the
// on-disk state-file key is bounded.
describe('#8063 review end-to-end: the ingest route cannot mint an unbounded Discord state-file key via sessionName/sessionId', () => {
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
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: `m${++autoId}` }) }
    }
    statePath = join(mkdtempSync(join(tmpdir(), 'projectkey-clamp-e2e-')), 'state.json')
    sink = new DiscordWebhookSink({
      statePath,
      resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
      sleepImpl: async () => {},
      heartbeatIntervalMs: 0,
      updateThrottleMs: 0,
    })
    deliveries = []
    mockServer = {
      _ingestSecret: SECRET,
      _subagentCounter: new SubagentCounter(),
      _turnTracker: new TurnTracker(),
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

  async function post(event) {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(event),
    })
    assert.equal(res.status, 200)
    await Promise.all(deliveries)
  }

  it('a 4096-char data.sessionId, with no envelope sessionId/project/cwd, yields a bounded state-file key', async () => {
    await post({
      source: 'claude-hooks',
      type: 'stop',
      ts: VALID_TS,
      data: { sessionId: RAW_LONG_SESSION_ID },
    })
    const keys = Object.keys(readState(statePath).projects)
    assert.equal(keys.length, 1)
    assert.ok(keys[0].length <= MAX_EXTERNAL_PROJECT_CHARS, `state-file key is ${keys[0].length} chars`)
  })

  it('a 4096-char data.sessionName beats a valid short envelope sessionId, but still yields a bounded state-file key', async () => {
    await post({
      source: 'claude-hooks',
      sessionId: 'short-id',
      type: 'stop',
      ts: VALID_TS,
      data: { sessionName: RAW_LONG_SESSION_NAME },
    })
    const keys = Object.keys(readState(statePath).projects)
    assert.equal(keys.length, 1)
    assert.ok(keys[0].length <= MAX_EXTERNAL_PROJECT_CHARS, `state-file key is ${keys[0].length} chars`)
    assert.notEqual(keys[0], 'short-id', 'sessionName still wins the fallback chain over sessionId — this pins that pre-existing precedence, not a regression from the clamp')
  })

  it('CONTROL: an ordinary short sessionId with no project/cwd/sessionName produces the identical key as before this fix', async () => {
    await post({
      source: 'claude-hooks',
      sessionId: 'ok-session-1',
      type: 'stop',
      ts: VALID_TS,
      data: {},
    })
    const keys = Object.keys(readState(statePath).projects)
    assert.deepEqual(keys, ['ok-session-1'])
  })
})
