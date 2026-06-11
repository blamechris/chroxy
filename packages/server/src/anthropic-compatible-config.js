/**
 * Config-driven Anthropic-compatible provider endpoints (#5419) —
 * validation + normalization for the `providers.anthropicCompatible`
 * config block.
 *
 * Many services and local servers now expose Anthropic-compatible
 * `/v1/messages` endpoints (Z.ai GLM, Moonshot Kimi, MiniMax, LM Studio
 * 0.4.1+, llama.cpp server, vLLM, OpenRouter, …). Each one would
 * otherwise need its own four-seam ClaudeByokSession subclass (the
 * deepseek-session.js / ollama-session.js pattern); this block lets an
 * operator declare them in config.json instead. Entries are validated
 * here and registered at startup by `registerAnthropicCompatibleProviders`
 * (anthropic-compatible-session.js).
 *
 * Entry shape:
 *   {
 *     "id": "zai-glm",                      // required — provider id (lowercase, digits, dashes)
 *     "label": "Z.ai GLM",                  // optional — dashboard label (defaults to id)
 *     "baseUrl": "https://api.z.ai/api/anthropic",  // required — http(s) endpoint base URL
 *     "apiKeyEnv": "ZAI_API_KEY",           // optional — env var NAME holding the key
 *     "credentialsKey": "zaiApiKey",        // optional — field NAME in ~/.chroxy/credentials.json (0600)
 *     "defaultModel": "glm-4.7",            // required — model used when none is selected
 *     "models": ["glm-4.7", "glm-4.7-air"], // optional — allowlist; absent = unrestricted (#5418 tri-state)
 *     "pricing": { "input": 0.6, "output": 2.2, "cacheRead": 0.11, "cacheWrite": 0 },
 *                                           // optional — USD per MTok; absent = zero pricing (local endpoints)
 *     "contextWindow": 200000,              // optional — tokens; absent = null (never fabricate, #5444)
 *     "modelDiscovery": { "url": "https://openrouter.ai/api/v1/models", "format": "openrouter" }
 *                                           // optional — live model catalog + per-model pricing autofill (#5548).
 *                                           //   format 'openrouter' (GET /api/v1/models, OpenAI-ish list with pricing)
 *                                           //   or 'openai' (bare /v1/models, ids only). A discovered catalog feeds
 *                                           //   the picker AND replaces the static `models` allowlist for tri-state
 *                                           //   validation (#5418); per-model pricing overrides the flat `pricing`.
 *   }
 *
 * Security boundary: config.json is NOT permission-restricted and gets
 * echoed in verbose output, so secrets must never appear in it.
 * `apiKeyEnv` / `credentialsKey` carry the NAME of an env var / a
 * credentials.json field, never the key itself — values that look like a
 * secret are rejected with a pointed warning (same posture as the
 * `notifications.discord.webhookUrl` rejection in config.js).
 *
 * All warnings here use "Invalid value" wording (never the "Invalid type"
 * prefix) so a malformed entry can never escalate into a fatal startup
 * error via loadAndMergeConfig — bad entries are warned about and dropped
 * at registration; valid siblings still register.
 *
 * This module is deliberately dependency-free (no SDK, no logger) so
 * config.js can import it without pulling the BYOK machinery into the
 * config-load path — same rationale as the Rancher regex duplication
 * note in config.js.
 */

/**
 * Provider ids that config-driven entries may never claim: every
 * provider in the built-in PROVIDERS literal (providers.js) plus the
 * docker ids registered lazily by registerDockerProvider(). Kept as a
 * static list (rather than importing providers.js) so this module stays
 * light; the registration path additionally checks the LIVE registry via
 * `getRegisteredProviderNames()` to catch embedder-registered ids.
 */
export const RESERVED_PROVIDER_IDS = Object.freeze([
  'claude-cli',
  'claude-sdk',
  'claude-tui',
  'claude-channel',
  'claude-byok',
  'deepseek',
  'ollama',
  'gemini',
  'codex',
  'docker',
  'docker-cli',
  'docker-sdk',
  'docker-byok',
])

// Provider id charset: lowercase letter first, then lowercase letters,
// digits, or dashes; max 64 chars. Matches the conventions of the
// built-in ids ('claude-sdk', 'docker-byok') and keeps ids safe for use
// in WS messages, dashboard URLs, and log lines without escaping.
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/

// Env var NAME charset (POSIX-portable uppercase convention).
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/

// credentials.json field NAME charset (matches the existing camelCase
// fields: anthropicApiKey, deepseekApiKey, discordWebhookUrl).
const CREDENTIALS_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/

// Entry keys that would carry a literal secret. Their PRESENCE (any
// value) is rejected with a pointed warning steering the operator to the
// env-var / credentials.json paths — mirrors the
// notifications.discord.webhookUrl rejection in config.js.
const FORBIDDEN_SECRET_KEYS = Object.freeze(['apiKey', 'api_key', 'key', 'token', 'secret', 'bearerToken'])

// Keys an entry is allowed to carry. Anything else gets an
// "(will be ignored)" warning so typos (`model` vs `defaultModel`)
// surface at startup instead of silently doing nothing.
const KNOWN_ENTRY_KEYS = new Set([
  'id', 'label', 'baseUrl', 'apiKeyEnv', 'credentialsKey',
  'defaultModel', 'models', 'pricing', 'contextWindow', 'modelDiscovery',
])

const PRICING_RATE_KEYS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite'])

// Model-catalog discovery formats supported today (#5548). 'openrouter' is the
// validation target (GET /api/v1/models, OpenAI-ish list carrying per-token
// pricing); 'openai' covers a bare /v1/models id list (LM Studio, vLLM) — no
// pricing, just a picker feed. Keep this list the single source of truth so the
// fetch adapters in model-discovery.js and the validator can never disagree.
export const MODEL_DISCOVERY_FORMATS = Object.freeze(['openrouter', 'openai'])

const MODEL_DISCOVERY_KEYS = new Set(['url', 'format'])

/**
 * Heuristic: does this string look like a pasted secret VALUE rather
 * than an env-var / credentials-field NAME? Used only to sharpen the
 * warning message — anything that fails the NAME regexes is rejected
 * regardless; this decides whether the warning says "that looks like a
 * secret" or just "invalid name".
 *
 * @param {*} value
 * @returns {boolean}
 */
export function looksLikeInlineSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  // Common key prefixes: sk-ant-..., sk-..., pk-..., key-..., Bearer xxx,
  // eyJ... (JWT). Case-sensitive eyJ so an env var named EYJ_* doesn't trip.
  if (/^(sk|pk|key|token|secret)[-_]/i.test(value)) return true
  if (/^bearer\s/i.test(value)) return true
  if (value.startsWith('eyJ')) return true
  // Real names are short; long high-entropy strings are almost certainly values.
  if (value.length > 64) return true
  return false
}

function typeName(value) {
  return Array.isArray(value) ? 'array' : typeof value
}

/**
 * Validate ONE entry; returns the normalized frozen entry, or null when
 * the entry must be dropped. Pushes human-readable warnings either way.
 */
function validateEntry(raw, path, seenIds, reservedIds, warnings) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(`Invalid value for '${path}': expected an object, got ${typeName(raw)}`)
    return null
  }

  let valid = true

  // Inline secrets — rejected on key PRESENCE, before anything else, so
  // the operator gets the security steer even when the rest is malformed.
  for (const key of FORBIDDEN_SECRET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      warnings.push(
        `'${path}.${key}' is not supported: API keys are secrets and don't belong in config.json — name an env var via 'apiKeyEnv' or a ~/.chroxy/credentials.json field (mode 0600) via 'credentialsKey' instead`,
      )
      valid = false
    }
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_ENTRY_KEYS.has(key) && !FORBIDDEN_SECRET_KEYS.includes(key)) {
      warnings.push(`Unknown key '${path}.${key}' (will be ignored)`)
    }
  }

  // --- id ---
  const id = raw.id
  if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id)) {
    warnings.push(
      `Invalid value for '${path}.id': expected a lowercase identifier (letters, digits, dashes; must start with a letter, max 64 chars), got ${JSON.stringify(id)}`,
    )
    valid = false
  } else if (reservedIds.has(id)) {
    // `reservedIds` merges the static built-in list with whatever the
    // caller passed (at registration time: the LIVE registry, which can
    // include docker/embedder-registered ids) — name both possibilities.
    warnings.push(`Invalid value for '${path}.id': '${id}' collides with a built-in or already-registered provider id`)
    valid = false
  } else if (seenIds.has(id)) {
    warnings.push(`Invalid value for '${path}.id': duplicate id '${id}' (already declared by an earlier entry)`)
    valid = false
  }

  // --- label ---
  let label = typeof id === 'string' ? id : null
  if (Object.prototype.hasOwnProperty.call(raw, 'label')) {
    if (typeof raw.label !== 'string' || raw.label.length === 0) {
      warnings.push(`Invalid value for '${path}.label': expected a non-empty string, got ${JSON.stringify(raw.label)} — falling back to the id`)
    } else {
      label = raw.label
    }
  }

  // --- baseUrl ---
  const baseUrl = raw.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    warnings.push(`Invalid value for '${path}.baseUrl': required — the http(s) base URL of the Anthropic-compatible endpoint`)
    valid = false
  } else {
    let parsed = null
    try {
      parsed = new URL(baseUrl)
    } catch {
      // Don't echo the raw value: the user:pass@ rejection below only runs
      // when parsing SUCCEEDS, so an unparseable URL carrying embedded
      // credentials would otherwise leak them into the startup log.
      warnings.push(`Invalid URL format for '${path}.baseUrl': expected an http(s) URL (value not shown — fix it in config.json)`)
      valid = false
    }
    if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      warnings.push(`Invalid value for '${path}.baseUrl': must use http:// or https://, got '${parsed.protocol}'`)
      valid = false
    }
    if (parsed && (parsed.username || parsed.password)) {
      // userinfo in the URL is an inline secret by another name.
      warnings.push(
        `Invalid value for '${path}.baseUrl': embedded credentials (user:pass@) are not supported — secrets don't belong in config.json; use 'apiKeyEnv' or 'credentialsKey'`,
      )
      valid = false
    }
  }

  // --- apiKeyEnv ---
  let apiKeyEnv = null
  if (Object.prototype.hasOwnProperty.call(raw, 'apiKeyEnv')) {
    if (typeof raw.apiKeyEnv === 'string' && ENV_VAR_NAME_RE.test(raw.apiKeyEnv)) {
      apiKeyEnv = raw.apiKeyEnv
    } else if (looksLikeInlineSecret(raw.apiKeyEnv)) {
      warnings.push(
        `Invalid value for '${path}.apiKeyEnv': that looks like a secret VALUE — 'apiKeyEnv' must be the NAME of an environment variable (e.g. "ZAI_API_KEY"); never put API keys in config.json`,
      )
      valid = false
    } else {
      // Never echo the rejected value: real API keys without a recognized
      // prefix (e.g. AIza…-style or short vendor hex tokens) slip past the
      // looksLikeInlineSecret heuristic, and these warnings land in the
      // startup log twice (config validation + registration).
      warnings.push(
        `Invalid value for '${path}.apiKeyEnv': expected an environment variable NAME (uppercase letters, digits, underscores — e.g. "ZAI_API_KEY"); value not shown in case it is a secret`,
      )
      valid = false
    }
  }

  // --- credentialsKey ---
  let credentialsKey = null
  if (Object.prototype.hasOwnProperty.call(raw, 'credentialsKey')) {
    if (typeof raw.credentialsKey === 'string' && CREDENTIALS_KEY_RE.test(raw.credentialsKey) && !looksLikeInlineSecret(raw.credentialsKey)) {
      credentialsKey = raw.credentialsKey
    } else if (looksLikeInlineSecret(raw.credentialsKey)) {
      warnings.push(
        `Invalid value for '${path}.credentialsKey': that looks like a secret VALUE — 'credentialsKey' must be a field NAME in ~/.chroxy/credentials.json (e.g. "zaiApiKey"); never put API keys in config.json`,
      )
      valid = false
    } else {
      // Never echo the rejected value — same rationale as apiKeyEnv above.
      warnings.push(
        `Invalid value for '${path}.credentialsKey': expected a credentials.json field NAME (letters, digits, underscores — e.g. "zaiApiKey"); value not shown in case it is a secret`,
      )
      valid = false
    }
  }

  // --- defaultModel ---
  const defaultModel = raw.defaultModel
  if (typeof defaultModel !== 'string' || defaultModel.trim().length === 0) {
    warnings.push(`Invalid value for '${path}.defaultModel': required — a non-empty model id string`)
    valid = false
  }

  // --- models (tri-state source: array = allowlist, absent = unrestricted) ---
  let models = null
  if (Object.prototype.hasOwnProperty.call(raw, 'models')) {
    if (!Array.isArray(raw.models) || raw.models.length === 0) {
      warnings.push(`Invalid value for '${path}.models': expected a non-empty array of model id strings (omit the key entirely for an unrestricted endpoint)`)
      valid = false
    } else if (raw.models.some((m) => typeof m !== 'string' || m.trim().length === 0)) {
      warnings.push(`Invalid value for '${path}.models': every entry must be a non-empty model id string`)
      valid = false
    } else {
      models = raw.models.map((m) => m.trim())
      if (typeof defaultModel === 'string' && defaultModel.trim().length > 0 && !models.includes(defaultModel.trim())) {
        // Warn-only: the session still starts on defaultModel; only live
        // model SWITCHING is gated by the allowlist (settings-handlers).
        warnings.push(`'${path}.defaultModel' ('${defaultModel.trim()}') is not listed in '${path}.models' — model switching back to the default will be rejected`)
      }
    }
  }

  // --- pricing ---
  // Absent → zero pricing (the ollama convention: an honest $0, no
  // missing-pricing warn). A malformed value drops the ENTRY rather than
  // degrading to zero — silently reporting $0 for a paid endpoint is
  // worse than not registering it.
  let pricing = null
  if (Object.prototype.hasOwnProperty.call(raw, 'pricing')) {
    if (typeof raw.pricing !== 'object' || raw.pricing === null || Array.isArray(raw.pricing)) {
      warnings.push(`Invalid value for '${path}.pricing': expected an object with USD-per-MTok rates (${PRICING_RATE_KEYS.join(', ')}), got ${typeName(raw.pricing)}`)
      valid = false
    } else {
      const normalized = {}
      let pricingValid = true
      for (const key of Object.keys(raw.pricing)) {
        if (!PRICING_RATE_KEYS.includes(key)) {
          warnings.push(`Unknown key '${path}.pricing.${key}' (will be ignored)`)
        }
      }
      for (const key of PRICING_RATE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(raw.pricing, key)) {
          normalized[key] = 0
          continue
        }
        const v = raw.pricing[key]
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          warnings.push(`Invalid value for '${path}.pricing.${key}': expected a number >= 0 (USD per MTok), got ${JSON.stringify(v)}`)
          pricingValid = false
        } else {
          normalized[key] = v
        }
      }
      if (pricingValid) {
        pricing = Object.freeze(normalized)
      } else {
        valid = false
      }
    }
  }

  // --- contextWindow ---
  // Absent or malformed → null. Never fabricate a window (#5418 / #5444):
  // an explicit null makes the dashboard omit the context chip instead of
  // pinning a made-up 200k on the model.
  let contextWindow = null
  if (Object.prototype.hasOwnProperty.call(raw, 'contextWindow')) {
    if (Number.isInteger(raw.contextWindow) && raw.contextWindow > 0) {
      contextWindow = raw.contextWindow
    } else {
      warnings.push(`Invalid value for '${path}.contextWindow': expected a positive integer (tokens), got ${JSON.stringify(raw.contextWindow)} — treating the window as unknown`)
    }
  }

  // --- modelDiscovery (live catalog + per-model pricing autofill, #5548) ---
  // Absent → no discovery (the picker keeps the static `models`/defaultModel
  // seed, the steady state since #5419). A malformed value drops the whole
  // entry: a half-configured discovery seam (bad url, unknown format) is a
  // misconfig the operator must see, not silently degrade to "no discovery".
  let modelDiscovery = null
  if (Object.prototype.hasOwnProperty.call(raw, 'modelDiscovery')) {
    const md = raw.modelDiscovery
    if (typeof md !== 'object' || md === null || Array.isArray(md)) {
      warnings.push(`Invalid value for '${path}.modelDiscovery': expected an object with 'url' and 'format', got ${typeName(md)}`)
      valid = false
    } else {
      let mdValid = true
      for (const key of Object.keys(md)) {
        if (!MODEL_DISCOVERY_KEYS.has(key)) {
          warnings.push(`Unknown key '${path}.modelDiscovery.${key}' (will be ignored)`)
        }
      }
      // url — http(s), no embedded credentials (same posture as baseUrl).
      let url = null
      if (typeof md.url !== 'string' || md.url.length === 0) {
        warnings.push(`Invalid value for '${path}.modelDiscovery.url': required — the http(s) URL of the model-catalog endpoint`)
        mdValid = false
      } else {
        let parsed = null
        try {
          parsed = new URL(md.url)
        } catch {
          warnings.push(`Invalid URL format for '${path}.modelDiscovery.url': expected an http(s) URL (value not shown — fix it in config.json)`)
          mdValid = false
        }
        if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          warnings.push(`Invalid value for '${path}.modelDiscovery.url': must use http:// or https://, got '${parsed.protocol}'`)
          mdValid = false
        }
        if (parsed && (parsed.username || parsed.password)) {
          warnings.push(`Invalid value for '${path}.modelDiscovery.url': embedded credentials (user:pass@) are not supported — secrets don't belong in config.json`)
          mdValid = false
        }
        if (mdValid) url = md.url
      }
      // format — one of the known adapters.
      let format = null
      if (typeof md.format !== 'string' || !MODEL_DISCOVERY_FORMATS.includes(md.format)) {
        warnings.push(`Invalid value for '${path}.modelDiscovery.format': expected one of ${MODEL_DISCOVERY_FORMATS.map((f) => `'${f}'`).join(', ')}, got ${JSON.stringify(md.format)}`)
        mdValid = false
      } else {
        format = md.format
      }
      if (mdValid) {
        modelDiscovery = Object.freeze({ url, format })
      } else {
        valid = false
      }
    }
  }

  if (!valid) return null

  seenIds.add(id)
  return Object.freeze({
    id,
    label,
    baseUrl,
    apiKeyEnv,
    credentialsKey,
    defaultModel: defaultModel.trim(),
    models: models ? Object.freeze(models) : null,
    pricing,
    contextWindow,
    modelDiscovery,
  })
}

/**
 * Validate + normalize the `providers.anthropicCompatible` array.
 *
 * Never throws. Invalid entries are dropped (with a warning each); valid
 * siblings survive — the "drop bad entries, keep the rest" contract used
 * by providerStreamStallTimeoutMs and environments.backend.
 *
 * @param {*} value - The raw `providers.anthropicCompatible` value
 * @param {{ reservedIds?: Iterable<string> }} [opts] - Extra ids the
 *   entries may not claim (the live registry at registration time); the
 *   static RESERVED_PROVIDER_IDS are always included.
 * @returns {{ entries: Array<object>, warnings: string[] }} Normalized
 *   frozen entries: `{ id, label, baseUrl, apiKeyEnv, credentialsKey,
 *   defaultModel, models|null, pricing|null, contextWindow|null }`.
 */
export function validateAnthropicCompatibleProviders(value, opts = {}) {
  const warnings = []
  const entries = []

  if (!Array.isArray(value)) {
    warnings.push(`Invalid value for 'providers.anthropicCompatible': expected an array of endpoint entries, got ${typeName(value)}`)
    return { entries, warnings }
  }

  const reservedIds = new Set(RESERVED_PROVIDER_IDS)
  if (opts.reservedIds) {
    for (const id of opts.reservedIds) reservedIds.add(id)
  }

  const seenIds = new Set()
  for (let i = 0; i < value.length; i++) {
    const normalized = validateEntry(value[i], `providers.anthropicCompatible[${i}]`, seenIds, reservedIds, warnings)
    if (normalized) entries.push(normalized)
  }

  return { entries, warnings }
}

/**
 * Validate the top-level `providers` value when it is an OBJECT (#5419).
 * The legacy form — an array of provider-id strings written by
 * `chroxy init` — is informational and stays unvalidated; this only runs
 * on the object form. Called from config.js's validateConfig.
 *
 * @param {object} providers - Already known to be a plain (non-array) object
 * @param {string[]} warnings - Accumulator the caller logs/returns
 */
export function validateProvidersConfigBlock(providers, warnings) {
  for (const key of Object.keys(providers)) {
    if (key !== 'anthropicCompatible') {
      warnings.push(`Unknown key 'providers.${key}' (will be ignored)`)
    }
  }
  if (Object.prototype.hasOwnProperty.call(providers, 'anthropicCompatible')) {
    const { warnings: entryWarnings } = validateAnthropicCompatibleProviders(providers.anthropicCompatible)
    warnings.push(...entryWarnings)
  }
}
