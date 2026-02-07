// Single source of truth for supported models. Each entry has a short id
// (used in set_model messages), a display label, and the full Claude model ID.
export const MODELS = [
  { id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-235-20250421' },
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-20250514' },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-20250514' },
]

// Accept both short ids and full model IDs in set_model
export const ALLOWED_MODEL_IDS = new Set(MODELS.flatMap(m => [m.id, m.fullId]))

// Lookup table: short id -> full model ID
const MODEL_ID_MAP = new Map(MODELS.flatMap(m => [
  [m.id, m.fullId],
  [m.fullId, m.fullId],
]))

/**
 * Resolve a model identifier (short or full) to its canonical full model ID.
 * Returns the input unchanged if not recognized.
 */
export function resolveModelId(model) {
  return MODEL_ID_MAP.get(model) || model
}
