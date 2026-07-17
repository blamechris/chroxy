import { SessionManager } from './session-manager.js'
import { DEFAULT_RESULT_TIMEOUT_MS, DEFAULT_HARD_TIMEOUT_MS, DEFAULT_STREAM_STALL_TIMEOUT_MS } from './base-session.js'
import { DEFAULT_TOOL_CALL_TIMEOUT_MS } from './byok-mcp-client.js'
import { formatIdleDuration } from './session-timeout-manager.js'
import { isOperatorTimeoutInRange } from './duration.js'
import { WsServer } from './ws-server.js'
import { BillingCanaryMonitor } from './billing-canary-monitor.js'
import { resolvePublicIp } from './get-public-ip.js'
import { createTunnel, parseTunnelArg } from './tunnel/index.js'
// #5368 slice (c): QUICK_TUNNEL_DNS_SETTLE_MS + TUNNEL_STATUS_MIN_PROTOCOL_VERSION
// moved to tunnel-lifecycle-handler.js with the tunnel block; createTunnel +
// waitForTunnel are still passed into the handler.
import { waitForTunnel } from './tunnel-check.js'
import { PushManager, settlePush } from './push.js'
import { ensureIngestSecret } from './event-ingest.js'
import { getChroxyHostEnv } from './chroxy-host-metadata.js'
import { PushNotificationHandler } from './server-cli/push-notification-handler.js'
import { StartupDisplay } from './server-cli/startup-display.js'
import { TunnelLifecycleHandler } from './server-cli/tunnel-lifecycle-handler.js'
import { ServerOrchestrator } from './server-cli/server-orchestrator.js'
import { hostname, homedir } from 'os'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative, sep } from 'path'
import { createLogger, setJsonMode, initFileLogging } from './logger.js'

const log = createLogger('cli')
// #5368 slice (b): QRCode + writeConnectionInfo moved to startup-display.js with
// displayQr; only removeConnectionInfo (shutdown) is still used here.
import { removeConnectionInfo } from './connection-info.js'
import { TokenManager } from './token-manager.js'
import { PairingManager } from './pairing.js'
import { getOrCreateServerIdentity, IdentityUnavailableError, resolveServerRotationCert } from './server-identity.js'
import { getLanIp } from './lan-ip.js'
import { resolveBindHost, isLoopbackHost, formatHostForUrl, maybeWarnNonLoopbackBind } from './bind-host.js'
import { writeFileRestricted } from './platform.js'
import { getToken, setToken, migrateToken, isKeychainAvailable } from './keychain.js'
import { maybeEncryptCredentialsAtRest } from './credential-store.js'
import { registerDockerProvider, resolveProviderLabel, DEFAULT_PROVIDER } from './providers.js'
import { registerAnthropicCompatibleProviders } from './anthropic-compatible-session.js'
import { registerOpenAiCompatibleProviders } from './openai-compatible-session.js'
import { getSharedPool, isPoolEnabled } from './docker-byok-pool.js'
import { getSharedPoolStats } from './docker-byok-pool-stats.js'
import { getRegistryForProvider, watchModelsOverlay } from './models.js'
// Imported from a dedicated constants module rather than environment-manager.js
// so we don't eagerly pull in DockerBackend when environments are disabled —
// environment-manager.js itself remains behind the dynamic import below
// (`if (config?.environments?.enabled)`).
import { UNREACHABLE_STATUSES } from './environment-statuses.js'
import { resolveSkipPermissions, buildEnvironmentBackend, isUserShellEnabled, getAllowAnyModelProviders } from './config.js'
import { buildOrchestrationManager } from './orchestration/build-manager.js'
import { parseDuration } from './duration.js'
import { createSessionTokenStore } from './session-token-store.js'

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
 * `tunnelMode` (#5356) lets clients that connected before the tunnel came up
 * (whose auth_ok exposure snapshot predates it) learn that a public quick
 * tunnel is now live. Optional so older callers/tests stay valid.
 *
 * @param {{ tunnelUrl: string, tunnelMode?: string }} args
 * @returns {object} WS message envelope
 */
export function buildTunnelReadyStatus({ tunnelUrl, tunnelMode }) {
  return {
    type: 'server_status',
    phase: 'ready',
    tunnelUrl,
    ...(tunnelMode ? { tunnelMode } : {}),
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
  const providerType = provider || DEFAULT_PROVIDER
  const modeStr = resolveProviderLabel(providerType)
  return `Chroxy Server v${version} (${modeStr})`
}

/**
 * Run `environmentManager.reconnect()` and log a startup summary (#3464).
 *
 * Always emits the existing `info` summary so the healthy-startup line stays
 * unchanged. When `reconnect()` resolves `false` (one or more environments
 * unreachable per PR #3462's contract), additionally emits a single aggregate
 * `warn` summarising the unreachable count derived from
 * `environmentManager.list()` — without this, the only signal was a buried
 * per-env `warn`, which is invisible in startup logs and tray-app dashboards.
 *
 * The unreachable count uses `UNREACHABLE_STATUSES` (currently `'error'` and
 * `'stopped'`) and stays accurate only while every code path in
 * `EnvironmentManager.reconnect()` that flips `allHealthy = false` also sets
 * `env.status` to one of those values. See the INVARIANT block on
 * `EnvironmentManager.reconnect()` JSDoc for details (#3492).
 *
 * Exported so tests can assert log behaviour without executing
 * `startCliServer()` end-to-end.
 *
 * @param {{ reconnect: () => Promise<boolean>, list: () => Array<{status: string}> }} environmentManager
 * @param {{ info: (msg: string) => void, warn: (msg: string) => void }} logger
 * @returns {Promise<boolean>} The boolean returned by `reconnect()`.
 */
export async function logEnvironmentManagerReconnectResult(environmentManager, logger) {
  const allHealthy = await environmentManager.reconnect()
  const environments = environmentManager.list()
  logger.info(`EnvironmentManager ready (${environments.length} environment(s))`)
  if (!allHealthy) {
    // Invariant (#3492): every reconnect() branch that flips allHealthy=false
    // also sets env.status to a value in UNREACHABLE_STATUSES. If a future
    // contributor adds a new branch without that co-located status assignment,
    // this count will silently undercount — keep them in sync.
    const unreachable = environments.filter(e => UNREACHABLE_STATUSES.has(e.status)).length
    logger.warn(`EnvironmentManager reconnect: ${unreachable} environment(s) unreachable — see per-environment logs above for details`)
  }
  return allHealthy
}

function checkNoAuthWarnings({ authRequired, tunnel }) {
  if (authRequired) return
  log.warn('--no-auth disables all authentication. Only safe on isolated networks!')
  if (tunnel && tunnel !== 'none') {
    log.error('--no-auth with tunnel exposes your server to the internet without authentication!')
  }
}

// #5368 slice (b): maskToken moved to server-cli/startup-display.js (its only
// caller was displayQr). Still also inlined in supervisor.js + mask-token.test.js.

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
/**
 * Persist server logs to disk so timeouts and crashes leave a forensic trail (#3731).
 *
 * Pre-fix the server only wrote to stdout/stderr — the Tauri parent buffered
 * ~100 lines in memory and the rest was dropped. Default destination is
 * `~/.chroxy/logs/chroxy.log` with 5MB rotation × 3 files; the caller can
 * override via `config.logLevel` / `config.logDir` or the `CHROXY_LOG_LEVEL` /
 * `CHROXY_LOG_DIR` env vars, and opt out entirely with
 * `CHROXY_NO_FILE_LOGGING=1` (used when a parent process owns log capture).
 *
 * Failures are swallowed: the boot path must not abort over a logging-only
 * problem (e.g. a read-only home directory). The error is reported to stderr
 * and the server continues with stdout-only logging.
 *
 * Exported for testing.
 *
 * @param {{ logLevel?: string, logDir?: string }} config
 * @returns {{ enabled: boolean, level: string, logDir: string|null, error?: string }}
 */
/**
 * #4509: resolve the three operator-facing inactivity timeouts
 * (resultTimeoutMs / hardTimeoutMs / streamStallTimeoutMs) from a startup
 * config object into BOTH shapes `startCliServer` needs:
 *
 *   - SessionManager constructor args (`*TimeoutMs`): null = let BaseSession
 *     apply its default. The provider opts forwarding path treats null as
 *     "omit", which is exactly the behaviour we want for fallback.
 *   - Startup log line (`effective*TimeoutMs`): the resolved DEFAULT_*
 *     constant so operators see the actual wall-clock value that will fire
 *     instead of a misleading `null`.
 *
 * Previously these two sites hand-rolled the same
 * `Number.isFinite(x) && x [>|>=] 0` check independently, with no
 * MAX_SANE_DURATION_MS ceiling. Consolidating into one helper closes the
 * #4509 gap and makes the two sites impossible to drift apart.
 *
 * @param {object} config - The merged startup config (from `~/.chroxy/config.json`
 *   + CLI flags + env vars).
 * @param {{ warn: Function }} log - Logger to emit the over-ceiling
 *   warning through. Defaults to a no-op so callers can omit it in tests.
 * @returns {{
 *   resultTimeoutMs: number|null,
 *   hardTimeoutMs: number|null,
 *   streamStallTimeoutMs: number|null,
 *   mcpToolCallTimeoutMs: number|null,
 *   effectiveResultTimeoutMs: number,
 *   effectiveHardTimeoutMs: number,
 *   effectiveStreamStallTimeoutMs: number,
 *   effectiveMcpToolCallTimeoutMs: number,
 * }}
 */
export function resolveStartupTimeouts(config = {}, log = { warn: () => {} }) {
  const resultOk = isOperatorTimeoutInRange(config.resultTimeoutMs, { name: 'resultTimeoutMs', log })
  const hardOk = isOperatorTimeoutInRange(config.hardTimeoutMs, { name: 'hardTimeoutMs', log })
  const stallOk = isOperatorTimeoutInRange(config.streamStallTimeoutMs, { allowZero: true, name: 'streamStallTimeoutMs', log })
  // #4517: mcpToolCallTimeoutMs joined the ceiling-clamped family. Same
  // `> 0` gate as the soft/hard timeouts (0 fires the callTool deadline
  // immediately and would make every MCP tool look broken); same fall-back-
  // to-null contract so byok-mcp-client's DEFAULT_TOOL_CALL_TIMEOUT_MS (30s)
  // applies. The config.js validator already gates file-loaded values to
  // 1s-10min — this guardrail catches programmatic instantiation and acts
  // as defense-in-depth for any future config path that bypasses validation.
  const mcpOk = isOperatorTimeoutInRange(config.mcpToolCallTimeoutMs, { name: 'mcpToolCallTimeoutMs', log })

  return {
    resultTimeoutMs: resultOk ? config.resultTimeoutMs : null,
    hardTimeoutMs: hardOk ? config.hardTimeoutMs : null,
    streamStallTimeoutMs: stallOk ? config.streamStallTimeoutMs : null,
    mcpToolCallTimeoutMs: mcpOk ? config.mcpToolCallTimeoutMs : null,
    effectiveResultTimeoutMs: resultOk ? config.resultTimeoutMs : DEFAULT_RESULT_TIMEOUT_MS,
    effectiveHardTimeoutMs: hardOk ? config.hardTimeoutMs : DEFAULT_HARD_TIMEOUT_MS,
    effectiveStreamStallTimeoutMs: stallOk ? config.streamStallTimeoutMs : DEFAULT_STREAM_STALL_TIMEOUT_MS,
    effectiveMcpToolCallTimeoutMs: mcpOk ? config.mcpToolCallTimeoutMs : DEFAULT_TOOL_CALL_TIMEOUT_MS,
  }
}

export function initFileLoggingFromConfig(config = {}) {
  if (process.env.CHROXY_NO_FILE_LOGGING === '1') {
    return { enabled: false, level: 'info', logDir: null }
  }
  const level = config.logLevel || process.env.CHROXY_LOG_LEVEL || 'info'
  const logDir = config.logDir || process.env.CHROXY_LOG_DIR || null
  try {
    initFileLogging({ level, ...(logDir ? { logDir } : {}) })
    return { enabled: true, level, logDir }
  } catch (err) {
    const message = err?.message || String(err)
    // Use console.error rather than the chroxy logger because the logger
    // itself may have just failed to initialize — a recursive log call
    // here would either silently swallow the message or crash on the
    // unset log path.
    console.error(`[logger] file logging init failed: ${message}`)
    return { enabled: false, level, logDir, error: message }
  }
}

/**
 * Decide whether to advertise the server over mDNS/Bonjour and, if so, publish
 * the `_chroxy._tcp` service. Extracted from startCliServer so the loopback
 * gating wiring is testable without booting the full CLI (#5280) — the pure
 * resolver (bind-host.js) was already covered, but the decision to suppress the
 * advertisement on a loopback bind was not.
 *
 * Returns `{ mdnsService, bonjourInstance }` (both null when not advertising) so
 * the caller can stop/destroy them on shutdown.
 *
 * @param {object} opts
 * @param {boolean} opts.noAuth   — auth disabled; never advertise.
 * @param {string|undefined} opts.bindHost — the resolved bind host.
 * @param {number} opts.port
 * @param {string} opts.version
 * @param {boolean} opts.hasToken — surfaced in the TXT record's `auth` field.
 * @param {object} [opts.log]     — logger (defaults to console).
 * @param {() => (object|Promise<object>)} [opts.bonjourFactory] — injectable
 *   Bonjour instance factory for tests; defaults to dynamically importing
 *   `bonjour-service`.
 */
export async function maybeAdvertiseMdns({
  noAuth,
  bindHost,
  port,
  version,
  hasToken,
  log = console,
  bonjourFactory,
} = {}) {
  const none = { mdnsService: null, bonjourInstance: null }
  // Auth-off skips discovery entirely (matches the pre-#5280 guards).
  if (noAuth) return none
  // Loopback bind — nothing on the LAN can reach it, so an _chroxy._tcp
  // advertisement would be misleading.
  if (isLoopbackHost(bindHost)) {
    log.info?.('Loopback bind — skipping mDNS advertisement (server not LAN-reachable)')
    return none
  }
  try {
    const bonjourInstance = bonjourFactory
      ? await bonjourFactory()
      : await (async () => {
          const { Bonjour } = await import('bonjour-service')
          return new Bonjour()
        })()
    const mdnsService = bonjourInstance.publish({
      name: `Chroxy (${hostname()})`,
      type: 'chroxy',
      port,
      txt: { version, auth: hasToken ? 'token' : 'none' },
    })
    log.info?.(`Advertising _chroxy._tcp on port ${port} via mDNS`)
    return { mdnsService, bonjourInstance }
  } catch (err) {
    // Normalize the error the way the rest of this file does — a Bonjour
    // factory (or the dynamic import) that throws a non-Error / null must not
    // turn the graceful no-advertisement fallback into a crash.
    log.debug?.(`mDNS advertisement unavailable: ${err?.message || String(err)}`)
    return none
  }
}

/**
 * #5369: best-effort teardown for STARTUP-ERROR paths (tunnel.start failure,
 * waitForTunnel failure). Async — awaits tunnel.stop() because at startup there
 * is no exit-deadline risk and we want a clean stop. Each step is try/catch-
 * isolated so one failure can't strand the rest. Exported (no process.exit) so
 * it can be unit-tested with fakes — mirrors flushAndDestroy in
 * server-cli-child.js. Order is tunnel → ws → mdns → bonjour → token → pairing
 * → sessionManager (the deliberate startup-error order; pool is NOT torn down
 * at these sites today and must not be added).
 */
export async function emergencyCleanup({
  tunnel, wsServer, mdnsService, bonjourInstance,
  tokenManager, pairingManager, sessionManager, logger = log,
}) {
  // String(err?.message || err) so a non-Error throw (e.g. a Symbol) can't make
  // the log-formatting itself throw and break this best-effort teardown chain.
  try { if (tunnel) await tunnel.stop() } catch (err) { logger?.warn?.(`emergencyCleanup: tunnel.stop failed: ${String(err?.message || err)}`) }
  try { wsServer?.close() } catch (err) { logger?.warn?.(`emergencyCleanup: wsServer.close failed: ${String(err?.message || err)}`) }
  try { mdnsService?.stop?.() } catch {}
  try { bonjourInstance?.destroy?.() } catch {}
  try { tokenManager?.destroy() } catch {}
  try { pairingManager?.destroy() } catch {}
  try { sessionManager?.destroyAll() } catch (err) { logger?.warn?.(`emergencyCleanup: destroyAll failed: ${String(err?.message || err)}`) }
}

/**
 * #5369: unified SYNCHRONOUS crash teardown for uncaughtException /
 * unhandledRejection. `kind` is the log label. Deliberately NOT async and does
 * NOT await tunnel.stop() — the sigterm-not-sigkill invariant: a hung stop must
 * never block the setTimeout-driven process.exit in the caller (otherwise an
 * installed crash handler suppresses Node's default crash-exit and could leave
 * the process alive forever). Order: broadcast → serialize → destroyAll → ws
 * close → tunnel.stop (fire-and-forget) → removeConnectionInfo. destroyAll runs
 * before wsServer.close so SDK sessions auto-deny pending permissions first.
 */
export function emergencyCleanupSync({ kind, tunnel, wsServer, sessionManager, logger = log }) {
  try { wsServer?.broadcastShutdown('crash', 0) } catch {}
  // Persist sessions before destroying — losing the user's restored state on
  // crash is worse UX than the small risk of writing partial state. The
  // try/catch isolates serialization failures so destroyAll() still runs.
  // logger?.warn?.() + String(...) so a minimal/nullish logger or a non-Error
  // throw can't itself throw and abort the remaining crash teardown.
  try { sessionManager?.serializeState() } catch (serializeErr) {
    logger?.warn?.(`Failed to serialize state during ${kind}: ${String(serializeErr?.stack || serializeErr)}`)
  }
  try { sessionManager?.destroyAll() } catch {}
  try { wsServer?.close() } catch {}
  // NO await — see the invariant above.
  try { if (tunnel) tunnel.stop() } catch {}
  try { removeConnectionInfo() } catch {}
}

export async function startCliServer(config) {
  // Enable JSON log format if configured
  if (config.logFormat === 'json') {
    setJsonMode(true)
  }

  initFileLoggingFromConfig(config)

  // #6633: publish Chroxy's host identity into this process's environment so the
  // in-process SDK provider's Bash tools inherit it (subprocess providers get it
  // via buildSpawnEnv). Computed + authoritative — a session can read
  // $CHROXY_HOST_VERSION / _GIT_SHA / _CHANNEL to confirm the exact running build.
  Object.assign(process.env, getChroxyHostEnv())

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

  // #5154 — encrypt a legacy plaintext credentials.json at rest once an OS
  // keychain is available (mirrors the primary-token migration above).
  // Best-effort: never blocks boot.
  try {
    maybeEncryptCredentialsAtRest({ log })
  } catch (err) {
    log.warn(`Credentials at-rest encryption check failed: ${err.message}`)
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

  // Register optional providers (e.g. docker) based on config
  await registerDockerProvider(config)

  // #5419: register config-driven Anthropic-compatible endpoints from
  // `providers.anthropicCompatible` (Z.ai GLM, Moonshot Kimi, MiniMax,
  // LM Studio, llama.cpp, vLLM, OpenRouter, custom). Registered before
  // the default-provider resolution below so `--provider <id>` /
  // `config.provider` can select one. Invalid entries are warned about
  // and skipped; valid siblings still register.
  registerAnthropicCompatibleProviders(config)
  // #5420: register config-driven OpenAI-compatible endpoints from
  // `providers.openaiCompatible` (OpenAI, OpenRouter, LM Studio, vLLM,
  // llama.cpp, Together, Groq, custom). Same entry shape, but the session
  // talks chat-completions via the Anthropic↔OpenAI shim. Registered right
  // after the Anthropic-compatible block (collision-checked against it).
  registerOpenAiCompatibleProviders(config)

  const providerType = config.provider || DEFAULT_PROVIDER

  // Warm the models registry from disk cache so the picker is populated before
  // any SDK session fires supportedModels(). Routed through the ACTIVE provider's
  // registry (#6368) so a non-Claude DEFAULT_PROVIDER warms its OWN cache
  // (~/.chroxy/models-cache.<provider>.json) instead of the Claude default. For
  // Claude providers getRegistryForProvider returns the shared default registry,
  // so behaviour is byte-identical to the prior module-level loadModelsCache().
  // Placed after the provider-registration block above so getRegistryForProvider
  // can resolve docker/config-driven/non-Claude providers. Silent miss on first boot.
  const bootRegistry = getRegistryForProvider(providerType)
  if (bootRegistry.loadCache()) {
    log.info(`Warmed models from cache: ${bootRegistry.getModels().map(m => m.id).join(', ')}`)
  }

  // #4209 / #4246: resolve the effective skip-permissions setting from the
  // merged config (CLI flag > canonical `dangerouslySkipPermissions` >
  // legacy `skipPermissions` alias). When enabled, log a loud security
  // banner identifying which key/source surfaced it — operators scanning
  // their config.json shouldn't have to wonder why their TUI sessions
  // started spawning with --dangerously-skip-permissions. When the legacy
  // alias is used, also surface the deprecation warning so they're
  // nudged to rename the key.
  const skipPerms = resolveSkipPermissions(config)
  if (skipPerms.deprecationWarning) {
    log.warn(`[security] ${skipPerms.deprecationWarning}`)
  }
  if (skipPerms.enabled) {
    log.warn(`[security] dangerouslySkipPermissions=true (source: config.${skipPerms.source}) — claude-tui sessions will spawn with --dangerously-skip-permissions and chroxy's permission gate is BYPASSED for those sessions`)
  }

  // Create environment manager for persistent container environments (optional)
  let environmentManager = null
  if (config?.environments?.enabled) {
    const { EnvironmentManager } = await import('./environment-manager.js')
    // #4556: forward the operator-configured K8s workspace PVC default so
    // every environment created on a K8s backend picks up the strategy
    // without per-call plumbing. Shape was validated at config-load time
    // (`validateConfig` in config.js); the manager re-passes it verbatim to
    // the backend, which is the single enforcement point for runtime checks
    // (K8sBackend.validateWorkspacePVC). Docker / other backends ignore the
    // field, so this is safe to pass regardless of the active backend.
    const workspacePVCDefault = config?.environments?.k8s?.workspace || null
    if (workspacePVCDefault) {
      const mountPath = workspacePVCDefault.mountPath || '/workspace'
      const readOnlyTag = workspacePVCDefault.readOnly ? ' (readOnly)' : ''
      // Make the K8s-only scope explicit so an operator who set this block
      // against a Docker deployment doesn't assume the PVC is being mounted —
      // Docker / other backends silently ignore the field at runtime.
      log.info(`EnvironmentManager: K8s workspace PVC configured (claim: ${workspacePVCDefault.claimName}, mount: ${mountPath})${readOnlyTag} — active only on K8sBackend; ignored by Docker and other backends`)
    }
    // #5144: config-driven backend selection. `environments.backend` picks
    // docker (default) | k8s | rancher; the selected backend's options come
    // from `environments.k8s` / `environments.rancher` (Rancher token resolved
    // from a secret-friendly source and never logged). The factory imports the
    // backend module lazily so a Docker deployment never pulls in the kube SDK,
    // and throws on a malformed k8s/rancher block — surfaced here as a fatal
    // startup error rather than a silent fall-through to Docker.
    let backend
    try {
      const built = await buildEnvironmentBackend(config)
      backend = built.backend
      if (built.type !== 'docker') {
        log.info(`EnvironmentManager: using '${built.type}' backend (from environments.backend)`)
      }
    } catch (err) {
      log.error(`EnvironmentManager: failed to construct '${config?.environments?.backend || 'docker'}' backend — ${err.message}`)
      throw err
    }
    environmentManager = new EnvironmentManager({ backend, workspacePVCDefault })
    await logEnvironmentManagerReconnectResult(environmentManager, log)
  }

  // #5081: boot-time garbage collection of leaked docker-byok compose stacks.
  // A daemon crash / SIGKILL between `docker compose up` and `docker compose
  // down` leaves the stack running with only an on-disk record (written by
  // DockerByokSession on start). Sweep those orphans now — before any new
  // session launches — so a crash can't leak stacks indefinitely. Entirely
  // best-effort: a failure here (docker down, partial teardown) is logged and
  // the offending entry stays on disk to be retried on the next boot.
  try {
    const { getSharedComposeStateStore } = await import('./byok-compose-state-shared.js')
    const { sweepOrphanedComposeStacks } = await import('./byok-compose-state.js')
    const store = getSharedComposeStateStore()
    if (store.list().length > 0) {
      const { DockerBackend } = await import('./environments/backends/docker.js')
      const result = await sweepOrphanedComposeStacks({ store, backend: new DockerBackend() })
      log.info(`docker-byok compose sweep: ${result.swept} orphaned stack(s) torn down, ${result.failed} deferred to next boot`)
    }
  } catch (err) {
    log.warn(`docker-byok compose sweep failed: ${err.message}`)
  }

  // #4509: resolve once so the SessionManager arg side and the startup log
  // line below can't drift apart, and any over-ceiling operator value emits
  // a single warning here at boot (not three on each tunable).
  const startupTimeouts = resolveStartupTimeouts(config, log)

  // 1. Create session manager
  const sessionManager = new SessionManager({
    maxSessions: config.maxSessions || 5,
    port: PORT,
    apiToken: API_TOKEN,
    defaultCwd: config.cwd || (isWithinHome(process.cwd()) ? process.cwd() : homedir()),
    defaultModel: config.model || null,
    defaultPermissionMode: 'approve',
    // #5859 (audit P1-7): reclaim orphaned chroxy session worktrees at boot when
    // the operator opted into worktree auto-reaping. Clean-tree-guarded.
    sweepOrphanWorktrees: config.worktreeGc?.autoReap === true,
    // #4209 / #4246: seed the auto-created Default session + any
    // subsequent createSession() that omits the field. Only honoured by
    // the claude-tui provider; other providers ignore it harmlessly.
    // Resolved via `resolveSkipPermissions()` so both the canonical
    // `dangerouslySkipPermissions` key and the legacy `skipPermissions`
    // alias are honoured (with a deprecation warning for the latter —
    // see the [security] log lines above).
    defaultSkipPermissions: skipPerms.enabled,
    // #5985 (epic #5982): gate the embedded user-shell terminal. Off unless the
    // operator set userShell.enabled:true in the config file. Enforced in
    // SessionManager.createSession so it covers every spawn path.
    userShellEnabled: isUserShellEnabled(config),
    // #6378: providers opted into unrestricted model validation (serve any
    // API-valid model id without a release). Empty Set unless the operator set
    // config.providers.allowAnyModel.
    allowAnyModelProviders: getAllowAnyModelProviders(config),
    providerType,
    maxToolInput: config.maxToolInput || null,
    transforms: config.transforms || [],
    sessionTimeout: config.sessionTimeout || null,
    sandbox: config.sandbox || null,
    costBudget: config.costBudget || null,
    // #5665: monthly programmatic-credit budget meter config.
    billing: config.billing || null,
    maxMessages: config.maxMessages || config.maxHistory || null,
    // #3749 / #3884 / #3899: SOFT-warning inactivity timeout (ms). null = BaseSession default (30 min).
    // #3899: HARD-cap inactivity timeout (ms). null = BaseSession default (2h).
    // #4467: stream-stall recovery (ms). null = BaseSession default (5min).
    //   0 explicitly disables (operators with workloads that have legitimate
    //   long event gaps can opt out).
    // #4509: ceiling-clamped via `resolveStartupTimeouts()` above; an
    // over-24h operator value falls back to null here so BaseSession applies
    // its default (and the operator gets a warn log identifying the bad key).
    resultTimeoutMs: startupTimeouts.resultTimeoutMs,
    hardTimeoutMs: startupTimeouts.hardTimeoutMs,
    streamStallTimeoutMs: startupTimeouts.streamStallTimeoutMs,
    // #5288: background-shell hard-quiesce window (ms). null = BaseSession
    // default (4h); 0 disables hard-reaping. SessionManager applies the same
    // isOperatorTimeoutInRange ceiling guard (allowZero) as the timeouts.
    backgroundShellHardQuiesceMs: config.backgroundShellHardQuiesceMs ?? null,
    // #4601: per-provider streamStallTimeoutMs override map. SessionManager
    // sanitises each entry against the same range gate as the global value
    // (`allowZero: true`, 5s-24h ceiling) — bogus entries are dropped (with
    // a warn) and the affected session falls through to the global value.
    // The unsanitised object is forwarded as-is so SessionManager owns the
    // single source of truth for validation.
    providerStreamStallTimeoutMs: config.providerStreamStallTimeoutMs || null,
    // #4482: per-MCP-call timeout (ms). null = byok-mcp-client default (30s).
    // Unlike streamStallTimeoutMs, 0 is not a meaningful disable — every
    // MCP tool would look broken — so non-positive falls back to null.
    // #4517: ceiling-clamped via `resolveStartupTimeouts()` above; an
    // over-24h operator value falls back to null here so byok-mcp-client
    // applies its default (and the operator gets a warn log).
    mcpToolCallTimeoutMs: startupTimeouts.mcpToolCallTimeoutMs,
    // Skills size budgets (#3202). null = use loader defaults (32KB / 256KB).
    maxSkillBytes: Number.isFinite(config.maxSkillBytes) ? config.maxSkillBytes : null,
    maxTotalSkillBytes: Number.isFinite(config.maxTotalSkillBytes) ? config.maxTotalSkillBytes : null,
  })

  // #3749 / #3899: surface the effective inactivity timeouts at startup so
  // operators can verify their config overrides took effect.
  // #4509: re-use the already-clamped values from `resolveStartupTimeouts()`
  // so the log line can't drift away from the SessionManager constructor
  // args (e.g. log "12h hard-cap" while passing `null` because only one of
  // the two sites caught a typo).
  const { effectiveResultTimeoutMs, effectiveHardTimeoutMs, effectiveStreamStallTimeoutMs } = startupTimeouts
  const stallLabel = effectiveStreamStallTimeoutMs === 0
    ? 'disabled'
    : `${formatIdleDuration(effectiveStreamStallTimeoutMs)} (${effectiveStreamStallTimeoutMs}ms)`
  log.info(`Inactivity soft-warning: ${formatIdleDuration(effectiveResultTimeoutMs)} (${effectiveResultTimeoutMs}ms); hard-cap: ${formatIdleDuration(effectiveHardTimeoutMs)} (${effectiveHardTimeoutMs}ms); stream-stall: ${stallLabel}`)

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

  // #5368 slice (a): the `session_event` → push-notification path (incl. the
  // #3866 idle-push dedupe and the #3870/#3871/#3872 races) lives in
  // PushNotificationHandler, constructed + started after pushManager exists and
  // before wsServer (so the #3871 wsServer-undefined branch still covers an
  // early restoreState event). See below, right after `new PushManager(...)`.

  // Log events for debugging
  sessionManager.on('session_created', ({ sessionId, name, cwd }) => {
    log.info(`Session created: ${sessionId} (${name}) in ${cwd}`)
  })

  sessionManager.on('session_destroyed', ({ sessionId }) => {
    log.info(`Session destroyed: ${sessionId}`)
    // #5368: the idle-push dedupe clear-on-destroy now lives in
    // PushNotificationHandler (its own session_destroyed listener).
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
    // #4541: notification preferences persistence. Co-located in
    // ~/.chroxy alongside push-tokens.json so cleanup is one step.
    prefsPath: join(homedir(), '.chroxy', 'notification-prefs.json'),
    // #5413 Phase 2: Discord status-embed sink. Off by default — only
    // active when a webhook URL resolves from CHROXY_DISCORD_WEBHOOK_URL
    // or ~/.chroxy/credentials.json (0600). Non-secret knobs (bot name,
    // per-project embed colors, throttle/heartbeat intervals) come from
    // the `notifications.discord` config block; the status-message state
    // (message ids, current state) persists alongside the other
    // notification state in ~/.chroxy.
    discord: {
      statePath: join(homedir(), '.chroxy', 'discord-webhook-state.json'),
      // #5828: the billing-alert sink keeps its own state file, separate from
      // the per-project status store above.
      billingStatePath: join(homedir(), '.chroxy', 'discord-billing-state.json'),
      ...(config.notifications?.discord || {}),
    },
  })

  // #5413 Phase 3: provision the daemon-level ingest secret for
  // POST /api/events BEFORE any external hook needs to read it (emitters
  // authenticate with the file's content, so it must exist up front).
  // Fail-soft: on failure the route fails closed (rejects everything) and
  // the warn log tells the operator why. Never logs the secret.
  ensureIngestSecret()

  // #5368 slice (a): wire the session_event → push path now that pushManager
  // exists. `getWsServer` is lazy because the handler is started before wsServer
  // is constructed (below) — an early restoreState `result` event must still
  // route here and hit the wsServer-undefined branch (#3871).
  const pushNotificationHandler = new PushNotificationHandler({
    sessionManager,
    pushManager,
    getWsServer: () => wsServer,
    logger: log,
  })
  pushNotificationHandler.start()

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

  // #5536 — long-lived server identity for E2E key pinning. Minted once and
  // persisted across restarts (keychain, or a 0600 file fallback). Its public
  // half rides the pairing payload (pinned by clients); its secret half signs
  // each connection's ephemeral exchange key so a pinned client can verify the
  // exchange key really came from this daemon. Only relevant when encryption is
  // on and auth is required — skip the keypair work for --no-auth / --no-encrypt
  // so those modes carry no pinning surface (and old TOFU behaviour is unchanged).
  let serverIdentity = null
  if (!NO_AUTH && !config.noEncrypt) {
    try {
      serverIdentity = getOrCreateServerIdentity()
    } catch (err) {
      if (err instanceof IdentityUnavailableError) {
        // #5615 case (b): the keychain is PRESENT but the identity read FAILED
        // (locked / interaction-not-allowed). We deliberately did NOT mint a
        // replacement — doing so would silently rotate the daemon's identity and
        // brick every already-pinned client with a false "network impersonation"
        // alert. A transient lock must not look like an active MITM.
        //
        // Fail loudly by default: refuse to start so the operator unlocks the
        // keychain (or grants access) and the SAME pinned identity loads. The
        // CHROXY_ALLOW_UNPINNED_BOOT escape hatch lets an operator who knows no
        // clients are pinned boot anyway with pinning DISABLED this boot — the
        // server then signs nothing. Clients that NEVER pinned this daemon see an
        // old-daemon shape (TOFU). Clients that ALREADY pinned it will REFUSE the
        // unsigned handshake (pinned-but-unsigned) — which is the safe outcome and
        // still better than a false "impersonation" alert from a rotated identity.
        // (err.message already begins with "server identity keychain read
        // failed (…)", so log it directly — no redundant prefix.)
        if (process.env.CHROXY_ALLOW_UNPINNED_BOOT === '1') {
          log.warn(
            `${err.message}. ` +
            'CHROXY_ALLOW_UNPINNED_BOOT=1 set — starting WITH KEY PINNING DISABLED this boot ' +
            '(server signs no exchange keys). Clients that never pinned this daemon get TOFU; ' +
            'clients that ALREADY pinned it will refuse until you restore the identity. ' +
            'Unlock the keychain and restart to restore pinning.',
          )
          serverIdentity = null
        } else {
          log.error(
            `${err.message}. ` +
            'Refusing to start: minting a replacement would rotate this daemon\'s identity and ' +
            'falsely alarm every paired client as a network-impersonation attempt. ' +
            'Unlock your OS keychain (or grant chroxy access) and start again. ' +
            'If you are certain NO clients have pinned this daemon, set CHROXY_ALLOW_UNPINNED_BOOT=1 ' +
            'to start once with key pinning disabled.',
          )
          process.exit(1)
        }
      } else {
        // Any other failure (e.g. no keychain + unwritable fallback file) keeps
        // the original behaviour: disable pinning, stay TOFU. This is NOT the
        // silent-rotation hazard — there was no prior identity to contradict.
        log.warn(`Could not establish server identity key (${err.message}); E2E key pinning disabled — connections stay TOFU`)
        serverIdentity = null
      }
    }
  }

  // #5616/#5976 — if the identity was rotated (admin ran `chroxy identity
  // rotate`), attach the single-hop continuity cert so the handshake can offer
  // it. The staleness guard inside resolveServerRotationCert ignores a sidecar
  // that names a different identity than the one we just loaded (e.g. left over
  // from before a clean re-mint). Best-effort: a missing/unreadable sidecar
  // simply leaves pinning behaviour unchanged (rotated clients re-pair).
  if (serverIdentity) {
    try {
      const cert = resolveServerRotationCert(serverIdentity.publicKey)
      if (cert) {
        serverIdentity = { ...serverIdentity, rotationCert: cert.rotationCert, previousPublicKey: cert.previousPublicKey }
        log.info('Identity-rotation continuity cert loaded — pinned clients can chain forward without re-pairing')
      }
    } catch (err) {
      log.warn(`Could not load identity-rotation cert (${err.message}); rotated clients will need to re-pair`)
    }
  }

  // Create pairing manager for ephemeral QR-based pairing (replaces permanent token in QR)
  // #6598 — how long a paired device's token survives without reconnecting
  // (sliding). Operator-configurable via `sessionTokenTtl` / CHROXY_SESSION_TOKEN_TTL;
  // default 30d, floored at 5min so a typo can't cause re-pair spam.
  const SESSION_TOKEN_TTL_DEFAULT_MS = 30 * 24 * 60 * 60_000
  const SESSION_TOKEN_TTL_FLOOR_MS = 5 * 60_000
  const parsedSessionTtl = config.sessionTokenTtl ? parseDuration(config.sessionTokenTtl) : null
  const sessionTokenTtlMs = Math.max(
    parsedSessionTtl && parsedSessionTtl > 0 ? parsedSessionTtl : SESSION_TOKEN_TTL_DEFAULT_MS,
    SESSION_TOKEN_TTL_FLOOR_MS,
  )
  // #6598 — persist paired tokens across restarts (encrypted at rest). Honour a
  // CHROXY_CONFIG_DIR override so it sits next to config.json / credentials.json.
  const chroxyDir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  const pairingManager = NO_AUTH ? null : new PairingManager({
    ttlMs: 60_000,
    autoRefresh: true,
    identityPublicKey: serverIdentity?.publicKey || null,
    sessionTokenTtlMs,
    sessionTokenStore: createSessionTokenStore({ dir: chroxyDir }),
  })

  // #6691 (E-4): the orchestration engine (null when the feature is off or if
  // construction fails — never a throw, so it can't break daemon boot).
  const orchestrationManager = buildOrchestrationManager({ sessionManager, config, chroxyDir, log })

  wsServer = new WsServer({
    port: PORT,
    apiToken: API_TOKEN,
    sessionManager,
    orchestrationManager,
    defaultSessionId,
    authRequired: !NO_AUTH,
    pushManager,
    maxPayload: config.maxPayload,
    noEncrypt: config.noEncrypt,
    // #6564 — `encryptLocalhost` (CHROXY_ENCRYPT_LOCALHOST) forces E2E encryption
    // on loopback too by disabling the plaintext bypass unconditionally. Default
    // off; the bypass is separately auto-disabled while a tunnel is active.
    localhostBypass: !config.encryptLocalhost,
    tokenManager,
    pairingManager,
    // #5536 — the identity keypair the WsServer uses to sign each connection's
    // ephemeral exchange public key (both eager and discrete paths). Null when
    // pinning is unavailable (no-auth / no-encrypt / keychain failure).
    serverIdentity,
    environmentManager,
    // Full runtime config so handlers can consult settings at message
    // time — e.g. validateCwdAllowed consults config.workspaceRoots to
    // enforce the 2026-04-11 audit blocker 1 workspace allowlist.
    config,
  })
  // Resolve the bind address. --no-auth forces loopback; otherwise an explicit
  // config.host (e.g. --host 127.0.0.1) binds that interface with auth still
  // on, and the default (undefined) binds 0.0.0.0 as before.
  // #6691 (E-4): forward engine run deltas to host-level (unbound) dashboard
  // clients. The manager already projects each delta to the wire shape; the
  // WsServer only routes it. Guarded so a broadcast error never bubbles.
  if (orchestrationManager) {
    orchestrationManager.on('run_delta', (delta) => {
      try { wsServer._broadcastOrchestrationDelta(delta) } catch (err) { log.warn(`orchestration delta broadcast failed: ${err?.message || err}`) }
    })
  }

  const bindHost = resolveBindHost({ noAuth: NO_AUTH, host: config.host })
  // #5356 (visibility layer): one warning when binding non-loopback (the
  // default 0.0.0.0 included) — LAN peers can reach the unauthenticated
  // surface (/health fingerprint, dashboard assets, rate-limited auth and
  // pairing attempts). No default change; points at --host 127.0.0.1.
  maybeWarnNonLoopbackBind({ bindHost, log })
  wsServer.start(bindHost)

  // #5932: hot-reload the ~/.chroxy/models.json overlay on edit — surfacing a
  // new model id (or a label/contextWindow/pricing override) is "a config entry,
  // not a code change", so it must not require a daemon restart. On a successful
  // reload, re-broadcast `available_models` for the default (Claude) registry so
  // connected pickers refresh live. A malformed save is ignored (last-good kept).
  const modelsOverlayWatcher = watchModelsOverlay({
    onReload: ({ models, defaultModelId }) => {
      log.info(`Models overlay reloaded: ${models.map((m) => m.id).join(', ')}`)
      wsServer.broadcast({ type: 'available_models', models, defaultModel: defaultModelId, provider: 'claude-sdk' })
    },
  })

  // #5821 (live wiring): the billing canary. Recomputes the daemon's billing
  // early-warnings (silent metered default; the dormant claude-tui
  // reclassification tripwire) and broadcasts a `billing_canary` message when
  // they change, so the dashboard can surface a banner during the 2026-06-15
  // programmatic-credit window. Created after wsServer (it broadcasts through
  // it); the provider is wired back into wsServer so the snapshot also seeds
  // auth_ok for late joiners.
  //
  // #5828: datacenter-egress detection is OPT-IN via `config.billing.egressCheck`
  // — only then do we pass `resolveEgressIp`, the one place the daemon makes an
  // outbound IP lookup (consent-gated). `getDatacenterPrefixes` lets an operator
  // add their cloud's ranges without a code change. `notify` fans a warning set
  // out as a `billing_warning` push so an away operator hears about a metered
  // default or a datacenter-egress flag without watching the dashboard.
  const egressCheckEnabled = config.billing?.egressCheck === true
  const billingCanaryMonitor = new BillingCanaryMonitor({
    getSessions: () => sessionManager.listSessions(),
    getDefaultProvider: () => config.provider || DEFAULT_PROVIDER,
    getApiKeyAuth: () => (config.provider || DEFAULT_PROVIDER) === 'claude-sdk' && Boolean(process.env.ANTHROPIC_API_KEY),
    broadcast: (msg) => { try { wsServer?.broadcast(msg) } catch { /* best-effort */ } },
    logger: log,
    resolveEgressIp: egressCheckEnabled ? () => resolvePublicIp() : undefined,
    getDatacenterPrefixes: () => config.billing?.datacenterPrefixes || [],
    notify: (warnings) => {
      // #5828: the monitor fires this once per distinct warning SET, plus once
      // on the non-empty→empty (all-clear) transition with an empty array. An
      // empty set is the all-clear: send a `resolved` push so the Discord
      // billing sink repaints its message green (and mobile gets a cleared
      // note). settlePush (#5702) logs both a thrown error AND a `false`
      // not-delivered return that a bare `.catch()` would drop.
      if (warnings.length === 0) {
        settlePush(
          pushManager.send('billing_warning', 'Billing alert cleared', 'All billing warnings have cleared.', { resolved: true }),
          'billing-canary-clear',
          log,
        )
        return
      }
      // One aggregate push per distinct warning set — billing_warning has no
      // rate limit (RATE_LIMITS), so the monitor's own change-detection is the
      // throttle. Codes ride in `data` for clients that key off them.
      const count = warnings.length
      const title = count > 1 ? `Billing alert (${count})` : 'Billing alert'
      const body = warnings.map((w) => w.message).join('\n\n')
      const codes = warnings.map((w) => w.code)
      settlePush(pushManager.send('billing_warning', title, body, { codes }), 'billing-canary', log)
    },
  })
  wsServer.setBillingCanaryProvider(() => billingCanaryMonitor.current())
  // Recompute on session lifecycle (changes the session set the canary reads);
  // the periodic interval covers cost drift. These are additional listeners —
  // they don't replace the logging ones above.
  sessionManager.on('session_created', () => billingCanaryMonitor.refresh())
  sessionManager.on('session_destroyed', () => billingCanaryMonitor.refresh())
  billingCanaryMonitor.start()

  // #5053: wire the pool stats aggregator to the shared pool so the
  // dashboard's GET /api/pool/stats has rolling counters (hit rate,
  // eviction-by-reason, recent evictions) to read. Default-OFF — only the
  // shared pool exists when CHROXY_DOCKER_BYOK_POOL is enabled, so this is a
  // no-op otherwise. attach() is idempotent (won't double-subscribe).
  if (isPoolEnabled(process.env)) {
    const statsPool = getSharedPool(process.env)
    if (statsPool) getSharedPoolStats().attach(statsPool)
  }

  // Wire session timeout to WsServer viewer checks
  sessionManager.setActiveViewersFn((sid) => wsServer.hasActiveViewersForSession(sid))
  sessionManager.startSessionTimeouts()

  // Advertise via mDNS/Bonjour for local network discovery. Suppressed on a
  // loopback bind and when auth is off — see maybeAdvertiseMdns (#5280).
  const { mdnsService, bonjourInstance } = await maybeAdvertiseMdns({
    noAuth: NO_AUTH,
    bindHost,
    port: PORT,
    version: SERVER_VERSION,
    hasToken: !!API_TOKEN,
    log,
  })

  // Track the live tunnel handle across modes (consumed by shutdown below).
  let tunnel = null

  // #5368 slice (b): the connection display — QR render + manual-connect block +
  // the connection-info side-car (displayQr), the ephemeral pairing-URL builder
  // (buildPairingUrl), the current-URL/mode display state shared across modes,
  // and the QR re-render listeners — lives in StartupDisplay. The mode branches
  // below set `startupDisplay.currentWsUrl` / `currentTunnelMode` and call
  // `startupDisplay.displayQr(...)`. The tunnel path sets currentWsUrl EARLY
  // (before the first displayQr) so a mid-startup tunnel_recovered has a value to
  // diff against — so displayQr deliberately does not mutate that state.
  const startupDisplay = new StartupDisplay({
    pairingManager,
    tokenManager,
    apiToken: API_TOKEN,
    showToken: !!config.showToken || process.env.CHROXY_SHOW_TOKEN === '1',
    logger: log,
  })

  // External URL mode: reverse proxy / custom domain (skip tunnel entirely)
  const externalUrl = config.externalUrl || null
  if (externalUrl) {
    const wsUrl = externalUrl.replace(/^https?:\/\//, 'wss://')
    startupDisplay.currentWsUrl = wsUrl
    startupDisplay.currentTunnelMode = 'external'
    const httpUrl = externalUrl.replace(/^wss?:\/\//, 'https://')
    await startupDisplay.displayQr(wsUrl, httpUrl, 'external')
  }

  // Determine tunnel mode
  const tunnelArg = parseTunnelArg(config.tunnel || 'quick')
  const SKIP_TUNNEL = NO_AUTH || !tunnelArg || !!externalUrl

  if (!SKIP_TUNNEL) {
    // #5356 (visibility layer): record quick-tunnel exposure before startup so
    // the auth_ok exposure snapshot covers clients that connect mid-warming.
    wsServer.setQuickTunnelActive(tunnelArg.mode === 'quick')
    // #5368 slice (c): the tunnel lifecycle (create + start + emergency-cleanup
    // on a start throw, wireTunnelEvents, tunnel_recovered re-verify + QR
    // re-render, waitForTunnel with warming/ready broadcasts + emergency-cleanup
    // on failure, success QR + pairing-id extension) lives in
    // TunnelLifecycleHandler. The function deps are passed in (createTunnel /
    // waitForTunnel as test seams; emergencyCleanup / wireTunnelEvents /
    // buildTunnel*Status are server-cli-defined, so injecting avoids a circular
    // import). On startup failure it returns ok:false after the full cleanup —
    // preserving startCliServer's original `process.exitCode = 1; return`.
    const tunnelHandler = new TunnelLifecycleHandler({
      createTunnel,
      emergencyCleanup,
      wireTunnelEvents,
      waitForTunnel,
      buildTunnelWarmingStatus,
      buildTunnelReadyStatus,
      config: {
        port: PORT,
        tunnelArg,
        tunnelConfig: config.tunnelConfig,
        tunnelName: config.tunnelName || null,
        tunnelHostname: config.tunnelHostname || null,
      },
      wsServer,
      startupDisplay,
      pairingManager,
      cleanupRefs: { mdnsService, bonjourInstance, tokenManager, sessionManager },
      logger: log,
    })
    const result = await tunnelHandler.createAndStart()
    tunnel = result.tunnel || tunnel
    if (!result.ok) {
      process.exitCode = 1
      return
    }

  } else if (externalUrl) {
    // Ready message already printed above
  } else if (!tunnelArg && !NO_AUTH) {
    // When bound to loopback the LAN IP is not reachable — advertise localhost.
    // When bound to a specific non-loopback interface, advertise that exact
    // address (getLanIp() returns the first NIC, which may not be the bound
    // one). Otherwise (default 0.0.0.0 bind) fall back to the discovered LAN IP.
    const host = isLoopbackHost(bindHost)
      ? 'localhost'
      : (bindHost && bindHost !== '0.0.0.0' ? bindHost : (getLanIp() || 'localhost'))
    // Bracket IPv6 literals so the URL authority is well-formed.
    const authority = `${formatHostForUrl(host)}:${PORT}`
    startupDisplay.currentWsUrl = `ws://${authority}`
    await startupDisplay.displayQr(`ws://${authority}`, `http://${authority}`, 'none')
  } else if (!NO_AUTH) {
    // tunnelArg is set but SKIP_TUNNEL is true due to externalUrl — already handled above
  } else {
    console.log(`[✓] Server ready! (CLI headless mode, no auth)\n`)
    console.log(`   Connect: ws://localhost:${PORT}`)
    console.log(`   Dashboard: http://localhost:${PORT}/dashboard`)
  }

  // #5368 slice (b): QR re-render on pairing auto-refresh + token rotation now
  // lives in StartupDisplay (it owns displayQr + the current-URL state the
  // listeners read). Wired here, after the mode branches set the initial URL.
  startupDisplay.wireReRenderListeners()

  // #5158: opt-in worktree auto-reaper. When enabled, reclaim orphaned
  // dead-pid-locked agent worktrees (clean trees only, never --force). Lazily
  // imported so a default (disabled) boot pays nothing and a failure here never
  // affects startup; the reaper itself yields between repos so the sweep
  // doesn't starve the loop.
  //
  // #5326 (WP-5.4): sweep once at boot AND on a recurring unref'd interval, so
  // a long-running daemon reclaims worktrees created mid-run without a restart.
  // The timer handle is assigned inside the async import .then(); if shutdown
  // races ahead of the import resolving, the clearInterval below is skipped —
  // tolerated because the interval is unref'd and process.exit reaps it anyway.
  let worktreeReapTimer = null
  if (config.worktreeGc?.autoReap === true) {
    import('./worktree-reaper.js')
      .then(({ startPeriodicAutoReap }) => { worktreeReapTimer = startPeriodicAutoReap(config, log) })
      .catch((err) => log.warn(`worktree auto-reaper failed: ${(err && err.message) || err}`))
  }

  // #5323 (WP-5.1) — sweep claude-tui hook-sink dirs left in /tmp by prior
  // crashed processes (a leak on every crash). Safe + unconditional: only dirs
  // whose owner pid is dead are removed, so a live daemon's dirs — including
  // ours — are kept. Fire-and-forget + lazily imported so a non-tui boot pays
  // nothing and a failure never affects startup.
  import('./claude-tui-session.js')
    .then(({ ClaudeTuiSession }) => ClaudeTuiSession.sweepStaleSinkDirs(log))
    .catch((err) => log.warn(`claude-tui sink-dir sweep failed: ${(err && err.message) || err}`))

  console.log('\nPress Ctrl+C to stop.\n')

  // Graceful shutdown.
  // Idempotent: a second SIGINT/SIGTERM (or a crash arriving mid-shutdown)
  // returns immediately. Without this, the second call ran serializeState()
  // against an already-empty `_sessions` Map and wrote 0 sessions to disk,
  // erasing the user's restored state across upgrade/quit cycles (#3697).
  // #5368 slice (d): the process lifecycle — the shuttingDown latch, the
  // graceful shutdown() teardown sequence, and the SIGINT/SIGTERM/SIGHUP/
  // uncaughtException/unhandledRejection registrations (#5369 onFatal +
  // emergencyCleanupSync) — lives in ServerOrchestrator. `worktreeReapTimer` is
  // passed as a GETTER because it's assigned inside an async import().then() and
  // may still be null now — the original shutdown closure read it lazily at
  // shutdown time, so the getter reproduces that. emergencyCleanupSync is
  // injected (server-cli-defined → avoids a circular import).
  const orchestrator = new ServerOrchestrator({
    wsServer,
    sessionManager,
    tunnel,
    mdnsService,
    bonjourInstance,
    tokenManager,
    pairingManager,
    pushManager,
    billingCanaryMonitor,
    modelsOverlayWatcher,
    getWorktreeReapTimer: () => worktreeReapTimer,
    emergencyCleanupSync,
    removeConnectionInfo,
    isPoolEnabled,
    getSharedPool,
    logger: log,
  })
  orchestrator.install()

  // Return references for supervised child drain protocol
  return { sessionManager, wsServer }
}
