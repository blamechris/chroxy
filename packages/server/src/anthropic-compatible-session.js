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
import { getRegistryForProvider } from './models.js'
import { refreshDiscoveredModels } from './model-discovery.js'
import { cachedResolveCredentialFile } from './auth-probes.js'
import { createLogger } from './logger.js'
import { BILLING_CLASSES } from './billing-class.js'

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
 * `resolveAuth` calls this once per configured entry on every dashboard
 * `list_providers` round-trip, so entries with a `credentialsKey` route the
 * credentials.json stat+read+parse through the shared
 * `cachedResolveCredentialFile` cache (#5461) — the same mtime+size+mode /
 * env-value invalidation contract the built-in byok/deepseek/discord slots
 * use, with one dynamic slot per (apiKeyEnv, credentialsKey) pair. Keying by
 * the resolver's actual inputs (rather than entry.id) means two entries that
 * share a credential spec share the cached result, and an id-less raw entry
 * can never poison a sibling's slot.
 *
 * @param {{ apiKeyEnv: string|null, credentialsKey: string|null }} entry
 * @returns {{ key: string, source: 'env' | 'file' } | { key: null, source: 'none', reason: string }}
 */
export function resolveAnthropicCompatibleApiKey(entry) {
  const { apiKeyEnv, credentialsKey } = entry
  if (!credentialsKey) {
    // Keyless placeholder or env-only entry — no credentials.json I/O to
    // cache; the uncached resolver never touches the file on these paths.
    return resolveAnthropicCompatibleApiKeyUncached(entry)
  }
  return cachedResolveCredentialFile(
    `compat:${apiKeyEnv || ''}:${credentialsKey}`,
    apiKeyEnv ? process.env[apiKeyEnv] : undefined,
    () => resolveAnthropicCompatibleApiKeyUncached(entry),
    apiKeyEnv || null,
  )
}

/**
 * The uncached resolver body — does the actual env lookup and (0600-enforced)
 * credentials.json read. Exercised through the cache wrapper above.
 *
 * @param {{ apiKeyEnv: string|null, credentialsKey: string|null }} entry
 * @returns {{ key: string, source: 'env' | 'file' } | { key: null, source: 'none', reason: string }}
 */
function resolveAnthropicCompatibleApiKeyUncached(entry) {
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
    modelDiscovery: (rawEntry.modelDiscovery
      && typeof rawEntry.modelDiscovery === 'object'
      && typeof rawEntry.modelDiscovery.url === 'string'
      && typeof rawEntry.modelDiscovery.format === 'string')
      ? Object.freeze({ url: rawEntry.modelDiscovery.url, format: rawEntry.modelDiscovery.format })
      : null,
  })

  const keyless = !entry.apiKeyEnv && !entry.credentialsKey
  const flatPricing = entry.pricing || ZERO_PRICING

  // Per-class mutable catalog state (#5548). Populated by model discovery
  // (refreshModels → applyCatalog) when `modelDiscovery` is configured;
  // otherwise stays null and every model-shaped static falls back to the
  // static `models`/defaultModel seed. Held in a closure shared by the class
  // statics — one catalog per registered provider id, exactly like the
  // module-scoped registry the registry hooks below resolve.
  //   - catalogIds: Set of discovered model ids (authoritative allowlist)
  //   - catalogMeta: Map id → { label, contextWindow }
  //   - catalogPricing: Map id → { input, output, cacheRead, cacheWrite }
  let catalogIds = null
  let catalogMeta = null
  let catalogPricing = null

  function applyCatalog(catalog) {
    const models = Array.isArray(catalog?.models) ? catalog.models : []
    if (models.length === 0) return
    const ids = new Set()
    const meta = new Map()
    for (const m of models) {
      if (typeof m?.id !== 'string' || m.id.length === 0) continue
      ids.add(m.id)
      meta.set(m.id, {
        label: typeof m.label === 'string' && m.label.length > 0 ? m.label : m.id,
        contextWindow: Number.isInteger(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : null,
      })
    }
    const pricingTable = catalog?.pricing && typeof catalog.pricing === 'object' ? catalog.pricing : {}
    const pricingMap = new Map()
    for (const id of Object.keys(pricingTable)) {
      const p = pricingTable[id]
      if (p && typeof p === 'object') {
        pricingMap.set(id, Object.freeze({ ...ZERO_PRICING, ...p }))
      }
    }
    catalogIds = ids
    catalogMeta = meta
    catalogPricing = pricingMap
  }

  // Picker seed: the allowlist when one is declared, otherwise just the
  // default model (the operator can type any id — unrestricted). Discovery,
  // once it runs, supersedes this in getFallbackModels via catalogMeta.
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
          billingClass: BILLING_CLASSES.API_KEY,
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
          billingClass: BILLING_CLASSES.API_KEY,
        }
      }
      return {
        ready: false,
        source: 'none',
        envVar: null,
        envVars,
        hint: credentialHint(entry),
        detail: `${entry.label} at ${entry.baseUrl} (${resolved.reason})`,
        // Config-driven endpoint billed against your own key — api-key,
        // era-independent.
        billingClass: BILLING_CLASSES.API_KEY,
      }
    }

    static getFallbackModels() {
      // Once a catalog has been discovered, seed the picker from it (hundreds
      // of models with labels + windows) instead of the static default-only
      // seed. Pre-discovery (cold boot) the static seed keeps the picker
      // useful until the first refresh resolves.
      if (catalogMeta && catalogMeta.size > 0) {
        return Object.freeze(
          [...catalogMeta.entries()].map(([id, m]) =>
            Object.freeze({ id, label: m.label, fullId: id, contextWindow: m.contextWindow })),
        )
      }
      return fallbackModels
    }

    /** The validated modelDiscovery seam for this class (null when absent). */
    static get modelDiscovery() {
      return entry.modelDiscovery
    }

    /**
     * Tri-state model validation source (settings-handlers, #2946/#5418):
     *   - discovered catalog present → the discovered ids are the
     *     authoritative allowlist (replaces PROVIDER_MODELS_UNRESTRICTED for
     *     this entry — the issue's tri-state interplay).
     *   - `models` declared (no/empty catalog) → the static array is the
     *     authoritative allowlist.
     *   - neither → null = unrestricted; any non-empty model id passes
     *     through verbatim and an unknown id surfaces as the endpoint's own
     *     error (the ollama rule).
     */
    static getAllowedModels() {
      if (catalogIds && catalogIds.size > 0) return [...catalogIds]
      return entry.models ? [...entry.models] : null
    }

    static getModelMetadata(modelId) {
      if (typeof modelId !== 'string' || modelId.length === 0) return null
      // Discovered catalog wins: it carries real labels + context windows.
      if (catalogMeta && catalogMeta.size > 0) {
        const hit = catalogMeta.get(modelId)
        if (hit) return { id: modelId, label: hit.label, fullId: modelId, contextWindow: hit.contextWindow }
        // Catalog present but this id isn't in it — unknown model. The picker
        // is now restricted to the catalog (getAllowedModels), so return null
        // the same way a declared-allowlist miss does.
        return null
      }
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

    /**
     * Dynamic model-catalog discovery hook (#5548) — ws-history's generic
     * `scheduleProviderModelsRefresh` calls this (fire-and-forget) whenever it
     * sends `available_models` for this provider, and pushes a refreshed list
     * if discovery changed the registry. No-op (resolves null) when the entry
     * declares no `modelDiscovery`. Never throws, never blocks validation.
     *
     * `deps` is a test seam (fetchFn / now / ttlMs / registry / apiKey).
     */
    static refreshModels(deps = {}) {
      if (!entry.modelDiscovery) return Promise.resolve(null)
      const apiKey = deps.apiKey !== undefined ? deps.apiKey : resolveDiscoveryApiKey(entry)
      return refreshDiscoveredModels({
        id: entry.id,
        url: entry.modelDiscovery.url,
        format: entry.modelDiscovery.format,
        apiKey,
        registry: deps.registry || getRegistryForProvider(entry.id),
        applyCatalog,
        ...deps,
      })
    }

    /** Test/introspection hook: the discovered per-model pricing snapshot. */
    static get discoveredPricing() {
      return catalogPricing
    }

    constructor(opts = {}) {
      // Force the registry name so the provider id on this session is
      // always the config entry's id — independent of whatever the
      // embedder passed (mirrors DeepSeekSession / OllamaSession).
      super({ ...opts, provider: entry.id })
    }

    /**
     * #5548: kick off catalog discovery on session start when the entry opts
     * in via `modelDiscovery` — the moment we know the user cares about this
     * endpoint, exactly like OllamaSession.start() probes /api/tags. Fire-and-
     * forget: discovery must never delay or fail session start (byok's start()
     * already emitted 'ready' by the time the probe resolves). On a changed
     * list, emit `models_updated` so the picker refreshes without a restart.
     */
    async start() {
      await super.start()
      if (!entry.modelDiscovery) return
      AnthropicCompatibleSession.refreshModels()
        .then((models) => {
          if (Array.isArray(models) && models.length > 0) {
            this.emit('models_updated', { models })
          }
        })
        .catch(() => {})
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

    /**
     * Per-model pricing (#5548). When discovery has populated a per-model
     * table, the model's discovered rates win so OpenRouter sessions report
     * real cost; otherwise fall back to the flat `pricing` block (or honest
     * all-zero for local endpoints). byok-session calls this with the active
     * model id, so cost reflects the specific model in use, not a single flat
     * rate across a catalog of hundreds.
     */
    _getPricing(model) {
      if (catalogPricing && typeof model === 'string') {
        const hit = catalogPricing.get(model)
        if (hit) return hit
      }
      return flatPricing
    }
  }

  return AnthropicCompatibleSession
}

/**
 * Resolve the API key to pass on the discovery probe (#5548). OpenRouter's
 * /api/v1/models needs no key, but passing the entry's key is harmless and
 * future-proofs gated aggregators. Returns null (no Authorization header) when
 * unresolved or for the keyless placeholder. Never logged.
 *
 * @param {object} entry - normalized config entry
 * @returns {string|null}
 */
function resolveDiscoveryApiKey(entry) {
  if (!entry.apiKeyEnv && !entry.credentialsKey) return null
  const resolved = resolveAnthropicCompatibleApiKey(entry)
  if (resolved.key && resolved.key !== COMPAT_PLACEHOLDER_API_KEY) return resolved.key
  return null
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
