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
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { CliSession } from './cli-session.js'
import { SdkSession } from './sdk-session.js'
import { ClaudeTuiSession } from './claude-tui-session.js'
import { ClaudeByokSession } from './byok-session.js'
import { DeepSeekSession } from './deepseek-session.js'
import { GeminiSession } from './gemini-session.js'
import { CodexSession } from './codex-session.js'
import { registerProviderRegistry } from './models.js'
import { resolveAnthropicApiKey } from './byok-credentials.js'
import { resolveDeepSeekApiKey } from './deepseek-credentials.js'

const PROVIDERS = {
  'claude-cli': CliSession,
  'claude-sdk': SdkSession,
  'claude-tui': ClaudeTuiSession,
  'claude-byok': ClaudeByokSession,
  'deepseek': DeepSeekSession,
  'gemini': GeminiSession,
  'codex': CodexSession,
}

// Names hidden from listProviders() (backward-compat aliases, etc.)
const HIDDEN = new Set()

// Seed per-provider registries for built-in providers so models.js can
// resolve provider-scoped model metadata without waiting for registerProvider.
for (const [name, ProviderClass] of Object.entries(PROVIDERS)) {
  registerProviderRegistry(name, ProviderClass)
}

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
 * Get a registered provider class by name.
 * @param {string} name - Provider identifier
 * @returns {Function} Provider class
 * @throws {Error} If provider is not registered
 */
export function getProvider(name) {
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
 * @param {string | undefined | null} name - Provider identifier
 * @returns {string} Human-readable label
 */
export function resolveProviderLabel(name) {
  if (!name || typeof name !== 'string') return 'unknown'
  const ProviderClass = PROVIDERS[name]
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
  for (const [name, ProviderClass] of Object.entries(PROVIDERS)) {
    if (HIDDEN.has(name)) continue
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
 * Resolve the auth/billing state for a single provider.
 *
 * The Claude CLI provider (and its docker-cli variant) explicitly strips
 * `ANTHROPIC_API_KEY` before spawning the binary — see spawn-env.js's
 * `claude` denylist — so it always bills the claude.ai subscription
 * regardless of whether the env var is present. Other providers route to
 * whichever credential they find first.
 *
 * Returns:
 *   ready    : boolean — false only when required creds are missing
 *   source   : 'env' | 'oauth' | 'none'
 *   envVar   : matched env var name (null when source !== 'env')
 *   envVars  : env var candidates checked
 *   hint     : human-readable fix hint
 *   detail   : human-readable summary including billing identity
 *
 * @param {string} name
 * @param {Function} ProviderClass
 */
function getProviderAuthInfo(name, ProviderClass) {
  const spec = ProviderClass.preflight
  const credSpec = spec?.credentials
  const envVars = (credSpec && Array.isArray(credSpec.envVars)) ? credSpec.envVars : []
  const optional = !!credSpec?.optional
  const hint = credSpec?.hint || (envVars.length ? `set ${envVars.join(' or ')}` : '')

  // Providers that opt out of preflight credentials checking (custom/external
  // providers, or any class that doesn't declare a `credentials` block) have
  // no env-var requirement we can verify — treat as ready so the UI doesn't
  // disable a working provider just because it skipped declaring preflight.
  if (!credSpec) {
    return {
      ready: true,
      source: 'none',
      envVar: null,
      envVars: [],
      hint: '',
      detail: 'No credential check declared by this provider',
    }
  }

  // Bare claude-cli on the host always bills subscription: spawn-env.js's
  // `claude` denylist strips ANTHROPIC_API_KEY before the subprocess starts,
  // and the CLI auths via the host's ~/.claude OAuth state.
  // claude-tui follows the same pattern — it explicitly deletes
  // ANTHROPIC_API_KEY from the spawn env and routes via OAuth/Keychain so
  // the round-trip bills as a subscription. The OAuth-creds probe doesn't
  // see Keychain credentials, so we mark these providers ready up-front.
  // Note: docker-cli is NOT in this set — see container-provider handling below.
  const isHostClaudeCli = name === 'claude-cli' || name === 'claude-tui'

  // Container providers (docker-cli / docker-sdk) explicitly forward
  // process.env.ANTHROPIC_API_KEY to the container at `docker run` time
  // (see docker-session.js _startContainer + docker-sdk-session.js _startContainer).
  // Inside the container there is no ~/.claude OAuth state, so the env var
  // is the only auth path — no OAuth fallback even though the host-side
  // preflight marks credentials as optional.
  const isContainerProvider = name === 'docker-cli' || name === 'docker-sdk'

  if (isHostClaudeCli) {
    const detail = name === 'claude-tui'
      ? 'Claude subscription (interactive TUI under PTY — bypasses programmatic credit metering)'
      : 'Claude subscription (CLI strips ANTHROPIC_API_KEY before spawn)'
    return {
      ready: true,
      source: 'oauth',
      envVar: null,
      envVars,
      hint: 'run `claude login` if not yet authed',
      detail,
    }
  }

  // BYOK provider checks env var AND the ~/.chroxy/credentials.json file
  // fallback (mode 0600 enforced). Both paths are semantically "API key
  // auth" from the dashboard's perspective — the SettingsPanel legend
  // only knows about 'oauth' | 'env' | 'missing' | 'none' tones (see
  // SettingsPanel.tsx:316-320), so we return 'env' for both env-var and
  // file paths. The `detail` string carries the diagnostic of *which*
  // file/var supplied the key.
  if (name === 'claude-byok') {
    const resolved = _cachedResolveCredentialFile(
      'byok',
      process.env.ANTHROPIC_API_KEY,
      resolveAnthropicApiKey,
    )
    if (resolved.key) {
      return {
        ready: true,
        source: 'env',
        envVar: resolved.source === 'env' ? 'ANTHROPIC_API_KEY' : null,
        envVars,
        hint: '',
        detail: `Anthropic API (${resolved.source === 'env' ? 'ANTHROPIC_API_KEY set' : '~/.chroxy/credentials.json'} — per-token billing)`,
      }
    }
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint,
      detail: `Anthropic API (${resolved.reason})`,
    }
  }

  // DeepSeek mirrors the BYOK branch (#4656): env-var OR
  // ~/.chroxy/credentials.json `deepseekApiKey` field. Both surface as
  // source: 'env' so SettingsPanel's tone legend maps cleanly; the
  // `detail` string disambiguates which path supplied the key. Without
  // this dedicated branch the generic env-var match below would return
  // ready:false whenever the user stored the key in credentials.json
  // rather than exporting DEEPSEEK_API_KEY.
  if (name === 'deepseek') {
    const resolved = _cachedResolveCredentialFile(
      'deepseek',
      process.env.DEEPSEEK_API_KEY,
      resolveDeepSeekApiKey,
    )
    if (resolved.key) {
      return {
        ready: true,
        source: 'env',
        envVar: resolved.source === 'env' ? 'DEEPSEEK_API_KEY' : null,
        envVars,
        hint: '',
        detail: `DeepSeek API (${resolved.source === 'env' ? 'DEEPSEEK_API_KEY set' : '~/.chroxy/credentials.json'} — per-token billing)`,
      }
    }
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint,
      detail: `DeepSeek API (${resolved.reason})`,
    }
  }

  // Look for any matching env var.
  const matched = envVars.find(v => process.env[v])

  if (matched) {
    return {
      ready: true,
      source: 'env',
      envVar: matched,
      envVars,
      hint: '',
      detail: `${describeBillingIdentity(name, matched)} (${matched} set)`,
    }
  }

  // Container providers can't reach host OAuth state — required-only.
  if (isContainerProvider) {
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint: hint || 'set ANTHROPIC_API_KEY (forwarded to the container at run time)',
      detail: 'Not configured — container providers need ANTHROPIC_API_KEY on the host (no OAuth fallback inside the container)',
    }
  }

  // #4301: Codex and Gemini CLIs authenticate via their own `login` flows
  // and cache OAuth tokens under `~/.codex/auth.json` / `~/.gemini/...`.
  // The Codex CLI also runs fine when `OPENAI_API_KEY` is null in that file
  // because the `tokens` block carries the access/refresh tokens. The
  // env-var-only preflight misreported these providers as "credentials
  // missing" whenever users authed via the CLI instead of exporting a key.
  if (name === 'codex' && _hasCodexOAuthCreds()) {
    return {
      ready: true,
      source: 'oauth',
      envVar: null,
      envVars,
      hint,
      detail: `${describeBillingIdentity(name, null)} (OAuth from \`codex login\`)`,
    }
  }
  if (name === 'gemini' && _hasGeminiOAuthCreds()) {
    return {
      ready: true,
      source: 'oauth',
      envVar: null,
      envVars,
      hint,
      detail: `${describeBillingIdentity(name, null)} (OAuth from \`gemini login\`)`,
    }
  }

  // No env var matched — optional creds (host claude-sdk) can fall back to
  // an OAuth subscription cached on disk by `claude login`. Earlier code
  // optimistically reported ready=true here, but #3674 caught that this
  // misleads users who never ran `claude login`: their session creation
  // would fail at runtime while the UI showed the chip enabled. We now
  // best-effort probe the on-disk auth state and only claim ready when at
  // least one known credential file is present.
  if (optional) {
    if (_hasClaudeOAuthCreds()) {
      return {
        ready: true,
        source: 'oauth',
        envVar: null,
        envVars,
        hint,
        detail: `${describeBillingIdentity(name, null)} (OAuth from \`claude login\`)`,
      }
    }
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint: hint || 'run `claude login` or set ANTHROPIC_API_KEY',
      detail: `Not configured — ${hint || 'run \`claude login\` or set ANTHROPIC_API_KEY'}`,
    }
  }

  // Required creds missing — provider can't run.
  // #4301: codex/gemini also support an OAuth login flow, so the hint should
  // mention both paths so the user doesn't think the env var is the only fix.
  let resolvedHint = hint
  if (name === 'codex') {
    resolvedHint = hint
      ? `${hint} or run \`codex login\``
      : 'run `codex login` or set OPENAI_API_KEY'
  } else if (name === 'gemini') {
    resolvedHint = hint
      ? `${hint} or run \`gemini login\``
      : 'run `gemini login` or set GEMINI_API_KEY'
  }
  return {
    ready: false,
    source: 'none',
    envVar: null,
    envVars,
    hint: resolvedHint,
    detail: envVars.length
      ? `Not configured — ${resolvedHint}`
      : 'Not configured',
  }
}

/**
 * Best-effort probe for `claude login` OAuth state on disk (#3674).
 *
 * Different versions of the Claude Agent SDK and Claude Code CLI cache
 * subscription credentials in different files; we cover the three known
 * locations and return true if any of them looks plausibly populated:
 *
 *   1. `~/.claude/auth.json`            — current SDK auth file
 *   2. `~/.claude/.credentials.json`    — older Claude Code CLI keystore
 *   3. `~/.claude.json`                 — global config; contains a
 *                                          `claudeAiOauth` block when the
 *                                          user has logged in via subscription
 *
 * The check is deliberately conservative: file presence (or the presence
 * of the OAuth key inside `~/.claude.json`) is enough — we don't validate
 * tokens or expiry. False positives are possible if the files are stale,
 * but the alternative (false negatives) is what #3674 was filed to fix.
 *
 * Override paths for tests / atypical installs:
 *   - `CHROXY_CLAUDE_HOME`   — overrides the directory for the first two
 *                              file checks AND the default location of
 *                              `.claude.json` (one level up from this dir).
 *   - `CHROXY_CLAUDE_CONFIG` — overrides the global `.claude.json` path
 *                              directly. Wins over the `CHROXY_CLAUDE_HOME`-
 *                              derived default when both are set.
 *
 * @returns {boolean}
 */
function _probeClaudeOAuthCreds() {
  try {
    const claudeHome = process.env.CHROXY_CLAUDE_HOME || join(homedir(), '.claude')
    if (existsSync(join(claudeHome, 'auth.json'))) return true
    if (existsSync(join(claudeHome, '.credentials.json'))) return true
    // Global config file lives one level up; some installs only have this.
    const globalConfig = process.env.CHROXY_CLAUDE_CONFIG
      || (process.env.CHROXY_CLAUDE_HOME
            ? join(process.env.CHROXY_CLAUDE_HOME, '..', '.claude.json')
            : join(homedir(), '.claude.json'))
    if (existsSync(globalConfig)) {
      try {
        const parsed = JSON.parse(readFileSync(globalConfig, 'utf-8'))
        if (parsed && typeof parsed === 'object' && parsed.claudeAiOauth) {
          return true
        }
      } catch {
        // Malformed JSON — treat as absent.
      }
    }
  } catch {
    // Any unexpected fs error → behave as if no creds, so the UI surfaces
    // the missing-creds state instead of silently misreporting ready.
  }
  return false
}

/**
 * Best-effort probe for `codex login` OAuth state on disk (#4301).
 *
 * The Codex CLI caches its login tokens in `~/.codex/auth.json`. The file is
 * always present after a `codex login` run; what matters for "user is authed"
 * is the `tokens` block being populated. The Codex CLI itself works fine
 * even when the file's `OPENAI_API_KEY` field is `null` because the OAuth
 * tokens carry the credential round-trip.
 *
 * Override path for tests / atypical installs:
 *   - `CHROXY_CODEX_HOME` — overrides the directory used to locate auth.json
 *
 * @returns {boolean}
 */
function _probeCodexOAuthCreds() {
  try {
    const codexHome = process.env.CHROXY_CODEX_HOME || join(homedir(), '.codex')
    const authPath = join(codexHome, 'auth.json')
    if (!existsSync(authPath)) return false
    try {
      const parsed = JSON.parse(readFileSync(authPath, 'utf-8'))
      if (!parsed || typeof parsed !== 'object') return false
      // Either: populated `tokens` block (OAuth login), or a real string
      // OPENAI_API_KEY embedded in the file (CLI also accepts this).
      if (parsed.tokens && typeof parsed.tokens === 'object') {
        const t = parsed.tokens
        if (typeof t.access_token === 'string' && t.access_token.length > 0) return true
        if (typeof t.refresh_token === 'string' && t.refresh_token.length > 0) return true
        if (typeof t.id_token === 'string' && t.id_token.length > 0) return true
      }
      if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0) {
        return true
      }
    } catch {
      // Malformed JSON — treat as absent.
    }
  } catch {
    // Any unexpected fs error → behave as if no creds.
  }
  return false
}

/**
 * Best-effort probe for `gemini login` OAuth state on disk (#4301).
 *
 * The Gemini CLI caches OAuth state under `~/.gemini/`. The exact filename
 * has shifted between CLI versions; we cover the names observed in the
 * wild and treat presence of any of them as evidence of a completed login:
 *
 *   - `~/.gemini/oauth_creds.json`     — typical for `gemini login`
 *   - `~/.gemini/google_accounts.json` — older variant
 *
 * Override path for tests / atypical installs:
 *   - `CHROXY_GEMINI_HOME` — overrides the directory used for the lookups
 *
 * @returns {boolean}
 */
function _probeGeminiOAuthCreds() {
  try {
    const geminiHome = process.env.CHROXY_GEMINI_HOME || join(homedir(), '.gemini')
    if (existsSync(join(geminiHome, 'oauth_creds.json'))) return true
    if (existsSync(join(geminiHome, 'google_accounts.json'))) return true
  } catch {
    // Any unexpected fs error → behave as if no creds.
  }
  return false
}

/**
 * 5s TTL cache around the on-disk creds probes (#3678).
 *
 * `listProviders()` is called from `handleListProviders` on every dashboard
 * `list_providers` WS request and once per `auth_ok` from `ws-history.js`.
 * Each call performs several `existsSync` + optional small `readFileSync` +
 * `JSON.parse`. The cache is keyed on the override env vars so a test (or a
 * runtime tweak) that changes any of the `CHROXY_*_HOME` variables naturally
 * invalidates the previous result.
 *
 * Per-provider entries so a mutation under one provider's home doesn't blow
 * away the cached result for another (#4301 added codex + gemini).
 */
let _credsCache = {
  claude: { value: null, expiresAt: 0, key: null },
  codex: { value: null, expiresAt: 0, key: null },
  gemini: { value: null, expiresAt: 0, key: null },
}

function _cachedProbe(slot, key, probe) {
  const now = Date.now()
  const entry = _credsCache[slot]
  if (entry.key === key && entry.expiresAt > now) {
    return entry.value
  }
  const value = probe()
  _credsCache[slot] = { value, expiresAt: now + 5_000, key }
  return value
}

function _hasClaudeOAuthCreds() {
  const key = `${process.env.CHROXY_CLAUDE_HOME ?? ''}|${process.env.CHROXY_CLAUDE_CONFIG ?? ''}`
  return _cachedProbe('claude', key, _probeClaudeOAuthCreds)
}

function _hasCodexOAuthCreds() {
  const key = `${process.env.CHROXY_CODEX_HOME ?? ''}`
  return _cachedProbe('codex', key, _probeCodexOAuthCreds)
}

function _hasGeminiOAuthCreds() {
  const key = `${process.env.CHROXY_GEMINI_HOME ?? ''}`
  return _cachedProbe('gemini', key, _probeGeminiOAuthCreds)
}

/**
 * mtime+size keyed cache for the BYOK + DeepSeek credential file reads (#4658).
 *
 * Unlike the OAuth probes above — which use a 5s TTL because the underlying
 * `claude login` / `codex login` / `gemini login` state spans multiple files
 * and parse paths — the BYOK + DeepSeek resolvers read a single well-known
 * file (`~/.chroxy/credentials.json`) and the auth signal is just "is this
 * file present, mode-0600, and does it still contain the relevant field?".
 *
 * That lets us cache on `{mtimeMs, size}` instead of a clock-based TTL:
 *   - Same env var + file unchanged → reuse cached resolver result without
 *     re-reading + JSON.parsing the file
 *   - File mtime or size changed → re-read and refresh the cache
 *   - File deleted (stat fails) → drop the cache, let resolver re-derive
 *     the "missing" reason from scratch
 *
 * Caching is keyed per slot (`byok`, `deepseek`) so a write to credentials.json
 * for one provider doesn't blow away the other's cached result. The env-var
 * value is folded into the key so an env mutation (set/unset/change) naturally
 * invalidates — the resolvers short-circuit on a populated env var without
 * touching the file, so caching that path safely avoids the stat too.
 *
 * Lives in providers.js (not in *-credentials.js) intentionally — the rest of
 * the codebase calls `resolveAnthropicApiKey()` / `resolveDeepSeekApiKey()`
 * directly (byok-session.js / deepseek-session.js for the actual API call)
 * and those paths must NOT be cached: a session start happens once and needs
 * the live file. Only the dashboard-poll path through `listProviders()` is hot
 * enough to justify the cache.
 */
let _credFileCache = {
  byok: { envValue: null, path: null, mtimeMs: null, size: null, result: null },
  deepseek: { envValue: null, path: null, mtimeMs: null, size: null, result: null },
}

/**
 * Cache wrapper around a credential-file resolver. The resolver itself does
 * the file read; this helper short-circuits to the cached resolver result when
 * the env var is unchanged AND either (env-var path was taken last time) or
 * (the file's stat-mtime+size still matches what we cached).
 *
 * @param {'byok' | 'deepseek'} slot
 * @param {string | undefined} envValue - current value of the relevant env var
 * @param {() => object} resolve - the underlying *-credentials resolver
 * @returns {object} resolver result
 */
function _cachedResolveCredentialFile(slot, envValue, resolve) {
  const entry = _credFileCache[slot]
  const credPath = join(homedir(), '.chroxy', 'credentials.json')

  // Env var precedence: when it's set the resolver never touches the file, so
  // the cache hit just needs the env value to match.
  if (typeof envValue === 'string' && envValue.length > 0) {
    if (entry.envValue === envValue && entry.path === null && entry.result) {
      return entry.result
    }
    const result = resolve()
    _credFileCache[slot] = { envValue, path: null, mtimeMs: null, size: null, result }
    return result
  }

  // No env var → resolver consults the file. Stat first; if the file is gone
  // or the stat throws, drop any cached entry and let the resolver build the
  // "missing" reason. We don't cache the missing case under a stat key (there
  // is no stat to key on), but the env-var path above will still cache after
  // a subsequent env-var set.
  let stat
  try {
    stat = statSync(credPath)
  } catch {
    _credFileCache[slot] = { envValue: null, path: null, mtimeMs: null, size: null, result: null }
    return resolve()
  }

  // Cache key includes credPath so an HOME change invalidates even if the
  // new file coincidentally has the same mtime+size as the cached old one.
  if (
    entry.envValue === null
    && entry.path === credPath
    && entry.mtimeMs === stat.mtimeMs
    && entry.size === stat.size
    && entry.result
  ) {
    return entry.result
  }

  const result = resolve()
  _credFileCache[slot] = {
    envValue: null,
    path: credPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    result,
  }
  return result
}

/**
 * Test-only hook to drop the cached creds-probe results so suites that mutate
 * the override env vars (or write/delete files under any `CHROXY_*_HOME`
 * without changing the env-var values) start from a clean slate. Production
 * code should never call this — the natural env-var-keyed invalidation plus
 * the 5s TTL is what users see.
 */
export function _resetCredsCacheForTest() {
  _credsCache = {
    claude: { value: null, expiresAt: 0, key: null },
    codex: { value: null, expiresAt: 0, key: null },
    gemini: { value: null, expiresAt: 0, key: null },
  }
  _credFileCache = {
    byok: { envValue: null, path: null, mtimeMs: null, size: null, result: null },
    deepseek: { envValue: null, path: null, mtimeMs: null, size: null, result: null },
  }
}

function describeBillingIdentity(name, envVar) {
  // Claude SDK family + ANTHROPIC_API_KEY → API; else OAuth fallback → subscription.
  if (name === 'claude-sdk') {
    if (envVar === 'ANTHROPIC_API_KEY') return 'Anthropic API'
    if (envVar === 'CLAUDE_CODE_OAUTH_TOKEN') return 'Anthropic API (OAuth token)'
    return 'Claude subscription'
  }
  // Container providers always bill API (no in-container OAuth fallback).
  if (name === 'docker-cli' || name === 'docker-sdk') {
    if (envVar === 'ANTHROPIC_API_KEY') return 'Anthropic API (forwarded to container)'
    if (envVar === 'CLAUDE_CODE_OAUTH_TOKEN') return 'Anthropic API (OAuth token forwarded to container)'
    return 'Anthropic API (forwarded to container)'
  }
  if (name === 'codex') return 'OpenAI API'
  if (name === 'gemini') return 'Google API'
  if (name === 'deepseek') return 'DeepSeek API'
  return 'External provider'
}

/**
 * Register docker providers when environments are enabled.
 * Probes `docker info` to confirm Docker is available; skips silently if not.
 *
 * Registers:
 *   - 'docker-cli': DockerSession (CLI-based, extends CliSession)
 *   - 'docker-sdk': DockerSdkSession (SDK-based, extends SdkSession)
 *   - 'docker': backward-compatible alias for 'docker-cli'
 *
 * @param {object} config - Merged server config
 */
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

  // Backward compatibility: 'docker' maps to 'docker-cli' (hidden from listProviders)
  registerProvider('docker', DockerSession, { alias: true })

  log.info('Docker providers registered (docker-cli, docker-sdk)')
}
