// #5413 Phase 3: POST /api/events — external event ingest.
//
// Pins:
//   - auth: ONLY the daemon-level ingest secret (constant-time compared);
//     missing/wrong token → 401 with no body detail; secret-unavailable
//     fails closed; the raw token never validates against anything else
//   - body handling: 64KB cap → 413, bad JSON → 400, schema violations →
//     400 with field-level details
//   - per-source rate limiting → 429 + Retry-After
//   - happy path → 200 and PushManager.send called with the mapped
//     category + explicit project carried into notification data
//   - cwd → git-root project derivation (no shell-outs, temp dirs)
//   - ingest secret provisioning: 0600 on disk, stable across loads
//
// All state paths are temp dirs (#4633 sandbox guard applies).

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpHandler } from '../src/http-routes.js'
import {
  loadOrCreateIngestSecret,
  defaultIngestSecretPath,
  deriveProjectFromCwd,
  handleEventIngest,
  ingestEventClass,
  INGEST_CATEGORY_FOR_TYPE,
  MAX_INGEST_BODY_BYTES,
} from '../src/event-ingest.js'
import { INGEST_EVENT_TYPES } from '@chroxy/protocol'
import { RateLimiter } from '../src/rate-limiter.js'

const SECRET = 'test-ingest-secret-0123456789abcdef'
const VALID_TS = 1_750_000_000_000

function makePushManager() {
  const calls = []
  return {
    calls,
    hasConfiguredSinks: () => true,
    send: (category, title, body, data) => {
      calls.push({ category, title, body, data })
      return Promise.resolve(true)
    },
  }
}

function createMockServer(overrides = {}) {
  return {
    apiToken: 'primary-token',
    authRequired: true,
    serverMode: 'multi',
    port: 0,
    _latestVersion: null,
    _gitInfo: { commit: 'abc', branch: 'main' },
    _startedAt: Date.now(),
    _encryptionEnabled: false,
    _permissions: {
      handlePermissionRequest: (_req, res) => { res.writeHead(200); res.end('ok') },
      handlePermissionResponseHttp: (_req, res) => { res.writeHead(200); res.end('ok') },
    },
    _isTokenValid(token) { return token === this.apiToken },
    _validateBearerAuth(req, res) {
      const authHeader = req.headers['authorization'] || ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
      if (!token || !this._isTokenValid(token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return false
      }
      return true
    },
    _ingestSecret: SECRET,
    pushManager: makePushManager(),
    ...overrides,
  }
}

function validEvent(overrides = {}) {
  return {
    source: 'claude-hooks',
    project: 'myproject',
    type: 'session_start',
    ts: VALID_TS,
    ...overrides,
  }
}

describe('event-ingest', () => {
  let httpServer
  let port
  let mockServer

  async function startWith(server) {
    mockServer = server
    httpServer = createServer(createHttpHandler(server))
    httpServer.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    port = httpServer.address().port
    return port
  }

  afterEach(() => {
    httpServer?.close()
    httpServer = null
  })

  function post(body, { token = SECRET, headers = {} } = {}) {
    const h = { 'Content-Type': 'application/json', ...headers }
    if (token !== null) h['Authorization'] = `Bearer ${token}`
    return globalThis.fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: h,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  describe('auth (fail closed)', () => {
    it('401 with no body detail when the Authorization header is missing', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent(), { token: null })
      assert.equal(res.status, 401)
      assert.equal(await res.text(), '', 'no body detail on auth failure')
      assert.equal(mockServer.pushManager.calls.length, 0)
    })

    it('401 on a wrong token (constant-time compare path)', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent(), { token: 'wrong-secret' })
      assert.equal(res.status, 401)
      assert.equal(await res.text(), '')
      assert.equal(mockServer.pushManager.calls.length, 0)
    })

    it('401 for the PRIMARY API token — full-authority tokens are not accepted here', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent(), { token: 'primary-token' })
      assert.equal(res.status, 401)
      assert.equal(mockServer.pushManager.calls.length, 0)
    })

    it('fails closed (401 for everyone) when the secret cannot be loaded', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ingest-'))
      // Park a FILE where the parent directory should be, so mkdirSync of
      // the secret's dirname throws (ENOTDIR) and no secret can exist.
      writeFileSync(join(dir, 'blocker'), '')
      const badPath = join(dir, 'blocker', 'ingest-secret')
      await startWith(createMockServer({ _ingestSecret: undefined, _ingestSecretPath: badPath }))
      const res = await post(validEvent(), { token: 'anything' })
      assert.equal(res.status, 401)
    })

    it('lazily provisions the secret file on first request when only a path is configured', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ingest-'))
      const secretPath = join(dir, 'ingest-secret')
      await startWith(createMockServer({ _ingestSecret: undefined, _ingestSecretPath: secretPath }))
      // Unauthenticated probe — rejected, but the secret now exists on disk
      // so a hook emitter can read it and succeed on its next event.
      const res = await post(validEvent(), { token: 'nope' })
      assert.equal(res.status, 401)
      assert.ok(existsSync(secretPath), 'secret file provisioned')
      const secret = readFileSync(secretPath, 'utf-8').trim()
      const res2 = await post(validEvent(), { token: secret })
      assert.equal(res2.status, 200)
    })
  })

  describe('body validation', () => {
    it('413 on an oversized body', async () => {
      await startWith(createMockServer())
      const big = JSON.stringify(validEvent({ project: 'x'.repeat(MAX_INGEST_BODY_BYTES) }))
      // #5433: the 413 must actually be DELIVERED — no reset hedge. A
      // connection reset rejects fetch() and fails the test.
      const res = await post(big)
      assert.equal(res.status, 413)
      assert.equal(mockServer.pushManager.calls.length, 0)
    })

    it('400 on invalid JSON', async () => {
      await startWith(createMockServer())
      const res = await post('{not json')
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.error, 'invalid JSON')
    })

    it('400 with field-level details on an unknown type', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({ type: 'mystery_event' }))
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.error, 'invalid event')
      assert.ok(body.details.some((d) => d.startsWith('type:')), `details name the field: ${body.details}`)
    })

    it('400 on an oversized string field', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({ source: 's'.repeat(65) }))
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.ok(body.details.some((d) => d.startsWith('source:')))
    })

    it('400 on unknown top-level keys (strict envelope)', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({ surprise: true }))
      assert.equal(res.status, 400)
    })

    it('400 on out-of-bounds ts', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({ ts: 1_750_000_000 })) // seconds, not ms
      assert.equal(res.status, 400)
    })
  })

  describe('rate limiting (per source)', () => {
    // #5675: the pre-seeded `_ingestRateLimiter` is now the KEEPALIVE bucket,
    // so this exercises post_tool_use (the only keepalive type). The pre-seed
    // knob (ws-server / tighter test knobs) keeps working.
    it('429 with Retry-After once a source exceeds its keepalive bucket', async () => {
      const server = createMockServer({
        _ingestRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 2, burst: 0, name: 'ingest-test' }),
      })
      await startWith(server)
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 200)
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 200)
      const res = await post(validEvent({ type: 'post_tool_use' }))
      assert.equal(res.status, 429)
      assert.ok(res.headers.get('retry-after'), 'Retry-After header present')
      const body = await res.json()
      assert.equal(body.error, 'rate limited')
    })

    it('rate-limit buckets are per source — another source still passes', async () => {
      const server = createMockServer({
        _ingestRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 1, burst: 0, name: 'ingest-test' }),
      })
      await startWith(server)
      assert.equal((await post(validEvent({ source: 'hooks-a', type: 'post_tool_use' }))).status, 200)
      assert.equal((await post(validEvent({ source: 'hooks-a', type: 'post_tool_use' }))).status, 429)
      assert.equal((await post(validEvent({ source: 'hooks-b', type: 'post_tool_use' }))).status, 200)
    })

    // #5432 review S1/S2 — the per-source buckets are keyed on a
    // caller-chosen string, so the pre-auth per-IP ceiling is the hard
    // total: rotating `source` per request must NOT mint unlimited fresh
    // buckets.
    it('pre-auth per-IP ceiling caps rotating-source abuse', async () => {
      const server = createMockServer({
        _ingestIpRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 2, burst: 0, name: 'ingest-ip-test' }),
      })
      await startWith(server)
      assert.equal((await post(validEvent({ source: 'spin-a' }))).status, 200)
      assert.equal((await post(validEvent({ source: 'spin-b' }))).status, 200)
      // Third request: fresh per-source bucket, but the IP ceiling fires.
      const res = await post(validEvent({ source: 'spin-c' }))
      assert.equal(res.status, 429)
      assert.ok(res.headers.get('retry-after'))
    })

    it('the per-IP limit fires BEFORE auth (cheap 429s for brute-force probing)', async () => {
      const server = createMockServer({
        _ingestIpRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 1, burst: 0, name: 'ingest-ip-test' }),
      })
      await startWith(server)
      assert.equal((await post(validEvent())).status, 200)
      // Exhausted bucket + WRONG token → 429, not 401: the limiter gates
      // the auth check itself.
      const res = await post(validEvent(), { token: 'wrong-token' })
      assert.equal(res.status, 429)
    })
  })

  // #5675: the per-source bucket is split by event class so a flood of
  // droppable `post_tool_use` keepalives can't starve the must-deliver
  // transition events (stop, subagent_stop, notification, ...).
  describe('rate limiting (class split #5675)', () => {
    // The core regression: flood the keepalive bucket until it 429s, then
    // assert must-deliver transitions still pass — proving the priority
    // inversion is fixed.
    it('a keepalive flood does NOT starve must-deliver transitions', async () => {
      const server = createMockServer({
        // Tiny keepalive bucket so a short flood exhausts it; generous
        // lifecycle bucket left to lazy default (300/min + 60 burst).
        _ingestRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 3, burst: 0, name: 'keepalive-test' }),
      })
      await startWith(server)
      // Flood post_tool_use until the keepalive bucket 429s.
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 200)
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 200)
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 200)
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 429, 'keepalive bucket exhausted')
      // The must-deliver transitions still pass — independent bucket.
      assert.equal((await post(validEvent({ type: 'stop' }))).status, 200, 'stop still delivered')
      assert.equal((await post(validEvent({ type: 'subagent_stop', sessionId: 's1' }))).status, 200, 'subagent_stop still delivered')
      assert.equal((await post(validEvent({ type: 'notification' }))).status, 200, 'notification still delivered')
    })

    it('exhausting the lifecycle bucket does NOT 429 keepalives', async () => {
      const server = createMockServer({
        // Generous keepalive bucket; tiny lifecycle bucket.
        _ingestRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 100, burst: 0, name: 'keepalive-test' }),
        _ingestLifecycleRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 1, burst: 0, name: 'lifecycle-test' }),
      })
      await startWith(server)
      assert.equal((await post(validEvent({ type: 'stop' }))).status, 200)
      assert.equal((await post(validEvent({ type: 'stop' }))).status, 429, 'lifecycle bucket exhausted')
      // Keepalives sail through their own bucket regardless.
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 200)
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 200)
    })

    it('exhausting the keepalive bucket does NOT 429 lifecycle events', async () => {
      const server = createMockServer({
        _ingestRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 1, burst: 0, name: 'keepalive-test' }),
        _ingestLifecycleRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 100, burst: 0, name: 'lifecycle-test' }),
      })
      await startWith(server)
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 200)
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 429, 'keepalive bucket exhausted')
      // Lifecycle events pass through their own bucket.
      assert.equal((await post(validEvent({ type: 'session_start' }))).status, 200)
      assert.equal((await post(validEvent({ type: 'subagent_start', sessionId: 's1' }))).status, 200)
    })

    it('the per-IP ceiling still applies regardless of class', async () => {
      const server = createMockServer({
        _ingestIpRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 2, burst: 0, name: 'ingest-ip-test' }),
        // Generous class buckets so only the IP ceiling can fire.
        _ingestRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 100, burst: 0, name: 'keepalive-test' }),
        _ingestLifecycleRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 100, burst: 0, name: 'lifecycle-test' }),
      })
      await startWith(server)
      assert.equal((await post(validEvent({ type: 'stop' }))).status, 200)
      assert.equal((await post(validEvent({ type: 'post_tool_use' }))).status, 200)
      // Third request across either class is capped by the IP ceiling.
      assert.equal((await post(validEvent({ type: 'stop' }))).status, 429, 'IP ceiling fires across classes')
    })
  })

  describe('ingestEventClass (#5675)', () => {
    it('maps post_tool_use to keepalive', () => {
      assert.equal(ingestEventClass('post_tool_use'), 'keepalive')
    })

    it('maps every must-deliver transition type to lifecycle', () => {
      for (const type of [
        'session_start', 'session_end', 'subagent_start', 'subagent_stop',
        'notification', 'user_prompt_submit', 'stop',
      ]) {
        assert.equal(ingestEventClass(type), 'lifecycle', `${type} should be lifecycle`)
      }
    })

    it('defaults unknown/new types to lifecycle (fail safe — never silently drop)', () => {
      assert.equal(ingestEventClass('some_future_type'), 'lifecycle')
      assert.equal(ingestEventClass(''), 'lifecycle')
      assert.equal(ingestEventClass(undefined), 'lifecycle')
    })

    it('covers the full ingest enum (no protocol type lands as keepalive by accident)', () => {
      for (const type of INGEST_EVENT_TYPES) {
        const cls = ingestEventClass(type)
        if (type === 'post_tool_use') assert.equal(cls, 'keepalive')
        else assert.equal(cls, 'lifecycle', `${type} should be lifecycle`)
      }
    })
  })

  describe('source charset (#5432 review S3)', () => {
    it('rejects sources with newlines / ANSI / spaces (log-injection guard)', async () => {
      await startWith(createMockServer())
      for (const source of ['evil\nsource', 'a\u001b[31mred', 'has space', '-leading-separator']) {
        const res = await post(validEvent({ source }))
        assert.equal(res.status, 400, `source ${JSON.stringify(source)} must be rejected`)
      }
      // The legitimate shapes still pass.
      assert.equal((await post(validEvent({ source: 'claude-hooks_v2.1' }))).status, 200)
    })
  })

  describe('pipeline dispatch', () => {
    it('200 happy path — send() called with the mapped category and explicit project', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({ sessionId: 'ext-1', data: { tool: 'Bash' } }))
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body, { ok: true, category: 'session_online', project: 'myproject' })
      assert.equal(mockServer.pushManager.calls.length, 1)
      const call = mockServer.pushManager.calls[0]
      assert.equal(call.category, 'session_online')
      assert.equal(call.data.project, 'myproject')
      assert.equal(call.data.sessionId, 'ext-1')
      assert.equal(call.data.source, 'claude-hooks')
      assert.equal(call.data.tool, 'Bash')
      assert.equal(call.data.external, true)
    })

    it('maps every schema event type onto a category', async () => {
      for (const type of INGEST_EVENT_TYPES) {
        assert.ok(INGEST_CATEGORY_FOR_TYPE[type], `category mapping for ${type}`)
      }
      await startWith(createMockServer())
      const expected = {
        session_start: 'session_online',
        session_end: 'session_offline',
        subagent_start: 'session_activity',
        subagent_stop: 'session_activity',
        notification: 'activity_waiting',
        post_tool_use: 'session_activity',
        // #5541 turn edges
        user_prompt_submit: 'session_activity',
        stop: 'activity_update',
      }
      for (const [type, category] of Object.entries(expected)) {
        const res = await post(validEvent({ type, source: `src-${type}` }))
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.equal(body.category, category, `${type} → ${category}`)
      }
    })

    // #5439 GAP A — both directions pinned: idle_prompt must ride the
    // activity_update category (Discord sink: `idle` embed, 🦀 "Ready for
    // input", idle→idle dedup), while permission_prompt (and a missing
    // discriminator) stays activity_waiting (🔐 "Needs Approval" ping).
    it('notification + notificationType=idle_prompt maps to activity_update (idle embed)', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({
        type: 'notification',
        data: { notificationType: 'idle_prompt' },
      }))
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.category, 'activity_update')
      const call = mockServer.pushManager.calls[0]
      assert.equal(call.category, 'activity_update')
      assert.equal(call.title, 'Ready for input')
    })

    it('notification + notificationType=permission_prompt stays activity_waiting', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({
        type: 'notification',
        data: { notificationType: 'permission_prompt' },
      }))
      assert.equal(res.status, 200)
      assert.equal((await res.json()).category, 'activity_waiting')
      assert.equal(mockServer.pushManager.calls[0].category, 'activity_waiting')
    })

    it('notification without a notificationType stays activity_waiting (back-compat)', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({ type: 'notification' }))
      assert.equal(res.status, 200)
      assert.equal((await res.json()).category, 'activity_waiting')
    })

    it('derives project from data.cwd (git-root walk) when project is absent', async () => {
      const repo = mkdtempSync(join(tmpdir(), 'ingest-repo-'))
      mkdirSync(join(repo, '.git'))
      const nested = join(repo, 'packages', 'server', 'src')
      mkdirSync(nested, { recursive: true })
      await startWith(createMockServer())
      const event = validEvent({ data: { cwd: nested } })
      delete event.project
      const res = await post(event)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.project, repo.split('/').pop())
      assert.equal(mockServer.pushManager.calls[0].data.project, repo.split('/').pop())
    })

    it('uses data.title / data.message as the notification text when provided', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({
        type: 'notification',
        data: { title: 'Custom title', message: 'Claude needs permission to run Bash' },
      }))
      assert.equal(res.status, 200)
      const call = mockServer.pushManager.calls[0]
      assert.equal(call.title, 'Custom title')
      assert.equal(call.body, 'Claude needs permission to run Bash')
    })

    // #5541 turn edges — authoritative turn START / END.
    it('user_prompt_submit → session_activity (online) and sets turnInFlight on the dispatch', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({
        type: 'user_prompt_submit',
        sessionId: 'ext-turn',
        data: { cwd: '/x' },
      }))
      assert.equal(res.status, 200)
      assert.equal((await res.json()).category, 'session_activity')
      const call = mockServer.pushManager.calls[0]
      assert.equal(call.category, 'session_activity')
      assert.equal(call.data.turnInFlight, true, 'turn-in-flight flag plumbed to the sink')
      assert.equal(call.data.project, 'myproject')
    })

    it('stop → activity_update (idle, "Ready for input") and clears turnInFlight', async () => {
      await startWith(createMockServer())
      // Start a turn first, then stop it.
      await post(validEvent({ type: 'user_prompt_submit', sessionId: 'ext-turn', data: { cwd: '/x' } }))
      const res = await post(validEvent({ type: 'stop', sessionId: 'ext-turn', data: { cwd: '/x' } }))
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.category, 'activity_update')
      const stopCall = mockServer.pushManager.calls[1]
      assert.equal(stopCall.category, 'activity_update')
      assert.equal(stopCall.title, 'Ready for input')
      assert.equal(stopCall.data.turnInFlight, false, 'stop clears the turn-in-flight flag')
    })

    it('turnInFlight is per project — a subagent event mid-turn reports the project busy', async () => {
      await startWith(createMockServer())
      await post(validEvent({ type: 'user_prompt_submit', sessionId: 'main', project: 'p', data: { cwd: '/x' } }))
      const res = await post(validEvent({ type: 'subagent_start', sessionId: 'main', project: 'p', data: { cwd: '/x' } }))
      assert.equal(res.status, 200)
      const call = mockServer.pushManager.calls[mockServer.pushManager.calls.length - 1]
      assert.equal(call.data.turnInFlight, true, 'subagent_start while a turn is in flight reports turnInFlight')
      assert.equal(call.data.subagents, 1)
    })

    it('no turn in flight → turnInFlight is false (daemon-restart / steady-state default)', async () => {
      await startWith(createMockServer())
      const res = await post(validEvent({ type: 'subagent_start', sessionId: 's', project: 'p', data: { cwd: '/x' } }))
      assert.equal(res.status, 200)
      const call = mockServer.pushManager.calls[0]
      assert.equal(call.data.turnInFlight, false)
    })

    it('503 when no pushManager is wired', async () => {
      await startWith(createMockServer({ pushManager: null }))
      const res = await post(validEvent())
      assert.equal(res.status, 503)
    })

    it('a sink hard-failure does not change the 200 (fire-and-forget dispatch)', async () => {
      const server = createMockServer({
        pushManager: { hasConfiguredSinks: () => true, send: () => Promise.resolve(false) },
      })
      await startWith(server)
      const res = await post(validEvent())
      assert.equal(res.status, 200)
    })
  })

  describe('handleEventIngest direct invocation', () => {
    it('is exported for reuse and rejects without req/res games', async () => {
      assert.equal(typeof handleEventIngest, 'function')
    })
  })
})

describe('loadOrCreateIngestSecret', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-secret-'))
  })

  it('creates the secret 0600 with base64url content and is stable across loads', () => {
    const secretPath = join(dir, 'sub', 'ingest-secret')
    const secret = loadOrCreateIngestSecret(secretPath)
    assert.match(secret, /^[A-Za-z0-9_-]{40,}$/, 'base64url, 32 bytes')
    const mode = statSync(secretPath).mode & 0o777
    assert.equal(mode, 0o600, 'secret file is 0600')
    assert.equal(loadOrCreateIngestSecret(secretPath), secret, 'second load returns the same secret')
  })

  it('reads an existing secret (trimmed) instead of regenerating', () => {
    const secretPath = join(dir, 'ingest-secret')
    writeFileSync(secretPath, 'pre-seeded-secret\n')
    assert.equal(loadOrCreateIngestSecret(secretPath), 'pre-seeded-secret')
  })

  it('regenerates over an empty file', () => {
    const secretPath = join(dir, 'ingest-secret')
    writeFileSync(secretPath, '')
    const secret = loadOrCreateIngestSecret(secretPath)
    assert.ok(secret.length >= 40)
  })

  it('default path lives under the config dir (CHROXY_CONFIG_DIR honored)', () => {
    const prev = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = dir
    try {
      assert.equal(defaultIngestSecretPath(), join(dir, 'ingest-secret'))
    } finally {
      if (prev === undefined) delete process.env.CHROXY_CONFIG_DIR
      else process.env.CHROXY_CONFIG_DIR = prev
    }
  })
})

describe('deriveProjectFromCwd', () => {
  it('returns the basename of the nearest dir containing .git (directory)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'proj-'))
    mkdirSync(join(repo, '.git'))
    const nested = join(repo, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    assert.equal(deriveProjectFromCwd(nested), repo.split('/').pop())
  })

  it('treats a .git FILE as a git root (worktrees)', () => {
    const wt = mkdtempSync(join(tmpdir(), 'wt-'))
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere/else\n')
    const nested = join(wt, 'src')
    mkdirSync(nested)
    assert.equal(deriveProjectFromCwd(nested), wt.split('/').pop())
  })

  it('prefers the NEAREST .git when nested repos exist', () => {
    const outer = mkdtempSync(join(tmpdir(), 'outer-'))
    mkdirSync(join(outer, '.git'))
    const inner = join(outer, 'vendor', 'innerrepo')
    mkdirSync(join(inner, '.git'), { recursive: true })
    assert.equal(deriveProjectFromCwd(join(inner)), 'innerrepo')
  })

  it('falls back to basename(cwd) when no .git is found', () => {
    const plain = mkdtempSync(join(tmpdir(), 'plain-'))
    const nested = join(plain, 'deep')
    mkdirSync(nested)
    assert.equal(deriveProjectFromCwd(nested), 'deep')
  })

  it('returns null for unusable input', () => {
    assert.equal(deriveProjectFromCwd(''), null)
    assert.equal(deriveProjectFromCwd(null), null)
    assert.equal(deriveProjectFromCwd(42), null)
  })

  it('does not throw on a nonexistent path (still walks the string)', () => {
    assert.equal(deriveProjectFromCwd('/nonexistent/zzz/abc'), 'abc')
  })
})
