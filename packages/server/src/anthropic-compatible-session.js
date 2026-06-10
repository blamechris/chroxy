/**
 * Config-driven Anthropic-compatible provider endpoints (#5419).
 *
 * Anything that speaks the Anthropic Messages API — Z.ai GLM, Moonshot
 * Kimi, MiniMax, LM Studio 0.4.1+, llama.cpp server, vLLM, OpenRouter,
 * any custom proxy — can be declared in config.json under
 * `providers.anthropicCompatible` and registered as a first-class
 * provider at startup, without writing a per-service session class.
 *
 * One generic factory, `createAnthropicCompatibleSessionClass(entry)`,
 * stamps out a ClaudeByokSession subclass per entry by parameterizing
 * the four seams (`_defaultModel`, `_resolveCredentials`, `_buildClient`,
 * `_getPricing`) plus the static-side metadata — exactly what
 * deepseek-session.js and ollama-session.js do by hand. Subclass, not
 * fork: every byok-session fix (history rollback, parallel tools,
 * MAX_TOOL_ROUNDS, MCP teardown) flows to every configured endpoint.
 *
 * Entry conventions (validated in anthropic-compatible-config.js):
 *   - `models` present  → static allowlist (`getAllowedModels()` returns
 *     the array; settings-handlers' tri-state takes the array path).
 *   - `models` absent   → unrestricted (`getAllowedModels()` returns null
 *     → PROVIDER_MODELS_UNRESTRICTED symbol path, the #5418 ollama rule).
 *   - `pricing` absent  → zero pricing (a real frozen all-zero entry, not
 *     null, so byok-session's "no pricing entry" warn never fires and
 *     cost is an honest $0 — the ollama convention for local endpoints).
 *   - `contextWindow` absent → null. Never fabricate a window: clients
 *     already handle a null/omitted window (#5444) by hiding the chip.
 *   - Neither `apiKeyEnv` nor `credentialsKey` → keyless local endpoint
 *     (LM Studio, llama.cpp, vLLM); the SDK refuses an empty apiKey so a
 *     placeholder is sent, same as ollama's dummy key.
 *
 * Credentials never touch config.json: `apiKeyEnv` names an env var,
 * `credentialsKey` names a field in ~/.chroxy/credentials.json (which
 * must be mode 0600 — same enforcement as deepseek-credentials.js). Env
 * wins over file. Keys are never logged; byok-session masks at the use
 * site.
 */

import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import Anthropic from '@anthropic-ai/sdk'
import { ClaudeByokSession } from './byok-session.js'
import { validateAnthropicCompatibleProviders } from './anthropic-compatible-config.js'
import { registerProvider, getRegisteredProviderNames } from './providers.js'
import { createLogger } from './logger.js'

const log = createLogger('anthropic-compatible')

// Sent when an entry configures no credential source (local endpoints):
// the wire requires an api key field but the server ignores it, and the
// Anthropic SDK refuses an empty apiKey — same story as ollama's dummy.
const COMPAT_PLACEHOLDER_API_KEY = 'anthropic-compatible'

// Zero-rate pricing for entries without a `pricing` block. A real
// (frozen) entry rather than null so byok-session's once-per-model "no
// pricing entry" warn never fires for an endpoint where missing pricing
// is the configuration, not a bug.
const ZERO_PRICING = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

// Lazy-resolved per call so tests that mutate process.env.HOME between
// cases pick up the new home (same rationale as deepseek-credentials.js).
function credentialsFilePath() {
  return join(homedir(), '.chroxy', 'credentials.json')
}

/**
 * Read one field out of ~/.chroxy/credentials.json with the same 0600
 * enforcement as byok-credentials.js / deepseek-credentials.js.
 *
 * @param {string} field - Field name (e.g. 'zaiApiKey')
 * @returns {{ key: string } | { key: null, reason: string }}
 */
function readCredentialsField(field) {
  const CREDENTIALS_FILE = credentialsFilePath()
  let stat
  try {
    stat = statSync(CREDENTIALS_FILE)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { key: null, reason: `${CREDENTIALS_FILE} does not exist` }
    }
    return { key: null, reason: `unable to stat ${CREDENTIALS_FILE}: ${err.message}` }
  }

  // Refuse anything more permissive than 0600 — same security boundary
  // as the BYOK/DeepSeek resolvers. A pasted-in credentials.json
  // defaulting to 0644 would leak the key to every local user.
  const perms = stat.mode & 0o777
  if (perms !== 0o600) {
    return {
      key: null,
      reason: `${CREDENTIALS_FILE} has mode ${perms.toString(8).padStart(3, '0')}; refusing to read (must be 0600 — run: chmod 600 ${CREDENTIALS_FILE})`,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'))
  } catch (err) {
    return { key: null, reason: `${CREDENTIALS_FILE} unreadable or not valid JSON: ${err.message}` }
  }

  if (typeof parsed?.[field] !== 'string' || parsed[field].length === 0) {
    return { key: null, reason: `${CREDENTIALS_FILE} missing or empty "${field}" field` }
  }

  return { key: parsed[field] }
}

/**
 * Resolve the API key for a config-driven Anthropic-compatible entry.
 *
 * Priority order:
 *   1. process.env[entry.apiKeyEnv]                (when apiKeyEnv is set)
 *   2. ~/.chroxy/credentials.json[entry.credentialsKey], file mode 0600
 *      (when credentialsKey is set)
 *   3. Neither source configured → the keyless placeholder (local endpoints)
 *
 * Never logged.
 *
 * @param {{ apiKeyEnv: string|null, credentialsKey: string|null }} entry
 * @returns {{ key: string, source: 'env' | 'file' } | { key: null, source: 'none', reason: string }}
 */
export function resolveAnthropicCompatibleApiKey(entry) {
  const { apiKeyEnv, credentialsKey } = entry

  if (!apiKeyEnv && !credentialsKey) {
    // Keyless local endpoint. 'env' keeps byok-session's key-source log
    // line truthful enough without growing a new source enum value —
    // mirrors ollama's dummy-key convention.
    return { key: COMPAT_PLACEHOLDER_API_KEY, source: 'env' }
  }

  if (apiKeyEnv) {
    const envKey = process.env[apiKeyEnv]
    if (typeof envKey === 'string' && envKey.length > 0) {
      return { key: envKey, source: 'env' }
    }
  }

  if (credentialsKey) {
    const fromFile = readCredentialsField(credentialsKey)
    if (fromFile.key) {
      return { key: fromFile.key, source: 'file' }
    }
    const envPart = apiKeyEnv ? `${apiKeyEnv} not set and ` : ''
    return { key: null, source: 'none', reason: `${envPart}${fromFile.reason}` }
  }

  return { key: null, source: 'none', reason: `${apiKeyEnv} not set` }
}

/**
 * Build the credential hint shown by preflight / resolveAuth for a
 * not-ready entry.
 */
function credentialHint(entry) {
  const parts = []
  if (entry.apiKeyEnv) parts.push(`set ${entry.apiKeyEnv}`)
  if (entry.credentialsKey) parts.push(`save it as "${entry.credentialsKey}" in ~/.chroxy/credentials.json (mode 0600)`)
  return parts.join(' or ')
}

/**
 * Create a ClaudeByokSession subclass for one validated config entry.
 *
 * The entry should be the NORMALIZED shape produced by
 * `validateAnthropicCompatibleProviders` (anthropic-compatible-config.js);
 * the factory still applies the same defaults defensively so tests and
 * embedders can pass a minimal raw entry.
 *
 * @param {object} rawEntry - Normalized config entry
 * @returns {typeof ClaudeByokSession} Provider session class for the registry
 */
export function createAnthropicCompatibleSessionClass(rawEntry) {
  if (typeof rawEntry !== 'object' || rawEntry === null || typeof rawEntry.id !== 'string' || rawEntry.id.length === 0) {
    throw new Error('createAnthropicCompatibleSessionClass requires an entry with a non-empty id')
  }
  if (typeof rawEntry.baseUrl !== 'string' || rawEntry.baseUrl.length === 0) {
    throw new Error(`anthropicCompatible entry '${rawEntry.id}' requires a baseUrl`)
  }
  if (typeof rawEntry.defaultModel !== 'string' || rawEntry.defaultModel.length === 0) {
    throw new Error(`anthropicCompatible entry '${rawEntry.id}' requires a defaultModel`)
  }

  // Defensive normalization (no-op for validator output).
  const entry = Object.freeze({
    id: rawEntry.id,
    label: typeof rawEntry.label === 'string' && rawEntry.label.length > 0 ? rawEntry.label : rawEntry.id,
    baseUrl: rawEntry.baseUrl,
    apiKeyEnv: typeof rawEntry.apiKeyEnv === 'string' && rawEntry.apiKeyEnv.length > 0 ? rawEntry.apiKeyEnv : null,
    credentialsKey: typeof rawEntry.credentialsKey === 'string' && rawEntry.credentialsKey.length > 0 ? rawEntry.credentialsKey : null,
    defaultModel: rawEntry.defaultModel,
    models: Array.isArray(rawEntry.models) && rawEntry.models.length > 0 ? Object.freeze([...rawEntry.models]) : null,
    pricing: rawEntry.pricing ? Object.freeze({ ...ZERO_PRICING, ...rawEntry.pricing }) : null,
    contextWindow: Number.isInteger(rawEntry.contextWindow) && rawEntry.contextWindow > 0 ? rawEntry.contextWindow : null,
  })

  const keyless = !entry.apiKeyEnv && !entry.credentialsKey
  const pricing = entry.pricing || ZERO_PRICING

  // Picker seed: the allowlist when one is declared, otherwise just the
  // default model (the operator can type any id — unrestricted).
  const fallbackModels = Object.freeze(
    (entry.models || [entry.defaultModel]).map((id) =>
      Object.freeze({ id, label: id, fullId: id, contextWindow: entry.contextWindow })),
  )

  class AnthropicCompatibleSession extends ClaudeByokSession {
    /** The validated config entry this class was built from (introspection/tests). */
    static get compatEntry() {
      return entry
    }

    static get displayLabel() {
      return entry.label
    }

    static get dataDir() {
      // No `~/.claude` dependency — pure HTTP(S) to the configured
      // endpoint. getProviderDataDirs() skips providers that return
      // null (#2965).
      return null
    }

    static get preflight() {
      return {
        label: entry.label,
        credentials: {
          // Empty envVars (keyless / credentials.json-only entries) →
          // the preflight credential gate is skipped (utils/preflight.js
          // requires envVars.length > 0); a missing file-sourced key
          // still surfaces through start()'s credentials-not-found path.
          envVars: entry.apiKeyEnv ? [entry.apiKeyEnv] : [],
          hint: keyless
            ? `no API key required — Anthropic-compatible endpoint at ${entry.baseUrl}`
            : credentialHint(entry),
          optional: keyless,
        },
      }
    }

    /**
     * Runtime auth state for the dashboard (#4769). Keyless entries are
     * always ready (local endpoints); keyed entries mirror the DeepSeek
     * flow — env var OR credentials.json, both surfacing as ready with a
     * `detail` that disambiguates the source. The key value itself never
     * appears in the result.
     *
     * @param {NodeJS.ProcessEnv} env
     * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string}}
     */
    static resolveAuth(env) {
      const envVars = entry.apiKeyEnv ? [entry.apiKeyEnv] : []
      if (keyless) {
        return {
          ready: true,
          source: 'env',
          envVar: null,
          envVars,
          hint: '',
          detail: `${entry.label} at ${entry.baseUrl} (no API key configured — config-driven Anthropic-compatible endpoint)`,
        }
      }
      const envKey = entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined
      const resolved = typeof envKey === 'string' && envKey.length > 0
        ? { key: envKey, source: 'env' }
        : resolveAnthropicCompatibleApiKey(entry)
      if (resolved.key && resolved.key !== COMPAT_PLACEHOLDER_API_KEY) {
        return {
          ready: true,
          source: 'env',
          envVar: resolved.source === 'env' ? entry.apiKeyEnv : null,
          envVars,
          hint: '',
          detail: `${entry.label} at ${entry.baseUrl} (${resolved.source === 'env' ? `${entry.apiKeyEnv} set` : '~/.chroxy/credentials.json'})`,
        }
      }
      return {
        ready: false,
        source: 'none',
        envVar: null,
        envVars,
        hint: credentialHint(entry),
        detail: `${entry.label} at ${entry.baseUrl} (${resolved.reason})`,
      }
    }

    static getFallbackModels() {
      return fallbackModels
    }

    /**
     * Tri-state model validation source (settings-handlers, #2946/#5418):
     *   - `models` declared → the array is the authoritative allowlist.
     *   - `models` absent   → null = unrestricted; any non-empty model id
     *     passes through verbatim and an unknown id surfaces as the
     *     endpoint's own error (the ollama rule).
     */
    static getAllowedModels() {
      return entry.models ? [...entry.models] : null
    }

    static getModelMetadata(modelId) {
      if (typeof modelId !== 'string' || modelId.length === 0) return null
      if (entry.models) {
        if (!entry.models.includes(modelId)) return null
        return { id: modelId, label: modelId, fullId: modelId, contextWindow: entry.contextWindow }
      }
      // Unrestricted endpoint: any non-empty id is valid metadata. The
      // explicit contextWindow key (possibly null) is load-bearing —
      // models.js preserves an explicit null instead of substituting
      // DEFAULT_CONTEXT_WINDOW, so the dashboard omits the chip rather
      // than showing a fabricated window (#5418 / #5444).
      return { id: modelId, label: modelId, fullId: modelId, contextWindow: entry.contextWindow }
    }

    constructor(opts = {}) {
      // Force the registry name so the provider id on this session is
      // always the config entry's id — independent of whatever the
      // embedder passed (mirrors DeepSeekSession / OllamaSession).
      super({ ...opts, provider: entry.id })
    }

    // --- Seam overrides (see byok-session.js for the contract) ---

    get _defaultModel() {
      return entry.defaultModel
    }

    _resolveCredentials() {
      return resolveAnthropicCompatibleApiKey(entry)
    }

    _buildClient(apiKey) {
      return new Anthropic({
        apiKey,
        baseURL: entry.baseUrl,
      })
    }

    _getPricing() {
      return pricing
    }
  }

  return AnthropicCompatibleSession
}

/**
 * Register every valid `providers.anthropicCompatible` entry from the
 * merged config as a first-class provider (#5419). Called once at server
 * startup (server-cli.js), before the default-provider resolution so
 * `--provider <id>` can select a config-driven endpoint.
 *
 * Invalid entries are logged and skipped; valid siblings still register.
 * Collisions are checked against both the static RESERVED_PROVIDER_IDS
 * and the LIVE registry at call time.
 *
 * @param {object | null | undefined} config - Merged server config
 * @returns {string[]} The provider ids that were registered
 */
export function registerAnthropicCompatibleProviders(config) {
  const block = config?.providers
  // Legacy form: `providers` as an array of provider-id strings
  // (informational, written by `chroxy init`) — nothing to register.
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return []
  if (!Object.prototype.hasOwnProperty.call(block, 'anthropicCompatible')) return []

  const { entries, warnings } = validateAnthropicCompatibleProviders(block.anthropicCompatible, {
    reservedIds: getRegisteredProviderNames(),
  })
  for (const warning of warnings) {
    log.warn(warning)
  }

  const registered = []
  for (const entry of entries) {
    registerProvider(entry.id, createAnthropicCompatibleSessionClass(entry))
    registered.push(entry.id)
    log.info(
      `Anthropic-compatible provider registered: ${entry.id} → ${entry.baseUrl} (default model: ${entry.defaultModel}, models: ${entry.models ? entry.models.join(', ') : 'unrestricted'}, key: ${entry.apiKeyEnv || entry.credentialsKey || 'none'})`,
    )
  }
  return registered
}
