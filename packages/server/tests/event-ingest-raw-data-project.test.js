// #7123 — found while reviewing #7121 (which closes #7105).
//
// #7121 clamps the DERIVED `project` at its single derivation site in
// `event-ingest.js`:
//
//   const derivedProject = event.project || deriveProjectFromCwd(data.cwd)
//   const project = ... slice(0, MAX_EXTERNAL_PROJECT_CHARS) ...
//
// That covers both branches `derivedProject` can take. But the push payload
// spreads the RAW event `data` bag before applying the clamped value:
//
//   pushManager.send(mapping.category, title, notifyBody, {
//     ...data,                            // <-- raw data.project lands here
//     ...
//     ...(project ? { project } : {}),    // <-- only overrides when truthy
//
// When the envelope carries no `project` AND no `data.cwd`, `project` is
// `null`, the override is skipped, and a `data.project` supplied directly in
// the `data` bag survives the spread untouched. `IngestEventDataSchema` caps
// each data value at 4096 chars — 16x the 256-char cap `event.project` gets
// from `IngestEventSchema` — so this route lets a schema-legal but 16x-over
// value reach `pushManager.send` and, from there, `DiscordWebhookSink.
// _projectKey`, which becomes the Discord state-file map key.
//
// The fix strips `data.project` from the spread unconditionally: the
// clamped/derived `project` computed above is the only value that may ever
// reach the payload under that key. When none is derivable, `project` is
// ABSENT from the payload rather than falling back to the raw value —
// whatever its length.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleEventIngest } from '../src/event-ingest.js'
import { SubagentCounter } from '../src/subagent-counter.js'
import { TurnTracker } from '../src/turn-tracker.js'
import { MAX_EXTERNAL_PROJECT_CHARS } from '../src/external-session-registry.js'
import { DiscordWebhookSink } from '../src/notifications/discord-webhook-sink.js'

const VALID_TS = 1_750_000_000_000
const SECRET = 'raw-data-project-secret'

/** Schema-legal (<=4096) but far over MAX_EXTERNAL_PROJECT_CHARS (256). */
const RAW_LONG_PROJECT = 'p'.repeat(4096)

describe('#7123 a raw data.project cannot bypass the ingest project clamp', () => {
  let httpServer
  let url
  let mockServer

  beforeEach(async () => {
    mockServer = {
      _ingestSecret: SECRET,
      _subagentCounter: new SubagentCounter(),
      _turnTracker: new TurnTracker(),
      pushManager: {
        calls: [],
        hasConfiguredSinks: () => true,
        send: (category, title, body, data) => {
          mockServer.pushManager.calls.push({ category, title, body, data })
          return Promise.resolve(true)
        },
      },
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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(event),
    })
    assert.equal(res.status, 200)
    return res
  }

  const lastPush = () => mockServer.pushManager.calls.at(-1)

  it('PREMISE: a 4096-char data.project is schema-legal (16x MAX_EXTERNAL_PROJECT_CHARS)', () => {
    assert.equal(RAW_LONG_PROJECT.length, 4096)
    assert.ok(RAW_LONG_PROJECT.length > MAX_EXTERNAL_PROJECT_CHARS * 4)
  })

  it('drops a raw data.project entirely when no envelope project and no cwd are given', async () => {
    await post({
      source: 'claude-hooks',
      sessionId: 'sess-raw-1',
      type: 'stop',
      ts: VALID_TS,
      data: { project: RAW_LONG_PROJECT },
    })
    assert.equal(
      lastPush().data.project, undefined,
      'no project is derivable, so the raw data.project must not fall back into the payload',
    )
  })

  it('bounds the _projectKey the Discord sink would derive from that payload', async () => {
    await post({
      source: 'claude-hooks',
      sessionId: 'sess-raw-2',
      type: 'stop',
      ts: VALID_TS,
      data: { project: RAW_LONG_PROJECT },
    })
    const key = DiscordWebhookSink.prototype._projectKey(lastPush())
    assert.ok(
      key.length <= MAX_EXTERNAL_PROJECT_CHARS,
      `_projectKey derived a ${key.length}-char state-file key from the dropped field`,
    )
    // With `project` absent, _projectKey's documented fallback chain
    // (project || sessionName || sessionId || 'chroxy') lands on sessionId.
    assert.equal(key, 'sess-raw-2')
  })

  it('a short (in-cap) data.project is ALSO dropped, not just an over-long one — it is not a supported channel', async () => {
    // The envelope's `project` field is the only documented way to set the
    // project explicitly; `data.project` reaching the sink was always an
    // accident of the raw spread, not a feature. The fix removes the key
    // outright rather than conditionally clamping only long values.
    await post({
      source: 'claude-hooks',
      sessionId: 'sess-raw-3',
      type: 'stop',
      ts: VALID_TS,
      data: { project: 'short-and-legal' },
    })
    assert.equal(lastPush().data.project, undefined)
  })

  it('CONTROL: other data fields survive the spread untouched alongside the stripped project', async () => {
    await post({
      source: 'claude-hooks',
      sessionId: 'sess-raw-4',
      type: 'stop',
      ts: VALID_TS,
      data: { project: RAW_LONG_PROJECT, title: 'hello', message: 'world', detail: 'x' },
    })
    const { data } = lastPush()
    assert.equal(data.project, undefined)
    assert.equal(data.title, 'hello')
    assert.equal(data.message, 'world')
    assert.equal(data.detail, 'x')
  })

  it('CONTROL: an explicit envelope project still wins and is carried through byte-for-byte', async () => {
    await post({
      source: 'claude-hooks',
      project: 'myproject',
      sessionId: 'sess-raw-5',
      type: 'stop',
      ts: VALID_TS,
      data: { project: RAW_LONG_PROJECT },
    })
    assert.equal(lastPush().data.project, 'myproject', 'the envelope project overrides, and is untouched by the strip')
  })

  it('CONTROL: derivation from data.cwd is unaffected by the strip', async () => {
    await post({
      source: 'claude-hooks',
      sessionId: 'sess-raw-6',
      type: 'stop',
      ts: VALID_TS,
      data: { cwd: '/Users/x/Projects/chroxy', project: RAW_LONG_PROJECT },
    })
    assert.equal(lastPush().data.project, 'chroxy', 'derived project wins over the raw data.project value')
  })

  it('CONTROL: a project at exactly the cap, derived from cwd, is untouched (#7121 boundary still holds)', async () => {
    const LONG_CWD = `/${'q'.repeat(4000)}`
    await post({
      source: 'claude-hooks',
      sessionId: 'sess-raw-7',
      type: 'stop',
      ts: VALID_TS,
      data: { cwd: LONG_CWD },
    })
    assert.equal(lastPush().data.project.length, MAX_EXTERNAL_PROJECT_CHARS)
  })
})

// End-to-end: the exact envelope from the issue body drives the real
// DiscordWebhookSink and asserts the resulting state-file key is bounded.
describe('#7123 end-to-end: the Discord sink state-file key is bounded', () => {
  let httpServer
  let url
  let mockServer
  let sink
  let statePath
  let deliveries
  let fetchCalls
  let originalFetch
  const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789_abcdefghijklmnopqrstuvwx'

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    fetchCalls = []
    let autoId = 0
    globalThis.fetch = async (fetchUrl, options = {}) => {
      fetchCalls.push({ url: String(fetchUrl), method: options.method || 'GET', body: options.body })
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: `m${++autoId}` }) }
    }
    statePath = join(mkdtempSync(join(tmpdir(), 'ingest-raw-project-e2e-')), 'state.json')
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

  it('the state-file key for a project-less, cwd-less event stays bounded (falls back to sessionId)', async () => {
    await post({
      source: 'claude-hooks',
      sessionId: 'e2e-raw-1',
      type: 'stop',
      ts: VALID_TS,
      data: { project: RAW_LONG_PROJECT },
    })
    const store = sink._loadState()
    const keys = Object.keys(store.projects)
    assert.ok(keys.length > 0, 'the sink must have written an entry')
    for (const key of keys) {
      assert.ok(key.length <= MAX_EXTERNAL_PROJECT_CHARS, `state-file key "${key.slice(0, 40)}..." is ${key.length} chars`)
    }
    assert.deepEqual(keys, ['e2e-raw-1'])
  })
})
