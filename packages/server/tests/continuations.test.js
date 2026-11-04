import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHttpHandler } from '../src/http-routes.js'
import { recordContinuation, listContinuations, CONTINUATION_TTL_MS } from '../src/continuations.js'
import { PushManager } from '../src/push.js'
import { WsServer } from '../src/ws-server.js'

const INGEST = 'fixture-ingest-credential'
const PRIMARY = 'fixture-primary-credential'

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
    writeFileSync(event.data.seedPath, 'replacement content with different size')
    await post()
    assert.equal((await (await get()).json()).continuations[0].unavailable, 'changed')
    assert.equal(listContinuations(server, event.ts + CONTINUATION_TTL_MS + 1)[0].unavailable, 'expired')
    unlinkSync(event.data.seedPath)
    assert.equal((await (await get()).json()).continuations[0].unavailable, 'missing')
  })
  it('retains missing paths as manual fallback and bounds daemon memory', async () => {
    const { event, post, get } = await setup()
    unlinkSync(event.data.seedPath)
    await post()
    assert.equal((await (await get()).json()).continuations[0].available, false)
    for (let i = 0; i < 60; i++) recordContinuation(server, { ...event, data: { ...event.data, seedPath: join(root, `${i}.md`) } })
    assert.equal(listContinuations(server).length, 50)
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
