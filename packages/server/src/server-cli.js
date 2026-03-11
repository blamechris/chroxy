import { SessionManager } from './session-manager.js'
import { WsServer } from './ws-server.js'
import { getTunnel, parseTunnelArg } from './tunnel/index.js'
import { waitForTunnel } from './tunnel-check.js'
import { wireTunnelEvents } from './tunnel-events.js'
import { PushManager } from './push.js'
import { hostname, homedir } from 'os'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative, sep } from 'path'
import qrcode from 'qrcode-terminal'
import { writeConnectionInfo, removeConnectionInfo } from './connection-info.js'
import { TokenManager } from './token-manager.js'
import { getLanIp } from './lan-ip.js'
import { writeFileRestricted } from './platform.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const SERVER_VERSION = packageJson.version

function isWithinHome(dir) {
  const rel = relative(homedir(), dir)
  return !rel.startsWith('..') && !rel.startsWith(sep)
}

/**
 * Start the Chroxy server in CLI headless mode.
 */
export async function startCliServer(config) {
  const PORT = config.port || parseInt(process.env.PORT || '8765', 10)
  const NO_AUTH = !!config.noAuth
  const API_TOKEN = NO_AUTH ? null : (config.apiToken || process.env.API_TOKEN)

  if (!NO_AUTH && !API_TOKEN) {
    console.error('[!] No API token configured. Run \'npx chroxy init\' first.')
    process.exit(1)
  }

  const providerType = config.provider || 'claude-sdk'
  const PROVIDER_LABELS = {
    'claude-cli': 'claude-cli (CLI legacy mode)',
    'claude-sdk': 'claude-sdk (SDK mode)',
  }
  const modeStr = PROVIDER_LABELS[providerType] || providerType
  const banner = `Chroxy Server v${SERVER_VERSION} (${modeStr})`
  const pad = Math.max(0, 38 - banner.length)
  const left = Math.floor(pad / 2)
  const right = pad - left
  console.log('')
  console.log('╔════════════════════════════════════════╗')
  console.log(`║${' '.repeat(left + 1)}${banner}${' '.repeat(right + 1)}║`)
  console.log('╚════════════════════════════════════════╝')
  console.log('')

  if (NO_AUTH) {
    console.log('⚠  WARNING: Running without authentication (--no-auth)')
    console.log('⚠  Server bound to localhost only. Do NOT expose to network.')
    console.log('')
  }

  // Prevent unencrypted traffic over public tunnels
  if (config.noEncrypt && config.tunnel && config.tunnel !== 'none') {
    console.error('[!] Cannot use --no-encrypt with a tunnel. Unencrypted WebSocket')
    console.error('    traffic over a public tunnel exposes all session data in transit.')
    console.error('    Remove --no-encrypt or disable the tunnel (--tunnel none).')
    process.exit(1)
  }

  // 1. Create session manager
  const sessionManager = new SessionManager({
    maxSessions: config.maxSessions || 5,
    port: PORT,
    apiToken: API_TOKEN,
    defaultCwd: config.cwd || (isWithinHome(process.cwd()) ? process.cwd() : homedir()),
    defaultModel: config.model || null,
    defaultPermissionMode: 'approve',
    providerType,
    maxToolInput: config.maxToolInput || null,
    transforms: config.transforms || [],
    sessionTimeout: config.sessionTimeout || null,
    costBudget: config.costBudget || null,
    maxHistory: config.maxHistory || null,
  })

  // 2. Try restoring session state from a previous instance
  let defaultSessionId
  defaultSessionId = sessionManager.restoreState()
  if (defaultSessionId) {
    console.log(`[cli] Restored sessions from previous server instance`)
  }

  // 3. Create default session if no restore
  if (!defaultSessionId) {
    defaultSessionId = sessionManager.createSession({ name: 'Default' })
  }

  let wsServer

  // Log events for debugging and forward critical errors
  sessionManager.on('session_event', ({ sessionId, event, data }) => {
    if (event === 'ready') {
      console.log(`[cli] Session ${sessionId} ready: ${data.sessionId} (model: ${data.model})`)
    } else if (event === 'error') {
      console.error(`[cli] Session ${sessionId} error: ${data.message}`)
      // Forward session errors as server_error (in addition to the in-chat error message)
      const isFatal = /failed to stay alive|max respawn/i.test(data.message)
      if (wsServer) wsServer.broadcastError('session', data.message, !isFatal, sessionId)
    } else if (event === 'result' && data.cost != null) {
      console.log(`[cli] Session ${sessionId} query: $${data.cost.toFixed(4)} in ${data.duration}ms`)
      // Push notification for idle: fire when no clients connected OR when clients are
      // connected but none viewing this session (background session completed)
      if (pushManager.hasTokens && wsServer) {
        const noClients = wsServer.authenticatedClientCount === 0
        const noActiveViewers = !noClients && !wsServer.hasActiveViewersForSession(sessionId)
        if (noClients || noActiveViewers) {
          const body = noClients
            ? 'A query completed while the app was disconnected.'
            : 'A query completed on a background session.'
          pushManager.send('idle', 'Claude is waiting', body, { sessionId })
        }
      }
    } else if (event === 'budget_warning') {
      console.warn(`[cli] Budget warning: ${data.message}`)
    } else if (event === 'budget_exceeded') {
      console.warn(`[cli] Budget exceeded: ${data.message}`)
    }
  })

  sessionManager.on('session_created', ({ sessionId, name, cwd }) => {
    console.log(`[cli] Session created: ${sessionId} (${name}) in ${cwd}`)
  })

  sessionManager.on('session_destroyed', ({ sessionId }) => {
    console.log(`[cli] Session destroyed: ${sessionId}`)
  })

  sessionManager.on('session_warning', ({ sessionId, name, reason, message, remainingMs }) => {
    console.log(`[cli] Session warning: ${message}`)
    if (wsServer) {
      wsServer.broadcast({ type: 'session_warning', sessionId, name, reason, message, remainingMs })
    }
  })

  sessionManager.on('session_timeout', ({ sessionId, name, idleMs }) => {
    console.log(`[cli] Session ${sessionId} (${name}) timed out after ${Math.round(idleMs / 1000)}s idle`)
    if (wsServer) {
      wsServer.broadcast({ type: 'session_timeout', sessionId, name, idleMs })
    }
  })

  // 3. Create push notification manager, token manager, and WebSocket server
  const pushManager = new PushManager()

  const configFile = join(homedir(), '.chroxy', 'config.json')
  const tokenManager = NO_AUTH ? null : new TokenManager({
    token: API_TOKEN,
    tokenExpiry: config.tokenExpiry || null,
    onPersist: (newToken) => {
      try {
        const raw = existsSync(configFile) ? readFileSync(configFile, 'utf-8') : '{}'
        const cfg = JSON.parse(raw)
        cfg.apiToken = newToken
        writeFileRestricted(configFile, JSON.stringify(cfg, null, 2))
      } catch (err) {
        console.error(`[token-manager] Failed to persist token: ${err.message}`)
      }
    },
  })
  if (tokenManager) tokenManager.start()

  wsServer = new WsServer({
    port: PORT,
    apiToken: API_TOKEN,
    sessionManager,
    defaultSessionId,
    authRequired: !NO_AUTH,
    pushManager,
    maxPayload: config.maxPayload,
    noEncrypt: config.noEncrypt,
    tokenManager,
  })
  // Bind to localhost-only when auth is disabled
  wsServer.start(NO_AUTH ? '127.0.0.1' : undefined)

  // Wire session timeout to WsServer viewer checks
  sessionManager.setActiveViewersFn((sid) => wsServer.hasActiveViewersForSession(sid))
  sessionManager.startSessionTimeouts()

  // Advertise via mDNS/Bonjour for local network discovery
  let mdnsService = null
  let bonjourInstance = null
  if (!NO_AUTH) {
    try {
      const { Bonjour } = await import('bonjour-service')
      bonjourInstance = new Bonjour()
      mdnsService = bonjourInstance.publish({
        name: `Chroxy (${hostname()})`,
        type: 'chroxy',
        port: PORT,
        txt: { version: SERVER_VERSION, auth: API_TOKEN ? 'token' : 'none' },
      })
      console.log(`[mdns] Advertising _chroxy._tcp on port ${PORT}`)
    } catch (err) {
      console.log(`[mdns] mDNS advertisement unavailable: ${err.message}`)
    }
  }

  // Track current WebSocket URL and mode label across all modes (tunnel, external, LAN)
  let tunnel = null
  let currentWsUrl = null
  let currentTunnelMode = 'none'

  // External URL mode: reverse proxy / custom domain (skip tunnel entirely)
  const externalUrl = config.externalUrl || null
  if (externalUrl) {
    const wsUrl = externalUrl.replace(/^https?:\/\//, 'wss://')
    currentWsUrl = wsUrl
    currentTunnelMode = 'external'
    const httpUrl = externalUrl.replace(/^wss?:\/\//, 'https://')
    const connectionUrl = `chroxy://${wsUrl.replace('wss://', '')}?token=${API_TOKEN}`

    console.log(`\n[✓] Server ready! (CLI headless mode, external URL)\n`)
    console.log('📱 Scan this QR code with the Chroxy app:\n')
    qrcode.generate(connectionUrl, { small: true })
    console.log(`\nOr connect manually:`)
    console.log(`   URL:   ${wsUrl}`)
    console.log(`   Token: ${API_TOKEN}`)
    console.log(`   Dashboard: ${httpUrl}/dashboard?token=${API_TOKEN}`)

    writeConnectionInfo({
      wsUrl,
      httpUrl,
      apiToken: API_TOKEN,
      connectionUrl,
      tunnelMode: 'external',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    })
  }

  // Determine tunnel mode
  const tunnelArg = parseTunnelArg(config.tunnel || 'quick')
  const SKIP_TUNNEL = NO_AUTH || !tunnelArg || !!externalUrl

  if (!SKIP_TUNNEL) {
    // 4. Start the tunnel via adapter registry
    const TunnelAdapter = getTunnel(tunnelArg.provider)
    tunnel = new TunnelAdapter({
      port: PORT,
      mode: tunnelArg.mode,
      config: {
        ...config.tunnelConfig,
        tunnelName: config.tunnelName || null,
        tunnelHostname: config.tunnelHostname || null,
      },
    })
    const { wsUrl, httpUrl } = await tunnel.start()
    currentWsUrl = wsUrl

    // 5. Wire up tunnel lifecycle events (before waitForTunnel to catch early failures)
    wireTunnelEvents(tunnel, wsServer)

    tunnel.on('tunnel_recovered', async ({ httpUrl: newHttpUrl, wsUrl: newWsUrl, attempt }) => {
      console.log(`[✓] Tunnel recovered after ${attempt} attempt(s)`)

      // Re-verify the new tunnel URL
      await waitForTunnel(newHttpUrl)

      // Only display new QR code if URL actually changed
      if (newWsUrl !== currentWsUrl) {
        currentWsUrl = newWsUrl
        // Use tokenManager.currentToken to get the latest (possibly rotated) token
        const currentApiToken = tokenManager ? tokenManager.currentToken : API_TOKEN
        const newConnectionUrl = `chroxy://${newWsUrl.replace('wss://', '')}?token=${currentApiToken}`
        console.log('\n[✓] New tunnel URL established:\n')
        console.log('📱 Scan this QR code with the Chroxy app:\n')
        qrcode.generate(newConnectionUrl, { small: true })
        console.log(`\nOr connect manually:`)
        console.log(`   URL:   ${newWsUrl}`)
        console.log(`   Token: ${currentApiToken}`)
        console.log('')
        wsServer.broadcastStatus(`Tunnel reconnected with new URL: ${newWsUrl}`)

        // Update connection info file with new tunnel URL
        writeConnectionInfo({
          wsUrl: newWsUrl,
          httpUrl: newHttpUrl,
          apiToken: currentApiToken,
          connectionUrl: newConnectionUrl,
          tunnelMode: modeLabel,
          startedAt: new Date().toISOString(),
          pid: process.pid,
        })
      } else {
        console.log(`[✓] Tunnel URL unchanged: ${newWsUrl}`)
        wsServer.broadcastStatus('Tunnel connection recovered')
      }
    })

    // 6. Wait for tunnel to be fully routable (DNS propagation)
    await waitForTunnel(httpUrl)

    // 7. Generate connection info
    const connectionUrl = `chroxy://${wsUrl.replace('wss://', '')}?token=${API_TOKEN}`
    const modeLabel = `${tunnelArg.provider}:${tunnelArg.mode}`
    currentTunnelMode = modeLabel

    console.log(`\n[✓] Server ready! (CLI headless mode, ${modeLabel})\n`)
    console.log('📱 Scan this QR code with the Chroxy app:\n')
    qrcode.generate(connectionUrl, { small: true })
    console.log(`\nOr connect manually:`)
    console.log(`   URL:   ${wsUrl}`)
    console.log(`   Token: ${API_TOKEN}`)
    console.log(`   Dashboard: ${httpUrl}/dashboard?token=${API_TOKEN}`)

    // 7b. Write connection info file for programmatic access
    writeConnectionInfo({
      wsUrl,
      httpUrl,
      apiToken: API_TOKEN,
      connectionUrl,
      tunnelMode: modeLabel,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    })

  } else if (externalUrl) {
    // Ready message already printed above
  } else if (!tunnelArg && !NO_AUTH) {
    const lanIp = getLanIp()
    const host = lanIp || 'localhost'
    currentWsUrl = `ws://${host}:${PORT}`
    const connectionUrl = `chroxy://${host}:${PORT}?token=${API_TOKEN}`

    console.log(`[✓] Server ready! (CLI headless mode, no tunnel)\n`)
    console.log(`   Connect: ws://${host}:${PORT}`)
    console.log(`   Token: ${API_TOKEN}`)
    console.log(`   Dashboard: http://localhost:${PORT}/dashboard?token=${API_TOKEN}`)

    writeConnectionInfo({
      wsUrl: `ws://${host}:${PORT}`,
      httpUrl: `http://${host}:${PORT}`,
      apiToken: API_TOKEN,
      connectionUrl,
      tunnelMode: 'none',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    })
  } else if (!NO_AUTH) {
    // tunnelArg is set but SKIP_TUNNEL is true due to externalUrl — already handled above
  } else {
    console.log(`[✓] Server ready! (CLI headless mode, no auth)\n`)
    console.log(`   Connect: ws://localhost:${PORT}`)
    console.log(`   Dashboard: http://localhost:${PORT}/dashboard`)
  }

  // Regenerate QR code and update connection info when token rotates
  const serverStartedAt = new Date().toISOString()
  if (tokenManager) {
    tokenManager.on('token_rotated', ({ newToken }) => {
      if (!currentWsUrl) return // no-auth or localhost-only — no QR to update

      const newConnectionUrl = `chroxy://${currentWsUrl.replace(/^wss?:\/\//, '')}?token=${newToken}`
      console.log('\n[token] API token rotated. Updated QR code:\n')
      qrcode.generate(newConnectionUrl, { small: true })
      console.log(`\n   Token: ${newToken.slice(0, 8)}...`)
      console.log('')

      // Determine httpUrl from wsUrl
      const httpBase = currentWsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')

      writeConnectionInfo({
        wsUrl: currentWsUrl,
        httpUrl: httpBase,
        apiToken: newToken,
        connectionUrl: newConnectionUrl,
        tunnelMode: currentTunnelMode,
        startedAt: serverStartedAt,
        pid: process.pid,
      })
    })
  }

  console.log('\nPress Ctrl+C to stop.\n')

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[${signal}] Shutting down...`)
    // Notify connected clients (ETA 0 = not coming back unless supervised)
    wsServer.broadcastShutdown('shutdown', 0)
    if (mdnsService) {
      try { mdnsService.stop?.() } catch {}
    }
    if (bonjourInstance) {
      try { bonjourInstance.destroy?.() } catch {}
    }
    if (tokenManager) tokenManager.destroy()
    sessionManager.destroyAll()
    wsServer.close()
    if (tunnel) await tunnel.stop()
    removeConnectionInfo()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.on('uncaughtException', (err) => {
    console.error('[fatal] Uncaught exception:', err)
    try { wsServer.broadcastShutdown('crash', 0) } catch {}
    try { wsServer.close() } catch {}
    try { sessionManager.destroyAll() } catch {}
    try { if (tunnel) tunnel.stop() } catch {}
    try { removeConnectionInfo() } catch {}
    setTimeout(() => process.exit(1), 100)
  })

  process.on('unhandledRejection', (err) => {
    console.error('[fatal] Unhandled rejection:', err)
    try { wsServer.broadcastShutdown('crash', 0) } catch {}
    try { wsServer.close() } catch {}
    try { sessionManager.destroyAll() } catch {}
    try { if (tunnel) tunnel.stop() } catch {}
    try { removeConnectionInfo() } catch {}
    setTimeout(() => process.exit(1), 100)
  })

  // Return references for supervised child drain protocol
  return { sessionManager, wsServer }
}
