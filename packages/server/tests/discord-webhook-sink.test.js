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
  cachedResolveDiscordWebhookUrl,
  isValidDiscordWebhookUrl,
  extractWebhookIdToken,
  maskWebhookUrl,
} from '../src/discord-credentials.js'
import { redactSensitive } from '../src/logger.js'
import { _setCredentialKeychainForTests } from '../src/credential-store.js'
import { encryptJson, getOrCreateMasterKey } from '../src/credential-cipher.js'
import { resetCachesForTest } from '../src/auth-probes.js'
import { SinkRegistry } from '../src/notifications/sink-registry.js'
import { PushManager } from '../src/push.js'
import { validateConfig } from '../src/config.js'

const WEBHOOK_ID = '123456789012345678'
const WEBHOOK_TOKEN = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789_abcdefghijklmnopqrstuvwx'
const WEBHOOK = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`
const API_BASE = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`

// In-memory keychain fake — drives the #5154 encrypted path deterministically
// without touching the host's real OS keychain (suite default is no-keychain).
function inMemoryKeychain() {
  const store = new Map()
  return {
    isKeychainAvailable: () => true,
    getToken: (service) => store.get(service) ?? null,
    setToken: (token, service) => { store.set(service, token) },
    _store: store,
  }
}

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

  // #5523 review: a non-ENOENT stat failure (EACCES/EPERM) must surface the
  // real error, NOT be misreported as "does not exist". readStore() returns such
  // failures as { fileExists:false, error:'unable to stat …' }, so the resolver
  // must consult `error` before the missing-file branch. We force EACCES by
  // making the parent `.chroxy` dir non-traversable. chmod is a no-op for root,
  // so skip there.
  it('non-ENOENT stat failure (EACCES) surfaces the real error, not "does not exist" (#5523)', () => {
    if (process.getuid && process.getuid() === 0) return // root bypasses dir perms
    const home = mkdtempSync(join(tmpdir(), 'discord-home-'))
    process.env.HOME = home
    const dir = join(home, '.chroxy')
    const file = join(dir, 'credentials.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ discordWebhookUrl: WEBHOOK }), { mode: 0o600 })
    chmodSync(file, 0o600)
    // Drop traverse on the parent dir → statSync(file) fails with EACCES.
    chmodSync(dir, 0o000)
    try {
      const r = resolveDiscordWebhookUrl()
      assert.equal(r.url, null)
      assert.equal(r.source, 'none')
      // The real reason must surface (stat error), never the misleading
      // "does not exist", and never the URL/token.
      assert.match(r.reason, /unable to stat/)
      assert.doesNotMatch(r.reason, /does not exist/)
      assert.ok(!r.reason.includes(WEBHOOK_TOKEN), 'reason must not echo the webhook token')
    } finally {
      // Restore so the temp dir is removable / harness cleanup succeeds.
      chmodSync(dir, 0o700)
    }
  })

  it('missing-field reason is value-free and stable on a plaintext file', () => {
    const home = mkdtempSync(join(tmpdir(), 'discord-home-'))
    process.env.HOME = home
    const dir = join(home, '.chroxy')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'credentials.json')
    // A credentials.json carrying only an API key — no webhook URL.
    writeFileSync(file, JSON.stringify({ anthropicApiKey: 'sk-ant-xyz' }), { mode: 0o600 })
    chmodSync(file, 0o600)
    const r = resolveDiscordWebhookUrl()
    assert.equal(r.url, null)
    assert.equal(r.source, 'none')
    assert.match(r.reason, /missing or empty "discordWebhookUrl"/)
  })

  // #5490: the #5154 at-rest encryption rewrites credentials.json into the
  // cipher envelope on first daemon start. A plain JSON.parse finds no
  // `discordWebhookUrl` key in the envelope, so the sink silently goes
  // unconfigured. The resolver must decrypt via the keychain-backed key.
  it('reads discordWebhookUrl from an ENCRYPTED credentials.json (#5490)', () => {
    const home = mkdtempSync(join(tmpdir(), 'discord-home-'))
    process.env.HOME = home
    const dir = join(home, '.chroxy')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'credentials.json')

    // Drive the encrypted branch with an in-memory keychain (the suite default
    // is no-keychain → plaintext). Mint/fetch the data key the same way the
    // store does, encrypt the plaintext blob, and write the envelope at 0600 —
    // exactly what maybeEncryptCredentialsAtRest() produces at startup.
    const keychain = inMemoryKeychain()
    _setCredentialKeychainForTests(keychain)
    resetCachesForTest()
    try {
      const key = getOrCreateMasterKey(keychain)
      const envelope = encryptJson({ discordWebhookUrl: WEBHOOK }, key)
      // Sanity: the secret must not be present in the on-disk envelope.
      const serialized = JSON.stringify(envelope)
      assert.ok(!serialized.includes(WEBHOOK_TOKEN), 'token must not appear in the envelope')
      writeFileSync(file, serialized, { mode: 0o600 })
      chmodSync(file, 0o600)

      const r = resolveDiscordWebhookUrl()
      assert.equal(r.source, 'file')
      assert.equal(r.url, WEBHOOK)
    } finally {
      _setCredentialKeychainForTests(null)
      resetCachesForTest()
    }
  })

  it('encrypted file + unavailable keychain → none with a value-free reason (#5490)', () => {
    const home = mkdtempSync(join(tmpdir(), 'discord-home-'))
    process.env.HOME = home
    const dir = join(home, '.chroxy')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'credentials.json')

    // Encrypt under a real key, then drop the keychain so the read can't fetch
    // the data key (locked keychain / headless host). Must fail closed to
    // source:'none' with a reason that never echoes the URL.
    const keychain = inMemoryKeychain()
    _setCredentialKeychainForTests(keychain)
    resetCachesForTest()
    try {
      const key = getOrCreateMasterKey(keychain)
      const envelope = encryptJson({ discordWebhookUrl: WEBHOOK }, key)
      writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 })
      chmodSync(file, 0o600)

      // Swap to a keychain that reports unavailable → getMasterKey returns null.
      _setCredentialKeychainForTests({ isKeychainAvailable: () => false })
      const r = resolveDiscordWebhookUrl()
      assert.equal(r.source, 'none')
      assert.equal(r.url, null)
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
      assert.ok(!r.reason.includes(WEBHOOK_TOKEN), 'reason must not echo the webhook token')
    } finally {
      _setCredentialKeychainForTests(null)
      resetCachesForTest()
    }
  })

  it('cachedResolveDiscordWebhookUrl composes with decryption (#5490)', () => {
    const home = mkdtempSync(join(tmpdir(), 'discord-home-'))
    process.env.HOME = home
    const dir = join(home, '.chroxy')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'credentials.json')

    const keychain = inMemoryKeychain()
    _setCredentialKeychainForTests(keychain)
    resetCachesForTest()
    try {
      const key = getOrCreateMasterKey(keychain)
      const envelope = encryptJson({ discordWebhookUrl: WEBHOOK }, key)
      writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 })
      chmodSync(file, 0o600)

      // First (cold) call decrypts; second (cached) call must return the same.
      const first = cachedResolveDiscordWebhookUrl()
      assert.equal(first.source, 'file')
      assert.equal(first.url, WEBHOOK)
      const second = cachedResolveDiscordWebhookUrl()
      assert.equal(second.source, 'file')
      assert.equal(second.url, WEBHOOK)
    } finally {
      _setCredentialKeychainForTests(null)
      resetCachesForTest()
    }
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

  it('escapes Discord markdown metacharacters in free-text fields (#5475)', async () => {
    // A transcript task description like `watch dist/*_test.js` would otherwise
    // render with the *…* / _…_ runs styled as italics, swallowing characters.
    // Body (Status), detail (Detail), and sessionName (Session) are all
    // free-text and must surface literally.
    const calls = scriptFetch()
    const { sink } = makeSink()
    await sink.send({
      ...idle({
        detail: 'tool ~strike~ and `code`',
        sessionName: 'proj_*beta*',
      }),
      body: 'watch dist/*_test.js | grep ~done~ > log',
    })
    const embed = JSON.parse(calls[0].body).embeds[0]

    const status = embed.fields.find((f) => f.name === 'Status').value
    assert.equal(status, 'watch dist/\\*\\_test.js \\| grep \\~done\\~ \\> log')
    // Every metacharacter is backslash-escaped — none survive un-escaped.
    assert.ok(!/(^|[^\\])[*_~`|>]/.test(status), 'no un-escaped metachar in Status')

    const detail = embed.fields.find((f) => f.name === 'Detail').value
    assert.equal(detail, 'tool \\~strike\\~ and \\`code\\`')

    const session = embed.fields.find((f) => f.name === 'Session').value
    assert.equal(session, 'proj\\_\\*beta\\*')
  })

  it('escapes a literal backslash before inserting markdown escapes (#5475)', async () => {
    // Backslash must be escaped first so a body of `a\*b` becomes `a\\\*b`
    // (escaped backslash + escaped star), not `a\\*b` (which Discord would
    // read as an escaped backslash followed by an un-escaped star).
    const calls = scriptFetch()
    const { sink } = makeSink()
    await sink.send({ ...idle(), body: 'a\\*b' })
    const status = JSON.parse(calls[0].body).embeds[0].fields.find((f) => f.name === 'Status').value
    assert.equal(status, 'a\\\\\\*b')
  })

  it('caps the FINAL escaped field at the truncate limit for all-metachar input (#5475)', async () => {
    // Escaping after truncation can ~double the length (each metachar → `\X`).
    // An all-metachar body must NOT push the escaped value past Discord's
    // 1024-char field limit, or the webhook PATCH/POST is rejected with a 400.
    const calls = scriptFetch()
    const { sink } = makeSink()
    await sink.send({
      ...idle({
        detail: '*'.repeat(1500),
        sessionName: '~'.repeat(500),
      }),
      body: '*'.repeat(2000),
    })
    const embed = JSON.parse(calls[0].body).embeds[0]

    for (const [name, cap] of [['Status', 1000], ['Detail', 1000], ['Session', 100]]) {
      const value = embed.fields.find((f) => f.name === name).value
      assert.ok(value.length <= cap, `${name} (${value.length}) within ${cap}-char cap`)
      // Well-formed: never ends on a lone (odd-run) escape backslash.
      const trailing = value.length - value.replace(/\\+$/, '').length
      assert.equal(trailing % 2, 0, `${name} must not end in a dangling escape backslash`)
      // And the body really was all-metachar → every kept char is part of a
      // `\X` pair, so the escaped value is purely backslashes + metachars.
      assert.ok(/^(\\[*~])+$/.test(value), `${name} is well-formed escaped metachars`)
    }
  })

  it('does not re-truncate a normal-length metachar body (#5475)', async () => {
    // A realistic free-text body stays under the cap even after escaping, so
    // escapeAndCap is a no-op clamp and the escaping is byte-for-byte correct.
    const calls = scriptFetch()
    const { sink } = makeSink()
    await sink.send({ ...idle(), body: 'watch dist/*_test.js | grep ~done~ > log' })
    const status = JSON.parse(calls[0].body).embeds[0].fields.find((f) => f.name === 'Status').value
    assert.equal(status, 'watch dist/\\*\\_test.js \\| grep \\~done\\~ \\> log')
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
          pruneAfterMs: 86400000,
        },
      },
    })
    assert.equal(result.valid, true, JSON.stringify(result.warnings))
  })

  it('warns on an invalid pruneAfterMs (value warning, never fatal)', () => {
    const result = validateConfig({ notifications: { discord: { pruneAfterMs: -1 } } })
    assert.ok(result.warnings.some((w) => w.includes('pruneAfterMs')))
    assert.ok(!result.warnings.some((w) => w.startsWith('Invalid type')))
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

  // #5457: a tiny retention prunes the entry (and its messageId) between
  // consecutive events — every event then POSTs a brand-new message instead
  // of PATCHing in place. Same non-fatal warning as the heartbeat floor.
  it('warns on a too-small pruneAfterMs (value warning, never fatal) (#5457)', () => {
    const result = validateConfig({ notifications: { discord: { pruneAfterMs: 5_000 } } })
    assert.ok(result.warnings.some((w) => w.includes('pruneAfterMs') && w.includes('60000')))
    assert.ok(!result.warnings.some((w) => w.startsWith('Invalid type')))
  })

  it('does not warn on pruneAfterMs at the floor or at 0 (disable)', () => {
    for (const v of [0, 60_000, 86_400_000]) {
      const result = validateConfig({ notifications: { discord: { pruneAfterMs: v } } })
      assert.ok(!result.warnings.some((w) => w.includes('pruneAfterMs')), `unexpected warning for ${v}: ${JSON.stringify(result.warnings)}`)
    }
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

// #5439 GAP C — subagent/idle interplay (port of claude-notify.sh:528-539
// and :383-384). While the user is being waited on (idle / permission embed)
// with subagents still running, routine session_activity must NOT flip the
// embed back to 🟢 "Session Online"; and when the LAST subagent finishes
// while the embed sits idle, the sink re-pings 🦀 "Ready for input" (the
// bash idle_busy → idle repost on count→0).
describe('DiscordWebhookSink — subagent/idle interplay (#5439 GAP C)', () => {
  const online = (data = {}) => ({
    category: 'session_online',
    title: 'Session online',
    body: 'External session started',
    data: { project: 'proj1', ...data },
  })
  const activity = (data = {}) => ({
    category: 'session_activity',
    title: 'Subagent finished',
    body: 'A subagent completed',
    data: { project: 'proj1', ...data },
  })
  const ready = (data = {}) => ({
    category: 'activity_update',
    title: 'Ready for input',
    body: 'Claude is waiting for input',
    data: { project: 'proj1', ...data },
  })
  const approval = (data = {}) => ({
    category: 'activity_waiting',
    title: 'Input needed',
    body: 'Claude is waiting',
    data: { project: 'proj1', ...data },
  })

  /** online (m1) → idle ping with running subagents (DELETE m1 + POST m2). */
  async function seedWaitingWithSubagents(sink, advance, state = 'idle') {
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(online())
    advance(16_000)
    scriptFetch([{ status: 204 }, { status: 200, body: { id: 'm2' } }])
    await sink.send(state === 'idle' ? ready({ subagents: 2 }) : approval({ subagents: 2 }))
    advance(16_000)
  }

  it('session_activity does NOT flip an idle embed back online while subagents are running', async () => {
    const { sink, statePath, advance } = makeSink()
    await seedWaitingWithSubagents(sink, advance, 'idle')
    const calls = scriptFetch([{ status: 200 }])
    assert.equal(await sink.send(activity({ subagents: 2 })), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'PATCH', 'count refresh PATCHes in place — no ping')
    assert.ok(calls[0].url.endsWith('/messages/m2'))
    const embed = JSON.parse(calls[0].body).embeds[0]
    assert.match(embed.title, /Ready for input/, 'embed keeps the waiting title')
    assert.ok(embed.fields.some((f) => f.name === 'Subagents' && f.value === '2'))
    const st = readState(statePath).projects.proj1
    assert.equal(st.state, 'idle', 'stored state stays idle')
  })

  it('session_activity does NOT flip a permission embed back online while subagents are running', async () => {
    const { sink, statePath, advance } = makeSink()
    await seedWaitingWithSubagents(sink, advance, 'permission')
    const calls = scriptFetch([{ status: 200 }])
    assert.equal(await sink.send(activity({ subagents: 1 })), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'PATCH')
    assert.match(JSON.parse(calls[0].body).embeds[0].title, /Needs Approval/)
    assert.equal(readState(statePath).projects.proj1.state, 'permission')
  })

  it('the demoted count refresh keeps the waiting body, not the activity text', async () => {
    const { sink, advance } = makeSink()
    await seedWaitingWithSubagents(sink, advance, 'idle')
    const calls = scriptFetch([{ status: 200 }])
    await sink.send(activity({ subagents: 1 }))
    const embed = JSON.parse(calls[0].body).embeds[0]
    assert.ok(
      embed.fields.some((f) => f.name === 'Status' && f.value === 'Claude is waiting for input'),
      'Status field keeps the waiting text'
    )
  })

  it('count→0 while idle re-pings Ready for input (DELETE + POST — bash :383-384)', async () => {
    const { sink, statePath, advance } = makeSink()
    await seedWaitingWithSubagents(sink, advance, 'idle')
    const calls = scriptFetch([
      { status: 204 },                       // DELETE m2
      { status: 200, body: { id: 'm3' } },   // fresh POST pings
    ])
    assert.equal(await sink.send(activity({ subagents: 0 })), true)
    assert.deepEqual(calls.map((c) => c.method), ['DELETE', 'POST'])
    assert.ok(calls[0].url.endsWith('/messages/m2'))
    const embed = JSON.parse(calls[1].body).embeds[0]
    assert.match(embed.title, /Ready for input/)
    const st = readState(statePath).projects.proj1
    assert.equal(st.state, 'idle')
    assert.equal(st.messageId, 'm3')
    assert.equal(st.subagents, 0)
  })

  it('count→0 while permission falls through to online (row-20 intentional diff, no false ready ping)', async () => {
    const { sink, statePath, advance } = makeSink()
    await seedWaitingWithSubagents(sink, advance, 'permission')
    const calls = scriptFetch([{ status: 200 }])
    assert.equal(await sink.send(activity({ subagents: 0 })), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'PATCH', 'no ping — permission clears to online on next activity')
    assert.match(JSON.parse(calls[0].body).embeds[0].title, /Session Online/)
    assert.equal(readState(statePath).projects.proj1.state, 'online')
  })

  it('an idle embed with NO subagents still wakes to online on session_activity (guard scoped to live counts)', async () => {
    const { sink, statePath, advance } = makeSink()
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(online())
    advance(16_000)
    scriptFetch([{ status: 204 }, { status: 200, body: { id: 'm2' } }])
    await sink.send(ready()) // plain idle, no subagents
    advance(16_000)
    const calls = scriptFetch([{ status: 200 }])
    assert.equal(await sink.send(activity({ subagents: 0 })), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'PATCH')
    assert.match(JSON.parse(calls[0].body).embeds[0].title, /Session Online/)
    assert.equal(readState(statePath).projects.proj1.state, 'online')
  })

  it('demoted count refreshes are still throttled inside the window', async () => {
    const { sink, advance } = makeSink({ updateThrottleMs: 15_000 })
    await seedWaitingWithSubagents(sink, advance, 'idle')
    scriptFetch([{ status: 200 }])
    await sink.send(activity({ subagents: 2 }))
    advance(1_000) // inside the window
    const calls = scriptFetch()
    assert.equal(await sink.send(activity({ subagents: 2 })), true)
    assert.equal(calls.length, 0, 'same-state count refresh throttled')
  })
})

// #5439 GAP D — SessionEnd 404 orphan (port of bash no_post_on_404). When
// the tracked message was deleted externally, marking the session offline
// must NOT POST a fresh offline embed — drop the messageId and move on.
describe('DiscordWebhookSink — offline 404 leaves no orphan (#5439 GAP D)', () => {
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

  it('a 404 on the offline PATCH drops the messageId without POSTing an orphan', async () => {
    const { sink, statePath, advance } = makeSink()
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(online())
    advance(60_000)
    const calls = scriptFetch([{ status: 404 }])
    assert.equal(await sink.send(offline()), true)
    assert.equal(calls.length, 1, 'no healing POST after the 404')
    assert.equal(calls[0].method, 'PATCH')
    const st = readState(statePath).projects.proj1
    assert.equal(st.messageId, null, 'tracking dropped')
    assert.equal(st.state, 'offline')
  })

  it('after the 404-drop, the next session_online POSTs fresh with no DELETE', async () => {
    const { sink, statePath, advance } = makeSink()
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(online())
    advance(60_000)
    scriptFetch([{ status: 404 }])
    await sink.send(offline())
    advance(60_000)
    const calls = scriptFetch([{ status: 200, body: { id: 'm2' } }])
    assert.equal(await sink.send(online()), true)
    assert.deepEqual(calls.map((c) => c.method), ['POST'], 'nothing tracked → no DELETE')
    assert.equal(readState(statePath).projects.proj1.messageId, 'm2')
  })

  it('a NON-offline PATCH 404 still self-heals by POSTing (regression guard)', async () => {
    const { sink, statePath } = makeSink()
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(idle())
    const calls = scriptFetch([
      { status: 404 },                     // PATCH 404 (message gone)
      { status: 200, body: { id: 'm2' } }, // healing POST
    ])
    assert.equal(await sink.send(errored()), true)
    assert.deepEqual(calls.map((c) => c.method), ['PATCH', 'POST'])
    assert.equal(readState(statePath).projects.alpha.messageId, 'm2')
  })
})

// #5429 / #5434 — stale-entry pruning. Entries in discord-webhook-state.json
// accumulated forever (one per project key / session id), and the heartbeat
// PATCHed every tracked entry — including final `offline` embeds —
// indefinitely. Pins:
//   - the heartbeat skips offline entries (the offline embed is final)
//   - entries untouched longer than `pruneAfterMs` are dropped at load time
//     (the startup sweep is the first load after init) and the pruned store
//     persists via the same atomic 0600 path
//   - the Discord message is KEPT (no DELETE) — only the tracking stops
//   - retention is configurable; 0 disables; fresh entries are untouched
describe('DiscordWebhookSink — stale-entry pruning (#5429 / #5434)', () => {
  const DAY_MS = 86_400_000
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

  it('the heartbeat skips offline entries (the final embed is never re-PATCHed)', async () => {
    const { sink, advance } = makeSink()
    scriptFetch([
      { status: 200, body: { id: 'm-proj1' } }, // POST proj1 online
      { status: 200, body: { id: 'm-live' } },  // POST live online
      { status: 200 },                          // PATCH proj1 offline
    ])
    await sink.send(online())
    await sink.send(online({ project: 'live' }))
    advance(60_000)
    await sink.send(offline())
    const calls = scriptFetch()
    await sink._heartbeatTick()
    const patches = calls.filter((c) => c.method === 'PATCH')
    assert.equal(patches.length, 1, 'only the live project is refreshed')
    assert.ok(patches[0].url.endsWith('/messages/m-live'))
    assert.ok(!calls.some((c) => c.url.endsWith('/messages/m-proj1')), 'offline embed left alone')
  })

  it('an entry offline longer than the retention is pruned; the Discord message is kept (no DELETE)', async () => {
    const { sink, statePath, advance } = makeSink()
    scriptFetch([{ status: 200, body: { id: 'm1' } }, { status: 200 }])
    await sink.send(online())
    advance(60_000)
    await sink.send(offline())
    assert.equal(readState(statePath).projects.proj1.state, 'offline')
    advance(DAY_MS + 1)
    const calls = scriptFetch([{ status: 200, body: { id: 'm-beta' } }])
    await sink.send(idle({ sessionName: 'beta' }))
    const { projects } = readState(statePath)
    assert.equal(projects.proj1, undefined, 'offline entry pruned after the retention')
    assert.equal(projects.beta.messageId, 'm-beta', 'fresh entry tracked normally')
    assert.ok(!calls.some((c) => c.method === 'DELETE'), 'the final offline message is never deleted')
  })

  it('startup sweep: a new sink drops ancient and corrupt entries from a pre-existing state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-sink-'))
    const statePath = join(dir, 'state.json')
    const NOW = 200_000_000
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      projects: {
        ancient: { messageId: 'm-ancient', state: 'idle', lastUpdateTs: NOW - DAY_MS - 1, firstSeenTs: 1 },
        corrupt: { messageId: 'm-corrupt', state: 'idle' }, // no lastUpdateTs at all
        fresh: { messageId: 'm-fresh', state: 'online', lastUpdateTs: NOW - 10_000, firstSeenTs: NOW - 10_000 },
      },
    }))
    const sink = new DiscordWebhookSink({
      statePath,
      resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
      sleepImpl: async () => {},
      heartbeatIntervalMs: 0,
      now: () => NOW,
    })
    const calls = scriptFetch([{ status: 200 }])
    await sink._heartbeatTick()
    const { projects } = readState(statePath)
    assert.equal(projects.ancient, undefined, 'ancient entry swept')
    assert.equal(projects.corrupt, undefined, 'entry without a usable lastUpdateTs swept')
    assert.ok(projects.fresh, 'fresh entry survives the sweep')
    const patches = calls.filter((c) => c.method === 'PATCH')
    assert.equal(patches.length, 1, 'heartbeat work bounded to live entries')
    assert.ok(patches[0].url.endsWith('/messages/m-fresh'))
  })

  it('the retention is configurable via pruneAfterMs', async () => {
    const { sink, statePath, advance } = makeSink({ pruneAfterMs: 60_000 })
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(errored())
    advance(30_000)
    assert.ok(sink._loadState().projects.alpha, 'entry younger than the retention is untouched')
    advance(30_001)
    assert.equal(sink._loadState().projects.alpha, undefined, 'entry older than the custom retention pruned')
    assert.equal(readState(statePath).projects.alpha, undefined, 'pruned store persisted')
  })

  it('entries younger than the default 24h retention are untouched', async () => {
    const { sink, advance } = makeSink()
    scriptFetch([{ status: 200, body: { id: 'm1' } }, { status: 200 }])
    await sink.send(online())
    advance(60_000)
    await sink.send(offline())
    advance(DAY_MS - 120_000) // ~23h58m after the offline PATCH — inside retention
    assert.equal(sink._loadState().projects.proj1.state, 'offline', 'recent offline entry retained')
  })

  it('pruneAfterMs: 0 disables pruning entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-sink-'))
    const statePath = join(dir, 'state.json')
    const NOW = 200_000_000
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      projects: { ancient: { messageId: 'm1', state: 'idle', lastUpdateTs: NOW - 10 * DAY_MS } },
    }))
    const sink = new DiscordWebhookSink({
      statePath,
      resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
      sleepImpl: async () => {},
      heartbeatIntervalMs: 0,
      pruneAfterMs: 0,
      now: () => NOW,
    })
    assert.ok(sink._loadState().projects.ancient, 'nothing pruned when disabled')
  })

  it('an invalid pruneAfterMs falls back to the default retention', () => {
    const { sink } = makeSink({ pruneAfterMs: -5 })
    assert.equal(sink._pruneAfterMs, DAY_MS)
    const { sink: sink2 } = makeSink({ pruneAfterMs: 'soon' })
    assert.equal(sink2._pruneAfterMs, DAY_MS)
  })

  // #5457: a retention below the 60s floor prunes the entry between
  // consecutive events, breaking PATCH-in-place into message-per-event spam.
  // Clamp to the default (parity with the heartbeatIntervalMs clamp); 0
  // stays 0 — it is the documented disable.
  it('a too-small pruneAfterMs (0 < v < 60s) falls back to the default retention (#5457)', () => {
    const { sink } = makeSink({ pruneAfterMs: 5_000 })
    assert.equal(sink._pruneAfterMs, DAY_MS)
    const { sink: sink2 } = makeSink({ pruneAfterMs: 59_999 })
    assert.equal(sink2._pruneAfterMs, DAY_MS)
    const { sink: sink3 } = makeSink({ pruneAfterMs: 60_000 })
    assert.equal(sink3._pruneAfterMs, 60_000, 'the floor itself is accepted')
    const { sink: sink4 } = makeSink({ pruneAfterMs: 0 })
    assert.equal(sink4._pruneAfterMs, 0, '0 stays the documented disable')
  })

  it('a state file whose projects slot is an array is treated as corrupt (fresh map, tracking persists)', async () => {
    // typeof [] === 'object', but JSON.stringify drops string-keyed entries
    // assigned onto an array — accepting the array would wedge tracking
    // (every persist silently loses the messageId).
    const { sink, statePath } = makeSink()
    writeFileSync(statePath, JSON.stringify({ version: 1, projects: [] }))
    scriptFetch([{ status: 200, body: { id: 'm1' } }])
    await sink.send(errored())
    const { projects } = readState(statePath)
    assert.ok(!Array.isArray(projects), 'projects persists as a map, not an array')
    assert.equal(projects.alpha.messageId, 'm1', 'entry tracked despite the corrupt array slot')
  })
})
