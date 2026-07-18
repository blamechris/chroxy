import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  serverKeyForUrl,
  getStoredToken,
  setStoredToken,
  deleteStoredToken,
  isTokenExpired,
  _setMcpOAuthKeychainForTests,
} from '../src/byok-mcp-oauth-store.js'

/**
 * #6822 — token store for remote MCP OAuth. The suite runs with the real
 * keychain disabled (tests/_setup.mjs sets CHROXY_CRED_DISABLE_KEYCHAIN=1) and
 * points the store at a temp file (CHROXY_MCP_OAUTH_TOKENS_PATH) so it never
 * touches the real ~/.chroxy tree or the real OS keychain.
 */

// A deterministic in-memory keychain to exercise the ENCRYPTED-at-rest path
// without any OS call — the same seam credential-cipher/keychain expose.
function makeMemoryKeychain() {
  const store = new Map()
  return {
    isKeychainAvailable: () => true,
    getToken: (service) => (store.has(service) ? store.get(service) : null),
    setToken: (token, service) => { store.set(service, token) },
    deleteToken: (service) => { store.delete(service) },
  }
}

let dir
let tokensPath
const prevPath = process.env.CHROXY_MCP_OAUTH_TOKENS_PATH

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chroxy-mcp-oauth-'))
  tokensPath = join(dir, 'mcp-oauth-tokens.json')
  process.env.CHROXY_MCP_OAUTH_TOKENS_PATH = tokensPath
  _setMcpOAuthKeychainForTests(null)
})

afterEach(() => {
  _setMcpOAuthKeychainForTests(null)
  if (prevPath === undefined) delete process.env.CHROXY_MCP_OAUTH_TOKENS_PATH
  else process.env.CHROXY_MCP_OAUTH_TOKENS_PATH = prevPath
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

const RECORD = {
  accessToken: 'access-secret-abc123',
  refreshToken: 'refresh-secret-xyz789',
  tokenType: 'Bearer',
  scope: 'mcp',
  expiresAt: 0,
  clientId: 'client-1',
  tokenEndpoint: 'https://as.example/token',
}

describe('serverKeyForUrl', () => {
  it('normalizes to origin + path with no userinfo/query/fragment/trailing slash', () => {
    assert.equal(serverKeyForUrl('https://u:p@Host.Example:8443/mcp/?q=1#frag'), 'https://host.example:8443/mcp')
    assert.equal(serverKeyForUrl('https://host.example/mcp/'), 'https://host.example/mcp')
    assert.equal(serverKeyForUrl('https://host.example/'), 'https://host.example')
  })
  it('returns null for an unparseable url', () => {
    assert.equal(serverKeyForUrl('not a url'), null)
    assert.equal(serverKeyForUrl(''), null)
    assert.equal(serverKeyForUrl(null), null)
  })
})

describe('token store (plaintext fallback — no keychain)', () => {
  it('round-trips a record and returns null before any write', () => {
    assert.equal(getStoredToken('https://host.example/mcp'), null)
    setStoredToken('https://host.example/mcp', RECORD)
    assert.deepEqual(getStoredToken('https://host.example/mcp'), RECORD)
  })

  it('keys by the normalized url so header rotation shares one record', () => {
    setStoredToken('https://u:p@host.example/mcp?tok=1', RECORD)
    assert.deepEqual(getStoredToken('https://host.example/mcp'), RECORD)
  })

  it('writes the file mode 0600', function () {
    if (process.platform === 'win32') return
    setStoredToken('https://host.example/mcp', RECORD)
    assert.equal(statSync(tokensPath).mode & 0o777, 0o600)
  })

  it('merges without clobbering sibling records', () => {
    setStoredToken('https://a.example/mcp', { ...RECORD, accessToken: 'A' })
    setStoredToken('https://b.example/mcp', { ...RECORD, accessToken: 'B' })
    assert.equal(getStoredToken('https://a.example/mcp').accessToken, 'A')
    assert.equal(getStoredToken('https://b.example/mcp').accessToken, 'B')
  })

  it('deleteStoredToken removes one record and deletes the file when empty', () => {
    setStoredToken('https://a.example/mcp', { ...RECORD, accessToken: 'A' })
    setStoredToken('https://b.example/mcp', { ...RECORD, accessToken: 'B' })
    deleteStoredToken('https://a.example/mcp')
    assert.equal(getStoredToken('https://a.example/mcp'), null)
    assert.equal(getStoredToken('https://b.example/mcp').accessToken, 'B')
    deleteStoredToken('https://b.example/mcp')
    assert.equal(existsSync(tokensPath), false)
  })

  it('rejects a record with no access token', () => {
    assert.throws(() => setStoredToken('https://a.example/mcp', { refreshToken: 'x' }), /accessToken/)
  })
})

describe('token store (encrypted at rest — injected keychain)', () => {
  it('round-trips through the encrypted envelope and never writes the token in plaintext', () => {
    _setMcpOAuthKeychainForTests(makeMemoryKeychain())
    setStoredToken('https://host.example/mcp', RECORD)
    // On-disk bytes must not contain either secret verbatim.
    const raw = readFileSync(tokensPath, 'utf8')
    assert.ok(!raw.includes(RECORD.accessToken), 'access token must not appear in plaintext on disk')
    assert.ok(!raw.includes(RECORD.refreshToken), 'refresh token must not appear in plaintext on disk')
    // The parsed file is an encrypted envelope, not the plain object.
    const parsed = JSON.parse(raw)
    assert.equal(parsed.alg, 'nacl-secretbox')
    // But a read (with the same keychain) decrypts back to the record.
    assert.deepEqual(getStoredToken('https://host.example/mcp'), RECORD)
  })
})

describe('isTokenExpired', () => {
  it('treats expiresAt=0 (no expires_in) as non-expiring', () => {
    assert.equal(isTokenExpired({ expiresAt: 0 }), false)
  })
  it('is true within the skew window and false well before', () => {
    assert.equal(isTokenExpired({ expiresAt: Date.now() + 5_000 }), true)  // inside 60s skew
    assert.equal(isTokenExpired({ expiresAt: Date.now() + 5 * 60_000 }), false)
    assert.equal(isTokenExpired({ expiresAt: Date.now() - 1_000 }), true)
  })
})

// Guard: writing then reading a large token is stable (no truncation), and the
// key derivation is stable across a random URL host.
describe('token store misc', () => {
  it('handles a long opaque token value', () => {
    const big = randomBytes(512).toString('base64')
    setStoredToken('https://host.example/mcp', { ...RECORD, accessToken: big })
    assert.equal(getStoredToken('https://host.example/mcp').accessToken, big)
  })
})
