import { EventEmitter } from 'node:events'
import { buildPermissionRequestMessage } from '@chroxy/protocol'
import { PermissionManager } from './permission-manager.js'
import { PreviewTunnelAdapter } from './tunnel/preview.js'
import { assertPreviewPort, pinPreviewTarget, createPinnedPreviewProxy } from './preview-target.js'
import { createLogger } from './logger.js'

const log = createLogger('dev-preview')

export const PREVIEW_EXPOSURE = 'Public Cloudflare URL; anyone with the URL can reach this service. Chroxy adds no authentication. HTTP only: no WebSockets or automatic reconnect.'

/** Explicit, one-shot, client-bound previews of an immutable HTTP connection. */
export class DevPreviewManager extends EventEmitter {
  constructor({ daemonPort, authRequired = true, getSession, pinTarget = pinPreviewTarget, createProxy = createPinnedPreviewProxy, tunnelFactory = opts => new PreviewTunnelAdapter(opts), tunnelConfig = {}, permissionTimeoutMs } = {}) {
    super()
    this._daemonPort = daemonPort
    this._authRequired = authRequired
    this._getSession = getSession
    this._pinTarget = pinTarget
    this._createProxy = createProxy
    this._tunnelFactory = tunnelFactory
    this._tunnelConfig = tunnelConfig
    this._permissionTimeoutMs = permissionTimeoutMs
    this._requests = new Map()
    this._tunnels = new Map()
    this._usedRequestIds = new Set()
  }

  _assertAuthority(client, sessionId) {
    if (this._authRequired !== true || client?.authenticated !== true || client.isPrimaryToken !== true || client.boundSessionId || !client.authToken) {
      throw new Error('Preview publication requires the primary-token client')
    }
    if (client.activeSessionId !== sessionId && !client.subscribedSessionIds?.has(sessionId)) throw new Error('Open this session before requesting its preview')
    const entry = this._getSession?.(sessionId)
    if (!entry?.session || !entry.session.cwd) throw new Error('Preview requires a live local session with a directory')
    return entry.session
  }

  async openPreview(client, { sessionId, port, requestId }, send) {
    let request
    try {
      const session = this._assertAuthority(client, sessionId)
      assertPreviewPort(port, this._daemonPort)
      if (typeof requestId !== 'string' || !requestId || this._usedRequestIds.has(requestId)) throw new Error('Preview request already used; request a new preview')
      if (this._usedRequestIds.size >= 10_000) throw new Error('Preview request limit reached; restart the daemon before requesting another preview')
      if (this._requests.size >= 32) throw new Error('Too many pending previews')
      if (this._requestsForPort(sessionId, port) || this._getTunnel(sessionId, port)) throw new Error('This port already has a pending or active preview')
      this._usedRequestIds.add(requestId)
      request = { requestId, sessionId, port, clientId: client.id, client, session, cwd: session.cwd, controller: new AbortController(), send }
      this._requests.set(requestId, request)
      const permissions = new PermissionManager({ timeoutMs: this._permissionTimeoutMs, cwd: session.cwd })
      request.permissions = permissions
      permissions.on('permission_request', data => send(buildPermissionRequestMessage({ ...data, sessionId })))
      permissions.on('permission_resolved', data => send({ type: 'permission_resolved', sessionId, ...data }))
      request.pin = await this._pinTarget({ port, cwd: session.cwd, signal: request.controller.signal })
      request.pin.socket.once('close', () => { request.controller.abort()
      void this.closePreview(sessionId, port) })
      this._assertLive(request)
      const target = request.pin.target
      const granted = await permissions.requestExplicitConsent({
        requestId, clientId: client.id, tool: 'dev_preview', signal: request.controller.signal,
        input: { target, exposure: PREVIEW_EXPOSURE, explicitConsent: true, nonDelegable: true },
        description: `Publish HTTP service ${target.command} (PID ${target.pid}) at http://127.0.0.1:${port}, directory ${target.cwd}. ${PREVIEW_EXPOSURE} Allow once for this connection?`,
      })
      if (!granted) return
      this._assertLive(request)
      await request.pin.verify()
      this._assertLive(request)
      await this._createPreviewTunnel(request)
    } catch (err) {
      send({ type: 'session_error', sessionId, code: 'DEV_PREVIEW_REFUSED', recoverable: true, message: err.message })
    } finally {
      if (request) {
        this._requests.delete(requestId)
        if (!this._getTunnel(sessionId, port)) request.pin?.close()
      }
    }
  }

  _assertLive(request) {
    if (request.controller.signal.aborted || this._requests.get(request.requestId) !== request || this._assertAuthority(request.client, request.sessionId) !== request.session) {
      throw new Error('Preview request is no longer live')
    }
    if (request.cwd !== request.session.cwd) throw new Error('Session directory changed; request a new preview')
  }

  respondToConsent(client, msg) {
    const request = this._requests.get(msg.requestId)
    if (!request) return this._usedRequestIds.has(msg.requestId)
    try {
      this._assertLive(request)
      if (client !== request.client || client.id !== request.clientId) return true
      request.permissions.respondToExplicitConsent(msg.requestId, msg.decision, { clientId: client.id, editedInput: msg.editedInput, scope: msg.scope })
    } catch { request.controller.abort() }
    return true
  }

  _requestsForPort(sessionId, port) {
    return [...this._requests.values()].find(r => r.sessionId === sessionId && r.port === port)
  }

  async _createPreviewTunnel(request) {
    const { sessionId, port, pin } = request
    const record = { request, pin, tunnel: null, proxy: null, url: null, closing: null }
    if (!this._tunnels.has(sessionId)) this._tunnels.set(sessionId, new Map())
    this._tunnels.get(sessionId).set(port, record)
    try {
      record.proxy = await this._createProxy(pin, async () => {
        if (request.controller.signal.aborted || request.cwd !== request.session.cwd || this._assertAuthority(request.client, sessionId) !== request.session) throw new Error('Preview ended')
      })
      await pin.verify()
      this._assertLive(request)
      record.tunnel = this._tunnelFactory({ port: record.proxy.port, config: { ...this._tunnelConfig, unixSocket: record.proxy.socketPath } })
      record.tunnel.once('tunnel_lost', () => { void this.closePreview(sessionId, port) })
      const { httpUrl } = await record.tunnel.start()
      await pin.verify()
      this._assertLive(request)
      if (record.closing) throw new Error('Preview closed during startup')
      record.url = httpUrl
      this.emit('dev_preview_started', { sessionId, port, url: httpUrl, target: pin.target, exposure: PREVIEW_EXPOSURE })
      record.monitor = setInterval(() => {
        void (async () => {
          if (request.cwd !== request.session.cwd || this._assertAuthority(request.client, sessionId) !== request.session) throw new Error('Preview session changed')
          await pin.verify()
        })().catch(() => this.closePreview(sessionId, port))
      }, 2000)
      record.monitor.unref?.()
    } catch (err) {
      const proxySettlement = Promise.resolve(record.proxy?.close()).catch(error => error)
      pin.close()
      await this.closePreview(sessionId, port)
      await proxySettlement
      throw err
    }
  }

  async closePreview(sessionId, port) {
    this._requestsForPort(sessionId, port)?.controller.abort()
    const record = this._getTunnel(sessionId, port)
    if (!record) return
    if (record.closing) return record.closing
    record.request.controller.abort()
    clearInterval(record.monitor)
    record.pin.close()
    const proxySettlement = Promise.resolve(record.proxy?.close()).catch(error => error)
    record.closing = (async () => {
      try {
        await record.tunnel?.stop()
        const proxyError = await proxySettlement
        if (proxyError) throw proxyError
        this._tunnels.get(sessionId)?.delete(port)
        if (this._tunnels.get(sessionId)?.size === 0) this._tunnels.delete(sessionId)
        this.emit('dev_preview_stopped', { sessionId, port })
      } catch (err) {
        const error = err?.message || String(err)
        log.error(`Preview on port ${port} remains tracked: ${error}`)
        this.emit('dev_preview_stop_failed', { sessionId, port, error })
      } finally { record.closing = null }
    })()
    return record.closing
  }

  async closeClient(clientId) {
    for (const request of this._requests.values()) if (request.clientId === clientId) request.controller.abort()
    const closing = []
    for (const [sessionId, ports] of this._tunnels) for (const [port, record] of ports) if (record.request.clientId === clientId) closing.push(this.closePreview(sessionId, port))
    await Promise.all(closing)
  }

  async closeSession(sessionId) {
    for (const request of this._requests.values()) if (request.sessionId === sessionId) request.controller.abort()
    await Promise.all([...(this._tunnels.get(sessionId)?.keys() || [])].map(port => this.closePreview(sessionId, port)))
  }

  async closeAll() {
    for (const request of this._requests.values()) request.controller.abort()
    await Promise.all([...this._tunnels.keys()].map(sessionId => this.closeSession(sessionId)))
  }

  getActivePreviews(sessionId) {
    return [...(this._tunnels.get(sessionId)?.entries() || [])].filter(([, r]) => r.url).map(([port, r]) => ({ port, url: r.url, target: r.pin.target, exposure: PREVIEW_EXPOSURE }))
  }

  _getTunnel(sessionId, port) { return this._tunnels.get(sessionId)?.get(port) ?? null }
}
