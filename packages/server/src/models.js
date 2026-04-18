import { readFileSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { writeFileRestricted } from './platform.js'

/** Default context window for unknown models */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Resolve context window size for a model ID.
 * Opus 4.6+ has 1M context; most other Claude models have 200k.
 */
function resolveContextWindow(fullId) {
  if (fullId.includes('opus-4-6') || fullId.includes('opus-4.6')) return 1_000_000
  if (fullId.includes('opus-4-7') || fullId.includes('opus-4.7')) return 1_000_000
  return DEFAULT_CONTEXT_WINDOW
}

// Minimal fallback used only when the SDK has never responded and no disk
// cache exists. Short aliases (sonnet/opus/haiku) resolve to the latest
// version in the claude CLI, so these entries stay valid across releases.
// Dated full IDs are intentionally avoided here — the SDK's supportedModels()
// is the source of truth for concrete version identifiers.
export const FALLBACK_MODELS = [
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6', contextWindow: resolveContextWindow('claude-sonnet-4-6') },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-7', contextWindow: resolveContextWindow('claude-opus-4-7') },
  { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-4-5', contextWindow: resolveContextWindow('claude-haiku-4-5') },
]

// Back-compat export: some existing tests import `MODELS`.
export const MODELS = FALLBACK_MODELS

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
 * Factory function that creates an isolated models registry.
 * Each instance has its own mutable state, preventing test pollution.
 */
export function createModelsRegistry() {
  let activeModels = FALLBACK_MODELS
  let defaultModelId = null
  let allowedModelIds = new Set()
  let toFullIdMap = new Map()
  let toShortIdMap = new Map()

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

    seed(FALLBACK_MODELS)
    if (models !== FALLBACK_MODELS) seed(models)
  }

  function applyModels(models, nextDefault) {
    activeModels = models
    defaultModelId = nextDefault
    rebuildLookups(models)
  }

  rebuildLookups(FALLBACK_MODELS)

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
              : resolveContextWindow(m.fullId),
          }))
        if (models.length === 0) return false
        applyModels(models, parsed.defaultModelId || null)
        return true
      } catch {
        return false
      }
    },

    /**
     * Persist the current model list to disk. Returns true on success.
     * Failures are swallowed — caching is best-effort. Writes go through a
     * temp file + rename so a crash mid-write can't leave a truncated cache,
     * and permissions are locked down via writeFileRestricted (0600).
     */
    saveCache(path = getDefaultCachePath()) {
      const tmpPath = `${path}.tmp-${process.pid}`
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileRestricted(tmpPath, JSON.stringify({
          models: activeModels,
          defaultModelId,
          savedAt: Date.now(),
        }, null, 2))
        renameSync(tmpPath, path)
        return true
      } catch {
        try { unlinkSync(tmpPath) } catch {}
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
