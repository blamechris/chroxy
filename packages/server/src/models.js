// Single source of truth for supported models. Each entry has a short id
// (used in set_model messages), a display label, and the full Claude model ID.
export const MODELS = [
  { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-235-20250421' },
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-20250514' },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-20250514' },
  { id: 'opus46', label: 'Opus 4.6', fullId: 'claude-opus-4-6' },
]

/**
 * Factory function that creates an isolated models registry.
 * Each instance has its own mutable state, preventing test pollution.
 */
export function createModelsRegistry() {
  let activeModels = MODELS
  let defaultModelId = null
  let allowedModelIds = new Set(MODELS.flatMap(m => [m.id, m.fullId]))
  let toFullIdMap = new Map(MODELS.flatMap(m => [[m.id, m.fullId], [m.fullId, m.fullId]]))
  let toShortIdMap = new Map(MODELS.flatMap(m => [[m.fullId, m.id], [m.id, m.id]]))

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

  return {
    getModels() {
      return activeModels
    },

    updateModels(sdkModels) {
      if (!Array.isArray(sdkModels)) return null

      defaultModelId = null
      const converted = sdkModels
        .filter(m => m && typeof m.value === 'string' && m.value.length > 0)
        .map(m => {
          const fullId = m.value
          const id = fullId.startsWith('claude-') ? fullId.slice(7) : fullId
          let label = m.displayName || id
          // Detect SDK default model (displayName starts with "Default")
          if (typeof m.displayName === 'string' && /^default\b/i.test(m.displayName)) {
            defaultModelId = id
            // Strip "Default (...)" wrapper to avoid nested labels
            const match = label.match(/^Default\s*\((.+)\)$/)
            if (match) label = match[1]
          }
          return { id, label, fullId }
        })

      if (converted.length === 0) return converted

      activeModels = converted
      rebuildLookups(converted)
      return converted
    },

    resetModels() {
      activeModels = MODELS
      defaultModelId = null
      rebuildLookups(MODELS)
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
