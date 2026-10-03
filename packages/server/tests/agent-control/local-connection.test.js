/**
 * Unit tests for agent-control/local-connection.js — local daemon
 * connection resolution, deliberately NON-MUTATING (never deletes a stale
 * connection.json) and never trusting a public tunnel URL's port for the
 * local dial target.
 *
 * Fixture connection.json files are written under a temp directory and
 * injected via the module's own `deps.getConnectionInfoPath` /
 * `deps.readConnectionInfo` seams — no real `~/.chroxy` state is ever
 * touched.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  resolveLocalConnection,
  resolveConnectionTarget,
  readConnectionInfoNonMutating,
  validateExplicitUrl,
} from '../../src/agent-control/local-connection.js'

describe('readConnectionInfoNonMutating / resolveLocalConnection', () => {
  let dir
  let connFile

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-agent-control-test-'))
    connFile = join(dir, 'connection.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // `readConnectionInfoNonMutating`'s own injection seam is
  // `deps.getConnectionInfoPath`; `resolveLocalConnection`'s is
  // `deps.readConnectionInfo` (a full read function) — the two are NOT the
  // same seam, so a `resolveLocalConnection` fixture must wrap the former
  // inside the latter rather than passing `getConnectionInfoPath` straight
  // through (which `resolveLocalConnection` simply ignores, silently
  // falling back to the REAL default `~/.chroxy/connection.json`).
  const readDeps = () => ({ getConnectionInfoPath: () => connFile })
  const resolveDeps = () => ({ readConnectionInfo: () => readConnectionInfoNonMutating(readDeps()) })

  it('missing connection.json resolves to a typed not_running failure', () => {
    assert.equal(readConnectionInfoNonMutating(readDeps()), null)
    assert.deepEqual(resolveLocalConnection(resolveDeps()), { ok: false, reason: 'not_running' })
  })

  it('unparseable connection.json resolves to a typed failure, not a throw', () => {
    writeFileSync(connFile, '{ not valid json', 'utf-8')
    assert.equal(readConnectionInfoNonMutating(readDeps()), null)
    assert.deepEqual(resolveLocalConnection(resolveDeps()), { ok: false, reason: 'not_running' })
  })

  it('a LIVE pid resolves ok:true with the local port and token', () => {
    writeFileSync(connFile, JSON.stringify({ pid: process.pid, port: 9123, apiToken: 'tok-live' }), 'utf-8')
    const result = resolveLocalConnection(resolveDeps())
    assert.equal(result.ok, true)
    assert.equal(result.port, 9123)
    assert.equal(result.url, 'ws://127.0.0.1:9123')
    assert.equal(result.token, 'tok-live')
  })

  it('a DEAD pid resolves not_running AND leaves the stale file on disk (never deletes it)', () => {
    // Spawn a real child and let it exit, so its pid is genuinely free.
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    assert.equal(child.status, 0)
    const deadPid = child.pid
    writeFileSync(connFile, JSON.stringify({ pid: deadPid, port: 9123, apiToken: 'tok-dead' }), 'utf-8')

    const result = resolveLocalConnection(resolveDeps())
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_running')
    assert.ok(existsSync(connFile), 'a stale connection.json must NOT be deleted by this read-only module')
  })

  it('a missing pid field (no liveness claim) is trusted as-is', () => {
    writeFileSync(connFile, JSON.stringify({ port: 9123, apiToken: 'tok-no-pid' }), 'utf-8')
    const result = resolveLocalConnection(resolveDeps())
    assert.equal(result.ok, true)
    assert.equal(result.port, 9123)
  })

  it('an out-of-range port field is never trusted (falls back to default, not the invalid value)', () => {
    for (const badPort of [0, -1, 70000, 1.5, 'nine']) {
      writeFileSync(connFile, JSON.stringify({ pid: process.pid, port: badPort, apiToken: 'tok' }), 'utf-8')
      const result = resolveLocalConnection(resolveDeps())
      assert.equal(result.ok, true)
      assert.notEqual(result.port, badPort)
    }
  })

  it('a port derived from httpUrl/wsUrl is used ONLY when the URL host is loopback', () => {
    writeFileSync(connFile, JSON.stringify({ pid: process.pid, httpUrl: 'http://127.0.0.1:9200/dashboard', apiToken: 'tok' }), 'utf-8')
    const local = resolveLocalConnection(resolveDeps())
    assert.equal(local.ok, true)
    assert.equal(local.port, 9200)
    assert.equal(local.url, 'ws://127.0.0.1:9200')
  })

  it('a public tunnel URL\'s port is NEVER extracted for the local dial target', () => {
    writeFileSync(connFile, JSON.stringify({ pid: process.pid, httpUrl: 'https://some-tunnel.trycloudflare.com:54321/', apiToken: 'tok' }), 'utf-8')
    const local = resolveLocalConnection(resolveDeps())
    assert.equal(local.ok, true)
    // A non-default URL port survives URL normalization and exercises the guard.
    // Falls through to the module default, and the host is
    // always 127.0.0.1 regardless of what the tunnel URL said.
    assert.equal(local.port, 8765)
    assert.ok(local.url.startsWith('ws://127.0.0.1:'))
  })

  it('the explicit port field is preferred over a loopback URL-derived one', () => {
    writeFileSync(connFile, JSON.stringify({ pid: process.pid, port: 8888, httpUrl: 'http://127.0.0.1:9999/', apiToken: 'tok' }), 'utf-8')
    const local = resolveLocalConnection(resolveDeps())
    assert.equal(local.port, 8888)
  })
})

describe('resolveConnectionTarget', () => {
  it('explicit --url with no token is refused', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'wss://example.com/', env: {} })
    assert.deepEqual(result, { ok: false, reason: 'remote_requires_token' })
  })

  it('explicit --url with userinfo (embedded credentials) is refused', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'ws://user:pass@example.com/', explicitToken: 'tok', env: {} })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'url_contains_credentials')
  })

  it('a non-ws(s) scheme is refused', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'https://example.com/', explicitToken: 'tok', env: {} })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid_url_scheme')
  })

  it('an unparseable URL is refused', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'not a url at all', explicitToken: 'tok', env: {} })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid_url')
  })

  it('a valid wss:// URL plus a token resolves ok:true with source "explicit"', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'wss://example.com/', explicitToken: 'tok-explicit', env: {} })
    assert.deepEqual(result, { ok: true, url: 'wss://example.com/', token: 'tok-explicit', source: 'explicit' })
  })

  it('reads the token from CHROXY_AGENT_CONTROL_TOKEN when explicitToken is not passed', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'wss://example.com/', env: { CHROXY_AGENT_CONTROL_TOKEN: 'tok-from-env' } })
    assert.equal(result.ok, true)
    assert.equal(result.token, 'tok-from-env')
  })

  it('falls back to the local resolver when no explicit URL is given, and reports not_running honestly', () => {
    const result = resolveConnectionTarget({
      env: {},
      deps: { readConnectionInfo: () => null },
    })
    assert.deepEqual(result, { ok: false, reason: 'not_running' })
  })

  it('a running local daemon with a token resolves ok:true with source "local"', () => {
    const result = resolveConnectionTarget({
      env: {},
      deps: { readConnectionInfo: () => ({ pid: process.pid, port: 8765, apiToken: 'tok-local' }) },
    })
    assert.deepEqual(result, { ok: true, url: 'ws://127.0.0.1:8765', token: 'tok-local', source: 'local' })
  })
})

// #7969 — the bearer token travels in the very first `auth` frame, before any
// key exchange, so over plain `ws://` to a host that is not this machine
// anyone on the path can read it, and an identity pin cannot help (the pin is
// checked only AFTER the token has been sent). The resolver therefore refuses
// a remote `ws://` target unless the caller opts in with the boolean `true`.
//
// "Loopback" is a deliberately STRICT, fail-closed definition applied to the
// hostname WHATWG `new URL()` produced: `localhost`, an IPv4 literal in
// 127.0.0.0/8, or `[::1]`. Every row of the REFUSED table is a spelling that
// looks local to a human or to a sloppy prefix/suffix match and is not.
describe('resolveConnectionTarget: ws:// to a non-loopback host (#7969)', () => {
  const TOKEN = 'tok-insecure-transport'

  const REFUSED = [
    ['a public hostname', 'ws://example.com:9'],
    ['a hostname that merely STARTS with a loopback literal', 'ws://127.0.0.1.evil.com:9'],
    ['the same, spelled with a percent-encoded dot (the parser decodes it)', 'ws://127.0.0.1%2eevil.com:9'],
    ['localhost with a trailing dot (a distinct, resolvable name)', 'ws://localhost.:9'],
    ['a subdomain of localhost', 'ws://foo.localhost:9'],
    ['localhost.localdomain', 'ws://localhost.localdomain:9'],
    ['0.0.0.0 (all interfaces, not loopback)', 'ws://0.0.0.0:9'],
    ['a private LAN address', 'ws://192.168.1.5:8765'],
    ['an IPv4-mapped IPv6 loopback (fail closed)', 'ws://[::ffff:127.0.0.1]:9'],
    ['the IPv6 unspecified address', 'ws://[::]:9'],
  ]

  const ALLOWED = [
    ['wss:// to any host', 'wss://example.com:9'],
    ['the IPv4 loopback literal', 'ws://127.0.0.1:9'],
    ['localhost', 'ws://localhost:9'],
    ['LOCALHOST (the parser lowercases it)', 'ws://LOCALHOST:9'],
    ['the IPv6 loopback', 'ws://[::1]:9'],
    ['the IPv6 loopback, long form (the parser normalizes it)', 'ws://[0:0:0:0:0:0:0:1]:9'],
    ['another address in 127.0.0.0/8', 'ws://127.0.0.2:9'],
    ['a shorthand IPv4 the parser expands to 127.0.0.1', 'ws://127.1:9'],
  ]

  for (const [label, url] of REFUSED) {
    it(`refuses ${url} — ${label}`, () => {
      const result = resolveConnectionTarget({ explicitUrl: url, explicitToken: TOKEN, env: {} })
      assert.deepEqual(result, { ok: false, reason: 'insecure_remote_ws' })
    })
  }

  for (const [label, url] of ALLOWED) {
    it(`allows ${url} — ${label}, and returns the URL string unchanged`, () => {
      const result = resolveConnectionTarget({ explicitUrl: url, explicitToken: TOKEN, env: {} })
      assert.deepEqual(result, { ok: true, url, token: TOKEN, source: 'explicit' })
    })
  }

  it('allowInsecureWs: true admits a remote ws:// URL, and the URL string is unchanged', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'ws://example.com:9', explicitToken: TOKEN, allowInsecureWs: true, env: {} })
    assert.deepEqual(result, { ok: true, url: 'ws://example.com:9', token: TOKEN, source: 'explicit' })
  })

  it('allowInsecureWs: true admits every spelling in the REFUSED table (the opt-in is the only way through)', () => {
    for (const [, url] of REFUSED) {
      const result = resolveConnectionTarget({ explicitUrl: url, explicitToken: TOKEN, allowInsecureWs: true, env: {} })
      assert.equal(result.ok, true, `${url} should be admitted with the explicit opt-in`)
    }
  })

  it('only the boolean true opts in — a truthy non-boolean does not', () => {
    for (const truthy of ['false', 'true', 1, {}, [], 'yes']) {
      const result = resolveConnectionTarget({ explicitUrl: 'ws://example.com:9', explicitToken: TOKEN, allowInsecureWs: truthy, env: {} })
      assert.deepEqual(result, { ok: false, reason: 'insecure_remote_ws' }, `allowInsecureWs: ${JSON.stringify(truthy)} must not opt in`)
    }
  })

  it('a ws:// remote URL arriving through CHROXY_AGENT_CONTROL_URL is refused the same way', () => {
    const result = resolveConnectionTarget({ env: { CHROXY_AGENT_CONTROL_URL: 'ws://example.com:9', CHROXY_AGENT_CONTROL_TOKEN: TOKEN } })
    assert.deepEqual(result, { ok: false, reason: 'insecure_remote_ws' })
  })

  it('there is no environment-variable opt-in: an env-configured URL still needs the option', () => {
    const env = { CHROXY_AGENT_CONTROL_URL: 'ws://example.com:9', CHROXY_AGENT_CONTROL_TOKEN: TOKEN, CHROXY_AGENT_CONTROL_ALLOW_INSECURE_WS: '1', CHROXY_ALLOW_INSECURE_WS: '1' }
    assert.deepEqual(resolveConnectionTarget({ env }), { ok: false, reason: 'insecure_remote_ws' })
    assert.equal(resolveConnectionTarget({ env, allowInsecureWs: true }).ok, true)
  })

  it('the insecure-transport refusal wins over the missing-token refusal', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'ws://example.com:9', env: {} })
    assert.deepEqual(result, { ok: false, reason: 'insecure_remote_ws' })
  })

  it('with the opt-in but no token, the missing-token refusal still applies', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'ws://example.com:9', allowInsecureWs: true, env: {} })
    assert.deepEqual(result, { ok: false, reason: 'remote_requires_token' })
  })

  it('embedded credentials still report url_contains_credentials, not the transport refusal', () => {
    const result = resolveConnectionTarget({ explicitUrl: 'ws://user:pass@example.com:9/', explicitToken: TOKEN, env: {} })
    assert.deepEqual(result, { ok: false, reason: 'url_contains_credentials' })
  })

  it('a non-ws(s) scheme and an unparseable URL keep their own reasons, ahead of the transport check', () => {
    assert.equal(resolveConnectionTarget({ explicitUrl: 'http://example.com/', explicitToken: TOKEN, env: {} }).reason, 'invalid_url_scheme')
    assert.equal(resolveConnectionTarget({ explicitUrl: 'not a url at all', explicitToken: TOKEN, env: {} }).reason, 'invalid_url')
  })

  it('the local default path is untouched by the option (no explicit URL, nothing to refuse)', () => {
    const deps = { readConnectionInfo: () => ({ pid: process.pid, port: 8765, apiToken: 'tok-local' }) }
    assert.deepEqual(
      resolveConnectionTarget({ env: {}, deps }),
      { ok: true, url: 'ws://127.0.0.1:8765', token: 'tok-local', source: 'local' },
    )
    assert.deepEqual(
      resolveConnectionTarget({ env: {}, deps, allowInsecureWs: true }),
      { ok: true, url: 'ws://127.0.0.1:8765', token: 'tok-local', source: 'local' },
    )
  })
})

// `validateExplicitUrl` is the ONE implementation of the rule: the resolver and
// `main()`'s fail-fast startup check (mcp-server.js) both call it. Its result
// shape is what lets `main()` tell "refused", "admitted by the opt-in" (warn)
// and "moot" (say so) apart without a second copy of the host logic.
describe('validateExplicitUrl (#7969)', () => {
  it('refuses a remote ws:// URL by default, with the dedicated reason', () => {
    assert.deepEqual(validateExplicitUrl('ws://example.com:9'), { ok: false, reason: 'insecure_remote_ws' })
    assert.deepEqual(validateExplicitUrl('ws://example.com:9', {}), { ok: false, reason: 'insecure_remote_ws' })
    assert.deepEqual(validateExplicitUrl('ws://example.com:9', { allowInsecureWs: false }), { ok: false, reason: 'insecure_remote_ws' })
  })

  it('reports insecureRemoteWs: true when a remote ws:// URL is admitted by the opt-in', () => {
    assert.deepEqual(validateExplicitUrl('ws://example.com:9', { allowInsecureWs: true }), { ok: true, insecureRemoteWs: true })
  })

  it('reports insecureRemoteWs: false wherever the opt-in is moot', () => {
    for (const url of ['wss://example.com:9', 'ws://127.0.0.1:9', 'ws://localhost:9', 'ws://[::1]:9']) {
      assert.deepEqual(validateExplicitUrl(url), { ok: true, insecureRemoteWs: false }, url)
      assert.deepEqual(validateExplicitUrl(url, { allowInsecureWs: true }), { ok: true, insecureRemoteWs: false }, url)
    }
  })

  it('only the boolean true opts in', () => {
    for (const truthy of ['false', 'true', 1, {}]) {
      assert.deepEqual(validateExplicitUrl('ws://example.com:9', { allowInsecureWs: truthy }), { ok: false, reason: 'insecure_remote_ws' })
    }
  })

  it('checks in order — parse, scheme, credentials, then transport — and the first failure wins', () => {
    assert.equal(validateExplicitUrl('not a url at all').reason, 'invalid_url')
    assert.equal(validateExplicitUrl('http://example.com/').reason, 'invalid_url_scheme')
    assert.equal(validateExplicitUrl('ws://user:pass@example.com/').reason, 'url_contains_credentials')
    assert.equal(validateExplicitUrl('ws://:pass@example.com/').reason, 'url_contains_credentials')
  })

  it('a loopback-looking prefix with a remote suffix is remote (the host is judged whole, never by prefix)', () => {
    for (const url of ['ws://127.0.0.1.evil.com:9', 'ws://localhost.evil.com:9', 'ws://127.evil.com:9', 'ws://[::1].evil.com:9']) {
      let verdict
      try { verdict = validateExplicitUrl(url) } catch { verdict = { ok: false, reason: 'threw' } }
      assert.equal(verdict.ok, false, `${url} must not be treated as loopback`)
    }
  })

  it('an IPv6-looking or IPv4-mapped host other than [::1] is remote', () => {
    for (const url of ['ws://[::2]:9', 'ws://[::ffff:7f:1]:9', 'ws://[::ffff:127.0.0.1]:9', 'ws://[fe80::1]:9']) {
      assert.deepEqual(validateExplicitUrl(url), { ok: false, reason: 'insecure_remote_ws' }, url)
    }
  })

  // The transport gate and the port fallback answer DIFFERENT questions and
  // use different predicates on purpose (see the note above
  // `hostStaysOnThisMachine` in local-connection.js). The gate admits all of
  // 127.0.0.0/8; the fallback only borrows a port from a URL that names the
  // listener resolveLocalConnection dials at 127.0.0.1. These expectations are
  // what `origin/main` produced before the gate existed — a regression here
  // changes where the local DEFAULT path dials.
  it('the port fallback keeps its own exact-match predicate: 127.0.0.1, localhost, [::1] donate a port', () => {
    const cases = [
      ['httpUrl', 'http://127.0.0.1:9300/', 9300],
      ['httpUrl', 'http://localhost:9301/dashboard', 9301],
      ['httpUrl', 'http://[::1]:9302/', 9302],
      ['wsUrl', 'ws://127.0.0.1:9303/', 9303],
      ['wsUrl', 'ws://localhost:9304/', 9304],
      ['wsUrl', 'ws://[::1]:9305/', 9305],
    ]
    for (const [field, url, port] of cases) {
      const info = { pid: process.pid, [field]: url, apiToken: 'tok' }
      assert.equal(resolveLocalConnection({ readConnectionInfo: () => info }).port, port, `${field}: ${url}`)
    }
  })

  it('the port fallback does NOT borrow a port from a URL that is loopback-range but not the dialed listener', () => {
    // 127.0.0.2 is admitted by the TRANSPORT gate (it stays on this machine),
    // but it is not the socket at 127.0.0.1: origin/main resolves the default
    // port here, and so must this.
    for (const url of ['http://127.0.0.2:9300/', 'http://127.1.2.3:9300/', 'http://127.0.0.1.evil.com:9301/', 'http://0.0.0.0:9302/', 'http://localhost.:9303/', 'http://foo.localhost:9304/']) {
      for (const field of ['httpUrl', 'wsUrl']) {
        const info = { pid: process.pid, [field]: url, apiToken: 'fixture' }
        const result = resolveLocalConnection({ readConnectionInfo: () => info })
        assert.equal(result.port, 8765, `${field}: ${url} must not donate its port`)
        assert.equal(result.url, 'ws://127.0.0.1:8765', `${field}: ${url}`)
      }
    }
  })

  it('the gate and the port fallback disagree on 127.0.0.2, deliberately', () => {
    assert.equal(validateExplicitUrl('ws://127.0.0.2:9').ok, true, 'the gate admits it as an explicit URL')
    const info = { pid: process.pid, httpUrl: 'http://127.0.0.2:9300/', apiToken: 'fixture' }
    assert.equal(resolveLocalConnection({ readConnectionInfo: () => info }).port, 8765, 'the fallback does not borrow its port')
  })
})
