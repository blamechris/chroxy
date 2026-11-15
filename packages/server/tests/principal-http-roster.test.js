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
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'
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

/** Calls that mark a guard family inside a route's consequent. Order matters: the first hit wins. */
const FAMILY_MARKS = [
  ['dashboard', /_authenticateDashboardRequest/],
  ['primary', /_validatePrimaryBearerAuth/],
  ['bearer-scoped', /_validateBearerAuth\(req, res, \{ allowScoped: true \}\)/],
  ['bearer', /_validateBearerAuth\(req, res\)/],
  ['ingest-secret', /handleEventIngest|handleMailbox/],
  ['hmac', /handleGithubWebhook/],
  ['hook-secret', /_permissions\.handle(PermissionRequest|PermissionFloorCheck)/],
  // /permission-response checks a bearer through the shared validator, scoped tokens allowed
  ['bearer-scoped', /_permissions\.handlePermissionResponseHttp/],
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

/** Every `if (req.method === ...)` route in http-routes.js, with the family its body uses. */
function sourceRoutes() {
  const src = read('http-routes.js')
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
  const routes = []
  walk(ast, (n) => {
    if (n.type !== 'IfStatement') return
    const test = src.slice(n.test.start, n.test.end).replace(/\s+/g, ' ')
    const m = /req\.method === '([A-Z]+)'/.exec(test)
    if (!m) return
    const body = src.slice(n.consequent.start, n.consequent.end)
    const mark = FAMILY_MARKS.find(([, re]) => re.test(body))
    routes.push({ method: m[1], test, family: mark ? mark[0] : 'public' })
  })
  return routes
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

describe('the HTTP route roster, checked in both directions against the source', () => {
  const routes = sourceRoutes()
  const matchesRoute = (entry, route) => entry.method === route.method && route.test.includes(entry.match)

  it('enumerates a non-empty route set from the source and a non-empty roster', () => {
    assert.ok(routes.length >= 30, `the scan found only ${routes.length} routes`)
    assert.ok(ROSTER.length > 0)
  })

  it('every route in http-routes.js is in the roster exactly once (a new route is red until classified)', () => {
    const unlisted = routes.filter((r) => ROSTER.filter((e) => matchesRoute(e, r)).length !== 1).map((r) => `${r.method} ${r.test.slice(0, 90)}`)
    assert.deepEqual(unlisted, [])
  })

  it('every roster entry is a real route (a listed route that does not exist is red)', () => {
    const stale = ROSTER.filter((e) => !routes.some((r) => matchesRoute(e, r))).map((e) => `${e.method} ${e.url}`)
    assert.deepEqual(stale, [])
  })

  it('the guard family the source uses for each route equals the roster guard (no route quietly changes class)', () => {
    let cases = 0
    for (const route of routes) {
      const entry = ROSTER.find((e) => matchesRoute(e, route))
      cases++
      assert.equal(route.family, entry.guard, `${route.method} ${entry.url}: source uses ${route.family}, roster says ${entry.guard}`)
    }
    assert.ok(cases > 0)
  })

  it('no route names a principal: http-routes.js does not mention one', () => {
    assert.equal(/principal/i.test(read('http-routes.js')), false)
  })

  it('every place a bearer is parsed is accounted for (file -> count), so a new bearer sink is red', () => {
    const counts = {}
    const walkDir = (dir, prefix = '') => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) walkDir(join(dir, d.name), `${prefix}${d.name}/`)
        else if (d.name.endsWith('.js')) {
          const n = (readFileSync(join(dir, d.name), 'utf8').match(/startsWith\('Bearer '\)/g) || []).length
          if (n > 0) counts[`${prefix}${d.name}`] = n
        }
      }
    }
    walkDir(SRC)
    // The independent oracle. Each is a guard family above, an HTTP-only credential
    // (ingest secret, hook secret) or the dashboard cookie/bearer reader; none reads the
    // principal store, which the next test proves.
    assert.deepEqual(counts, {
      'bearer-recheck.js': 1,
      'event-ingest.js': 1,
      'mailbox-route.js': 1,
      'ws-permissions.js': 3,
      'ws-server.js': 4,
    })
  })

  it('the principal store is referenced by no HTTP guard and by no module that parses a bearer', () => {
    const importers = []
    const walkDir = (dir, prefix = '') => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) walkDir(join(dir, d.name), `${prefix}${d.name}/`)
        else if (d.name.endsWith('.js') && /from '[^']*principal-store\.js'/.test(readFileSync(join(dir, d.name), 'utf8'))) importers.push(`${prefix}${d.name}`)
      }
    }
    walkDir(SRC)
    assert.deepEqual(importers.sort(), ['cli/agent-cmd.js', 'handlers/principal-admin-handlers.js', 'server-cli.js'])
    for (const name of ['_validateBearerAuth', '_validatePrimaryBearerAuth', '_authenticateDashboardRequest', '_validateHookAuth', '_isTokenValid', '_isSessionScopedToken']) {
      const text = methodSource('ws-server.js', name)
      assert.ok(typeof text === 'string' && text.length > 50, `${name} not found`)
      assert.equal(/principal/i.test(text), false, `${name} must not accept a principal`)
    }
    for (const file of ['event-ingest.js', 'mailbox-route.js', 'ws-permissions.js', 'bearer-recheck.js', 'http-routes.js']) {
      assert.equal(/principal/i.test(read(file)), false, file)
    }
  })

  it('the shell-approval listener is primary-guarded and names no principal', () => {
    const text = methodSource('ws-server.js', '_handleShellApprovalRequest') ?? read('ws-server.js').slice(read('ws-server.js').indexOf("path === '/api/shell/pending'") - 600, read('ws-server.js').indexOf("path === '/api/shell/pending'") + 400)
    assert.ok(/_validatePrimaryBearerAuth/.test(text))
    assert.equal(/principal/i.test(text), false)
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
