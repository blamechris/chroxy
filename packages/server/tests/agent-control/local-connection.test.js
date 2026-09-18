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
