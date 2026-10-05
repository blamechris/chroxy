/**
 * Session defaults: the New Session provider/model a user has deliberately
 * chosen, kept apart from what they merely inherited (#8265).
 *
 * Before this module the two persisted keys meant "whatever the Settings
 * select last held". A value written once, under an older built-in default,
 * beat the daemon's default forever and never said where it came from — the
 * desktop app preselected `claude-cli` (which registers chroxy's hook in the
 * user-level Claude settings, #8263) and created sessions on a stale
 * `opus-4-6` pin.
 *
 * The invariant this module establishes: once the schema marker is written,
 * a PRESENT key is a deliberate user override — only the Settings selects
 * write it from then on — and an ABSENT key means "inherit" (the daemon's
 * default provider; the provider's own default model). Legacy values that
 * cannot be told apart from an inherited default are migrated to absent,
 * once, with a notice; the rest are kept as overrides.
 */

export const DEFAULT_PROVIDER_KEY = 'chroxy_default_provider'
export const DEFAULT_MODEL_KEY = 'chroxy_default_model'
export const SESSION_DEFAULTS_SCHEMA_KEY = 'chroxy_session_defaults_v'
export const SESSION_DEFAULTS_NOTICE_KEY = 'chroxy_session_defaults_notice'
export const SESSION_DEFAULTS_SCHEMA_VERSION = '2'

/**
 * Legacy persisted providers treated as inherited rather than chosen:
 *  - `claude-cli` writes chroxy's permission hook into the user-level Claude
 *    settings file, so it must never be preselected silently (#8263);
 *  - `claude-tui` was the built-in default (#5819), so a persisted copy of it
 *    is indistinguishable from accepting that default, which is retired (#8266).
 */
const INHERITED_LEGACY_PROVIDERS: ReadonlySet<string> = new Set(['claude-cli', 'claude-tui'])

/**
 * A Claude model id pinned to a version (`opus-4-6`, `claude-sonnet-4-6`,
 * `claude-opus-4-7[1m]`, `claude-sonnet-4-20250514`). Aliases (`opus`,
 * `sonnet`, `default`) follow the newest model and are not pins; non-Claude
 * ids (`gpt-5`, `gemini-2.5-pro`) are out of this check's reach.
 */
export function isVersionedClaudeModelPin(model: string): boolean {
  return /^(claude-)?(opus|sonnet|haiku|fable)-\d/.test(model.trim())
}

export type SessionDefaultSource = 'user' | 'server' | 'builtin'

export interface SessionDefaultsNotice {
  /** The legacy provider that was cleared, if any. */
  provider?: string
  /** The legacy model pin that was cleared, if any. */
  model?: string
}

export interface MigratedSessionDefaults {
  /** The deliberate provider override, or null to inherit. */
  provider: string | null
  /** The deliberate model override, or '' to inherit. */
  model: string
  /** What the one-time migration cleared, still undismissed. */
  notice: SessionDefaultsNotice | null
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readNotice(storage: StorageLike): SessionDefaultsNotice | null {
  const raw = storage.getItem(SESSION_DEFAULTS_NOTICE_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { provider, model } = parsed as Record<string, unknown>
    const notice: SessionDefaultsNotice = {}
    if (typeof provider === 'string' && provider) notice.provider = provider
    if (typeof model === 'string' && model) notice.model = model
    return notice.provider || notice.model ? notice : null
  } catch {
    return null
  }
}

/**
 * Bring persisted session defaults to the current schema and return them.
 * Idempotent: a store already at the current schema is read, never rewritten.
 * Storage that throws (private mode, storage denied) reads as "nothing
 * persisted", like every other persisted dashboard setting.
 */
export function migrateSessionDefaults(storage: StorageLike | null = defaultStorage()): MigratedSessionDefaults {
  if (!storage) return { provider: null, model: '', notice: null }
  try {
    if (storage.getItem(SESSION_DEFAULTS_SCHEMA_KEY) !== SESSION_DEFAULTS_SCHEMA_VERSION) {
      const notice: SessionDefaultsNotice = {}
      const legacyProvider = storage.getItem(DEFAULT_PROVIDER_KEY)
      if (legacyProvider !== null && (legacyProvider.trim() === '' || INHERITED_LEGACY_PROVIDERS.has(legacyProvider.trim()))) {
        storage.removeItem(DEFAULT_PROVIDER_KEY)
        if (legacyProvider.trim()) notice.provider = legacyProvider.trim()
      }
      const legacyModel = storage.getItem(DEFAULT_MODEL_KEY)
      if (legacyModel !== null && (legacyModel.trim() === '' || isVersionedClaudeModelPin(legacyModel))) {
        storage.removeItem(DEFAULT_MODEL_KEY)
        if (legacyModel.trim()) notice.model = legacyModel.trim()
      }
      if (notice.provider || notice.model) {
        storage.setItem(SESSION_DEFAULTS_NOTICE_KEY, JSON.stringify(notice))
      }
      storage.setItem(SESSION_DEFAULTS_SCHEMA_KEY, SESSION_DEFAULTS_SCHEMA_VERSION)
    }
    const provider = storage.getItem(DEFAULT_PROVIDER_KEY)
    return {
      provider: provider && provider.trim() ? provider : null,
      model: storage.getItem(DEFAULT_MODEL_KEY) ?? '',
      notice: readNotice(storage),
    }
  } catch {
    return { provider: null, model: '', notice: null }
  }
}

/** Persist (or, for '' / null, clear) a deliberate override. Best-effort. */
export function persistSessionDefault(key: typeof DEFAULT_PROVIDER_KEY | typeof DEFAULT_MODEL_KEY, value: string | null, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return
  try {
    if (value && value.trim()) storage.setItem(key, value)
    else storage.removeItem(key)
    // An explicit write is a decision taken with the current schema in force.
    storage.setItem(SESSION_DEFAULTS_SCHEMA_KEY, SESSION_DEFAULTS_SCHEMA_VERSION)
  } catch { /* noop */ }
}

/** Dismiss the one-time migration notice. Best-effort. */
export function clearSessionDefaultsNotice(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return
  try { storage.removeItem(SESSION_DEFAULTS_NOTICE_KEY) } catch { /* noop */ }
}
