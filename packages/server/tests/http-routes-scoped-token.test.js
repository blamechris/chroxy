import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parse as acornParse } from 'acorn'
import { fileURLToPath } from 'node:url'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { createMockSessionManager } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Every route the main HTTP listener matches, and what a session-scoped bearer
// token can do there. `refused`: the scoped token gets nothing (403, or 404 when
// the route is not mounted in this fixture). `public`: no credential is involved.
// `own-credential`: authorised by a different secret, which a bearer does not
// substitute for. `limited`: the route accepts a scoped token and limits it to
// that token's session itself.
//
// One entry per `req.method === '...'` matcher in http-routes.js. The count test
// below fails when a matcher is added or removed, so a new route is classified
// here before it ships.
const ROUTES = [
  { m: 'OPTIONS', p: '/anything', kind: 'public' },
  { m: 'GET', p: '/health', kind: 'public' },
  { m: 'GET', p: '/p/some-slug', kind: 'public' },
  { m: 'GET', p: '/version', kind: 'refused' },
  { m: 'GET', p: '/api/daemon/idle', kind: 'refused' },
  { m: 'GET', p: '/mcp/oauth/callback', kind: 'own-credential' },
  { m: 'GET', p: '/metrics', kind: 'refused' },
  { m: 'POST', p: '/api/events', kind: 'own-credential' },
  { m: 'GET', p: '/api/continuations', kind: 'refused' },
  { m: 'POST', p: '/api/github/webhook', kind: 'own-credential' },
  { m: 'POST', p: '/api/mailbox', kind: 'own-credential' },
  { m: 'POST', p: '/api/mailbox/register', kind: 'own-credential' },
  { m: 'GET', p: '/api/snapshots', kind: 'refused' },
  { m: 'DELETE', p: '/api/snapshots/x', kind: 'refused' },
  { m: 'GET', p: '/api/paired-devices', kind: 'refused' },
  { m: 'DELETE', p: '/api/paired-devices', kind: 'refused' },
  { m: 'DELETE', p: '/api/paired-devices/x', kind: 'refused' },
  { m: 'POST', p: '/api/pages', kind: 'refused' },
  { m: 'GET', p: '/api/pages', kind: 'refused' },
  { m: 'DELETE', p: '/api/pages/x', kind: 'refused' },
  { m: 'GET', p: '/api/pool/stats', kind: 'refused' },
  { m: 'GET', p: '/diagnostics', kind: 'refused' },
  { m: 'POST', p: '/permission', kind: 'own-credential' },
  { m: 'POST', p: '/permission-floor', kind: 'own-credential' },
  { m: 'POST', p: '/permission-response', kind: 'limited' },
  { m: 'GET', p: '/connect', kind: 'refused' },
  { m: 'GET', p: '/pairing-code', kind: 'refused' },
  { m: 'POST', p: '/pair-discord', kind: 'refused' },
  { m: 'GET', p: '/qr/session/session-2', kind: 'refused' },
  { m: 'GET', p: '/qr', kind: 'refused' },
  { m: 'GET', p: '/assets/xterm.js', kind: 'public' },
  { m: 'GET', p: '/dashboard', kind: 'refused' },
  // The session's own declared status (#9026). Session-local by construction: the
  // handler admits a pairing token only when it is bound to the session named in
  // the path (see the dedicated tests below); an unbound pairing token, or one
  // bound to another session, is refused with 403.
  { m: 'POST', p: '/api/sessions/session-1/status', kind: 'limited' },
]

describe('HTTP routes and a session-scoped bearer token', () => {
  it('every route matcher is classified (one table entry per matcher)', () => {
    const src = readFileSync(join(SRC, 'http-routes.js'), 'utf8')
    const matchers = src.match(/req\.method === '[A-Z]+'/g) ?? []
    assert.equal(ROUTES.length, matchers.length,
      `http-routes.js has ${matchers.length} route matchers; classify each in ROUTES (found ${ROUTES.length})`)
  })

  it('every classified route is a path the router actually matches (and the reverse by count)', () => {
    const src = readFileSync(join(SRC, 'http-routes.js'), 'utf8')
    for (const r of ROUTES) {
      if (r.p === '/anything') continue // OPTIONS is matched by method alone
      const needle = r.p === '/mcp/oauth/callback' ? 'MCP_OAUTH_CALLBACK_PATH' : r.p.startsWith('/api/sessions/') ? 'api\\/sessions\\/' : r.p.replace(/\/(some-slug|x|session-2|session-1\/status|xterm\.js)$/, '')
      assert.ok(src.includes(`'${needle}`) || src.includes(`${needle}'`) || src.includes(needle), `${r.m} ${r.p}: no matcher for ${needle} in http-routes.js`)
    }
  })

  it('the only opt-ins to scoped tokens are the two reviewed `limited` routes (parsed, not matched as text)', () => {
    // Parsed with acorn so no spelling (an options variable, `!0`, a computed key,
    // a direct token-validity call) goes around a string match.
    const refs = new Map() // `${file}:${name}` -> count of Identifier nodes with that name
    const optInProps = [] // every object property keyed `allowScoped`
    const walk = (node, file, parent = null) => {
      if (!node || typeof node.type !== 'string') return
      if (node.type === 'Identifier' && WATCHED.has(node.name)) {
        const k = `${file}:${node.name}`
        refs.set(k, (refs.get(k) ?? 0) + 1)
      }
      // Only object LITERALS are opt-ins; the destructuring of the option inside
      // _validateBearerAuth is an ObjectPattern.
      // Identifier-keyed AND string-keyed (`{ 'allowScoped': true }`) properties.
      if (node.type === 'Property' && parent?.type === 'ObjectExpression' && !node.computed && (node.key?.name === 'allowScoped' || node.key?.value === 'allowScoped')) optInProps.push({ file, value: node.value })
      // A string or template that spells the option anywhere (a JSON.parse source,
      // a computed key, a concatenation fragment) is a way to build it without the
      // identifier. Nothing in src spells it as a string today.
      if (node.type === 'Literal' && typeof node.value === 'string' && node.value.includes('allowScoped')) stringSpellings.push(file)
      if (node.type === 'TemplateElement' && node.value?.cooked?.includes('allowScoped')) stringSpellings.push(file)
      // A destructuring default (`{ allowScoped = true }`) would opt every caller in.
      if (node.type === 'AssignmentPattern' && node.left?.name === 'allowScoped') defaults.push(`${file}:${node.right.type}:${node.right.value}`)
      if (node.type === 'Property' && node.computed) {
        // A computed key could spell the option without the identifier.
        const k = node.key?.type === 'Literal' ? String(node.key.value) : null
        if (k === 'allowScoped' || k === null) computedKeys.push({ file, k })
      }
      for (const key of Object.keys(node)) {
        const v = node[key]
        if (Array.isArray(v)) v.forEach((x) => walk(x, file, node))
        else if (v && typeof v.type === 'string') walk(v, file, node)
      }
    }
    const WATCHED = new Set(['allowScoped', '_isTokenValid', '_validateBearerAuth', '_isSessionScopedToken'])
    const computedKeys = []
    const stringSpellings = []
    const defaults = []
    const visit = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) visit(full)
        else if (e.name.endsWith('.js')) walk(acornParse(readFileSync(full, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }), full.slice(SRC.length + 1))
      }
    }
    visit(SRC)

    // Every property keyed `allowScoped` is the literal `true`, in exactly the two
    // reviewed places: POST /permission-response (ws-server.js; answers only the
    // token's own session's prompts) and POST /api/sessions/:id/status
    // (http-routes.js; admits a pairing token only when it is bound to the session
    // in the path).
    assert.deepEqual(optInProps.map((p) => `${p.file}:${p.value.type}:${p.value.value}`).sort(),
      ['http-routes.js:Literal:true', 'ws-server.js:Literal:true'])
    // Nothing else mentions the option or reaches the token-validity checks: these
    // counts are the reviewed ones. A new reference (an options variable passed
    // along, another caller of the validity check that skips the scoped-token
    // test) changes a count and must be reviewed and classified above.
    const reviewed = {
      // The status route re-checks the bearer after reading its body.
      'http-routes.js:_isTokenValid': 1,
      'http-routes.js:_validateBearerAuth': 6,
      'http-routes.js:allowScoped': 1,
      'ws-server.js:_validateBearerAuth': 2,
      'ws-server.js:allowScoped': 4,
      'ws-server.js:_isTokenValid': 6,
      'ws-server.js:_isSessionScopedToken': 4,
    }
    assert.deepEqual(Object.fromEntries([...refs].sort()), reviewed)
    // No computed property key (which could spell the option indirectly) in the
    // two files that hold the opt-ins.
    assert.deepEqual(computedKeys.filter((c) => c.file === 'http-routes.js' || c.file === 'ws-server.js'), [])
    // The option is never spelled as a string anywhere in src, and its only
    // destructuring default is the literal `false` (opted out unless asked).
    assert.deepEqual(stringSpellings, [])
    assert.deepEqual(defaults, ['ws-server.js:Literal:false'])
    // No computed key in ANY src file is spelled `allowScoped` (a literal-keyed
    // computed property is caught above; this names the file if one appears).
    assert.deepEqual(computedKeys.filter((c) => c.k === 'allowScoped'), [])
    // The http-routes opt-in sits beside the check that binds the token to the
    // path's session.
    const routes = readFileSync(join(SRC, 'http-routes.js'), 'utf8')
    const at = routes.search(/allowScoped/)
    assert.ok(/bound !== sessionId/.test(routes.slice(at, at + 900)), 'the status route compares the token binding with the session in the path')
  })

  describe('over a real socket', () => {
    class WsServer extends _WsServer {
      constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
      start(...args) { super.start(...args); setLogListener(null) }
    }
    let server
    let pm
    afterEach(() => {
      if (server) { server.close(); server = null }
      if (pm) { pm.destroy(); pm = null }
    })

    async function start() {
      pm = new PairingManager({ wsUrl: 'wss://example.com' })
      const { manager } = createMockSessionManager([
        { id: 'session-1', name: 'One', cwd: '/tmp/project-1' },
        { id: 'session-2', name: 'Two', cwd: '/tmp/project-2' },
      ])
      server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, pairingManager: pm })
      server.start('127.0.0.1')
      await new Promise((resolve) => server.httpServer.once('listening', resolve))
      const scoped = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
      return { port: server.httpServer.address().port, scoped }
    }

    it('refuses the scoped token on every route classified `refused`', async () => {
      const { port, scoped } = await start()
      for (const r of ROUTES.filter((x) => x.kind === 'refused')) {
        const res = await fetch(`http://127.0.0.1:${port}${r.p}`, {
          method: r.m,
          headers: { Authorization: `Bearer ${scoped}`, 'Content-Type': 'application/json' },
          ...(r.m === 'POST' ? { body: '{}' } : {}),
          redirect: 'manual',
        })
        assert.ok([403, 404].includes(res.status), `${r.m} ${r.p} answered a scoped token with ${res.status}`)
        await res.arrayBuffer()
      }
    })

    it('does not treat the scoped token as the credential of an `own-credential` route', async () => {
      const { port, scoped } = await start()
      for (const r of ROUTES.filter((x) => x.kind === 'own-credential')) {
        const res = await fetch(`http://127.0.0.1:${port}${r.p}`, {
          method: r.m,
          headers: { Authorization: `Bearer ${scoped}`, 'Content-Type': 'application/json' },
          ...(r.m === 'POST' ? { body: '{}' } : {}),
        })
        assert.ok(res.status >= 400, `${r.m} ${r.p} accepted a scoped bearer (${res.status})`)
        await res.arrayBuffer()
      }
    })

    it('the status route admits a scoped token for its own session only', async () => {
      const { port, scoped } = await start()
      const post = (path, token, body = '{}') => fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      })
      // Another session\'s id in the path: refused.
      const other = await post('/api/sessions/session-2/status', scoped)
      assert.equal(other.status, 403)
      assert.equal((await other.json()).code, 'SESSION_TOKEN_MISMATCH')
      // An unbound (linking-mode) pairing token is refused for every session.
      const linking = pm.validatePairing(pm.currentPairingId).sessionToken
      assert.equal((await post('/api/sessions/session-1/status', linking)).status, 403)
      // Its own session: past the gate (an empty body fails validation, 400).
      assert.equal((await post('/api/sessions/session-1/status', scoped)).status, 400)
      // Control: the primary token is past the gate for any session.
      assert.equal((await post('/api/sessions/session-2/status', 'primary-tok')).status, 400)
    })
  })
})
