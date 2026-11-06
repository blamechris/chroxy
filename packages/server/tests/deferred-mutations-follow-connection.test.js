import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { SessionManager } from '../src/session-manager.js'
import { CheckpointManager } from '../src/checkpoint-manager.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { AuthorityRevokedError, isAuthorityRevoked } from '../src/connection-authority.js'
import { createMockSessionManager, createSpy, waitFor, GIT, disableRepoAutoGc, rmDirRobust } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

// Work that waits (a lock, a survey, a trust prompt, path resolution) must not
// start its mutation for a connection whose credential went away during the wait.
// `isAuthorized` is the one mechanism; each case flips it DURING the wait.

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...a) { super.start(...a); setLogListener(null) }
}

function flag() {
  const f = { ok: true, isAuthorized: () => f.ok }
  return f
}

function tempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-deferred-'))
  execFileSync(GIT, ['init'], { cwd: dir })
  disableRepoAutoGc(dir)
  execFileSync(GIT, ['config', 'user.email', 't@t.com'], { cwd: dir })
  execFileSync(GIT, ['config', 'user.name', 'T'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'one')
  execFileSync(GIT, ['add', '.'], { cwd: dir })
  execFileSync(GIT, ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'chroxy-deferred-sm-'))
  return join(_tmp, `state-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (_tmp) rmSync(_tmp, { recursive: true, force: true }) })

describe('file writes', () => {
  let dir
  let results
  let ops
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-deferred-fs-'))
    results = []
    ops = createFileOps((_ws, msg) => results.push(msg), dir)
  })
  afterEach(() => rmDirRobust(dir))

  it('control: write_file writes while authorized', async () => {
    await ops.writeFile({}, 'sub/new.txt', 'hello', dir, () => true)
    assert.equal(readFileSync(join(dir, 'sub', 'new.txt'), 'utf8'), 'hello')
  })

  it('write_file creates nothing once the connection is no longer authorized', async () => {
    const f = flag()
    const p = ops.writeFile({}, 'sub/new.txt', 'hello', dir, f.isAuthorized)
    f.ok = false // revoked while the path was being resolved
    await p
    assert.equal(existsSync(join(dir, 'sub')), false, 'not even the parent directory')
    assert.equal(existsSync(join(dir, 'sub', 'new.txt')), false)
  })

  it('write_file does not write when authority is lost only after the directories exist', async () => {
    let calls = 0
    await ops.writeFile({}, 'sub/new.txt', 'hello', dir, () => ++calls <= 1)
    assert.equal(existsSync(join(dir, 'sub', 'new.txt')), false)
    assert.ok(calls >= 2, 'the authority was consulted again after mkdir')
  })

  it('append_memory does not append when authority is lost only at the final step', async () => {
    let calls = 0
    await ops.appendMemory({}, 'a note', dir, () => ++calls <= 1)
    assert.equal(existsSync(join(dir, 'CLAUDE.md')), false)
    assert.ok(calls >= 2, 'the authority was consulted again just before the write')
  })

  it('append_memory appends nothing once the connection is no longer authorized', async () => {
    const f = flag()
    const p = ops.appendMemory({}, 'a note', dir, f.isAuthorized)
    f.ok = false
    await p
    assert.equal(existsSync(join(dir, 'CLAUDE.md')), false)
  })
})

describe('git mutations', () => {
  let repo
  let ops
  beforeEach(() => {
    repo = tempGitRepo()
    ops = createFileOps(() => {}, repo)
    writeFileSync(join(repo, 'a.txt'), 'two')
  })
  afterEach(() => rmDirRobust(repo))
  const staged = () => execFileSync(GIT, ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim()

  it('control: stage stages while authorized', async () => {
    await ops.gitStage({}, ['a.txt'], repo, () => true)
    assert.equal(staged(), 'a.txt')
  })

  it('stage stages nothing once the connection is no longer authorized', async () => {
    const f = flag()
    const p = ops.gitStage({}, ['a.txt'], repo, f.isAuthorized)
    f.ok = false
    await p
    assert.equal(staged(), '')
  })

  it('unstage leaves the index alone once the connection is no longer authorized', async () => {
    await ops.gitStage({}, ['a.txt'], repo, () => true)
    const f = flag()
    const p = ops.gitUnstage({}, ['a.txt'], repo, f.isAuthorized)
    f.ok = false
    await p
    assert.equal(staged(), 'a.txt')
  })

  it('commit creates no commit once the connection is no longer authorized', async () => {
    await ops.gitStage({}, ['a.txt'], repo, () => true)
    const f = flag()
    const p = ops.gitCommit({}, 'second', repo, f.isAuthorized)
    f.ok = false
    await p
    const count = execFileSync(GIT, ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    assert.equal(count, '1')
  })
})

describe('session lock', () => {
  function manager() {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = createSpy()
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Original', cwd: '/tmp' })
    return { mgr, session }
  }

  it('rename is not applied once the connection is no longer authorized', async () => {
    const { mgr } = manager()
    const f = flag()
    const p = mgr.renameSessionLocked('s1', 'Renamed', { isAuthorized: f.isAuthorized })
    f.ok = false
    await assert.rejects(p, (err) => isAuthorityRevoked(err))
    assert.equal(mgr._sessions.get('s1').name, 'Original')
  })

  it('destroy is not performed, and the session is not left marked as going away', async () => {
    const { mgr, session } = manager()
    const f = flag()
    const p = mgr.destroySessionLocked('s1', { isAuthorized: f.isAuthorized })
    f.ok = false
    await assert.rejects(p, (err) => err instanceof AuthorityRevokedError)
    assert.equal(session.destroy.callCount, 0)
    assert.ok(mgr._sessions.has('s1'))
    assert.equal(mgr._sessions.get('s1')._destroying, false)
  })

  it('control: rename and destroy proceed while authorized', async () => {
    const { mgr } = manager()
    assert.equal(await mgr.renameSessionLocked('s1', 'Renamed', { isAuthorized: () => true }), true)
    await mgr.destroySessionLocked('s1', { isAuthorized: () => true })
    assert.equal(mgr._sessions.has('s1'), false)
  })
})

describe('checkpoint restore', () => {
  let repo
  let stateDir
  let cm
  beforeEach(() => {
    repo = tempGitRepo()
    stateDir = mkdtempSync(join(tmpdir(), 'chroxy-deferred-cp-'))
    cm = new CheckpointManager({ checkpointsDir: stateDir })
  })
  afterEach(() => { rmDirRobust(repo); rmDirRobust(stateDir) })

  it('restores no files once the connection is no longer authorized', async () => {
    const cp = await cm.createCheckpoint({ sessionId: 's', resumeSessionId: 'r', cwd: repo, name: 'cp' })
    writeFileSync(join(repo, 'a.txt'), 'changed after the checkpoint')
    const f = flag()
    const p = cm.restoreCheckpoint('s', cp.id, { isAuthorized: f.isAuthorized })
    f.ok = false
    await assert.rejects(p, (err) => isAuthorityRevoked(err))
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'changed after the checkpoint')
  })

  it('control: restores while authorized', async () => {
    const cp = await cm.createCheckpoint({ sessionId: 's', resumeSessionId: 'r', cwd: repo, name: 'cp' })
    writeFileSync(join(repo, 'a.txt'), 'changed after the checkpoint')
    await cm.restoreCheckpoint('s', cp.id, { isAuthorized: () => true })
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one')
  })

  it('creates no checkpoint snapshot once the connection is no longer authorized', async () => {
    const f = flag()
    const p = cm.createCheckpoint({ sessionId: 's2', resumeSessionId: 'r', cwd: repo, name: 'cp', isAuthorized: f.isAuthorized })
    f.ok = false
    await assert.rejects(p, (err) => isAuthorityRevoked(err))
    assert.equal(cm.listCheckpoints('s2').length, 0)
  })
})

describe('MCP config write', () => {
  let dir
  let configPath
  let storePath
  let prevTrust
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-deferred-mcp-'))
    configPath = join(dir, 'claude.json')
    storePath = join(dir, 'mcp-trust.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    prevTrust = process.env.CHROXY_MCP_TRUST_PATH
    process.env.CHROXY_MCP_TRUST_PATH = storePath
  })
  afterEach(() => {
    if (prevTrust === undefined) delete process.env.CHROXY_MCP_TRUST_PATH
    else process.env.CHROXY_MCP_TRUST_PATH = prevTrust
    rmDirRobust(dir)
  })

  function sessionRevokingDuringPrompt(f) {
    const session = new ClaudeByokSession({ cwd: dir, mcpConfigPath: configPath })
    session._permissions = { async requestMcpTrust() { f.ok = false; return true } }
    session._mcpFleet = null
    session._emitMcpServers = () => {}
    return session
  }

  it('writes nothing when the connection ends while the trust prompt is open', async () => {
    const f = flag()
    const session = sessionRevokingDuringPrompt(f)
    await assert.rejects(
      session.addMcpServer('gh', { command: 'node', args: ['x.js'] }, 'user', { isAuthorized: f.isAuthorized }),
      (err) => isAuthorityRevoked(err),
    )
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers || {}), [])
  })

  it('control: an authorized add is written', async () => {
    const f = flag()
    const session = new ClaudeByokSession({ cwd: dir, mcpConfigPath: configPath })
    session._permissions = { async requestMcpTrust() { return true } }
    session._mcpFleet = null
    session._emitMcpServers = () => {}
    const res = await session.addMcpServer('gh', { command: 'node', args: ['x.js'] }, 'user', { isAuthorized: f.isAuthorized })
    assert.equal(res.ok, true)
  })
})

describe('control room host actions', () => {
  function ctxFor(f, { survey, run }) {
    return {
      transport: { send: createSpy(), isConnectionAuthorized: () => f.ok },
      sessions: {},
      services: {},
      surveySimulators: survey,
      runSimulatorAction: run,
    }
  }
  const msg = { type: 'simulator_action', action: 'boot', udid: 'U-1', requestId: 'r1' }
  const snapshot = { available: true, devices: [{ udid: 'U-1', name: 'iPhone', state: 'Shutdown' }] }

  it('control: a boot runs while the connection is authorized', async () => {
    const f = flag()
    const run = createSpy(async () => 'booted')
    await controlRoomHandlers.simulator_action({}, { id: 'c1' }, msg, ctxFor(f, { survey: async () => snapshot, run }))
    assert.equal(run.callCount, 1)
  })

  it('a boot is not run when the connection ends during the survey', async () => {
    const f = flag()
    const run = createSpy(async () => 'booted')
    const survey = async () => { f.ok = false; return snapshot }
    await controlRoomHandlers.simulator_action({}, { id: 'c1' }, msg, ctxFor(f, { survey, run }))
    assert.equal(run.callCount, 0)
  })
})

describe('replies after silent expiry', () => {
  let server
  let pm
  afterEach(() => {
    if (server) { server.close(); server = null }
    if (pm) { pm.destroy(); pm = null }
  })

  async function connectBound() {
    pm = new PairingManager({ wsUrl: 'wss://example.com', sessionTokenTtlMs: 60_000 })
    const made = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/one' }])
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true, pairingManager: pm })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    clearInterval(server._pingInterval)
    const token = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`)
    const messages = []
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    await new Promise((resolve) => ws.once('open', resolve))
    ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => messages.find(m => m.type === 'auth_ok'), { timeoutMs: 2000, label: 'auth_ok' })
    const [sock, client] = [...server.clients].find(([, c]) => c.pairingCredential === token)
    return { ws, messages, sock, client, token }
  }

  it('control: a reply to a connection with a live credential is delivered', async () => {
    const { ws, messages, sock } = await connectBound()
    server._send(sock, { type: 'probe_reply' })
    await waitFor(() => messages.find(m => m.type === 'probe_reply'), { timeoutMs: 2000, label: 'probe_reply' })
    ws.close()
  })

  it('a reply is not delivered once the credential has lapsed, even before any sweep noticed', async () => {
    const { ws, messages, sock, token } = await connectBound()
    pm._sessionTokens.get(token).createdAt = Date.now() - 120_000 // expired, not yet swept
    assert.equal(server._send(sock, { type: 'probe_reply' }), false)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(messages.some(m => m.type === 'probe_reply'), false)
    ws.close()
  })

  it('the credential_invalidated notice still reaches a connection whose credential is gone', async () => {
    const { ws, messages, token } = await connectBound()
    pm.revokeSessionTokenById(pm._deviceIdForToken(token))
    const notice = await waitFor(() => messages.find(m => m.type === 'credential_invalidated'), { timeoutMs: 2000, label: 'notice' })
    assert.equal(notice.reason, 'revoked')
    ws.close()
  })

  it('a cause outside the wire vocabulary is reported as invalid', async () => {
    const { ws, messages, sock, client } = await connectBound()
    server._endCredentialConnection(sock, client, 'destroyed')
    const notice = await waitFor(() => messages.find(m => m.type === 'credential_invalidated'), { timeoutMs: 2000, label: 'notice' })
    assert.equal(notice.reason, 'invalid')
    ws.close()
  })

  it('a pending key-exchange timer does not outlive the ended connection', async () => {
    const { ws, client, token } = await connectBound()
    let fired = false
    client._keyExchangeTimeout = setTimeout(() => { fired = true }, 100)
    pm.revokeSessionTokenById(pm._deviceIdForToken(token))
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(fired, false)
    ws.close()
  })

  it('an unannounced removal found on the next frame is reported with the neutral reason', async () => {
    const { ws, messages, token } = await connectBound()
    pm._sessionTokens.delete(token)
    ws.send(JSON.stringify({ type: 'ping' }))
    const notice = await waitFor(() => messages.find(m => m.type === 'credential_invalidated'), { timeoutMs: 2000, label: 'notice' })
    assert.equal(notice.reason, 'invalid')
  })
})

describe('a connection whose authentication was stripped', () => {
  it('still receives the outcome of a new authentication attempt, and nothing else', async () => {
    const made = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/one' }])
    const server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: made.manager, authRequired: true })
    try {
      server.start('127.0.0.1')
      await new Promise((resolve) => server.httpServer.once('listening', resolve))
      clearInterval(server._pingInterval)
      const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`)
      const messages = []
      ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
      await new Promise((resolve) => ws.once('open', resolve))
      ws.send(JSON.stringify({ type: 'auth', token: 'primary-tok' }))
      await waitFor(() => messages.find(m => m.type === 'auth_ok'), { timeoutMs: 2000, label: 'auth_ok' })
      const [sock, client] = [...server.clients][0]
      client.authenticated = false // what a token revoke does
      assert.equal(server._send(sock, { type: 'probe_reply' }), false, 'ordinary replies are withheld')
      ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }))
      await waitFor(() => messages.find(m => m.type === 'auth_fail'), { timeoutMs: 2000, label: 'auth_fail' })
      assert.equal(messages.some(m => m.type === 'probe_reply'), false)
      ws.close()
    } finally {
      server.close()
    }
  })
})

describe('token store eviction', () => {
  it('evicts the least recently used token, not the oldest inserted', () => {
    const pm = new PairingManager()
    const first = pm.validatePairing(pm.currentPairingId).sessionToken
    for (let i = 0; i < 99; i++) pm.validatePairing(pm.currentPairingId)
    // `first` is the oldest inserted, but it is the one in use: every other token
    // was last used earlier (explicit clocks keep this independent of timer resolution).
    let age = 1000
    for (const [tok, meta] of pm._sessionTokens) if (tok !== first) meta.createdAt = Date.now() - (age += 10)
    pm._sessionTokens.get(first).createdAt = Date.now() - 5000
    pm.touchSessionToken(first)
    pm.validatePairing(pm.currentPairingId) // 101st: forces one eviction
    assert.equal(pm.isSessionTokenLive(first), true, 'the recently used device survives')
    assert.equal(pm._sessionTokens.size, 100)
    pm.destroy()
  })
})
