// #7428: DiscordCiSink — one fresh Discord message per settled CI run.
// Separate from the per-project status sink (a CI run is not a session
// state) and, unlike the billing-alert sink, stateless: every ci_complete
// notification POSTs a brand-new message, never an edit.
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { DiscordCiSink } from '../src/notifications/discord-ci-sink.js'

const WEBHOOK_ID = '123456789012345678'
const WEBHOOK_TOKEN = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789_abcdefghijklmnopqrstuvwx'
const WEBHOOK = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`

let originalFetch
beforeEach(() => { originalFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = originalFetch; mock.restoreAll() })

/** Scripted fetch — responses consumed in order; dry script returns 200 + fresh id. */
function scriptFetch(script = []) {
  const calls = []
  let autoId = 0
  globalThis.fetch = mock.fn(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body })
    const next = script.length > 0 ? script.shift() : { status: 200, body: { id: `auto-${++autoId}` } }
    if (next.throws) throw next.throws
    const status = next.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => next.headers?.[String(h).toLowerCase()] ?? null },
      json: async () => next.body ?? {},
    }
  })
  return calls
}

function makeSink(overrides = {}) {
  const sink = new DiscordCiSink({
    resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
    sleepImpl: async () => {},
    now: () => 1_700_000_000_000,
    ...overrides,
  })
  return { sink }
}

/**
 * A ci_complete notification shaped like ciCompletionPush() in
 * session-ci-watcher.js. `data` is merged over the defaults (not replaced) so
 * a test overriding one field (e.g. just `verdict`) doesn't silently drop the
 * rest.
 */
const ciComplete = ({ data, ...rest } = {}) => ({
  category: 'ci_complete',
  title: 'CI passed on #1234',
  body: '5 of 5 checks passed; merge state CLEAN — Fix the flaky retry test',
  data: {
    sessionId: 'sess-1',
    prNumber: 1234,
    prUrl: 'https://github.com/blamechris/chroxy/pull/1234',
    repo: 'blamechris/chroxy',
    verdict: 'success',
    mergeStateStatus: 'CLEAN',
    ...data,
  },
  ...rest,
})

describe('DiscordCiSink — configuration gating', () => {
  it('isConfigured() is false without a webhook URL', () => {
    const { sink } = makeSink({ resolveWebhookUrl: () => null })
    assert.equal(sink.isConfigured(), false)
  })

  it('isConfigured() is false when ciAlerts is disabled', () => {
    const { sink } = makeSink({ ciAlerts: false })
    assert.equal(sink.isConfigured(), false)
  })

  it('isConfigured() is true with a webhook URL and the default kill-switch', () => {
    const { sink } = makeSink()
    assert.equal(sink.isConfigured(), true)
  })

  it('a throwing resolver never throws out of isConfigured()', () => {
    const { sink } = makeSink({ resolveWebhookUrl: () => { throw new Error('boom') } })
    assert.equal(sink.isConfigured(), false)
  })
})

describe('DiscordCiSink — delivery', () => {
  it('skips non-ci_complete categories (status/billing sinks own those)', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink()
    const ok = await sink.send({ category: 'activity_update', title: 't', body: 'b', data: {} })
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
  })

  it('no-op when unconfigured', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink({ resolveWebhookUrl: () => null })
    const ok = await sink.send(ciComplete())
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
  })

  it('a ci_complete notification actually POSTs one message with title/number/conclusion/link', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    const ok = await sink.send(ciComplete())
    assert.equal(ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.match(calls[0].url, /\?wait=true$/)
    const payload = JSON.parse(calls[0].body)
    const embed = payload.embeds[0]
    assert.match(embed.title, /1234/) // PR number
    assert.ok(embed.title.includes('\u{2705}'), 'success conclusion emoji present')
    assert.equal(embed.url, 'https://github.com/blamechris/chroxy/pull/1234') // link
    assert.ok(embed.description.includes('Fix the flaky retry test')) // PR title
  })

  it('a failure verdict renders the failure emoji and color', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ title: 'CI failed on #1234', data: { verdict: 'failure', prNumber: 1234 } }))
    const payload = JSON.parse(calls[0].body)
    const embed = payload.embeds[0]
    assert.ok(embed.title.includes('\u{274C}'))
    assert.equal(embed.color, sink._failureColor)
  })

  it('two consecutive ci_complete events for the same PR produce two POSTs (no editing in place)', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'msg-1' } },
      { status: 200, body: { id: 'msg-2' } },
    ])
    const { sink } = makeSink()
    await sink.send(ciComplete())
    const ok = await sink.send(ciComplete())
    assert.equal(ok, true)
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'POST'])
    assert.notEqual(calls[0].url, undefined)
  })

  it('a hard POST failure resolves false', async () => {
    scriptFetch([{ status: 500 }, { status: 500 }, { status: 500 }])
    const { sink } = makeSink()
    const ok = await sink.send(ciComplete())
    assert.equal(ok, false)
  })

  it('a network throw resolves false, never throws', async () => {
    scriptFetch([{ throws: new Error('ECONNRESET') }, { throws: new Error('ECONNRESET') }, { throws: new Error('ECONNRESET') }])
    const { sink } = makeSink()
    const ok = await sink.send(ciComplete())
    assert.equal(ok, false)
  })

  it('respects a globally muted ci_complete category', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink()
    const ok = await sink.send(ciComplete(), { isCategoryEnabled: () => false })
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
  })

  it('respects quiet hours without a bypass', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink()
    const ok = await sink.send(ciComplete(), {
      isInQuietHours: () => true,
      shouldBypassQuietHours: () => false,
    })
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
  })

  it('a bypass-listed category still sends during quiet hours', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    const ok = await sink.send(ciComplete(), {
      isInQuietHours: () => true,
      shouldBypassQuietHours: () => true,
    })
    assert.equal(ok, true)
    assert.equal(calls.length, 1)
  })
})

describe('DiscordCiSink — payload shape / graceful degradation', () => {
  it('renders without a Duration field when the payload carries no timing data (today’s reality)', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete())
    const payload = JSON.parse(calls[0].body)
    const fields = payload.embeds[0].fields || []
    assert.equal(fields.some((f) => f.name === 'Duration'), false)
  })

  it('renders a Duration field when the notification does carry one (forward-compat)', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ data: { durationSeconds: 330 } }))
    const payload = JSON.parse(calls[0].body)
    const field = payload.embeds[0].fields.find((f) => f.name === 'Duration')
    assert.ok(field, 'Duration field present')
    assert.equal(field.value, '5m 30s')
  })

  it('renders gracefully with a missing/empty title, falling back to the PR number', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send({ category: 'ci_complete', title: '', body: '', data: { prNumber: 999, verdict: 'success' } })
    const payload = JSON.parse(calls[0].body)
    assert.match(payload.embeds[0].title, /999/)
  })

  it('renders gracefully with no prUrl at all — no url set, no throw', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ data: { prUrl: null } }))
    const payload = JSON.parse(calls[0].body)
    assert.equal(payload.embeds[0].url, undefined)
  })

  it('an unrecognised verdict gets a neutral conclusion, not a false success/failure', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ title: 'CI finished on #1234 with unrecognised checks', data: { verdict: 'unknown' } }))
    const payload = JSON.parse(calls[0].body)
    const embed = payload.embeds[0]
    assert.ok(!embed.title.includes('\u{2705}'))
    assert.ok(!embed.title.includes('\u{274C}'))
    assert.equal(embed.color, sink._unknownColor)
  })
})

describe('DiscordCiSink — sanitisation (#7428)', () => {
  it('neutralises an @everyone mention in the PR title (carried in notification.body)', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ body: '5 of 5 checks passed — @everyone please review this' }))
    const payload = JSON.parse(calls[0].body)
    const description = payload.embeds[0].description
    assert.ok(!description.includes('@everyone'), 'raw @everyone must not reach the wire')
    assert.ok(description.includes('everyone'), 'text is still present, just de-fanged')
  })

  it('neutralises a role/user snowflake mention', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ body: 'ping <@123456789012345678> and <@&987654321098765432>' }))
    const payload = JSON.parse(calls[0].body)
    const description = payload.embeds[0].description
    assert.ok(!description.includes('<@123456789012345678>'))
    assert.ok(!description.includes('<@&987654321098765432>'))
  })

  it('escapes markdown metacharacters in the PR title / body', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ body: 'fix *bold* and _italic_ handling' }))
    const payload = JSON.parse(calls[0].body)
    const description = payload.embeds[0].description
    assert.ok(description.includes('\\*bold\\*'))
    assert.ok(description.includes('\\_italic\\_'))
  })

  it('truncates a very long title to the embed title limit', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ title: 'x'.repeat(1000) }))
    const payload = JSON.parse(calls[0].body)
    assert.ok(payload.embeds[0].title.length <= 256)
  })

  it('escapes markdown metacharacters in the embed TITLE, not only the description', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ title: 'CI *passed* on _main_ #1234' }))
    const title = JSON.parse(calls[0].body).embeds[0].title
    assert.ok(title.includes('\\*passed\\*'), 'title must escape *')
    assert.ok(title.includes('\\_main\\_'), 'title must escape _')
  })

  it('sets allowed_mentions { parse: [] } so Discord parses no mentions server-side', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ body: '@everyone <@123456789012345678>' }))
    const payload = JSON.parse(calls[0].body)
    assert.deepEqual(payload.allowed_mentions, { parse: [] })
  })

  it('a mention injected via the title itself is also neutralised', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(ciComplete({ title: '@everyone CI passed on #1234' }))
    const payload = JSON.parse(calls[0].body)
    assert.ok(!payload.embeds[0].title.includes('@everyone'))
  })
})
