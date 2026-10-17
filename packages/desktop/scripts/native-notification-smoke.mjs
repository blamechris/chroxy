#!/usr/bin/env node
/** Isolated fixture only: never starts Chroxy, a provider, or a desktop process. */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, readFile, writeFile, chmod, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { isEntryPoint } from '../../../scripts/lib/is-entry-point.mjs'
import { challengeFromUrl, computeHealthProof } from '../../server/src/health-proof.js'

const CLIENT = new URL('./native-notification-smoke-client.js', import.meta.url)
const FORBIDDEN_PORTS = new Set([8765, 8785, 3131, 8080, 3000])
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="referrer" content="no-referrer"><title>Isolated native notification smoke</title><style>:root{color-scheme:dark}body{background:#111827;color:#e5e7eb;font:18px system-ui;padding:48px}h1{font-size:26px}#status{padding:24px;background:#1f2937;border-radius:12px}</style></head><body><h1>Isolated native notification smoke</h1><p>No Chroxy daemon or provider is running in this fixture.</p><p id="status">Checking native bridge…</p><p>A native receipt is not proof of an OS notification card.</p><script src="/smoke-client.js" defer></script></body></html>`

function equalToken(actual, expected) {
  const left = Buffer.from(actual || '')
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('object required')
  return body
}

/** All secrets are generated here and persisted only in a new private temp root. */
export async function createSmokeFixture({ lifetimeMs = 600000, port = 0, receiptTimeoutMs = 10000 } = {}) {
  if (!Number.isInteger(lifetimeMs) || lifetimeMs < 100 || lifetimeMs > 1800000) throw new Error('invalid lifetime')
  if (!Number.isInteger(receiptTimeoutMs) || receiptTimeoutMs < 20 || receiptTimeoutMs > 10000) throw new Error('invalid receipt timeout')
  if (!Number.isInteger(port) || port < 0 || port > 65535 || FORBIDDEN_PORTS.has(port)) throw new Error('forbidden port')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chroxy-native-smoke-')))
  await chmod(root, 0o700)
  const token = randomBytes(32).toString('hex')
  const controlToken = randomBytes(32).toString('hex')
  const script = await readFile(CLIENT)
  const { version } = JSON.parse(await readFile(new URL('../../server/package.json', import.meta.url), 'utf8'))
  let state = 'WAITING'
  let reason = null
  let closed = false
  let origin
  let timeout
  let receiptTimeout
  const snapshot = () => ({ state, reason, osDelivery: 'UNVERIFIED' })
  const record = () => writeFile(join(root, 'receipt.json'), `${JSON.stringify(snapshot(), null, 2)}\n`, { mode: 0o600 })
  // Serialize transitions and their durable receipt, including concurrent claims.
  let pending = Promise.resolve()
  const server = createServer((req, res) => {
    const handle = async () => {
      const send = (code, body, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
        res.end(type === 'application/json' ? JSON.stringify(body) : body)
      }
      if (req.headers.host !== new URL(origin).host) return send(403, { error: 'host rejected' })
      const url = new URL(req.url, origin)
      if (req.method === 'GET' && url.pathname === '/health') {
        const challenge = challengeFromUrl(req.url)
        return send(200, { status: 'ok', version, mode: 'native-notification-smoke', ...(challenge ? { proof: computeHealthProof(token, server.address().port, challenge) } : {}) })
      }
      if (req.method === 'GET' && url.pathname === '/dashboard') {
        if (url.searchParams.getAll('token').length !== 1 || !equalToken(url.searchParams.get('token'), token)) return send(401, { error: 'unauthorized' })
        return send(200, HTML, 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && url.pathname === '/smoke-client.js') return send(200, script, 'text/javascript; charset=utf-8')
      if (!url.pathname.startsWith('/smoke/')) return send(404, { error: 'not found' })
      const browserOrigin = req.headers.origin
      const site = req.headers['sec-fetch-site']
      if ((browserOrigin && browserOrigin !== origin) || (site && site !== 'same-origin' && site !== 'none')) return send(403, { error: 'origin rejected' })
      const control = url.pathname === '/smoke/arm'
      // Arming is an operator CLI action, never a browser request (even same-origin).
      if (control && (browserOrigin || site)) return send(403, { error: 'CLI arm required' })
      if (!equalToken(req.headers.authorization, `Bearer ${control ? controlToken : token}`)) return send(401, { error: 'unauthorized' })
      if (url.pathname === '/smoke/status' && req.method === 'GET') return send(200, snapshot())
      if (req.method !== 'POST') return send(405, { error: 'POST required' })
      let body
      try { body = await readBody(req) } catch { return send(400, { error: 'invalid body' }) }
      const empty = Object.keys(body).length === 0
      if (url.pathname === '/smoke/ready' && empty && state === 'WAITING') state = 'READY'
      else if (url.pathname === '/smoke/arm' && empty && state === 'READY') state = 'ARMED'
      else if (url.pathname === '/smoke/claim' && empty) {
        if (state !== 'ARMED') return send(200, { ...snapshot(), claim: false })
        state = 'INVOKING'
        await record() // Admission is durable before the native command can run.
        receiptTimeout = setTimeout(() => {
          pending = pending.then(async () => {
            if (state === 'INVOKING') { state = 'FAILED'; reason = 'native receipt missing'; await record() }
          })
        }, receiptTimeoutMs)
        return send(200, { ...snapshot(), claim: true })
      } else if (url.pathname === '/smoke/receipt' && state === 'INVOKING' && Object.keys(body).length === 1 && typeof body.nativeRoute === 'boolean') {
        clearTimeout(receiptTimeout)
        state = body.nativeRoute ? 'SUBMITTED' : 'FAILED'
        reason = body.nativeRoute ? null : 'native route not confirmed'
      } else if (url.pathname === '/smoke/fail' && ['WAITING', 'READY', 'ARMED', 'INVOKING'].includes(state) && Object.keys(body).length === 1 && ['missing native bridge', 'native notification rejected or timed out', 'native probe or fixture request failed'].includes(body.reason)) {
        clearTimeout(receiptTimeout)
        state = 'FAILED'
        reason = body.reason
      } else return send(409, { error: 'invalid transition' })
      await record()
      send(200, snapshot())
    }
    pending = pending.then(handle).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"error":"fixture failure"}')
    })
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolveListen)
  })
  const actualPort = server.address().port
  if (FORBIDDEN_PORTS.has(actualPort)) { server.close(); throw new Error('forbidden allocated port') }
  origin = `http://127.0.0.1:${actualPort}`
  const config = { apiToken: token, port: actualPort, host: '127.0.0.1', tunnel: 'none', encryptLocalhost: true }
  await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(root, 'desktop-settings.json'), `${JSON.stringify({ autoStartServer: false, showNotifications: true, exposeOnLan: false, tunnelMode: 'none', nodePath: process.execPath }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(root, 'control.json'), `${JSON.stringify({ origin, controlToken })}\n`, { mode: 0o600 })
  await record()
  const dispose = async () => {
    if (closed) return
    closed = true
    clearTimeout(timeout)
    clearTimeout(receiptTimeout)
    server.closeAllConnections()
    await new Promise(resolveClose => server.close(resolveClose))
    await pending
  }
  timeout = setTimeout(() => {
    pending = pending.then(async () => {
      if (!['FAILED', 'SUBMITTED'].includes(state)) { state = 'FAILED'; reason = 'fixture lifetime expired'; await record() }
    })
    void dispose()
  }, lifetimeMs)
  return { root, origin, port: actualPort, snapshot, dispose }
}

export async function armSmoke(root) {
  if (!root || !isAbsolute(root)) throw new Error('absolute fixture root required')
  const { origin, controlToken } = JSON.parse(await readFile(join(root, 'control.json'), 'utf8'))
  const url = new URL(origin)
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || FORBIDDEN_PORTS.has(Number(url.port))) throw new Error('isolated loopback origin required')
  const response = await fetch(`${origin}/smoke/arm`, {
    method: 'POST', headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`arm rejected (${response.status})`)
  return response.json()
}

async function main() {
  if (process.versions.node.split('.')[0] !== '22') throw new Error('Node 22 required')
  const args = process.argv.slice(2)
  const [command, root, ...extra] = args
  if (command === 'arm' && root && !extra.length) {
    console.log(JSON.stringify(await armSmoke(root)))
  } else if (command === 'serve' && !root) {
    const fixture = await createSmokeFixture()
    console.log(JSON.stringify({ root: fixture.root, port: fixture.port, pid: process.pid, lifetimeSeconds: 600 }))
    const shutdown = () => { void fixture.dispose() }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } else throw new Error('usage: native-notification-smoke.mjs serve | arm /absolute/fixture-root')
}

if (isEntryPoint(import.meta.url)) {
  main().catch(() => { console.error('Native smoke fixture failed; usage: native-notification-smoke.mjs serve | arm /absolute/fixture-root'); process.exitCode = 1 })
}
