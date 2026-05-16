import { describe, it, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSession } from './test-helpers.js'
import { setLogListener, initFileLogging, closeFileLogging, createLogger } from '../src/logger.js'
import { resolveDiagnosticsRateLimit } from '../src/ws-server.js'

// Same wrapper pattern as ws-server-auth.test.js — disable encryption for
// fast tests, mute the log listener WsServer.start() registers.
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  const httpServer = server.httpServer
  await new Promise((resolve, reject) => {
    function onListening() {
      httpServer.removeListener('error', onError)
      resolve()
    }
    function onError(err) {
      httpServer.removeListener('listening', onListening)
      reject(err)
    }
    httpServer.once('listening', onListening)
    httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

/**
 * Issue #3732 — /diagnostics endpoint integration tests.
 * Confirms the route is wired into the HTTP handler with the expected
 * auth, content-type negotiation, and shape.
 */
describe('GET /diagnostics (#3732)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('rejects without bearer token when authRequired: true', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics`)
    assert.equal(res.status, 403)
  })

  it('returns JSON snapshot with correct token', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
      headers: { 'Authorization': 'Bearer tok-diag' },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/)
    const body = await res.json()
    assert.equal(typeof body.server?.version, 'string')
    assert.equal(typeof body.server?.uptime, 'number')
    assert.ok(Array.isArray(body.sessions))
    assert.ok(body.logs, 'logs section present')
    // file logging may or may not be enabled in this test env; either source
    // value is acceptable. The contract is that the field exists.
    assert.ok(['file', 'disabled'].includes(body.logs.source))
  })

  it('returns plaintext when Accept: text/plain', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
      headers: { 'Authorization': 'Bearer tok-diag', 'Accept': 'text/plain' },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain/)
    const body = await res.text()
    assert.match(body, /chroxy server v/)
    assert.match(body, /sessions \(\d+\):/)
    assert.match(body, /log tail \(/)
  })

  it('rejects with wrong bearer token', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
      headers: { 'Authorization': 'Bearer wrong-tok' },
    })
    assert.equal(res.status, 403)
  })

  it('does NOT serve prefix-aliased paths like /diagnostics-foo (Copilot review on PR #3734)', async () => {
    // Pre-fix the route used `req.url?.startsWith('/diagnostics')`, which
    // would have matched (and shadowed) any future `/diagnostics-foo` route.
    // The fix matches the pathname exactly, allowing only an optional
    // query string.
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics-foo`, {
      headers: { 'Authorization': 'Bearer tok-diag' },
    })
    assert.notEqual(res.status, 200,
      'prefix-aliased path must NOT be served by /diagnostics')
  })

  it('still matches /diagnostics with a query string (#3739 forward-compat)', async () => {
    // The pathname check splits on `?` so future query-param tuning
    // (e.g. ?logTailBytes=N from #3739) lands on the route correctly.
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    const port = await startServerAndGetPort(server)
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics?foo=bar`, {
      headers: { 'Authorization': 'Bearer tok-diag' },
    })
    assert.equal(res.status, 200, 'query-string variant of /diagnostics still serves')
  })
})

/**
 * Issue #3739 — `?logTailBytes=N` query param on /diagnostics.
 *
 * Operators triaging a long-running stall want a wider log window than the
 * 8KB default; during a tight repro they want a smaller, faster response.
 * The handler must parse + validate + clamp the param so a stolen token
 * can't slurp megabytes of log into memory per request.
 */
describe('GET /diagnostics?logTailBytes=N (#3739)', () => {
  let server
  let logDir

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-diag-logtail-'))
    initFileLogging({ logDir })
    // Generate ~90KB of log content so that:
    //   - the default 8KB window has plenty to trim,
    //   - the explicit 1024-byte window is well below file size,
    //   - and the 64KB hard cap (LOG_TAIL_BYTES_MAX in http-routes.js) is
    //     actually exercised by the oversized-?logTailBytes test below
    //     (would otherwise pass even if clamping were broken).
    // Each line ends up ~120 bytes (timestamp + level + component +
    // payload + newline) under the logger's plaintext format.
    const log = createLogger('diag-test')
    for (let i = 0; i < 800; i++) {
      log.info(`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-${i}`)
    }
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    closeFileLogging()
    if (logDir) {
      rmSync(logDir, { recursive: true, force: true })
      logDir = null
    }
  })

  async function startAuthed() {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
    })
    return startServerAndGetPort(server)
  }

  async function fetchDiag(port, query = '') {
    const res = await fetch(`http://127.0.0.1:${port}/diagnostics${query}`, {
      headers: { 'Authorization': 'Bearer tok-diag' },
    })
    assert.equal(res.status, 200)
    return res.json()
  }

  function tailBytes(body) {
    return (body.logs?.lines || []).reduce((acc, l) => acc + l.length + 1, 0)
  }

  it('honours an explicit ?logTailBytes=1024 by trimming the tail', async () => {
    const port = await startAuthed()
    const small = await fetchDiag(port, '?logTailBytes=1024')
    const def = await fetchDiag(port)
    assert.ok(tailBytes(small) <= 1024 + 200, `1024-byte cap respected (got ${tailBytes(small)})`)
    assert.ok(tailBytes(small) < tailBytes(def),
      `explicit smaller window (${tailBytes(small)}) must be smaller than default (${tailBytes(def)})`)
  })

  it('uses the default window when ?logTailBytes is absent', async () => {
    const port = await startAuthed()
    const body = await fetchDiag(port)
    // Default in buildDiagnosticsSnapshot is 8192. Allow some slack for
    // line-boundary trimming.
    assert.ok(tailBytes(body) <= 8192 + 200, `default 8KB cap holds (got ${tailBytes(body)})`)
    assert.ok(body.logs.lines.length > 0, 'default still returns some log lines')
  })

  it('clamps oversized ?logTailBytes=999999999 to the hard cap (65536)', async () => {
    const port = await startAuthed()
    const body = await fetchDiag(port, '?logTailBytes=999999999')
    // The log file is ~90KB (see beforeEach), so an unclamped pass-through
    // would return >64KB. Asserting the response is *at* the cap proves
    // the clamp ran; asserting it's *close* to the cap (>50KB) proves we
    // actually exercised it rather than returning a tiny tail by accident.
    const bytes = tailBytes(body)
    assert.ok(bytes <= 65536, `hard cap enforced (got ${bytes})`)
    assert.ok(bytes >= 50000,
      `cap actually exercised — must be near 64KB to prove clamp ran (got ${bytes})`)
  })

  it('falls back to default for NaN ?logTailBytes=garbage', async () => {
    const port = await startAuthed()
    const body = await fetchDiag(port, '?logTailBytes=garbage')
    const def = await fetchDiag(port)
    // Garbage param should behave identically to no param. Use a tight
    // tolerance (not strict equality) since each fetch emits a few
    // WsServer log lines that grow the underlying file between requests.
    assert.ok(Math.abs(tailBytes(body) - tailBytes(def)) < 500,
      `invalid param falls through to default behavior (got ${tailBytes(body)} vs ${tailBytes(def)})`)
  })

  it('falls back to default for negative ?logTailBytes=-1', async () => {
    const port = await startAuthed()
    const body = await fetchDiag(port, '?logTailBytes=-1')
    const def = await fetchDiag(port)
    assert.ok(Math.abs(tailBytes(body) - tailBytes(def)) < 500,
      `negative param falls through to default behavior (got ${tailBytes(body)} vs ${tailBytes(def)})`)
  })

  it('falls back to default for zero ?logTailBytes=0', async () => {
    const port = await startAuthed()
    const body = await fetchDiag(port, '?logTailBytes=0')
    const def = await fetchDiag(port)
    assert.ok(Math.abs(tailBytes(body) - tailBytes(def)) < 500,
      `zero param falls through to default behavior (got ${tailBytes(body)} vs ${tailBytes(def)})`)
  })

  it('truncates a fractional ?logTailBytes=1024.9 to an integer', async () => {
    const port = await startAuthed()
    const frac = await fetchDiag(port, '?logTailBytes=1024.9')
    const intg = await fetchDiag(port, '?logTailBytes=1024')
    // If `1024.9` were passed through to buildDiagnosticsSnapshot unchanged,
    // collectLogTail's readSync(... length=1024.9) would hit its error
    // path and return zero lines + a `logs.error`. Assert positively that
    // we got file-backed lines AND that the byte count matches the
    // integer-1024 response within a few log lines of drift.
    assert.equal(frac.logs?.source, 'file', 'fractional request must succeed against the log file')
    assert.equal(frac.logs?.error, undefined, 'no readSync error from a fractional length')
    assert.ok(frac.logs?.lines?.length > 0, 'fractional request returns log lines')
    assert.ok(Math.abs(tailBytes(frac) - tailBytes(intg)) < 500,
      `fractional behaves like integer 1024 (got ${tailBytes(frac)} vs ${tailBytes(intg)})`)
  })
})

/**
 * Issue #3737 — per-source-IP rate limit on /diagnostics.
 *
 * The endpoint reads the filesystem (log tail) and iterates every session
 * per call. Without a limiter, an attacker with a stolen token can DoS the
 * server with a tight loop. Match the /permission pattern: 429 + Retry-After.
 */
describe('GET /diagnostics rate limit (#3737)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  async function startWithLimit(limitConfig) {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-diag',
      cliSession: createMockSession(),
      authRequired: true,
      diagnosticsRateLimit: limitConfig,
    })
    return startServerAndGetPort(server)
  }

  function diagFetch(port, { ip } = {}) {
    const headers = { 'Authorization': 'Bearer tok-diag' }
    // The test client connects over loopback, so cf-connecting-ip is trusted
    // by getRateLimitKey — varying it simulates different source IPs.
    if (ip) headers['CF-Connecting-IP'] = ip
    return fetch(`http://127.0.0.1:${port}/diagnostics`, { headers })
  }

  it('returns 429 after exceeding the per-IP limit', async () => {
    // 3 requests allowed (maxMessages=2 + burst=1), 4th is blocked
    const port = await startWithLimit({ windowMs: 60_000, maxMessages: 2, burst: 1 })
    for (let i = 0; i < 3; i++) {
      const res = await diagFetch(port, { ip: '203.0.113.7' })
      assert.equal(res.status, 200, `request ${i + 1} should be allowed`)
      await res.text()
    }
    const blocked = await diagFetch(port, { ip: '203.0.113.7' })
    assert.equal(blocked.status, 429, '4th request from same IP must be rate-limited')
    assert.ok(blocked.headers.get('retry-after'), 'response must include Retry-After header')
    const retryAfter = Number(blocked.headers.get('retry-after'))
    assert.ok(retryAfter >= 1, `Retry-After should be a positive integer (got ${retryAfter})`)
    const body = await blocked.json()
    assert.equal(body.error, 'rate limited')
    assert.ok(typeof body.retryAfterMs === 'number' && body.retryAfterMs > 0,
      'body should expose retryAfterMs')
  })

  it('does not block a different source IP after the first IP is rate-limited', async () => {
    const port = await startWithLimit({ windowMs: 60_000, maxMessages: 1, burst: 0 })
    // Exhaust the bucket for IP A
    const first = await diagFetch(port, { ip: '203.0.113.7' })
    assert.equal(first.status, 200)
    await first.text()
    const blocked = await diagFetch(port, { ip: '203.0.113.7' })
    assert.equal(blocked.status, 429, 'IP A is now rate-limited')
    await blocked.text()
    // IP B should still pass — buckets are per-IP
    const otherIp = await diagFetch(port, { ip: '198.51.100.42' })
    assert.equal(otherIp.status, 200, 'different IP must not share the bucket')
    await otherIp.text()
  })

  it('allows the IP again after the sliding window expires', async () => {
    // Very short window so the test runs fast; sliding window prunes
    // expired timestamps on next check.
    const port = await startWithLimit({ windowMs: 80, maxMessages: 1, burst: 0 })
    const first = await diagFetch(port, { ip: '203.0.113.7' })
    assert.equal(first.status, 200)
    await first.text()
    const blocked = await diagFetch(port, { ip: '203.0.113.7' })
    assert.equal(blocked.status, 429)
    await blocked.text()
    // Wait past the window
    await new Promise(resolve => setTimeout(resolve, 120))
    const replayed = await diagFetch(port, { ip: '203.0.113.7' })
    assert.equal(replayed.status, 200, 'request should succeed after window resets')
    await replayed.text()
  })
})

describe('resolveDiagnosticsRateLimit env-var guard (#3737)', () => {
  const ENV_KEY = 'CHROXY_DIAGNOSTICS_RATE_LIMIT'
  let saved

  beforeEach(() => {
    saved = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = saved
  })

  it('overrideOpts short-circuits env parsing', () => {
    process.env[ENV_KEY] = '500'
    const opts = { windowMs: 1000, maxMessages: 3, burst: 1 }
    assert.deepEqual(resolveDiagnosticsRateLimit(opts), opts)
  })

  it('returns defaults when env var is unset', () => {
    const { windowMs, maxMessages, burst } = resolveDiagnosticsRateLimit(null)
    assert.equal(windowMs, 60_000)
    assert.equal(maxMessages, 12)
    assert.equal(burst, 4)
  })

  it('integer >= 1 overrides maxMessages and auto-derives burst', () => {
    process.env[ENV_KEY] = '60'
    const { windowMs, maxMessages, burst } = resolveDiagnosticsRateLimit(null)
    assert.equal(windowMs, 60_000)
    assert.equal(maxMessages, 60)
    assert.equal(burst, 20)
  })

  it('integer = 1 yields burst = 1 (floor(1/3) = 0 → max(1, 0) = 1)', () => {
    process.env[ENV_KEY] = '1'
    const { maxMessages, burst } = resolveDiagnosticsRateLimit(null)
    assert.equal(maxMessages, 1)
    assert.equal(burst, 1)
  })

  // Regression guard: pre-fix, Math.trunc(0.5) = 0, then RateLimiter's
  // `maxMessages || DEFAULT_MAX_MESSAGES` would use the 100 default,
  // EFFECTIVELY RAISING the limit instead of falling back to our 12/min
  // default. Now sub-integer values are rejected outright.
  it('rejects sub-integer values (Math.trunc would zero them) and falls back to defaults', () => {
    for (const bad of ['0.5', '0.1', '0.9']) {
      process.env[ENV_KEY] = bad
      const { maxMessages, burst } = resolveDiagnosticsRateLimit(null)
      assert.equal(maxMessages, 12, `sub-integer ${bad} must fall back to default 12`)
      assert.equal(burst, 4, `sub-integer ${bad} must fall back to default burst 4`)
    }
  })

  it('rejects 0 and negative values', () => {
    for (const bad of ['0', '-1', '-100']) {
      process.env[ENV_KEY] = bad
      const { maxMessages } = resolveDiagnosticsRateLimit(null)
      assert.equal(maxMessages, 12, `${bad} must fall back to default`)
    }
  })

  it('rejects NaN / non-numeric / empty / whitespace-only', () => {
    for (const bad of ['', 'abc', 'NaN', '   ']) {
      process.env[ENV_KEY] = bad
      const { maxMessages } = resolveDiagnosticsRateLimit(null)
      assert.equal(maxMessages, 12, `"${bad}" must fall back to default`)
    }
  })
})
