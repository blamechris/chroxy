import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { getStoredCredential, setStoredCredential } from '../src/credential-store.js'

/**
 * #3855: WS handler tests for the Provider Credentials messages.
 *   - get_credentials_status: returns masked status, never a raw value
 *   - set_credential: persists at 0600, replies masked to requester, validates
 *   - delete_credential: removes the value, replies to requester (no broadcast)
 *   - test_credential: returns a result keyed by credential
 *
 * Auth gating note: these handlers are only dispatched after the WS layer sets
 * `client.authenticated` (ws-server.js); an unauthenticated connection never
 * reaches the settingsHandlers map. That gate is shared infrastructure covered
 * elsewhere — here we assert the per-message behaviour and that no plaintext
 * value is ever placed on the wire.
 */

const CRED_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY']

// sendError() writes directly to ws.send (JSON string), while success replies
// go via ctx.send (object). Capture both so a helper can return the latest of
// either path.
function makeWs() {
  return { readyState: 1, send: mock.fn() }
}

function makeCtx() {
  return { send: mock.fn(), broadcast: mock.fn() }
}

// The handlers send exactly one reply: success via ctx.send (object), error
// via ws.send (JSON string). Return whichever fired.
function lastReply(ws, ctx) {
  if (ws.send.mock.callCount() > 0) {
    return JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1].arguments[0])
  }
  if (ctx.send.mock.callCount() > 0) {
    return ctx.send.mock.calls[ctx.send.mock.calls.length - 1].arguments[1]
  }
  return null
}

describe('credential WS handlers (#3855)', () => {
  let tmpHome
  let originalHome
  const savedEnv = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-handlers-test-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    for (const k of CRED_ENV_VARS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    for (const k of CRED_ENV_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  describe('get_credentials_status', () => {
    it('replies with a credentials_status snapshot and never a raw value', () => {
      const raw = 'sk-ant-supersecret-value-000'
      setStoredCredential('ANTHROPIC_API_KEY', raw)
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.get_credentials_status(ws, {}, { type: 'get_credentials_status', requestId: 'r1' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'credentials_status')
      assert.equal(reply.requestId, 'r1')
      assert.ok(Array.isArray(reply.credentials))
      // No raw value anywhere in the reply.
      assert.equal(JSON.stringify(reply).includes(raw), false)
      const anth = reply.credentials.find((c) => c.key === 'ANTHROPIC_API_KEY')
      assert.equal(anth.status, 'set')
      assert.ok(anth.masked)
    })
  })

  describe('set_credential', () => {
    it('persists a valid key at 0600 and replies masked to the requester only (no broadcast)', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.set_credential(ws, {}, {
        type: 'set_credential', key: 'OPENAI_API_KEY', value: 'sk-openai-abc', requestId: 'r2',
      }, ctx)
      assert.equal(getStoredCredential('OPENAI_API_KEY'), 'sk-openai-abc')
      const file = join(tmpHome, '.chroxy', 'credentials.json')
      if (process.platform !== 'win32') {
        assert.equal(statSync(file).mode & 0o777, 0o600)
      }
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'credentials_status')
      assert.equal(reply.requestId, 'r2')
      // #3855: credentials are admin state — sent ONLY to the requester, never
      // broadcast (would leak configured-provider + masked previews to other
      // authenticated clients).
      assert.equal(ctx.broadcast.mock.callCount(), 0)
      assert.equal(JSON.stringify(reply).includes('sk-openai-abc'), false)
    })

    it('rejects an unknown key', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.set_credential(ws, {}, { type: 'set_credential', key: 'NOPE', value: 'x', requestId: 'r3' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'INVALID_REQUEST')
    })

    it('rejects an empty value', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.set_credential(ws, {}, { type: 'set_credential', key: 'GEMINI_API_KEY', value: '   ', requestId: 'r4' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'INVALID_REQUEST')
    })

    it('rejects a malformed Anthropic key with CREDENTIAL_WRITE_FAILED', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.set_credential(ws, {}, {
        type: 'set_credential', key: 'ANTHROPIC_API_KEY', value: 'not-a-key', requestId: 'r5',
      }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'CREDENTIAL_WRITE_FAILED')
    })
  })

  describe('delete_credential', () => {
    it('removes the stored value and replies to the requester only (no broadcast)', () => {
      setStoredCredential('GEMINI_API_KEY', 'gem-1')
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.delete_credential(ws, {}, { type: 'delete_credential', key: 'GEMINI_API_KEY', requestId: 'r6' }, ctx)
      assert.equal(getStoredCredential('GEMINI_API_KEY'), null)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'credentials_status')
      assert.equal(ctx.broadcast.mock.callCount(), 0)
    })

    it('rejects an unknown key', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.delete_credential(ws, {}, { type: 'delete_credential', key: 'NOPE', requestId: 'r7' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
    })
  })

  describe('test_credential', () => {
    it('returns a credential_test_result keyed by the credential', async () => {
      // No credential set + no fetch override → resolves to "not configured".
      const ws = makeWs()
      const ctx = makeCtx()
      await settingsHandlers.test_credential(ws, {}, { type: 'test_credential', key: 'OPENAI_API_KEY', requestId: 'r8' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'credential_test_result')
      assert.equal(reply.key, 'OPENAI_API_KEY')
      assert.equal(reply.ok, false)
    })

    it('rejects an unknown key', async () => {
      const ws = makeWs()
      const ctx = makeCtx()
      await settingsHandlers.test_credential(ws, {}, { type: 'test_credential', key: 'NOPE', requestId: 'r9' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
    })
  })

  // #5155: credential WRITES require host-level authority. A pairing-bound
  // session token (client.boundSessionId set) can READ masked status but must
  // NOT be able to overwrite or clear the operator's provider keys — that's a
  // billing-redirection / DoS vector. Reads stay open for the bound client.
  describe('#5155 bound-client write gate', () => {
    const boundClient = { id: 'c-bound', boundSessionId: 'sess-1' }

    it('rejects set_credential from a pairing-bound client and does not write', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.set_credential(ws, boundClient, {
        type: 'set_credential', key: 'OPENAI_API_KEY', value: 'sk-openai-evil', requestId: 'rb1',
      }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'CREDENTIAL_WRITE_FORBIDDEN_BOUND_CLIENT')
      assert.equal(reply.requestId, 'rb1')
      // The write must NOT have happened.
      assert.equal(getStoredCredential('OPENAI_API_KEY'), null)
      assert.equal(ctx.broadcast.mock.callCount(), 0)
    })

    it('rejects delete_credential from a pairing-bound client and leaves the value intact', () => {
      setStoredCredential('GEMINI_API_KEY', 'gem-keep')
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.delete_credential(ws, boundClient, {
        type: 'delete_credential', key: 'GEMINI_API_KEY', requestId: 'rb2',
      }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'CREDENTIAL_WRITE_FORBIDDEN_BOUND_CLIENT')
      // The live value must survive.
      assert.equal(getStoredCredential('GEMINI_API_KEY'), 'gem-keep')
    })

    it('still allows a pairing-bound client to READ masked status', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-readable')
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.get_credentials_status(ws, boundClient, { type: 'get_credentials_status', requestId: 'rb3' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'credentials_status')
      const anth = reply.credentials.find((c) => c.key === 'ANTHROPIC_API_KEY')
      assert.equal(anth.status, 'set')
    })

    it('still allows the primary (unbound) client to write', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      settingsHandlers.set_credential(ws, { id: 'c-primary' }, {
        type: 'set_credential', key: 'OPENAI_API_KEY', value: 'sk-openai-ok', requestId: 'rb4',
      }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'credentials_status')
      assert.equal(getStoredCredential('OPENAI_API_KEY'), 'sk-openai-ok')
    })
  })
})
