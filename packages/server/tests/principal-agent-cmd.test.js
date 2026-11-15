/**
 * `chroxy agent grant|list|revoke` (src/cli/agent-cmd.js): grant refuses everywhere;
 * list and revoke ask the running daemon over the strict-primary `principal_admin_*`
 * types, here against a real WsServer through the real agent-control client.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import WebSocket from 'ws'
import { WsServer as _WsServer, WS_CLOSE_CREDENTIAL_INVALID } from '../src/ws-server.js'
import { runAgentGrant, runAgentList, runAgentRevoke, registerAgentCommand } from '../src/cli/agent-cmd.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal } from './helpers/principal-store-fixture.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

const capture = () => {
  const out = []
  const err = []
  return { out, err, deps: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

describe('chroxy agent grant refuses', () => {
  it('prints "agent principals not yet enabled", fails, and never contacts the daemon', async () => {
    const c = capture()
    let connected = 0
    const r = await runAgentGrant({ label: 'x', scope: 'observe', session: 's' }, { ...c.deps, connect: async () => { connected++; return { ok: false } } })
    assert.equal(r.ok, false)
    assert.equal(r.refused, true)
    assert.deepEqual(c.err, ['agent principals not yet enabled'])
    assert.equal(connected, 0)
  })

  it('through the real command: exit code 1, the refusal on stderr, nothing on stdout', async () => {
    const program = new Command()
    program.exitOverride()
    registerAgentCommand(program)
    const writes = []
    const origErr = process.stderr.write.bind(process.stderr)
    const origOut = process.stdout.write.bind(process.stdout)
    const outs = []
    process.stderr.write = (s) => { writes.push(String(s)); return true }
    process.stdout.write = (s) => { outs.push(String(s)); return true }
    const before = process.exitCode
    try {
      await program.parseAsync(['node', 'chroxy', 'agent', 'grant', '--label', 'x', '--scope', 'drive', '--session', 's1', '--ttl', '1h'])
      assert.equal(process.exitCode, 1)
    } finally {
      process.stderr.write = origErr
      process.stdout.write = origOut
      process.exitCode = before
    }
    assert.deepEqual(writes, ['agent principals not yet enabled\n'])
    assert.deepEqual(outs, [])
  })
})

describe('list and revoke against a real daemon', () => {
  let server
  const cleanups = []
  const sockets = []
  afterEach(() => {
    for (const ws of sockets.splice(0)) { try { ws.terminate() } catch { /* closed */ } }
    if (server) { server.close(); server = null }
    while (cleanups.length) cleanups.pop()()
  })

  async function boot({ withPrincipal = true } = {}) {
    const fixture = tempPrincipalDir()
    cleanups.push(fixture.cleanup)
    const store = testPrincipalStore(fixture.path)
    const made = withPrincipal ? insertPrincipal(store, { label: 'watcher' }) : null
    const { manager } = createMockSessionManager([{ id: 'sess-1', name: 'One', cwd: '/tmp/p' }])
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, principalStore: store })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    const port = server.httpServer.address().port
    const resolveLocalConnection = () => ({ ok: true, url: `ws://127.0.0.1:${port}`, token: 'primary-tok', port })
    return { port, store, made, deps: { resolveLocalConnection } }
  }

  it('list on a fresh install reports an empty store', async () => {
    const { deps } = await boot({ withPrincipal: false })
    const c = capture()
    const r = await runAgentList({}, { ...deps, ...c.deps })
    assert.equal(r.ok, true)
    assert.deepEqual(c.out, ['No agent principals.'])
  })

  it('list shows each grant, never a token or hash; --json is machine readable', async () => {
    const { deps, made } = await boot()
    const c = capture()
    const r = await runAgentList({}, { ...deps, ...c.deps })
    assert.equal(r.ok, true)
    const text = c.out.join('\n')
    assert.ok(/1 agent principal/.test(text) && /watcher/.test(text) && /state=live/.test(text))
    assert.equal(text.includes(made.token), false)
    const j = capture()
    await runAgentList({ json: true }, { ...deps, ...j.deps })
    const parsed = JSON.parse(j.out.join('\n'))
    assert.equal(parsed[0].label, 'watcher')
    assert.equal(JSON.stringify(parsed).includes('tokenHash'), false)
  })

  it('revoke by label closes the principal connection with 4401 and says so', async () => {
    const { deps, port, made, store } = await boot()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(ws)
    const frames = []
    let code = null
    ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    ws.on('close', (c) => { code = c })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ type: 'auth', token: made.token }))
    await waitFor(() => frames.find((m) => m.type === 'auth_ok'), { label: 'principal auth_ok' })
    server._authFailures.clear()
    const c = capture()
    const r = await runAgentRevoke('watcher', {}, { ...deps, ...c.deps })
    assert.equal(r.ok, true)
    assert.ok(/Revoked pr-1/.test(c.out.join('\n')))
    await waitFor(() => code !== null, { label: 'principal socket closed' })
    assert.equal(code, WS_CLOSE_CREDENTIAL_INVALID)
    assert.equal(store.state('pr-1'), 'revoked')
    assert.deepEqual(frames.filter((m) => m.type === 'credential_invalidated').map((m) => m.reason), ['revoked'])
  })

  it('revoke by principal id works; an unknown name fails with the daemon\'s refusal', async () => {
    const { deps } = await boot()
    const bad = capture()
    const rb = await runAgentRevoke('nobody', {}, { ...deps, ...bad.deps })
    assert.equal(rb.ok, false)
    assert.ok(/No such live principal/.test(bad.err.join('\n')))
    const good = capture()
    const rg = await runAgentRevoke('pr-1', {}, { ...deps, ...good.deps })
    assert.equal(rg.ok, true)
  })

  it('a revoke that is not durable is a failure (exit non-zero) that says to revoke again', async () => {
    const { deps, store } = await boot()
    store._writeDurable = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
    const c = capture()
    const r = await runAgentRevoke('pr-1', {}, { ...deps, ...c.deps })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not_durable')
    assert.ok(/NOT durable/.test(c.err.join('\n')))
    assert.equal(store.state('pr-1'), 'revoked', 'the revoke holds in memory')
  })

  it('an untrusted store makes list fail with the doctor-readable reason', async () => {
    const { deps, store } = await boot()
    store._health = { ok: false, status: 'invalid', code: 'EMODE', reason: 'the principal store is not mode 0600' }
    store.refresh = () => store.health()
    store._entries = new Map()
    const c = capture()
    const r = await runAgentList({}, { ...deps, ...c.deps })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'store_invalid')
    assert.ok(/not mode 0600/.test(c.err.join('\n')))
  })

  it('with no daemon running, list and revoke say so and fail', async () => {
    const c = capture()
    const deps = { resolveLocalConnection: () => ({ ok: false, reason: 'not_running' }) }
    const origErr = process.stderr.write.bind(process.stderr)
    const lines = []
    process.stderr.write = (s) => { lines.push(String(s)); return true }
    try {
      assert.equal((await runAgentList({}, { ...deps, ...c.deps })).ok, false)
      assert.equal((await runAgentRevoke('x', {}, { ...deps, ...c.deps })).ok, false)
    } finally { process.stderr.write = origErr }
    assert.equal(lines.filter((l) => /not running/.test(l)).length, 2)
  })

  it('revoke with no name is refused before any request', async () => {
    const c = capture()
    const r = await runAgentRevoke('', {}, { ...c.deps, connect: async () => { throw new Error('must not connect') } })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'bad_args')
  })
})
