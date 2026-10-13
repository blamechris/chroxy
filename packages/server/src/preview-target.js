import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, mkdtemp, lstat, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { connect } from 'node:net'
import http from 'node:http'

const exec = promisify(execFile)
const PROTECTED_PORTS = new Set([22, 80, 443, 3306, 5432, 6379, 8765, 9200, 11434, 27017])

export function assertPreviewPort(port, daemonPort) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || PROTECTED_PORTS.has(port) || port === daemonPort) {
    throw new Error('Choose an unprivileged dev-service port other than a protected or daemon port')
  }
}

async function inspect(args) {
  if (!['darwin', 'linux'].includes(process.platform) || typeof process.getuid !== 'function') {
    throw new Error('Preview ownership inspection requires macOS or Linux with lsof and ps')
  }
  const binary = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof'
  try {
    return (await exec(binary, args, { timeout: 2000, maxBuffer: 128 * 1024 })).stdout
  } catch {
    throw new Error('Could not verify preview service ownership with lsof; keep the service running and check lsof is available')
  }
}

export function parsePreviewSockets(output) {
  const records = []
  let owner = null
  let file = null
  for (const line of output.split('\n')) {
    const key = line[0], value = line.slice(1)
    if (key === 'p') { owner = { pid: Number(value) }
    file = null }
    else if (key === 'c' && owner) owner.command = value
    else if (key === 'u' && owner) owner.uid = Number(value)
    else if (key === 'f' && owner) { file = { ...owner, fd: value }
    records.push(file) }
    else if (key === 'n' && file) file.name = value
    else if (key === 't' && file) file.type = value
  }
  return records
}

async function processIdentity(record, cwd) {
  if (record.uid !== process.getuid() || record.pid === process.pid || !Number.isInteger(record.pid)) {
    throw new Error('Preview target must be a separate service owned by the current user')
  }
  const rawCwd = await inspect(['-a', '-p', String(record.pid), '-d', 'cwd', '-Fn'])
  const directories = rawCwd.split('\n').filter(s => s.startsWith('n')).map(s => s.slice(1))
  if (directories.length !== 1 || await realpath(directories[0]) !== await realpath(cwd)) {
    throw new Error('Preview service must run in this session directory; its ownership could not be established')
  }
  let started
  try {
    started = (await exec('/bin/ps', ['-p', String(record.pid), '-o', 'lstart='], { timeout: 2000, maxBuffer: 4096 })).stdout.trim()
  } catch { throw new Error('Could not verify preview process lifetime') }
  if (!started) throw new Error('Preview service exited during inspection')
  return { ...record, cwd: await realpath(cwd), started }
}

function sameProcess(a, b) {
  return a.pid === b.pid && a.uid === b.uid && a.started === b.started && a.cwd === b.cwd
}

/** Acquire one TCP connection and prove the accepting process owns it.
 * No bytes are sent until consent. This connection is never replaced.
 */
export async function pinPreviewTarget({ port, cwd, signal }) {
  const listeners = parsePreviewSockets(await inspect(['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcuftn']))
  if (listeners.length !== 1 || listeners[0].name !== `127.0.0.1:${port}` || listeners[0].type !== 'IPv4') {
    throw new Error('Preview needs one IPv4 listener bound only to 127.0.0.1; ambiguous or network-wide listeners are refused')
  }
  const listener = await processIdentity(listeners[0], cwd)
  if (signal?.aborted) throw new Error('Preview request cancelled')
  const socket = connect({ host: '127.0.0.1', port })
  // An error can arrive during asynchronous inspection, before HTTP owns it.
  socket.on('error', () => {})
  const abort = () => socket.destroy()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy()
      reject(new Error('Preview connection timed out')) }, 2000)
      const connected = () => { cleanup()
      resolve() }
      const failed = () => { cleanup()
      reject(new Error('Preview service connection closed')) }
      const cleanup = () => { clearTimeout(timer)
      socket.off('connect', connected)
      socket.off('error', failed)
      socket.off('close', failed) }
      socket.once('connect', connected)
      socket.once('error', failed)
      socket.once('close', failed)
    })
    const tuple = `127.0.0.1:${port}->127.0.0.1:${socket.localPort}`
    async function readPeer() {
      if (socket.destroyed || signal?.aborted) throw new Error('Preview connection ended; request a new preview')
      const peers = parsePreviewSockets(await inspect(['-nP', '-a', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpcuftn']))
        .filter(r => r.name === tuple && r.type === 'IPv4')
      if (peers.length !== 1) throw new Error('Could not uniquely verify the accepting preview process')
      return processIdentity(peers[0], cwd)
    }
    const peer = await readPeer()
    if (!sameProcess(peer, listener)) throw new Error('Preview service changed during connection; request a new preview')
    const target = Object.freeze({ host: '127.0.0.1', port, pid: peer.pid, command: peer.command, cwd: peer.cwd, started: peer.started })
    return {
      socket, target,
      async verify() {
        const listenersNow = parsePreviewSockets(await inspect(['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcuftn']))
        if (listenersNow.length !== 1 || listenersNow[0].name !== listener.name || listenersNow[0].fd !== listener.fd) throw new Error('Preview listener changed')
        const listenerNow = await processIdentity(listenersNow[0], cwd)
        if (!sameProcess(listener, listenerNow)) throw new Error('Preview listener identity changed')
        const current = await readPeer()
        if (!sameProcess(peer, current) || current.fd !== peer.fd) throw new Error('Preview target identity changed')
      },
      close() { signal?.removeEventListener('abort', abort)
      socket.destroy() },
    }
  } catch (err) {
    signal?.removeEventListener('abort', abort)
    socket.destroy()
    throw err
  }
}

/** HTTP-only proxy with exactly one upstream connection and no reconnect. */
export async function createPinnedPreviewProxy(pin, verifyLive) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
  let assigned = false
  agent.createConnection = (_opts, callback) => {
    if (assigned || pin.socket.destroyed) { callback(new Error('Preview connection ended'))
    return undefined }
    assigned = true
    return pin.socket
  }
  const server = http.createServer(async (req, res) => {
    try {
      await verifyLive()
      await pin.verify()
      if (pin.socket.destroyed) throw new Error('Preview connection ended')
      const headers = { ...req.headers, host: `127.0.0.1:${pin.target.port}`, connection: 'keep-alive' }
      delete headers.upgrade
      const upstream = http.request({ host: '127.0.0.1', port: pin.target.port, path: req.url, method: req.method, headers, agent }, reply => {
        res.writeHead(reply.statusCode || 502, reply.headers)
        reply.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502)
      res.end('Preview connection ended; request a new preview') })
      req.pipe(upstream)
    } catch {
      res.writeHead(410)
      res.end('Preview ended; request a new preview')
    }
  })
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\nHTTP previews do not support WebSockets') })
  server.requestTimeout = 30_000
  // A unique private Unix origin cannot be inherited by a new TCP listener.
  // Keep its stale path confined even if the daemon is forcibly terminated.
  const directory = await mkdtemp('/tmp/chroxy-preview-')
  const identity = await lstat(directory)
  if (!identity.isDirectory() || identity.uid !== process.getuid() || (identity.mode & 0o777) !== 0o700) {
    throw new Error('Could not establish private preview origin ownership')
  }
  const socketPath = join(directory, 'origin.sock')
  const connections = new Set()
  server.on('connection', socket => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
  } catch (err) {
    pin.close()
    agent.destroy()
    await rmdir(directory)
    throw err
  }
  let closing
  return {
    socketPath,
    close() {
      if (closing) return closing
      pin.close()
      agent.destroy()
      for (const socket of connections) socket.destroy()
      closing = new Promise((resolve, reject) => {
        server.close(async () => {
          try {
            const current = await lstat(directory)
            if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isDirectory()) throw new Error('Preview origin directory identity changed; cleanup refused')
            await rmdir(directory)
            resolve()
          } catch (err) { reject(err) }
        })
      })
      return closing
    },
  }
}
