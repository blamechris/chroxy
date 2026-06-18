import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// -- Discord pairing-link delivery (#5513, epic #5509) --
//
// A one-off webhook POST of the approval-gated chroxy:// pairing link. NOT the
// per-project status embed (no state machine, no message id tracking). The
// webhook URL is a secret — never logged, never returned in any error/result.
describe('discord-pair-delivery (#5513)', () => {
  let mod
  let savedEnv

  beforeEach(async () => {
    mod = await import('../src/discord-pair-delivery.js')
    savedEnv = process.env.CHROXY_DISCORD_WEBHOOK_URL
  })

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CHROXY_DISCORD_WEBHOOK_URL
    else process.env.CHROXY_DISCORD_WEBHOOK_URL = savedEnv
  })

  const validWebhook = 'https://discord.com/api/webhooks/123456789/abcDEF_token-xyz'

  it('buildPairLinkMessage produces minimal text — link + expiry + approval note, no token material', () => {
    const msg = mod.buildPairLinkMessage({
      url: 'chroxy://host.example?pair=ABCD2345',
      expiresInSeconds: 60,
    })
    assert.ok(typeof msg.content === 'string')
    assert.ok(msg.content.includes('chroxy://host.example?pair=ABCD2345'), 'carries the chroxy:// link')
    assert.match(msg.content, /60s|60 s|expires/i)
    assert.match(msg.content, /approv/i, 'states host approval is required')
    // No embed state-machine fields — a plain content post.
    assert.equal(msg.embeds, undefined)
  })

  it('returns posted:false with reason not_configured when no webhook is set', async () => {
    delete process.env.CHROXY_DISCORD_WEBHOOK_URL
    const out = await mod.postPairLinkToDiscord(
      { url: 'chroxy://h?pair=X', expiresInSeconds: 60 },
      { resolveWebhookUrl: () => ({ url: null, source: 'none' }) },
    )
    assert.equal(out.posted, false)
    assert.equal(out.reason, 'not_configured')
  })

  it('POSTs to the webhook execute endpoint and resolves posted:true on 2xx', async () => {
    let captured = null
    const fakeFetch = async (url, opts) => {
      captured = { url, opts }
      return { ok: true, status: 204 }
    }
    const out = await mod.postPairLinkToDiscord(
      { url: 'chroxy://host?pair=CODE2345', expiresInSeconds: 45 },
      { resolveWebhookUrl: () => ({ url: validWebhook, source: 'env' }), fetchFn: fakeFetch },
    )
    assert.equal(out.posted, true)
    assert.equal(out.expiresInSeconds, 45)
    // Hits the discord webhook execute endpoint built from id/token.
    assert.ok(captured.url.startsWith('https://discord.com/api/webhooks/123456789/abcDEF_token-xyz'))
    assert.equal(captured.opts.method, 'POST')
    const body = JSON.parse(captured.opts.body)
    assert.ok(body.content.includes('chroxy://host?pair=CODE2345'))
  })

  it('resolves posted:false reason post_failed on a non-2xx response', async () => {
    const fakeFetch = async () => ({ ok: false, status: 400 })
    const out = await mod.postPairLinkToDiscord(
      { url: 'chroxy://h?pair=X', expiresInSeconds: 60 },
      { resolveWebhookUrl: () => ({ url: validWebhook, source: 'env' }), fetchFn: fakeFetch },
    )
    assert.equal(out.posted, false)
    assert.equal(out.reason, 'post_failed')
  })

  it('never includes the webhook URL or token in the result on failure', async () => {
    const fakeFetch = async () => { throw new Error(`connect ${validWebhook} refused`) }
    const out = await mod.postPairLinkToDiscord(
      { url: 'chroxy://h?pair=X', expiresInSeconds: 60 },
      { resolveWebhookUrl: () => ({ url: validWebhook, source: 'env' }), fetchFn: fakeFetch },
    )
    assert.equal(out.posted, false)
    const serialized = JSON.stringify(out)
    assert.ok(!serialized.includes('abcDEF_token-xyz'), 'token must never leak into the result')
    assert.ok(!serialized.includes(validWebhook), 'full webhook URL must never leak into the result')
  })

  it('rejects a missing/invalid pairing url with reason invalid', async () => {
    const out = await mod.postPairLinkToDiscord(
      { url: null, expiresInSeconds: 60 },
      { resolveWebhookUrl: () => ({ url: validWebhook, source: 'env' }) },
    )
    assert.equal(out.posted, false)
    assert.equal(out.reason, 'invalid')
  })
})
