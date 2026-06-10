// #5413 Phase 2: DiscordWebhookSink — the status-embed state machine ported
// from claude-code-notify, riding the Phase-1 sink rails.
//
// Pins:
//   - credential sourcing (env > 0600 credentials.json, masking)
//   - the message state machine: POST-once per project, PATCH for routine
//     updates, DELETE+POST for ping-worthy states, 404 self-heal, throttle
//     window, per-project isolation
//   - Discord 429 handling (retry_after respected, capped)
//   - hard failure after retries → send() resolves false, never throws
//   - heartbeat lifecycle (lazy start, destroy, no-op when unconfigured)
//
// All fetches mocked; all state paths are temp dirs (#4633 sandbox).

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiscordWebhookSink, formatDuration } from '../src/notifications/discord-webhook-sink.js'
import {
  resolveDiscordWebhookUrl,
  isValidDiscordWebhookUrl,
  extractWebhookIdToken,
  maskWebhookUrl,
} from '../src/discord-credentials.js'
import { redactSensitive } from '../src/logger.js'
import { SinkRegistry } from '../src/notifications/sink-registry.js'
import { PushManager } from '../src/push.js'
import { validateConfig } from '../src/config.js'

const WEBHOOK_ID = '123456789012345678'
const WEBHOOK_TOKEN = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789_abcdefghijklmnopqrstuvwx'
const WEBHOOK = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`
const API_BASE = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`

let originalFetch
let originalHome
let originalEnvUrl

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalHome = process.env.HOME
  originalEnvUrl = process.env.CHROXY_DISCORD_WEBHOOK_URL
  delete process.env.CHROXY_DISCORD_WEBHOOK_URL
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env.HOME = originalHome
  if (originalEnvUrl === undefined) delete process.env.CHROXY_DISCORD_WEBHOOK_URL
  else process.env.CHROXY_DISCORD_WEBHOOK_URL = originalEnvUrl
  mock.restoreAll()
})

/**
 * Scripted fetch: each entry is { status, body?, headers? }. Responses are
 * consumed in order; when the script runs dry, a 200 with a fresh message id
 * is returned. Returns the recorded calls array.
 */
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

/** Sink wired to a temp state file, a fake resolver, and a recording sleep. */
function makeSink(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'discord-sink-'))
  const statePath = join(dir, 'state.json')
  const sleeps = []
  let nowMs = 1_000_000
  const sink = new DiscordWebhookSink({
    statePath,
    resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
    sleepImpl: async (ms) => { sleeps.push(ms) },
    heartbeatIntervalMs: 0,
    now: () => nowMs,
    ...overrides,
  })
  return { sink, dir, statePath, sleeps, advance: (ms) => { nowMs += ms }, getNow: () => nowMs }
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'))
}

const idle = (data = {}) => ({
  category: 'activity_update',
  title: 'Session idle',
  body: 'Ready for next message',
  data: { sessionName: 'alpha', state: 'idle', ...data },
})
const waiting = (data = {}) => ({
  category: 'activity_waiting',
  title: 'Waiting for approval',
  body: 'Permission needed: Bash',
  data: { sessionName: 'alpha', state: 'waiting', detail: 'Bash', ...data },
})
const errored = (data = {}) => ({
  category: 'activity_error',
  title: 'Session error',
  body: 'boom',
  data: { sessionName: 'alpha', state: 'error', ...data },
})

describe('discord-credentials — webhook URL sourcing', () => {
  it('env var wins over the credentials file', () => {
    const home = mkdtempSync(join(tmpdir(), 'discord-home-'))
    process.env.HOME = home
    mkdirSync(join(home, '.chroxy'), { recursive: true })
    const file = join(home, '.chroxy', 'credentials.json')
    writeFileSync(file, JSON.stringify({ discordWebhookUrl: 'https://discord.com/api/webhooks/1/file-token-aaaaaaaaaaaaaaaaaaaa' }), { mode: 0o600 })
    chmodSync(file, 0o600)
    process.env.CHROXY_DISCORD_WEBHOOK_URL = WEBHOOK
    const r = resolveDiscordWebhookUrl()
    assert.equal(r.source, 'env')
    assert.equal(r.url, WEBHOOK)
  })

  it('reads discordWebhookUrl from a 0600 credentials.json', () => {
    // Temp home — the #4633 sandbox guard only protects the REAL home.
    const home = mkdtempSync(join(tmpdir(), 'discord-home-'))
    process.env.HOME = home
    const dir = join(home, '.chroxy')
    const file = join(dir, 'credentials.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ discordWebhookUrl: WEBHOOK }), { mode: 0o600 })
    chmodSync(file, 0o600)
    const r = resolveDiscordWebhookUrl()
    assert.equal(r.source, 'file')
    assert.equal(r.url, WEBHOOK)
  })

  it('refuses a credentials file that is not 0600', () => {
    const home = mkdtempSync(join(tmpdir(), 'discord-home-'))
    process.env.HOME = home
    mkdirSync(join(home, '.chroxy'), { recursive: true })
    const file = join(home, '.chroxy', 'credentials.json')
    writeFileSync(file, JSON.stringify({ discordWebhookUrl: WEBHOOK }))
    chmodSync(file, 0o644)
    const r = resolveDiscordWebhookUrl()
    assert.equal(r.url, null)
    assert.match(r.reason, /0600/)
  })

  it('resolves to none when neither env nor file is present', () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'discord-home-'))
    const r = resolveDiscordWebhookUrl()
    assert.equal(r.url, null)
    assert.equal(r.source, 'none')
  })

  it('validates webhook URL shapes', () => {
    assert.equal(isValidDiscordWebhookUrl(WEBHOOK), true)
    assert.equal(isValidDiscordWebhookUrl(`https://discordapp.com/api/webhooks/1/${WEBHOOK_TOKEN}`), true)
    assert.equal(isValidDiscordWebhookUrl(`https://discord.com/api/v10/webhooks/1/${WEBHOOK_TOKEN}`), true)
    assert.equal(isValidDiscordWebhookUrl('https://example.com/api/webhooks/1/tok'), false)
    assert.equal(isValidDiscordWebhookUrl('http://discord.com/api/webhooks/1/tok'), false)
    assert.equal(isValidDiscordWebhookUrl('not a url'), false)
    assert.equal(isValidDiscordWebhookUrl(null), false)
  })

  it('extracts id/token, ignoring query params and fragments', () => {
    const parts = extractWebhookIdToken(`${WEBHOOK}?wait=true#frag`)
    assert.deepEqual(parts, { id: WEBHOOK_ID, token: WEBHOOK_TOKEN })
    assert.equal(extractWebhookIdToken('https://example.com/x'), null)
  })

  it('maskWebhookUrl never echoes the token', () => {
    const masked = maskWebhookUrl(WEBHOOK)
    assert.ok(masked.includes(WEBHOOK_ID))
    assert.ok(!masked.includes(WEBHOOK_TOKEN))
    assert.ok(masked.includes('[REDACTED]'))
    assert.equal(maskWebhookUrl('garbage'), '<invalid webhook url>')
  })

  it('logger redaction scrubs Discord webhook URLs (#5413)', () => {
    const redacted = redactSensitive(`posting to ${WEBHOOK} failed`)
    assert.ok(!redacted.includes(WEBHOOK_TOKEN), 'token must not survive redaction')
    assert.ok(redacted.includes('[REDACTED]'))
    // legacy domain too
    const legacy = redactSensitive(`https://discordapp.com/api/webhooks/42/${WEBHOOK_TOKEN}`)
    assert.ok(!legacy.includes(WEBHOOK_TOKEN))
  })
})

describe('DiscordWebhookSink — configuration gating', () => {
  it('has the stable sink name', () => {
    const { sink } = makeSink()
    assert.equal(sink.name, 'discord-webhook')
  })

  it('is unconfigured without a webhook URL (off by default)', () => {
    const { sink } = makeSink({ resolveWebhookUrl: () => ({ url: null, source: 'none', reason: 'nope' }) })
    assert.equal(sink.isConfigured(), false)
  })

  it('is unconfigured when the resolved URL is not a Discord webhook', () => {
    const { sink } = makeSink({ resolveWebhookUrl: () => ({ url: 'https://example.com/hook', source: 'env' }) })
    assert.equal(sink.isConfigured(), false)
  })

  it('is unconfigured (not crashed) when the resolver throws', () => {
    const { sink } = makeSink({ resolveWebhookUrl: () => { throw new Error('disk on fire') } })
    assert.equal(sink.isConfigured(), false)
  })

  it('is configured with a valid webhook URL', () => {
    const { sink } = makeSink()
    assert.equal(sink.isConfigured(), true)
  })

  it('the registry skips it entirely while unconfigured', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink({ resolveWebhookUrl: () => ({ url: null, source: 'none' }) })
    const registry = new SinkRegistry()
    registry.register(sink)
    assert.equal(registry.hasConfigured(), false)
    assert.equal(await registry.fanOut(idle()), true)
    assert.equal(calls.length, 0)
  })

  it('send() resolves true without fetching when unconfigured (defensive)', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink({ resolveWebhookUrl: () => ({ url: null, source: 'none' }) })
    assert.equal(await sink.send(idle()), true)
    assert.equal(calls.length, 0)
  })

  it('honours a global category mute via the context evaluators (deviceId null)', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink()
    const ok = await sink.send(idle(), {
      isCategoryEnabled: (_category, deviceId) => deviceId !== null,
    })
    assert.equal(ok, true)
    assert.equal(calls.length, 0, 'globally muted category silences the embed update')
  })

  it('honours global quiet hours unless the category bypasses them', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink()
    assert.equal(await sink.send(idle(), { isInQuietHours: () => true }), true)
    assert.equal(calls.length, 0, 'quiet hours suppress the update')
    assert.equal(
      await sink.send(waiting(), { isInQuietHours: () => true, shouldBypassQuietHours: () => true }),
      true
    )
    assert.equal(calls.length, 1, 'bypass categories still fire during quiet hours')
  })
})

describe('DiscordWebhookSink — status-message state machine', () => {
  it('first notification POSTs a new message (?wait=true) and persists its id', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'm1' } }])
    const { sink, statePath } = makeSink()
    assert.equal(await sink.send(idle()), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, `${API_BASE}?wait=true`)
    const state = readState(statePath)
    assert.equal(state.projects.alpha.messageId, 'm1')
    assert.equal(state.projects.alpha.state, 'idle')
  })

  it('persists the state file atomically with restricted permissions', async () => {
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    const { sink, statePath } = makeSink()
    await sink.send(idle())
    assert.equal(existsSync(statePath), true)
    if (process.platform !== 'win32') {
      assert.equal(statSync(statePath).mode & 0o777, 0o600)
    }
    assert.equal(existsSync(`${statePath}.tmp`), false, 'temp sidecar renamed away')
  })

  it('a routine state update PATCHes the same message (no delete, no new post)', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'm1' } }, { status: 200 }])
    const { sink } = makeSink()
    await sink.send(idle())
    assert.equal(await sink.send(errored()), true)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].method, 'PATCH')
    assert.equal(calls[1].url, `${API_BASE}/messages/m1`)
  })

  it('a ping-worthy state DELETEs the old message then POSTs a new one (new id persisted)', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'm1' } }, // initial POST (idle)
      { status: 200 },                     // PATCH (error)
      { status: 204 },                     // DELETE m1
      { status: 200, body: { id: 'm2' } }, // re-POST (idle pings again)
    ])
    const { sink, statePath } = makeSink({ updateThrottleMs: 0 })
    await sink.send(idle())
    await sink.send(errored())
    assert.equal(await sink.send(idle()), true)
    assert.equal(calls.length, 4)
    assert.equal(calls[2].method, 'DELETE')
    assert.equal(calls[2].url, `${API_BASE}/messages/m1`)
    assert.equal(calls[3].method, 'POST')
    assert.equal(readState(statePath).projects.alpha.messageId, 'm2')
  })

  it('permission requests always re-post (each approval request re-pings)', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'm1' } }, // POST (permission)
      { status: 204 },                     // DELETE m1
      { status: 200, body: { id: 'm2' } }, // POST (permission again)
    ])
    const { sink } = makeSink()
    await sink.send(waiting())
    await sink.send(waiting())
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'DELETE', 'POST'])
  })

  it('idle → idle is a no-op (parity: already-idle embeds are not re-pinged)', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'm1' } }])
    const { sink } = makeSink()
    await sink.send(idle())
    assert.equal(await sink.send(idle()), true)
    assert.equal(calls.length, 1, 'second idle suppressed')
  })

  it('self-heals when the tracked message was deleted externally (PATCH 404 → re-POST)', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'm1' } }, // POST (idle)
      { status: 404 },                     // PATCH 404 (message gone)
      { status: 200, body: { id: 'm2' } }, // healing POST
    ])
    const { sink, statePath } = makeSink()
    await sink.send(idle())
    assert.equal(await sink.send(errored()), true)
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'PATCH', 'POST'])
    assert.equal(readState(statePath).projects.alpha.messageId, 'm2')
  })

  it('throttles redundant same-state routine PATCHes inside the window', async () => {
    const calls = scriptFetch()
    const { sink, advance } = makeSink({ updateThrottleMs: 15_000 })
    await sink.send(errored())               // POST (no message yet)
    advance(1_000)
    assert.equal(await sink.send(errored()), true) // inside window → suppressed
    assert.equal(calls.length, 1)
    advance(20_000)
    await sink.send(errored())               // window passed → PATCH
    assert.equal(calls.length, 2)
    assert.equal(calls[1].method, 'PATCH')
  })

  it('a state CHANGE bypasses the throttle window', async () => {
    const calls = scriptFetch()
    const { sink, advance } = makeSink({ updateThrottleMs: 60_000 })
    await sink.send(errored())
    advance(1_000)
    assert.equal(await sink.send({ ...errored(), category: 'inactivity_warning' }), true)
    assert.equal(calls.length, 2, 'error → stale transition not throttled')
  })

  it('keeps one message per project (two projects = two independent messages)', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'm-alpha' } },
      { status: 200, body: { id: 'm-beta' } },
    ])
    const { sink, statePath } = makeSink()
    await sink.send(idle({ sessionName: 'alpha' }))
    await sink.send(idle({ sessionName: 'beta' }))
    assert.equal(calls.length, 2)
    const { projects } = readState(statePath)
    assert.equal(projects.alpha.messageId, 'm-alpha')
    assert.equal(projects.beta.messageId, 'm-beta')
  })

  it('ignores unmapped categories without fetching (parity: unknown types skipped)', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink()
    assert.equal(await sink.send({ category: 'live_activity', title: 't', body: 'b', data: {} }), true)
    assert.equal(calls.length, 0)
  })

  it('builds the embed with per-project color, state title, and fields', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink({ colors: { alpha: 1752220 }, botName: 'TestBot' })
    await sink.send(idle({ subagents: 3 }))
    const payload = JSON.parse(calls[0].body)
    assert.equal(payload.username, 'TestBot')
    const embed = payload.embeds[0]
    assert.ok(embed.title.includes('alpha'))
    assert.ok(embed.title.includes('Ready for input'))
    assert.equal(embed.color, 1752220)
    assert.ok(embed.fields.some((f) => f.name === 'Subagents' && f.value === '3'))
    assert.ok(embed.footer.text.startsWith('TestBot'))
    assert.ok(embed.timestamp)
  })

  it('the #5438-enriched idle body rides notification.body into the Status field', async () => {
    // The ready-for-input enrichment is composed upstream (PushNotificationHandler
    // via composeReadyNotificationBody) and rides notification.body — this pins
    // that the status embed surfaces it without any sink special-casing.
    const calls = scriptFetch()
    const { sink } = makeSink()
    const enriched = 'Ready for input — still watching: deploy monitor +1 more'
    await sink.send({ ...idle(), body: enriched })
    const embed = JSON.parse(calls[0].body).embeds[0]
    assert.ok(embed.title.includes('Ready for input'))
    assert.ok(embed.fields.some((f) => f.name === 'Status' && f.value === enriched))
  })

  it('uses the permission color for needs-approval regardless of project overrides', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink({ colors: { alpha: 1752220 } })
    await sink.send(waiting())
    const embed = JSON.parse(calls[0].body).embeds[0]
    assert.equal(embed.color, 16753920)
    assert.ok(embed.fields.some((f) => f.name === 'Detail' && f.value === 'Bash'))
  })

  it('a DELETE failure during repost is best-effort: the new POST still goes out', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'm1' } }, // POST permission
      { throws: new Error('ECONNRESET') }, // DELETE fails
      { status: 200, body: { id: 'm2' } }, // POST still happens
    ])
    const { sink, statePath } = makeSink()
    await sink.send(waiting())
    assert.equal(await sink.send(waiting()), true)
    assert.equal(calls.length, 3)
    assert.equal(readState(statePath).projects.alpha.messageId, 'm2')
  })
})

describe('DiscordWebhookSink — 429 + failure handling', () => {
  it('respects retry_after from the 429 JSON body (Discord sends seconds)', async () => {
    const calls = scriptFetch([
      { status: 429, body: { retry_after: 1.5 } },
      { status: 200, body: { id: 'm1' } },
    ])
    const { sink, sleeps } = makeSink()
    assert.equal(await sink.send(idle()), true)
    assert.equal(calls.length, 2)
    assert.deepEqual(sleeps, [1500])
  })

  it('respects the Retry-After header when present', async () => {
    const calls = scriptFetch([
      { status: 429, headers: { 'retry-after': '3' } },
      { status: 200, body: { id: 'm1' } },
    ])
    const { sink, sleeps } = makeSink()
    assert.equal(await sink.send(idle()), true)
    assert.equal(calls.length, 2)
    assert.deepEqual(sleeps, [3000])
  })

  it('caps an absurd retry_after instead of stalling the pipeline', async () => {
    scriptFetch([
      { status: 429, body: { retry_after: 9999 } },
      { status: 200, body: { id: 'm1' } },
    ])
    const { sink, sleeps } = makeSink()
    await sink.send(idle())
    assert.deepEqual(sleeps, [30_000])
  })

  it('resolves false after exhausting retries on persistent 429 (no hammering)', async () => {
    const calls = scriptFetch([
      { status: 429, body: { retry_after: 0.1 } },
      { status: 429, body: { retry_after: 0.1 } },
      { status: 429, body: { retry_after: 0.1 } },
    ])
    const { sink } = makeSink()
    assert.equal(await sink.send(idle()), false)
    assert.equal(calls.length, 3, 'bounded attempts')
  })

  it('retries 5xx with backoff and resolves false after the final failure (never throws)', async () => {
    const calls = scriptFetch([{ status: 500 }, { status: 502 }, { status: 503 }])
    const { sink, sleeps } = makeSink()
    assert.equal(await sink.send(idle()), false)
    assert.equal(calls.length, 3)
    assert.deepEqual(sleeps, [1000, 2000])
  })

  it('resolves false (never throws) when the network throws on every attempt', async () => {
    scriptFetch([
      { throws: new Error('ENOTFOUND') },
      { throws: new Error('ENOTFOUND') },
      { throws: new Error('ENOTFOUND') },
    ])
    const { sink } = makeSink()
    assert.equal(await sink.send(idle()), false)
  })

  it('does not retry non-429 4xx responses', async () => {
    const calls = scriptFetch([{ status: 403 }])
    const { sink } = makeSink()
    assert.equal(await sink.send(idle()), false)
    assert.equal(calls.length, 1)
  })

  it('a failed PATCH does not advance the throttle clock (next event retries)', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'm1' } }, // POST idle
      { status: 500 }, { status: 500 }, { status: 500 }, // PATCH error fails hard
      { status: 200 },                     // retry PATCH succeeds
    ])
    const { sink, advance } = makeSink({ updateThrottleMs: 15_000 })
    await sink.send(idle())
    assert.equal(await sink.send(errored()), false)
    advance(1_000) // still inside what WOULD be the window had the failure stamped it
    assert.equal(await sink.send(errored()), true)
    assert.equal(calls.length, 5)
  })
})

describe('DiscordWebhookSink — heartbeat', () => {
  it('starts lazily after the first successful write and stops on destroy()', async () => {
    scriptFetch()
    const { sink } = makeSink({ heartbeatIntervalMs: 60_000 })
    assert.equal(sink._heartbeatTimer, null)
    await sink.send(idle())
    assert.notEqual(sink._heartbeatTimer, null, 'heartbeat armed after first message')
    sink.destroy()
    assert.equal(sink._heartbeatTimer, null)
    sink.destroy() // idempotent
  })

  it('never starts when disabled (heartbeatIntervalMs: 0)', async () => {
    scriptFetch()
    const { sink } = makeSink({ heartbeatIntervalMs: 0 })
    await sink.send(idle())
    assert.equal(sink._heartbeatTimer, null)
  })

  it('a tick PATCHes every tracked embed to refresh the elapsed footer', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'm-alpha' } },
      { status: 200, body: { id: 'm-beta' } },
    ])
    const { sink, advance } = makeSink()
    await sink.send(idle({ sessionName: 'alpha' }))
    await sink.send(idle({ sessionName: 'beta' }))
    advance(90_000)
    await sink._heartbeatTick()
    const patches = calls.filter((c) => c.method === 'PATCH')
    assert.equal(patches.length, 2)
    assert.ok(patches.some((c) => c.url.endsWith('/messages/m-alpha')))
    assert.ok(patches.some((c) => c.url.endsWith('/messages/m-beta')))
    const embed = JSON.parse(patches[0].body).embeds[0]
    assert.ok(embed.footer.text.includes('1m 30s'), `footer should show elapsed time, got: ${embed.footer.text}`)
  })

  it('a tick forgets a message that 404s so the next event re-posts', async () => {
    scriptFetch([
      { status: 200, body: { id: 'm1' } },
      { status: 404 }, // heartbeat PATCH finds it gone
    ])
    const { sink, statePath } = makeSink()
    await sink.send(idle())
    await sink._heartbeatTick()
    assert.equal(readState(statePath).projects.alpha.messageId, null)
  })

  it('a tick does nothing when unconfigured', async () => {
    const calls = scriptFetch()
    let url = WEBHOOK
    const { sink } = makeSink({ resolveWebhookUrl: () => ({ url, source: 'env' }) })
    await sink.send(idle())
    url = null // webhook removed between ticks
    await sink._heartbeatTick()
    assert.equal(calls.length, 1, 'no PATCH after the webhook went away')
  })
})

describe('PushManager integration (#5413 Phase 2)', () => {
  it('registers the Discord sink alongside Expo, off by default', () => {
    const pm = new PushManager({
      discord: { resolveWebhookUrl: () => ({ url: null, source: 'none' }) },
    })
    assert.deepEqual(pm._sinks.sinks.map((s) => s.name), ['expo-push', 'discord-webhook'])
    assert.equal(pm.hasConfiguredSinks(), false)
    pm.destroy()
  })

  it('hasConfiguredSinks() is true for a Discord-only setup (no Expo tokens)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-pm-'))
    const pm = new PushManager({
      discord: {
        statePath: join(dir, 'state.json'),
        resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
      },
    })
    assert.equal(pm.hasTokens, false, 'no Expo tokens registered')
    assert.equal(pm.hasConfiguredSinks(), true, 'Discord webhook alone counts')
    pm.destroy()
  })

  it('send() routes a notification through the Discord sink for a Discord-only setup', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'm1' } }])
    const dir = mkdtempSync(join(tmpdir(), 'discord-pm-'))
    const pm = new PushManager({
      discord: {
        statePath: join(dir, 'state.json'),
        resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
        heartbeatIntervalMs: 0,
      },
    })
    const ok = await pm.send('activity_update', 'Session idle', 'Ready', { sessionName: 'alpha', state: 'idle' })
    assert.equal(ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    pm.destroy()
  })

  it('destroy() clears the Discord heartbeat', async () => {
    scriptFetch()
    const dir = mkdtempSync(join(tmpdir(), 'discord-pm-'))
    const pm = new PushManager({
      discord: {
        statePath: join(dir, 'state.json'),
        resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
        heartbeatIntervalMs: 60_000,
      },
    })
    await pm.send('activity_update', 'Session idle', 'Ready', { sessionName: 'alpha' })
    assert.notEqual(pm._discordSink._heartbeatTimer, null)
    pm.destroy()
    assert.equal(pm._discordSink._heartbeatTimer, null)
  })
})

describe('config — notifications.discord block (#5413)', () => {
  it('accepts a well-formed block', () => {
    const result = validateConfig({
      notifications: {
        discord: {
          botName: 'Chroxy',
          colors: { chroxy: 1752220 },
          defaultColor: 5793266,
          permissionColor: 16753920,
          errorColor: 15158332,
          updateThrottleMs: 15000,
          heartbeatIntervalMs: 300000,
        },
      },
    })
    assert.equal(result.valid, true, JSON.stringify(result.warnings))
  })

  it('does not flag notifications as an unknown key', () => {
    const result = validateConfig({ notifications: {} })
    assert.equal(result.warnings.length, 0)
  })

  it('warns when a webhook URL is smuggled into config (secrets do not belong there)', () => {
    const result = validateConfig({ notifications: { discord: { webhookUrl: WEBHOOK } } })
    assert.ok(result.warnings.some((w) => w.includes('webhookUrl') && w.includes('CHROXY_DISCORD_WEBHOOK_URL')))
  })

  it('warns on out-of-range colors (value warning, never fatal "Invalid type")', () => {
    const result = validateConfig({ notifications: { discord: { colors: { proj: 99999999 } } } })
    assert.ok(result.warnings.some((w) => w.includes('colors.proj')))
    assert.ok(!result.warnings.some((w) => w.startsWith('Invalid type')), 'cosmetic typos must not be startup-fatal')
  })

  it('warns on a too-small heartbeat interval', () => {
    const result = validateConfig({ notifications: { discord: { heartbeatIntervalMs: 500 } } })
    assert.ok(result.warnings.some((w) => w.includes('heartbeatIntervalMs')))
  })
})

describe('formatDuration (ported from claude-code-notify)', () => {
  it('formats seconds, minutes, and hours like the original', () => {
    assert.equal(formatDuration(45), '45s')
    assert.equal(formatDuration(330), '5m 30s')
    assert.equal(formatDuration(4500), '1h 15m')
    assert.equal(formatDuration(-5), '0s')
    assert.equal(formatDuration(NaN), '0s')
  })
})

// #5413 Phase 3 — session lifecycle states fed by POST /api/events
// (event-ingest.js): session_online / session_offline / session_activity.
// Pins the bash original's SessionStart (DELETE old message + fresh POST,
// clean slate) and SessionEnd (PATCH offline in place; no-op when nothing
// is tracked or already offline) semantics.
describe('DiscordWebhookSink — online/offline lifecycle (#5413 Phase 3)', () => {
  const online = (data = {}) => ({
    category: 'session_online',
    title: 'Session online',
    body: 'External session started',
    data: { project: 'proj1', ...data },
  })
  const offline = (data = {}) => ({
    category: 'session_offline',
    title: 'Session offline',
    body: 'External session ended',
    data: { project: 'proj1', ...data },
  })
  const activity = (data = {}) => ({
    category: 'session_activity',
    title: 'Tool activity',
    body: 'Tool use completed',
    data: { project: 'proj1', ...data },
  })

  it('session_online POSTs a fresh message with the online title (no DELETE when nothing is tracked)', async () => {
    const { sink, statePath } = makeSink()
    const calls = scriptFetch([{ status: 200, body: { id: 'm1' } }])
    assert.equal(await sink.send(online()), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.ok(calls[0].url.includes('?wait=true'))
    const payload = JSON.parse(calls[0].body)
    assert.match(payload.embeds[0].title, /proj1 — Session Online/)
    assert.equal(payload.embeds[0].color, 3066993, 'bash CLAUDE_NOTIFY_ONLINE_COLOR default (green)')
    assert.equal(readState(statePath).projects.proj1.state, 'online')
  })

  it('session_online DELETEs the previous (offline) message before POSTing — bash SessionStart parity', async () => {
    const { sink, statePath, advance } = makeSink()
    // Establish a tracked message, take it offline, then start a new session.
    let calls = scriptFetch([{ status: 200, body: { id: 'm-old' } }])
    await sink.send(online())
    advance(60_000)
    calls = scriptFetch([{ status: 200 }]) // PATCH offline
    await sink.send(offline())
    assert.equal(readState(statePath).projects.proj1.state, 'offline')
    advance(60_000)
    calls = scriptFetch([
      { status: 204 },                       // DELETE m-old
      { status: 200, body: { id: 'm-new' } }, // POST fresh
    ])
    assert.equal(await sink.send(online()), true)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].method, 'DELETE')
    assert.ok(calls[0].url.endsWith('/messages/m-old'))
    assert.equal(calls[1].method, 'POST')
    const st = readState(statePath).projects.proj1
    assert.equal(st.state, 'online')
    assert.equal(st.messageId, 'm-new')
  })

  it('session_online resets the elapsed-time epoch and subagent count (clean slate)', async () => {
    const { sink, statePath, advance, getNow } = makeSink()
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(online({ subagents: 3 }))
    advance(120_000)
    scriptFetch([{ status: 204 }, { status: 200, body: { id: 'm2' } }])
    await sink.send(online())
    const st = readState(statePath).projects.proj1
    assert.equal(st.firstSeenTs, getNow(), 'firstSeenTs reset to the new session start')
    assert.equal(st.subagents, 0, 'subagent count cleared')
  })

  it('session_offline PATCHes the tracked message in place (routine, never DELETE+POST)', async () => {
    const { sink, statePath, advance } = makeSink()
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(online())
    advance(60_000)
    const calls = scriptFetch([{ status: 200 }])
    assert.equal(await sink.send(offline()), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'PATCH')
    assert.ok(calls[0].url.endsWith('/messages/m1'))
    const payload = JSON.parse(calls[0].body)
    assert.match(payload.embeds[0].title, /proj1 — Session Offline/)
    assert.equal(readState(statePath).projects.proj1.state, 'offline')
  })

  it('session_offline is a no-op when nothing is tracked for the project', async () => {
    const { sink } = makeSink()
    const calls = scriptFetch()
    assert.equal(await sink.send(offline()), true)
    assert.equal(calls.length, 0, 'no message to mark offline → no fetch at all')
  })

  it('session_offline is a no-op when the project is already offline', async () => {
    const { sink, advance } = makeSink()
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(online())
    advance(60_000)
    scriptFetch([{ status: 200 }])
    await sink.send(offline())
    advance(60_000)
    const calls = scriptFetch()
    assert.equal(await sink.send(offline()), true)
    assert.equal(calls.length, 0)
  })

  it('session_activity is a routine PATCH keeping the online state, throttled within the window', async () => {
    const { sink, advance } = makeSink({ updateThrottleMs: 15_000 })
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(online())
    advance(16_000)
    let calls = scriptFetch([{ status: 200 }])
    assert.equal(await sink.send(activity()), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'PATCH')
    // Same-state activity inside the throttle window is suppressed.
    advance(1_000)
    calls = scriptFetch()
    assert.equal(await sink.send(activity()), true)
    assert.equal(calls.length, 0, 'throttled — no PATCH')
  })

  it('unmapped categories still no-op (parity guard unchanged)', async () => {
    const { sink } = makeSink()
    const calls = scriptFetch()
    assert.equal(await sink.send({ category: 'mystery', title: 't', body: 'b', data: {} }), true)
    assert.equal(calls.length, 0)
  })
})
