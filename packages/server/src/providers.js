/**
 * Provider registry for session backends.
 *
 * Built-in providers are a plain object literal below. Docker providers are
 * registered lazily by registerDockerProvider() when environments are enabled
 * and the Docker daemon is reachable.
 *
 * To add a new first-class provider: import the session class and add it to
 * the PROVIDERS literal. To add one externally (rare), call registerProvider()
 * — but editing this file is preferred.
 *
 * Session classes must extend EventEmitter and expose start/destroy/sendMessage/
 * interrupt/setModel/setPermissionMode plus a static `capabilities` getter.
 * See sdk-session.js or cli-session.js for a worked example.
 */
import { CliSession } from './cli-session.js'
import { SdkSession } from './sdk-session.js'
import { ClaudeTuiSession } from './claude-tui-session.js'
import { ClaudeChannelSession } from './claude-channel-session.js'
import { ClaudeByokSession } from './byok-session.js'
import { DeepSeekSession } from './deepseek-session.js'
import { OllamaSession } from './ollama-session.js'
import { GeminiSession } from './gemini-session.js'
import { CodexSession } from './codex-session.js'
import { CodexAppServerSession } from './codex-app-server-session.js'
import { UserShellSession } from './user-shell-session.js'
import { registerProviderRegistry } from './models.js'
import { BILLING_CLASSES } from './billing-class.js'
import { DEFAULT_PROVIDER, USER_SHELL_PROVIDER } from '@chroxy/protocol'
import {
  hasClaudeOAuthCreds,
  hasCodexOAuthCreds,
  hasGeminiOAuthCreds,
  cachedResolveCredentialFile,
  resetCachesForTest,
} from './auth-probes.js'

// #6616 — values of CHROXY_CODEX_APPSERVER that opt the codex provider OUT of the
// (now-default) app-server path and back to the legacy `codex exec` path.
const CODEX_EXEC_OPT_OUT = new Set(['0', 'false', 'no', 'off'])

const PROVIDERS = {
  'claude-cli': CliSession,
  'claude-sdk': SdkSession,
  'claude-tui': ClaudeTuiSession,
  // #3953 — research-preview `claude --channels` MCP transport. Scaffold
  // only: ClaudeChannelSession.start() throws until the bridge lands in
  // #3954. Registered so the dashboard can list it + `chroxy doctor` runs
  // its preflight; gated as a preview option (never default — see
  // DEFAULT_PROVIDER below).
  'claude-channel': ClaudeChannelSession,
  'claude-byok': ClaudeByokSession,
  'deepseek': DeepSeekSession,
  // Local models via Ollama's Anthropic-compatible Messages API (v0.14+).
  // Rides the BYOK agent loop; no credentials, zero cost, models are
  // whatever the user has pulled locally. See ollama-session.js.
  'ollama': OllamaSession,
  'gemini': GeminiSession,
  'codex': CodexSession,
  // #6605/#6616 — codex via the app-server JSON-RPC protocol (persistent) instead
  // of one-shot `codex exec`. Hidden (not a user-selectable provider): it's the
  // swap target for the 'codex' key and is now the DEFAULT, selected in
  // getProvider() unless CHROXY_CODEX_APPSERVER opts out (=0). Registered here so
  // validateProviderClass runs its contract check at module load.
  'codex-appserver': CodexAppServerSession,
  // #5983 (epic #5982) — general-purpose user shell ($SHELL via node-pty).
  // Gated OFF by default (userShell.enabled, #5985a) and primary-token-only
  // on create + every terminal_* op (#5985b); excluded from mailbox injection
  // (#5984). PTY-only — no chat/turn semantics. Provider id single-sourced
  // from @chroxy/protocol (#5986) so server + clients can't drift.
  [USER_SHELL_PROVIDER]: UserShellSession,
}

// The default provider lives in @chroxy/protocol so the server, dashboard,
// and mobile app all agree on "which provider is the default?" from one
// source (#5823). Re-exported here so existing server call sites
// (server-cli.js, doctor.js, session-manager.js) keep importing it from the
// provider registry. Flipped to claude-tui ahead of the 2026-06-15 cutover
// (#5819) — see the protocol constant's doc for the billing rationale.
export { DEFAULT_PROVIDER, USER_SHELL_PROVIDER }

// Names hidden from listProviders() (backward-compat aliases, etc.)
// #5994: user-shell is NOT a chat provider — it's a terminal-only session
// created via a dedicated shell affordance (#5986/#5987), never the chat
// provider picker. Hiding it keeps it out of listProviders() so it can't be
// selected as a (fake-ready) chat backend. getProvider/create still resolve it.
const HIDDEN = new Set([USER_SHELL_PROVIDER, 'codex-appserver'])

/** Required methods every provider class prototype must expose. */
const REQUIRED_METHODS = ['sendMessage', 'interrupt', 'setModel', 'setPermissionMode', 'start', 'destroy']

/** Methods required when the provider handles permissions in-process. */
const IN_PROCESS_PERMISSION_METHODS = ['respondToPermission', 'respondToQuestion']

/**
 * Validates that a provider class implements the ProviderSession interface.
 * Checks the class prototype so no instance is created during registration.
 * When `ProviderClass.capabilities.inProcessPermissions` is true, also validates
 * that `respondToPermission` and `respondToQuestion` are present.
 * @param {Function} ProviderClass - Session class to validate
 * @param {string} name - Provider name for error messages
 * @throws {Error} If any required method is missing from the prototype
 */
export function validateProviderClass(ProviderClass, name) {
  if (typeof ProviderClass !== 'function' || !ProviderClass.prototype) {
    throw new Error(`Provider '${name}' must be a constructable class`)
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof ProviderClass.prototype[method] !== 'function') {
      throw new Error(`Provider '${name}' missing required method: ${method}`)
    }
  }
  if (ProviderClass.capabilities?.inProcessPermissions) {
    for (const method of IN_PROCESS_PERMISSION_METHODS) {
      if (typeof ProviderClass.prototype[method] !== 'function') {
        throw new Error(`Provider '${name}' has inProcessPermissions=true but is missing required method: ${method}`)
      }
    }
  }
}

// #5555: validate every built-in against the ProviderSession contract at
// registry construction, then seed its per-provider model registry. Before
// this, validateProviderClass only ran on the registerProvider() path
// (Docker / external / config-driven endpoints) — the 9 first-class providers
// in the PROVIDERS literal got NO interface check, so the documented contract
// didn't actually cover its main case. A built-in that drops a required method
// (or flips inProcessPermissions without the permission methods) now fails
// loudly at module load instead of throwing deep inside a live session.
for (const [name, ProviderClass] of Object.entries(PROVIDERS)) {
  validateProviderClass(ProviderClass, name)
  registerProviderRegistry(name, ProviderClass)
}

/**
 * Register a provider class by name.
 * @param {string} name - Provider identifier (e.g. 'claude-sdk')
 * @param {Function} ProviderClass - Session class with static capabilities getter
 * @param {{ alias?: boolean }} [opts] - Mark as alias to exclude from listProviders()
 */
export function registerProvider(name, ProviderClass, opts) {
  if (typeof name !== 'string' || !name) {
    throw new Error('Provider name must be a non-empty string')
  }
  if (typeof ProviderClass !== 'function') {
    throw new Error(`Provider "${name}" must be a class/constructor`)
  }
  validateProviderClass(ProviderClass, name)
  PROVIDERS[name] = ProviderClass
  if (opts?.alias) HIDDEN.add(name)
  // Expose the class to models.js so the per-provider model registry
  // (#2956) can source its fallback list and ID convention from the
  // provider itself instead of hard-coding Claude behaviour globally.
  registerProviderRegistry(name, ProviderClass)
}

/**
 * List the names currently in the registry — built-ins plus anything
 * registered since startup (docker providers, config-driven
 * Anthropic-compatible endpoints, embedder providers). Includes hidden
 * aliases: the caller (#5419 collision checking) needs the FULL claimed
 * namespace, not just what the dashboard lists.
 *
 * @returns {string[]} Registered provider names
 */
export function getRegisteredProviderNames() {
  return Object.keys(PROVIDERS)
}

/**
 * Get a registered provider class by name.
 * @param {string} name - Provider identifier
 * @returns {Function} Provider class
 * @throws {Error} If provider is not registered
 */
export function getProvider(name) {
  // #6616 — codex is driven through the app-server JSON-RPC protocol (persistent,
  // approval-capable) BY DEFAULT. It's a strict superset of one-shot `codex exec`:
  // approvals surfaced in Chroxy (#6611), permission-mode mapping (#6613),
  // intra-session conversation memory, and attachments incl. image vision (#6609)
  // — where exec rejects attachments and has no approval surface. Opt OUT to the
  // legacy exec path with CHROXY_CODEX_APPSERVER=0 (or false/no/off). Resolved
  // here (not in the load-validated PROVIDERS literal) because getProvider is the
  // single chokepoint SessionManager uses to both construct and preflight, so
  // this one branch covers every path.
  if (name === 'codex' && !CODEX_EXEC_OPT_OUT.has((process.env.CHROXY_CODEX_APPSERVER || '').trim().toLowerCase())) {
    return CodexAppServerSession
  }
  const ProviderClass = PROVIDERS[name]
  if (!ProviderClass) {
    const available = Object.keys(PROVIDERS).join(', ')
    throw new Error(`Unknown provider "${name}". Available: ${available}`)
  }
  return ProviderClass
}

/**
 * Resolve a human-readable label for a provider name (#2953).
 *
 * Reads the class's `static get displayLabel()` so each provider owns its own
 * display name. Falls back to the raw provider id for unknown providers so
 * the server still boots with a readable banner even if someone registers a
 * custom provider without a label, and returns `'unknown'` for empty input.
 *
 * #6676 — resolves through `getProvider(name)` (not the static `PROVIDERS[name]`),
 * so codex reports the label of its RUNTIME driver (app-server by default →
 * "OpenAI Codex (app-server)", exec on `CHROXY_CODEX_APPSERVER=0` → "OpenAI
 * Codex"), matching what a live session's `constructor.displayLabel` reports.
 * `getProvider` throws for an unknown name, so those fall back to the raw name.
 *
 * @param {string | undefined | null} name - Provider identifier
 * @returns {string} Human-readable label
 */
export function resolveProviderLabel(name) {
  if (!name || typeof name !== 'string') return 'unknown'
  let ProviderClass
  try {
    ProviderClass = getProvider(name)
  } catch {
    ProviderClass = PROVIDERS[name]
  }
  if (ProviderClass && typeof ProviderClass.displayLabel === 'string' && ProviderClass.displayLabel.length > 0) {
    return ProviderClass.displayLabel
  }
  return name
}

/**
 * Collect the unique data directories for all registered (non-hidden) providers
 * that expose a static `dataDir` getter (#2965).
 *
 * Consumers (conversation-scanner, ws-file-ops) call this instead of hardcoding
 * ~/.claude so that every registered provider's data is included automatically.
 * Docker aliases are excluded (they share the same dataDir as their base) and
 * providers that do not define dataDir are skipped silently.
 *
 * @returns {string[]} Deduplicated list of absolute data directory paths.
 */
export function getProviderDataDirs() {
  const seen = new Set()
  const dirs = []
  for (const [name, ProviderClass] of Object.entries(PROVIDERS)) {
    if (HIDDEN.has(name)) continue
    const dir = ProviderClass.dataDir
    if (typeof dir !== 'string' || dir.length === 0) continue
    if (seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs
}

/**
 * List all registered providers with their capabilities.
 * Excludes aliases (e.g. 'docker') to prevent duplicate entries in UI.
 *
 * `sessionRules` capability is derived from method existence: a provider
 * supports session-scoped rules iff its prototype has `setPermissionRules`.
 * Clients use this to gate the "Allow for Session" UI affordance (#3072).
 *
 * `auth` (#3404 audit F1+F5) summarises whether the provider can actually run
 * sessions right now and which billing identity is on the hook. Lets the
 * dashboard grey-out unusable providers and surface a billing-confidence
 * panel without making the user shell out and run `chroxy doctor`.
 *
 * @returns {Array<{ name: string, capabilities: object, auth: object }>}
 */
export function listProviders() {
  const list = []
  for (const name of Object.keys(PROVIDERS)) {
    if (HIDDEN.has(name)) continue
    // #6618 — resolve to the class that will ACTUALLY be instantiated for this
    // provider id. getProvider honors CHROXY_CODEX_APPSERVER for codex (app-server
    // by default, exec on opt-out), so the picker's advertised capabilities match
    // what a live session reports in session_info. For every other provider
    // getProvider is just PROVIDERS[name], so this is a no-op. codex's app-server
    // class delegates dataDir/resolveAuth/preflight to the exec class, so `auth` is
    // unchanged — only the capability shape follows the runtime driver.
    const ProviderClass = getProvider(name)
    list.push({
      name,
      capabilities: {
        ...(ProviderClass.capabilities || {}),
        sessionRules: typeof ProviderClass.prototype.setPermissionRules === 'function',
      },
      auth: getProviderAuthInfo(name, ProviderClass),
    })
  }
  return list
}

/**
 * Helpers passed to each provider's `static resolveAuth(env, helpers)` call.
 * Bundles the shared OAuth probes and credential-file resolver cache so the
 * provider doesn't have to import them directly — keeps the contract small
 * and the surface easy to mock in tests (#4769).
 */
const AUTH_HELPERS = Object.freeze({
  hasClaudeOAuthCreds,
  hasCodexOAuthCreds,
  hasGeminiOAuthCreds,
  cachedResolveCredentialFile,
})

/**
 * Generic fallback auth resolver for providers that don't declare their own
 * `static resolveAuth`. Returns the same shape — `{ ready, source, envVar,
 * envVars, hint, detail }` — using only the preflight credentials spec.
 *
 * Behaviour matches what the pre-#4769 dispatcher did when none of the
 * provider-specific branches fired:
 *   - No `credentials` block in preflight → ready (opt-out for custom providers)
 *   - An env var is set → source: 'env'
 *   - `optional: true` with no env var → not-ready with the spec hint
 *   - Required env var missing → not-ready with the spec hint
 *
 * Provider-specific behaviour (OAuth probes, file resolvers, container
 * overrides) lives on the provider classes — see `ProviderClass.resolveAuth`.
 */
function genericResolveAuth(ProviderClass, env) {
  const spec = ProviderClass.preflight
  const credSpec = spec?.credentials
  if (!credSpec) {
    return {
      ready: true,
      source: 'none',
      envVar: null,
      envVars: [],
      hint: '',
      detail: 'No credential check declared by this provider',
      // Custom/external providers default to per-token api-key billing — they
      // never draw on Claude's subscription/credit pool (#5630).
      billingClass: BILLING_CLASSES.API_KEY,
    }
  }
  const envVars = Array.isArray(credSpec.envVars) ? credSpec.envVars : []
  const hint = credSpec.hint || (envVars.length ? `set ${envVars.join(' or ')}` : '')
  const matched = envVars.find(v => env[v])
  if (matched) {
    return {
      ready: true,
      source: 'env',
      envVar: matched,
      envVars,
      hint: '',
      detail: `External provider (${matched} set)`,
      billingClass: BILLING_CLASSES.API_KEY,
    }
  }
  return {
    ready: false,
    source: 'none',
    envVar: null,
    envVars,
    hint,
    detail: envVars.length ? `Not configured — ${hint}` : 'Not configured',
    billingClass: BILLING_CLASSES.API_KEY,
  }
}

/**
 * Resolve the auth/billing state for a single provider (#4769 dispatcher).
 *
 * Each provider class owns its own `static resolveAuth(env, helpers)` method
 * — see e.g. CliSession, SdkSession, CodexSession. This dispatcher is now
 * just a thin shim that hands the active env + shared helpers to the
 * provider, with a generic fallback for custom/external providers that
 * haven't (yet) declared `resolveAuth`.
 *
 * Returns:
 *   ready    : boolean — false only when required creds are missing
 *   source   : 'env' | 'oauth' | 'none'
 *   envVar   : matched env var name (null when source !== 'env')
 *   envVars  : env var candidates checked
 *   hint     : human-readable fix hint
 *   detail   : human-readable summary including billing identity
 *
 * @param {string} _name - Provider id (unused — kept for caller back-compat)
 * @param {Function} ProviderClass
 */
export function getProviderAuthInfo(_name, ProviderClass) {
  if (typeof ProviderClass.resolveAuth === 'function') {
    return ProviderClass.resolveAuth(process.env, AUTH_HELPERS)
  }
  return genericResolveAuth(ProviderClass, process.env)
}

/**
 * Test-only hook (back-compat re-export from #4769 extraction): drop the
 * cached creds-probe results so suites that mutate the `CHROXY_*_HOME`
 * overrides or write/delete files under them start from a clean slate.
 * Now delegates to `auth-probes.js#resetCachesForTest()`. Production code
 * should never call this.
 */
export function _resetCredsCacheForTest() {
  resetCachesForTest()
}

/**
 * Register docker providers when environments are enabled.
 * Probes `docker info` to confirm Docker is available; skips silently if not.
 *
 * Registers:
 *   - 'docker-cli': DockerSession (CLI-based, extends CliSession)
 *   - 'docker-sdk': DockerSdkSession (SDK-based, extends SdkSession)
 *   - 'docker-byok': DockerByokSession (#4053, Claude BYOK loop on the host)
 *   - 'docker': backward-compatible alias for 'docker-cli'
 *
 * @param {object} config - Merged server config
 */
// #5448: every docker provider id registered below. store-core's
// CLAUDE_BACKED_DOCKER_IDS allowlist assumes ALL of these run Claude sessions
// (so a missing model contextWindow resolves to the Claude 200k default). That
// is true today — each maps to a Claude wrapper (DockerSession/DockerSdkSession
// extend the Claude CLI/SDK sessions; DockerByokSession runs the Claude BYOK
// loop). If you register a NON-Claude provider under a `docker-*` name, you MUST
// add it here AND decide its context-window story in store-core — otherwise the
// providers test (every DOCKER_PROVIDER_ID must be Claude-backed) trips, instead
// of the session silently regressing to a fabricated "% of 200k" meter.
export const DOCKER_PROVIDER_IDS = ['docker-cli', 'docker-sdk', 'docker-byok', 'docker']

export async function registerDockerProvider(config) {
  if (!config?.environments?.enabled) return

  const { createLogger } = await import('./logger.js')
  const log = createLogger('providers')

  const { execFileSync } = await import('child_process')
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
  } catch {
    log.warn('Docker not available — docker providers disabled')
    return
  }

  const { DockerSession } = await import('./docker-session.js')
  registerProvider('docker-cli', DockerSession)

  const { DockerSdkSession } = await import('./docker-sdk-session.js')
  registerProvider('docker-sdk', DockerSdkSession)

  // #4053: docker-byok — runs the BYOK agent loop on the host, tool
  // execution inside the container. Same gating story as the other
  // docker-* providers: only registered when environments are enabled
  // AND `docker info` succeeded above. The provider's own start()
  // does a second `docker info` preflight per session because the
  // daemon can go down between server boot and session create.
  const { DockerByokSession } = await import('./docker-byok-session.js')
  registerProvider('docker-byok', DockerByokSession)

  // Backward compatibility: 'docker' maps to 'docker-cli' (hidden from listProviders)
  registerProvider('docker', DockerSession, { alias: true })

  log.info(`Docker providers registered (${DOCKER_PROVIDER_IDS.filter((id) => id !== 'docker').join(', ')})`)
}
