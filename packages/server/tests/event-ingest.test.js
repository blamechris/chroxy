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

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync, chmodSync, symlinkSync, chownSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createHttpHandler } from '../src/http-routes.js'
import {
  loadOrCreateIngestSecret,
  defaultIngestSecretPath,
  handleEventIngest,
  ingestEventClass,
  INGEST_CATEGORY_FOR_TYPE,
  MAX_INGEST_BODY_BYTES,
} from '../src/event-ingest.js'
import { INGEST_EVENT_TYPES } from '@chroxy/protocol'
// deriveProjectFromCwd moved to the shared module (audit P2-2, #5850); the
// server now imports it from here too.
import { deriveProjectFromCwd } from '@chroxy/protocol/project'
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
      assert.equal(body.project, basename(repo))
      assert.equal(mockServer.pushManager.calls[0].data.project, basename(repo))
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
    // #7401 — left as assert.match deliberately: the subject is a file this test just wrote (a single ~43-char secret line).
    assert.match(secret, /^[A-Za-z0-9_-]{40,}$/, 'base64url, 32 bytes')
    const mode = statSync(secretPath).mode & 0o777
    assert.equal(mode, 0o600, 'secret file is 0600')
    assert.equal(loadOrCreateIngestSecret(secretPath), secret, 'second load returns the same secret')
  })

  it('reads an existing secret (trimmed) instead of regenerating', () => {
    const secretPath = join(dir, 'ingest-secret')
    // #7246: mode 0600 explicitly — loadOrCreateIngestSecret now re-checks the
    // mode on every existing-file read, so a "pre-seeded" fixture must be
    // written the way a legitimate secret actually lands on disk.
    writeFileSync(secretPath, 'pre-seeded-secret\n', { mode: 0o600 })
    assert.equal(loadOrCreateIngestSecret(secretPath), 'pre-seeded-secret')
  })

  it('regenerates over an empty file', () => {
    const secretPath = join(dir, 'ingest-secret')
    // #7246: same as above — 0600 so the empty-file recovery path is reached
    // (an empty file with the WRONG mode should refuse, not recover; that
    // boundary is covered below).
    writeFileSync(secretPath, '', { mode: 0o600 })
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

// #7246: ingest-secret set 0600 at exclusive create but never re-checked the
// mode on an existing-file read — a pre-existing or later-widened file was
// trusted regardless of its permissions. This mirrors the read-path boundary
// session-token-store.js (session-tokens.json) and credential-store.js
// (credentials.json) already enforce: refuse rather than warn-and-repair.
describe('loadOrCreateIngestSecret — #7246 mode re-check on read (fail-closed)', () => {
  let dir
  let secretPath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-secret-mode-'))
    secretPath = join(dir, 'ingest-secret')
  })

  it('refuses to read an existing secret with a widened (0644) mode', { skip: process.platform === 'win32' }, () => {
    writeFileSync(secretPath, 'widened-secret\n', { mode: 0o600 })
    chmodSync(secretPath, 0o644)
    assert.throws(
      () => loadOrCreateIngestSecret(secretPath),
      /has mode 644; refusing to read \(must be 0600\)/,
      'a 0644 ingest-secret must be refused, not silently trusted'
    )
  })

  it('refuses to read an existing secret with a NARROWER (0400) mode too — the boundary is exactly 0600', { skip: process.platform === 'win32' }, () => {
    // The mode check compares with `!==`, not `>` — narrower is not "safer" by
    // the letter of the contract (docs/security/bearer-token-authority.md and
    // the sibling stores all require exactly 0600), and a `perms > 0o600`
    // mutant silently accepts this case while still refusing every widened
    // one above, so it must be asserted on its own.
    writeFileSync(secretPath, 'narrowed-secret\n', { mode: 0o600 })
    chmodSync(secretPath, 0o400)
    assert.throws(
      () => loadOrCreateIngestSecret(secretPath),
      /has mode 400; refusing to read \(must be 0600\)/,
      'a 0400 ingest-secret must be refused too — the rule is EXACTLY 0600, not "no wider than 0600"'
    )
  })

  it('refuses a symlink whose resolved target carries a widened mode', { skip: process.platform === 'win32' }, () => {
    const targetPath = join(dir, 'real-secret')
    writeFileSync(targetPath, 'target-secret\n', { mode: 0o600 })
    chmodSync(targetPath, 0o640) // group-readable — still wrong, not just world-readable
    symlinkSync(targetPath, secretPath)
    assert.throws(
      () => loadOrCreateIngestSecret(secretPath),
      /has mode 640; refusing to read \(must be 0600\)/,
      'statSync follows the link, so the TARGET mode is what gets enforced'
    )
  })

  it('refuses an existing secret owned by another uid', { skip: typeof process.getuid !== 'function' }, () => {
    // A foreign-owned file can't be built as a normal user (no chown), so this
    // exercises the comparison from the other side, matching
    // stale-session-dirs.test.js's "refuses a base owned by another uid":
    // a file we own looks foreign to a process claiming a different uid.
    writeFileSync(secretPath, 'owned-by-someone-else\n', { mode: 0o600 })
    const realGetuid = process.getuid
    const realUid = realGetuid.call(process)
    process.getuid = () => realUid + 1
    try {
      assert.throws(
        () => loadOrCreateIngestSecret(secretPath),
        new RegExp(`is owned by uid ${realUid} rather than uid ${realUid + 1}; refusing to read`),
        'a same-mode file owned by a different uid must still be refused'
      )
    } finally {
      process.getuid = realGetuid
    }
  })

  // Regression guard for the specific `if (uid)` footgun the implementation
  // comment calls out: uid 0 (root) is a valid but FALSY value, so a truthy
  // check (`if (uid) …`) would silently disable the comparison for exactly
  // the daemon whose reach a foreign file matters most for. Claiming uid 0
  // while the file is owned by our real (non-zero, off-CI-root) uid must
  // still be a mismatch — mirrors stale-session-dirs.test.js's "refuses a
  // foreign base when the daemon runs as root (uid 0)".
  it('refuses when the CALLER claims uid 0 (root) and the file is owned by a different uid', { skip: typeof process.getuid !== 'function' }, () => {
    writeFileSync(secretPath, 'root-check\n', { mode: 0o600 })
    const realGetuid = process.getuid
    const realUid = realGetuid.call(process)
    if (realUid === 0) {
      // Actually running as root (e.g. a Linux CI runner) — chown the file
      // itself to a different uid so the mismatch is real, not simulated.
      chownSync(secretPath, 1, 1)
      assert.throws(() => loadOrCreateIngestSecret(secretPath), /refusing to read/)
      return
    }
    process.getuid = () => 0
    try {
      assert.throws(
        () => loadOrCreateIngestSecret(secretPath),
        new RegExp(`is owned by uid ${realUid} rather than uid 0; refusing to read`),
        'uid 0 must not be treated as "no uid to compare" via a truthy check'
      )
    } finally {
      process.getuid = realGetuid
    }
  })

  it('fails closed (throws) when statSync fails for a reason other than the file being absent', async (t) => {
    if (typeof mock.module !== 'function') {
      t.skip('re-run with --experimental-test-module-mocks to exercise this test')
      return
    }
    writeFileSync(secretPath, 'unreachable\n', { mode: 0o600 })
    const realFs = await import('node:fs')
    const statError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const mockFs = { ...realFs, statSync: () => { throw statError } }
    mock.module('node:fs', { defaultExport: mockFs, namedExports: mockFs })
    try {
      const { loadOrCreateIngestSecret: loadWithMock } = await import(`../src/event-ingest.js?cacheBust=7246-stat-${Date.now()}`)
      assert.throws(
        () => loadWithMock(secretPath),
        /unable to stat .*: EACCES/,
        'a non-ENOENT stat failure must throw, never fall through to reading or recreating the secret'
      )
    } finally {
      mock.restoreAll()
    }
  })

  it('an ENOENT stat failure (create/delete race) is NOT a refusal — falls through to create-new-secret', async (t) => {
    if (typeof mock.module !== 'function') {
      t.skip('re-run with --experimental-test-module-mocks to exercise this test')
      return
    }
    // existsSync says present, but statSync races to ENOENT (the file vanished
    // between the two calls) — this must be treated as "absent", not refused,
    // so the create path can proceed. Distinguishes the ENOENT special-case
    // from the general stat-failure refusal above.
    const realFs = await import('node:fs')
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    const mockFs = {
      ...realFs,
      existsSync: (p) => (p === secretPath ? true : realFs.existsSync(p)),
      statSync: (p) => { if (p === secretPath) throw enoent; return realFs.statSync(p) },
    }
    mock.module('node:fs', { defaultExport: mockFs, namedExports: mockFs })
    try {
      const { loadOrCreateIngestSecret: loadWithMock } = await import(`../src/event-ingest.js?cacheBust=7246-enoent-${Date.now()}`)
      const secret = loadWithMock(secretPath)
      assert.ok(secret.length >= 40, 'a fresh secret was minted rather than throwing')
    } finally {
      mock.restoreAll()
    }
  })
})

describe('deriveProjectFromCwd', () => {
  it('returns the basename of the nearest dir containing .git (directory)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'proj-'))
    mkdirSync(join(repo, '.git'))
    const nested = join(repo, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    assert.equal(deriveProjectFromCwd(nested), basename(repo))
  })

  it('treats a .git FILE as a git root (worktrees)', () => {
    const wt = mkdtempSync(join(tmpdir(), 'wt-'))
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere/else\n')
    const nested = join(wt, 'src')
    mkdirSync(nested)
    assert.equal(deriveProjectFromCwd(nested), basename(wt))
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

  // #5483/#5850: a cwd inside a chroxy session worktree (~/.chroxy/worktrees/<id>)
  // must resolve to the PARENT repo, never the opaque hex session id. This mirrors
  // the hook-side fix (#5483) so the server fallback can't re-mint the id.
  describe('chroxy session worktree (#5483/#5850)', () => {
    const ID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'

    // git: 'valid' writes a real `git worktree add` .git file pointing back at
    // the repo; 'corrupt' writes garbage; 'missing' writes no file.
    function makeChroxyWorktree({ git = 'valid' } = {}) {
      const root = mkdtempSync(join(tmpdir(), 'cwt-root-'))
      const repo = mkdtempSync(join(tmpdir(), 'cwt-repo-'))
      const wt = join(root, ID)
      mkdirSync(wt, { recursive: true })
      if (git === 'valid') writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', ID)}\n`)
      else if (git === 'corrupt') writeFileSync(join(wt, '.git'), 'not a gitdir line\n')
      const env = { ...process.env, CHROXY_WORKTREES_ROOT: root }
      return { root, repo, wt, env }
    }

    it('recovers the parent repo basename, not the opaque session id', () => {
      const { repo, wt, env } = makeChroxyWorktree()
      const got = deriveProjectFromCwd(wt, env)
      assert.equal(got, basename(repo))
      assert.notEqual(got, ID, 'must not return the opaque session id')
    })

    it('recovers from a nested cwd inside the worktree too', () => {
      const { repo, wt, env } = makeChroxyWorktree()
      const nested = join(wt, 'packages', 'app')
      mkdirSync(nested, { recursive: true })
      assert.equal(deriveProjectFromCwd(nested, env), basename(repo))
    })

    it('returns null (not the id) when the worktree .git file is corrupt', () => {
      const { wt, env } = makeChroxyWorktree({ git: 'corrupt' })
      assert.equal(deriveProjectFromCwd(wt, env), null)
    })

    it('returns null (not the id) when the worktree .git file is missing', () => {
      const { wt, env } = makeChroxyWorktree({ git: 'missing' })
      assert.equal(deriveProjectFromCwd(wt, env), null)
    })
  })
})
