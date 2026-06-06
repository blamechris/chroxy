import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { settingsHandlers } from '../../src/handlers/settings-handlers.js'
import { createSpy } from '../test-helpers.js'

/**
 * Tests for the BYOK credentials WS handlers (#4052):
 *   - byok_get_credentials_status
 *   - byok_set_credentials
 *   - byok_clear_credentials
 *
 * Each test points HOME at a tmpdir so the real ~/.chroxy/credentials.json
 * is never touched.
 */

function makeCtx() {
  const sent = []
  return {
    send: createSpy((_ws, msg) => { sent.push(msg) }),
    broadcast: createSpy(() => {}),
    _sent: sent,
  }
}

function makeWs() {
  const messages = []
  return {
    readyState: 1,
    send: createSpy((raw) => { messages.push(JSON.parse(raw)) }),
    _messages: messages,
  }
}

describe('byok credentials handlers (#4052)', () => {
  let tmpHome
  let originalHome
  let originalApiKey

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-byok-cred-handler-'))
    originalHome = process.env.HOME
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = tmpHome
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(tmpHome, { recursive: true, force: true })
  })

  describe('byok_get_credentials_status', () => {
    it('reports missing when no key configured', () => {
      const ctx = makeCtx()
      settingsHandlers.byok_get_credentials_status(makeWs(), { id: 'c1' }, { requestId: 'r1' }, ctx)
      const payload = ctx._sent[0]
      assert.equal(payload.type, 'byok_credentials_status')
      assert.equal(payload.requestId, 'r1')
      assert.equal(payload.status, 'missing')
      assert.equal(payload.source, 'none')
    })

    it('reports set/env when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + 'a'.repeat(95)
      const ctx = makeCtx()
      settingsHandlers.byok_get_credentials_status(makeWs(), { id: 'c1' }, { requestId: 'r1' }, ctx)
      const payload = ctx._sent[0]
      assert.equal(payload.status, 'set')
      assert.equal(payload.source, 'env')
      assert.match(payload.masked, /^sk-ant-api03/)
      assert.equal(payload.masked.includes(process.env.ANTHROPIC_API_KEY.slice(15)), false,
        'full key must never appear in WS payload')
    })
  })

  const isPosix = process.platform !== 'win32'

  describe('byok_set_credentials', () => {
    it('writes the key with mode 0600 and returns set/file status', () => {
      const longKey = 'sk-ant-api03-' + 'b'.repeat(95)
      const ctx = makeCtx()
      settingsHandlers.byok_set_credentials(makeWs(), { id: 'c1' }, { requestId: 'r1', anthropicApiKey: longKey }, ctx)
      const credPath = join(tmpHome, '.chroxy', 'credentials.json')
      assert.ok(existsSync(credPath))
      if (isPosix) {
        assert.equal(statSync(credPath).mode & 0o777, 0o600)
      }

      const payload = ctx._sent[0]
      assert.equal(payload.type, 'byok_credentials_status')
      assert.equal(payload.status, 'set')
      assert.equal(payload.source, 'file')
      assert.match(payload.masked, /^sk-ant-api03/)
      // Belt and suspenders: payload must not echo the full key anywhere.
      assert.equal(JSON.stringify(payload).includes(longKey), false)
    })

    it('rejects missing key with INVALID_REQUEST', () => {
      const ctx = makeCtx()
      const ws = makeWs()
      settingsHandlers.byok_set_credentials(ws, { id: 'c1' }, { requestId: 'r1' }, ctx)
      const err = ws._messages.find((m) => m.type === 'error')
      assert.ok(err, 'expected an error reply')
      assert.equal(err.code, 'INVALID_REQUEST')
    })

    it('rejects empty string key', () => {
      const ctx = makeCtx()
      const ws = makeWs()
      settingsHandlers.byok_set_credentials(ws, { id: 'c1' }, { requestId: 'r1', anthropicApiKey: '' }, ctx)
      const err = ws._messages.find((m) => m.type === 'error')
      assert.ok(err)
    })

    it('rejects keys that do not start with sk-ant-', () => {
      const ctx = makeCtx()
      const ws = makeWs()
      settingsHandlers.byok_set_credentials(ws, { id: 'c1' }, { requestId: 'r1', anthropicApiKey: 'sk-openai-12345' }, ctx)
      const err = ws._messages.find((m) => m.type === 'error')
      assert.ok(err)
      assert.equal(err.code, 'INVALID_REQUEST')
      assert.match(err.message, /sk-ant-/)
      assert.equal(existsSync(join(tmpHome, '.chroxy', 'credentials.json')), false)
    })
  })

  describe('byok_set_credentials trim + broadcast (review #4140)', () => {
    it('trims surrounding whitespace before persisting (review #4143)', () => {
      const longKey = 'sk-ant-api03-' + 'f'.repeat(95)
      const ctx = makeCtx()
      settingsHandlers.byok_set_credentials(
        makeWs(),
        { id: 'c1' },
        { requestId: 'r1', anthropicApiKey: `  ${longKey}\n` },
        ctx,
      )
      // The reply should be a success status, not an error.
      const reply = ctx._sent.find((m) => m.type === 'byok_credentials_status')
      assert.ok(reply, 'expected a success status reply')
      assert.equal(reply.status, 'set')
    })

    it('broadcasts the new status to all clients on set (review #4142)', () => {
      const longKey = 'sk-ant-api03-' + 'g'.repeat(95)
      const broadcasts = []
      const ctx = makeCtx()
      ctx.broadcast = (msg) => { broadcasts.push(msg) }
      settingsHandlers.byok_set_credentials(
        makeWs(),
        { id: 'c1' },
        { requestId: 'r1', anthropicApiKey: longKey },
        ctx,
      )
      assert.equal(broadcasts.length, 1)
      assert.equal(broadcasts[0].type, 'byok_credentials_status')
      assert.equal(broadcasts[0].status, 'set')
      // Broadcasts don't carry requestId — they're not a reply to a specific call.
      assert.equal(broadcasts[0].requestId, undefined)
    })

    it('broadcasts the new status to all clients on clear (review #4142)', () => {
      const longKey = 'sk-ant-api03-' + 'h'.repeat(95)
      settingsHandlers.byok_set_credentials(makeWs(), { id: 'c1' }, { anthropicApiKey: longKey }, makeCtx())

      const broadcasts = []
      const ctx = makeCtx()
      ctx.broadcast = (msg) => { broadcasts.push(msg) }
      settingsHandlers.byok_clear_credentials(makeWs(), { id: 'c1' }, { requestId: 'r2' }, ctx)
      assert.equal(broadcasts.length, 1)
      assert.equal(broadcasts[0].status, 'missing')
    })
  })

  describe('byok_clear_credentials', () => {
    it('removes the credentials file and returns missing status', () => {
      // Seed via set, then clear.
      const longKey = 'sk-ant-api03-' + 'c'.repeat(95)
      settingsHandlers.byok_set_credentials(makeWs(), { id: 'c1' }, { anthropicApiKey: longKey }, makeCtx())
      const credPath = join(tmpHome, '.chroxy', 'credentials.json')
      assert.ok(existsSync(credPath), 'precondition: file exists after set')

      const ctx = makeCtx()
      settingsHandlers.byok_clear_credentials(makeWs(), { id: 'c1' }, { requestId: 'r2' }, ctx)
      assert.equal(existsSync(credPath), false, 'file must be removed')
      const payload = ctx._sent[0]
      assert.equal(payload.type, 'byok_credentials_status')
      assert.equal(payload.requestId, 'r2')
      assert.equal(payload.status, 'missing')
    })

    it('is a no-op when no key exists', () => {
      const ctx = makeCtx()
      settingsHandlers.byok_clear_credentials(makeWs(), { id: 'c1' }, { requestId: 'r3' }, ctx)
      assert.equal(ctx._sent[0].status, 'missing')
    })
  })

  describe('security boundaries', () => {
    it('never includes the raw key in the wire payload from set', () => {
      const longKey = 'sk-ant-api03-' + 'd'.repeat(95)
      const ctx = makeCtx()
      settingsHandlers.byok_set_credentials(makeWs(), { id: 'c1' }, { requestId: 'r4', anthropicApiKey: longKey }, ctx)
      for (const sent of ctx._sent) {
        assert.equal(JSON.stringify(sent).includes(longKey), false,
          'raw key leaked into a WS payload')
      }
    })

    it('never includes the raw key in the wire payload from status (env source)', () => {
      const longKey = 'sk-ant-api03-' + 'e'.repeat(95)
      process.env.ANTHROPIC_API_KEY = longKey
      const ctx = makeCtx()
      settingsHandlers.byok_get_credentials_status(makeWs(), { id: 'c1' }, { requestId: 'r5' }, ctx)
      for (const sent of ctx._sent) {
        assert.equal(JSON.stringify(sent).includes(longKey), false,
          'raw key leaked into a WS payload')
      }
    })
  })

  // #5155: BYOK credential WRITES require host-level authority. A pairing-bound
  // session token (client.boundSessionId set) can READ masked status but must
  // NOT be able to set or clear the operator's key.
  describe('#5155 bound-client write gate', () => {
    const boundClient = { id: 'c-bound', boundSessionId: 'sess-1' }
    const credPath = () => join(tmpHome, '.chroxy', 'credentials.json')

    it('rejects byok_set_credentials from a pairing-bound client and writes nothing', () => {
      const longKey = 'sk-ant-api03-' + 'f'.repeat(95)
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.byok_set_credentials(ws, boundClient, { requestId: 'rb1', anthropicApiKey: longKey }, ctx)
      const reply = ws._messages[0]
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'CREDENTIAL_WRITE_FORBIDDEN_BOUND_CLIENT')
      assert.equal(reply.requestId, 'rb1')
      assert.equal(existsSync(credPath()), false, 'no credentials file written')
      assert.equal(ctx.broadcast.calls.length, 0)
    })

    it('rejects byok_clear_credentials from a pairing-bound client and leaves the file intact', () => {
      // Seed via an unbound (primary) client.
      const longKey = 'sk-ant-api03-' + 'g'.repeat(95)
      settingsHandlers.byok_set_credentials(makeWs(), { id: 'c-primary' }, { anthropicApiKey: longKey }, makeCtx())
      assert.ok(existsSync(credPath()), 'precondition: file exists after set')

      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.byok_clear_credentials(ws, boundClient, { requestId: 'rb2' }, ctx)
      const reply = ws._messages[0]
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'CREDENTIAL_WRITE_FORBIDDEN_BOUND_CLIENT')
      assert.ok(existsSync(credPath()), 'credentials file must survive a rejected clear')
    })

    it('still allows a pairing-bound client to READ status', () => {
      const ctx = makeCtx()
      settingsHandlers.byok_get_credentials_status(makeWs(), boundClient, { requestId: 'rb3' }, ctx)
      assert.equal(ctx._sent[0].type, 'byok_credentials_status')
    })
  })
})
