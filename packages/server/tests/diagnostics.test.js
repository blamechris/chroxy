import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildDiagnosticsSnapshot } from '../src/diagnostics.js'
import { initFileLogging, closeFileLogging, createLogger } from '../src/logger.js'
import { RateLimiter } from '../src/rate-limiter.js'

/**
 * Issue #3732 — diagnostics endpoint for triaging stuck sessions.
 *
 * The snapshot has to surface enough state that an operator looking at a hung
 * session can tell *why* it's stuck — specifically the busy flag, the inactivity
 * timer's pause state, the pending-permission queue with timestamps, and a tail
 * of the on-disk log (which #3731 enables). It must NOT leak tool inputs into
 * the diagnostic surface — full inputs already live in the auth-gated log.
 */

function makeFakeSession(overrides = {}) {
  return {
    _isBusy: false,
    _resultTimeoutPaused: false,
    _permissionPauseCount: 0,
    _currentMessageId: null,
    permissionMode: 'approve',
    _pendingPermissions: new Map(),
    _lastPermissionData: new Map(),
    ...overrides,
  }
}

function makeServer({ sessions = [], started = Date.now() - 5000 } = {}) {
  const sessionMap = new Map()
  for (const s of sessions) sessionMap.set(s.id, s.entry)
  return {
    serverMode: 'cli',
    _startedAt: started,
    _clientManager: { clients: new Map(), authenticatedCount: 0 },
    sessionManager: { _sessions: sessionMap },
  }
}

describe('buildDiagnosticsSnapshot (#3732)', () => {
  it('returns server-level metadata even when there are no sessions', () => {
    const server = makeServer()
    const snap = buildDiagnosticsSnapshot({ server, serverVersion: '0.7.99' })
    assert.equal(snap.server.version, '0.7.99')
    assert.equal(snap.server.mode, 'cli')
    assert.equal(typeof snap.server.uptime, 'number')
    assert.ok(snap.server.uptime >= 0)
    assert.equal(typeof snap.server.pid, 'number')
    assert.deepEqual(snap.sessions, [])
  })

  it('surfaces the per-session busy/pause state that determines RESULT_TIMEOUT', () => {
    const session = makeFakeSession({
      _isBusy: true,
      _resultTimeoutPaused: true,
      _permissionPauseCount: 2,
      _currentMessageId: 'msg-x-3',
      permissionMode: 'approve',
    })
    const server = makeServer({
      sessions: [{
        id: 'sess-1',
        entry: { session, name: 'My Session', provider: 'claude-sdk', cwd: '/tmp', lastActivityAt: 1234567 },
      }],
    })

    const snap = buildDiagnosticsSnapshot({ server, serverVersion: '0.7.99' })
    assert.equal(snap.sessions.length, 1)
    const s0 = snap.sessions[0]
    assert.equal(s0.id, 'sess-1')
    assert.equal(s0.name, 'My Session')
    assert.equal(s0.provider, 'claude-sdk')
    assert.equal(s0.cwd, '/tmp')
    assert.equal(s0.isBusy, true)
    assert.equal(s0.resultTimeoutPaused, true)
    assert.equal(s0.permissionPauseCount, 2)
    assert.equal(s0.currentMessageId, 'msg-x-3')
    assert.equal(s0.permissionMode, 'approve')
    assert.equal(s0.lastActivityAt, 1234567)
  })

  it('lists pending permissions with age but does NOT echo tool input', () => {
    // Ensure tool input never leaks via /diagnostics — operators triaging a
    // stuck Bash prompt shouldn't be able to read the command from the
    // diagnostics surface. Full input lives in the auth-gated log only.
    const session = makeFakeSession()
    session._pendingPermissions.set('perm-1', { resolve: () => {}, input: { command: 'rm -rf /tmp/secret' } })
    session._lastPermissionData.set('perm-1', {
      tool: 'Bash',
      description: 'rm -rf /tmp/secret',
      input: { command: 'rm -rf /tmp/secret' },
      createdAt: Date.now() - 10_000,
      remainingMs: 290_000,
    })

    const server = makeServer({
      sessions: [{ id: 'sess-1', entry: { session, provider: 'claude-sdk' } }],
    })

    const snap = buildDiagnosticsSnapshot({ server, serverVersion: '0.7.99' })
    assert.equal(snap.sessions[0].pendingPermissions.length, 1)
    const p = snap.sessions[0].pendingPermissions[0]
    assert.equal(p.requestId, 'perm-1')
    assert.equal(p.tool, 'Bash')
    assert.equal(p.description, 'rm -rf /tmp/secret', 'description IS surfaced (already in WS broadcast)')
    assert.ok(p.ageMs >= 10_000, 'age reflects createdAt')
    assert.equal(p.input, undefined, 'raw input must NOT appear in the diagnostics surface')
  })

  it('truncates pending permission descriptions to 200 chars', () => {
    const longDesc = 'x'.repeat(500)
    const session = makeFakeSession()
    session._pendingPermissions.set('perm-1', {})
    session._lastPermissionData.set('perm-1', { tool: 'Bash', description: longDesc, createdAt: Date.now() })
    const server = makeServer({
      sessions: [{ id: 'sess-1', entry: { session, provider: 'claude-sdk' } }],
    })
    const snap = buildDiagnosticsSnapshot({ server, serverVersion: '0.7.99' })
    assert.equal(snap.sessions[0].pendingPermissions[0].description.length, 200)
  })

  it('reports logs.source = "disabled" when file logging is not initialized', () => {
    closeFileLogging() // ensure no leakage from a prior test
    const snap = buildDiagnosticsSnapshot({ server: makeServer(), serverVersion: '0.7.99' })
    assert.equal(snap.logs.source, 'disabled')
    assert.equal(snap.logs.path, null)
    assert.deepEqual(snap.logs.lines, [])
  })

  describe('with file logging enabled', () => {
    let logDir
    beforeEach(() => {
      logDir = mkdtempSync(join(tmpdir(), 'chroxy-diag-test-'))
      initFileLogging({ logDir })
    })
    afterEach(() => {
      closeFileLogging()
      rmSync(logDir, { recursive: true, force: true })
    })

    it('returns a tail of the on-disk log when file logging is on', () => {
      const log = createLogger('diag-test')
      for (let i = 0; i < 5; i++) log.info(`event-line-${i}`)
      const snap = buildDiagnosticsSnapshot({ server: makeServer(), serverVersion: '0.7.99' })
      assert.equal(snap.logs.source, 'file')
      assert.ok(snap.logs.path?.endsWith('chroxy.log'))
      assert.ok(snap.logs.lines.length >= 5, 'should include all 5 emitted lines')
      assert.ok(snap.logs.lines.some(l => l.includes('event-line-4')))
    })

    it('caps the log tail to logTailBytes', () => {
      const log = createLogger('diag-test')
      // Write enough to exceed the byte budget so we can verify trimming.
      for (let i = 0; i < 200; i++) log.info(`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-${i}`)
      const snap = buildDiagnosticsSnapshot({
        server: makeServer(),
        serverVersion: '0.7.99',
        logTailBytes: 1024,
      })
      // Sum of returned line lengths should not exceed the byte cap by much.
      const totalBytes = snap.logs.lines.reduce((acc, l) => acc + l.length + 1, 0)
      assert.ok(totalBytes <= 1024 + 200, `tail respects byte cap (got ${totalBytes})`)
      // We dropped a partial first line — every returned line should end
      // cleanly with `-N` (the suffix from our generator).
      for (const line of snap.logs.lines) {
        assert.match(line, /-\d+$/)
      }
    })

    it('reports logs.note when the file does not yet exist on disk', () => {
      // initFileLogging created the dir but no log line has been written
      // yet — the file won't exist until the first log call.
      closeFileLogging()
      initFileLogging({ logDir })
      const snap = buildDiagnosticsSnapshot({ server: makeServer(), serverVersion: '0.7.99' })
      assert.equal(snap.logs.source, 'file')
      assert.equal(snap.logs.lines.length, 0)
      assert.match(snap.logs.note ?? '', /not yet written/)
    })
  })
})

describe('buildDiagnosticsSnapshot rateLimiters (#3996)', () => {
  /**
   * The rateLimiters surface lets operators detect IP-rotation attacks: any
   * limiter with `evictionCount > 0` is shedding entries. Tests verify the
   * snapshot includes every limiter the server holds (including the one that
   * lives inside the permission handler closure) and is resilient to
   * partial server objects (so /diagnostics never 500s on a half-built mock).
   */
  function makeServerWithLimiters({ limiters = {}, httpPermissionLimiter = null } = {}) {
    return {
      serverMode: 'cli',
      _startedAt: Date.now() - 1000,
      _clientManager: { clients: new Map(), authenticatedCount: 0 },
      sessionManager: { _sessions: new Map() },
      _rateLimiter: limiters.ws ?? null,
      _permissionRateLimiter: limiters.permission ?? null,
      _diagnosticsRateLimiter: limiters.diagnostics ?? null,
      _permissions: httpPermissionLimiter ? { _httpPermissionLimiter: httpPermissionLimiter } : null,
    }
  }

  it('includes one entry per RateLimiter the server exposes, with name + zero counts at idle', () => {
    const server = makeServerWithLimiters({
      limiters: {
        ws: new RateLimiter({ name: 'ws' }),
        permission: new RateLimiter({ name: 'permission', windowMs: 60_000, maxMessages: 60, burst: 0 }),
        diagnostics: new RateLimiter({ name: 'diagnostics', windowMs: 60_000, maxMessages: 12, burst: 4 }),
      },
      httpPermissionLimiter: new RateLimiter({ name: 'http-permission' }),
    })
    const snap = buildDiagnosticsSnapshot({ server, serverVersion: '0.7.99' })
    assert.ok(Array.isArray(snap.rateLimiters), 'rateLimiters is an array')
    const names = snap.rateLimiters.map(r => r.name).sort()
    assert.deepEqual(names, ['diagnostics', 'http-permission', 'permission', 'ws'])
    for (const r of snap.rateLimiters) {
      assert.equal(r.evictionCount, 0)
      assert.equal(r.lastEvictionAt, null)
      assert.equal(typeof r.mapSize, 'number')
      assert.equal(typeof r.maxEntries, 'number')
    }
  })

  it('reflects evictionCount > 0 once a limiter has shed entries', () => {
    const ws = new RateLimiter({ name: 'ws', maxEntries: 3, evictionLogThrottleMs: 60_000 })
    for (let i = 0; i < 10; i++) ws.check(`client-${i}`)
    const snap = buildDiagnosticsSnapshot({
      server: makeServerWithLimiters({ limiters: { ws } }),
      serverVersion: '0.7.99',
    })
    const wsEntry = snap.rateLimiters.find(r => r.name === 'ws')
    assert.ok(wsEntry, 'ws limiter present')
    assert.equal(wsEntry.evictionCount, 7)
    assert.equal(wsEntry.mapSize, 3)
    assert.ok(wsEntry.lastEvictionAt > 0, 'lastEvictionAt populated')
  })

  it('omits limiters that are missing or do not implement getEvictionStats', () => {
    // Defensive: a server mock with no limiters wired up must still produce
    // a snapshot — and the snapshot should silently drop the missing slots
    // rather than emit nulls or throw.
    const server = makeServerWithLimiters({ limiters: { ws: new RateLimiter({ name: 'ws' }) } })
    // Throw an evil object into one of the slots to exercise the try/catch.
    server._diagnosticsRateLimiter = { getEvictionStats: () => { throw new Error('boom') } }
    const snap = buildDiagnosticsSnapshot({ server, serverVersion: '0.7.99' })
    assert.equal(snap.rateLimiters.length, 1)
    assert.equal(snap.rateLimiters[0].name, 'ws')
  })

  it('returns an empty array when the server exposes no limiters at all', () => {
    const snap = buildDiagnosticsSnapshot({
      server: { _clientManager: { clients: new Map() }, sessionManager: { _sessions: new Map() } },
      serverVersion: '0.7.99',
    })
    assert.deepEqual(snap.rateLimiters, [])
  })
})
