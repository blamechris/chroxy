import { readFileSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'

const log = createLogger('models')

/** Default context window for unknown models */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Static context-window heuristic used at cold start before the SDK reports.
 * Opus 4.6+ has 1M; most other Claude models have 200k. The SDK sends
 * authoritative values in `SDKResultSuccess.modelUsage[*].contextWindow`
 * after each turn — registries opportunistically correct themselves via
 * `updateContextWindow()` so wrong guesses only surface for the first turn.
 *
 * Exported so Claude providers (SdkSession/CliSession) can reuse it in
 * their `getModelMetadata()` implementations.
 */
export function resolveClaudeContextWindow(fullId) {
  if (fullId.includes('opus-4-6') || fullId.includes('opus-4.6')) return 1_000_000
  if (fullId.includes('opus-4-7') || fullId.includes('opus-4.7')) return 1_000_000
  return DEFAULT_CONTEXT_WINDOW
}


/**
 * Default Claude ID converter: strips the `claude-` prefix to produce the
 * short id while keeping the full id as-is. Exported so provider classes
 * can compose it in their own `getModelMetadata()`.
 */
export function claudeDeriveId(fullId) {
  return typeof fullId === 'string' && fullId.startsWith('claude-') ? fullId.slice(7) : fullId
}

// Minimal fallback used only when the SDK has never responded and no disk
// cache exists. Short aliases (sonnet/opus/haiku) resolve to the latest
// version in the claude CLI, so these entries stay valid across releases.
// Dated full IDs are intentionally avoided here — the SDK's supportedModels()
// is the source of truth for concrete version identifiers.
//
// Deep-frozen so callers of getModels() can't mutate the module-level constant
// via the returned array reference.
export const FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6', contextWindow: resolveClaudeContextWindow('claude-sonnet-4-6') }),
  Object.freeze({ id: 'opus', label: 'Opus', fullId: 'claude-opus-4-7', contextWindow: resolveClaudeContextWindow('claude-opus-4-7') }),
  Object.freeze({ id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-4-5', contextWindow: resolveClaudeContextWindow('claude-haiku-4-5') }),
])

function getDefaultCachePath() {
  const configDir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  return join(configDir, 'models-cache.json')
}

/**
 * Canonical JSON stringifier — sorts object keys recursively so equivalent
 * data produces an identical string regardless of construction order.
 *
 * Used by the registry's snapshotString() to dedupe saveCache() writes. The
 * JS spec guarantees insertion-order key iteration, but relying on that to
 * compare payloads is fragile: any future refactor that builds model objects
 * via `{...m, contextWindow}` spreads or object-rest patterns could silently
 * shuffle keys and defeat the snapshot equality check. Sorting keys makes
 * the snapshot invariant to construction order.
 *
 * Semantics match `JSON.stringify` for the cases that matter:
 *   - undefined / function / symbol values: dropped from objects,
 *     coerced to null inside arrays (same as JSON.stringify)
 *   - sparse array holes: serialized as null (same as JSON.stringify)
 *   - `toJSON()`: honored on any object that defines it
 *   - circular structures: throw (same as JSON.stringify)
 *
 * Implementation: normalize to a key-sorted plain-object/array tree first,
 * then hand to `JSON.stringify`. This avoids emitting invalid JSON like
 * `{"k":undefined}` while still guaranteeing canonical ordering.
 *
 * Exported for tests.
 */
export function canonicalStringify(value) {
  const seen = new Set()

  function normalize(current, key, inArray) {
    if (current && typeof current === 'object' && typeof current.toJSON === 'function') {
      current = current.toJSON(key)
    }
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
      return inArray ? null : undefined
    }
    if (!current || typeof current !== 'object') {
      return current
    }
    if (seen.has(current)) {
      throw new TypeError('Converting circular structure to JSON')
    }
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        const out = new Array(current.length)
        for (let i = 0; i < current.length; i += 1) {
          out[i] = normalize(current[i], String(i), true)
        }
        return out
      }
      const out = {}
      const keys = Object.keys(current).sort()
      for (const childKey of keys) {
        const childValue = normalize(current[childKey], childKey, false)
        if (childValue !== undefined) {
          out[childKey] = childValue
        }
      }
      return out
    } finally {
      seen.delete(current)
    }
  }

  return JSON.stringify(normalize(value, '', false))
}

/**
 * Derive a human-readable label from a stripped model ID.
 * E.g. "opus-4-5-20251101" → "Opus 4.5", "sonnet-4-20250514" → "Sonnet 4"
 */
function humanizeModelId(id) {
  let clean = id.replace(/-\d{8,}$/, '')
  const parts = clean.split('-')
  if (parts.length === 0) return id
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const version = parts.slice(1).join('.')
  return version ? `${family} ${version}` : family
}

/**
 * Factory function that creates an isolated models registry.
 * Each instance has its own mutable state, preventing test pollution.
 *
 * Accepts optional provider-specific hooks so non-Claude providers (Codex,
 * Gemini, …) can drive their own fallback list, ID derivation and context-
 * window heuristic without the registry hard-coding Claude conventions. When
 * no hooks are supplied the registry defaults to the Claude behaviour so all
 * existing callers (sdk-session, server-cli, test suites) keep working.
 *
 * @param {Object} [hooks]
 * @param {ReadonlyArray<Object>} [hooks.fallbackModels] - Provider's minimal
 *   fallback list. Defaults to Claude's `FALLBACK_MODELS`.
 * @param {(fullId:string) => string} [hooks.deriveId] - Maps an SDK `fullId`
 *   to the registry's short id. Defaults to Claude's `claude-` strip.
 * @param {(fullId:string) => number} [hooks.resolveContextWindow] -
 *   Heuristic context-window resolver. Defaults to the Claude one.
 * @param {(id:string) => (Object|null)} [hooks.getModelMetadata] -
 *   Optional provider lookup that can return `{id,label,fullId,contextWindow}`
 *   for a known model id. When present it is consulted first during
 *   `updateModels()` to reuse provider-authoritative metadata.
 */
export function createModelsRegistry(hooks = {}) {
  const fallbackModels = hooks.fallbackModels ?? FALLBACK_MODELS
  const deriveIdFn = typeof hooks.deriveId === 'function' ? hooks.deriveId : claudeDeriveId
  const resolveContextWindowFn = typeof hooks.resolveContextWindow === 'function'
    ? hooks.resolveContextWindow
    : resolveClaudeContextWindow
  const getModelMetadataFn = typeof hooks.getModelMetadata === 'function' ? hooks.getModelMetadata : null

  let activeModels = fallbackModels
  let defaultModelId = null
  let allowedModelIds = new Set()
  let toFullIdMap = new Map()
  let toShortIdMap = new Map()
  // Snapshot of the last saved cache payload so saveCache() can skip
  // redundant writes. `null` forces the first save to always run.
  let lastSavedSnapshot = null
  // Authoritative contextWindow values observed from SDK `modelUsage`,
  // keyed by fullId. These override the static resolveContextWindow()
  // heuristic and must survive subsequent updateModels() refreshes
  // (which otherwise rebuild every entry from the heuristic on every
  // SDK session init). Cleared on resetModels().
  const contextWindowOverrides = new Map()

  // Seed lookups with FALLBACK_MODELS aliases so legacy short ids
  // (`sonnet`/`opus`/`haiku`) remain valid even after the SDK returns a
  // dynamic list whose derived short ids look different
  // (e.g. `sonnet-4-6`). Dynamic entries override on collision.
  function rebuildLookups(models) {
    allowedModelIds = new Set()
    toFullIdMap = new Map()
    toShortIdMap = new Map()

    const seed = (list) => {
      for (const m of list) {
        allowedModelIds.add(m.id)
        allowedModelIds.add(m.fullId)
        toFullIdMap.set(m.id, m.fullId)
        toFullIdMap.set(m.fullId, m.fullId)
        toShortIdMap.set(m.fullId, m.id)
        toShortIdMap.set(m.id, m.id)
      }
    }

    seed(fallbackModels)
    if (models !== fallbackModels) seed(models)
  }

  function applyModels(models, nextDefault) {
    activeModels = models
    defaultModelId = nextDefault
    rebuildLookups(models)
  }

  function snapshotString() {
    return canonicalStringify({ models: activeModels, defaultModelId })
  }

  rebuildLookups(fallbackModels)

  return {
    getModels() {
      return activeModels
    },

    updateModels(sdkModels) {
      if (!Array.isArray(sdkModels)) {
        log.debug(`updateModels: ignoring non-array input (got ${sdkModels === null ? 'null' : typeof sdkModels})`)
        return null
      }

      let nextDefault = null
      // Track total dropped count separately from the key-sample buffer so
      // the log reports "dropped N/M" correctly when more than 3 entries
      // are invalid (the sample is capped to avoid log bloat).
      let droppedCount = 0
      const droppedSample = []
      const converted = sdkModels
        .filter(m => {
          const ok = m && typeof m.value === 'string' && m.value.length > 0
          if (!ok) {
            droppedCount++
            if (droppedSample.length < 3) droppedSample.push(m)
          }
          return ok
        })
        .map(m => {
          const fullId = m.value
          // Prefer the provider's own metadata lookup when it recognises
          // the id — that keeps the short id / label / context window in
          // sync with whatever the provider exposes via `getAllowedModels()`
          // and `getFallbackModels()`. When the provider has no entry for
          // this id (new release, custom deploy, …) fall back to the
          // registry's deriveId/resolveContextWindow hooks.
          const providerMeta = getModelMetadataFn ? getModelMetadataFn(fullId) : null
          const derivedId = providerMeta?.id ?? deriveIdFn(fullId)
          let label = m.displayName || ''
          if (typeof m.displayName === 'string' && /^default\b/i.test(m.displayName)) {
            nextDefault = derivedId
            const match = label.match(/^Default\s*\((.+)\)$/)
            if (match) label = match[1]
          }
          if (!label || /^recommended$/i.test(label)) {
            label = providerMeta?.label || humanizeModelId(derivedId)
          }
          // Prefer an authoritative value observed from SDK modelUsage
          // over the static heuristic, so a learned contextWindow isn't
          // lost when _fetchSupportedModels() fires on every init.
          const contextWindow = contextWindowOverrides.get(fullId)
            ?? providerMeta?.contextWindow
            ?? resolveContextWindowFn(fullId)
          return { id: derivedId, label, fullId, contextWindow }
        })

      if (droppedCount > 0) {
        // Contract drift: SDK returned entries whose `value` was missing,
        // non-string, or empty. Log the accurate total count, plus a
        // keys-only sample of the first N offenders — entries may carry
        // provider metadata we don't want to leak to disk logs.
        const sample = droppedSample.map(m => {
          if (m === null) return 'null'
          if (typeof m !== 'object') return typeof m
          return `{${Object.keys(m).join(',')}}`
        }).join(', ')
        log.warn(`updateModels: dropped ${droppedCount}/${sdkModels.length} SDK entries with missing or invalid 'value' key (sample: ${sample})`)
      }

      if (converted.length === 0) {
        if (sdkModels.length > 0) {
          log.warn(`updateModels: SDK returned ${sdkModels.length} entries but none matched the expected {value,displayName,description} shape — keeping existing models`)
        }
        return converted
      }

      applyModels(converted, nextDefault)
      return converted
    },

    /**
     * Replace the contextWindow for an existing entry when the SDK reports
     * an authoritative value (via `SDKResultSuccess.modelUsage`). Matches
     * on `fullId` or short `id`. No-op if the model isn't in the registry
     * or the reported value already matches.
     */
    updateContextWindow(modelId, contextWindow) {
      if (typeof modelId !== 'string' || typeof contextWindow !== 'number' || contextWindow <= 0) {
        return false
      }
      let changed = false
      activeModels = activeModels.map(m => {
        if ((m.id === modelId || m.fullId === modelId) && m.contextWindow !== contextWindow) {
          changed = true
          // Persist the authoritative value so a later updateModels()
          // refresh doesn't revert us to the static heuristic.
          contextWindowOverrides.set(m.fullId, contextWindow)
          return { ...m, contextWindow }
        }
        return m
      })
      return changed
    },

    resetModels() {
      contextWindowOverrides.clear()
      applyModels(fallbackModels, null)
      lastSavedSnapshot = null
    },

    getDefaultModelId() {
      return defaultModelId
    },

    resolveModelId(model) {
      return toFullIdMap.get(model) || model
    },

    toShortModelId(model) {
      return toShortIdMap.get(model) || model
    },

    getAllowedModelIds() {
      return allowedModelIds
    },

    /**
     * Load a previously cached model list from disk. Returns true on success.
     * Silently returns false if the cache is absent, malformed, or empty.
     * Missing `label` and `contextWindow` fields are re-derived so that
     * older or hand-edited cache files don't leave the picker with empty
     * labels or a default context window.
     */
    loadCache(path = getDefaultCachePath()) {
      try {
        const raw = readFileSync(path, 'utf-8')
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return false
        const models = parsed.models
          .filter(m => m && typeof m.id === 'string' && typeof m.fullId === 'string')
          .map(m => ({
            id: m.id,
            fullId: m.fullId,
            label: typeof m.label === 'string' && m.label.length > 0 ? m.label : humanizeModelId(m.id),
            contextWindow: typeof m.contextWindow === 'number' && m.contextWindow > 0
              ? m.contextWindow
              : resolveContextWindowFn(m.fullId),
          }))
        if (models.length === 0) return false
        applyModels(models, parsed.defaultModelId || null)
        // Treat the loaded state as the last-saved baseline so subsequent
        // saveCache() calls only hit disk when the registry actually drifts.
        lastSavedSnapshot = snapshotString()
        return true
      } catch {
        return false
      }
    },

    /**
     * Persist the current model list to disk. Returns true on success
     * OR when there was nothing to persist (idempotent no-op); returns
     * false only if the write was attempted and failed.
     *
     * Skips disk IO when the (models, defaultModelId) snapshot matches the
     * last successful save — `_fetchSupportedModels()` fires on every SDK
     * session init, which would otherwise write ~2 KB on every user message.
     *
     * Writes go through a temp file + rename so a crash mid-write can't
     * leave a truncated cache, and permissions are locked down via
     * writeFileRestricted (0600).
     */
    saveCache(path = getDefaultCachePath()) {
      const snapshot = snapshotString()
      if (snapshot === lastSavedSnapshot) return true

      const tmpPath = `${path}.tmp-${process.pid}`
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileRestricted(tmpPath, JSON.stringify({
          models: activeModels,
          defaultModelId,
          savedAt: Date.now(),
        }, null, 2))
        renameSync(tmpPath, path)
        lastSavedSnapshot = snapshot
        return true
      } catch (err) {
        // Persisting the cache failed (permission denied, disk full, read-only
        // parent). The in-memory list stays live for this process, but will be
        // lost on restart — surface at warn level so operators can diagnose
        // from ~/.chroxy/logs/chroxy.log.
        log.warn(`saveCache: failed to persist models cache to ${path}: ${err?.code || ''} ${err?.message || err}`.trim())
        try { unlinkSync(tmpPath) } catch {}
        return false
      }
    },
  }
}

// Default instance — preserves backward compatibility for all existing imports
const defaultRegistry = createModelsRegistry()

/**
 * Per-provider registries. Providers that expose static
 * `getFallbackModels()` and `getModelMetadata(id)` get a dedicated, isolated
 * registry so a Codex or Gemini session never sees Claude-only models. The
 * cache is lazy and keyed by provider name.
 *
 * The default Claude providers (`claude-sdk`, `claude-cli`, any docker alias
 * thereof) continue to share the module-level `defaultRegistry` so that the
 * existing cache-warming path (`loadModelsCache`) and the live
 * `updateModels()` feed from the Agent SDK still have one source of truth.
 */
const providerRegistryCache = new Map()

const CLAUDE_PROVIDER_NAMES = new Set([
  'claude-sdk',
  'claude-cli',
  'docker',
  'docker-sdk',
  'docker-cli',
])

// Populated by providers.js at module load so models.js can resolve a
// provider name to its ProviderClass without creating a circular import.
// Keeping this module-local + async-free keeps `getRegistryForProvider()`
// synchronous for the ws-history.js hot path (post-auth handshake).
const nameToProviderClass = new Map()

/**
 * Called by providers.js after `registerProvider(name, ProviderClass)` so
 * models.js can build a per-provider registry on demand. Noop for Claude
 * providers — they share the default registry.
 *
 * @param {string} providerName
 * @param {Function} ProviderClass
 */
export function registerProviderRegistry(providerName, ProviderClass) {
  if (!providerName || typeof providerName !== 'string') return
  if (typeof ProviderClass !== 'function') return
  nameToProviderClass.set(providerName, ProviderClass)
  // Purge any previously-cached registry so a re-registration picks up
  // the new class (useful for tests and hot-reload).
  providerRegistryCache.delete(providerName)
}

/**
 * Lazily create and cache a provider-scoped registry.
 *
 * Claude providers (including docker-based variants) share the module-level
 * default registry so the live SDK feed keeps updating a single source of
 * truth. Non-Claude providers get their own registry driven by
 * `ProviderClass.getFallbackModels()` and `ProviderClass.getModelMetadata()`.
 *
 * Unknown or unregistered provider names fall back to the Claude registry
 * (safe default — matches the legacy global behaviour).
 *
 * @param {string} providerName
 * @returns {ReturnType<typeof createModelsRegistry>}
 */
export function getRegistryForProvider(providerName) {
  if (!providerName || CLAUDE_PROVIDER_NAMES.has(providerName)) {
    return defaultRegistry
  }

  const cached = providerRegistryCache.get(providerName)
  if (cached) return cached

  const ProviderClass = nameToProviderClass.get(providerName)
  if (!ProviderClass || typeof ProviderClass.getFallbackModels !== 'function') {
    return defaultRegistry
  }

  const registry = createModelsRegistry({
    fallbackModels: ProviderClass.getFallbackModels(),
    getModelMetadata: typeof ProviderClass.getModelMetadata === 'function'
      ? (id) => ProviderClass.getModelMetadata(id)
      : null,
    // Non-Claude providers typically use opaque full ids (no prefix to
    // strip) — identity is the safest default. Providers can override via
    // `getModelMetadata()` when they want a different short id.
    deriveId: (fullId) => fullId,
    resolveContextWindow: (fullId) => {
      const meta = typeof ProviderClass.getModelMetadata === 'function'
        ? ProviderClass.getModelMetadata(fullId)
        : null
      return meta?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    },
  })
  providerRegistryCache.set(providerName, registry)
  return registry
}

// Accept both short ids and full model IDs in set_model.
// Proxy delegates to the default registry's live Set so mutations
// (from updateModels/resetModels) are always reflected.
export const ALLOWED_MODEL_IDS = new Proxy(new Set(), {
  get(_, prop) {
    const target = defaultRegistry.getAllowedModelIds()
    const value = Reflect.get(target, prop, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

export function getModels() {
  return defaultRegistry.getModels()
}

export function updateModels(sdkModels) {
  return defaultRegistry.updateModels(sdkModels)
}

export function updateContextWindow(modelId, contextWindow) {
  return defaultRegistry.updateContextWindow(modelId, contextWindow)
}

export function resetModels() {
  defaultRegistry.resetModels()
}

export function resolveModelId(model) {
  return defaultRegistry.resolveModelId(model)
}

export function toShortModelId(model) {
  return defaultRegistry.toShortModelId(model)
}

export function getDefaultModelId() {
  return defaultRegistry.getDefaultModelId()
}

export function loadModelsCache(path) {
  return defaultRegistry.loadCache(path)
}

export function saveModelsCache(path) {
  return defaultRegistry.saveCache(path)
}
