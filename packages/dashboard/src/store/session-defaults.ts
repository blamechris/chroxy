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
 * `claude-opus-4-7[1m]`, `claude-sonnet-4-20250514`), including the older
 * version-first scheme (`claude-3-5-sonnet-20241022`, `claude-3-opus-20240229`,
 * `claude-3-7-sonnet-latest`). Aliases (`opus`, `sonnet`, `default`) follow
 * the newest model and are not pins; non-Claude ids (`gpt-5`,
 * `gemini-2.5-pro`) are out of this check's reach.
 */
export function isVersionedClaudeModelPin(model: string): boolean {
  const id = model.trim()
  // family-first: opus-4-6, claude-sonnet-4-20250514, claude-opus-4-7[1m]
  if (/^(claude-)?(opus|sonnet|haiku|fable)-\d/i.test(id)) return true
  // version-first (claude-3 era): claude-3-opus, claude-3-5-sonnet-20241022,
  // claude-3-7-sonnet-latest. A bare `sonnet-latest` names no version, so it
  // is an alias, not a pin.
  return /^(claude-)?\d+(-\d+)?-(opus|sonnet|haiku|fable)(-\d|-latest|$)/i.test(id)
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
 * True when a value found WITHOUT the schema marker cannot be told apart from
 * an inherited default, so the migration clears it instead of honouring it.
 */
function isLegacyInherited(key: typeof DEFAULT_PROVIDER_KEY | typeof DEFAULT_MODEL_KEY, value: string | null): boolean {
  if (value === null) return false
  if (value.trim() === '') return true
  return key === DEFAULT_PROVIDER_KEY
    ? INHERITED_LEGACY_PROVIDERS.has(value.trim())
    : isVersionedClaudeModelPin(value)
}

/**
 * Bring persisted session defaults to the current schema and return them.
 * Idempotent: a store already at the current schema is read, never rewritten.
 *
 * Reading and writing fail separately. Only a failed READ means "nothing
 * persisted" (private mode, storage denied), like every other persisted
 * dashboard setting. A failed WRITE (quota) never changes what this load
 * returns: the values are classified from what was read, so a readable
 * deliberate override is honoured and a legacy value is inherited even when
 * its removal could not be written. The unfinished steps are retried on the
 * next load, because the schema marker is only written after them.
 */
export function migrateSessionDefaults(storage: StorageLike | null = defaultStorage()): MigratedSessionDefaults {
  if (!storage) return { provider: null, model: '', notice: null }
  let marker: string | null
  let rawProvider: string | null
  let rawModel: string | null
  try {
    marker = storage.getItem(SESSION_DEFAULTS_SCHEMA_KEY)
    rawProvider = storage.getItem(DEFAULT_PROVIDER_KEY)
    rawModel = storage.getItem(DEFAULT_MODEL_KEY)
  } catch {
    return { provider: null, model: '', notice: null }
  }
  // The notice is read on its own: an unreadable notice must not cost the
  // user their readable defaults.
  let storedNotice: SessionDefaultsNotice | null = null
  try { storedNotice = readNotice(storage) } catch { /* treated as no notice */ }

  let provider = rawProvider && rawProvider.trim() ? rawProvider : null
  let model = rawModel ?? ''
  // An undismissed notice from an earlier, partly failed run is MERGED, never
  // replaced: a retry that only finds the model left must not drop the
  // provider the first run already cleared.
  const notice: SessionDefaultsNotice = { ...storedNotice }

  if (marker !== SESSION_DEFAULTS_SCHEMA_VERSION) {
    const clear: string[] = []
    if (isLegacyInherited(DEFAULT_PROVIDER_KEY, rawProvider)) {
      clear.push(DEFAULT_PROVIDER_KEY)
      provider = null
      if (rawProvider!.trim()) notice.provider = rawProvider!.trim()
    }
    if (isLegacyInherited(DEFAULT_MODEL_KEY, rawModel)) {
      clear.push(DEFAULT_MODEL_KEY)
      model = ''
      if (rawModel!.trim()) notice.model = rawModel!.trim()
    }
    // Order matters when storage fails part-way: the notice is written before
    // anything is removed, and the marker only after every removal, so a
    // failure never loses a value silently and the next load re-runs this.
    try {
      if (notice.provider || notice.model) {
        storage.setItem(SESSION_DEFAULTS_NOTICE_KEY, JSON.stringify(notice))
      }
      for (const key of clear) storage.removeItem(key)
      storage.setItem(SESSION_DEFAULTS_SCHEMA_KEY, SESSION_DEFAULTS_SCHEMA_VERSION)
    } catch { /* retried on the next load */ }
  }

  return { provider, model, notice: notice.provider || notice.model ? notice : null }
}

/**
 * Finish a migration that a failed write left pending, so that a Settings write
 * which follows lands under the schema marker as a deliberate choice.
 *
 * Every legacy-classified value is removed BEFORE the marker is stamped (the
 * marker turns each present key into an override, so a stale claude-cli or
 * opus-4-6 must never survive it). The notice is recorded first and, if that
 * write fails (quota), once more after the removals have freed space.
 * Returns false when a removal or the marker could not be written, i.e. the
 * store is still unmigrated.
 */
function finishPendingMigration(storage: StorageLike): boolean {
  let notice: SessionDefaultsNotice = {}
  try { notice = { ...readNotice(storage) } } catch { /* no stored notice */ }
  const legacy: Array<typeof DEFAULT_PROVIDER_KEY | typeof DEFAULT_MODEL_KEY> = []
  for (const key of [DEFAULT_PROVIDER_KEY, DEFAULT_MODEL_KEY] as const) {
    const value = storage.getItem(key)
    if (!isLegacyInherited(key, value)) continue
    legacy.push(key)
    if (value!.trim()) notice[key === DEFAULT_PROVIDER_KEY ? 'provider' : 'model'] = value!.trim()
  }
  const writeNotice = (): boolean => {
    if (!notice.provider && !notice.model) return true
    try { storage.setItem(SESSION_DEFAULTS_NOTICE_KEY, JSON.stringify(notice)); return true } catch { return false }
  }
  const noticeWritten = writeNotice()
  try {
    for (const key of legacy) storage.removeItem(key)
    if (!noticeWritten) writeNotice()
    storage.setItem(SESSION_DEFAULTS_SCHEMA_KEY, SESSION_DEFAULTS_SCHEMA_VERSION)
    return true
  } catch {
    return false
  }
}

/** Persist (or, for '' / null, clear) a deliberate override. Best-effort. */
export function persistSessionDefault(key: typeof DEFAULT_PROVIDER_KEY | typeof DEFAULT_MODEL_KEY, value: string | null, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return
  // The choice is written LAST, after any pending migration has been finished
  // and the marker stamped, so it is recorded as deliberate and a later load
  // never re-classifies it (a deliberate claude-tui is also a legacy-looking
  // value).
  //
  // If the migration cannot be finished (a removal or the marker write
  // throws), the store stays unmigrated, and the next load would delete a
  // legacy-LOOKING choice and name it as cleared. Such a choice is therefore
  // not persisted: it holds for this session (the store keeps it in memory)
  // and the next load inherits. Any other choice, and clearing to inherit,
  // are still written.
  const chosen = value && value.trim() ? value : null
  let migrated = true
  try {
    if (storage.getItem(SESSION_DEFAULTS_SCHEMA_KEY) !== SESSION_DEFAULTS_SCHEMA_VERSION) {
      migrated = finishPendingMigration(storage)
    }
  } catch { migrated = false }
  try {
    if (!chosen) storage.removeItem(key)
    else if (migrated || !isLegacyInherited(key, chosen)) storage.setItem(key, chosen)
  } catch { /* noop */ }
}

/** Dismiss the one-time migration notice. Best-effort. */
export function clearSessionDefaultsNotice(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return
  try { storage.removeItem(SESSION_DEFAULTS_NOTICE_KEY) } catch { /* noop */ }
}
