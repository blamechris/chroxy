import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, lstat, unlink, rmdir, writeFile, chmod, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { DevPreviewManager } from '../src/dev-preview.js'
import { PermissionManager } from '../src/permission-manager.js'
import { pinPreviewTarget, assertPreviewPort } from '../src/preview-target.js'
import { PreviewTunnelAdapter } from '../src/tunnel/preview.js'
import { CloudflareTunnelAdapter } from '../src/tunnel/cloudflare.js'
import { WsServer } from '../src/ws-server.js'
import { createMockSessionManager } from './test-helpers.js'
import { ClientMessageSchema, ServerPermissionRequestSchema } from '@chroxy/protocol'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const session = { cwd: '/tmp/preview-fixture', permissionMode: 'auto' }
  const client = { id: 'client-a', authenticated: true, isPrimaryToken: true, authToken: 'fixture-only', activeSessionId: 's1' }
  const socket = new EventEmitter()
  socket.destroyed = false
  const pin = { socket, target: Object.freeze({ host: '127.0.0.1', port: 3100, pid: 100, command: 'fixture', cwd: session.cwd, started: 'fixture-generation' }), verify: async () => { if (socket.destroyed) throw new Error('Connection ended') }, close: () => { socket.destroyed = true } }
  let creations = 0
  const tunnel = new EventEmitter()
  tunnel.start = async () => ({ httpUrl: 'https://fixture.trycloudflare.com' })
  tunnel.stop = async () => {}
  const manager = new DevPreviewManager({ daemonPort: 9911, permissionTimeoutMs: 200, getSession: () => ({ session }), pinTarget: async () => pin, createProxy: async () => ({ port: 5100, close() {} }), tunnelFactory: () => { creations++
  return tunnel }, ...options })
  const sent = []
  const request = { sessionId: 's1', port: 3100, requestId: 'request-a' }
  const open = () => manager.openPreview(client, request, msg => sent.push(msg))
  const allow = (extra = {}, caller = client) => manager.respondToConsent(caller, { requestId: request.requestId, decision: 'allow', ...extra })
  return { session, client, manager, socket, pin, tunnel, sent, request, open, allow, creations: () => creations }
}

describe('explicit preview lifecycle', () => {
  it('prompts with target and posture; human Allow publishes exactly once', async () => {
    const f = fixture()
    const opening = f.open()
    await tick()
    assert.equal(f.creations(), 0)
    const prompt = f.sent.find(m => m.type === 'permission_request')
    assert.ok(ServerPermissionRequestSchema.safeParse(prompt).success)
    assert.equal(prompt.explicitConsent, true)
    assert.equal(prompt.nonDelegable, true)
    assert.equal(prompt.input.target.host, '127.0.0.1')
    assert.ok(prompt.description.includes('adds no authentication'))
    assert.ok(prompt.input.exposure.includes('no WebSockets'))
    f.allow()
    f.allow()
    await opening
    assert.equal(f.creations(), 1)
    await f.open()
    assert.equal(f.creations(), 1)
    await f.manager.closeAll()
  })
  it('forwards the configured binary policy when starting the preview adapter', async () => {
    const config = { binaryProvenance: { mode: 'block' } }
    const f = fixture({ tunnelConfig: config })
    let options
    f.manager._tunnelFactory = opts => { options = opts
    return f.tunnel }
    const opening = f.open()
    await tick()
    f.allow()
    await opening
    assert.equal(options.config.binaryProvenance, config.binaryProvenance)
    await f.manager.closeAll()
  })
  for (const mode of ['default', 'auto', 'bypassPermissions', 'acceptEdits', 'plan']) {
    it(`requires explicit consent in ${mode}, broad rules and pending flips`, async () => {
      const f = fixture()
      f.session.permissionMode = mode
      const opening = f.open()
      await tick()
      const pm = f.manager._requests.get('request-a').permissions
      pm.setRules([{ tool: 'Read', decision: 'allow' }, { tool: 'Write', decision: 'allow' }])
      pm.autoAllowPending()
      await tick()
      assert.equal(pm.hasPendingPrompt(), true)
      assert.throws(() => pm.setRules([{ tool: 'dev_preview', decision: 'allow' }]))
      assert.equal(f.creations(), 0)
      assert.equal(pm.respondToPermission('request-a', 'allow'), false)
      assert.equal(pm.respondToPermission('request-a', 'allowAlways'), false)
      f.allow()
      await opening
      assert.equal(f.creations(), 1)
      await f.manager.closeAll()
    })
  }
  for (const scenario of ['deny', 'timeout', 'disconnect', 'destroy', 'changed target', 'changed directory', 'cancel']) {
    it(`${scenario} settles without publication`, async () => {
      const f = fixture({ permissionTimeoutMs: 40 })
      const opening = f.open()
      await tick()
      if (scenario === 'deny') f.allow({ decision: 'deny' })
      if (scenario === 'disconnect') await f.manager.closeClient(f.client.id)
      if (scenario === 'destroy') await f.manager.closeSession('s1')
      if (scenario === 'cancel') await f.manager.closePreview('s1', 3100)
      if (scenario === 'changed target') { f.pin.verify = async () => { throw new Error('Changed target') }
      f.allow() }
      if (scenario === 'changed directory') { f.session.cwd = '/tmp/other-fixture'
      f.allow() }
      await opening
      assert.equal(f.creations(), 0)
      f.allow()
      assert.equal(f.creations(), 0)
      assert.equal(f.socket.destroyed, true)
    })
  }
  for (const extra of [{ decision: 'allowAlways' }, { scope: 'session' }, { editedInput: {} }]) {
    it(`refuses modified grants ${JSON.stringify(extra)}`, async () => {
      const f = fixture()
      const opening = f.open()
      await tick()
      f.allow(extra)
      await tick()
      assert.equal(f.creations(), 0)
      f.allow({ decision: 'deny' })
      await opening
    })
  }
  it('another connection or reconnect cannot use an outstanding grant', async () => {
    const f = fixture()
    const opening = f.open()
    await tick()
    f.allow({}, { ...f.client, id: 'client-b' })
    f.allow({}, { ...f.client })
    await tick()
    assert.equal(f.creations(), 0)
    await f.manager.closeClient(f.client.id)
    await opening
    f.allow({}, { ...f.client, id: 'reconnected' })
    assert.equal(f.creations(), 0)
  })
  it('refuses no-auth mode even when a client supplies a token string', async () => {
    const f = fixture({ authRequired: false })
    await f.open()
    assert.equal(f.creations(), 0)
    assert.equal(f.sent.some(m => m.type === 'permission_request'), false)
  })
  for (const overrides of [{ boundSessionId: 's1' }, { boundSessionId: 's2' }, { isPrimaryToken: false }, { authenticated: false }, { authToken: undefined }, { activeSessionId: 's2' }]) {
    it(`refuses unauthorized request ${JSON.stringify(overrides)}`, async () => {
      const f = fixture()
      Object.assign(f.client, overrides)
      await f.open()
      assert.equal(f.creations(), 0)
      assert.equal(f.sent.some(m => m.type === 'permission_request'), false)
    })
  }
  it('cancels while proxy creation is pending', async () => {
    let finish
    const f = fixture({ createProxy: () => new Promise(resolve => { finish = resolve }) })
    const opening = f.open()
    await tick()
    f.allow()
    await tick()
    await f.manager.closePreview('s1', 3100)
    let closed = false
    finish({ port: 5100, close() { closed = true } })
    await opening
    assert.equal(f.creations(), 0)
    assert.equal(closed, true)
  })
  it('close during startup publishes no URL', async () => {
    const f = fixture()
    let finishStart
    f.tunnel.start = () => new Promise(resolve => { finishStart = resolve })
    const opening = f.open()
    await tick()
    f.allow()
    await tick()
    await f.manager.closeClient(f.client.id)
    finishStart({ httpUrl: 'https://fixture.trycloudflare.com' })
    await opening
    assert.equal(f.manager.getActivePreviews('s1').length, 0)
  })
  it('retains failed settlement without falsely publishing stopped', async () => {
    const f = fixture()
    const opening = f.open()
    await tick()
    f.allow()
    await opening
    const stopped = []
    const failed = []
    f.manager.on('dev_preview_stopped', data => stopped.push(data))
    f.manager.on('dev_preview_stop_failed', data => failed.push(data))
    f.tunnel.stop = async () => { throw new Error('Exit unconfirmed') }
    await f.manager.closePreview('s1', 3100)
    assert.equal(stopped.length, 0)
    assert.equal(failed.length, 1)
    assert.equal(f.manager.getActivePreviews('s1').length, 1)
    f.tunnel.stop = async () => {}
    await f.manager.closeAll()
    assert.equal(stopped.length, 1)
  })
})

describe('permission and protocol boundaries', () => {
  it('requires strict session, port and requestId with no arbitrary target', () => {
    const request = { type: 'open_dev_preview', sessionId: 's1', port: 3100, requestId: 'r1' }
    assert.ok(ClientMessageSchema.safeParse(request).success)
    for (const changed of [{ host: 'localhost' }, { url: 'http://localhost:3100' }, { port: 1 }, { port: 3100.5 }, { sessionId: '' }, { requestId: '' }]) assert.equal(ClientMessageSchema.safeParse({ ...request, ...changed }).success, false)
  })
  it('generic admission cannot approve publication in any mode', async () => {
    const pm = new PermissionManager()
    for (const mode of ['auto', 'bypassPermissions', 'acceptEdits', 'default']) assert.equal((await pm.handlePermission('dev_preview', {}, null, mode)).behavior, 'deny')
  })
  it('refuses protected and daemon ports and accepts an ordinary dev port', () => {
    for (const port of [22, 80, 443, 5432, 8765, 11434, 9911, 0, 65536]) assert.throws(() => assertPreviewPort(port, 9911))
    assertPreviewPort(3100, 9911)
  })
})

async function startService(cwd, host = '127.0.0.1', listenPort = 0) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import http from 'node:http'; const server=http.createServer((req,res)=>res.end('preview-fixture:'+req.url)); server.keepAliveTimeout=60000; server.listen(${listenPort}, ${JSON.stringify(host)},()=>console.log(server.address().port)); process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0))});`], { cwd, env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
  let raw = ''
  const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 3000)
  child.stdout.on('data', data => { raw += data
  if (raw.includes('\n')) { clearTimeout(timer)
  resolve(Number(raw.trim())) } })
  child.once('error', reject) })
  return { child, port, async close() { if (child.exitCode != null) return
  const exited = once(child, 'close')
  child.kill('SIGTERM')
  await exited } }
}
function getHttp(port, path) {
  return new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', ...(typeof port === 'string' ? { socketPath: port } : { port }), path }, res => { let body = ''
  res.on('data', data => { body += data })
  res.on('end', () => resolve({ status: res.statusCode, body })) }).on('error', reject) })
}

describe('real loopback service', () => {
  it('proves accepting peer, proxies two requests on one connection, then closes', { timeout: 15_000, skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'preview-test-'))
    const service = await startService(cwd)
    let proxyPort
    let creations = 0
    let ingress
    const session = { cwd }
    const manager = new DevPreviewManager({ getSession: () => ({ session }), tunnelFactory: ({ config }) => { proxyPort = config.unixSocket
    ingress = config.previewIngress
    creations++
    const tunnel = new EventEmitter()
    tunnel.start = async () => ({ httpUrl: 'https://fixture.trycloudflare.com' })
    tunnel.stop = async () => {}
    return tunnel } })
    const client = { id: 'human', authenticated: true, isPrimaryToken: true, authToken: 'fixture-only', activeSessionId: 's1' }
    const sent = []
    try {
      let approve
      const prompt = new Promise(resolve => { approve = resolve })
      const opening = manager.openPreview(client, { sessionId: 's1', port: service.port, requestId: 'real-r1' }, msg => { sent.push(msg)
      if (msg.type === 'permission_request' || msg.type === 'session_error') approve(msg) })
      const consent = await prompt
      assert.equal(consent.type, 'permission_request', consent.message)
      assert.equal(consent.input.target.pid, service.child.pid)
      assert.equal(creations, 0)
      manager.respondToConsent(client, { requestId: 'real-r1', decision: 'allow' })
      await opening
      assert.equal(creations, 1, JSON.stringify(sent.filter(m => m.type === 'session_error')))
      assert.deepEqual(await getHttp(proxyPort, '/first'), { status: 200, body: 'preview-fixture:/first' })
      assert.deepEqual(await getHttp(proxyPort, '/second'), { status: 200, body: 'preview-fixture:/second' })
      const adapter = new PreviewTunnelAdapter({ config: { previewIngress: ingress } })
      const spawnOriginal = CloudflareTunnelAdapter.prototype._spawnCloudflared
      let spawned = 0
      CloudflareTunnelAdapter.prototype._spawnCloudflared = () => {
        spawned++
        return new EventEmitter()
      }
      try {
        const argv = adapter._quickTunnelArguments()
        adapter._spawnCloudflared(argv, {})
        assert.equal(spawned, 1, 'valid owned configuration reaches spawn')
        for (const bytes of ['', '{}', JSON.stringify({ ingress: [{ service: 'http://127.0.0.1:1' }] })]) {
          await writeFile(ingress.path, bytes)
          assert.throws(() => adapter._spawnCloudflared(argv, {}), /configuration changed/)
          assert.equal(spawned, 1, 'invalid configuration cannot spawn')
        }
        await writeFile(ingress.path, ingress.bytes)
        await chmod(ingress.path, 0o644)
        assert.throws(() => adapter._spawnCloudflared(argv, {}), /configuration changed/)
        await chmod(ingress.path, 0o600)
        await rename(ingress.path, ingress.path + '.held')
        try {
          assert.throws(() => adapter._spawnCloudflared(argv, {}), /ENOENT/)
          await writeFile(ingress.path, ingress.bytes, { mode: 0o600 })
          assert.throws(() => adapter._spawnCloudflared(argv, {}), /configuration changed/)
          await unlink(ingress.path)
        } finally { await rename(ingress.path + '.held', ingress.path) }
        adapter.config.previewIngress = { ...ingress, file: { ...ingress.file, ino: -1 } }
        assert.throws(() => adapter._spawnCloudflared(argv, {}), /configuration changed/)
        assert.equal(spawned, 1, 'changed config identity cannot spawn')
        for (const key of ['directory', 'socket']) {
          adapter.config.previewIngress = { ...ingress, [key]: { ...ingress[key], ino: -1 } }
          assert.throws(() => adapter._spawnCloudflared(argv, {}), /ownership changed/)
        }
        adapter.config.previewIngress = ingress
        assert.throws(() => adapter._spawnCloudflared([...argv, '--url', 'http://127.0.0.1:1'], {}), /arguments changed/)
        assert.equal(spawned, 1)
        adapter._spawnCloudflared(argv, {})
        assert.equal(spawned, 2, 'restored owned configuration reaches spawn')
      } finally {
        CloudflareTunnelAdapter.prototype._spawnCloudflared = spawnOriginal
        await writeFile(ingress.path, ingress.bytes)
        await chmod(ingress.path, 0o600)
      }
      await service.close()
      await manager.closeAll()
      assert.equal(manager.getActivePreviews('s1').length, 0)
      await assert.rejects(getHttp(proxyPort, '/closed'))
    } finally { await manager.closeAll()
    await service.close()
    await rm(cwd, { recursive: true, force: true }) }
  })
  for (const variant of ['different directory', 'network listener']) {
    it(`refuses ${variant} before consent`, { timeout: 10_000 }, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'preview-target-'))
      const service = await startService(cwd, variant === 'network listener' ? '0.0.0.0' : '127.0.0.1')
      try { await assert.rejects(pinPreviewTarget({ port: service.port, cwd: variant === 'different directory' ? tmpdir() : cwd })) } finally { await service.close()
      await rm(cwd, { recursive: true, force: true }) }
    })
  }
})

describe('bounded tunnel settlement', () => {
  it('reports the HTTP preview authentication posture explicitly', () => {
    const tunnel = new PreviewTunnelAdapter({ port: 5100 })
    assert.ok(tunnel._quickTunnelExposureMessage('https://fixture.trycloudflare.com').includes('adds no authentication'))
  })
  it('waits for confirmed child close', async () => {
    const tunnel = new PreviewTunnelAdapter({ port: 5100 })
    const proc = new EventEmitter()
    proc.exitCode = null
    proc.signalCode = null
    proc.kill = () => { setImmediate(() => proc.emit('close', 0))
    return true }
    tunnel._children.add(proc)
    proc.once('close', () => tunnel._children.delete(proc))
    tunnel.process = proc
    const stopping = tunnel.stop()
    assert.equal(tunnel.process, proc)
    await stopping
    assert.equal(tunnel.process, null)
    assert.equal(tunnel._children.size, 0)
  })
  it('escalates to KILL and confirms settlement', { timeout: 7000 }, async () => {
    const tunnel = new PreviewTunnelAdapter({ port: 5100 })
    const proc = new EventEmitter()
    proc.exitCode = null
    proc.signalCode = null
    const signals = []
    proc.kill = signal => { signals.push(signal)
    if (signal === 'SIGKILL') setImmediate(() => proc.emit('close', null, signal))
    return true }
    tunnel._children.add(proc)
    proc.once('close', () => tunnel._children.delete(proc))
    tunnel.process = proc
    await tunnel.stop()
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(tunnel.process, null)
  })
  it('reports failure and retains an unconfirmed child', { timeout: 7000 }, async () => {
    const tunnel = new PreviewTunnelAdapter({ port: 5100 })
    const proc = new EventEmitter()
    proc.exitCode = null
    proc.signalCode = null
    proc.kill = () => true
    tunnel._children.add(proc)
    tunnel.process = proc
    await assert.rejects(tunnel.stop(), /could not be confirmed/)
    assert.equal(tunnel.process, proc)
    assert.equal(tunnel._children.size, 1)
    proc.exitCode = 0
    await tunnel.stop()
  })
})

it('a private Unix HTTP origin stays ended after proxy exit and TCP service replacement', { timeout: 15_000, skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'preview-origin-'))
  const service = await startService(cwd)
  const module = fileURLToPath(new URL('../src/preview-target.js', import.meta.url))
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { pinPreviewTarget, createPinnedPreviewProxy } from ${JSON.stringify(module)}; const pin=await pinPreviewTarget({port:${service.port},cwd:${JSON.stringify(cwd)}}); const proxy=await createPinnedPreviewProxy(pin,async()=>{}); console.log(proxy.socketPath);`], { cwd, env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
  let path
  let replacement
  try {
    path = await new Promise((resolve, reject) => {
      let data = ''
      const timer = setTimeout(() => reject(new Error('Unix origin fixture startup timed out')), 4000)
      child.stdout.on('data', chunk => { data += chunk
      if (data.includes('\n')) { clearTimeout(timer)
      resolve(data.trim()) } })
      child.once('error', err => { clearTimeout(timer)
      reject(err) })
      child.once('close', () => { clearTimeout(timer)
      reject(new Error('Unix origin fixture closed before readiness')) })
    })
    const directory = path.slice(0, path.lastIndexOf('/'))
    const owner = await lstat(directory)
    assert.equal(owner.uid, process.getuid())
    assert.equal(owner.mode & 0o777, 0o700)
    assert.equal((await getHttp(path, '/first')).body, 'preview-fixture:/first')
    const exited = once(child, 'close')
    child.kill('SIGKILL')
    await exited
    await service.close()
    replacement = await startService(cwd, '127.0.0.1', service.port)
    assert.equal((await getHttp(replacement.port, '/replacement')).body, 'preview-fixture:/replacement')
    await assert.rejects(getHttp(path, '/ended'))
  } finally {
    if (child.exitCode == null && child.signalCode == null) { const exited = once(child, 'close')
    child.kill('SIGKILL')
    await exited }
    await service.close()
    await replacement?.close()
    if (path) {
      const socket = await lstat(path).catch(() => null)
      if (socket?.isSocket() && socket.uid === process.getuid()) await unlink(path)
      const config = join(path.slice(0, path.lastIndexOf('/')), 'ingress.json')
      const owner = await lstat(config).catch(() => null)
      if (owner?.isFile() && owner.uid === process.getuid()) await unlink(config)
      await rmdir(path.slice(0, path.lastIndexOf('/')))
    }
    await rm(cwd, { recursive: true, force: true })
  }
})

it('preview tunnel arguments select the private ingress and Quick dispatch', () => {
  const tunnel = new PreviewTunnelAdapter({ config: { previewIngress: { path: '/tmp/preview-fixture/ingress.json' } } })
  assert.deepEqual(tunnel._quickTunnelArguments(), ['tunnel', '--config', '/tmp/preview-fixture/ingress.json', '--hello-world', '--no-autoupdate'])
  assert.equal(tunnel._quickTunnelArguments().includes('--url'), false)
  assert.equal(tunnel._quickTunnelArguments().includes('--unix-socket'), false)
  assert.throws(() => new PreviewTunnelAdapter({ port: 3100 })._quickTunnelArguments(), /private Unix ingress/)
})

it('unsupported ownership inspection refuses before consent or tunnel creation', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const f = fixture({ pinTarget: pinPreviewTarget })
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await f.open()
    assert.equal(f.creations(), 0)
    assert.equal(f.sent.some(msg => msg.type === 'permission_request'), false)
    assert.ok(f.sent.some(msg => msg.type === 'session_error' && msg.message.includes('requires macOS or Linux')))
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

it('reports request, consent, opening, active and automatic end with its reason', async () => {
  const f = fixture()
  const opening = f.open()
  await tick()
  f.allow()
  await opening
  f.tunnel.emit('tunnel_lost')
  await tick()
  const states = f.sent.filter(m => m.type === 'dev_preview_status')
  assert.deepEqual(states.map(m => m.state), ['checking', 'awaiting_consent', 'opening', 'active', 'closing', 'closed'])
  assert.ok(states.every(m => m.requestId === 'request-a' && m.port === 3100))
  assert.ok(states.at(-1).reason.includes('tunnel connection ended'))
})

it('schema and restart refusals settle the admitted request by its original ID', async () => {
  const { manager } = createMockSessionManager([{ id: 's1', cwd: '/tmp/preview-fixture' }])
  const server = new WsServer({ port: 0, apiToken: 'fixture-only', sessionManager: manager })
  const ws = {}
  const sent = []
  server.clients.set(ws, { id: 'human', authenticated: true, isPrimaryToken: true, authToken: 'fixture-only', rateLimitKey: 'fixture', activeSessionId: 's1' })
  server._send = (_ws, msg) => sent.push(msg)
  try {
    const request = { type: 'open_dev_preview', sessionId: 's1', requestId: 'bad-port', port: -1 }
    await server._handleMessage(ws, request)
    const invalid = sent.find(m => m.type === 'dev_preview_status')
    assert.ok(invalid, 'invalid preview admission must receive a correlated terminal status')
    assert.equal(invalid.requestId, 'bad-port')
    assert.equal(invalid.state, 'failed')
    assert.equal(invalid.port, undefined, 'use the client admission record for malformed ports')
    sent.length = 0
    server._draining = true
    await server._handleMessage(ws, { ...request, port: 3100, requestId: 'draining' })
    assert.equal(sent[0].requestId, 'draining')
    assert.equal(sent[0].state, 'failed')
    assert.equal(server._devPreview._requests.size, 0)
  } finally {
    server.clients.clear()
    await server.close()
  }
})

it('authority, stale-session and protected-port refusals leave a terminal request status', async () => {
  for (const scenario of ['paired', 'nonprimary', 'stale-session', 'protected-port']) {
    const f = fixture()
    if (scenario === 'paired') f.client.boundSessionId = 's1'
    if (scenario === 'nonprimary') f.client.isPrimaryToken = false
    if (scenario === 'stale-session') f.manager._getSession = () => null
    if (scenario === 'protected-port') f.request.port = 5432
    await f.open()
    const state = f.sent.find(m => m.type === 'dev_preview_status')
    assert.equal(state.state, 'failed', scenario)
    assert.equal(state.requestId, f.request.requestId)
    assert.equal(f.sent.some(m => m.type === 'permission_request'), false)
    assert.equal(f.creations(), 0)
  }
})
