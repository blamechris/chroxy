/**
 * Customizable keyboard-shortcut registry (#3852).
 *
 * Single source of truth for the dashboard's user-rebindable shortcuts.
 * Each shortcut is declared once with an id, a default binding, a
 * human-readable description, a UI category, and a runtime scope. Users
 * can override the binding via the Settings panel; overrides are
 * persisted to localStorage so they survive reloads and (in Tauri) app
 * restarts.
 *
 * Design notes
 * ------------
 * - Bindings are normalised to a single canonical string form
 *   ("cmd+shift+p") so comparisons across "Cmd+K" / "Meta+k" / "ctrl+k"
 *   are reliable. We collapse Meta and Ctrl into a single "cmd" token
 *   because the existing keydown ladder treats them equivalently
 *   (`e.metaKey || e.ctrlKey`) — that's the cross-platform contract.
 * - Conflict detection is scoped: two `global` shortcuts on the same
 *   combo collide, but a `global` and a `composer` shortcut on the same
 *   combo do not (different listeners, different keydown surfaces).
 * - The registry is intentionally headless. The Settings UI and the
 *   keydown ladder both consume it via `getBinding` / `matchEvent`.
 * - Out of scope for this PR: multi-key chords ("cmd+k cmd+s"), cross-
 *   machine sync, server-side shortcuts.
 */

export type ShortcutCategory = 'navigation' | 'composer' | 'session' | 'view' | 'sidebar' | 'other'
export type ShortcutScope = 'global' | 'composer'

export interface ShortcutDef {
  id: string
  defaultBinding: string
  description: string
  category: ShortcutCategory
  scope: ShortcutScope
  /**
   * Optional runtime predicate: shortcut only fires when this returns
   * true. Used for environment gates that the registry can't know
   * about (e.g. Tauri-only shortcuts like Cmd+W close-tab). Evaluated
   * inside `matchEvent` — a false predicate means the shortcut is
   * skipped even if the combo matches.
   */
  enabled?: () => boolean
  /**
   * When true, the shortcut does NOT fire while focus is in a text
   * input (INPUT / TEXTAREA / contenteditable / SELECT). Mirrors the
   * inline gates the App.tsx ladder used to do per-branch. Evaluated
   * inside `matchEvent` when the caller passes a target element.
   */
  disabledInTextInput?: boolean
}

export interface ShortcutListEntry extends ShortcutDef {
  /** Effective binding (override if any, otherwise default), normalised. */
  binding: string
  isCustomized: boolean
}

export interface ParsedBinding {
  key: string
  meta: boolean
  shift: boolean
  alt: boolean
}

/**
 * localStorage key for the override map. We deliberately namespace with
 * a version suffix so a future breaking change (e.g. chord support) can
 * bump the key without inheriting incompatible saved state.
 */
export const STORAGE_KEY = 'chroxy_persist_shortcut_overrides_v1'

const MOD_CMD = new Set(['cmd', 'meta', 'ctrl', 'control'])
const MOD_SHIFT = 'shift'
const MOD_ALT = new Set(['alt', 'option', 'opt'])

/**
 * Normalise a binding string into a deterministic canonical form so
 * "Cmd+Shift+P", "shift+cmd+p" and "Meta+Shift+P" all compare equal.
 *
 * The output format is `[cmd+][shift+][alt+]<key>` with everything
 * lowercased.
 */
export function normalizeBinding(input: string): string {
  const parts = input.trim().toLowerCase().split('+').map(p => p.trim()).filter(Boolean)
  if (parts.length === 0) return ''
  let cmd = false, shift = false, alt = false
  let key = ''
  for (const part of parts) {
    if (MOD_CMD.has(part)) cmd = true
    else if (part === MOD_SHIFT) shift = true
    else if (MOD_ALT.has(part)) alt = true
    else key = part
  }
  // If the whole string was modifiers (no key) treat the last token as
  // the key — guards against pathological inputs like "cmd+cmd".
  if (!key && parts.length > 0) key = parts[parts.length - 1]!
  const out: string[] = []
  if (cmd) out.push('cmd')
  if (shift) out.push('shift')
  if (alt) out.push('alt')
  out.push(key)
  return out.join('+')
}

/**
 * Decompose a binding string into its match-time pieces. Consumers use
 * the returned struct to compare against a KeyboardEvent.
 */
export function parseBinding(input: string): ParsedBinding {
  const canonical = normalizeBinding(input)
  const parts = canonical.split('+')
  const key = parts[parts.length - 1] || ''
  return {
    key,
    meta: parts.includes('cmd'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  }
}

/**
 * Pretty-name lookup for KeyboardEvent.key values whose default
 * title-case rendering ("Arrowup", "Pageup") looks broken. Keys not in
 * this table fall back to the generic capitalisation rule below.
 *
 * #4941: introduced when the sidebar reorder shortcut (alt+arrowup /
 * alt+arrowdown) started appearing in the cheat sheet — the bare
 * title-case form rendered as "Option+Arrowup" which is visually wrong.
 */
const PRETTY_KEY_NAMES: Record<string, string> = {
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  space: 'Space',
  insert: 'Insert',
}

/**
 * Render a canonical binding ("cmd+shift+p") in a human-friendly form
 * for the UI. On macOS the modifier reads "Cmd", elsewhere "Ctrl".
 *
 * Single-character keys are uppercased; punctuation and longer key
 * names ("Enter", "Tab", "Escape") are normalised via PRETTY_KEY_NAMES
 * so the cheat sheet stays readable.
 */
export function formatBindingForDisplay(canonical: string, isMac: boolean): string {
  if (!canonical) return ''
  const parts = canonical.split('+')
  const out: string[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!
    if (part === 'cmd') out.push(isMac ? 'Cmd' : 'Ctrl')
    else if (part === 'shift') out.push('Shift')
    else if (part === 'alt') out.push(isMac ? 'Option' : 'Alt')
    else if (i === parts.length - 1) {
      // Final token is the key. Uppercase single ASCII letters; consult
      // PRETTY_KEY_NAMES for the W3C `KeyboardEvent.key` names whose
      // generic title-case rendering looks broken; otherwise leave
      // punctuation as-is and title-case the rest.
      if (/^[a-z]$/.test(part)) out.push(part.toUpperCase())
      else if (PRETTY_KEY_NAMES[part]) out.push(PRETTY_KEY_NAMES[part])
      else if (/^[a-z]/.test(part)) out.push(part.charAt(0).toUpperCase() + part.slice(1))
      else out.push(part)
    } else {
      out.push(part)
    }
  }
  return out.join('+')
}

interface KeyEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  /**
   * Optional event target — when provided, `matchEvent` respects each
   * shortcut's `disabledInTextInput` flag. KeyboardEvent already
   * carries `target` so the standard call site needs no extra plumbing.
   */
  target?: EventTarget | null
}

function isTextInputTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false
  const el = target as HTMLElement
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

export interface ShortcutRegistry {
  /** Return the list of definitions with their effective bindings. */
  list(): ShortcutListEntry[]
  /** Return the canonical effective binding for a shortcut id. */
  getBinding(id: string): string
  /** Get a single entry with its effective binding. Returns null if unknown. */
  get(id: string): ShortcutListEntry | null
  /**
   * Persist a new binding for a shortcut. Throws on scope conflict.
   *
   * Defers to `findConflict` for the collision check, so the same
   * `enabled()`-aware semantics apply: if `id` itself is currently
   * runtime-disabled, no conflict can be raised (its combo cannot
   * fire), and conflicts against other disabled defs are likewise
   * suppressed. The new binding is still persisted in either case.
   */
  setBinding(id: string, binding: string): void
  /** Remove the override, restoring the default. */
  resetBinding(id: string): void
  /** Remove every override. */
  resetAll(): void
  /**
   * Return the shortcut id (if any) that would collide if `id` was
   * bound to `binding`. Null = no conflict.
   *
   * Defs whose `enabled()` predicate returns false are skipped during
   * the scan — they cannot fire at runtime so they cannot collide.
   * This applies symmetrically to the target (`id`) and to every
   * other def in scope (#4431, #4442). Two mutually-exclusive
   * environment gates (e.g. a Tauri-only and a browser-only binding)
   * can therefore share a combo without a false-positive conflict.
   */
  findConflict(id: string, binding: string): ShortcutListEntry | null
  /**
   * Return the shortcut id whose binding matches a KeyboardEvent in
   * the given scope. Null = no match.
   */
  matchEvent(event: KeyEventLike, scope: ShortcutScope): string | null
  /** Subscribe to binding changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Return all definitions (immutable). */
  definitions(): readonly ShortcutDef[]
}

function loadOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) out[k] = normalizeBinding(v)
    }
    return out
  } catch {
    return {}
  }
}

function saveOverrides(overrides: Record<string, string>): void {
  try {
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    }
  } catch {
    /* localStorage unavailable (private mode, quota) — fail soft. */
  }
}

/**
 * Build a registry from a list of definitions. The registry is
 * standalone — there is no module-level singleton — which makes it
 * trivial to test and lets the consumer wire its own React lifecycle.
 */
export function createShortcutRegistry(defs: readonly ShortcutDef[]): ShortcutRegistry {
  // Defensive copy so callers can't mutate our definitions array.
  const definitions: ShortcutDef[] = defs.map(d => ({ ...d, defaultBinding: normalizeBinding(d.defaultBinding) }))
  let overrides: Record<string, string> = loadOverrides()
  const listeners = new Set<() => void>()

  const byId = new Map<string, ShortcutDef>()
  for (const d of definitions) byId.set(d.id, d)

  function getBinding(id: string): string {
    const override = overrides[id]
    if (override) return override
    const def = byId.get(id)
    return def?.defaultBinding ?? ''
  }

  function get(id: string): ShortcutListEntry | null {
    const def = byId.get(id)
    if (!def) return null
    const binding = getBinding(id)
    return { ...def, binding, isCustomized: binding !== def.defaultBinding }
  }

  function list(): ShortcutListEntry[] {
    return definitions.map(def => {
      const binding = getBinding(def.id)
      return { ...def, binding, isCustomized: binding !== def.defaultBinding }
    })
  }

  function findConflict(id: string, binding: string): ShortcutListEntry | null {
    const target = byId.get(id)
    if (!target) return null
    const canonical = normalizeBinding(binding)
    if (!canonical) return null
    // If the shortcut being bound is itself runtime-disabled, it can't
    // collide with anything — its combo will never fire. Symmetrically,
    // disabled defs below are skipped so two mutually-exclusive
    // environment gates (e.g. Tauri-only vs browser-only) can share a
    // combo without false conflicts (#4431).
    if (target.enabled && !target.enabled()) return null
    for (const def of definitions) {
      if (def.id === id) continue
      if (def.scope !== target.scope) continue
      // Skip runtime-disabled defs — they don't fire on this combo, so
      // they can't collide with the binding we're checking.
      if (def.enabled && !def.enabled()) continue
      if (getBinding(def.id) === canonical) {
        return { ...def, binding: canonical, isCustomized: getBinding(def.id) !== def.defaultBinding }
      }
    }
    return null
  }

  function emit() {
    for (const l of listeners) {
      try { l() } catch { /* listener errors must not break siblings */ }
    }
  }

  function setBinding(id: string, binding: string): void {
    const def = byId.get(id)
    if (!def) throw new Error(`Unknown shortcut id: ${id}`)
    const canonical = normalizeBinding(binding)
    if (!canonical) throw new Error('Empty binding')
    // Setting to the current effective value is a no-op (don't churn
    // localStorage, don't emit).
    if (getBinding(id) === canonical) return
    const conflict = findConflict(id, canonical)
    if (conflict) {
      throw new Error(
        `Binding conflict: "${canonical}" is already used by "${conflict.description}" (${conflict.id})`,
      )
    }
    if (canonical === def.defaultBinding) {
      // Resetting to the default — drop the override row instead of
      // storing a redundant copy.
      delete overrides[id]
    } else {
      overrides[id] = canonical
    }
    saveOverrides(overrides)
    emit()
  }

  function resetBinding(id: string): void {
    if (!(id in overrides)) return
    delete overrides[id]
    saveOverrides(overrides)
    emit()
  }

  function resetAll(): void {
    if (Object.keys(overrides).length === 0) return
    overrides = {}
    saveOverrides(overrides)
    emit()
  }

  function matchEvent(event: KeyEventLike, scope: ShortcutScope): string | null {
    const eventKey = (event.key || '').toLowerCase()
    const eventMeta = event.metaKey || event.ctrlKey
    const inTextInput = isTextInputTarget(event.target)
    for (const def of definitions) {
      if (def.scope !== scope) continue
      const binding = getBinding(def.id)
      const parsed = parseBinding(binding)
      if (
        parsed.key === eventKey &&
        parsed.meta === eventMeta &&
        parsed.shift === event.shiftKey &&
        parsed.alt === event.altKey
      ) {
        // Environment / context gates — applied after the combo match
        // so `enabled` and `disabledInTextInput` short-circuit cleanly
        // without affecting conflict detection.
        if (def.disabledInTextInput && inTextInput) continue
        if (def.enabled && !def.enabled()) continue
        return def.id
      }
    }
    return null
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  function definitionsReadonly(): readonly ShortcutDef[] {
    return definitions
  }

  return {
    list,
    getBinding,
    get,
    setBinding,
    resetBinding,
    resetAll,
    findConflict,
    matchEvent,
    subscribe,
    definitions: definitionsReadonly,
  }
}
