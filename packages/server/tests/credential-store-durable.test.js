import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as credStore from '../src/credential-store.js'
import { githubWebhookHandlers } from '../src/handlers/github-webhook-handlers.js'
import { credentialHandlers } from '../src/handlers/credential-handlers.js'
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
 *   - a PRE-RENAME (temp file) durability failure throws instead of reporting
 *     success, and the prior value survives — nothing was published,
 *   - a POST-RENAME (directory) durability failure does NOT throw: the rename has
 *     already published the new value, so only the durability of the new directory
 *     ENTRY is unproven. Reporting a failed write there would be factually wrong
 *     and would leave the in-process cache holding a value that is no longer on
 *     disk (split brain). It reports a distinct `durabilityUnconfirmed` outcome,
 *     the caller updates its cache to match disk, and the operator gets a
 *     `WEBHOOK_SECRET_DURABILITY_UNCONFIRMED` diagnostic alongside the config ack.
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

/** Every frame the handler produced, in order, across both send paths. */
function allReplies(ws, ctx) {
  const out = []
  for (const call of ctx.transport.send.mock.calls) out.push(call.arguments[1])
  for (const call of ws.send.mock.calls) out.push(JSON.parse(call.arguments[0]))
  return out
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

function throwOnDirFsync(calls) {
  return (target, { isDir = false } = {}) => {
    calls.push({ target, isDir })
    // The temp-file fsync (pre-rename) SUCCEEDS — only the containing
    // directory's fsync (post-rename, after the value is already live) fails.
    if (!isDir) return
    const err = new Error('simulated directory fsync I/O failure')
    err.code = 'EIO'
    throw err
  }
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

  it('a PRE-RENAME (temp file) durability failure throws and leaves the previously stored value intact', () => {
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

  it('a POST-RENAME (directory) durability failure does NOT throw — the value is live, only its durability is unproven', () => {
    if (IS_WINDOWS) return // no directory fsync on Windows (MOVEFILE_WRITE_THROUGH covers the rename)
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-original-value-0001')
    calls = []
    credStore._setCredentialDurabilityForTests(throwOnDirFsync(calls))

    let outcome
    assert.doesNotThrow(() => {
      outcome = credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-rotated-value-0002', { durable: true })
    }, 'the rename already published the new value — reporting a failed write would be factually wrong')
    credStore._setCredentialDurabilityForTests(null)

    assert.equal(calls.length, 2, 'both limbs ran: temp-file fsync then directory fsync')
    assert.equal(
      credStore.readStoredField(WEBHOOK_SECRET_FIELD).value,
      'whsec-rotated-value-0002',
      'the new value IS on disk — the rename succeeded before the directory fsync failed',
    )
    assert.equal(
      typeof outcome?.durabilityUnconfirmed,
      'string',
      'the caller must be told durability is UNCONFIRMED (distinct from the write failing)',
    )
    assert.match(outcome.durabilityUnconfirmed, /directory fsync/)
    const leftovers = readdirSync(credDir).filter((n) => n.includes('.tmp.'))
    assert.deepEqual(leftovers, [], 'no orphaned temp file')
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

  it('the rotation path never reports a failed write for a rotation that LANDED, and the cache follows disk', () => {
    if (IS_WINDOWS) return // no directory fsync on Windows
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-original-value-0001')
    calls = []
    credStore._setCredentialDurabilityForTests(throwOnDirFsync(calls))

    const ws = makeWs()
    const cache = { value: undefined }
    const ctx = makeCtx(cache)
    githubWebhookHandlers.github_webhook_set_secret(
      ws,
      { id: 'c1', isPrimaryToken: true },
      { type: 'github_webhook_set_secret', requestId: 'r3', secret: 'whsec-rotated-value-0002' },
      ctx,
    )
    const replies = allReplies(ws, ctx)
    credStore._setCredentialDurabilityForTests(null)

    // The new secret is live on disk...
    assert.equal(credStore.readStoredField(WEBHOOK_SECRET_FIELD).value, 'whsec-rotated-value-0002')
    // ...so the reply must NOT claim the write failed (the operator would leave
    // the OLD secret configured at GitHub while the daemon verifies with the new one).
    assert.deepEqual(
      replies.filter((r) => r.code === 'WEBHOOK_SECRET_WRITE_FAILED'),
      [],
      'a write that landed must never be reported as a failed write',
    )
    const config = replies.find((r) => r.type === 'github_webhook_config')
    assert.ok(config, 'the reply is still the value-free config')
    assert.equal(config.configured, true)
    // ...and the in-process cache must never diverge from what is on disk.
    assert.equal(
      cache.value,
      'whsec-rotated-value-0002',
      'the hot cache must track disk — otherwise live deliveries verify with the OLD secret',
    )
    // ...while the operator still learns the durability of the write is unproven.
    const caveat = replies.find((r) => r.code === 'WEBHOOK_SECRET_DURABILITY_UNCONFIRMED')
    assert.ok(caveat, 'the fsync failure must still be surfaced to the operator')
    assert.equal(caveat.type, 'error')
    assert.match(caveat.message, /durab/i)
    assert.match(caveat.message, /saved|live|stored/i)
  })

  it('the rotation path reports a PRE-RENAME durability failure instead of acking success', () => {
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

  // ---------------------------------------------------------------------------
  // #7056 — the CLEAR path. Clearing a shared secret is as acute as rotating it:
  // an operator clears precisely because they believe the value leaked. A
  // non-durable clear can report success and then resurrect the leaked secret
  // after a power loss. The clear has TWO limbs, and the second one is the
  // interesting one: when the field was the last key the file is UNLINKED, and an
  // unlink's durability lives in the containing DIRECTORY's entry, not in any
  // file fsync.
  // ---------------------------------------------------------------------------

  it('does NOT fsync on an ordinary (non-durable) delete — the default stays off', () => {
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-ordinary-value-0001')
    credStore.setStoredField('otherField', 'keep-me-around-0001')
    calls = []
    credStore.deleteStoredField(WEBHOOK_SECRET_FIELD)
    assert.equal(credStore.readStoredField(WEBHOOK_SECRET_FIELD).value, null)
    assert.deepEqual(calls, [], 'a default delete must add no fsync to the write path')
  })

  it('durable delete (siblings survive) fsyncs the temp file BEFORE the rename and the directory AFTER', () => {
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-durable-value-0001')
    credStore.setStoredField('otherField', 'keep-me-around-0001')
    calls = []

    credStore.deleteStoredField(WEBHOOK_SECRET_FIELD, { durable: true })

    assert.equal(credStore.readStoredField(WEBHOOK_SECRET_FIELD).value, null, 'the field is gone')
    assert.equal(credStore.readStoredField('otherField').value, 'keep-me-around-0001', 'siblings survive')

    assert.ok(calls.length >= 1, 'durable delete must fsync the temp file')
    const [fileCall] = calls
    assert.equal(fileCall.isDir, false, 'first fsync is the temp FILE')
    assert.equal(fileCall.targetExists, true, 'the live file still exists pre-rename on a rewrite delete')

    if (IS_WINDOWS) {
      assert.equal(calls.length, 1, 'Windows has no directory fsync')
      return
    }
    assert.equal(calls.length, 2, 'POSIX durable rewrite-delete = temp-file fsync + directory fsync')
    assert.equal(calls[1].isDir, true, 'second fsync is the containing DIRECTORY')
    assert.equal(calls[1].target, credDir)
  })

  it('durable delete of the LAST field unlinks the file and fsyncs the directory AFTER the unlink', () => {
    if (IS_WINDOWS) return // no directory fsync on Windows
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-last-field-0001')
    calls = []

    credStore.deleteStoredField(WEBHOOK_SECRET_FIELD, { durable: true })

    assert.equal(existsSync(credFile), false, 'the file is removed when it would be left empty')
    assert.equal(calls.length, 1, 'an unlink has no temp file — only the containing directory is fsynced')
    assert.equal(calls[0].isDir, true, 'the unlink limb must fsync the DIRECTORY, not a file')
    assert.equal(calls[0].target, credDir)
    assert.equal(
      calls[0].targetExists, false,
      'the directory fsync must happen AFTER the unlink — otherwise it proves nothing about the removal',
    )
  })

  it('a directory-fsync failure on the UNLINK limb does NOT throw — the secret is already gone, only durability is unproven', () => {
    if (IS_WINDOWS) return
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-last-field-0001')
    calls = []
    credStore._setCredentialDurabilityForTests(throwOnDirFsync(calls))

    let outcome
    assert.doesNotThrow(() => {
      outcome = credStore.deleteStoredField(WEBHOOK_SECRET_FIELD, { durable: true })
    }, 'the unlink already removed the secret — reporting a failed clear would be factually wrong')
    credStore._setCredentialDurabilityForTests(null)

    assert.equal(existsSync(credFile), false, 'the secret IS gone from the live filesystem')
    assert.equal(
      typeof outcome?.durabilityUnconfirmed, 'string',
      'the clear must report unconfirmed durability rather than silently acking it',
    )
    assert.match(outcome.durabilityUnconfirmed, /EIO|simulated directory fsync/)
  })

  it('the webhook CLEAR handler opts into durability and surfaces an unconfirmed clear', () => {
    if (IS_WINDOWS) return
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-to-be-cleared-0001')
    const cache = { value: 'stale' }
    const ws = makeWs()
    const ctx = makeCtx(cache)
    calls = []
    credStore._setCredentialDurabilityForTests(throwOnDirFsync(calls))

    githubWebhookHandlers.github_webhook_clear_secret(ws, {}, { requestId: 'req-clear-1' }, ctx)
    credStore._setCredentialDurabilityForTests(null)

    assert.ok(calls.some((c) => c.isDir), 'the clear path must have opted into the durable write')
    assert.equal(credStore.readStoredField(WEBHOOK_SECRET_FIELD).value, null, 'the secret is cleared')
    assert.equal(cache.value, null, 'the hot cache is dropped so the next delivery re-resolves')

    const replies = allReplies(ws, ctx)
    const unconfirmed = replies.find((r) => r?.code === 'WEBHOOK_SECRET_DURABILITY_UNCONFIRMED')
    assert.ok(unconfirmed, `expected a durability-unconfirmed error frame, got ${JSON.stringify(replies.map((r) => r?.type || r?.code))}`)
    assert.equal(
      unconfirmed.requestId ?? null, null,
      'the durability warning must be requestId-LESS so a client cannot read it as the clear\'s verdict',
    )
  })

  // --- review follow-ups on #7056 -------------------------------------------

  it('an UNREADABLE store throws instead of acking a clear that cleared nothing', () => {
    if (IS_WINDOWS) return // POSIX dir-permission semantics
    if (process.getuid && process.getuid() === 0) return // root ignores mode bits
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-still-on-disk-0001')
    // Make statSync fail with EACCES (NOT ENOENT): readStore reports that as
    // { fileExists: false, error }, which a fileExists-first guard would treat
    // as "nothing to clear" and ack — while the secret is still on disk.
    chmodSync(credDir, 0o000)
    try {
      assert.throws(
        () => credStore.deleteStoredField(WEBHOOK_SECRET_FIELD, { durable: true }),
        /unable to stat/,
        'an unreadable store must surface, never report a successful clear',
      )
    } finally {
      chmodSync(credDir, 0o700)
    }
    assert.equal(
      credStore.readStoredField(WEBHOOK_SECRET_FIELD).value, 'whsec-still-on-disk-0001',
      'the secret is demonstrably still there — acking the clear would have been a lie',
    )
  })

  it('a durable clear of an ALREADY-absent field still confirms the directory (retries can confirm)', () => {
    if (IS_WINDOWS) return
    credStore.setStoredField(WEBHOOK_SECRET_FIELD, 'whsec-gone-0001')
    credStore.deleteStoredField(WEBHOOK_SECRET_FIELD, { durable: true })
    calls = []

    // The operator's natural move after an unconfirmed clear is to re-run it.
    // That retry must be able to CONFIRM durability, not ack for free.
    const outcome = credStore.deleteStoredField(WEBHOOK_SECRET_FIELD, { durable: true })

    assert.equal(outcome.durabilityUnconfirmed, null)
    assert.equal(calls.length, 1, 'a durable no-op must still fsync the containing directory')
    assert.equal(calls[0].isDir, true)
    assert.equal(calls[0].target, credDir)
  })

  it('a NON-durable clear of an absent field stays a free no-op', () => {
    credStore.setStoredField('otherField', 'keep-me-0001')
    calls = []
    const outcome = credStore.deleteStoredField(WEBHOOK_SECRET_FIELD)
    assert.equal(outcome.durabilityUnconfirmed, null)
    assert.deepEqual(calls, [], 'the default path must add no fsync')
  })

  it('a durable clear of an absent field with SIBLINGS present still confirms the directory', () => {
    if (IS_WINDOWS) return
    // Distinct from the retry test above: there the store was unlinked, so the
    // retry hit !fileExists. Here the FILE SURVIVES (a sibling keeps it alive)
    // and the retry hits the !(field in data) limb, which needs its own pin —
    // mutating that one line alone otherwise leaves the suite green.
    credStore.setStoredField('otherField', 'keep-me-0001')
    calls = []

    const outcome = credStore.deleteStoredField(WEBHOOK_SECRET_FIELD, { durable: true })

    assert.equal(existsSync(credFile), true, 'the sibling keeps the store file alive')
    assert.equal(outcome.durabilityUnconfirmed, null)
    assert.equal(calls.length, 1, 'the !(field in data) durable limb must fsync the directory too')
    assert.equal(calls[0].isDir, true)
    assert.equal(calls[0].target, credDir)
  })

  it('#7056: deleteStoredCredential also surfaces an unreadable store instead of acking', () => {
    if (IS_WINDOWS) return
    if (process.getuid && process.getuid() === 0) return
    credStore.setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-still-here-0001')
    chmodSync(credDir, 0o000)
    try {
      assert.throws(
        () => credStore.deleteStoredCredential('ANTHROPIC_API_KEY'),
        /unable to stat/,
        'the API-key delete must not ack a deletion it could not perform',
      )
    } finally {
      chmodSync(credDir, 0o700)
    }
    assert.equal(credStore.getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-still-here-0001')
  })

  // --- #7062: the API-key delete ---------------------------------------------
  // `deleteStoredCredential` is the sibling of the field clear above and had the
  // identical non-durable shape: neither limb forced anything to disk. Same
  // threat model — an operator deletes a provider key precisely because they
  // believe it leaked, and a delete that is acked but still in the OS writeback
  // window can bring the key back on the next start after a power loss.

  it('#7062: does NOT fsync on an ordinary (non-durable) credential delete', () => {
    credStore.setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-ordinary-0001')
    credStore.setStoredCredential('OPENAI_API_KEY', 'sk-keep-me-0001')
    calls = []
    credStore.deleteStoredCredential('ANTHROPIC_API_KEY')
    assert.equal(credStore.getStoredCredential('ANTHROPIC_API_KEY'), null)
    assert.deepEqual(calls, [], 'a default credential delete must add no fsync to the write path')
  })

  it('#7062: durable credential delete (siblings survive) fsyncs the temp file BEFORE the rename and the directory AFTER', () => {
    credStore.setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-durable-0001')
    credStore.setStoredCredential('OPENAI_API_KEY', 'sk-keep-me-0001')
    calls = []

    credStore.deleteStoredCredential('ANTHROPIC_API_KEY', { durable: true })

    assert.equal(credStore.getStoredCredential('ANTHROPIC_API_KEY'), null, 'the key is gone')
    assert.equal(credStore.getStoredCredential('OPENAI_API_KEY'), 'sk-keep-me-0001', 'siblings survive')

    assert.ok(calls.length >= 1, 'durable delete must fsync the temp file')
    const [fileCall] = calls
    assert.equal(fileCall.isDir, false, 'first fsync is the temp FILE')
    assert.equal(fileCall.targetExists, true, 'the live file still exists pre-rename on a rewrite delete')

    if (IS_WINDOWS) {
      assert.equal(calls.length, 1, 'Windows has no directory fsync')
      return
    }
    assert.equal(calls.length, 2, 'POSIX durable rewrite-delete = temp-file fsync + directory fsync')
    assert.equal(calls[1].isDir, true, 'second fsync is the containing DIRECTORY')
    assert.equal(calls[1].target, credDir)
  })

  it('#7062: durable delete of the LAST credential unlinks the file and fsyncs the directory AFTER the unlink', () => {
    if (IS_WINDOWS) return
    credStore.setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-last-key-0001')
    calls = []

    credStore.deleteStoredCredential('ANTHROPIC_API_KEY', { durable: true })

    assert.equal(existsSync(credFile), false, 'the file is removed when it would be left empty')
    assert.equal(calls.length, 1, 'an unlink has no temp file — only the containing directory is fsynced')
    assert.equal(calls[0].isDir, true, 'the unlink limb must fsync the DIRECTORY, not a file')
    assert.equal(calls[0].target, credDir)
    assert.equal(
      calls[0].targetExists, false,
      'the directory fsync must happen AFTER the unlink — otherwise it proves nothing about the removal',
    )
  })

  it('#7062: a directory-fsync failure on the credential UNLINK limb does NOT throw — the key is already gone', () => {
    if (IS_WINDOWS) return
    credStore.setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-last-key-0001')
    calls = []
    credStore._setCredentialDurabilityForTests(throwOnDirFsync(calls))

    let outcome
    assert.doesNotThrow(() => {
      outcome = credStore.deleteStoredCredential('ANTHROPIC_API_KEY', { durable: true })
    }, 'the unlink already removed the key — reporting a failed delete would be factually wrong')
    credStore._setCredentialDurabilityForTests(null)

    assert.equal(existsSync(credFile), false, 'the key IS gone from the live filesystem')
    assert.equal(
      typeof outcome?.durabilityUnconfirmed, 'string',
      'the delete must report unconfirmed durability rather than silently acking it',
    )
    assert.match(outcome.durabilityUnconfirmed, /EIO|simulated directory fsync/)
  })

  it('#7062: a durable credential delete of an ALREADY-absent key still confirms the directory', () => {
    if (IS_WINDOWS) return
    credStore.setStoredCredential('OPENAI_API_KEY', 'sk-sibling-0001')
    calls = []
    // The retry after an unconfirmed delete lands exactly here: the key is
    // already gone, and the outstanding doubt is the directory entry.
    const outcome = credStore.deleteStoredCredential('ANTHROPIC_API_KEY', { durable: true })
    assert.equal(outcome?.durabilityUnconfirmed, null)
    assert.equal(calls.length, 1, 'the already-absent durable limb must fsync the directory too')
    assert.equal(calls[0].isDir, true)
    assert.equal(calls[0].target, credDir)
  })

  it('#7062: the delete_credential handler opts into durability and surfaces an unconfirmed delete', () => {
    if (IS_WINDOWS) return
    credStore.setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-to-be-deleted-01')
    const ws = makeWs()
    const ctx = makeCtx()
    calls = []
    credStore._setCredentialDurabilityForTests(throwOnDirFsync(calls))

    credentialHandlers.delete_credential(ws, {}, { requestId: 'req-del-1', key: 'ANTHROPIC_API_KEY' }, ctx)
    credStore._setCredentialDurabilityForTests(null)

    assert.ok(calls.some((c) => c.isDir), 'the delete path must have opted into the durable write')
    assert.equal(credStore.getStoredCredential('ANTHROPIC_API_KEY'), null, 'the key is deleted')

    const replies = allReplies(ws, ctx)
    const unconfirmed = replies.find((r) => r?.code === 'CREDENTIAL_DELETE_DURABILITY_UNCONFIRMED')
    assert.ok(unconfirmed, `expected a durability-unconfirmed error frame, got ${JSON.stringify(replies.map((r) => r?.type || r?.code))}`)
    assert.equal(
      unconfirmed.requestId ?? null, null,
      'the durability warning must be requestId-LESS so a client cannot read it as the delete\'s verdict',
    )
  })

  // --- review follow-ups on #7062 --------------------------------------------
  // Both added because the mutation that removes the guard left the suite green:
  // an unpinned opt-in is how #7062 happened in the first place (the durable fix
  // landed on one sibling and skipped the other), so each opt-in gets its own test.

  it('#7062: the BYOK CLEAR handler also opts into durability and surfaces an unconfirmed clear', () => {
    if (IS_WINDOWS) return
    credStore.setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-byok-clear-0001')
    const ws = makeWs()
    const ctx = makeCtx()
    calls = []
    credStore._setCredentialDurabilityForTests(throwOnDirFsync(calls))

    credentialHandlers.byok_clear_credentials(ws, {}, { requestId: 'req-byok-clear-1' }, ctx)
    credStore._setCredentialDurabilityForTests(null)

    assert.ok(calls.some((c) => c.isDir), 'the BYOK clear path must have opted into the durable write')
    assert.equal(credStore.getStoredCredential('ANTHROPIC_API_KEY'), null, 'the key is cleared')

    const replies = allReplies(ws, ctx)
    const unconfirmed = replies.find((r) => r?.code === 'CREDENTIAL_DELETE_DURABILITY_UNCONFIRMED')
    assert.ok(unconfirmed, `expected a durability-unconfirmed error frame, got ${JSON.stringify(replies.map((r) => r?.type || r?.code))}`)
    assert.equal(
      unconfirmed.requestId ?? null, null,
      'the durability warning must be requestId-LESS so a client cannot read it as the clear\'s verdict',
    )
  })

  it('#7062: a durable credential delete with NO store file at all still confirms the directory', () => {
    if (IS_WINDOWS) return
    // The !fileExists limb. A retry after an unconfirmed delete that unlinked the
    // last key lands exactly here, and the outstanding doubt is still the
    // directory entry — acking for free would turn "unconfirmed" into false comfort.
    assert.equal(existsSync(credFile), false, 'precondition: no credentials file')
    calls = []
    const outcome = credStore.deleteStoredCredential('ANTHROPIC_API_KEY', { durable: true })
    assert.equal(outcome?.durabilityUnconfirmed, null)
    assert.equal(calls.length, 1, 'the !fileExists durable limb must fsync the directory too')
    assert.equal(calls[0].isDir, true)
    assert.equal(calls[0].target, credDir)
  })
})
