import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inputHandlers } from '../../src/handlers/input-handlers.js'
import { PushManager } from '../../src/push.js'
import { CATEGORY_DEFAULTS } from '../../src/notification-prefs.js'
import { createSpy } from '../test-helpers.js'

/**
 * Tests for the notification preferences WS handlers (#4541):
 *   - notification_prefs_get
 *   - notification_prefs_set
 *
 * Mirrors the BYOK credentials handler tests (#4052) — feeds the handler a
 * fake ctx with a PushManager pointed at a temp prefs file, then asserts
 * on the persisted state plus the broadcast/reply messages.
 */

function makeCtx(pushManager) {
  const sent = []
  const broadcast = []
  return {
    pushManager,
    send: createSpy((_ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcast.push(msg) }),
    _sent: sent,
    _broadcast: broadcast,
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

describe('notification prefs handlers (#4541)', () => {
  let tmpDir
  let prefsPath
  let pushManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-notif-prefs-handler-'))
    prefsPath = join(tmpDir, 'notification-prefs.json')
    pushManager = new PushManager({ prefsPath })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('notification_prefs_get', () => {
    it('returns the current snapshot with defaults on first call', () => {
      const ctx = makeCtx(pushManager)
      inputHandlers.notification_prefs_get(makeWs(), { id: 'c1' }, { requestId: 'r1' }, ctx)
      const payload = ctx._sent[0]
      assert.equal(payload.type, 'notification_prefs')
      assert.equal(payload.requestId, 'r1')
      assert.deepEqual(payload.prefs.categories, CATEGORY_DEFAULTS)
      assert.deepEqual(payload.prefs.devices, {})
      assert.equal(payload.prefs.quietHours, null)
    })

    it('echoes back the persisted state after a set', () => {
      pushManager.setPrefs({ categories: { result: false } })
      const ctx = makeCtx(pushManager)
      inputHandlers.notification_prefs_get(makeWs(), { id: 'c1' }, {}, ctx)
      const payload = ctx._sent[0]
      assert.equal(payload.prefs.categories.result, false)
      assert.equal(payload.prefs.categories.permission, true)
    })

    it('emits NOT_AVAILABLE when pushManager is missing from ctx', () => {
      const ctx = { send: createSpy(() => {}), _sent: [] }
      ctx.send = createSpy((_ws, msg) => { ctx._sent.push(msg) })
      const ws = makeWs()
      inputHandlers.notification_prefs_get(ws, { id: 'c1' }, { requestId: 'r1' }, ctx)
      const err = ws._messages.find((m) => m.type === 'error')
      assert.ok(err, 'expected an error reply')
      assert.equal(err.code, 'NOT_AVAILABLE')
    })
  })

  describe('notification_prefs_set', () => {
    it('persists the patch atomically and replies with the merged snapshot', () => {
      const ctx = makeCtx(pushManager)
      inputHandlers.notification_prefs_set(
        makeWs(),
        { id: 'c1' },
        { requestId: 'r1', prefs: { categories: { result: false } } },
        ctx,
      )
      // File persisted
      assert.ok(existsSync(prefsPath), 'set must persist to disk')
      const onDisk = JSON.parse(readFileSync(prefsPath, 'utf8'))
      assert.equal(onDisk.categories.result, false)

      // Reply sent with requestId
      const reply = ctx._sent[0]
      assert.equal(reply.type, 'notification_prefs')
      assert.equal(reply.requestId, 'r1')
      assert.equal(reply.prefs.categories.result, false)
      // Unmentioned categories retain defaults
      assert.equal(reply.prefs.categories.permission, true)
    })

    it('broadcasts the snapshot to other connected clients (without requestId)', () => {
      const ctx = makeCtx(pushManager)
      inputHandlers.notification_prefs_set(
        makeWs(),
        { id: 'c1' },
        { requestId: 'r1', prefs: { categories: { result: false } } },
        ctx,
      )
      assert.equal(ctx._broadcast.length, 1, 'expected exactly one broadcast')
      const bcast = ctx._broadcast[0]
      assert.equal(bcast.type, 'notification_prefs')
      assert.equal(bcast.requestId, undefined, 'broadcast must NOT carry requestId')
      assert.equal(bcast.prefs.categories.result, false)
    })

    it('shallow-merges sequential category patches (per-toggle UI flow)', () => {
      const ctx = makeCtx(pushManager)
      inputHandlers.notification_prefs_set(
        makeWs(), { id: 'c1' },
        { prefs: { categories: { result: false } } }, ctx,
      )
      inputHandlers.notification_prefs_set(
        makeWs(), { id: 'c1' },
        { prefs: { categories: { permission: false } } }, ctx,
      )
      const onDisk = JSON.parse(readFileSync(prefsPath, 'utf8'))
      assert.equal(onDisk.categories.result, false, 'first toggle must survive second set')
      assert.equal(onDisk.categories.permission, false)
    })

    it('rejects missing prefs object with INVALID_REQUEST', () => {
      const ctx = makeCtx(pushManager)
      const ws = makeWs()
      inputHandlers.notification_prefs_set(ws, { id: 'c1' }, { requestId: 'r1' }, ctx)
      const err = ws._messages.find((m) => m.type === 'error')
      assert.ok(err, 'expected an error reply')
      assert.equal(err.code, 'INVALID_REQUEST')
    })

    it('per-device override resolves through PushManager.isCategoryEnabled', () => {
      // Real-token-format keys (#4551 — handler now requires isValidPushTokenFormat
      // pass on every devices map key, matching the register_push_token gate).
      const tokA = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'
      const tokB = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]'
      const ctx = makeCtx(pushManager)
      inputHandlers.notification_prefs_set(
        makeWs(), { id: 'c1' },
        { prefs: { categories: { result: false }, devices: { [tokA]: { categories: { result: true } } } } },
        ctx,
      )
      // Per-device override re-enables result for tokA, but tokB still
      // sees the global mute.
      assert.equal(pushManager.isCategoryEnabled('result', tokA), true)
      assert.equal(pushManager.isCategoryEnabled('result', tokB), false)
    })

    it('emits NOT_AVAILABLE when pushManager is missing from ctx', () => {
      const ctx = { send: createSpy(() => {}), _sent: [] }
      ctx.send = createSpy((_ws, msg) => { ctx._sent.push(msg) })
      const ws = makeWs()
      inputHandlers.notification_prefs_set(
        ws, { id: 'c1' },
        { requestId: 'r1', prefs: { categories: { result: false } } },
        ctx,
      )
      const err = ws._messages.find((m) => m.type === 'error')
      assert.ok(err)
      assert.equal(err.code, 'NOT_AVAILABLE')
    })

    // #4551 — device keys in the patch must clear the same
    // isValidPushTokenFormat gate that register_push_token enforces.
    // Without this an authenticated client can stuff arbitrary strings
    // into ~/.chroxy/notification-prefs.json and have them re-served on
    // every notification_prefs_get. Reject the whole patch (do NOT
    // partial-apply) so the on-disk state stays clean.
    it('rejects notification_prefs_set with malformed device key', () => {
      const setPrefsSpy = createSpy((patch, opts) => pushManager.setPrefs(patch, opts))
      const wrappedManager = Object.assign(Object.create(Object.getPrototypeOf(pushManager)), pushManager, {
        setPrefs: setPrefsSpy,
      })
      const ctx = makeCtx(wrappedManager)
      const ws = makeWs()
      const before = JSON.parse(JSON.stringify(pushManager.getPrefs()))
      inputHandlers.notification_prefs_set(
        ws, { id: 'c1' },
        {
          requestId: 'r1',
          prefs: { devices: { 'bad key with spaces': { categories: { result: false } } } },
        },
        ctx,
      )
      const err = ws._messages.find((m) => m.type === 'error')
      assert.ok(err, 'expected an error reply')
      assert.equal(err.code, 'INVALID_REQUEST')
      assert.match(err.message, /Invalid device token format/)
      // setPrefs must not be called on a rejected patch — the prefs file
      // stays exactly as it was.
      assert.equal(setPrefsSpy.callCount, 0, 'setPrefs must not be invoked on invalid input')
      assert.deepEqual(pushManager.getPrefs(), before, 'prefs snapshot must be unchanged')
      // No persisted file either (no prior writes on this temp dir).
      assert.equal(existsSync(prefsPath), false, 'prefs file must not exist after rejection')
    })

    // #4610 — `typeof [] === 'object'` so an array-typed `devices` payload
    // would otherwise reach the key-format loop and reject with the wrong
    // error message ("Invalid device token format" — true but misleading
    // about the actual shape mismatch). Reject arrays explicitly up front
    // with a shape-specific message so misbehaving clients get a clear
    // signal and the on-disk state stays untouched.
    it('rejects array-typed devices payload with a shape-specific message (#4610)', () => {
      const setPrefsSpy = createSpy((patch, opts) => pushManager.setPrefs(patch, opts))
      const wrappedManager = Object.assign(Object.create(Object.getPrototypeOf(pushManager)), pushManager, {
        setPrefs: setPrefsSpy,
      })
      const ctx = makeCtx(wrappedManager)
      const ws = makeWs()
      const before = JSON.parse(JSON.stringify(pushManager.getPrefs()))
      inputHandlers.notification_prefs_set(
        ws, { id: 'c1' },
        { requestId: 'r1', prefs: { devices: ['foo', 'bar'] } },
        ctx,
      )
      const err = ws._messages.find((m) => m.type === 'error')
      assert.ok(err, 'expected an error reply')
      assert.equal(err.code, 'INVALID_REQUEST')
      assert.match(err.message, /devices must be an object, not an array/)
      // No partial-apply: setPrefs must not be invoked and disk stays clean.
      assert.equal(setPrefsSpy.callCount, 0, 'setPrefs must not be invoked on array-typed devices')
      assert.deepEqual(pushManager.getPrefs(), before, 'prefs snapshot must be unchanged')
      assert.equal(existsSync(prefsPath), false, 'prefs file must not exist after rejection')
    })

    it('rejects notification_prefs_set when device key is too short', () => {
      const setPrefsSpy = createSpy((patch, opts) => pushManager.setPrefs(patch, opts))
      const wrappedManager = Object.assign(Object.create(Object.getPrototypeOf(pushManager)), pushManager, {
        setPrefs: setPrefsSpy,
      })
      const ctx = makeCtx(wrappedManager)
      const ws = makeWs()
      inputHandlers.notification_prefs_set(
        ws, { id: 'c1' },
        { requestId: 'r1', prefs: { devices: { 'short': { categories: { result: false } } } } },
        ctx,
      )
      const err = ws._messages.find((m) => m.type === 'error')
      assert.ok(err)
      assert.equal(err.code, 'INVALID_REQUEST')
      assert.equal(setPrefsSpy.callCount, 0)
      assert.equal(existsSync(prefsPath), false)
    })

    it('accepts a valid 64-char hex device key', () => {
      const validKey = 'a'.repeat(64)
      const ctx = makeCtx(pushManager)
      inputHandlers.notification_prefs_set(
        makeWs(), { id: 'c1' },
        {
          requestId: 'r1',
          prefs: { devices: { [validKey]: { categories: { result: false } } } },
        },
        ctx,
      )
      const reply = ctx._sent[0]
      assert.equal(reply.type, 'notification_prefs')
      assert.equal(reply.requestId, 'r1')
      assert.ok(reply.prefs.devices[validKey], 'valid device key must be persisted in reply')
      assert.ok(existsSync(prefsPath), 'valid set must persist to disk')
    })
  })

  describe('schema coverage handshake', () => {
    it('both message types are registered on inputHandlers', () => {
      assert.equal(typeof inputHandlers.notification_prefs_get, 'function')
      assert.equal(typeof inputHandlers.notification_prefs_set, 'function')
    })
  })
})
