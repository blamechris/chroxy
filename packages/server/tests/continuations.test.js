import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHttpHandler } from '../src/http-routes.js'
import { recordContinuation, listContinuations, createContinuationProbe, CONTINUATION_TTL_MS } from '../src/continuations.js'
import { PushManager } from '../src/push.js'
import { WsServer } from '../src/ws-server.js'

const INGEST = 'fixture-ingest-credential'
const PRIMARY = 'fixture-primary-credential'

it('initial metadata failure stays unavailable across replacement and replay until a newer announcement', async () => {
  const server = {}
  const ts = Date.now()
  const event = { source: 'session-seed', type: 'wave_complete', ts, data: { seedPath: '/vault/NEXT-demo.md', cwd: '/projects/demo' } }
  const initial = recordContinuation(server, event, ts, async () => null)
  await server._continuationRefresh
  assert.equal(initial.opportunity.fingerprint, null)
  assert.equal(initial.opportunity.baselineFailed, true)
  let laterProbes = 0
  const replacementProbe = async () => { laterProbes++; return { [initial.opportunity.id]: 'replacement-file' } }
  assert.equal((await listContinuations(server, ts, replacementProbe))[0].available, false)
  assert.equal(laterProbes, 0, 'a failed baseline must never adopt later metadata')
  assert.equal(recordContinuation(server, event, ts, replacementProbe).duplicate, true)
  assert.equal((await listContinuations(server, ts, replacementProbe))[0].unavailable, 'metadata timeout')
  assert.equal(laterProbes, 0, 'same-ts replay cannot revive an initial failure')
  assert.equal(recordContinuation(server, { ...event, ts: ts + 1 }, ts + 1, replacementProbe).duplicate, false)
  await server._continuationRefresh
  assert.equal((await listContinuations(server, ts + 1, replacementProbe))[0].available, true)
  assert.equal(server._continuations.get(initial.opportunity.id).fingerprint, 'replacement-file')
})

it('an established metadata baseline recovers from timeout only when the original fingerprint matches', async () => {
  const server = {}
  const ts = Date.now()
  const event = { source: 'session-seed', type: 'wave_complete', ts, data: { seedPath: '/vault/NEXT-demo.md', cwd: '/projects/demo' } }
  const initial = recordContinuation(server, event, ts, async (entries) => ({ [entries[0].id]: 'original-file' }))
  await server._continuationRefresh
  assert.equal((await listContinuations(server, ts, async () => null))[0].unavailable, 'metadata timeout')
  assert.equal((await listContinuations(server, ts, async () => ({ [initial.opportunity.id]: 'original-file' })))[0].available, true)
  assert.equal((await listContinuations(server, ts, async () => ({ [initial.opportunity.id]: 'replacement-file' })))[0].unavailable, 'changed')
})

it('an announcement excluded from an already-running batch cannot acquire its baseline later', async () => {
  const server = {}
  const ts = Date.now()
  const event = { source: 'session-seed', type: 'wave_complete', ts, data: { seedPath: '/vault/NEXT-one.md', cwd: '/projects/demo' } }
  let finish
  const first = recordContinuation(server, event, ts, () => new Promise((resolve) => { finish = resolve }))
  const second = recordContinuation(server, { ...event, data: { ...event.data, seedPath: '/vault/NEXT-two.md' } }, ts)
  assert.equal(second.opportunity.baselineFailed, true)
  finish({ [first.opportunity.id]: 'first-file' })
  await server._continuationRefresh
  const result = await listContinuations(server, ts, async (entries) => {
    assert.deepEqual(entries.map((entry) => entry.id), [first.opportunity.id])
    return { [first.opportunity.id]: 'first-file', [second.opportunity.id]: 'replacement-file' }
  })
  assert.equal(result.find((item) => item.id === second.opportunity.id).available, false)
})

describe('seed continuation HTTP flow', () => {
  let http, root, server
  afterEach(async () => {
    http?.closeAllConnections()
    if (http) await new Promise((resolve) => http.close(resolve))
    if (root) rmSync(root, { recursive: true, force: true })
  })
  async function setup() {
    root = mkdtempSync(join(tmpdir(), 'continuation-'))
    const seedPath = join(root, 'NEXT-demo.md')
    writeFileSync(seedPath, 'PRIVATE CONTENT MUST NEVER BE RETURNED')
    const sends = []
    server = {
      _ingestSecret: INGEST,
      authRequired: true,
      _isTokenValid: (token) => [PRIMARY, 'fixture-session-bound'].includes(token),
      _pairingManager: { isSessionTokenValid: (token) => token === 'fixture-session-bound' },
      pushManager: { send: (...args) => { sends.push(args); return Promise.resolve(true) } },
      _validatePrimaryBearerAuth: WsServer.prototype._validatePrimaryBearerAuth,
    }
    http = createServer(createHttpHandler(server))
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const base = `http://127.0.0.1:${http.address().port}`
    const event = { source: 'session-seed', type: 'wave_complete', ts: Date.now(), data: { seedPath, cwd: root } }
    return {
      event, sends,
      post: (body = event, token = INGEST) => fetch(`${base}/api/events`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
      get: (token = PRIMARY) => fetch(`${base}/api/continuations`, { headers: { Authorization: `Bearer ${token}` } }),
    }
  }
  it('announces once and returns paths only to the primary reader', async () => {
    const { event, sends, post, get } = await setup()
    assert.equal((await post(event, PRIMARY)).status, 401)
    assert.equal((await get(INGEST)).status, 403)
    assert.equal((await get('fixture-session-bound')).status, 403)
    assert.equal((await post()).status, 200)
    assert.equal((await post()).status, 200)
    const response = await get()
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const { continuations } = await response.json()
    assert.equal(continuations.length, 1)
    assert.equal(continuations[0].available, true)
    assert.equal(continuations[0].seedPath, event.data.seedPath)
    assert.equal(continuations[0].cwd, root)
    assert.equal(JSON.stringify(continuations).includes('PRIVATE CONTENT'), false)
    assert.equal(sends.length, 1)
    assert.equal(sends[0][0], 'continuation')
    assert.equal(sends[0][4], 'continuation')
    assert.deepEqual(sends[0][3], event.data)
  })
  it('rejects wrong source, absent/relative/control/oversized paths and seed content', async () => {
    const { event, post, sends } = await setup()
    for (const body of [
      { ...event, source: 'other' }, { ...event, type: 'stop' }, { ...event, data: {} },
      ...['relative.md', '/bad\npath', 'x'.repeat(4097)].map((seedPath) => ({ ...event, data: { ...event.data, seedPath } })),
      { ...event, data: { ...event.data, seedContent: 'must not be accepted' } },
    ]) assert.equal((await post(body)).status, 400)
    assert.equal(sends.length, 0)
  })
  it('marks changed/deleted/expired seeds unavailable; retries never adopt replacements', async () => {
    const { event, post, get } = await setup()
    await post()
    await (await get()).json()
    writeFileSync(event.data.seedPath, 'replacement content with different size')
    await post()
    assert.equal((await (await get()).json()).continuations[0].unavailable, 'changed')
    assert.equal((await listContinuations(server, event.ts + CONTINUATION_TTL_MS + 1))[0].unavailable, 'expired')
    unlinkSync(event.data.seedPath)
    assert.equal((await (await get()).json()).continuations[0].unavailable, 'missing')
  })
  it('retains missing paths as manual fallback and bounds daemon memory', async () => {
    const { event, post, get } = await setup()
    unlinkSync(event.data.seedPath)
    await post()
    assert.equal((await (await get()).json()).continuations[0].available, false)
    for (let i = 0; i < 60; i++) recordContinuation(server, { ...event, data: { ...event.data, seedPath: join(root, `${i}.md`) } })
    assert.equal((await listContinuations(server)).length, 50)
  })
  it('isolates slow metadata with a deadline and concurrency bound while HTTP and timers stay responsive', async () => {
    const { event, post, get } = await setup()
    await post()
    await (await get()).json()
    const slowWorker = join(root, 'slow-worker.cjs')
    writeFileSync(slowWorker, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)')
    const probe = createContinuationProbe({ workerPath: slowWorker, timeoutMs: 150 })
    const pending = listContinuations(server, Date.now(), probe)
    assert.equal(await probe([{ id: 'second', ...event.data }]), null, 'only one child can be active')
    let timerFired = false
    const timer = setTimeout(() => { timerFired = true }, 0)
    const started = Date.now()
    assert.equal((await get('fixture-denied')).status, 403, 'daemon HTTP responds during stalled stat')
    const result = await pending
    clearTimeout(timer)
    assert.equal(timerFired, true, 'main event loop runs while child is blocked')
    assert.ok(Date.now() - started < 1000, 'child has an enforceable wall-clock deadline')
    assert.equal(result[0].unavailable, 'metadata timeout')
    const expiredResult = await listContinuations(server, event.ts + CONTINUATION_TTL_MS + 1,
      () => { assert.fail('expired seeds and cwd must never be probed') })
    assert.equal(expiredResult[0].unavailable, 'expired')
  })
})

it('continuation category can be muted and respects quiet hours by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'continuation-prefs-'))
  const originalFetch = globalThis.fetch
  const deliveries = []
  const manager = new PushManager({ storagePath: join(root, 'tokens.json'), now: () => Date.parse('2026-10-01T23:00:00Z'), discord: { resolveWebhookUrl: () => null } })
  try {
    manager.registerToken('ExponentPushToken[continuation-fixture]')
    globalThis.fetch = async (...args) => { deliveries.push(args); return { ok: true, json: async () => ({ data: [] }) } }
    manager.setPrefs({ categories: { continuation: false } })
    assert.equal(manager.getPrefs().categories.continuation, false)
    await manager.send('continuation', 'Wave complete', 'ready', {}, 'continuation')
    assert.equal(deliveries.length, 0)
    manager.setPrefs({ categories: { continuation: true }, quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' } })
    await manager.send('continuation', 'Wave complete', 'ready', {}, 'continuation')
    assert.equal(deliveries.length, 0)
    manager.setPrefs({ quietHours: null })
    await manager.send('continuation', 'Wave complete', 'ready', {}, 'continuation')
    assert.equal(deliveries.length, 1, 'positive control: unmuted continuation delivers')
  } finally { globalThis.fetch = originalFetch; manager.destroy(); rmSync(root, { recursive: true, force: true }) }
})
