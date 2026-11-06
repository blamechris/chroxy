import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { createPermissionHandler } from '../src/ws-permissions.js'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as acornParse } from 'acorn'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { captureBearer, bearerStillValid } from '../src/bearer-recheck.js'
import { PairingManager } from '../src/pairing.js'
import { TokenManager } from '../src/token-manager.js'
import { createMockSessionManager, createSpy } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { boundedRegex } from '../src/utils/bounded-regex.js'

class WsServer extends _WsServer {
  constructor(o = {}) { super({ noEncrypt: true, ...o }) }
  start(...a) { super.start(...a); setLogListener(null) }
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))
after(() => boundedRegex.close())

let server, pm, tm
afterEach(() => { server?.close(); pm?.destroy(); tm?.destroy(); server = pm = tm = null })

async function boot({ authRequired = true } = {}) {
  pm = new PairingManager({ wsUrl: 'wss://example.com' })
  tm = new TokenManager({ token: 'primary-tok', graceMs: 1000 })
  const made = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/one' }])
  const setDeclaredStatus = createSpy(() => ({ state: 'working' }))
  made.manager.setDeclaredStatus = setDeclaredStatus
  const publish = createSpy(() => ({ slug: 'abc', title: 'T', bytes: 1, createdAt: 1 }))
  const pagesStore = { maxPageBytes: 1000, publish, list: () => [] }
  server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired, pairingManager: pm, tokenManager: tm, pagesStore })
  server.start('127.0.0.1')
  await new Promise((r, j) => { server.httpServer.once('listening', r); server.httpServer.once('error', j) })
  clearInterval(server._pingInterval)
  const session = made.sessionsMap.get('session-1').session
  const answers = []
  session.respondToPermission = (rid, d) => { answers.push({ rid, d }); return true }
  return { port: server.httpServer.address().port, made, setDeclaredStatus, publish, answers }
}

// Headers first, the body later: the window in which a credential can end.
function openPost(port, path, token, body) {
  const sock = net.connect(port, '127.0.0.1')
  let resp = ''
  sock.on('data', (d) => { resp += d })
  sock.on('error', () => {})
  const auth = token ? `Authorization: Bearer ${token}\r\n` : ''
  const head = `POST ${path} HTTP/1.1\r\nHost: x\r\n${auth}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`
  return new Promise((res) => sock.once('connect', () => {
    sock.write(head)
    res({ finish: async () => { sock.write(body); await tick(120); sock.destroy(); return resp.split('\r\n')[0] } })
  }))
}

const mintBound = () => pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
const endPairing = (t) => pm.revokeSessionTokenById(pm._deviceIdForToken(t))
const endPrimary = () => tm.revoke()

// One row per route that reads a body after validating its bearer.
const ROUTES = [
  {
    name: 'POST /permission-response',
    path: '/permission-response',
    tokens: ['pairing', 'primary'],
    prep: () => { server._permissionSessionMap.set('req-1', 'session-1') },
    body: JSON.stringify({ requestId: 'req-1', decision: 'allow' }),
    effects: (b) => b.answers.length,
  },
  {
    name: 'POST /api/sessions/:id/status',
    path: '/api/sessions/session-1/status',
    tokens: ['pairing', 'primary'],
    prep: () => {},
    body: JSON.stringify({ state: 'running', summary: 'working on it' }),
    effects: (b) => b.setDeclaredStatus.callCount,
  },
  {
    name: 'POST /api/pages',
    path: '/api/pages',
    tokens: ['primary'], // host authority: a pairing token is refused up front
    prep: () => {},
    body: JSON.stringify({ title: 'T', html: '<p>x</p>' }),
    effects: (b) => b.publish.callCount,
  },
]

describe('a request whose bearer ended while the body was arriving changes nothing', () => {
  for (const route of ROUTES) {
    for (const kind of route.tokens) {
      const tokenFor = () => (kind === 'pairing' ? mintBound() : 'primary-tok')
      const end = (t) => (kind === 'pairing' ? endPairing(t) : endPrimary())

      it(`${route.name}, ${kind} token: ended before the body completes → 403, nothing changed`, async () => {
        const b = await boot()
        const token = tokenFor()
        route.prep(b)
        const h = await openPost(b.port, route.path, token, route.body)
        await tick()
        end(token)
        const status = await h.finish()
        assert.match(status, /403/)
        assert.equal(route.effects(b), 0)
      })

      it(`${route.name}, ${kind} token: control, still valid when the body completes → accepted`, async () => {
        const b = await boot()
        const token = tokenFor()
        route.prep(b)
        const h = await openPost(b.port, route.path, token, route.body)
        await tick()
        const status = await h.finish()
        assert.match(status, /200/)
        assert.equal(route.effects(b), 1)
      })
    }

    it(`${route.name}, auth off: there is no bearer to re-check, the request is accepted`, async () => {
      const b = await boot({ authRequired: false })
      route.prep(b)
      const h = await openPost(b.port, route.path, null, route.body)
      await tick()
      const status = await h.finish()
      assert.match(status, /200/)
      assert.equal(route.effects(b), 1)
    })
  }
})

// ---------------------------------------------------------------------------
// A tripwire (not a proof) for the shared re-check. Parsed with acorn: the
// INNERMOST if-statement, function declaration or class method that both calls a
// bearer validator and calls a NAMED body reader must also call
// `bearerStillValid` AFTER the first read. A differently spelled reader (an
// inline stream loop, a reader reached through another helper) is not seen; the
// per-route tests above are what establish the behaviour.
// ---------------------------------------------------------------------------
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const VALIDATORS = new Set(['_validateBearerAuth', '_validatePrimaryBearerAuth', 'validateBearerAuth'])
const BODY_READERS = new Set(['readJsonBodyCapped', 'readCappedJson'])
// Reasoned exclusions: these read a body under the per-session hook credential
// (`_validateHookAuth`, not a bearer) and only create a prompt whose answer returns to
// the same caller, or read; nothing executes on the strength of the body.
const REASONED_EXCLUSIONS = ['handlePermissionRequest', 'handlePermissionFloorCheck']

function calleeName(node) {
  const c = node.callee
  if (c.type === 'Identifier') return c.name
  if (c.type === 'MemberExpression' && !c.computed) return c.property.name
  return null
}
function isBodyRead(node) {
  if (node.type !== 'CallExpression') return false
  const name = calleeName(node)
  if (BODY_READERS.has(name)) return true
  // req.on('data', ...)
  return name === 'on' && node.arguments[0]?.type === 'Literal' && node.arguments[0].value === 'data'
}
function facts(node) {
  const out = { validates: false, reads: false, rechecks: false }
  let firstRead = Infinity
  const rechecks = []
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'CallExpression') {
      const name = calleeName(n)
      if (VALIDATORS.has(name)) out.validates = true
      if (isBodyRead(n)) { out.reads = true; firstRead = Math.min(firstRead, n.start) }
      if (name === 'bearerStillValid') rechecks.push(n.start)
    }
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v.type === 'string') walk(v)
    }
  }
  walk(node)
  // The re-check must FOLLOW the read: one before it checks nothing that matters.
  out.rechecks = rechecks.some((at) => at > firstRead)
  return out
}
/** Innermost if/function nodes that validate a bearer and read a body: [{ line, rechecks }] */
function bodyAfterBearerSites(src) {
  const ast = acornParse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const sites = []
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return null
    let childHit = false
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach((x) => { if (visit(x)) childHit = true })
      else if (v && typeof v.type === 'string') { if (visit(v)) childHit = true }
    }
    if (childHit) return true
    if (n.type === 'IfStatement' || n.type === 'FunctionDeclaration' || n.type === 'MethodDefinition') {
      const f = facts(n.type === 'IfStatement' ? n.consequent : n.type === 'MethodDefinition' ? n.value : n)
      if (f.validates && f.reads) { sites.push({ line: n.loc.start.line, rechecks: f.rechecks }); return true }
    }
    return false
  }
  visit(ast)
  return sites
}

describe('tripwire: a named body reader after bearer validation is followed by the shared re-check', () => {
  it('the real routes all go through the shared re-check, and the scan finds the known three', () => {
    const found = []
    const walkDir = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name)
        if (e.isDirectory()) walkDir(f)
        else if (e.name.endsWith('.js')) {
          const src = readFileSync(f, 'utf8')
          if (!/validate\w*BearerAuth/.test(src)) continue
          for (const s of bodyAfterBearerSites(src)) found.push({ file: f.slice(SRC.length + 1), ...s })
        }
      }
    }
    walkDir(SRC)
    assert.deepEqual(found.map((s) => s.file).sort(), ['http-routes.js', 'http-routes.js', 'ws-permissions.js'])
    assert.deepEqual(found.filter((s) => !s.rechecks), [], 'a route reads a body after bearer validation without re-checking it')
  })

  it('positive control: the scan flags a route that reads a body without re-checking', () => {
    const bad = `
      function handler(req, res) {
        if (!server._validateBearerAuth(req, res)) return
        readJsonBodyCapped(req, res, 10).then((b) => { change(b) })
      }`
    const good = `
      function handler(req, res) {
        if (!server._validateBearerAuth(req, res)) return
        const bearer = captureBearer(server, req)
        readJsonBodyCapped(req, res, 10).then((b) => { if (!bearerStillValid(server, bearer)) return; change(b) })
      }`
    assert.deepEqual(bodyAfterBearerSites(bad).map((s) => s.rechecks), [false])
    assert.deepEqual(bodyAfterBearerSites(good).map((s) => s.rechecks), [true])
    // A re-check that comes BEFORE the read does not count.
    const early = `
      function handler(req, res) {
        if (!server._validateBearerAuth(req, res)) return
        if (!bearerStillValid(server, captureBearer(server, req))) return
        readJsonBodyCapped(req, res, 10).then((b) => { change(b) })
      }`
    assert.deepEqual(bodyAfterBearerSites(early).map((s) => s.rechecks), [false])
    // A class method and the other named reader are scanned too.
    const method = `
      class R { handle(req, res) {
        if (!this._validateBearerAuth(req, res)) return
        readCappedJson(req, res, 10, (b) => { change(b) })
      } }`
    assert.deepEqual(bodyAfterBearerSites(method).map((s) => s.rechecks), [false])
  })

  it('the reasoned exclusions read a body but use the hook credential, not a bearer', () => {
    const ast = acornParse(readFileSync(join(SRC, 'ws-permissions.js'), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' })
    const fns = new Map()
    const collect = (n) => {
      if (!n || typeof n.type !== 'string') return
      if (n.type === 'FunctionDeclaration' && n.id) fns.set(n.id.name, n)
      for (const k of Object.keys(n)) {
        const v = n[k]
        if (Array.isArray(v)) v.forEach(collect)
        else if (v && typeof v.type === 'string') collect(v)
      }
    }
    collect(ast)
    for (const name of REASONED_EXCLUSIONS) {
      const f = facts(fns.get(name))
      assert.equal(f.reads, true, `${name} reads a body`)
      assert.equal(f.validates, false, `${name} must not start validating a bearer without a re-check (it would join the scan)`)
    }
  })
})

// ---------------------------------------------------------------------------
describe('the shared re-check helper', () => {
  const pairing = (valid, live) => ({ isSessionTokenValid: () => valid, isSessionTokenLive: () => live })
  const req = (token) => ({ headers: { authorization: `Bearer ${token}` } })

  it('refuses when nothing was captured', () => {
    assert.equal(bearerStillValid({ _isTokenValid: () => true }, null), false)
    assert.equal(bearerStillValid({ _isTokenValid: () => true }, undefined), false)
  })

  it('auth off: nothing to check', () => {
    const c = captureBearer({ authRequired: false }, req('x'))
    assert.equal(bearerStillValid({ _isTokenValid: () => false }, c), true)
  })

  it('a pairing token must still be live, whatever the general validity check says', () => {
    const server = { authRequired: true, _pairingManager: pairing(true, true), _isTokenValid: () => true }
    const c = captureBearer(server, req('t'))
    assert.equal(c.wasPairing, true)
    assert.equal(bearerStillValid(server, c), true)
    const ended = { ...server, _pairingManager: pairing(true, false) }
    assert.equal(bearerStillValid(ended, c), false, 'ended pairing token refused even though _isTokenValid says true')
    assert.equal(bearerStillValid({ ...server, _pairingManager: null }, c), false, 'fails closed with no pairing manager')
  })

  it('any other token is judged by the general validity check, not the pairing one', () => {
    const server = { authRequired: true, _pairingManager: pairing(false, false), _isTokenValid: (t) => t === 'primary' }
    const c = captureBearer(server, req('primary'))
    assert.equal(c.wasPairing, false)
    assert.equal(bearerStillValid(server, c), true, 'valid although the pairing manager does not know it')
    assert.equal(bearerStillValid({ ...server, _isTokenValid: () => false }, c), false)
  })

  it('a request with no bearer header is refused when auth is on', () => {
    const server = { authRequired: true, _pairingManager: null, _isTokenValid: () => true }
    assert.equal(bearerStillValid(server, captureBearer(server, { headers: {} })), false)
  })
})

describe('a permission handler with no re-check wired refuses', () => {
  it('POST /permission-response answers 403 and changes nothing', async () => {
    const answers = []
    const handler = createPermissionHandler({
      sendFn() {}, broadcastFn() {},
      validateBearerAuth: () => true,
      getSessionManager: () => ({ getSession: () => ({ session: { respondToPermission: (...a) => { answers.push(a); return true } } }) }),
      pendingPermissions: new Map(),
      permissionSessionMap: new Map([['req-1', 'session-1']]),
    })
    const req = new EventEmitter()
    req.headers = {}
    req.setEncoding = () => {}
    let status = null
    const res = { writeHead: (s) => { status = s }, end() {} }
    handler.handlePermissionResponseHttp(req, res)
    req.emit('data', JSON.stringify({ requestId: 'req-1', decision: 'allow' }))
    req.emit('end')
    await tick(20)
    assert.equal(status, 403)
    assert.equal(answers.length, 0)
  })
})
