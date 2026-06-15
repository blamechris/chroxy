// #5828: DiscordBillingSink — the daemon-global billing-alert message. Separate
// from the per-project status sink: one message, re-pinged on a changed warning
// set, repainted green on all-clear.
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiscordBillingSink } from '../src/notifications/discord-billing-sink.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'discord-billing-'))
  const statePath = join(dir, 'billing-state.json')
  const sink = new DiscordBillingSink({
    statePath,
    resolveWebhookUrl: () => ({ url: WEBHOOK, source: 'env' }),
    sleepImpl: async () => {},
    now: () => 1_700_000_000_000,
    ...overrides,
  })
  return { sink, dir, statePath }
}

const readState = (p) => JSON.parse(readFileSync(p, 'utf-8'))

const alert = (codes, body = 'something is metered') => ({
  category: 'billing_warning',
  title: 'Billing alert',
  body,
  data: { codes },
})
const cleared = () => ({
  category: 'billing_warning',
  title: 'Billing alert cleared',
  body: 'All billing warnings have cleared.',
  data: { resolved: true, codes: [] },
})

describe('DiscordBillingSink — configuration gating', () => {
  it('isConfigured() is false without a webhook URL', () => {
    const { sink } = makeSink({ resolveWebhookUrl: () => null })
    assert.equal(sink.isConfigured(), false)
  })

  it('isConfigured() is false when billingAlerts is disabled', () => {
    const { sink } = makeSink({ billingAlerts: false })
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

describe('DiscordBillingSink — delivery', () => {
  it('skips non-billing categories (status sink owns those)', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink()
    const ok = await sink.send({ category: 'activity_update', title: 't', body: 'b', data: {} })
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
  })

  it('no-op when unconfigured', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink({ resolveWebhookUrl: () => null })
    const ok = await sink.send(alert(['SILENT_METERED_DEFAULT']))
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
  })

  it('first alert POSTs a new message and persists id + signature', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink, statePath } = makeSink()
    const ok = await sink.send(alert(['SILENT_METERED_DEFAULT']))
    assert.equal(ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.match(calls[0].url, /\?wait=true$/)
    const st = readState(statePath)
    assert.equal(st.messageId, 'msg-1')
    assert.ok(st.warnSignature.includes('SILENT_METERED_DEFAULT'))
  })

  it('the same alert again is a no-op (dedup against double fan-out)', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(alert(['SILENT_METERED_DEFAULT']))
    const ok = await sink.send(alert(['SILENT_METERED_DEFAULT']))
    assert.equal(ok, true)
    assert.equal(calls.length, 1) // no second POST/PATCH
  })

  it('a changed warning set re-pings: DELETE old + POST new', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'msg-1' } }, // first POST
      { status: 200 },                         // DELETE old
      { status: 200, body: { id: 'msg-2' } }, // second POST
    ])
    const { sink, statePath } = makeSink()
    await sink.send(alert(['SILENT_METERED_DEFAULT']))
    const ok = await sink.send(alert(['SILENT_METERED_DEFAULT', 'DATACENTER_EGRESS'], 'metered + egress'))
    assert.equal(ok, true)
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'DELETE', 'POST'])
    assert.match(calls[1].url, /\/messages\/msg-1$/)
    assert.equal(readState(statePath).messageId, 'msg-2')
  })

  it('same codes but a changed message re-pings (new egress IP)', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'msg-1' } },
      { status: 200 },
      { status: 200, body: { id: 'msg-2' } },
    ])
    const { sink } = makeSink()
    await sink.send(alert(['DATACENTER_EGRESS'], 'egress 5.9.1.2'))
    await sink.send(alert(['DATACENTER_EGRESS'], 'egress 5.9.9.9'))
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'DELETE', 'POST'])
  })

  it('all-clear PATCHes the tracked message to resolved and clears the signature', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'msg-1' } }, // alert POST
      { status: 200 },                         // resolved PATCH
    ])
    const { sink, statePath } = makeSink()
    await sink.send(alert(['SILENT_METERED_DEFAULT']))
    const ok = await sink.send(cleared())
    assert.equal(ok, true)
    assert.equal(calls[1].method, 'PATCH')
    assert.match(calls[1].url, /\/messages\/msg-1$/)
    const st = readState(statePath)
    assert.equal(st.messageId, 'msg-1')
    assert.equal(st.warnSignature, null) // cleared → next warning re-pings
  })

  it('all-clear with nothing tracked is a silent no-op', async () => {
    const calls = scriptFetch()
    const { sink, statePath } = makeSink()
    const ok = await sink.send(cleared())
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
    assert.equal(existsSync(statePath), false) // never wrote state
  })

  it('a warning after a resolve re-pings even with identical codes', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'msg-1' } }, // alert POST
      { status: 200 },                         // resolved PATCH
      { status: 200 },                         // DELETE old on re-alert
      { status: 200, body: { id: 'msg-2' } }, // re-alert POST
    ])
    const { sink } = makeSink()
    await sink.send(alert(['SILENT_METERED_DEFAULT']))
    await sink.send(cleared())
    const ok = await sink.send(alert(['SILENT_METERED_DEFAULT']))
    assert.equal(ok, true)
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'PATCH', 'DELETE', 'POST'])
  })

  it('resolved PATCH on a 404 forgets the message (no healing POST)', async () => {
    const calls = scriptFetch([
      { status: 200, body: { id: 'msg-1' } }, // alert POST
      { status: 404 },                         // resolved PATCH — deleted externally
    ])
    const { sink, statePath } = makeSink()
    await sink.send(alert(['SILENT_METERED_DEFAULT']))
    const ok = await sink.send(cleared())
    assert.equal(ok, true)
    assert.equal(calls.length, 2) // no extra POST
    assert.equal(readState(statePath).messageId, null)
  })

  it('a hard POST failure resolves false', async () => {
    scriptFetch([{ status: 500 }, { status: 500 }, { status: 500 }])
    const { sink } = makeSink()
    const ok = await sink.send(alert(['SILENT_METERED_DEFAULT']))
    assert.equal(ok, false)
  })

  it('respects a globally muted billing_warning category', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink()
    const ok = await sink.send(alert(['SILENT_METERED_DEFAULT']), {
      isCategoryEnabled: () => false,
    })
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
  })

  it('respects quiet hours without a bypass', async () => {
    const calls = scriptFetch()
    const { sink } = makeSink()
    const ok = await sink.send(alert(['SILENT_METERED_DEFAULT']), {
      isInQuietHours: () => true,
      shouldBypassQuietHours: () => false,
    })
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
  })

  it('escapes markdown in the warning body', async () => {
    const calls = scriptFetch([{ status: 200, body: { id: 'msg-1' } }])
    const { sink } = makeSink()
    await sink.send(alert(['DATACENTER_EGRESS'], 'egress *5.9.1.2* via _cloud_'))
    const payload = JSON.parse(calls[0].body)
    const field = payload.embeds[0].fields.find((f) => f.name === 'Warnings')
    assert.ok(field.value.includes('\\*5.9.1.2\\*'))
    assert.ok(field.value.includes('\\_cloud\\_'))
  })
})
