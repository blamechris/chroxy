/**
 * Agent principals are refused on EVERY HTTP route (agent-principals.md sections 3 and 4.5).
 *
 * A principal token is accepted at WebSocket `auth` only. This file holds the roster of
 * every route in http-routes.js with the guard family it uses, and checks it in BOTH
 * directions against the source (a route that is missing from the roster is red, and a
 * listed route that does not exist is red), plus every other place a bearer is parsed.
 * Then a real server answers the roster over HTTP: a LIVE principal token is refused on
 * each route, and the primary token (the positive control) gets past the same guard.
 *
 * No route opts in to principals in v1: the principal store is not referenced by any HTTP
 * guard, and `_validateBearerAuth`'s own source names no principal.
 */
import { describe, it, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'
import { inventoryRoutes, inventoryBearerReads, srcFiles } from './helpers/http-auth-inventory.js'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PagesStore } from '../src/pages-store.js'
import { createMockSessionManager } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal } from './helpers/principal-store-fixture.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

/**
 * Every route in http-routes.js, by method and a fragment of its condition. `guard` is the
 * family the route uses:
 *   public         no bearer is read at all
 *   bearer         `_validateBearerAuth`           bearer-scoped  `{ allowScoped: true }`
 *   primary        `_validatePrimaryBearerAuth`    dashboard      `_authenticateDashboardRequest`
 *   ingest-secret  the daemon ingest secret (own check)   hmac   GitHub signature, no bearer
 *   hook-secret    the per-session hook secret (createPermissionHandler)
 * An independent oracle: written here, not derived from the source it checks.
 */
const ROSTER = [
  { method: 'OPTIONS', match: "'OPTIONS'", url: '/', guard: 'public' },
  { method: 'GET', match: "(req.url === '/' ||", url: '/health', guard: 'public' },
  { method: 'GET', match: "pagesPath.startsWith('/p/')", url: '/p/none', guard: 'public' },
  { method: 'GET', match: "req.url === '/version'", url: '/version', guard: 'bearer' },
  { method: 'GET', match: "'/api/daemon/idle'", url: '/api/daemon/idle', guard: 'primary' },
  { method: 'GET', match: 'oauthCbPath ===', url: '/oauth/callback', guard: 'public' },
  { method: 'GET', match: "req.url === '/metrics'", url: '/metrics', guard: 'bearer' },
  { method: 'POST', match: 'statusMatch', url: '/api/sessions/sess-1/status', guard: 'bearer-scoped', body: {} },
  { method: 'POST', match: "snapPath === '/api/events'", url: '/api/events', guard: 'ingest-secret', body: {} },
  { method: 'GET', match: "snapPath === '/api/continuations'", url: '/api/continuations', guard: 'primary' },
  { method: 'POST', match: "snapPath === '/api/github/webhook'", url: '/api/github/webhook', guard: 'hmac', body: {} },
  { method: 'POST', match: "snapPath === '/api/mailbox'", url: '/api/mailbox', guard: 'ingest-secret', body: {} },
  { method: 'POST', match: "snapPath === '/api/mailbox/register'", url: '/api/mailbox/register', guard: 'ingest-secret', body: {} },
  { method: 'GET', match: "snapPath === '/api/snapshots'", url: '/api/snapshots', guard: 'bearer' },
  { method: 'DELETE', match: "snapPath.startsWith('/api/snapshots/')", url: '/api/snapshots/none', guard: 'primary' },
  { method: 'GET', match: "snapPath === '/api/paired-devices'", url: '/api/paired-devices', guard: 'primary' },
  { method: 'DELETE', match: "snapPath === '/api/paired-devices'", url: '/api/paired-devices', guard: 'primary' },
  { method: 'DELETE', match: "snapPath.startsWith('/api/paired-devices/')", url: '/api/paired-devices/none', guard: 'primary' },
  { method: 'POST', match: "snapPath === '/api/pages' &&", url: '/api/pages', guard: 'primary', body: {} },
  { method: 'GET', match: "snapPath === '/api/pages' &&", url: '/api/pages', guard: 'primary' },
  { method: 'DELETE', match: "snapPath.startsWith('/api/pages/')", url: '/api/pages/none', guard: 'primary' },
  { method: 'GET', match: "snapPath === '/api/pool/stats'", url: '/api/pool/stats', guard: 'bearer' },
  { method: 'GET', match: "diagPathname === '/diagnostics'", url: '/diagnostics', guard: 'bearer' },
  { method: 'POST', match: "req.url === '/permission'", url: '/permission', guard: 'hook-secret', body: {} },
  { method: 'POST', match: "req.url === '/permission-floor'", url: '/permission-floor', guard: 'hook-secret', body: {} },
  { method: 'POST', match: "req.url === '/permission-response'", url: '/permission-response', guard: 'bearer-scoped', body: {} },
  { method: 'GET', match: "req.url === '/connect'", url: '/connect', guard: 'primary' },
  { method: 'GET', match: "'/pairing-code'", url: '/pairing-code', guard: 'primary' },
  { method: 'POST', match: "'/pair-discord'", url: '/pair-discord', guard: 'primary', body: {} },
  { method: 'GET', match: "startsWith('/qr/session/')", url: '/qr/session/none', guard: 'primary' },
  { method: 'GET', match: "startsWith('/qr')", url: '/qr', guard: 'primary' },
  { method: 'GET', match: "startsWith('/assets/')", url: '/assets/none.js', guard: 'public' },
  { method: 'GET', match: '/^\\/dashboard', url: '/dashboard', guard: 'dashboard' },
]

function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return
  fn(node)
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn))
    else if (v && typeof v.type === 'string') walk(v, fn)
  }
}

// Callee names that may receive `req` outside a route without being a delegated route
// (the wrapper around `dispatch`, and the oversize-body responder). Pinned.
const NON_ROUTING_REQ_CALLS = ['sendOversizeResponse', 'dispatch']

/**
 * Everything the roster is checked against, from the AST: the routes of the request
 * handler with their guard family, what could not be placed, and every authorization-header
 * read in the source tree. Pure over file paths so a mutated copy can be checked the same way.
 */
function inventory(routesFile, srcRoot = SRC) {
  const { routes, unplaced } = inventoryRoutes(routesFile, { nonRoutingReqCalls: NON_ROUTING_REQ_CALLS, strict: true })
  const reads = {}
  const escapes = {}
  for (const f of srcFiles(srcRoot)) {
    const path = f.rel === 'http-routes.js' ? routesFile : f.path
    const b = inventoryBearerReads(path)
    if (b.reads.length) reads[f.rel] = b.reads.length
    if (b.escapes.length) escapes[f.rel] = b.escapes.length
  }
  return { routes, unplaced, reads, escapes }
}

// What the tree holds today, an independent oracle. Each bearer READ is a guard family
// above, an HTTP-only credential (ingest secret, hook secret), the dashboard reader, or a
// redaction or validation pattern (anthropic-compatible-config.js, redaction.js: a `Bearer` regex, not an inbound read); none reads the principal store (next test).
const EXPECTED_READS = {
  'anthropic-compatible-config.js': 1, 'bearer-recheck.js': 2, 'event-ingest.js': 2, 'http-routes.js': 1, 'mailbox-route.js': 2,
  'redaction.js': 2, 'ws-permissions.js': 6, 'ws-server.js': 9,
}
// The request's header bag handed on whole: proxy-header classifiers and the preview proxy.
const EXPECTED_ESCAPES = { 'connection-locality.js': 2, 'preview-target.js': 1 }

/**
 * The roster check as a function: every problem, as a string. The real test asserts
 * the list is empty; the mutation fixtures assert it is not.
 */
function rosterProblems(inv) {
  const problems = []
  for (const u of inv.unplaced) problems.push(`unplaced: ${u}`)
  const matches = (entry, route) => entry.method === route.method && route.test.includes(entry.match)
  for (const route of inv.routes) {
    const hits = ROSTER.filter((e) => matches(e, route))
    if (hits.length !== 1) problems.push(`route not in the roster exactly once: ${route.method} ${route.test.slice(0, 80)}`)
    else if (hits[0].guard !== route.family) problems.push(`guard family changed: ${hits[0].url} is ${route.family}, roster says ${hits[0].guard}`)
  }
  for (const e of ROSTER) if (!inv.routes.some((r) => matches(e, r))) problems.push(`roster entry is not a route: ${e.method} ${e.url}`)
  const diff = (got, want, what) => {
    for (const k of new Set([...Object.keys(got), ...Object.keys(want)])) {
      if ((got[k] ?? 0) !== (want[k] ?? 0)) problems.push(`${what} in ${k}: found ${got[k] ?? 0}, expected ${want[k] ?? 0}`)
    }
  }
  diff(inv.reads, EXPECTED_READS, 'authorization-header reads')
  diff(inv.escapes, EXPECTED_ESCAPES, 'request headers handed on whole')
  return problems
}

/** The text of a named method of the WsServer class. */
function methodSource(file, name) {
  const src = read(file)
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
  let found = null
  walk(ast, (n) => {
    if (n.type === 'MethodDefinition' && n.key?.name === name) found = src.slice(n.start, n.end)
  })
  return found
}

describe('the HTTP route roster, checked in both directions against the source (AST, not spelling)', () => {
  const real = inventory(join(SRC, 'http-routes.js'))

  it('enumerates a non-empty route set and a non-empty roster', () => {
    assert.ok(real.routes.length >= 30, `the scan found only ${real.routes.length} routes`)
    assert.ok(ROSTER.length > 0)
    assert.ok(Object.keys(real.reads).length > 0)
  })

  it('the source and the roster agree both ways: no unlisted route, no stale entry, no class change, no unplaced construct, no unaccounted bearer read', () => {
    assert.deepEqual(rosterProblems(real), [])
  })

  it('other servers that route on req.method are pinned (the shell-approval listener, the supervisor health probe, the channel server)', () => {
    const found = {}
    for (const f of srcFiles(SRC)) {
      if (f.rel === 'http-routes.js') continue
      const r = inventoryRoutes(f.path)
      if (r.routes.length || r.unplaced.length) found[f.rel] = { routes: r.routes.length, unplaced: r.unplaced.length }
    }
    assert.deepEqual(found, {
      'channels/chroxy-channel-server.js': { routes: 0, unplaced: 1 },
      'supervisor.js': { routes: 1, unplaced: 0 },
      'ws-server.js': { routes: 2, unplaced: 0 },
    })
  })

  it('no route names a principal: http-routes.js does not mention one', () => {
    assert.equal(/principal/i.test(read('http-routes.js')), false)
  })

  it('the principal store is referenced by no HTTP guard and by no module that reads a bearer', () => {
    const importers = []
    for (const f of srcFiles(SRC)) {
      if (/from '[^']*principal-store\.js'/.test(readFileSync(f.path, 'utf8'))) importers.push(f.rel)
    }
    assert.deepEqual(importers.sort(), ['cli/agent-cmd.js', 'handlers/principal-admin-handlers.js', 'server-cli.js'])
    for (const name of ['_validateBearerAuth', '_validatePrimaryBearerAuth', '_authenticateDashboardRequest', '_validateHookAuth', '_isTokenValid', '_isSessionScopedToken']) {
      const text = methodSource('ws-server.js', name)
      assert.ok(typeof text === 'string' && text.length > 50, `${name} not found`)
      assert.equal(/principal/i.test(text), false, `${name} must not accept a principal`)
    }
    for (const rel of Object.keys(EXPECTED_READS).filter((r) => !['ws-server.js', 'redaction.js', 'anthropic-compatible-config.js'].includes(r))) {
      assert.equal(/principal/i.test(read(rel)), false, rel)
    }
  })

  it('the shell-approval listener is primary-guarded and names no principal', () => {
    const text = read('ws-server.js')
    const at = text.indexOf("path === '/api/shell/pending'")
    assert.ok(at > 0)
    assert.ok(/_validatePrimaryBearerAuth/.test(text.slice(at - 600, at + 400)))
    assert.equal(/principal/i.test(text.slice(at - 600, at + 400)), false)
  })

  describe('mutation fixtures: each construct the old regexes could not see makes the roster check fail on its own', () => {
    const fixtures = []
    const real_routes = read('http-routes.js')
    const root = mkdtempSync(join(tmpdir(), 'chroxy-roster-fixture-'))
    after(() => rmSync(root, { recursive: true, force: true }))

    /** A copy of http-routes.js with `extra` inserted before the dashboard route. */
    function withExtra(name, extra) {
      const marker = "    if (req.method === 'GET' && req.url?.startsWith('/assets/')) {"
      assert.ok(real_routes.includes(marker), 'fixture anchor moved: update this test')
      const path = join(root, `${name}.js`)
      writeFileSync(path, real_routes.replace(marker, `${extra}\n${marker}`))
      fixtures.push(name)
      return path
    }
    const problemsFor = (path) => rosterProblems(inventory(path))

    it('positive control: an untouched copy is clean', () => {
      const path = join(root, 'clean.js')
      writeFileSync(path, real_routes)
      assert.deepEqual(problemsFor(path), [])
    })

    it('a reversed comparison is still a route, and an unlisted one is reported', () => {
      const p = problemsFor(withExtra('reversed', "    if ('GET' === req.method && req.url === '/sneaky') { res.end('x'); return }"))
      assert.ok(p.some((x) => /not in the roster exactly once/.test(x) && /sneaky/.test(x)), JSON.stringify(p))
    })

    it('alternative literal syntax (template literal, bracket access, loose equality) is still a route', () => {
      const a = problemsFor(withExtra('tpl', "    if (req.method === `POST` && req.url === '/sneaky-tpl') { res.end('x'); return }"))
      const b = problemsFor(withExtra('bracket', "    if (req['method'] == 'PUT' && req.url === '/sneaky-bracket') { res.end('x'); return }"))
      const c = problemsFor(withExtra('includes', "    if (['PATCH', 'PUT'].includes(req.method) && req.url === '/sneaky-inc') { res.end('x'); return }"))
      for (const p of [a, b, c]) assert.ok(p.some((x) => /not in the roster exactly once/.test(x)), JSON.stringify(p))
    })

    it('a method test that cannot be resolved to literals is reported as unplaced, not skipped', () => {
      const p = problemsFor(withExtra('unresolved', "    if (req.method === someMethodVariable && req.url === '/sneaky-var') { res.end('x'); return }"))
      assert.ok(p.some((x) => /^unplaced: .*not resolvable/.test(x)), JSON.stringify(p))
      const q = problemsFor(withExtra('alias', "    const m = req.method\n    if (m === 'GET') { res.end('x'); return }"))
      assert.ok(q.some((x) => /^unplaced: .*req\.method used outside a route test/.test(x)), JSON.stringify(q))
    })

    it('a delegated route handler is reported as unplaced', () => {
      const p = problemsFor(withExtra('delegated', "    if (await extraRoutes(server, req, res)) return"))
      assert.ok(p.some((x) => /^unplaced: .*request handed to extraRoutes/.test(x)), JSON.stringify(p))
      const q = problemsFor(withExtra('table', "    const routeFn = TABLE[req.url]\n    if (routeFn) return routeFn(req, res)"))
      assert.ok(q.some((x) => /^unplaced:/.test(x)), JSON.stringify(q))
    })

    it('a path test with no method comparison is reported as unplaced', () => {
      const p = problemsFor(withExtra('nomethod', "    if (req.url === '/any-method') { res.end('x'); return }"))
      assert.ok(p.some((x) => /^unplaced: .*path test with no method/.test(x)), JSON.stringify(p))
    })

    it('an alternative bearer parser is an unaccounted authorization-header read', () => {
      const forms = {
        optional: "    const t1 = req.headers['authorization']?.slice(7)",
        upper: "    const t2 = req.headers['Authorization']",
        template: "    const t3 = req.headers[`authorization`]",
        getter: "    const t4 = req.headers.get('authorization')",
        destructure: "    const { authorization: t5 } = req.headers",
        regex: "    const t6 = /^Bearer (.+)$/.exec(String(1))",
        escape: "    const t7 = extractAuth(req.headers)",
      }
      let cases = 0
      for (const [name, code] of Object.entries(forms)) {
        const p = problemsFor(withExtra(`bearer-${name}`, code))
        cases++
        assert.ok(p.some((x) => /authorization-header reads|handed on whole/.test(x)), `${name}: ${JSON.stringify(p)}`)
      }
      assert.ok(cases === Object.keys(forms).length && cases > 0)
    })

    it('every fixture above was written (the suite is not vacuous)', () => {
      assert.ok(fixtures.length >= 8, `only ${fixtures.length} fixtures ran`)
    })
  })
})

describe('over HTTP: a live principal token is refused on every route; the primary token gets past the same guard', () => {
  let server
  const cleanups = []
  let tmpRoot
  before(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'chroxy-http-roster-')) })
  after(() => { rmSync(tmpRoot, { recursive: true, force: true }) })
  afterEach(() => {
    if (server) { server.close(); server = null }
    while (cleanups.length) cleanups.pop()()
  })

  const REFUSALS = new Set(['unauthorized', 'primary_token_required', 'session_scoped_token', 'forbidden'])

  async function boot() {
    const fixture = tempPrincipalDir()
    cleanups.push(fixture.cleanup)
    const store = testPrincipalStore(fixture.path)
    const { token } = insertPrincipal(store)
    const { manager } = createMockSessionManager([{ id: 'sess-1', name: 'One', cwd: '/tmp/p' }])
    server = new WsServer({
      port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, principalStore: store,
      pagesStore: new PagesStore({ pagesDir: join(tmpRoot, 'pages') }),
    })
    server._ingestSecret = 'test-ingest-secret'
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return { base: `http://127.0.0.1:${server.httpServer.address().port}`, principalToken: token }
  }

  async function call(base, entry, token, { query = '' } = {}) {
    // A route that takes the credential and then waits (a hook permission request is a long
    // poll) is cut off after a moment: that is a request the guard let through (status 0).
    let res
    try {
      res = await fetch(`${base}${entry.url}${query}`, {
      signal: AbortSignal.timeout(1500),
      method: entry.method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(entry.body ? { 'content-type': 'application/json' } : {}) },
      body: entry.body ? JSON.stringify(entry.body) : undefined,
      redirect: 'manual',
      })
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { status: 0, error: 'timeout', text: '' }
      throw err
    }
    const text = await res.text()
    let error = null
    try { error = JSON.parse(text).error ?? null } catch { /* not JSON */ }
    return { status: res.status, error, text }
  }

  const guarded = ROSTER.filter((e) => ['bearer', 'bearer-scoped', 'primary', 'dashboard'].includes(e.guard))
  const secret = ROSTER.filter((e) => ['ingest-secret', 'hmac', 'hook-secret'].includes(e.guard))

  it('the probe set is non-empty and covers every guarded family', () => {
    assert.ok(guarded.length >= 20)
    assert.ok(secret.length >= 5)
    assert.deepEqual([...new Set(guarded.map((e) => e.guard))].sort(), ['bearer', 'bearer-scoped', 'dashboard', 'primary'])
  })

  it('bearer, scoped, primary and dashboard routes: the principal token is refused; the primary token is not', async () => {
    const { base, principalToken } = await boot()
    let cases = 0
    for (const entry of guarded) {
      const refused = await call(base, entry, principalToken)
      cases++
      assert.ok(refused.status === 403 || refused.status === 401, `${entry.method} ${entry.url} accepted a principal token (${refused.status})`)
      if (entry.guard !== 'dashboard') assert.ok(REFUSALS.has(refused.error), `${entry.url}: ${refused.error}`)
      // positive control: the primary token is NOT refused by the same guard
      const accepted = await call(base, entry, 'primary-tok')
      assert.ok(!(REFUSALS.has(accepted.error) && (accepted.status === 401 || accepted.status === 403)), `${entry.method} ${entry.url} refused the primary token (${accepted.status} ${accepted.error})`)
      assert.ok(!(entry.guard === 'dashboard' && accepted.status === 403), 'dashboard refused the primary token')
    }
    assert.ok(cases === guarded.length && cases > 0)
  })

  it('the principal token is not accepted in a query string or cookie on the dashboard either', async () => {
    const { base, principalToken } = await boot()
    const entry = ROSTER.find((e) => e.guard === 'dashboard')
    assert.equal((await call(base, entry, null, { query: `?token=${principalToken}` })).status, 403)
    const res = await fetch(`${base}/dashboard`, { headers: { cookie: `chroxy_auth=${principalToken}` }, redirect: 'manual' })
    assert.equal(res.status, 403)
    const okRes = await fetch(`${base}/dashboard?token=primary-tok`, { redirect: 'manual' })
    assert.notEqual(okRes.status, 403)
  })

  it('secret-guarded routes (ingest secret, GitHub signature, hook secret): the principal token is refused too', async () => {
    const { base, principalToken } = await boot()
    let cases = 0
    for (const entry of secret) {
      const refused = await call(base, entry, principalToken)
      cases++
      assert.ok(refused.status >= 400 && refused.status !== 404, `${entry.method} ${entry.url} gave ${refused.status} to a principal token`)
      assert.notEqual(refused.status, 200)
    }
    assert.ok(cases > 0)
    // positive control for the ingest-secret family: its own secret is not refused as unauthorized
    const ingest = ROSTER.find((e) => e.url === '/api/events')
    const own = await call(base, ingest, 'test-ingest-secret')
    assert.ok(own.status !== 401 && own.status !== 403, `the ingest secret must pass its own guard (${own.status})`)
    const withPrincipal = await call(base, ingest, principalToken)
    assert.equal(withPrincipal.status, 401)
    // positive control for the hook-secret family: no hook secrets registered falls back to the primary token
    const perm = ROSTER.find((e) => e.url === '/permission')
    const primaryOnPerm = await call(base, perm, 'primary-tok')
    assert.ok(primaryOnPerm.status !== 403, `the hook route accepts the primary token when no hook secret is registered (${primaryOnPerm.status})`)
    assert.equal((await call(base, perm, principalToken)).status, 403)
  })

  it('public routes carry no authority: they answer without any token, and a principal token buys nothing more', async () => {
    const { base, principalToken } = await boot()
    const health = ROSTER.find((e) => e.url === '/health')
    const bare = await call(base, health, null)
    const withPrincipal = await call(base, health, principalToken)
    assert.equal(bare.status, withPrincipal.status)
    assert.equal(bare.text, withPrincipal.text)
  })
})
