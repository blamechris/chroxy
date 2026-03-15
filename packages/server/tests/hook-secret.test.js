import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

import { createPermissionHandler } from '../src/ws-permissions.js'

// ---------------------------------------------------------------------------
// Helper: minimal mock HTTP req/res for validateHookAuth tests
// ---------------------------------------------------------------------------
function makeReqRes({ authHeader } = {}) {
  const req = {
    headers: {
      authorization: authHeader || '',
    },
    on() {},
  }
  let statusCode = null
  let body = null
  const res = {
    statusCode: null,
    writeHead(code) { statusCode = code },
    end(b) { body = b },
    get _statusCode() { return statusCode },
    get _body() { return body },
  }
  return { req, res }
}

// ---------------------------------------------------------------------------
// Inline WsServer-like hook secret registry (tests the logic independently)
// ---------------------------------------------------------------------------
function createHookAuthValidator({ authRequired = true, hookSecrets = new Set(), apiToken = 'main-token' } = {}) {
  function isTokenValid(token) {
    // Constant-time-like compare (simplified for tests)
    return token === apiToken
  }

  return function validateHookAuth(req, res) {
    if (!authRequired) return true
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    }
    if (hookSecrets.size > 0) {
      if (!hookSecrets.has(token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return false
      }
      return true
    }
    // No hook secrets — fall back to main token
    if (!isTokenValid(token)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    }
    return true
  }
}

// ---------------------------------------------------------------------------
// Tests: _validateHookAuth logic
// ---------------------------------------------------------------------------
describe('validateHookAuth — no hook secrets registered (fallback to main token)', () => {
  it('allows main API token when no hook secrets registered', () => {
    const validate = createHookAuthValidator({ hookSecrets: new Set() })
    const { req, res } = makeReqRes({ authHeader: 'Bearer main-token' })
    assert.equal(validate(req, res), true)
  })

  it('rejects unknown token when no hook secrets registered', () => {
    const validate = createHookAuthValidator({ hookSecrets: new Set() })
    const { req, res } = makeReqRes({ authHeader: 'Bearer wrong-token' })
    assert.equal(validate(req, res), false)
    assert.equal(res._statusCode, 403)
  })

  it('rejects missing Authorization header', () => {
    const validate = createHookAuthValidator({ hookSecrets: new Set() })
    const { req, res } = makeReqRes({ authHeader: '' })
    assert.equal(validate(req, res), false)
    assert.equal(res._statusCode, 403)
  })
})

describe('validateHookAuth — with registered hook secrets', () => {
  it('allows a registered hook secret', () => {
    const hookSecrets = new Set(['abc123hook'])
    const validate = createHookAuthValidator({ hookSecrets })
    const { req, res } = makeReqRes({ authHeader: 'Bearer abc123hook' })
    assert.equal(validate(req, res), true)
  })

  it('rejects the main API token when hook secrets are registered', () => {
    const hookSecrets = new Set(['abc123hook'])
    const validate = createHookAuthValidator({ hookSecrets })
    // The primary API token must NOT be accepted when hook secrets are active
    const { req, res } = makeReqRes({ authHeader: 'Bearer main-token' })
    assert.equal(validate(req, res), false)
    assert.equal(res._statusCode, 403)
  })

  it('rejects an unregistered token when hook secrets are registered', () => {
    const hookSecrets = new Set(['abc123hook'])
    const validate = createHookAuthValidator({ hookSecrets })
    const { req, res } = makeReqRes({ authHeader: 'Bearer stale-or-wrong' })
    assert.equal(validate(req, res), false)
    assert.equal(res._statusCode, 403)
  })

  it('allows any of multiple registered secrets', () => {
    const hookSecrets = new Set(['secret-a', 'secret-b'])
    const validate = createHookAuthValidator({ hookSecrets })
    const { req: ra, res: rsa } = makeReqRes({ authHeader: 'Bearer secret-a' })
    const { req: rb, res: rsb } = makeReqRes({ authHeader: 'Bearer secret-b' })
    assert.equal(validate(ra, rsa), true)
    assert.equal(validate(rb, rsb), true)
  })

  it('reverts to main token fallback after all secrets are removed', () => {
    const hookSecrets = new Set(['temp-secret'])
    const validate = createHookAuthValidator({ hookSecrets })

    // With secret registered: main token is rejected
    const { req: r1, res: rs1 } = makeReqRes({ authHeader: 'Bearer main-token' })
    assert.equal(validate(r1, rs1), false)

    // Remove the secret — now main token is accepted again
    hookSecrets.delete('temp-secret')
    const { req: r2, res: rs2 } = makeReqRes({ authHeader: 'Bearer main-token' })
    assert.equal(validate(r2, rs2), true)
  })
})

describe('validateHookAuth — auth disabled', () => {
  it('always returns true when authRequired is false', () => {
    const validate = createHookAuthValidator({ authRequired: false })
    const { req, res } = makeReqRes({ authHeader: '' })
    assert.equal(validate(req, res), true)
  })
})

// ---------------------------------------------------------------------------
// Tests: createPermissionHandler uses validateHookAuth for POST /permission
// ---------------------------------------------------------------------------
describe('createPermissionHandler — validateHookAuth integration', () => {
  it('uses validateHookAuth for POST /permission, falls back to validateBearerAuth when not provided', () => {
    let hookAuthCalled = false
    let bearerAuthCalled = false

    const handler = createPermissionHandler({
      sendFn: () => {},
      broadcastFn: () => {},
      validateBearerAuth: (_req, _res) => { bearerAuthCalled = true; return false },
      validateHookAuth: (_req, _res) => { hookAuthCalled = true; return false },
      pendingPermissions: new Map(),
      permissionSessionMap: new Map(),
      getSessionManager: () => null,
      pushManager: null,
    })

    const req = { headers: { authorization: 'Bearer test' }, on() {} }
    let statusCode = null
    const res = {
      writeHead(code) { statusCode = code },
      end() {},
      on() {},
    }

    handler.handlePermissionRequest(req, res)

    assert.equal(hookAuthCalled, true, 'validateHookAuth should be called for /permission')
    assert.equal(bearerAuthCalled, false, 'validateBearerAuth should NOT be called for /permission')
  })

  it('falls back to validateBearerAuth when validateHookAuth is not provided', () => {
    let bearerAuthCalled = false

    const handler = createPermissionHandler({
      sendFn: () => {},
      broadcastFn: () => {},
      validateBearerAuth: (_req, _res) => { bearerAuthCalled = true; return false },
      // validateHookAuth intentionally omitted
      pendingPermissions: new Map(),
      permissionSessionMap: new Map(),
      getSessionManager: () => null,
      pushManager: null,
    })

    const req = { headers: { authorization: 'Bearer test' }, on() {} }
    const res = {
      writeHead() {},
      end() {},
      on() {},
    }

    handler.handlePermissionRequest(req, res)
    assert.equal(bearerAuthCalled, true, 'should fall back to validateBearerAuth')
  })
})

// ---------------------------------------------------------------------------
// Tests: WsServer registerHookSecret / unregisterHookSecret
// ---------------------------------------------------------------------------
describe('WsServer hook secret registry', () => {
  // Import the actual WsServer to test the registry methods
  // We test the logic directly without starting a full server

  it('registerHookSecret adds secret to _hookSecrets', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const server = new WsServer({ apiToken: 'test-api', authRequired: false })
    server.registerHookSecret('my-secret')
    assert.ok(server._hookSecrets.has('my-secret'))
  })

  it('unregisterHookSecret removes secret from _hookSecrets', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const server = new WsServer({ apiToken: 'test-api', authRequired: false })
    server.registerHookSecret('my-secret')
    server.unregisterHookSecret('my-secret')
    assert.ok(!server._hookSecrets.has('my-secret'))
  })

  it('registerHookSecret ignores falsy values', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const server = new WsServer({ apiToken: 'test-api', authRequired: false })
    server.registerHookSecret(null)
    server.registerHookSecret(undefined)
    server.registerHookSecret('')
    assert.equal(server._hookSecrets.size, 0)
  })

  it('unregisterHookSecret is safe to call with unknown secret', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const server = new WsServer({ apiToken: 'test-api', authRequired: false })
    assert.doesNotThrow(() => server.unregisterHookSecret('nonexistent'))
  })

  it('_validateHookAuth accepts a registered hook secret', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const server = new WsServer({ apiToken: 'main-token', authRequired: true })
    const secret = 'session-hook-secret'
    server.registerHookSecret(secret)

    const req = { headers: { authorization: `Bearer ${secret}` } }
    let rejected = false
    const res = {
      writeHead() { rejected = true },
      end() {},
    }

    const result = server._validateHookAuth(req, res)
    assert.equal(result, true)
    assert.equal(rejected, false)
  })

  it('_validateHookAuth rejects main API token when hook secrets are registered', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const server = new WsServer({ apiToken: 'main-token', authRequired: true })
    server.registerHookSecret('session-hook-secret')

    const req = { headers: { authorization: 'Bearer main-token' } }
    let statusCode = null
    const res = {
      writeHead(code) { statusCode = code },
      end() {},
    }

    const result = server._validateHookAuth(req, res)
    assert.equal(result, false)
    assert.equal(statusCode, 403)
  })

  it('_validateHookAuth falls back to main token when no hook secrets registered', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const server = new WsServer({ apiToken: 'main-token', authRequired: true })

    const req = { headers: { authorization: 'Bearer main-token' } }
    const res = { writeHead() {}, end() {} }

    const result = server._validateHookAuth(req, res)
    assert.equal(result, true)
  })

  it('_validateHookAuth returns true when authRequired is false', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const server = new WsServer({ apiToken: 'main-token', authRequired: false })

    const req = { headers: { authorization: '' } }
    const res = { writeHead() {}, end() {} }

    assert.equal(server._validateHookAuth(req, res), true)
  })
})

// ---------------------------------------------------------------------------
// Tests: WsServer legacy cliSession mode — hook secret registered at construction
// ---------------------------------------------------------------------------
describe('WsServer legacy cliSession mode — hook secret auto-registration', () => {
  it('registers cliSession hook secret in _hookSecrets at construction time', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const fakeCliSession = { _hookSecret: 'legacy-hook-secret-abc123' }
    const server = new WsServer({ apiToken: 'main-token', authRequired: true, cliSession: fakeCliSession })
    assert.ok(server._hookSecrets.has('legacy-hook-secret-abc123'), '_hookSecrets should contain the cliSession hook secret')
  })

  it('_validateHookAuth accepts the cliSession hook secret in legacy mode', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const fakeCliSession = { _hookSecret: 'legacy-hook-secret-abc123' }
    const server = new WsServer({ apiToken: 'main-token', authRequired: true, cliSession: fakeCliSession })

    const req = { headers: { authorization: 'Bearer legacy-hook-secret-abc123' } }
    const res = { writeHead() {}, end() {} }
    assert.equal(server._validateHookAuth(req, res), true)
  })

  it('_validateHookAuth rejects main API token in legacy mode (hook secret registered)', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const fakeCliSession = { _hookSecret: 'legacy-hook-secret-abc123' }
    const server = new WsServer({ apiToken: 'main-token', authRequired: true, cliSession: fakeCliSession })

    const req = { headers: { authorization: 'Bearer main-token' } }
    let statusCode = null
    const res = { writeHead(code) { statusCode = code }, end() {} }
    assert.equal(server._validateHookAuth(req, res), false)
    assert.equal(statusCode, 403)
  })

  it('does not register a hook secret when cliSession has no _hookSecret', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const fakeCliSession = {} // no _hookSecret property
    const server = new WsServer({ apiToken: 'main-token', authRequired: true, cliSession: fakeCliSession })
    assert.equal(server._hookSecrets.size, 0)
  })
})
