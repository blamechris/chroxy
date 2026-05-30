/**
 * SettingsPanel — slide-out panel with theme picker and session defaults.
 *
 * Triggered via gear icon in header or Cmd+,. Changes apply instantly
 * and persist to localStorage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import { ShortcutsSection } from '../shortcuts/ShortcutsSection'
import { getAvailableThemes, applyTheme } from '../theme/theme-engine'
import { getThemeById } from '../theme/themes'
import type { ThemeDefinition } from '../theme/themes'
import { PROVIDER_LABELS } from '../lib/provider-labels'
import { buildQuietHoursTimezoneList } from '@chroxy/store-core'
import { isTauri } from '../utils/tauri'
import {
  getTunnelMode,
  setTunnelMode,
  restartServer,
  getServerInfo,
  getAllowAutoPermissionMode,
  setAllowAutoPermissionMode,
} from '../hooks/useTauriIPC'

/** Confirmation copy from issue #3077 — keep verbatim. */
const AUTO_PERMISSION_CONFIRM_MESSAGE =
  'Auto-permission mode disables all per-tool prompts for non-paired clients. Continue?'

/**
 * #4542: friendly labels + ordering for the per-category notification
 * toggles. Keys MUST match the server-side `ALL_CATEGORIES` enum from
 * packages/server/src/notification-prefs.js (mirrors RATE_LIMITS in
 * push.js). Unknown keys from the snapshot fall back to the raw key name
 * so a future server-side category isn't silently hidden.
 */
const NOTIFICATION_CATEGORY_LABELS: Record<string, { label: string; hint?: string }> = {
  permission: {
    label: 'Permission requests',
    hint: 'Tool-use prompts that need an allow / deny decision.',
  },
  result: {
    label: 'Task completion',
    hint: 'Sent when a Claude turn finishes and no one is watching.',
  },
  activity_update: {
    label: 'Activity updates',
    hint: 'Foreground task progress while you are away.',
  },
  activity_waiting: {
    label: 'Waiting for input',
    hint: 'Claude asked a question or is paused on a prompt.',
  },
  activity_error: {
    label: 'Session errors',
    hint: 'Crashes, tunnel drops, and unrecoverable session failures.',
  },
  inactivity_warning: {
    label: 'Inactivity warnings',
    hint: 'Heads-up before a long-idle session is auto-paused.',
  },
  live_activity: {
    label: 'Live Activity (iOS)',
    hint: 'iOS Dynamic Island / lock-screen Live Activity updates.',
  },
}

/** Render order for known categories. Unknown keys append at the end in snapshot order. */
const NOTIFICATION_CATEGORY_ORDER = [
  'permission',
  'activity_waiting',
  'activity_error',
  'activity_update',
  'inactivity_warning',
  'result',
  'live_activity',
]

/**
 * #4544: documented defaults for the quiet-hours bypass list. Mirrors
 * `DEFAULT_BYPASS_CATEGORIES` from packages/server/src/notification-prefs.js.
 * Used when a snapshot omits the field (older server, fresh install) so
 * the UI shows the right initial checkboxes.
 */
const DEFAULT_BYPASS_CATEGORIES = ['permission', 'activity_error']

/**
 * #4544: timezone picker options. The curated short-list lives in
 * `@chroxy/store-core` (#4569) so the dashboard and mobile pickers share a
 * single source of truth. We prepend the browser-resolved zone here so the
 * user can pick "this device" without scrolling, and tag the matching entry
 * with the trailing label.
 *
 * `Intl.supportedValuesOf('timeZone')` returns the full set on modern
 * browsers — kept in mind for a future searchable combobox.
 */
function getQuietHoursTimezoneOptions(): { value: string; label: string }[] {
  const browser = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
  })()
  return buildQuietHoursTimezoneList(browser).map((tz) => ({
    value: tz,
    label: tz === browser ? `${tz} (this device)` : tz,
  }))
}

export interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
  showConsoleTab?: boolean
  onToggleConsoleTab?: (show: boolean) => void
}

/**
 * #4544: quiet-hours editor — start/end/timezone + per-category bypass list.
 *
 * Owns its own form state so partial edits (e.g. typing into start before
 * committing) don't round-trip every keystroke through the WS. On `Save` we
 * fire `onWindowChange` once; on `Disable` we send `null`. The bypass
 * checkboxes patch immediately because they're individual booleans that
 * don't benefit from a Save buffer.
 *
 * #4570: snapshots arriving mid-edit must not clobber the unsaved draft.
 * We track a `dirty` flag (true after the user touches any field, false
 * after Save / Disable / explicit accept). When dirty AND an incoming
 * snapshot diverges from the user's draft, we hold the draft and surface
 * a conflict banner with accept (keep mine) / discard (take theirs).
 */
function QuietHoursEditor(props: {
  window: { start: string; end: string; timezone: string } | null
  categories: Record<string, boolean>
  bypassCategories: string[]
  onWindowChange: (w: { start: string; end: string; timezone: string } | null) => void
  onBypassChange: (categories: string[]) => void
}) {
  const { window: win, categories, bypassCategories, onWindowChange, onBypassChange } = props
  const tzOptions = useMemo(() => getQuietHoursTimezoneOptions(), [])
  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
  }, [])

  // Draft state. Seeded from the snapshot so reopening the panel after a
  // remote change reflects the broadcast snapshot, not stale edits.
  const [enabled, setEnabled] = useState<boolean>(win != null)
  const [start, setStart] = useState<string>(win?.start ?? '22:00')
  const [end, setEnd] = useState<string>(win?.end ?? '07:00')
  const [timezone, setTimezone] = useState<string>(win?.timezone ?? browserTz)

  // #4570: dirty flips on any edit and clears on save/disable/accept.
  // The snapshot effect below reads dirty via a ref so we don't add it to
  // the dependency array (which would re-run the effect when dirty changes
  // and re-apply the snapshot we were trying to skip).
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(dirty)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  // #4570: when a snapshot lands while the draft is dirty AND its values
  // diverge from the user's draft, we hold the snapshot here and render
  // the conflict banner. Null = no pending conflict.
  const [pendingSnapshot, setPendingSnapshot] = useState<
    | { start: string; end: string; timezone: string }
    | null
    | undefined
  >(undefined)

  // Re-sync draft when the snapshot changes (e.g. another client saved a
  // window or the user just hit Save and the broadcast came back). The
  // dependency array intentionally captures the inner fields; comparing
  // object identity wouldn't help since the message-handler always builds
  // a fresh object.
  //
  // #4570: skip the apply when the editor is dirty AND the incoming
  // snapshot diverges from the local draft. Park the snapshot so the user
  // can resolve via the conflict banner.
  useEffect(() => {
    const isDirty = dirtyRef.current
    const matchesDraft = win
      ? (win.start === start && win.end === end && win.timezone === timezone && enabled)
      : !enabled
    if (isDirty && !matchesDraft) {
      // Hold the snapshot for the user to resolve. We intentionally do NOT
      // overwrite the draft fields.
      setPendingSnapshot(win)
      return
    }
    // Clean apply (or snapshot already matches draft — e.g. Save echo).
    setEnabled(win != null)
    if (win) {
      setStart(win.start)
      setEnd(win.end)
      setTimezone(win.timezone)
    }
    setPendingSnapshot(undefined)
    setDirty(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win])

  const handleToggleEnable = useCallback((next: boolean) => {
    setEnabled(next)
    setDirty(false)
    setPendingSnapshot(undefined)
    if (!next) {
      // Sending null on disable wipes the persisted window so the server
      // gate short-circuits. Draft fields stay in form state so the user
      // can re-enable without re-typing.
      onWindowChange(null)
    } else if (win == null) {
      // First-time enable: persist the current draft (defaults
      // 22:00-07:00 in browser TZ) so the user sees something
      // immediately rather than an empty muted toggle.
      onWindowChange({ start, end, timezone })
    }
  }, [win, start, end, timezone, onWindowChange])

  const handleSaveWindow = useCallback(() => {
    setDirty(false)
    setPendingSnapshot(undefined)
    onWindowChange({ start, end, timezone })
  }, [start, end, timezone, onWindowChange])

  // #4570: user keeps their local draft — discard the parked snapshot.
  // The next divergent snapshot will surface the banner again.
  const handleAcceptDraft = useCallback(() => {
    setPendingSnapshot(undefined)
  }, [])

  // #4570: user takes the remote snapshot — overwrite draft + clear dirty.
  const handleDiscardDraft = useCallback(() => {
    const snap = pendingSnapshot
    if (snap === undefined) return
    setEnabled(snap != null)
    if (snap) {
      setStart(snap.start)
      setEnd(snap.end)
      setTimezone(snap.timezone)
    }
    setDirty(false)
    setPendingSnapshot(undefined)
  }, [pendingSnapshot])

  // #4570: dirty-tracking wrappers around the field setters so every edit
  // path flips the flag without sprinkling setDirty() through JSX.
  const setStartDirty = useCallback((next: string) => { setStart(next); setDirty(true) }, [])
  const setEndDirty = useCallback((next: string) => { setEnd(next); setDirty(true) }, [])
  const setTimezoneDirty = useCallback((next: string) => { setTimezone(next); setDirty(true) }, [])

  const handleToggleBypass = useCallback((cat: string, next: boolean) => {
    const set = new Set(bypassCategories)
    if (next) set.add(cat)
    else set.delete(cat)
    onBypassChange([...set])
  }, [bypassCategories, onBypassChange])

  // Surface every known + currently-bypassing category — the user can
  // re-enable a bypass even if it's not in the active categories map.
  const bypassCandidates = useMemo(() => {
    const known = NOTIFICATION_CATEGORY_ORDER.filter((k) => k in categories || bypassCategories.includes(k))
    const extras = bypassCategories.filter((k) => !NOTIFICATION_CATEGORY_ORDER.includes(k) && !(k in categories))
    return [...known, ...extras]
  }, [categories, bypassCategories])

  return (
    <div className="quiet-hours-editor" data-testid="quiet-hours-editor">
      <div className="settings-field settings-field-checkbox">
        <label htmlFor="quiet-hours-enabled">
          <input
            id="quiet-hours-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => handleToggleEnable(e.target.checked)}
            data-testid="quiet-hours-enabled-toggle"
          />
          Quiet hours
        </label>
        <p className="settings-hint">
          Mute pushes during a fixed window each day. Operator-blocking
          categories (permission prompts, session errors) still fire by
          default — uncheck them below to silence them too.
        </p>
      </div>
      {enabled && (
        <>
          {pendingSnapshot !== undefined && (
            <div
              className="settings-hint quiet-hours-conflict-banner"
              role="alert"
              data-testid="quiet-hours-conflict-banner"
            >
              <p>
                Another client updated quiet hours while you were editing.
                Keep your unsaved changes, or discard them and load the
                latest values?
              </p>
              <div className="settings-field">
                <button
                  type="button"
                  onClick={handleAcceptDraft}
                  data-testid="quiet-hours-conflict-accept"
                >
                  Keep my edits
                </button>
                <button
                  type="button"
                  onClick={handleDiscardDraft}
                  data-testid="quiet-hours-conflict-discard"
                >
                  Discard and load latest
                </button>
              </div>
            </div>
          )}
          <div className="settings-field">
            <label htmlFor="quiet-hours-start">From</label>
            <input
              id="quiet-hours-start"
              type="time"
              value={start}
              onChange={(e) => setStartDirty(e.target.value)}
              data-testid="quiet-hours-start-input"
            />
          </div>
          <div className="settings-field">
            <label htmlFor="quiet-hours-end">To</label>
            <input
              id="quiet-hours-end"
              type="time"
              value={end}
              onChange={(e) => setEndDirty(e.target.value)}
              data-testid="quiet-hours-end-input"
            />
          </div>
          <div className="settings-field">
            <label htmlFor="quiet-hours-timezone">Timezone</label>
            <select
              id="quiet-hours-timezone"
              value={timezone}
              onChange={(e) => setTimezoneDirty(e.target.value)}
              data-testid="quiet-hours-timezone-select"
            >
              {tzOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="settings-field">
            <button
              type="button"
              onClick={handleSaveWindow}
              data-testid="quiet-hours-save-button"
              disabled={start === (win?.start ?? '') && end === (win?.end ?? '') && timezone === (win?.timezone ?? '')}
            >
              Save quiet hours
            </button>
          </div>
          <fieldset className="quiet-hours-bypass" data-testid="quiet-hours-bypass-fieldset">
            <legend>Bypass during quiet hours</legend>
            <p className="settings-hint">
              Categories checked here still fire even at 3am. Uncheck to
              silence them.
            </p>
            <ul className="notification-prefs-list">
              {bypassCandidates.map((cat) => {
                const meta = NOTIFICATION_CATEGORY_LABELS[cat]
                const label = meta?.label ?? cat
                const checked = bypassCategories.includes(cat)
                const toggleId = `quiet-hours-bypass-${cat}`
                return (
                  <li key={cat} className="settings-field settings-field-checkbox">
                    <label htmlFor={toggleId}>
                      <input
                        id={toggleId}
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => handleToggleBypass(cat, e.target.checked)}
                        data-testid={`quiet-hours-bypass-toggle-${cat}`}
                      />
                      {label}
                    </label>
                  </li>
                )
              })}
            </ul>
          </fieldset>
        </>
      )}
    </div>
  )
}

/**
 * #4564: token label truncation. Expo push tokens look like
 * `ExponentPushToken[~40-base64-chars]` — too wide to read in a settings
 * row. Trim to a stable first-N prefix plus an ellipsis so the user can
 * still match the row against a clear action without exposing the full
 * token. The displayed prefix length (24 chars) keeps `ExponentPushToken[`
 * (18 chars) plus a few discriminating characters of the inner token —
 * enough to distinguish two simultaneously-registered devices from the
 * same vendor.
 */
function truncateDeviceLabel(key: string): string {
  const MAX = 24
  if (key.length <= MAX) return key
  return `${key.slice(0, MAX)}…`
}

/**
 * #4564: list of currently-known per-device override entries with a
 * per-row "Clear" button. Lets the user drain orphans accumulated when a
 * push token refreshes, an app reinstalls, or a browser tab loses its
 * `chroxy_device_id` — without those there's no way to remove a stale
 * entry short of hand-editing `~/.chroxy/notification-prefs.json`.
 *
 * Render contract:
 *   - Always renders (even when empty) so users can find the affordance
 *     once they DO accumulate orphans.
 *   - Tags the row matching `currentDeviceKey` as "this device" so a
 *     misclick on the wrong row doesn't surprise the operator by muting
 *     the device they're currently using.
 *   - Truncates long tokens via `truncateDeviceLabel` so the list stays
 *     readable; the full token is intentionally not shown — operators
 *     who want to verify before clearing can read the prefs file.
 */
function KnownDevicesList(props: {
  devices: Record<string, {
    categories?: Record<string, boolean>
    quietHours?: { start: string; end: string; timezone: string } | null
    bypassCategories?: string[]
  }>
  currentDeviceKey: string | null
  onClear: (deviceKey: string) => void
}) {
  const { devices, currentDeviceKey, onClear } = props
  // Stable order: render the current device first (so the user reaches
  // their own row without scrolling), then other tokens lexicographically
  // for a deterministic ordering across reloads.
  const keys = Object.keys(devices)
  const sorted = keys.slice().sort((a, b) => {
    if (a === currentDeviceKey) return -1
    if (b === currentDeviceKey) return 1
    return a.localeCompare(b)
  })

  return (
    <fieldset
      className="settings-fieldset notification-prefs-devices"
      data-testid="notification-prefs-devices-list"
    >
      <legend>Per-device overrides</legend>
      <p className="settings-hint">
        Each entry is a device (browser tab or mobile app) that has set its
        own notification preferences. Clear an entry to drop its overrides —
        useful when a push token refreshes or an app is reinstalled and the
        old entry becomes orphaned.
      </p>
      {sorted.length === 0 ? (
        <p
          className="settings-hint"
          data-testid="notification-prefs-devices-empty"
        >
          No per-device overrides yet. Mute a category on this device above to
          create one.
        </p>
      ) : (
        <ul className="notification-prefs-devices-list">
          {sorted.map(key => {
            const isCurrent = key === currentDeviceKey
            return (
              <li
                key={key}
                className="notification-prefs-device-entry"
                data-testid={`notification-prefs-device-entry-${key}`}
              >
                <span className="notification-prefs-device-label">
                  <code>{truncateDeviceLabel(key)}</code>
                  {isCurrent && (
                    <span className="notification-prefs-device-self-tag"> (this device)</span>
                  )}
                </span>
                <button
                  type="button"
                  className="notification-prefs-device-clear"
                  onClick={() => onClear(key)}
                  data-testid={`notification-prefs-device-clear-${key}`}
                >
                  Clear
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </fieldset>
  )
}

/** Preview swatches for a theme */
function ThemeSwatches({ theme }: { theme: ThemeDefinition }) {
  const bg = theme.colors['bg-primary'] || '#0f0f1a'
  const accent = theme.colors['accent-blue'] || '#4a9eff'
  const text = theme.colors['text-primary'] || '#ffffff'
  const termBg = theme.terminal.background
  const termFg = theme.terminal.foreground

  return (
    <div className="theme-swatches">
      <span className="theme-swatch" style={{ backgroundColor: bg }} title="Background" />
      <span className="theme-swatch" style={{ backgroundColor: accent }} title="Accent" />
      <span className="theme-swatch" style={{ backgroundColor: text }} title="Text" />
      <span className="theme-swatch" style={{ backgroundColor: termBg, border: `1px solid ${termFg}` }} title="Terminal" />
      <span className="theme-swatch" style={{ backgroundColor: termFg }} title="Terminal text" />
    </div>
  )
}

export function SettingsPanel({ isOpen, onClose, showConsoleTab, onToggleConsoleTab }: SettingsPanelProps) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const activeTheme = useConnectionStore(s => s.activeTheme)
  const setTheme = useConnectionStore(s => s.setTheme)
  const defaultProvider = useConnectionStore(s => s.defaultProvider)
  const setDefaultProvider = useConnectionStore(s => s.setDefaultProvider)
  const defaultModel = useConnectionStore(s => s.defaultModel)
  const setDefaultModel = useConnectionStore(s => s.setDefaultModel)
  const availableModels = useConnectionStore(s => s.availableModels ?? [])
  const availableProviders = useConnectionStore(s => s.availableProviders ?? [])
  const inputSettings = useConnectionStore(s => s.inputSettings)
  const updateInputSettings = useConnectionStore(s => s.updateInputSettings)
  // Per-session promptEvaluator toggle. Lives in settings (not the header)
  // so the "Auto-evaluate prompts before send" label has room for a hint
  // line and doesn't crowd the model/permission selects. Only shown when
  // the active session reports a boolean `promptEvaluator` field —
  // older servers (pre-#3185) omit it, in which case we'd be rendering
  // a non-functional control.
  const activeSessionId = useConnectionStore(s => s.activeSessionId)
  const sessions = useConnectionStore(s => s.sessions)
  const setPromptEvaluator = useConnectionStore(s => s.setPromptEvaluator)
  // #3805: per-session Chroxy context hint toggle. Opt-in by default —
  // when on, the server prepends a short paragraph to the system prompt
  // telling the model it's running inside Chroxy so it can adjust
  // output for mobile clients (narrower code blocks, no wide ASCII
  // diagrams). Only shown when the active session reports a boolean
  // `chroxyContextHint` field; older servers (pre-#3805) omit it.
  const setChroxyContextHint = useConnectionStore(s => s.setChroxyContextHint)
  // #4052: BYOK credentials state + actions. Status arrives via the WS
  // byok_credentials_status message; the raw key is never stored — only
  // the masked preview.
  const byokCredentialsStatus = useConnectionStore(s => s.byokCredentialsStatus)
  const refreshByokCredentialsStatus = useConnectionStore(s => s.refreshByokCredentialsStatus)
  const setByokCredentials = useConnectionStore(s => s.setByokCredentials)
  const clearByokCredentials = useConnectionStore(s => s.clearByokCredentials)
  // #4542: per-category notification preferences. Snapshot arrives via the
  // WS `notification_prefs` message; the panel sends `notification_prefs_get`
  // on open and `notification_prefs_set` on every toggle. Server broadcasts
  // the merged snapshot so other clients stay in lockstep.
  const notificationPrefs = useConnectionStore(s => s.notificationPrefs)
  const refreshNotificationPrefs = useConnectionStore(s => s.refreshNotificationPrefs)
  const setNotificationPrefsCategory = useConnectionStore(s => s.setNotificationPrefsCategory)
  // #4543: per-device opt-in/out. `currentDeviceKey` is the stable
  // localStorage id used to address THIS browser tab in the per-device
  // override map. Null means we never minted a key (storage unavailable);
  // when null, the per-device toggle row is suppressed entirely so we never
  // ship a `devices[""]` / `devices[null]` patch.
  const currentDeviceKey = useConnectionStore(s => s.currentDeviceKey)
  const setNotificationPrefsDevice = useConnectionStore(s => s.setNotificationPrefsDevice)
  // #4564: drop an entire per-device entry — the "Clear" buttons in the
  // known-devices list call this to drain orphans left by token refresh,
  // app reinstall, or browser storage wipe. Sends the null sentinel
  // (`devices: { [token]: null }`) which the server interprets as delete.
  const deleteNotificationPrefsDevice = useConnectionStore(s => s.deleteNotificationPrefsDevice)
  // #4544: quiet-hours editor actions. The window is global (per-device
  // overrides are a future iteration owned by #4543); `bypassCategories`
  // is the list of categories that fire even during quiet hours.
  const setNotificationPrefsQuietHours = useConnectionStore(s => s.setNotificationPrefsQuietHours)
  const setNotificationPrefsBypassCategories = useConnectionStore(s => s.setNotificationPrefsBypassCategories)
  // #4560: capability gate for the Notifications section. Pre-#4541 servers
  // have no `notification_prefs_get` handler; firing the request was a
  // fire-and-forget no-op that left the section stuck on "Loading
  // preferences…" forever. Mirrors the per-capability pattern already used
  // by skillTrustAccept / skillTrustGrant (App.tsx), gated server-wide
  // rather than per-session. Default to fail-closed: an empty map (older
  // server, or pre-connect) reads as "feature not supported" so the user
  // sees an explicit "needs a newer server" message instead of dead UI.
  const notificationPrefsSupported = useConnectionStore(s => !!s.serverCapabilities?.notificationPrefs)
  const activeSessionPromptEvaluator = sessions.find(s => s.sessionId === activeSessionId)?.promptEvaluator
  // #3805: same capability gate pattern as promptEvaluator — only
  // render the toggle when the active session reports the boolean
  // field. Older servers omit it; rendering a non-functional control
  // would mislead.
  const activeSessionChroxyContextHint = sessions.find(s => s.sessionId === activeSessionId)?.chroxyContextHint
  const themes = getAvailableThemes()
  const inTauri = isTauri()
  const [tunnelMode, setTunnelModeState] = useState<string>('none')
  const [tunnelError, setTunnelError] = useState<string | null>(null)
  const [serverTunnelMode, setServerTunnelMode] = useState<string>('none')
  const [restarting, setRestarting] = useState(false)
  // #4052: paste-API-key form state. Lives in the component (not the
  // store) so the raw key is never observable beyond this one render.
  const [byokKeyInput, setByokKeyInput] = useState('')
  const [byokError, setByokError] = useState<string | null>(null)
  // #4559: inline "server disconnected" warning surfaced when a BYOK or
  // notification-prefs WS write fires while `socket.readyState !== OPEN`.
  // Pre-#4559 these actions silently no-op'd and the toggle reverted, so
  // the user saw nothing to explain why their change didn't stick. Split
  // into two state vars so a stale BYOK error doesn't bleed into the
  // notifications section (and vice versa) — each section owns its own
  // banner that clears the next time a successful write goes out.
  const [byokWsClosedError, setByokWsClosedError] = useState<string | null>(null)
  const [notifWsClosedError, setNotifWsClosedError] = useState<string | null>(null)
  const [allowAutoPerm, setAllowAutoPerm] = useState<boolean>(false)
  const [autoPermError, setAutoPermError] = useState<string | null>(null)
  const [autoPermDirty, setAutoPermDirty] = useState<boolean>(false)
  const [autoPermSaving, setAutoPermSaving] = useState<boolean>(false)

  // #4559: shared copy for the inline "server disconnected" banner so the
  // BYOK and notifications sections stay in lockstep on phrasing. Mentions
  // the exact recovery path (wait for reconnect, then retry) so the user
  // doesn't need to dig through docs to know what to do next.
  const WS_CLOSED_MESSAGE =
    'Settings save failed — server disconnected. Reconnect and try again.'

  // Load tunnel mode from Tauri settings and running server on open
  useEffect(() => {
    if (!isOpen || !inTauri) return
    setTunnelError(null)
    setRestarting(false)
    setAutoPermError(null)
    setAutoPermDirty(false)
    setAutoPermSaving(false)
    // Read saved setting (what user selected)
    getTunnelMode().then(mode => {
      if (mode) setTunnelModeState(mode)
    })
    // Read running server's actual mode (may differ if not restarted)
    getServerInfo().then(info => {
      if (info?.tunnelMode) setServerTunnelMode(info.tunnelMode)
    })
    // Read current auto-permission flag from ~/.chroxy/config.json
    getAllowAutoPermissionMode().then(value => {
      if (value !== null) setAllowAutoPerm(value)
    }).catch(err => {
      setAutoPermError(err instanceof Error ? err.message : String(err))
    })
  }, [isOpen, inTauri])

  // #4052: Pull the latest credentials status whenever the panel opens so
  // it's accurate even after an out-of-band change (e.g. the user edited
  // ~/.chroxy/credentials.json directly in another terminal).
  //
  // #4559: ignore the boolean return here intentionally — a closed socket
  // on panel open is the common case (Settings can be opened while the
  // ConnectionPhase is still 'reconnecting'). The banner only fires for
  // user-initiated writes; the refresh path quietly retries on the next
  // open or when notificationPrefs/byokCredentialsStatus actually need it.
  useEffect(() => {
    if (!isOpen) return
    refreshByokCredentialsStatus()
  }, [isOpen, refreshByokCredentialsStatus])

  // #4542: Pull the latest notification prefs on open. Out-of-band changes
  // (other dashboard / mobile client setting a category) are pushed via the
  // server's broadcast after every `notification_prefs_set`, so once
  // connected we stay in sync without polling.
  //
  // #4560: skip the refresh entirely when the server doesn't advertise the
  // `notificationPrefs` capability — pre-#4541 servers have no handler for
  // `notification_prefs_get`, so the request would either get rejected as
  // an `unknown_message` error or be silently dropped. Either way the
  // section never receives a snapshot and the loading hint sits forever.
  // Skipping the WS write keeps the server logs clean and makes the gated
  // render decisions self-consistent.
  useEffect(() => {
    if (!isOpen) return
    if (!notificationPrefsSupported) return
    refreshNotificationPrefs()
  }, [isOpen, notificationPrefsSupported, refreshNotificationPrefs])

  // #4559: clear the inline "server disconnected" banners when the panel
  // closes so re-opening Settings starts from a clean slate. A stale
  // banner from a prior open would confuse the user if the connection has
  // since recovered — the next interaction will surface a fresh banner if
  // the socket is still closed.
  useEffect(() => {
    if (isOpen) return
    setByokWsClosedError(null)
    setNotifWsClosedError(null)
  }, [isOpen])

  const handleSaveByokKey = useCallback(() => {
    setByokError(null)
    const trimmed = byokKeyInput.trim()
    if (!trimmed.startsWith('sk-ant-')) {
      setByokError('Anthropic API keys start with "sk-ant-".')
      return
    }
    // #4559: surface inline error when the WS is closed instead of the
    // pre-existing silent no-op. Clear the input only on a successful
    // send so the user can retry without re-pasting.
    const sent = setByokCredentials(trimmed)
    if (sent) {
      setByokWsClosedError(null)
      setByokKeyInput('')
    } else {
      setByokWsClosedError(WS_CLOSED_MESSAGE)
    }
  }, [byokKeyInput, setByokCredentials])

  const handleClearByokKey = useCallback(() => {
    setByokError(null)
    // #4559: same fail-loud contract as Save.
    const sent = clearByokCredentials()
    if (sent) setByokWsClosedError(null)
    else setByokWsClosedError(WS_CLOSED_MESSAGE)
  }, [clearByokCredentials])

  // #4559: notification-prefs wrappers. Each handler delegates to the
  // store action (which returns `true` when sent, `false` when the WS is
  // closed) and updates the inline banner accordingly. Sharing the
  // wrappers across all four prefs setters keeps the success → clear /
  // failure → set pattern uniform — no chance of forgetting to clear on a
  // subsequent successful save.
  const handleSetNotificationCategory = useCallback((cat: string, enabled: boolean) => {
    const sent = setNotificationPrefsCategory(cat, enabled)
    if (sent) setNotifWsClosedError(null)
    else setNotifWsClosedError(WS_CLOSED_MESSAGE)
  }, [setNotificationPrefsCategory])

  const handleSetNotificationDevice = useCallback((deviceKey: string, cat: string, enabled: boolean) => {
    const sent = setNotificationPrefsDevice(deviceKey, cat, enabled)
    if (sent) setNotifWsClosedError(null)
    else setNotifWsClosedError(WS_CLOSED_MESSAGE)
  }, [setNotificationPrefsDevice])

  // #4564: clear an entire per-device entry. Same WS-closed banner contract
  // as the rest of the notification-prefs handlers — a closed-socket clear
  // would silently fail and the orphan would stay on disk.
  const handleClearNotificationDevice = useCallback((deviceKey: string) => {
    const sent = deleteNotificationPrefsDevice(deviceKey)
    if (sent) setNotifWsClosedError(null)
    else setNotifWsClosedError(WS_CLOSED_MESSAGE)
  }, [deleteNotificationPrefsDevice])

  const handleSetNotificationQuietHours = useCallback((window: { start: string; end: string; timezone: string } | null) => {
    const sent = setNotificationPrefsQuietHours(window)
    if (sent) setNotifWsClosedError(null)
    else setNotifWsClosedError(WS_CLOSED_MESSAGE)
  }, [setNotificationPrefsQuietHours])

  const handleSetNotificationBypassCategories = useCallback((categories: string[]) => {
    const sent = setNotificationPrefsBypassCategories(categories)
    if (sent) setNotifWsClosedError(null)
    else setNotifWsClosedError(WS_CLOSED_MESSAGE)
  }, [setNotificationPrefsBypassCategories])

  const handleToggleAutoPerm = useCallback(async (next: boolean) => {
    setAutoPermError(null)
    // Confirm only when ENABLING — disabling auto-mode is always safe.
    if (next) {
      // window.confirm is synchronous and Tauri-compatible. The dashboard
      // already relies on it elsewhere for destructive actions.
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(AUTO_PERMISSION_CONFIRM_MESSAGE)
        : true
      if (!ok) return
    }
    const previous = allowAutoPerm
    setAllowAutoPerm(next)
    setAutoPermSaving(true)
    try {
      await setAllowAutoPermissionMode(next)
      setAutoPermDirty(true)
    } catch (err) {
      setAllowAutoPerm(previous)
      setAutoPermError(err instanceof Error ? err.message : String(err))
    } finally {
      setAutoPermSaving(false)
    }
  }, [allowAutoPerm])

  const handleTunnelModeChange = useCallback(async (mode: string) => {
    setTunnelError(null)
    const previousMode = tunnelMode
    setTunnelModeState(mode)
    try {
      await setTunnelMode(mode)
    } catch (err) {
      // Revert to actual saved mode, or previous mode as fallback
      const actual = await getTunnelMode()
      setTunnelModeState(actual ?? previousMode)
      setTunnelError(err instanceof Error ? err.message : String(err))
    }
  }, [tunnelMode])

  // Normalize: if persisted defaultProvider isn't in server's list, use first available
  const effectiveProvider = useMemo(() => {
    if (availableProviders.length > 0 && !availableProviders.some(p => p.name === defaultProvider)) {
      return availableProviders[0]!.name
    }
    return defaultProvider
  }, [availableProviders, defaultProvider])

  const handleSelectTheme = useCallback((themeId: string) => {
    setTheme(themeId)
    applyTheme(getThemeById(themeId))
  }, [setTheme])

  const handleProviderChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setDefaultProvider(e.target.value)
  }, [setDefaultProvider])

  const handleModelChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setDefaultModel(e.target.value)
  }, [setDefaultModel])

  const handleSendShortcutChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateInputSettings({ chatEnterToSend: e.target.value === 'enter' })
  }, [updateInputSettings])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const overlays = document.querySelectorAll('[data-modal-overlay]')
        if (overlays.length > 0 && overlays[overlays.length - 1] === backdropRef.current) {
          e.preventDefault()
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <>
      <div ref={backdropRef} className="settings-backdrop" data-modal-overlay onClick={onClose} />
      <div className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button className="settings-close" onClick={onClose} aria-label="Close settings" type="button">
            &times;
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <h3>Appearance</h3>
            <div className="theme-grid">
              {themes.map(theme => (
                <button
                  key={theme.id}
                  className={`theme-card${activeTheme === theme.id ? ' active' : ''}`}
                  onClick={() => handleSelectTheme(theme.id)}
                  type="button"
                  aria-pressed={activeTheme === theme.id}
                >
                  <ThemeSwatches theme={theme} />
                  <span className="theme-card-name">{theme.name}</span>
                  <span className="theme-card-desc">{theme.description}</span>
                  {activeTheme === theme.id && (
                    <span className="theme-card-check" aria-hidden="true">&#10003;</span>
                  )}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h3>Session Defaults</h3>
            <div className="settings-field">
              <label htmlFor="default-provider">Default provider</label>
              <select
                id="default-provider"
                aria-label="Default provider"
                value={effectiveProvider}
                onChange={handleProviderChange}
              >
                {availableProviders.length > 0
                  ? availableProviders.map(p => (
                      <option key={p.name} value={p.name}>
                        {PROVIDER_LABELS[p.name] || p.name}
                      </option>
                    ))
                  : <>
                      <option value="claude-sdk">Claude Code (SDK)</option>
                      <option value="claude-cli">Claude Code (CLI)</option>
                    </>
                }
              </select>
            </div>
            {availableModels.length > 0 && (
              <div className="settings-field">
                <label htmlFor="default-model">Default model</label>
                <select
                  id="default-model"
                  aria-label="Default model"
                  value={defaultModel}
                  onChange={handleModelChange}
                >
                  <option value="">Server default</option>
                  {availableModels.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="settings-field">
              <label htmlFor="send-shortcut">Send message with</label>
              <select
                id="send-shortcut"
                aria-label="Send shortcut"
                value={inputSettings.chatEnterToSend ? 'enter' : 'cmd-enter'}
                onChange={handleSendShortcutChange}
              >
                <option value="enter">Enter</option>
                <option value="cmd-enter">Cmd/Ctrl+Enter</option>
              </select>
            </div>
          </section>

          {/* #3852: customizable keyboard-shortcut bindings. Lives next
              to the existing Send shortcut select so all keyboard
              preferences are grouped together. */}
          <ShortcutsSection />

          {/* Active session — per-session toggles. Only renders when the
              active session reports a capability (e.g. boolean
              promptEvaluator OR chroxyContextHint). Older servers
              (pre-#3185 / pre-#3805) omit the fields entirely, in which
              case showing a non-functional toggle would mislead. */}
          {(typeof activeSessionPromptEvaluator === 'boolean' || typeof activeSessionChroxyContextHint === 'boolean') && (
            <section className="settings-section" data-testid="active-session-section">
              <h3>Active session</h3>
              {typeof activeSessionPromptEvaluator === 'boolean' && (
                <div className="settings-field settings-field-checkbox">
                  <label htmlFor="prompt-evaluator-toggle">
                    <input
                      id="prompt-evaluator-toggle"
                      type="checkbox"
                      checked={activeSessionPromptEvaluator}
                      onChange={(e) => setPromptEvaluator(e.target.checked)}
                      data-testid="prompt-evaluator-toggle"
                    />
                    Auto-evaluate prompts before send
                  </label>
                  <p className="settings-hint">
                    Run a quality check on each prompt before it's sent. Catches
                    ambiguous wording and surfaces clarifications inline. Applies
                    to this session only.
                  </p>
                </div>
              )}
              {typeof activeSessionChroxyContextHint === 'boolean' && (
                <div className="settings-field settings-field-checkbox">
                  <label htmlFor="chroxy-context-hint-toggle">
                    <input
                      id="chroxy-context-hint-toggle"
                      type="checkbox"
                      checked={activeSessionChroxyContextHint}
                      onChange={(e) => setChroxyContextHint(e.target.checked)}
                      data-testid="chroxy-context-hint-toggle"
                    />
                    Tell the model it's running inside Chroxy
                  </label>
                  <p className="settings-hint">
                    Prepends a short note to the system prompt so the model
                    knows it's bridged to a phone over a Cloudflare tunnel and
                    can prefer concise, mobile-friendly output (narrower code
                    blocks, no wide ASCII diagrams). Applies to this session
                    only.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* #3404 audit F1: per-provider auth/billing status. Surfaces
              `chroxy doctor` info inside the UI so users don't have to
              shell out to verify which account is on the hook. */}
          {availableProviders.some(p => !!p.auth) && (
            <section className="settings-section" data-testid="auth-status-section">
              <h3>Provider auth status</h3>
              <p className="settings-hint">
                Which billing identity each provider would use for new sessions.
                The server reports this from the same checks <code>chroxy doctor</code> runs.
              </p>
              <ul className="auth-status-legend" aria-label="Color legend">
                <li><span className="auth-status-swatch" data-tone="oauth" aria-hidden="true" /> Subscription / login</li>
                <li><span className="auth-status-swatch" data-tone="env" aria-hidden="true" /> API key</li>
                <li><span className="auth-status-swatch" data-tone="missing" aria-hidden="true" /> Not configured</li>
                <li><span className="auth-status-swatch" data-tone="none" aria-hidden="true" /> Custom provider</li>
              </ul>
              <ul className="auth-status-list">
                {availableProviders.map(p => {
                  if (!p.auth) return null
                  const label = PROVIDER_LABELS[p.name] || p.name
                  const tone = p.auth.ready ? p.auth.source : 'missing'
                  return (
                    <li
                      key={p.name}
                      className="auth-status-row"
                      data-provider={p.name}
                      data-tone={tone}
                      data-testid={`auth-status-${p.name}`}
                    >
                      <span className="auth-status-name">{label}</span>
                      <span className="auth-status-detail">{p.auth.detail}</span>
                      {!p.auth.ready && p.auth.hint && (
                        <span className="auth-status-hint">{p.auth.hint}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {/* #4052: BYOK credentials. Lets the user paste their Anthropic
              API key into the daemon's ~/.chroxy/credentials.json (0600)
              without dropping to a terminal. The full key is never echoed
              back — only the masked preview from the server. */}
          <section className="settings-section" data-testid="byok-credentials-section">
            <h3>BYOK credentials</h3>
            <p className="settings-hint">
              Paste an Anthropic API key for the <code>claude-byok</code> provider.
              Saved to <code>~/.chroxy/credentials.json</code> with mode 0600.
              An <code>ANTHROPIC_API_KEY</code> environment variable takes precedence
              if set.
            </p>
            <div className="settings-field" data-testid="byok-status">
              <span>
                Status:{' '}
                {byokCredentialsStatus?.status === 'set'
                  ? `Set (${byokCredentialsStatus.source}) — ${byokCredentialsStatus.masked}`
                  : 'Missing'}
              </span>
            </div>
            {byokCredentialsStatus?.status === 'missing' && byokCredentialsStatus.reason && (
              <p className="settings-hint" data-testid="byok-reason">
                {byokCredentialsStatus.reason}
              </p>
            )}
            {/* #4144 / #4175: stale-file notice. Two cases:
                1. source === 'env' — env var wins precedence; the saved
                   file is shadowed but still on disk (will be used again
                   if the env var is unset).
                2. source === 'none' && fileExists — the file is on disk
                   but cannot be read (e.g. mode 0644 fails the strict
                   mode-0600 check); the user sees a Remove button with
                   no context until #4175 broadened this gate.
                Skip when source === 'file' (file IS being used — no
                stale-state to surface). */}
            {byokCredentialsStatus?.fileExists && byokCredentialsStatus.source !== 'file' && (
              <p
                className="settings-hint"
                data-testid="byok-stale-file-notice"
                style={{ color: 'var(--warning-fg, #fbbf24)' }}
              >
                {byokCredentialsStatus.source === 'env' ? (
                  <>
                    Your <code>ANTHROPIC_API_KEY</code> environment variable is currently being
                    used. But a saved <code>credentials.json</code> file is still on disk and
                    will be used again the moment the env var is unset.
                    Click Remove to delete the file.
                  </>
                ) : (
                  <>
                    A saved <code>credentials.json</code> file is on disk but cannot be read
                    (see Status above for the reason). Click Remove to delete the unreadable
                    file, then paste your key again to save a fresh, readable copy.
                  </>
                )}
              </p>
            )}
            <div className="settings-field">
              <label htmlFor="byok-key-input">API key</label>
              <input
                id="byok-key-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-..."
                value={byokKeyInput}
                onChange={(e) => setByokKeyInput(e.target.value)}
                data-testid="byok-key-input"
              />
            </div>
            {byokError && (
              <p className="settings-hint" data-testid="byok-error" style={{ color: 'var(--error, #f00)' }}>
                {byokError}
              </p>
            )}
            {/* #4559: inline "server disconnected" warning. Same
                .settings-hint + error color as `byokError` so the BYOK
                section has a single error treatment. role=alert so
                screen readers announce the failure rather than letting
                the toggle revert silently. */}
            {byokWsClosedError && (
              <p
                className="settings-hint"
                role="alert"
                data-testid="byok-ws-closed-error"
                style={{ color: 'var(--error, #f00)' }}
              >
                {byokWsClosedError}
              </p>
            )}
            <div className="settings-field">
              <button
                type="button"
                onClick={handleSaveByokKey}
                disabled={byokKeyInput.trim().length === 0}
                data-testid="byok-save-button"
              >
                Save
              </button>
              {/* #4144: Remove is now keyed on file presence, not source.
                  When the env var wins precedence, the saved file is
                  shadowed but the user should still be able to clear it. */}
              {byokCredentialsStatus?.fileExists && (
                <button
                  type="button"
                  onClick={handleClearByokKey}
                  data-testid="byok-clear-button"
                >
                  Remove
                </button>
              )}
            </div>
          </section>

          {/* #4542: per-category notification opt-in/out. Snapshot lands via
              `notification_prefs`; toggling a checkbox patches one category
              via `notification_prefs_set` and the server re-broadcasts so
              other clients stay in lockstep. The section renders even
              before the first snapshot lands so the user knows the feature
              exists (with a loading hint).

              #4543: each row also exposes a "Mute on this device" toggle.
              The per-device entry is keyed by `currentDeviceKey` (the same
              stable localStorage id sent in `deviceInfo` on auth), so the
              dashboard always addresses the same `devices` entry across
              reconnects. When `currentDeviceKey` is null (storage broken),
              the per-device toggle row is suppressed entirely.

              #4560: the section header is always rendered so the user knows
              the feature exists. When the server doesn't advertise the
              `notificationPrefs` capability (pre-#4541), the body is
              replaced with an explicit "needs a newer server" message —
              the prior behaviour left "Loading preferences…" up forever
              because pre-#4541 servers never reply to `notification_prefs_get`. */}
          <section className="settings-section" data-testid="notification-prefs-section">
            <h3>Notifications</h3>
            <p className="settings-hint">
              Choose which push categories reach your devices. Server-side rate
              limits still apply as a defensive floor — these toggles can only
              mute further, never amplify.
            </p>
            {/* #4559: inline "server disconnected" warning. role=alert so
                screen readers announce the failure rather than letting
                a reverted toggle pass without explanation. */}
            {notifWsClosedError && (
              <p
                className="settings-hint"
                role="alert"
                data-testid="notification-prefs-ws-closed-error"
                style={{ color: 'var(--error, #f00)' }}
              >
                {notifWsClosedError}
              </p>
            )}
            {!notificationPrefsSupported ? (
              <p
                className="settings-hint"
                data-testid="notification-prefs-not-supported"
              >
                Your server does not support notification preferences. Upgrade
                to chroxy v0.9.14 or newer to manage per-category opt-in,
                per-device mutes, and quiet hours from here.
              </p>
            ) : notificationPrefs == null ? (
              <p
                className="settings-hint"
                data-testid="notification-prefs-loading"
              >
                Loading preferences&hellip;
              </p>
            ) : (
              <>
                {(() => {
                  const cats = notificationPrefs.categories
                  const knownKeys = NOTIFICATION_CATEGORY_ORDER.filter(k => k in cats)
                  const unknownKeys = Object.keys(cats).filter(k => !NOTIFICATION_CATEGORY_ORDER.includes(k))
                  const ordered = [...knownKeys, ...unknownKeys]
                  // #4543: look up THIS device's override map once per render
                  // so each row can determine its per-device state without
                  // re-reading the snapshot.
                  const deviceCategories = currentDeviceKey
                    ? notificationPrefs.devices?.[currentDeviceKey]?.categories ?? {}
                    : {}
                  return (
                    <ul className="notification-prefs-list">
                      {ordered.map(cat => {
                        const meta = NOTIFICATION_CATEGORY_LABELS[cat]
                        const label = meta?.label ?? cat
                        const hint = meta?.hint
                        const checked = cats[cat] !== false
                        const toggleId = `notification-prefs-${cat}`
                        // #4543: per-device override resolution.
                        //   - explicit `false` → muted on this device.
                        //   - explicit `true`  → unmuted on this device
                        //                        (overrides a `false` global).
                        //   - missing entry    → falls through to global default;
                        //                        UI shows the row as NOT muted
                        //                        (mute checkbox unchecked).
                        // Toggling sends the inverse boolean so a checked
                        // "mute" checkbox === `enabled: false` on the wire.
                        const deviceOverride = deviceCategories[cat]
                        const mutedOnThisDevice = deviceOverride === false
                        const deviceToggleId = `notification-prefs-device-${cat}`
                        return (
                          <li key={cat} className="settings-field settings-field-checkbox">
                            <label htmlFor={toggleId}>
                              <input
                                id={toggleId}
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => handleSetNotificationCategory(cat, e.target.checked)}
                                data-testid={`notification-prefs-toggle-${cat}`}
                              />
                              {label}
                            </label>
                            {hint && <p className="settings-hint">{hint}</p>}
                            {currentDeviceKey && (
                              // #4562: per-device row uses a <div> wrapper +
                              // explicit `htmlFor` <label> sibling rather than
                              // a wrapping <label>. The parent category row
                              // already lives inside its own <label> on the
                              // same <li>, and screen readers / click bubbling
                              // get confused when two label elements share an
                              // ancestor `<li>` — hoisting the per-device
                              // label out of a wrapper element keeps the input
                              // and its text label as flat siblings with a
                              // single explicit association.
                              <div
                                className="notification-prefs-device-row"
                                data-testid={`notification-prefs-device-row-${cat}`}
                              >
                                <input
                                  id={deviceToggleId}
                                  type="checkbox"
                                  checked={mutedOnThisDevice}
                                  onChange={(e) =>
                                    handleSetNotificationDevice(currentDeviceKey, cat, !e.target.checked)
                                  }
                                  data-testid={`notification-prefs-device-toggle-${cat}`}
                                />
                                <label htmlFor={deviceToggleId}>Mute on this device</label>
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )
                })()}

                {/* #4544: quiet-hours editor. The window is global (per-device
                    overrides are owned by a future iteration). Toggling the
                    enabled checkbox seeds a sensible default (22:00-07:00 in
                    the browser timezone) so the user doesn't see an empty
                    form; clearing it sends `null` to wipe persistence. */}
                <QuietHoursEditor
                  window={notificationPrefs.quietHours}
                  categories={notificationPrefs.categories}
                  bypassCategories={notificationPrefs.bypassCategories ?? DEFAULT_BYPASS_CATEGORIES}
                  onWindowChange={handleSetNotificationQuietHours}
                  onBypassChange={handleSetNotificationBypassCategories}
                />

                {/* #4564: per-device override list — lets the user drain
                    orphan entries left behind when Expo refreshes a push
                    token, an app is reinstalled, or a browser tab loses
                    its localStorage device id. Rendered even when the map
                    is empty so users find the surface for later. */}
                <KnownDevicesList
                  devices={notificationPrefs.devices}
                  currentDeviceKey={currentDeviceKey}
                  onClear={handleClearNotificationDevice}
                />
              </>
            )}
          </section>

          {onToggleConsoleTab && (
            <section className="settings-section">
              <h3>Dashboard</h3>
              <div className="settings-field">
                <label htmlFor="show-console-tab">Show Console tab</label>
                <input
                  id="show-console-tab"
                  type="checkbox"
                  checked={showConsoleTab ?? false}
                  onChange={(e) => onToggleConsoleTab(e.target.checked)}
                />
              </div>
            </section>
          )}

          {inTauri && (
            <section className="settings-section">
              <h3>Security</h3>
              <div className="settings-field">
                <label htmlFor="allow-auto-perm">Allow auto-permission mode</label>
                <input
                  id="allow-auto-perm"
                  type="checkbox"
                  checked={allowAutoPerm}
                  disabled={autoPermSaving}
                  onChange={(e) => handleToggleAutoPerm(e.target.checked)}
                />
              </div>
              <p className="settings-help">
                When enabled, sessions on the host can switch to auto-permission
                mode (no per-tool prompts). Paired QR clients are always blocked
                from this regardless of the toggle.
              </p>
              {autoPermError && (
                <p className="tunnel-mode-error" role="alert">{autoPermError}</p>
              )}
              {autoPermDirty && !autoPermError && (
                <button
                  type="button"
                  className="tunnel-restart-btn"
                  disabled={restarting}
                  onClick={async () => {
                    setRestarting(true)
                    await restartServer()
                    setAutoPermDirty(false)
                    setTimeout(() => setRestarting(false), 3000)
                  }}
                >
                  {restarting ? 'Restarting...' : 'Restart Server to Apply'}
                </button>
              )}
            </section>
          )}

          {inTauri && (
            <section className="settings-section">
              <h3>Network</h3>
              <div className="settings-field">
                <span id="tunnel-mode-label">Tunnel mode</span>
                <div className="tunnel-mode-options" role="radiogroup" aria-labelledby="tunnel-mode-label">
                  {([
                    { value: 'none', label: 'Off', desc: 'LAN only' },
                    { value: 'quick', label: 'Quick Tunnel', desc: 'Random Cloudflare URL' },
                    { value: 'named', label: 'Named Tunnel', desc: 'Stable URL, requires setup' },
                  ] as const).map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      className={`tunnel-mode-option${tunnelMode === opt.value ? ' active' : ''}`}
                      onClick={() => handleTunnelModeChange(opt.value)}
                      aria-checked={tunnelMode === opt.value}
                    >
                      <span className="tunnel-mode-label">{opt.label}</span>
                      <span className="tunnel-mode-desc">{opt.desc}</span>
                    </button>
                  ))}
                </div>
                {tunnelError && (
                  <p className="tunnel-mode-error">{tunnelError}</p>
                )}
                {tunnelMode !== serverTunnelMode ? (
                  <button
                    type="button"
                    className="tunnel-restart-btn"
                    disabled={restarting}
                    onClick={async () => {
                      setRestarting(true)
                      await restartServer()
                      setServerTunnelMode(tunnelMode)
                      setTimeout(() => setRestarting(false), 3000)
                    }}
                  >
                    {restarting ? 'Restarting...' : 'Restart Server to Apply'}
                  </button>
                ) : (
                  <p className="tunnel-mode-note">Server restart required after change</p>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  )
}
