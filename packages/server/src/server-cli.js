import { SessionManager } from './session-manager.js'
import { WsServer, TUNNEL_STATUS_MIN_PROTOCOL_VERSION } from './ws-server.js'
import { createTunnel, parseTunnelArg } from './tunnel/index.js'
import { waitForTunnel } from './tunnel-check.js'
import { PushManager } from './push.js'
import { hostname, homedir } from 'os'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative, sep } from 'path'
import QRCode from 'qrcode'
import { createLogger, setJsonMode } from './logger.js'

const log = createLogger('cli')
import { writeConnectionInfo, removeConnectionInfo } from './connection-info.js'
import { TokenManager } from './token-manager.js'
import { PairingManager } from './pairing.js'
import { getLanIp } from './lan-ip.js'
import { writeFileRestricted } from './platform.js'
import { getToken, setToken, migrateToken, isKeychainAvailable } from './keychain.js'
import { registerDockerProvider, resolveProviderLabel } from './providers.js'
import { loadModelsCache, getModels } from './models.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const SERVER_VERSION = packageJson.version

// Tools that indicate a "writing" activity state for push notifications (#2085)

/**
 * Build a `server_status` broadcast payload for the tunnel_warming phase.
 *
 * Factored out of the broadcast site so tests can import and assert the
 * exact object shape that ships to clients — previously tests duplicated
 * the construction and silently drifted if the production code changed.
 *
 * Pass `attempt`/`maxAttempts` for per-attempt progress updates; omit
 * them for the initial pre-poll broadcast ("Tunnel warming up…" with no
 * counter).
 *
 * @param {{ tunnelMode: string, tunnelUrl: string, attempt?: number, maxAttempts?: number }} args
 * @returns {object} WS message envelope
 */
export function buildTunnelWarmingStatus({ tunnelMode, tunnelUrl, attempt, maxAttempts }) {
  const base = {
    type: 'server_status',
    phase: 'tunnel_warming',
    tunnelMode,
    tunnelUrl,
  }
  if (typeof attempt === 'number' && typeof maxAttempts === 'number') {
    return {
      ...base,
      attempt,
      maxAttempts,
      message: `Tunnel warming up… (${attempt}/${maxAttempts})`,
    }
  }
  return { ...base, message: 'Tunnel warming up…' }
}

/**
 * Build a `server_status` broadcast for the terminal `ready` phase —
 * signals the dashboard banner to disappear and the tunnel URL to be
 * considered routable.
 *
 * @param {{ tunnelUrl: string }} args
 * @returns {object} WS message envelope
 */
export function buildTunnelReadyStatus({ tunnelUrl }) {
  return {
    type: 'server_status',
    phase: 'ready',
    tunnelUrl,
    message: 'Tunnel is ready',
  }
}

/**
 * Build the single-line startup banner string (#2953).
 *
 * Renders as `Chroxy Server vX.Y.Z (<provider label>)`. The provider label is
 * resolved via `resolveProviderLabel()` so each provider contributes its own
 * `static get displayLabel()`, replacing the previous hardcoded
 * `PROVIDER_LABELS` map that had to be updated manually every time a new
 * provider landed (Gemini/Codex had been falling through to the raw id).
 *
 * Exported so tests can assert the exact banner text without executing
 * `startCliServer()` end-to-end.
 *
 * @param {{ version: string, provider?: string }} args
 * @returns {string} Banner line (no outer box, no padding)
 */
export function buildServerBanner({ version, provider }) {
  const providerType = provider || 'claude-sdk'
  const modeStr = resolveProviderLabel(providerType)
  return `Chroxy Server v${version} (${modeStr})`
}

function checkNoAuthWarnings({ authRequired, tunnel }) {
  if (authRequired) return
  log.warn('--no-auth disables all authentication. Only safe on isolated networks!')
  if (tunnel && tunnel !== 'none') {
    log.error('--no-auth with tunnel exposes your server to the internet without authentication!')
  }
}

function maskToken(token) {
  if (!token) return ''
  if (token.length <= 8) return token
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

function wireTunnelEvents(tunnel, wsServer) {
  tunnel.on('tunnel_lost', ({ code, signal }) => {
    const exitReason = signal ? `signal ${signal}` : `code ${code}`
    log.warn(`Tunnel lost (${exitReason})`)
    wsServer.broadcastError('tunnel', `Tunnel connection lost (${exitReason}). Recovering...`, true)
  })

  tunnel.on('tunnel_recovering', ({ attempt, delayMs }) => {
    log.info(`Attempting tunnel recovery (attempt ${attempt}, waiting ${delayMs}ms)...`)
    wsServer.broadcastStatus('Tunnel recovering...')
  })

  tunnel.on('tunnel_failed', ({ message, lastExitCode, lastSignal, recoveryOngoing }) => {
    log.warn(message)
    log.warn(`Last exit: code=${lastExitCode} signal=${lastSignal}`)
    if (recoveryOngoing) {
      // 2026-04-11 audit (Skeptic Task #2): the tunnel adapter now
      // retries indefinitely with capped exponential backoff, so this
      // event means "fast round exhausted, still retrying" rather than
      // "gave up permanently". Surface a recoverable warning to connected
      // clients so they know something's wrong without panicking.
      log.warn('Tunnel is still retrying with long-tail backoff. Remote connections may be temporarily unavailable.')
      wsServer.broadcastError(
        'tunnel',
        'Tunnel connection unstable — retrying. Remote connections may be temporarily unavailable.',
        true,
      )
    } else {
      log.error('Server will continue on localhost only. Remote connections will not work.')
      wsServer.broadcastError('tunnel', 'Tunnel recovery failed. Remote connections will not work.', false)
    }
  })

  tunnel.on('tunnel_recovery_exhausted_round', ({ attempts, nextBackoffMs }) => {
    log.warn(`Tunnel recovery round exhausted after ${attempts} fast attempts; next retry in ${nextBackoffMs}ms`)
    // The tunnel_failed event above already surfaces a user-facing error.
    // This is operator-facing diagnostic only.
  })
}

function isWithinHome(dir) {
  const rel = relative(homedir(), dir)
  return !rel.startsWith('..') && !rel.startsWith(sep)
}

/**
 * Start the Chroxy server in CLI headless mode.
 */
export async function startCliServer(config) {
  // Enable JSON log format if configured
  if (config.logFormat === 'json') {
    setJsonMode(true)
  }

  const PORT = config.port || parseInt(process.env.PORT || '8765', 10)
  const NO_AUTH = !!config.noAuth

  // Token precedence: config (may be from keychain migration) > keychain > env var
  let API_TOKEN = NO_AUTH ? null : (config.apiToken || getToken() || process.env.API_TOKEN)

  // Migrate plaintext token to keychain and remove from config file
  if (!NO_AUTH && config.apiToken && isKeychainAvailable()) {
    const configFile = join(homedir(), '.chroxy', 'config.json')
    const { migrated } = migrateToken(config)
    // Remove plaintext token from config file (whether newly migrated or already in keychain)
    const keychainToken = getToken()
    if (keychainToken && (migrated || keychainToken === config.apiToken)) {
      try {
        const raw = existsSync(configFile) ? readFileSync(configFile, 'utf-8') : '{}'
        const cfg = JSON.parse(raw)
        if (cfg.apiToken) {
          delete cfg.apiToken
          writeFileRestricted(configFile, JSON.stringify(cfg, null, 2))
          if (migrated) log.info('API token migrated to OS keychain')
          else log.info('Removed redundant plaintext token from config')
        }
      } catch (err) {
        log.warn(`Keychain migration warning: ${err.message}`)
      }
      // Use keychain token as authoritative source
      API_TOKEN = keychainToken
    }
  }

  if (!NO_AUTH && !API_TOKEN) {
    console.error('[!] No API token configured. Run \'npx chroxy init\' first.') // intentional user-facing output
    process.exit(1)
  }

  const banner = buildServerBanner({ version: SERVER_VERSION, provider: config.provider })
  const pad = Math.max(0, 38 - banner.length)
  const left = Math.floor(pad / 2)
  const right = pad - left
  console.log('')
  console.log('╔════════════════════════════════════════╗')
  console.log(`║${' '.repeat(left + 1)}${banner}${' '.repeat(right + 1)}║`)
  console.log('╚════════════════════════════════════════╝')
  console.log('')

  if (NO_AUTH) {
    const tunnelMode = config.tunnel || 'none'
    checkNoAuthWarnings({ authRequired: false, tunnel: tunnelMode })
    console.log('')
  }

  // Prevent unencrypted traffic over public tunnels
  if (config.noEncrypt && config.tunnel && config.tunnel !== 'none') {
    console.error('[!] Cannot use --no-encrypt with a tunnel. Unencrypted WebSocket') // intentional user-facing output
    console.error('    traffic over a public tunnel exposes all session data in transit.')
    console.error('    Remove --no-encrypt or disable the tunnel (--tunnel none).')
    process.exit(1)
  }

  // Warm the models registry from disk cache so the picker is populated
  // before any SDK session fires supportedModels(). Silent miss on first boot.
  if (loadModelsCache()) {
    log.info(`Warmed models from cache: ${getModels().map(m => m.id).join(', ')}`)
  }

  // Register optional providers (e.g. docker) based on config
  await registerDockerProvider(config)

  // Create environment manager for persistent container environments (optional)
  let environmentManager = null
  if (config?.environments?.enabled) {
    const { EnvironmentManager } = await import('./environment-manager.js')
    environmentManager = new EnvironmentManager()
    await environmentManager.reconnect()
    log.info(`EnvironmentManager ready (${environmentManager.list().length} environment(s))`)
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
    sandbox: config.sandbox || null,
    costBudget: config.costBudget || null,
    maxMessages: config.maxMessages || config.maxHistory || null,
  })

  // 2. Try restoring session state from a previous instance
  let defaultSessionId
  defaultSessionId = sessionManager.restoreState()
  if (defaultSessionId) {
    log.info('Restored sessions from previous server instance')
  }

  // 3. Create default session if no restore
  if (!defaultSessionId) {
    defaultSessionId = sessionManager.createSession({ name: 'Default' })
  }

  let wsServer

  // Log events for debugging and forward critical errors
  sessionManager.on('session_event', ({ sessionId, event, data }) => {
    if (event === 'ready') {
      log.info(`Session ${sessionId} ready: ${data.sessionId} (model: ${data.model})`)
    } else if (event === 'error') {
      log.error(`Session ${sessionId} error: ${data.message}`)
      // Error is already broadcast as { type: 'message', messageType: 'error' } through
      // the forwarding path (ws-forwarding.js → EventNormalizer). Don't also broadcastError()
      // here — that produces a duplicate server_error message on every client.
      // Activity update: error (immediate)
      if (pushManager.hasTokens) {
        const sessionName = sessionManager.getSession(sessionId)?.name
        pushManager.send('activity_error', 'Session error', data.message, {
          sessionId,
          sessionName,
          state: 'error',
          detail: data.message,
        })
      }
    } else if (event === 'result' && data.cost != null) {
      log.info(`Session ${sessionId} query: $${data.cost.toFixed(4)} in ${data.duration}ms`)
      // Note: this arm used to ALSO fire an 'idle' push here ("Claude is waiting")
      // for the same unattended-completion case that the activity_update push below
      // already covers. Because the two pushes used different rate-limit buckets
      // (idle=60s, activity_update=10s) they never deduped each other, so every
      // unattended completion produced two OS-level notifications on the phone.
      // Removed in favor of the single activity_update fire below; see the
      // notification audit note in docs/audit-results/eas-cng-config/ for the
      // deeper post-mortem.
    } else if (event === 'result') {
      // result without cost (e.g. Gemini providers) — log duration if available
      if (data.duration != null) {
        log.info(`Session ${sessionId} query completed in ${data.duration}ms`)
      }
    } else if (event === 'budget_warning') {
      log.warn(`Budget warning: ${data.message}`)
    } else if (event === 'budget_exceeded') {
      log.warn(`Budget exceeded: ${data.message}`)
    }

    // Push notifications for actionable events only (#2612)
    // Intermediate events (stream_start, tool_start) no longer trigger pushes.
    if (pushManager.hasTokens) {
      if (event === 'result') {
        // Activity update: idle — only when no one is actively watching
        if (wsServer) {
          const noClients = wsServer.authenticatedClientCount === 0
          const noActiveViewers = !noClients && !wsServer.hasActiveViewersForSession(sessionId)
          if (noClients || noActiveViewers) {
            const sessionName = sessionManager.getSession(sessionId)?.name
            pushManager.send('activity_update', 'Claude finished', 'Response ready', {
              sessionId,
              sessionName,
              state: 'idle',
              ...(data.duration != null && { elapsed: data.duration }),
            })
          }
        }
      } else if (event === 'permission_request') {
        const sessionName = sessionManager.getSession(sessionId)?.name
        pushManager.send('activity_waiting', 'Waiting for approval', `Permission needed: ${data.tool}`, {
          sessionId,
          sessionName,
          state: 'waiting',
          detail: data.tool,
        })
      } else if (event === 'user_question') {
        const sessionName = sessionManager.getSession(sessionId)?.name
        pushManager.send('activity_waiting', 'Input needed', 'Claude has a question', {
          sessionId,
          sessionName,
          state: 'waiting',
        })
      }
    }
  })

  sessionManager.on('session_created', ({ sessionId, name, cwd }) => {
    log.info(`Session created: ${sessionId} (${name}) in ${cwd}`)
  })

  sessionManager.on('session_destroyed', ({ sessionId }) => {
    log.info(`Session destroyed: ${sessionId}`)
  })

  sessionManager.on('session_warning', ({ sessionId, name, reason, message, remainingMs }) => {
    log.warn(`Session warning: ${message}`)
    if (wsServer) {
      wsServer.broadcast({ type: 'session_warning', sessionId, name, reason, message, remainingMs })
    }
  })

  sessionManager.on('session_timeout', ({ sessionId, name, idleMs }) => {
    log.info(`Session ${sessionId} (${name}) timed out after ${Math.round(idleMs / 1000)}s idle`)
    if (wsServer) {
      wsServer.broadcast({ type: 'session_timeout', sessionId, name, idleMs })
    }
  })

  // 3. Create push notification manager, token manager, and WebSocket server
  const pushManager = new PushManager({
    storagePath: join(homedir(), '.chroxy', 'push-tokens.json'),
  })

  const configFile = join(homedir(), '.chroxy', 'config.json')
  const tokenManager = NO_AUTH ? null : new TokenManager({
    token: API_TOKEN,
    tokenExpiry: config.tokenExpiry || null,
    onPersist: (newToken) => {
      const persistToFile = () => {
        const raw = existsSync(configFile) ? readFileSync(configFile, 'utf-8') : '{}'
        const cfg = JSON.parse(raw)
        cfg.apiToken = newToken
        writeFileRestricted(configFile, JSON.stringify(cfg, null, 2))
      }
      try {
        if (isKeychainAvailable()) {
          try {
            setToken(newToken)
          } catch {
            // Keychain write failed — fall back to config file
            persistToFile()
          }
        } else {
          persistToFile()
        }
      } catch (err) {
        log.error(`Failed to persist token: ${err.message}`)
      }
    },
  })
  if (tokenManager) tokenManager.start()

  // Create pairing manager for ephemeral QR-based pairing (replaces permanent token in QR)
  const pairingManager = NO_AUTH ? null : new PairingManager({
    ttlMs: 60_000,
    autoRefresh: true,
  })

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
    pairingManager,
    environmentManager,
    // Full runtime config so handlers can consult settings at message
    // time — e.g. validateCwdAllowed consults config.workspaceRoots to
    // enforce the 2026-04-11 audit blocker 1 workspace allowlist.
    config,
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
      log.info(`Advertising _chroxy._tcp on port ${PORT} via mDNS`)
    } catch (err) {
      log.debug(`mDNS advertisement unavailable: ${err.message}`)
    }
  }

  // Track current WebSocket URL and mode label across all modes (tunnel, external, LAN)
  let tunnel = null
  let currentWsUrl = null
  let currentTunnelMode = 'none'

  // Helper: build QR connection URL using ephemeral pairing ID (never the permanent token)
  const buildPairingUrl = (wsUrlStr) => {
    if (!pairingManager) return null
    pairingManager.setWsUrl(wsUrlStr)
    return pairingManager.currentPairingUrl
  }

  // Helper: display QR code and connection info
  const SHOW_TOKEN = !!config.showToken || process.env.CHROXY_SHOW_TOKEN === '1'
  const displayQr = async (wsUrlStr, httpUrlStr, modeLabel) => {
    const pairingUrl = buildPairingUrl(wsUrlStr)
    if (pairingUrl) {
      console.log(`\n[✓] Server ready! (CLI headless mode, ${modeLabel})\n`)
      console.log('📱 Scan this QR code with the Chroxy app:\n')
      const qrText = await QRCode.toString(pairingUrl, { type: 'terminal', small: true })
      process.stdout.write(qrText)
      const displayToken = SHOW_TOKEN ? API_TOKEN : maskToken(API_TOKEN)
      console.log(`\nOr connect manually:`)
      console.log(`   URL:   ${wsUrlStr}`)
      console.log(`   Token: ${displayToken}`)
      if (httpUrlStr) {
        if (SHOW_TOKEN) {
          console.log(`   Dashboard: ${httpUrlStr}/dashboard?token=${API_TOKEN}`)
        } else {
          console.log(`   Dashboard: ${httpUrlStr}/dashboard (use --show-token to see full URL)`)
        }
      }
    }

    writeConnectionInfo({
      wsUrl: wsUrlStr,
      httpUrl: httpUrlStr,
      apiToken: API_TOKEN,
      connectionUrl: pairingUrl || `chroxy://${wsUrlStr.replace(/^wss?:\/\//, '')}?token=${API_TOKEN}`,
      tunnelMode: modeLabel,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    })
  }

  // External URL mode: reverse proxy / custom domain (skip tunnel entirely)
  const externalUrl = config.externalUrl || null
  if (externalUrl) {
    const wsUrl = externalUrl.replace(/^https?:\/\//, 'wss://')
    currentWsUrl = wsUrl
    currentTunnelMode = 'external'
    const httpUrl = externalUrl.replace(/^wss?:\/\//, 'https://')
    await displayQr(wsUrl, httpUrl, 'external')
  }

  // Determine tunnel mode
  const tunnelArg = parseTunnelArg(config.tunnel || 'quick')
  const SKIP_TUNNEL = NO_AUTH || !tunnelArg || !!externalUrl

  if (!SKIP_TUNNEL) {
    // 4. Start the tunnel
    tunnel = createTunnel({
      port: PORT,
      mode: tunnelArg.mode,
      tunnelConfig: config.tunnelConfig,
      tunnelName: config.tunnelName || null,
      tunnelHostname: config.tunnelHostname || null,
    })
    const { wsUrl, httpUrl } = await tunnel.start()
    currentWsUrl = wsUrl

    // 5. Wire up tunnel lifecycle events (before waitForTunnel to catch early failures)
    wireTunnelEvents(tunnel, wsServer)

    tunnel.on('tunnel_recovered', async ({ httpUrl: newHttpUrl, wsUrl: newWsUrl, attempt }) => {
      log.info(`Tunnel recovered after ${attempt} attempt(s)`)

      // Re-verify the new tunnel URL
      await waitForTunnel(newHttpUrl)

      // Only display new QR code if URL actually changed
      if (newWsUrl !== currentWsUrl) {
        currentWsUrl = newWsUrl
        if (pairingManager) pairingManager.refresh()
        await displayQr(newWsUrl, newHttpUrl, modeLabel)
        wsServer.broadcastStatus(`Tunnel reconnected with new URL: ${newWsUrl}`)
      } else {
        log.info(`Tunnel URL unchanged: ${newWsUrl}`)
        wsServer.broadcastStatus('Tunnel connection recovered')
      }
    })

    // 6. Wait for tunnel to be fully routable (DNS propagation)
    // UX landmine #4: waitForTunnel now throws TUNNEL_NOT_ROUTABLE
    // instead of silently proceeding with a broken QR.
    // #2836: phase 'tunnel_warming' is the current wire name. The
    // previous name 'tunnel_verifying' is still accepted by the dashboard
    // handler for backward compatibility with in-flight clients.
    //
    // #2849: gate on protocolVersion >= 2. v1 dashboards render unknown
    // `server_status` payloads as chat messages because they only read
    // `msg.message` (falls through to the legacy plain-status branch).
    // The structured phase field is a v2 addition.
    wsServer.broadcastMinProtocolVersion(TUNNEL_STATUS_MIN_PROTOCOL_VERSION, buildTunnelWarmingStatus({ tunnelMode: tunnelArg.mode, tunnelUrl: httpUrl }))
    try {
      await waitForTunnel(httpUrl, {
        onAttempt: (attempt, maxAttempts) => {
          wsServer.broadcastMinProtocolVersion(
            TUNNEL_STATUS_MIN_PROTOCOL_VERSION,
            buildTunnelWarmingStatus({
              tunnelMode: tunnelArg.mode,
              tunnelUrl: httpUrl,
              attempt,
              maxAttempts,
            }),
          )
        },
      })
    } catch (tunnelErr) {
      log.error(tunnelErr.message)
      wsServer.broadcastError(tunnelErr.message)
      console.error(`\n  ✗ ${tunnelErr.message}\n`)
      // Clean up the tunnel and server before exiting so we don't
      // leave orphan processes holding the port.
      try { await tunnel.stop() } catch {}
      try { wsServer.close() } catch {}
      process.exitCode = 1
      return
    }
    wsServer.broadcastMinProtocolVersion(TUNNEL_STATUS_MIN_PROTOCOL_VERSION, buildTunnelReadyStatus({ tunnelUrl: httpUrl }))

    // 7. Generate connection info
    const modeLabel = `cloudflare:${tunnelArg.mode}`
    currentTunnelMode = modeLabel
    await displayQr(wsUrl, httpUrl, modeLabel)

    // Extend the pairing ID validity after first QR display to give the user
    // time to scan. Without this, slow tunnel setup (60-80s) can consume most
    // of the default 60s TTL, causing rotation before the user can scan (#2599).
    if (pairingManager) pairingManager.extendCurrentId()

  } else if (externalUrl) {
    // Ready message already printed above
  } else if (!tunnelArg && !NO_AUTH) {
    const lanIp = getLanIp()
    const host = lanIp || 'localhost'
    currentWsUrl = `ws://${host}:${PORT}`
    await displayQr(`ws://${host}:${PORT}`, `http://${host}:${PORT}`, 'none')
  } else if (!NO_AUTH) {
    // tunnelArg is set but SKIP_TUNNEL is true due to externalUrl — already handled above
  } else {
    console.log(`[✓] Server ready! (CLI headless mode, no auth)\n`)
    console.log(`   Connect: ws://localhost:${PORT}`)
    console.log(`   Dashboard: http://localhost:${PORT}/dashboard`)
  }

  // Re-render QR code when pairing auto-refreshes (keeps terminal QR scannable)
  if (pairingManager) {
    pairingManager.on('pairing_refreshed', async () => {
      if (!currentWsUrl) return
      const httpBase = currentWsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
      await displayQr(currentWsUrl, httpBase, currentTunnelMode)
      log.info('QR code refreshed with new pairing ID.')
    })
  }

  // Regenerate QR code and update connection info when token rotates
  if (tokenManager) {
    tokenManager.on('token_rotated', async () => {
      if (!currentWsUrl) return // no-auth or localhost-only — no QR to update

      // Refresh pairing ID when token rotates (old session tokens remain valid).
      // The pairing_refreshed listener handles QR re-render; only call displayQr
      // directly when pairingManager is absent (no pairing_refreshed will fire).
      if (pairingManager) {
        pairingManager.refresh()
      } else {
        const httpBase = currentWsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
        await displayQr(currentWsUrl, httpBase, currentTunnelMode)
      }
      log.info('API token rotated. QR code updated.')
    })
  }

  console.log('\nPress Ctrl+C to stop.\n')

  // Graceful shutdown
  const shutdown = async (signal) => {
    log.info(`[${signal}] Shutting down...`)
    // Notify connected clients (ETA 0 = not coming back unless supervised)
    wsServer.broadcastShutdown('shutdown', 0)
    if (mdnsService) {
      try { mdnsService.stop?.() } catch {}
    }
    if (bonjourInstance) {
      try { bonjourInstance.destroy?.() } catch {}
    }
    if (tokenManager) tokenManager.destroy()
    if (pairingManager) pairingManager.destroy()
    // Persist sessions before destroying (enables restore on restart)
    try { sessionManager.serializeState() } catch (err) {
      log.error(`Failed to serialize session state: ${err?.message || err}`)
    }
    sessionManager.destroyAll()
    wsServer.close()
    if (tunnel) await tunnel.stop()
    removeConnectionInfo()
    process.exit(0)
  }

  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)) })
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })

  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err?.stack || err}`)
    try { wsServer.broadcastShutdown('crash', 0) } catch {}
    // destroyAll() first: SDK sessions auto-deny pending permissions before WsServer closes
    try { sessionManager.destroyAll() } catch {}
    try { wsServer.close() } catch {}
    try { if (tunnel) tunnel.stop() } catch {}
    try { removeConnectionInfo() } catch {}
    setTimeout(() => process.exit(1), 100)
  })

  process.on('unhandledRejection', (err) => {
    log.error(`Unhandled rejection: ${err?.stack || err}`)
    try { wsServer.broadcastShutdown('crash', 0) } catch {}
    // destroyAll() first: SDK sessions auto-deny pending permissions before WsServer closes
    try { sessionManager.destroyAll() } catch {}
    try { wsServer.close() } catch {}
    try { if (tunnel) tunnel.stop() } catch {}
    try { removeConnectionInfo() } catch {}
    setTimeout(() => process.exit(1), 100)
  })

  // Return references for supervised child drain protocol
  return { sessionManager, wsServer }
}
