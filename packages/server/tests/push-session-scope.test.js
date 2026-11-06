import { describe, it, afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PushManager } from '../src/push.js'
import { inputHandlers } from '../src/handlers/input-handlers.js'

const PHONE = 'ExponentPushToken[phonephonephonephone]'
const GUEST = 'ExponentPushToken[guestguestguestguest]'

function fetchSpy() {
  return mock.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }))
}
// The tokens a send() posted to the push service.
const recipients = (spy) => spy.mock.calls.flatMap((c) => JSON.parse(c.arguments[1].body).map((m) => m.to))

describe('push destinations registered for one session', () => {
  let manager
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'push-scope-'))
    manager = new PushManager({ storagePath: join(dir, 'tokens.json') })
  })
  afterEach(() => {
    mock.restoreAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('receives notifications for its session and not for another', async () => {
    manager.registerToken(GUEST, 'conn-1', { sessionId: 'sess-a' })
    const spy = fetchSpy()
    globalThis.fetch = spy
    await manager.send('permission', 'T', 'B', { sessionId: 'sess-a' })
    assert.deepEqual(recipients(spy), [GUEST])

    manager._lastSent.clear()
    const spy2 = fetchSpy()
    globalThis.fetch = spy2
    await manager.send('permission', 'T', 'B', { sessionId: 'sess-b' })
    assert.deepEqual(recipients(spy2), [])
  })

  it('receives no notification that names no session', async () => {
    manager.registerToken(GUEST, 'conn-1', { sessionId: 'sess-a' })
    const spy = fetchSpy()
    globalThis.fetch = spy
    await manager.send('billing_warning', 'T', 'B', { codes: ['x'] })
    assert.deepEqual(recipients(spy), [])
  })

  it('does not narrow, and is not widened by, other destinations', async () => {
    manager.registerToken(PHONE, 'host-conn') // the host\'s own device: everything
    manager.registerToken(GUEST, 'conn-1', { sessionId: 'sess-a' })
    const spy = fetchSpy()
    globalThis.fetch = spy
    await manager.send('permission', 'T', 'B', { sessionId: 'sess-b' })
    assert.deepEqual(recipients(spy), [PHONE])
  })

  it('a session-scoped connection cannot narrow-then-widen a token the host registered', async () => {
    manager.registerToken(PHONE, 'host-conn')
    manager.registerToken(PHONE, 'conn-1', { sessionId: 'sess-a' }) // same token, another owner
    const spy = fetchSpy()
    globalThis.fetch = spy
    await manager.send('permission', 'T', 'B', { sessionId: 'sess-b' })
    assert.deepEqual(recipients(spy), [PHONE], 'the host\'s own registration still stands')
  })

  it('a token held by two scoped connections receives both sessions', async () => {
    manager.registerToken(GUEST, 'conn-1', { sessionId: 'sess-a' })
    manager.registerToken(GUEST, 'conn-2', { sessionId: 'sess-b' })
    for (const sid of ['sess-a', 'sess-b']) {
      manager._lastSent.clear()
      const spy = fetchSpy()
      globalThis.fetch = spy
      await manager.send('permission', 'T', 'B', { sessionId: sid })
      assert.deepEqual(recipients(spy), [GUEST], sid)
    }
    manager._lastSent.clear()
    const spy = fetchSpy()
    globalThis.fetch = spy
    await manager.send('permission', 'T', 'B', { sessionId: 'sess-c' })
    assert.deepEqual(recipients(spy), [])
  })

  it('is gone with its connection', async () => {
    manager.registerToken(GUEST, 'conn-1', { sessionId: 'sess-a' })
    manager.releaseTokenOwner(GUEST, 'conn-1')
    assert.equal(manager.tokens.has(GUEST), false)
  })

  it('is not written to disk (it would come back without its scope)', () => {
    manager.registerToken(PHONE, 'host-conn')
    manager.registerToken(GUEST, 'conn-1', { sessionId: 'sess-a' })
    const saved = JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf-8'))
    assert.deepEqual(saved.tokens, [PHONE])
  })

  it('needs an owner', () => {
    assert.equal(manager.registerToken(GUEST, null, { sessionId: 'sess-a' }), false)
    assert.equal(manager.tokens.has(GUEST), false)
  })
})

describe('a destination restored from disk', () => {
  it('stays unscoped and stays registered when a session-scoped connection registers and leaves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-restored-'))
    try {
      writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ tokens: [PHONE], liveActivityTokens: [] }))
      const manager = new PushManager({ storagePath: join(dir, 'tokens.json') })
      manager.registerToken(PHONE, 'conn-1', { sessionId: 'sess-a' })
      const spy = fetchSpy()
      globalThis.fetch = spy
      await manager.send('permission', 'T', 'B', { sessionId: 'sess-b' })
      assert.deepEqual(recipients(spy), [PHONE], "the host's destination still receives every session")
      manager.releaseTokenOwner(PHONE, 'conn-1')
      assert.equal(manager.tokens.has(PHONE), true, 'and is not removed when that connection leaves')
    } finally {
      mock.restoreAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('register_push_token from a session-scoped connection', () => {
  function run(client) {
    const calls = []
    const ctx = {
      services: { pushManager: { registerToken: (...a) => { calls.push(a); return true }, touchDevice: () => {} } },
      transport: { send: () => {} },
    }
    inputHandlers.register_push_token({}, client, { token: GUEST }, ctx)
    return calls
  }

  it('limits the registration to the bound session', () => {
    assert.deepEqual(run({ id: 'c1', boundSessionId: 'sess-a' }), [[GUEST, 'c1', { sessionId: 'sess-a' }]])
  })

  it('treats an empty binding as scoped', () => {
    assert.deepEqual(run({ id: 'c1', boundSessionId: '' }), [[GUEST, 'c1', { sessionId: '' }]])
  })

  it('leaves an unscoped connection\'s registration unlimited', () => {
    assert.deepEqual(run({ id: 'c1' }), [[GUEST, 'c1', undefined]])
  })
})
