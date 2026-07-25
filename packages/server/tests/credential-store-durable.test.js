import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as credStore from '../src/credential-store.js'
import { githubWebhookHandlers } from '../src/handlers/github-webhook-handlers.js'
import { WEBHOOK_SECRET_FIELD } from '../src/github-webhook.js'
import { nsCtx } from './test-helpers.js'

/**
 * #6964 — the credential store's durable-write seam.
 *
 * `writeStoreAtomically` predates #6914's `writeFileRestricted({ durable: true })`
 * and had no way to force a credential rotation to disk: an operator could rotate
 * a shared secret, be told it succeeded, and lose it to a power failure inside the
 * OS writeback window. These tests pin the seam:
 *   - OFF by default (no fsync on an ordinary set — no new blocking I/O),
 *   - ON for the rotation path: temp file fsynced BEFORE the rename, containing
 *     directory fsynced AFTER it (a rename is not durable until its directory
 *     entry is),
 *   - a durability FAILURE throws instead of reporting success, and the prior
 *     value survives.
 *
 * The durability hook is injected (`_setCredentialDurabilityForTests`) so the
 * assertions never depend on real fsync behaviour of the host filesystem.
 * A temp HOME isolates the real credentials store; the test bootstrap sets
 * CHROXY_CRED_DISABLE_KEYCHAIN=1, so writes land as 0600 plaintext and the
 * encryption-at-rest path is untouched by this test.
 */

const IS_WINDOWS = process.platform === 'win32'

function makeWs() {
  return { readyState: 1, send: mock.fn() }
}

function makeCtx(cache = { value: undefined }) {
  return nsCtx({
    send: mock.fn(),
    broadcast: mock.fn(),
    webhookPayloadUrl: { url: 'https://x.trycloudflare.com/api/github/webhook', lanOnly: false, note: null },
    repoWebhookDeliveries: null,
    setWebhookSecretCache: mock.fn((v) => { cache.value = v }),
  })
}

function lastReply(ws, ctx) {
  if (ws.send.mock.callCount() > 0) {
    return JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1].arguments[0])
  }
  if (ctx.transport.send.mock.callCount() > 0) {
    return ctx.transport.send.mock.calls[ctx.transport.send.mock.calls.length - 1].arguments[1]
  }
  return null
}

describe('credential-store durable-write seam (#6964)', () => {
  let tmpHome
  let originalHome
  let savedEnvSecret
  let calls
  let credFile
  let credDir

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-durable-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    savedEnvSecret = process.env.GITHUB_WEBHOOK_SECRET
    delete process.env.GITHUB_WEBHOOK_SECRET
    credDir = join(tmpHome, '.chroxy')
    credFile = join(credDir, 'credentials.json')
    calls = []
    assert.equal(
      typeof credStore._setCredentialDurabilityForTests,
      'function',
      'credential-store must expose the injectable durability seam (#6964)',
    )
    credStore._setCredentialDurabilityForTests((target, { isDir = false } = {}) => {
      // Record whether the FINAL file already exists at fsync time — that is how
      // we prove the temp-file fsync happens before the rename and the directory
      // fsync after it, without reaching into the module internals.
      calls.push({ target, isDir, targetExists: existsSync(credFile) })
    })
  })

  afterEach(() => {
    if (typeof credStore._setCredentialDurabilityForTests === 'function') {
      credStore._setCredentialDurabilityForTests(null)
    }
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (savedEnvSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
    else process.env.GITHUB_WEBHOOK_SECRET = savedEnvSecret
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  it('does NOT fsync on an ordinary (non-durable) set — the default stays off', () => {
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-ordinary-value-0001')
    assert.equal(credStore.readStoredField(WEBHOOK_SECRET_FIELD).value, 'whsec-ordinary-value-0001')
    assert.deepEqual(calls, [], 'a default set must add no fsync to the write path')
  })

  it('durable set fsyncs the temp file BEFORE the rename and the directory AFTER', () => {
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-durable-value-0001', { durable: true })
    assert.equal(credStore.readStoredField(WEBHOOK_SECRET_FIELD).value, 'whsec-durable-value-0001')

    assert.ok(calls.length >= 1, 'durable set must fsync the temp file')
    const [fileCall] = calls
    assert.equal(fileCall.isDir, false, 'first fsync is the temp FILE')
    assert.ok(
      fileCall.target.startsWith(credFile) && fileCall.target !== credFile,
      `first fsync target should be the temp sibling of ${credFile}, got ${fileCall.target}`,
    )
    assert.equal(fileCall.targetExists, false, 'temp-file fsync must happen BEFORE the rename')

    if (IS_WINDOWS) {
      assert.equal(calls.length, 1, 'Windows has no directory fsync (MOVEFILE_WRITE_THROUGH covers the rename)')
      return
    }
    assert.equal(calls.length, 2, 'POSIX durable write = temp-file fsync + containing-directory fsync')
    const dirCall = calls[1]
    assert.equal(dirCall.isDir, true, 'second fsync is the containing DIRECTORY')
    assert.equal(dirCall.target, credDir)
    assert.equal(dirCall.targetExists, true, 'directory fsync must happen AFTER the rename')
  })

  it('a durability failure throws and leaves the previously stored value intact', () => {
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-original-value-0001')
    calls = []
    credStore._setCredentialDurabilityForTests(() => {
      const err = new Error('simulated fsync I/O failure')
      err.code = 'EIO'
      throw err
    })

    assert.throws(
      () => credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-rotated-value-0002', { durable: true }),
      /EIO|simulated fsync I\/O failure/,
      'a genuine fsync failure must surface, never report success',
    )
    credStore._setCredentialDurabilityForTests(null)
    assert.equal(
      credStore.readStoredField(WEBHOOK_SECRET_FIELD).value,
      'whsec-original-value-0001',
      'the prior credential must survive a failed durable rotation',
    )
    const leftovers = readdirSync(credDir).filter((n) => n.includes('.tmp.'))
    assert.deepEqual(leftovers, [], 'the orphaned temp file must be cleaned up')
  })

  it('the webhook-secret ROTATION path drives the durable write and acks only on success', () => {
    const ws = makeWs()
    const cache = { value: undefined }
    const ctx = makeCtx(cache)
    githubWebhookHandlers.github_webhook_set_secret(
      ws,
      { id: 'c1', isPrimaryToken: true },
      { type: 'github_webhook_set_secret', requestId: 'r1', secret: 'whsec-rotated-by-operator' },
      ctx,
    )
    const reply = lastReply(ws, ctx)
    assert.equal(reply.type, 'github_webhook_config', 'success ack is the value-free config')
    assert.equal(reply.configured, true)
    assert.equal(cache.value, 'whsec-rotated-by-operator')
    assert.ok(calls.length >= 1, 'the rotation path must reach the durable write')
    assert.equal(calls[0].isDir, false)
    assert.equal(calls[0].targetExists, false)
    if (!IS_WINDOWS) {
      assert.equal(calls.length, 2)
      assert.equal(calls[1].isDir, true)
    }
  })

  it('the rotation path reports a durability failure instead of acking success', () => {
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-original-value-0001')
    credStore._setCredentialDurabilityForTests(() => {
      const err = new Error('simulated fsync I/O failure')
      err.code = 'EIO'
      throw err
    })
    const ws = makeWs()
    const cache = { value: undefined }
    const ctx = makeCtx(cache)
    githubWebhookHandlers.github_webhook_set_secret(
      ws,
      { id: 'c1', isPrimaryToken: true },
      { type: 'github_webhook_set_secret', requestId: 'r2', secret: 'whsec-rotated-value-0002' },
      ctx,
    )
    const reply = lastReply(ws, ctx)
    assert.equal(reply.type, 'error', 'a non-durable rotation must NOT ack as configured')
    assert.equal(reply.code, 'WEBHOOK_SECRET_WRITE_FAILED')
    assert.equal(cache.value, undefined, 'the hot cache must not adopt a secret that never landed')
    credStore._setCredentialDurabilityForTests(null)
    assert.equal(credStore.readStoredField(WEBHOOK_SECRET_FIELD).value, 'whsec-original-value-0001')
  })
})
