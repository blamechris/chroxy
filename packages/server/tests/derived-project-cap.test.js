// #7105 — the DERIVED `project` was bounded at only one of its four consumers,
// and the Discord embed title was never bounded at all.
//
// `event-ingest.js` mints the value once:
//
//   const project = event.project || deriveProjectFromCwd(data.cwd)
//
// An explicit `event.project` is wire-capped at 256 by IngestEventSchema, but
// the derived branch is a path BASENAME — and `cwd` is wire-capped at 4096 — so
// a single-component 4096-char cwd yields a ~4000-char project. (The path need
// not exist on disk, so NAME_MAX does not bound it.) That value then fans out
// to four consumers; #7104 clamped exactly one of them (the external-session
// registry, from the inside).
//
// The live consequence is the Discord status embed. `_projectKey` sanitizes the
// CHARSET but not the LENGTH, and `_buildPayload` interpolates the result into
// `title` — the one embed field in that function that does NOT go through
// `escapeAndCap`. Discord's embed-title limit is 256, so the webhook POST comes
// back 400 and the per-project status embed silently stops updating.
//
// Note that the two halves of the fix are BOTH load-bearing: clamping the
// derivation site alone yields a 256-char project, and the shortest state title
// adds ~18 more characters on top of it — still over Discord's limit. The
// end-to-end case at the bottom is red unless both are in place.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveProjectFromCwd } from '@chroxy/protocol/project'
import { handleEventIngest } from '../src/event-ingest.js'
import { SubagentCounter } from '../src/subagent-counter.js'
import { TurnTracker } from '../src/turn-tracker.js'
import { MAX_EXTERNAL_PROJECT_CHARS } from '../src/external-session-registry.js'
import { DiscordWebhookSink } from '../src/notifications/discord-webhook-sink.js'

/**
 * Discord's documented hard limits, asserted as literals on purpose: pinning
 * against a constant exported by the code under test would pass no matter what
 * that constant said.
 * https://discord.com/developers/docs/resources/message#embed-object-embed-limits
 */
const DISCORD_EMBED_TITLE_LIMIT = 256
const DISCORD_EMBED_FIELD_NAME_LIMIT = 256
const DISCORD_EMBED_FIELD_VALUE_LIMIT = 1024
const DISCORD_EMBED_FOOTER_LIMIT = 2048
const DISCORD_EMBED_TOTAL_LIMIT = 6000

const VALID_TS = 1_750_000_000_000
const SECRET = 'derived-project-cap-secret'
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789_abcdefghijklmnopqrstuvwx'

/** A single-component path that is wire-legal inbound (<=4096) but over-long. */
const LONG_COMPONENT = 'p'.repeat(4000)
const LONG_CWD = `/${LONG_COMPONENT}`

/** Every Discord embed limit that a long project could plausibly blow. */
function assertDiscordLegal(payload) {
  const embed = payload.embeds[0]
  assert.ok(
    embed.title.length <= DISCORD_EMBED_TITLE_LIMIT,
    `embed title is ${embed.title.length} chars; Discord rejects the whole webhook past ${DISCORD_EMBED_TITLE_LIMIT} (400)`,
  )
  let total = embed.title.length
  for (const field of embed.fields || []) {
    assert.ok(field.name.length <= DISCORD_EMBED_FIELD_NAME_LIMIT, `field name ${field.name.length} chars`)
    assert.ok(field.value.length <= DISCORD_EMBED_FIELD_VALUE_LIMIT, `field value ${field.value.length} chars`)
    total += field.name.length + field.value.length
  }
  const footer = embed.footer?.text || ''
  assert.ok(footer.length <= DISCORD_EMBED_FOOTER_LIMIT, `footer ${footer.length} chars`)
  total += footer.length
  assert.ok(total <= DISCORD_EMBED_TOTAL_LIMIT, `embed total ${total} chars`)
}

describe('#7105 the derived project is clamped at its derivation site', () => {
  let httpServer
  let url
  let mockServer
  let externalCalls

  beforeEach(async () => {
    externalCalls = []
    mockServer = {
      _ingestSecret: SECRET,
      _subagentCounter: new SubagentCounter(),
      _turnTracker: new TurnTracker(),
      sessionManager: {
        recordExternalSessionEvent: (type, source, sessionId, info) => {
          externalCalls.push({ type, source, sessionId, info })
        },
      },
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
  const storedProjects = (map) => [...map.values()].map((e) => e.project)

  it('PREMISE: the derivation really does mint a 4000-char project from a wire-legal cwd', () => {
    // The positive control for every fixture below: if deriveProjectFromCwd
    // bounded its own output, each "is clamped" assertion would pass for free.
    const derived = deriveProjectFromCwd(LONG_CWD)
    assert.equal(derived.length, 4000, 'the unclamped derivation is what makes this bug reachable')
    assert.ok(derived.length > MAX_EXTERNAL_PROJECT_CHARS)
  })

  it('bounds the project handed to SubagentCounter', async () => {
    await post({ source: 'claude-hooks', sessionId: 'sess-1', type: 'subagent_start', ts: VALID_TS, data: { cwd: LONG_CWD } })
    assert.deepEqual(
      storedProjects(mockServer._subagentCounter._entries).map((p) => p.length),
      [MAX_EXTERNAL_PROJECT_CHARS],
      'the subagent counter retains the project verbatim — it must be bounded before it gets there',
    )
  })

  it('bounds the project handed to TurnTracker', async () => {
    await post({ source: 'claude-hooks', sessionId: 'sess-2', type: 'user_prompt_submit', ts: VALID_TS, data: { cwd: LONG_CWD } })
    assert.deepEqual(
      storedProjects(mockServer._turnTracker._entries).map((p) => p.length),
      [MAX_EXTERNAL_PROJECT_CHARS],
      'the turn tracker retains the project verbatim — it must be bounded before it gets there',
    )
  })

  it('bounds the project handed to pushManager.send', async () => {
    await post({ source: 'claude-hooks', sessionId: 'sess-3', type: 'stop', ts: VALID_TS, data: { cwd: LONG_CWD } })
    assert.equal(
      lastPush().data.project.length, MAX_EXTERNAL_PROJECT_CHARS,
      'this is the value that reaches every notification sink, Discord included',
    )
  })

  it('bounds the project handed to recordExternalSessionEvent', async () => {
    // #7104 clamps this one INSIDE the registry. Pinning it here says the
    // caller no longer relies on that — the registry clamp becomes pure
    // defence-in-depth rather than the only thing standing between a 4000-char
    // basename and the mission-control snapshot.
    await post({ source: 'claude-hooks', sessionId: 'sess-4', type: 'session_start', ts: VALID_TS, data: { cwd: LONG_CWD } })
    assert.equal(externalCalls.length, 1)
    assert.equal(externalCalls[0].info.project.length, MAX_EXTERNAL_PROJECT_CHARS)
  })

  it('CONTROL: an ordinary derived project reaches all four consumers byte-for-byte', async () => {
    // Without this, a clamp that truncated indiscriminately would pass above.
    await post({ source: 'claude-hooks', sessionId: 'ok-1', type: 'subagent_start', ts: VALID_TS, data: { cwd: '/Users/x/Projects/chroxy' } })
    await post({ source: 'claude-hooks', sessionId: 'ok-1', type: 'user_prompt_submit', ts: VALID_TS, data: { cwd: '/Users/x/Projects/chroxy' } })
    assert.deepEqual(storedProjects(mockServer._subagentCounter._entries), ['chroxy'])
    assert.deepEqual(storedProjects(mockServer._turnTracker._entries), ['chroxy'])
    assert.equal(lastPush().data.project, 'chroxy')
    assert.equal(externalCalls.at(-1).info.project, 'chroxy')
  })

  it('CONTROL: a project of exactly the cap is untouched, and cwd is not clamped with it', async () => {
    const exact = 'q'.repeat(MAX_EXTERNAL_PROJECT_CHARS)
    await post({ source: 'claude-hooks', project: exact, sessionId: 'ok-2', type: 'stop', ts: VALID_TS, data: { cwd: LONG_CWD } })
    assert.equal(lastPush().data.project, exact, 'the boundary is inclusive')
    assert.equal(lastPush().data.cwd, LONG_CWD, 'cwd has its own, larger bound — clamping it would corrupt a real path')
    assert.equal(externalCalls.at(-1).info.cwd, LONG_CWD)
  })
})

describe('#7105 the Discord embed title is capped', () => {
  let sink
  let statePath

  beforeEach(() => {
    statePath = join(mkdtempSync(join(tmpdir(), 'discord-title-cap-')), 'state.json')
    sink = new DiscordWebhookSink({
      statePath,
      resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
      sleepImpl: async () => {},
      heartbeatIntervalMs: 0,
      now: () => 1_000_000,
    })
  })

  afterEach(() => sink.destroy?.())

  const entry = (state) => ({ state, body: 'Ready for next message', firstSeenTs: 1_000_000 })

  it('PREMISE: _projectKey passes an over-long project through untouched', () => {
    // The charset sanitizer is not a length bound: a run of 4000 `p` is already
    // in the allowed set, so it survives whole.
    assert.equal(sink._projectKey({ data: { project: LONG_COMPONENT } }).length, 4000)
  })

  it('caps the title of every state, however long the project', () => {
    for (const state of ['idle', 'permission', 'error', 'stale', 'online', 'offline']) {
      const payload = sink._buildPayload(LONG_COMPONENT, entry(state))
      assertDiscordLegal(payload)
    }
  })

  it('keeps the state suffix when the project is truncated', () => {
    // The title's entire information content is the STATE. Capping the composed
    // title instead of the project would cut the suffix off and leave 256
    // characters of `p`.
    const title = sink._buildPayload(LONG_COMPONENT, entry('idle')).embeds[0].title
    assert.ok(title.length <= DISCORD_EMBED_TITLE_LIMIT, `title is ${title.length} chars`)
    assert.match(title, /Ready for input$/)
    assert.ok(title.startsWith('\u{1F980} p'), `unexpected title head: ${title.slice(0, 40)}`)
  })

  it('CONTROL: an ordinary project title is untouched', () => {
    // Without this, a cap that mangled every title would pass above.
    const title = sink._buildPayload('chroxy', entry('idle')).embeds[0].title
    assert.equal(title, '\u{1F980} chroxy — Ready for input')
  })

  it('CONTROL: a project sized exactly to the budget is not truncated', () => {
    // Pins the boundary as inclusive — an off-by-one that shaved a character
    // off every at-budget project would otherwise go unnoticed.
    const composed = sink._buildPayload('x', entry('idle')).embeds[0].title
    const budget = DISCORD_EMBED_TITLE_LIMIT - (composed.length - 1)
    const exact = 'y'.repeat(budget)
    const title = sink._buildPayload(exact, entry('idle')).embeds[0].title
    assert.ok(title.includes(exact), 'a project that already fits must not be rewritten')
    assert.equal(title.length, DISCORD_EMBED_TITLE_LIMIT)
  })
})

// The end-to-end case the issue asks for: a 4096-char `cwd` arrives on
// POST /api/events and must yield a payload the Discord API would accept.
// This is red unless BOTH halves are fixed — clamping the derivation site alone
// still leaves a 256-char project plus its state suffix over the 256 limit.
describe('#7105 end-to-end: a 4096-char cwd yields a Discord-legal webhook body', () => {
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
    statePath = join(mkdtempSync(join(tmpdir(), 'ingest-title-e2e-')), 'state.json')
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

  // The mocked global fetch is reserved for the sink's Discord calls.
  async function post(event) {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(event),
    })
    assert.equal(res.status, 200)
    await Promise.all(deliveries)
  }

  it('every webhook body Discord is sent stays inside the embed limits', async () => {
    await post({ source: 'claude-hooks', sessionId: 'e2e-1', type: 'session_start', ts: VALID_TS, data: { cwd: LONG_CWD } })
    await post({ source: 'claude-hooks', sessionId: 'e2e-1', type: 'stop', ts: VALID_TS, data: { cwd: LONG_CWD } })

    const bodies = fetchCalls.filter((c) => c.body).map((c) => JSON.parse(c.body))
    assert.ok(bodies.length > 0, 'the sink must actually have talked to Discord')
    for (const body of bodies) assertDiscordLegal(body)
  })
})
