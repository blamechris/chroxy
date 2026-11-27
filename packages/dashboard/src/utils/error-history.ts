/**
 * #9235 — local, bounded history of dashboard errors, for Settings → Diagnostics.
 *
 * STANDALONE ON PURPOSE: this module must not import the Zustand store (or anything that
 * does). It runs when the store may be the thing that failed, and the ErrorBoundary uses it.
 *
 * What is stored. ONLY classifier output (`utils/error-report`): the allowlisted error name,
 * the matched engine template id and its re-rendered text (or `[message omitted]`), and
 * normalised stack frames. Raw error text and raw stacks are never written, in any field.
 * The set of trusted asset basenames is derived at capture time and again at read time from
 * the page's own loaded scripts; it is NEVER persisted.
 *
 * Storage is untrusted on the way back out. Every entry read is rebuilt field by field
 * (enums, ISO time, strict semver, bounded count) and its message and stack are run through
 * the classifier and normalisers again, so a poisoned localStorage value cannot reach the UI
 * or the clipboard raw.
 *
 * Asset provenance: a script URL joins the trusted set only if it is same-origin http(s), a
 * direct child of the directory this very module was served from (the dashboard's own
 * `assets/` directory), AND has Vite's hashed-asset name `<stem>-<8 hash chars>.js|.mjs`.
 * Resource-timing entries must also have been initiated by a script or a (module)preload link,
 * so an image or fetch that merely ends in `.js` is never trusted.
 *
 * Failure policy: nothing here throws to the caller and nothing logs (a `console.error` from
 * the recorder would be a feedback loop with the error listeners). When storage throws or
 * holds corrupt data, an in-memory ring with the same bounds serves for the page lifetime.
 */
import { isTauri } from './tauri'
import {
  classifyErrorMessage,
  formatErrorReport,
  normalizeComponentStack,
  normalizeStack,
  type AssetBasenames,
} from './error-report'

declare const __APP_VERSION__: string

export const ERROR_HISTORY_KEY = 'chroxy_error_history_v1'
export const MAX_HISTORY_ENTRIES = 20
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_COUNT = 9_999_999

export type ErrorCategory = 'render' | 'window-error' | 'unhandled-rejection'
export type ErrorPlatform = 'tauri' | 'web'

/** The stored (and returned) shape. Every field is classifier output or a validated scalar. */
export interface ErrorHistoryEntry {
  id: string
  /** ISO-8601 UTC, 3 fraction digits: the most recent occurrence. */
  time: string
  firstTime: string
  count: number
  category: ErrorCategory
  platform: ErrorPlatform
  /** Strict `d.d.d` semver, or `unknown`. */
  version: string
  name: string
  template: string | null
  text: string
  stack: string[]
  componentStack: string[]
}

const CATEGORIES: readonly string[] = ['render', 'window-error', 'unhandled-rejection']
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ID_RE = /^[a-z0-9]{1,12}$/
const MAX_STORED_LINES = 60
const MAX_STORED_LINE_CHARS = 256
/** A stored value larger than this is not ours (20 entries of normalised frames are a few KB). */
const MAX_STORED_BYTES = 64 * 1024
/** Storm control: at most this many recorded events per rolling second. */
const MAX_EVENTS_PER_SECOND = 10

// ---------------------------------------------------------------------------
// Trusted asset set (never persisted)
// ---------------------------------------------------------------------------

/**
 * Vite 7's default `build.rollupOptions.output.chunkFileNames/entryFileNames` is
 * `assets/[name]-[hash].js`, with an 8-character base64url hash (verified against
 * `vite build` output of this package: `index-Dvf46w8T.js`, `cose-bilkent-JH36ORCC-ywTmjP-W.js`;
 * `packages/dashboard/vite.config.ts` does not override the file names). A stem may itself
 * contain `-` and `.`.
 */
const HASHED_ASSET_RE = /^[A-Za-z0-9_.-]{1,72}-[A-Za-z0-9_-]{8}\.m?js$/
const MAX_RESOURCE_ENTRIES = 200

let moduleUrl: string | null = null
try {
  moduleUrl = import.meta.url
} catch {
  moduleUrl = null
}

/** Test seam: pretend this module was served from `url` (jsdom serves it from file://). */
export function __setModuleUrlForTests(url: string | null): void {
  moduleUrl = url
}

/** The directory (with trailing slash) this module was served from, if it is same-origin http(s). */
function ownAssetDir(origin: string): string | null {
  if (!moduleUrl) return null
  try {
    const u = new URL(moduleUrl)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== origin) return null
    const dir = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1)
    return dir.endsWith('/assets/') ? dir : null
  } catch {
    return null
  }
}

function admittedBasename(raw: unknown, origin: string, dir: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null
  try {
    const u = new URL(raw, origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.origin !== origin) return null
    if (!u.pathname.startsWith(dir)) return null
    const seg = u.pathname.slice(dir.length)
    if (seg.includes('/') || !HASHED_ASSET_RE.test(seg)) return null
    return seg
  } catch {
    return null
  }
}

/**
 * The dashboard's own loaded script basenames. Admission needs ALL of: same-origin http(s);
 * a direct child of this module's own `assets/` directory; Vite's hashed-asset name; and, for
 * resource-timing entries, a script or link (modulepreload) initiator. Computed on demand,
 * never stored. Outside a built bundle (dev server, tests) the set is empty, which makes
 * every frame location `<unknown>`.
 */
export function currentAssetBasenames(): Set<string> {
  const out = new Set<string>()
  try {
    if (typeof location === 'undefined' || typeof document === 'undefined') return out
    const origin = location.origin
    if (!origin || origin === 'null') return out
    const dir = ownAssetDir(origin)
    if (dir === null) return out
    const add = (raw: unknown): void => {
      const b = admittedBasename(raw, origin, dir)
      if (b) out.add(b)
    }
    try {
      for (const s of Array.from(document.scripts)) add(s.src)
    } catch { /* keep what we have */ }
    try {
      if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
        const entries = performance.getEntriesByType('resource')
        const n = Math.min(entries.length, MAX_RESOURCE_ENTRIES)
        for (let i = 0; i < n; i++) {
          const e = entries[i] as { name?: unknown; initiatorType?: unknown }
          if (e.initiatorType !== 'script' && e.initiatorType !== 'link') continue
          add(e.name)
        }
      }
    } catch { /* keep what we have */ }
    add(moduleUrl)
  } catch {
    // an empty set is fail-closed: every frame location becomes <unknown>
  }
  return out
}

// ---------------------------------------------------------------------------
// Entry construction and re-validation
// ---------------------------------------------------------------------------

function clientVersion(): string {
  try {
    const v = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null
    return typeof v === 'string' && VERSION_RE.test(v) ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

function currentPlatform(): ErrorPlatform {
  try {
    return isTauri() ? 'tauri' : 'web'
  } catch {
    return 'web'
  }
}

function shortId(seed: string): string {
  // FNV-1a, 32-bit, base36 — a local label, not a security primitive.
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(6, '0').slice(0, 6)
}

function dedupeKey(e: Pick<ErrorHistoryEntry, 'category' | 'name' | 'template' | 'text' | 'stack'>): string {
  return [e.category, e.name, e.template ?? '', e.text, e.stack[0] ?? ''].join('|')
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v.length !== 24 || !ISO_RE.test(v)) return null
  const ms = Date.parse(v)
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== v) return null
  return v
}

/** Set by revalidate when it clamps a future time; readAll then writes the clamped list back. */
let clampedOnRead = false

/**
 * Rebuild an entry from untrusted input. Returns null when it is not an object or has no
 * valid time. Message, stack and component stack go back through the classifier.
 */
function revalidate(raw: unknown, assets: AssetBasenames, nowMs: number): ErrorHistoryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const parsedTime = isoOrNull(r.time)
  if (parsedTime === null) return null
  // A future-dated time (clock change, poisoned value) is clamped to now so it ages out.
  const clamp = (t: string): string => {
    if (Date.parse(t) <= nowMs) return t
    clampedOnRead = true // the clamped value must be written back, or it would stay in the future
    return new Date(nowMs).toISOString()
  }
  const time = clamp(parsedTime)
  const firstTime = clamp(isoOrNull(r.firstTime) ?? time)
  const category = typeof r.category === 'string' && CATEGORIES.includes(r.category) ? (r.category as ErrorCategory) : null
  if (category === null) return null
  const platform: ErrorPlatform = r.platform === 'tauri' ? 'tauri' : 'web'
  const cls = classifyErrorMessage(r.name, r.text)
  const lines = (v: unknown): string => (Array.isArray(v)
    ? v.slice(0, MAX_STORED_LINES).filter((x): x is string => typeof x === 'string')
      .map(x => (x.length > MAX_STORED_LINE_CHARS ? x.slice(0, MAX_STORED_LINE_CHARS) : x)).join('\n')
    : '')
  const stack = normalizeStack(lines(r.stack), { assetBasenames: assets })
  const componentStack = normalizeComponentStack(lines(r.componentStack))
  const count = typeof r.count === 'number' && Number.isFinite(r.count)
    ? Math.max(1, Math.min(MAX_COUNT, Math.floor(r.count))) : 1
  const version = typeof r.version === 'string' && VERSION_RE.test(r.version) ? r.version : 'unknown'
  const id = typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : shortId(`${time}|${dedupeKey({ category, ...cls, stack })}`)
  return {
    id, time, firstTime, count, category, platform, version,
    name: cls.name, template: cls.template, text: cls.text, stack, componentStack,
  }
}

export interface ErrorSource {
  category: ErrorCategory
  error: unknown
  componentStack?: unknown
}

/** Classify a live error into a fresh entry (count 1). Never throws. */
function buildEntry(src: ErrorSource, assets: AssetBasenames, nowMs: number): ErrorHistoryEntry {
  const err = src.error instanceof Error ? src.error : null
  // A non-Error value (string, object, undefined) records the category only.
  const cls = classifyErrorMessage(err?.name, err?.message)
  const stack = err ? normalizeStack(err.stack, { assetBasenames: assets }) : []
  const componentStack = src.category === 'render' ? normalizeComponentStack(src.componentStack) : []
  const time = new Date(nowMs).toISOString()
  const category = src.category
  return {
    id: shortId(`${time}|${dedupeKey({ category, name: cls.name, template: cls.template, text: cls.text, stack })}`),
    time, firstTime: time, count: 1, category,
    platform: currentPlatform(), version: clientVersion(),
    name: cls.name, template: cls.template, text: cls.text, stack, componentStack,
  }
}

// ---------------------------------------------------------------------------
// Storage (with an in-memory fallback ring)
// ---------------------------------------------------------------------------
//
// Ring semantics. `memory` mirrors the last list this page wrote or read. It is AUTHORITATIVE
// only when storage is unavailable (getItem throws), or while `dirty`: a write failed, so the
// persisted value is older than the ring. A later successful write, or a clear, ends dirty.
// When storage works and the key is absent (another tab cleared it), the history is empty and
// the ring is dropped; it is never resurrected.

let memory: ErrorHistoryEntry[] = []
let dirty = false
let recording = false
let recent: number[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of Array.from(listeners)) {
    try { l() } catch { /* a bad listener must not break the recorder */ }
  }
}

function prune(list: ErrorHistoryEntry[], nowMs: number): ErrorHistoryEntry[] {
  const seen = new Set<string>()
  const out: ErrorHistoryEntry[] = []
  for (const e of list
    .filter(e => nowMs - Date.parse(e.time) <= HISTORY_MAX_AGE_MS)
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))) {
    if (seen.has(e.id)) continue // a duplicate id would expand two rows at once
    seen.add(e.id)
    out.push(e)
  }
  return out.slice(0, MAX_HISTORY_ENTRIES)
}

function revalidateAll(list: unknown[], assets: AssetBasenames, nowMs: number): ErrorHistoryEntry[] {
  return list.map(e => revalidate(e, assets, nowMs)).filter((e): e is ErrorHistoryEntry => e !== null)
}

function persist(list: ErrorHistoryEntry[]): boolean {
  try {
    if (list.length === 0) localStorage.removeItem(ERROR_HISTORY_KEY)
    else localStorage.setItem(ERROR_HISTORY_KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

function readAll(assets: AssetBasenames, nowMs: number): ErrorHistoryEntry[] {
  let text: string | null
  try {
    text = localStorage.getItem(ERROR_HISTORY_KEY)
  } catch {
    // storage unavailable: the ring is all there is
    return prune(revalidateAll(memory, assets, nowMs), nowMs)
  }
  if (dirty) return prune(revalidateAll(memory, assets, nowMs), nowMs)
  if (text === null) {
    memory = []
    return []
  }
  let parsed: unknown
  if (text.length <= MAX_STORED_BYTES) {
    try { parsed = JSON.parse(text) } catch { parsed = undefined }
  }
  if (!Array.isArray(parsed)) {
    // oversized, corrupt or an unexpected shape: reset to empty
    memory = []
    try { localStorage.removeItem(ERROR_HISTORY_KEY) } catch { /* ignore */ }
    return []
  }
  clampedOnRead = false
  const clean = prune(revalidateAll(parsed.slice(0, MAX_HISTORY_ENTRIES * 3), assets, nowMs), nowMs)
  memory = clean
  // Expiry deletes, it does not just hide: write back whenever anything was dropped.
  if (clean.length !== parsed.length || clampedOnRead) persist(clean)
  return clean
}

function writeAll(list: ErrorHistoryEntry[]): void {
  memory = list
  dirty = !persist(list)
}

/** Recent errors, newest first, every field re-validated. Never throws. */
export function readErrorHistory(assets?: AssetBasenames, nowMs: number = Date.now()): ErrorHistoryEntry[] {
  try {
    return readAll(assets ?? currentAssetBasenames(), nowMs)
  } catch {
    return []
  }
}

/** Drop expired entries from storage now (called once at install). */
export function pruneErrorHistory(): void {
  readErrorHistory()
}

function overStormBudget(nowMs: number): boolean {
  recent = recent.filter(t => nowMs - t < 1000 && t <= nowMs)
  if (recent.length >= MAX_EVENTS_PER_SECOND) return true
  recent.push(nowMs)
  return false
}

/** Record one error. Never throws, never logs, and drops nested or storm-rate calls. */
export function recordDashboardError(src: ErrorSource): void {
  if (recording) return
  recording = true
  try {
    const nowMs = Date.now()
    if (overStormBudget(nowMs)) return
    const assets = currentAssetBasenames()
    const entry = buildEntry(src, assets, nowMs)
    if (entry.template === 'resize-observer-loop') return // browser noise, not a defect
    const list = readAll(assets, nowMs)
    const key = dedupeKey(entry)
    const i = list.findIndex(e => dedupeKey(e) === key)
    let next: ErrorHistoryEntry[]
    if (i >= 0) {
      const prev = list[i]!
      const bumped: ErrorHistoryEntry = {
        ...prev, count: Math.min(MAX_COUNT, prev.count + 1), time: entry.time,
        version: entry.version, platform: entry.platform,
        componentStack: entry.componentStack.length > 0 ? entry.componentStack : prev.componentStack,
      }
      next = [bumped, ...list.slice(0, i), ...list.slice(i + 1)]
    } else {
      // A 32-bit hash can collide: re-hash until the id is unique among retained entries.
      let n = 0
      while (list.some(e => e.id === entry.id) && n < 50) entry.id = shortId(`${entry.id}#${++n}`)
      next = [entry, ...list]
    }
    writeAll(prune(next, nowMs))
    notify()
  } catch {
    // the recorder must never be the second failure
  } finally {
    recording = false
  }
}

/** Remove the stored history and the in-memory ring. */
export function clearErrorHistory(): void {
  memory = []
  let removed = true
  try { localStorage.removeItem(ERROR_HISTORY_KEY) } catch { removed = false }
  // If storage could not be cleared, the (empty) ring stays authoritative.
  dirty = !removed
  notify()
}

/** Subscribe to history changes (the open Diagnostics view). Returns an unsubscribe. */
export function subscribeErrorHistory(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Another tab wrote or cleared the key: a mirror ring is stale, and open views must refresh.
if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (ev: StorageEvent) => {
      if (ev.key !== null && ev.key !== ERROR_HISTORY_KEY) return
      if (!dirty) memory = []
      notify()
    })
  } catch { /* no window events: the view just refreshes on its own renders */ }
}

/** The exact Copy-report text for a stored entry (re-validated again by the formatter). */
export function formatHistoryEntry(entry: ErrorHistoryEntry, assets?: AssetBasenames): string {
  return formatErrorReport({
    time: entry.time, version: entry.version, platform: entry.platform, category: entry.category,
    count: entry.count, name: entry.name, message: entry.text, stack: entry.stack,
    componentStack: entry.componentStack,
  }, { assetBasenames: assets ?? currentAssetBasenames() })
}

/** The Copy-report text for a live error (the ErrorBoundary fallback), built from classifier output only. */
export function formatLiveErrorReport(src: ErrorSource, timeMs: number = Date.now()): string {
  try {
    const assets = currentAssetBasenames()
    return formatHistoryEntry(buildEntry(src, assets, timeMs), assets)
  } catch {
    return 'Chroxy dashboard error report\nMessage: [message omitted]'
  }
}

/** Test seam: drop the in-memory ring and listeners. */
export function __resetErrorHistoryForTests(): void {
  memory = []
  dirty = false
  recording = false
  recent = []
  listeners.clear()
}
