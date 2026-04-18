import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

// Minimal fallback used only when the SDK has never responded and no disk
// cache exists. Short aliases (sonnet/opus/haiku) resolve to the latest
// version in the claude CLI, so these entries stay valid across releases.
// Dated full IDs are intentionally avoided here — the SDK's supportedModels()
// is the source of truth for concrete version identifiers.
export const FALLBACK_MODELS = [
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-7', contextWindow: 200_000 },
  { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-4-5', contextWindow: 200_000 },
]

// Back-compat export: some existing tests import `MODELS`.
export const MODELS = FALLBACK_MODELS

/** Default context window for unknown models */
export const DEFAULT_CONTEXT_WINDOW = 200_000

function getDefaultCachePath() {
  const configDir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  return join(configDir, 'models-cache.json')
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
 * Resolve context window size for a model ID.
 * Opus 4.6+ has 1M context; most other Claude models have 200k.
 */
function resolveContextWindow(fullId) {
  if (fullId.includes('opus-4-6') || fullId.includes('opus-4.6')) return 1_000_000
  if (fullId.includes('opus-4-7') || fullId.includes('opus-4.7')) return 1_000_000
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Factory function that creates an isolated models registry.
 * Each instance has its own mutable state, preventing test pollution.
 */
export function createModelsRegistry() {
  let activeModels = FALLBACK_MODELS
  let defaultModelId = null
  let allowedModelIds = new Set(FALLBACK_MODELS.flatMap(m => [m.id, m.fullId]))
  let toFullIdMap = new Map(FALLBACK_MODELS.flatMap(m => [[m.id, m.fullId], [m.fullId, m.fullId]]))
  let toShortIdMap = new Map(FALLBACK_MODELS.flatMap(m => [[m.fullId, m.id], [m.id, m.id]]))

  function rebuildLookups(models) {
    allowedModelIds = new Set()
    toFullIdMap = new Map()
    toShortIdMap = new Map()
    for (const m of models) {
      allowedModelIds.add(m.id)
      allowedModelIds.add(m.fullId)
      toFullIdMap.set(m.id, m.fullId)
      toFullIdMap.set(m.fullId, m.fullId)
      toShortIdMap.set(m.fullId, m.id)
      toShortIdMap.set(m.id, m.id)
    }
  }

  function applyModels(models, nextDefault) {
    activeModels = models
    defaultModelId = nextDefault
    rebuildLookups(models)
  }

  return {
    getModels() {
      return activeModels
    },

    updateModels(sdkModels) {
      if (!Array.isArray(sdkModels)) return null

      let nextDefault = null
      const converted = sdkModels
        .filter(m => m && typeof m.value === 'string' && m.value.length > 0)
        .map(m => {
          const fullId = m.value
          const id = fullId.startsWith('claude-') ? fullId.slice(7) : fullId
          let label = m.displayName || ''
          if (typeof m.displayName === 'string' && /^default\b/i.test(m.displayName)) {
            nextDefault = id
            const match = label.match(/^Default\s*\((.+)\)$/)
            if (match) label = match[1]
          }
          if (!label || /^recommended$/i.test(label)) {
            label = humanizeModelId(id)
          }
          const contextWindow = resolveContextWindow(fullId)
          return { id, label, fullId, contextWindow }
        })

      if (converted.length === 0) return converted

      applyModels(converted, nextDefault)
      return converted
    },

    resetModels() {
      applyModels(FALLBACK_MODELS, null)
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
     */
    loadCache(path = getDefaultCachePath()) {
      try {
        const raw = readFileSync(path, 'utf-8')
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return false
        const models = parsed.models.filter(m => m && typeof m.id === 'string' && typeof m.fullId === 'string')
        if (models.length === 0) return false
        applyModels(models, parsed.defaultModelId || null)
        return true
      } catch {
        return false
      }
    },

    /**
     * Persist the current model list to disk. Returns true on success.
     * Failures are swallowed — caching is best-effort.
     */
    saveCache(path = getDefaultCachePath()) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify({
          models: activeModels,
          defaultModelId,
          savedAt: Date.now(),
        }, null, 2))
        return true
      } catch {
        return false
      }
    },
  }
}

// Default instance — preserves backward compatibility for all existing imports
const defaultRegistry = createModelsRegistry()

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
