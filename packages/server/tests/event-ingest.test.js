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
      const res = await post(big).catch(() => null)
      // The server destroys the socket after flagging oversize; depending on
      // timing the client sees the 413 or a reset. Both prove the cap.
      if (res) assert.equal(res.status, 413)
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
    it('429 with Retry-After once a source exceeds its bucket', async () => {
      const server = createMockServer({
        _ingestRateLimiter: new RateLimiter({ windowMs: 60_000, maxMessages: 2, burst: 0, name: 'ingest-test' }),
      })
      await startWith(server)
      assert.equal((await post(validEvent())).status, 200)
      assert.equal((await post(validEvent({ type: 'session_end' }))).status, 200)
      const res = await post(validEvent({ type: 'notification' }))
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
      assert.equal((await post(validEvent({ source: 'hooks-a' }))).status, 200)
      assert.equal((await post(validEvent({ source: 'hooks-a' }))).status, 429)
      assert.equal((await post(validEvent({ source: 'hooks-b' }))).status, 200)
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
      }
      for (const [type, category] of Object.entries(expected)) {
        const res = await post(validEvent({ type, source: `src-${type}` }))
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.equal(body.category, category, `${type} → ${category}`)
      }
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
