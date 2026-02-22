// Single source of truth for supported models. Each entry has a short id
// (used in set_model messages), a display label, and the full Claude model ID.
export const MODELS = [
  { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-235-20250421' },
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-20250514' },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-20250514' },
  { id: 'opus46', label: 'Opus 4.6', fullId: 'claude-opus-4-6' },
]

// Mutable state — updated by updateModels() when SDK reports available models
let activeModels = MODELS

// Accept both short ids and full model IDs in set_model
export const ALLOWED_MODEL_IDS = new Set(MODELS.flatMap(m => [m.id, m.fullId]))

// Lookup tables for bidirectional resolution
let toFullIdMap = new Map(MODELS.flatMap(m => [[m.id, m.fullId], [m.fullId, m.fullId]]))
let toShortIdMap = new Map(MODELS.flatMap(m => [[m.fullId, m.id], [m.id, m.id]]))

function rebuildLookups(models) {
  ALLOWED_MODEL_IDS.clear()
  toFullIdMap = new Map()
  toShortIdMap = new Map()
  for (const m of models) {
    ALLOWED_MODEL_IDS.add(m.id)
    ALLOWED_MODEL_IDS.add(m.fullId)
    toFullIdMap.set(m.id, m.fullId)
    toFullIdMap.set(m.fullId, m.fullId)
    toShortIdMap.set(m.fullId, m.id)
    toShortIdMap.set(m.id, m.id)
  }
}

/**
 * Get the current model list (may be updated by SDK).
 */
export function getModels() {
  return activeModels
}

/**
 * Update the active model list from SDK ModelInfo[].
 * Converts SDK format { value, displayName, description } to our format { id, label, fullId }.
 * Returns the converted list, or null if input is invalid.
 */
export function updateModels(sdkModels) {
  if (!Array.isArray(sdkModels)) return null

  const converted = sdkModels
    .filter(m => m && typeof m.value === 'string' && m.value.length > 0)
    .map(m => {
      const fullId = m.value
      const id = fullId.startsWith('claude-') ? fullId.slice(7) : fullId
      const label = m.displayName || id
      return { id, label, fullId }
    })

  // If the SDK yields no usable models, preserve current/default registry
  if (converted.length === 0) return converted

  activeModels = converted
  rebuildLookups(converted)
  return converted
}

/**
 * Reset to the default hardcoded model list. Used in tests.
 */
export function resetModels() {
  activeModels = MODELS
  rebuildLookups(MODELS)
}

/**
 * Resolve a model identifier (short or full) to its canonical full model ID.
 * Returns the input unchanged if not recognized.
 */
export function resolveModelId(model) {
  return toFullIdMap.get(model) || model
}

/**
 * Resolve a model identifier (short or full) to its short id.
 * Used for broadcasting to clients (app compares against short ids).
 * Returns the input unchanged if not recognized.
 */
export function toShortModelId(model) {
  return toShortIdMap.get(model) || model
}
