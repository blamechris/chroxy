/**
 * SettingsPanel — slide-out panel with theme picker and session defaults.
 *
 * Triggered via gear icon in header or Cmd+,. Changes apply instantly
 * and persist to localStorage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnectionStore, isRuleEligibleProvider } from '../store/connection'
import type { PermissionRule, PermissionAuditEntry } from '../store/types'
import { ShortcutsSection } from '../shortcuts/ShortcutsSection'
import { ProviderCredentialsPane } from './ProviderCredentialsPane'
import { getAvailableThemes, applyTheme } from '../theme/theme-engine'
import { getThemeById } from '../theme/themes'
import type { ThemeDefinition } from '../theme/themes'
import { PROVIDER_LABELS } from '../lib/provider-labels'
import {
  COST_BADGE_MODES,
  COST_BADGE_MODE_LABELS,
  isCostBadgeMode,
} from './SidebarCostBadge'
import {
  buildQuietHoursTimezoneList,
  formatPlatform,
  formatRelativeTime,
  // #4853: shared runtime guard for `VoiceInputMode` — replaces the
  // inline `Record<VoiceInputMode, true>` literal previously rebuilt
  // on every change-handler call.
  isVoiceInputMode,
} from '@chroxy/store-core'
import { isTauri } from '../utils/tauri'
import { isMacPlatform } from '../utils/platform'
import { getTauriInvoke } from '../utils/tauri-bridge'
import {
  getTunnelMode,
  setTunnelMode,
  getExposeOnLan,
  setExposeOnLan,
  getSummonHotkey,
  setSummonHotkey,
  restartServer,
  getServerInfo,
  getAllowAutoPermissionMode,
  setAllowAutoPermissionMode,
} from '../hooks/useTauriIPC'
import { useDebouncedSetter } from '../hooks/useDebouncedSetter'

/** Confirmation copy from issue #3077 — keep verbatim. */
const AUTO_PERMISSION_CONFIRM_MESSAGE =
  'Auto-permission mode disables all per-tool prompts for non-paired clients. Continue?'

/**
 * #6772/#6829 — stable empty reference for the permission-rules selectors so
 * Zustand doesn't re-render the panel on every unrelated store write (mirrors the
 * mobile SettingsScreen `EMPTY_RULES`).
 */
const EMPTY_PERMISSION_RULES: PermissionRule[] = []

/**
 * #6772/#6830 — human label for one permission audit entry. The server's audit
 * log (permission-audit.js) records heterogeneous kinds; render each known kind
 * by its distinguishing fields. `entry.type` is an OPEN string (PR #6836
 * review — the wire schema is forward-compatible), so any UNKNOWN kind falls
 * through to the generic label rather than breaking the list. Pure +
 * exported-shape so the SettingsPanel test can assert on the rendered text.
 *
 * #6830 — a `decision` entry now MAY carry `tool` and, for a durable grant,
 * `persist:'project'`:
 *   - a plain `allow`/`deny` (`tool` present or absent — pre-#6830 entries in
 *     an existing log have neither) renders as before, with the tool name
 *     appended when known.
 *   - an `allowAlways` renders as "Always-allowed" and calls out whether it
 *     was actually saved as a durable project rule (a NEVER_AUTO_ALLOW /
 *     non-eligible tool, e.g. Bash, degrades to a one-time allow — nothing
 *     persisted, so no rule survives a restart).
 *   - `reason:'persisted_rule'` is a rule silently auto-approving a tool call
 *     with NO prompt ever shown (permission-manager.js
 *     _auditPersistedRuleAutoApprove) — rendered distinctly ("Auto-allowed")
 *     rather than folded into the generic allow/deny verb.
 */
export function describePermissionAuditEntry(entry: PermissionAuditEntry): string {
  switch (entry.type) {
    case 'mode_change':
      return `Permission mode: ${entry.previousMode ?? '?'} → ${entry.newMode ?? '?'}`
    case 'whitelist_change':
      return `Session rules changed (${entry.rules?.length ?? 0} rule${(entry.rules?.length ?? 0) === 1 ? '' : 's'})`
    case 'decision': {
      const toolPart = entry.tool ? ` ${entry.tool}` : ''
      if (entry.reason === 'persisted_rule') {
        // A durable project rule auto-approved with no prompt shown — no
        // human responder, so there's no "(user)"/reason suffix to add.
        return `Auto-allowed${toolPart} (persisted rule)`
      }
      const verb = entry.decision === 'deny' ? 'Denied' : entry.decision === 'allowAlways' ? 'Always-allowed' : 'Allowed'
      const persistPart = entry.persist === 'project'
        ? ' — saved as a project rule'
        : entry.decision === 'allowAlways' && entry.tool
          ? ' (not saved — one-time only)'
          : ''
      const reason = entry.reason && entry.reason !== 'user' ? ` (${entry.reason})` : ''
      return `${verb}${toolPart}${reason}${persistPart}`
    }
    default:
      return 'Permission event'
  }
}

/**
 * #4588: confirmation copy for clearing the current device's per-device
 * overrides. Only fires when the user clicks Clear on the row tagged
 * `(this device)` — orphan-row clears stay one-click because the whole
 * point of the orphan list is fast cleanup. A misclick on your own row,
 * though, silently wipes whatever mutes / quiet-hours overrides you set
 * up; the prompt is the second cue (after the `(this device)` tag).
 */
const CURRENT_DEVICE_CLEAR_CONFIRM_MESSAGE =
  'Clear your per-device overrides? Notifications on this device will fall back to global defaults.'

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
  // #5828: billing canary early-warnings (silent metered default, claude-tui
  // reclassification, datacenter egress).
  billing_warning: {
    label: 'Billing alerts',
    hint: 'Metered-credit and datacenter-egress warnings from the billing canary.',
  },
  live_activity: {
    label: 'Live Activity (iOS)',
    hint: 'iOS Dynamic Island / lock-screen Live Activity updates.',
  },
  // #5413 Phase 3: external-session categories fed by POST /api/events.
  session_online: {
    label: 'External session online',
    hint: 'An external session reported in via /api/events.',
  },
  session_offline: {
    label: 'External session offline',
    hint: 'An external session ended or went away.',
  },
  session_activity: {
    label: 'External session activity',
    hint: 'Subagent and tool activity from external sessions.',
  },
  // Mailbox live-interrupt: "new mail" pings fed by POST /api/mailbox.
  mailbox: {
    label: 'Mailbox',
    hint: 'New agent-to-agent mailbox messages waiting for a session.',
  },
}

/** Render order for known categories. Unknown keys append at the end in snapshot order. */
const NOTIFICATION_CATEGORY_ORDER = [
  'permission',
  'activity_waiting',
  'activity_error',
  'activity_update',
  'inactivity_warning',
  'billing_warning',
  'result',
  // External-session categories (#5413) grouped together, ahead of the
  // platform-specific Live Activity entry which stays last.
  'session_online',
  'session_offline',
  'session_activity',
  'mailbox',
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

/**
 * #5544: the preference body shared between the legacy slide-out modal
 * (`SettingsPanel`) and the Control Room Settings tab (`SettingsContent`
 * embedded). `SettingsPanel` wraps this in the modal chrome; the Control
 * Room renders it directly inside its tab. Persistence per setting is
 * unchanged — this is UI convergence, not a storage migration.
 */
export interface SettingsContentProps {
  /**
   * Whether the content is currently visible. Gates the on-open effects
   * (refresh notification prefs, BYOK status, Tauri tunnel/hotkey load) so
   * they fire once the surface becomes active and re-fire on re-activation.
   * In the modal this tracks `isOpen`; in the Control Room tab it's true
   * while the Settings tab is the active sub-tab.
   */
  active: boolean
  showConsoleTab?: boolean
  onToggleConsoleTab?: (show: boolean) => void
  // #4891 — audible intervention ping enable/mute. Optional so existing
  // call sites / tests that don't wire it stay valid; the row only renders
  // when the handler is provided.
  interventionPingEnabled?: boolean
  onToggleInterventionPing?: (enabled: boolean) => void
}

export interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
  showConsoleTab?: boolean
  onToggleConsoleTab?: (show: boolean) => void
  interventionPingEnabled?: boolean
  onToggleInterventionPing?: (enabled: boolean) => void
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

  // #4570 / #4739: draft state + dirty-flag + parked-snapshot conflict
  // UX live in `useDebouncedSetter` (manual mode — Save button gates the
  // actual WS send; debounceMs=0 disables auto-flush). The draft shape
  // bundles `enabled` with the three fields so the conflict equality
  // check can asymmetrically map `enabled=false` to a `null` server
  // snapshot. When the snapshot is null we keep the default field
  // values so re-enabling doesn't blank them.
  type Draft = { enabled: boolean; start: string; end: string; timezone: string }
  const serverDraft: Draft = useMemo(() => ({
    enabled: win != null,
    start: win?.start ?? '22:00',
    end: win?.end ?? '07:00',
    timezone: win?.timezone ?? browserTz,
  }), [win, browserTz])

  // Conflict equality. Mirrors the original inline `matchesDraft` check:
  //   - server win=null matches draft.enabled=false (fields ignored)
  //   - server win={…} matches when all three fields AND enabled agree
  const draftEquals = useCallback((server: Draft, draft: Draft): boolean => {
    if (!server.enabled) return !draft.enabled
    return (
      draft.enabled &&
      server.start === draft.start &&
      server.end === draft.end &&
      server.timezone === draft.timezone
    )
  }, [])

  // Manual mode — `setDraft` updates local state only; Save explicitly
  // calls `flush()` so the dirty flag + parked-snapshot banner clear
  // optimistically (rather than waiting for the server echo to arrive,
  // which would leave the banner stuck if the WS write fails). The hook
  // owns dirty, conflict, accept/discard, flush, and unmount-cancel
  // semantics.
  //
  // `onFlush` translates the composite draft into the wire shape used by
  // `onWindowChange`: when `enabled` is true we send the window; when
  // false we send `null` (the server's "wipe quiet hours" sentinel). The
  // toggle and first-time enable paths still call `onWindowChange`
  // directly because they need to fire independent of the user's
  // typed-but-not-yet-saved fields.
  const {
    draft,
    setDraft,
    conflict: pendingDraft,
    acceptDraft: handleAcceptDraft,
    discardDraft: handleDiscardDraftFromHook,
    flush: flushDraft,
  } = useDebouncedSetter<Draft>({
    serverValue: serverDraft,
    scopeKey: 'quiet-hours',
    debounceMs: 0,
    onFlush: (next) => {
      if (next.enabled) {
        onWindowChange({ start: next.start, end: next.end, timezone: next.timezone })
      } else {
        onWindowChange(null)
      }
    },
    equals: draftEquals,
  })

  const { enabled, start, end, timezone } = draft

  // Wrap discard so the parked snapshot is exposed back through the
  // banner UX. The hook already replaces draft with the parked value
  // and clears dirty.
  // pendingSnapshot mirrors the original null-vs-undefined contract:
  //   - undefined → no conflict (banner hidden)
  //   - null      → server disabled the window mid-edit
  //   - object    → server set a different window mid-edit
  const pendingSnapshot: { start: string; end: string; timezone: string } | null | undefined =
    pendingDraft === undefined
      ? undefined
      : pendingDraft.enabled
        ? { start: pendingDraft.start, end: pendingDraft.end, timezone: pendingDraft.timezone }
        : null

  const handleToggleEnable = useCallback((next: boolean) => {
    // Side-effect handlers replace setDraft directly with `dirty=false`
    // semantics: toggling enabled either disables (sends null) or
    // first-time enables (sends current draft fields). Either way the
    // user has committed, so we replicate the original behaviour by
    // mirroring the server state immediately rather than parking it.
    setDraft({ enabled: next, start, end, timezone })
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
  }, [win, start, end, timezone, onWindowChange, setDraft])

  const handleSaveWindow = useCallback(() => {
    // `flushDraft` fires the hook's `onFlush` with the current draft
    // (which delegates to `onWindowChange` for the enabled-true case)
    // AND clears `dirty` + dismisses the parked-snapshot banner
    // optimistically. Mirrors the pre-#4739 behaviour where Save
    // explicitly called `setDirty(false)` + `setPendingSnapshot(undefined)`
    // before dispatching the WS write, so a conflict banner that's
    // visible at click-time disappears immediately rather than hanging
    // around until the server echo arrives (or staying stuck forever if
    // the WS write fails).
    flushDraft()
  }, [flushDraft])

  const handleDiscardDraft = useCallback(() => {
    handleDiscardDraftFromHook()
  }, [handleDiscardDraftFromHook])

  // Field setters delegate to setDraft so dirty + conflict tracking
  // stay centralised in the hook.
  const setStartDirty = useCallback((next: string) => {
    setDraft({ enabled, start: next, end, timezone })
  }, [setDraft, enabled, end, timezone])
  const setEndDirty = useCallback((next: string) => {
    setDraft({ enabled, start, end: next, timezone })
  }, [setDraft, enabled, start, timezone])
  const setTimezoneDirty = useCallback((next: string) => {
    setDraft({ enabled, start, end, timezone: next })
  }, [setDraft, enabled, start, end])

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
    // #4587: optional last-seen + platform metadata stamped by the server
    // on each device patch + register_push_token. Pre-#4587 servers omit
    // both fields, in which case the row renders exactly as before
    // (truncated token + optional "this device" tag, no meta spans).
    lastSeenAt?: number
    platform?: string
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
            const entry = devices[key]
            // Index access on Record<string, T> returns `T | undefined`
            // under noUncheckedIndexedAccess. `key` came from
            // Object.keys(devices) so `entry` is always present in
            // practice, but the type narrowing keeps strict TS happy
            // and guards against a race where `devices` mutates
            // between the keys() snapshot and the render.
            if (!entry) return null
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
                  {/* #4587: optional platform + last-seen metadata. Both
                      hidden when absent (pre-#4587 server snapshot) so the
                      row degrades to the original token-only render.
                      Ternary (not `&&`) so a stray 0 in lastSeenAt — or
                      empty-string platform that bypassed the sanitizer —
                      can never render as a raw literal text node. */}
                  {entry.platform ? (
                    <span
                      className="notification-prefs-device-meta"
                      data-testid={`notification-prefs-device-platform-${key}`}
                    >
                      {' · '}{formatPlatform(entry.platform)}
                    </span>
                  ) : null}
                  {entry.lastSeenAt ? (
                    <span
                      className="notification-prefs-device-meta"
                      data-testid={`notification-prefs-device-last-seen-${key}`}
                    >
                      {' · Last seen '}{formatRelativeTime(entry.lastSeenAt)}
                    </span>
                  ) : null}
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

export function SettingsContent({ active, showConsoleTab, onToggleConsoleTab, interventionPingEnabled, onToggleInterventionPing }: SettingsContentProps) {
  // #5544: alias retained so the body's many `isOpen` reads (effect gates,
  // refresh-on-open) keep their original meaning — true while this surface
  // is the visible one (modal open, or Control Room Settings tab active).
  const isOpen = active
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
  // #5184: header cost-badge display mode. Persisted via the store setter
  // (same localStorage pattern as theme / default provider).
  const costBadgeMode = useConnectionStore(s => s.costBadgeMode)
  const setCostBadgeMode = useConnectionStore(s => s.setCostBadgeMode)
  const confirmSessionClose = useConnectionStore(s => s.confirmSessionClose)
  const setConfirmSessionClose = useConnectionStore(s => s.setConfirmSessionClose)
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
  // #4660: per-session preamble setter. The text area below debounces
  // user input by 400ms before calling this — per-keystroke WS chatter
  // would otherwise blow up the state-file write rate and the broadcast
  // bandwidth for multi-client sessions.
  const setSessionPreamble = useConnectionStore(s => s.setSessionPreamble)
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
  // #4660: same capability-gate pattern as chroxyContextHint — only
  // render the text area when the active session reports the field
  // (older servers pre-#4660 omit it entirely). The server is the
  // authoritative trim/cap site so we render exactly what it confirmed.
  const activeSessionSessionPreamble = sessions.find(s => s.sessionId === activeSessionId)?.sessionPreamble
  // #6772/#6829 — per-session permission rules viewer + audit history. sessionRules /
  // persistentRules live on sessionStates (kept current by `permission_rules_updated`);
  // the active session's cwd (project-rule scope label) + provider are on the sessions
  // list. Stable empty refs keep the selectors from re-rendering on unrelated writes.
  const activeSessionRules = useConnectionStore(s => {
    const id = s.activeSessionId
    return (id ? s.sessionStates?.[id]?.sessionRules : undefined) ?? EMPTY_PERMISSION_RULES
  })
  const activePersistentRules = useConnectionStore(s => {
    const id = s.activeSessionId
    return (id ? s.sessionStates?.[id]?.persistentRules : undefined) ?? EMPTY_PERMISSION_RULES
  })
  const activeSessionCwd = sessions.find(s => s.sessionId === activeSessionId)?.cwd ?? null
  const activeSessionProvider = sessions.find(s => s.sessionId === activeSessionId)?.provider ?? null
  const providerSupportsRules = isRuleEligibleProvider(activeSessionProvider, availableProviders)
  const setPermissionRules = useConnectionStore(s => s.setPermissionRules)
  const setProjectPermissionRules = useConnectionStore(s => s.setProjectPermissionRules)
  const queryPermissionAudit = useConnectionStore(s => s.queryPermissionAudit)
  const permissionAudit = useConnectionStore(s => s.permissionAudit)
  const permissionAuditLoading = useConnectionStore(s => s.permissionAuditLoading)
  const permissionAuditError = useConnectionStore(s => s.permissionAuditError)
  const themes = getAvailableThemes()
  const inTauri = isTauri()
  const [tunnelMode, setTunnelModeState] = useState<string>('none')
  const [tunnelError, setTunnelError] = useState<string | null>(null)
  const [serverTunnelMode, setServerTunnelMode] = useState<string>('none')
  const [restarting, setRestarting] = useState(false)
  // #5356 — LAN exposure of the embedded server. `exposeOnLan` is the saved
  // setting; `savedExposeOnLan` tracks what's persisted so the panel can prompt
  // for a restart when changed (bind address is fixed at server spawn).
  const [exposeOnLan, setExposeOnLanState] = useState<boolean>(false)
  const [savedExposeOnLan, setSavedExposeOnLan] = useState<boolean>(false)
  const [exposeOnLanError, setExposeOnLanError] = useState<string | null>(null)
  // #5294 — global summon hotkey. `summonHotkeySaved` tracks the persisted
  // value so the Save button can disable when unchanged and Clear when empty.
  const [summonHotkeyInput, setSummonHotkeyInput] = useState<string>('')
  const [summonHotkeySaved, setSummonHotkeySaved] = useState<string | null>(null)
  const [summonHotkeyError, setSummonHotkeyError] = useState<string | null>(null)
  const [summonHotkeySaving, setSummonHotkeySaving] = useState<boolean>(false)
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
  // #4956 — Tooling reset hint state. The Tauri command runs `tccutil reset
  // Microphone/SpeechRecognition com.chroxy.desktop`; we only surface the
  // button on macOS-in-Tauri (other platforms have no TCC, and the browser
  // can't shell out). Status feedback is intentionally inline (not a toast)
  // so the user sees the outcome next to the button they pressed.
  const [speechResetStatus, setSpeechResetStatus] = useState<
    'idle' | 'running' | 'success' | 'error'
  >('idle')
  const [speechResetError, setSpeechResetError] = useState<string | null>(null)
  const showSpeechResetButton = inTauri && isMacPlatform()
  const handleResetSpeechPermissions = useCallback(async () => {
    setSpeechResetStatus('running')
    setSpeechResetError(null)
    try {
      const invoke = getTauriInvoke()
      if (!invoke) {
        throw new Error('Tauri invoke unavailable')
      }
      await invoke('reset_speech_permissions')
      setSpeechResetStatus('success')
    } catch (err) {
      setSpeechResetStatus('error')
      setSpeechResetError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  const [autoPermSaving, setAutoPermSaving] = useState<boolean>(false)

  // #4660 / #4662 / #4739: per-session preamble text area. Local draft
  // is decoupled from the server-confirmed `activeSessionSessionPreamble`
  // so typing stays responsive while a 400ms debounce gates the actual
  // WS send. The `useDebouncedSetter` hook (extracted in #4739)
  // encapsulates the debounce timer, dirty-flag tracking, parked-snapshot
  // conflict UX, session-switch cancel + re-hydrate, and unmount cleanup
  // that previously lived inline here as ~100 lines of refs + effects.
  //
  // Scope key is the active session id so a mid-edit session switch
  // cancels the pending debounce and re-hydrates to the new session's
  // server value — without this, the timer would fire against the new
  // session with session A's draft text (gap 1 of #4662).
  const {
    draft: preambleDraft,
    setDraft: setPreambleDraft,
    conflict: preambleConflict,
    acceptDraft: handleAcceptPreambleDraft,
    discardDraft: handleDiscardPreambleDraft,
  } = useDebouncedSetter<string>({
    serverValue: typeof activeSessionSessionPreamble === 'string' ? activeSessionSessionPreamble : '',
    scopeKey: activeSessionId ?? null,
    debounceMs: 400,
    onFlush: setSessionPreamble,
  })

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
    // #4998 review — match the panel-scoped reset pattern used for
    // tunnelError / autoPermError so a stale success/error hint from a
    // previous open doesn't linger across reopens.
    setSpeechResetStatus('idle')
    setSpeechResetError(null)
    // #5294 — reset hotkey edit state, then load the persisted accelerator.
    setSummonHotkeyError(null)
    setSummonHotkeySaving(false)
    getSummonHotkey().then(hk => {
      setSummonHotkeySaved(hk ?? null)
      setSummonHotkeyInput(hk ?? '')
    }).catch(() => {})
    // Read saved setting (what user selected)
    getTunnelMode().then(mode => {
      if (mode) setTunnelModeState(mode)
    })
    // #5356 — read saved LAN-exposure setting (false = loopback-only default).
    // This effect only runs in Tauri (gated on inTauri above), so a `null`
    // here means the IPC invoke failed (the shared helper converts errors to
    // null) — surface it rather than silently presenting the default toggle.
    setExposeOnLanError(null)
    getExposeOnLan().then(value => {
      if (value !== null) {
        setExposeOnLanState(value)
        setSavedExposeOnLan(value)
      } else {
        setExposeOnLanError('Could not load the LAN-exposure setting.')
      }
    }).catch(err => {
      setExposeOnLanError(err instanceof Error ? err.message : String(err))
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
  //
  // #4588: clearing the row tagged `(this device)` silently wipes the
  // operator's own mute/quiet-hours overrides — surface a confirm prompt
  // for that case only. Orphan-row clears stay one-click; the whole point
  // of the orphan list is fast cleanup.
  const handleClearNotificationDevice = useCallback((deviceKey: string) => {
    if (deviceKey === currentDeviceKey) {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(CURRENT_DEVICE_CLEAR_CONFIRM_MESSAGE)
        : true
      if (!ok) return
    }
    const sent = deleteNotificationPrefsDevice(deviceKey)
    if (sent) setNotifWsClosedError(null)
    else setNotifWsClosedError(WS_CLOSED_MESSAGE)
  }, [deleteNotificationPrefsDevice, currentDeviceKey])

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

  // #5356 — persist the LAN-exposure toggle. Optimistic; revert on error.
  const handleExposeOnLanChange = useCallback(async (expose: boolean) => {
    setExposeOnLanError(null)
    const previous = exposeOnLan
    setExposeOnLanState(expose)
    try {
      await setExposeOnLan(expose)
    } catch (err) {
      setExposeOnLanState(previous)
      setExposeOnLanError(err instanceof Error ? err.message : String(err))
    }
  }, [exposeOnLan])

  // #5294 — persist + live-register the summon hotkey. On a bad/conflicting
  // accelerator the Rust side throws; surface it and leave the field as-typed
  // so the user can correct it (the previous binding stays active server-side).
  const handleSaveSummonHotkey = useCallback(async () => {
    const next = summonHotkeyInput.trim()
    setSummonHotkeyError(null)
    setSummonHotkeySaving(true)
    try {
      await setSummonHotkey(next || null)
      setSummonHotkeySaved(next || null)
      setSummonHotkeyInput(next)
    } catch (err) {
      setSummonHotkeyError(err instanceof Error ? err.message : String(err))
    } finally {
      setSummonHotkeySaving(false)
    }
  }, [summonHotkeyInput])

  const handleClearSummonHotkey = useCallback(async () => {
    setSummonHotkeyError(null)
    setSummonHotkeySaving(true)
    try {
      await setSummonHotkey(null)
      setSummonHotkeySaved(null)
      setSummonHotkeyInput('')
    } catch (err) {
      setSummonHotkeyError(err instanceof Error ? err.message : String(err))
    } finally {
      setSummonHotkeySaving(false)
    }
  }, [])

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

  // #5184: validate the select value through the shared guard before
  // committing — a stray option (or a value injected by automated tooling)
  // can't poison the union the way a bare cast would.
  const handleCostBadgeModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    if (isCostBadgeMode(e.target.value)) {
      setCostBadgeMode(e.target.value)
    }
  }, [setCostBadgeMode])

  const handleSendShortcutChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateInputSettings({ chatEnterToSend: e.target.value === 'enter' })
  }, [updateInputSettings])

  const handleVoiceInputModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    // #4853: validate against the shared `isVoiceInputMode` guard from
    // store-core. The guard is keyed off an exhaustive
    // `Record<VoiceInputMode, true>` map, so adding a new mode to the
    // union without listing it there is a TS error — neither this site
    // nor any other rehydrate/wire boundary can silently drop a new
    // mode the way a hand-written `===` chain would (#4841 review
    // feedback that landed in #4825 inline, now extracted in #4853).
    if (isVoiceInputMode(e.target.value)) {
      updateInputSettings({ voiceInputMode: e.target.value })
    }
  }, [updateInputSettings])

  // #5544: both hosts unmount this content when it's hidden — the modal
  // wrapper on close, and the Control Room Settings tab whenever another
  // sub-tab is focused (ControlRoomView renders tab bodies conditionally) —
  // so `isOpen` is effectively always true today. The guard stays as a cheap
  // safety net for any future host that keeps the content mounted while
  // hidden.
  if (!isOpen) return null

  return (
    <div className="settings-body" data-testid="settings-content">
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
            {/* #5184: header cost-badge display mode. The badge in the
                top bar (provider/model by default) can show cost, tokens,
                % of context used, or the session-type tag instead. */}
            <div className="settings-field">
              <label htmlFor="cost-badge-mode">Header badge shows</label>
              <select
                id="cost-badge-mode"
                aria-label="Header badge display"
                value={costBadgeMode}
                onChange={handleCostBadgeModeChange}
                data-testid="cost-badge-mode-select"
              >
                {COST_BADGE_MODES.map(mode => (
                  <option key={mode} value={mode}>
                    {COST_BADGE_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
              <p className="settings-hint">
                Choose what the badge in the top bar displays — provider and
                model, the running dollar cost, token count, percent of the
                context window used, or the session-type tag.
              </p>
            </div>
            {/* #5206: confirm-before-close toggle. When on (default), closing
                a session tab prompts a confirmation so a session isn't
                terminated by an accidental click. The Control Room tab is
                exempt — it closes immediately. */}
            <div className="settings-field settings-field-checkbox">
              <label htmlFor="confirm-session-close">
                <input
                  id="confirm-session-close"
                  type="checkbox"
                  checked={confirmSessionClose}
                  onChange={(e) => setConfirmSessionClose(e.target.checked)}
                  data-testid="confirm-session-close-toggle"
                />
                Confirm before closing a session
              </label>
              <p className="settings-hint">
                Ask for confirmation before closing a session tab so you don't
                terminate a session by accident. Closing the Control Room tab
                never asks.
              </p>
            </div>
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
            {/* #4785: voice input behaviour. `continuous` keeps the mic
                lit across silence gaps until the user clicks stop.
                `auto-pause` is the pre-#4785 behaviour (Web Speech ends
                on silence). Only affects the web engine; the Tauri
                native engine has its own end-of-utterance semantics.
                #4796: labels reworded — "Stop automatically on pause"
                was ambiguous (silence? tab pause? network?). The new
                wording calls out the trigger (silence) explicitly. */}
            <div className="settings-field">
              <label htmlFor="voice-input-mode">Voice input</label>
              <select
                id="voice-input-mode"
                aria-label="Voice input mode"
                aria-describedby="voice-input-mode-hint"
                value={inputSettings.voiceInputMode}
                onChange={handleVoiceInputModeChange}
              >
                <option value="continuous">Keep listening until I click stop</option>
                <option value="auto-pause">Stop after silence (browser decides)</option>
              </select>
              {/* #4796: hint copy quotes the dropdown labels verbatim
                  so users can map each sentence back to the option they
                  selected. Earlier wording used "Continuous mode" /
                  "Silence mode" shorthand which could read like a third
                  mode and didn't match the dropdown labels. */}
              <p
                id="voice-input-mode-hint"
                className="settings-hint"
                data-testid="voice-input-mode-hint"
              >
                Click the mic button to start dictation and click again
                to stop — the button is a toggle, not push-to-hold.
                <strong> &ldquo;Keep listening until I click stop&rdquo;</strong>{' '}
                holds the mic open through pauses and restarts recognition
                automatically.{' '}
                <strong>&ldquo;Stop after silence (browser decides)&rdquo;</strong>{' '}
                lets the browser end recognition after a short silence
                in your speech. Only applies to the browser speech
                engine — the macOS native speech helper manages its own
                end-of-utterance timing.
              </p>
            </div>
            {/* #4956 — macOS-only reset for cached TCC denials. Surfaced
                after #4954 shipped the helper-entitlement fix because end
                users upgrading from a broken build (v0.9.40 and earlier)
                still hit the old TCC denial against the prior codesign
                hash. The Rust side runs `tccutil reset Microphone +
                SpeechRecognition com.chroxy.desktop`; on next mic use macOS
                re-prompts and the new entitled signature gets allowed.
                Gated on inTauri + macOS so the button doesn't show as a
                no-op on Linux/Windows or in browser. */}
            {showSpeechResetButton && (
              <div className="settings-field" data-testid="speech-reset-row">
                <label htmlFor="speech-reset-button">Reset macOS speech permissions</label>
                <button
                  type="button"
                  id="speech-reset-button"
                  className="settings-secondary-button"
                  onClick={handleResetSpeechPermissions}
                  disabled={speechResetStatus === 'running'}
                  data-testid="speech-reset-button"
                >
                  {speechResetStatus === 'running' ? 'Resetting…' : 'Reset now'}
                </button>
                {speechResetStatus === 'success' && (
                  <p
                    className="settings-hint"
                    data-testid="speech-reset-success"
                    role="status"
                  >
                    Speech permissions reset. Click the mic again — macOS will
                    prompt for permission, and the new entitled helper
                    signature will be allowed.
                  </p>
                )}
                {speechResetStatus === 'error' && speechResetError && (
                  <p
                    className="settings-hint settings-error"
                    data-testid="speech-reset-error"
                    role="alert"
                  >
                    Reset failed: {speechResetError}
                  </p>
                )}
                {speechResetStatus === 'idle' && (
                  <p className="settings-hint">
                    Use this if voice input still says &ldquo;permission
                    denied&rdquo; after upgrading. Chroxy v0.9.40+ ships with a
                    new helper signature; macOS may cache a denial for the old
                    signature. Resets <code>Microphone</code> and{' '}
                    <code>SpeechRecognition</code> for <code>com.chroxy.desktop</code>.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* #3852: customizable keyboard-shortcut bindings. Lives next
              to the existing Send shortcut select so all keyboard
              preferences are grouped together. */}
          <ShortcutsSection />

          {/* Active session — per-session toggles. Only renders when the
              active session reports a capability (e.g. boolean
              promptEvaluator OR chroxyContextHint OR string preamble).
              Older servers (pre-#3185 / pre-#3805 / pre-#4660) omit the
              fields entirely, in which case showing a non-functional
              control would mislead. */}
          {(typeof activeSessionPromptEvaluator === 'boolean' || typeof activeSessionChroxyContextHint === 'boolean' || typeof activeSessionSessionPreamble === 'string') && (
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
              {typeof activeSessionSessionPreamble === 'string' && (
                <div className="settings-field">
                  <label htmlFor="session-preamble-input">
                    Always include this context in every message
                  </label>
                  {/* #4662: conflict banner mirrors QuietHoursEditor
                      (#4570). Renders when a divergent server snapshot
                      arrives while the local draft is dirty. */}
                  {preambleConflict !== undefined && (
                    <div
                      className="settings-hint session-preamble-conflict-banner"
                      role="alert"
                      data-testid="session-preamble-conflict-banner"
                    >
                      <p>
                        Another client updated this session's preamble while
                        you were editing. Keep your unsaved changes, or
                        discard them and load the latest value?
                      </p>
                      <div className="settings-field">
                        <button
                          type="button"
                          onClick={handleAcceptPreambleDraft}
                          data-testid="session-preamble-conflict-accept"
                        >
                          Keep my edits
                        </button>
                        <button
                          type="button"
                          onClick={handleDiscardPreambleDraft}
                          data-testid="session-preamble-conflict-discard"
                        >
                          Discard and load latest
                        </button>
                      </div>
                    </div>
                  )}
                  <textarea
                    id="session-preamble-input"
                    value={preambleDraft}
                    onChange={(e) => setPreambleDraft(e.target.value)}
                    rows={4}
                    maxLength={4000}
                    placeholder="e.g. This is a Godot 4 project — prefer GDScript over C#. Always respond in concise bullet points."
                    data-testid="session-preamble-input"
                    className="settings-textarea"
                  />
                  <p className="settings-hint">
                    Prepended to the system prompt every turn so you don't have
                    to retype the same context in each message. Capped at 4000
                    characters. Applies to this session only and persists
                    across server restarts.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* #6772/#6829 — Session Rules viewer. Mirrors the mobile
              SettingsScreen SESSION RULES / PROJECT RULES lists: view the active
              session's auto-approval rules (session-scoped AND durable per-project
              "always allow" grants, clearly distinguished by scope), remove one, or
              clear all. Removing/clearing sends set_permission_rules via the store.
              Rendered when the active session's provider supports rules OR there are
              already-standing rules to manage. */}
          {activeSessionId != null && (providerSupportsRules || activeSessionRules.length > 0 || activePersistentRules.length > 0) && (
            <section className="settings-section" data-testid="session-rules-section">
              <h3>Session rules</h3>
              <p className="settings-hint">
                Tools you auto-approved for this session (<strong>Allow for Session</strong>)
                and durable grants that survive daemon restarts
                (<strong>Always allow</strong>). Remove one to require a prompt again.
              </p>

              {/* Session-scoped rules */}
              <div className="settings-field" data-testid="session-rules-list">
                <label>Session-scoped</label>
                {activeSessionRules.length === 0 ? (
                  <p className="settings-hint" data-testid="session-rules-empty">No active session rules.</p>
                ) : (
                  <>
                    <ul className="perm-rules-list">
                      {activeSessionRules.map((rule, index) => (
                        <li
                          key={`session-${rule.tool}-${rule.decision}-${index}`}
                          className="perm-rule-row"
                          data-testid={`session-rule-item-${rule.tool}`}
                        >
                          <span className="perm-rule-label">
                            <span className="perm-rule-scope perm-rule-scope-session">session</span>
                            {' '}<code>{rule.tool}</code> — {rule.decision === 'allow' ? 'auto-allow' : 'auto-deny'}
                          </span>
                          <button
                            type="button"
                            className="perm-rule-remove"
                            aria-label={`Remove session rule ${rule.tool}`}
                            data-testid={`session-rule-remove-${rule.tool}`}
                            onClick={() => setPermissionRules(activeSessionRules.filter((_, i) => i !== index))}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="settings-secondary-button"
                      data-testid="session-rules-clear"
                      onClick={() => setPermissionRules([])}
                    >
                      Clear all session rules
                    </button>
                  </>
                )}
              </div>

              {/* Durable per-project ("always allow") rules — only shown when present */}
              {activePersistentRules.length > 0 && (
                <div className="settings-field" data-testid="project-rules-list">
                  <label data-testid="project-rules-header">Project (always allow)</label>
                  <p className="settings-hint">
                    Persisted for{' '}
                    <code data-testid="project-rules-path">{activeSessionCwd ?? 'this project'}</code>
                    {' '}— survives daemon restarts.
                  </p>
                  <ul className="perm-rules-list">
                    {activePersistentRules.map((rule, index) => (
                      <li
                        key={`project-${rule.tool}-${rule.decision}-${index}`}
                        className="perm-rule-row"
                        data-testid={`project-rule-item-${rule.tool}`}
                      >
                        <span className="perm-rule-label">
                          <span className="perm-rule-scope perm-rule-scope-project">project</span>
                          {' '}<code>{rule.tool}</code> — {rule.decision === 'allow' ? 'always allow' : 'always deny'}
                        </span>
                        <button
                          type="button"
                          className="perm-rule-remove"
                          aria-label={`Remove project rule ${rule.tool}`}
                          data-testid={`project-rule-remove-${rule.tool}`}
                          onClick={() => setProjectPermissionRules(activePersistentRules.filter((_, i) => i !== index))}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="settings-secondary-button"
                    data-testid="project-rules-clear"
                    onClick={() => setProjectPermissionRules([])}
                  >
                    Clear all project rules
                  </button>
                </div>
              )}
            </section>
          )}

          {/* #6772 — Permission history. Read-only view of the server's permission
              audit trail (mode changes, session-rule changes, allow/deny decisions)
              for the active session — the first client to query the daemon's
              query_permission_audit API. Pull-on-demand (not live) so it never adds
              wire traffic unless opened. */}
          {activeSessionId != null && (
            <section className="settings-section" data-testid="permission-history-section">
              <h3>Permission history</h3>
              <p className="settings-hint">
                Recent permission decisions and rule changes for this session, from the
                server's audit log.
              </p>
              <button
                type="button"
                className="settings-secondary-button"
                data-testid="permission-history-load"
                disabled={permissionAuditLoading}
                onClick={() => queryPermissionAudit()}
              >
                {permissionAuditLoading ? 'Loading…' : permissionAudit == null ? 'Load history' : 'Refresh'}
              </button>
              {/* PR #6836 review — a malformed reply clears loading and lands here
                  instead of wedging the button; retry via the same Load button. */}
              {permissionAuditError && (
                <p className="settings-hint" role="alert" data-testid="permission-history-error">
                  Couldn't load permission history. Try again.
                </p>
              )}
              {permissionAudit != null && (
                permissionAudit.length === 0 ? (
                  <p className="settings-hint" data-testid="permission-history-empty">
                    No permission events recorded for this session yet.
                  </p>
                ) : (
                  <ul className="perm-audit-list" data-testid="permission-history-list">
                    {permissionAudit.map((entry, index) => (
                      <li
                        key={`audit-${entry.timestamp}-${index}`}
                        className="perm-audit-row"
                        data-testid={`permission-audit-entry-${index}`}
                      >
                        <span className="perm-audit-label">{describePermissionAuditEntry(entry)}</span>
                        <span className="perm-audit-time">{formatRelativeTime(entry.timestamp)}</span>
                      </li>
                    ))}
                  </ul>
                )
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

          {/* #3855: generalized Provider Credentials pane — manage API keys +
              OAuth status for every known provider from the dashboard. */}
          <ProviderCredentialsPane isOpen={isOpen} />

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

          {(onToggleConsoleTab || onToggleInterventionPing) && (
            <section className="settings-section" data-testid="dashboard-section">
              <h3>Dashboard</h3>
              {onToggleConsoleTab && (
                <div className="settings-field">
                  <label htmlFor="show-console-tab">Show Console tab</label>
                  <input
                    id="show-console-tab"
                    type="checkbox"
                    checked={showConsoleTab ?? false}
                    onChange={(e) => onToggleConsoleTab(e.target.checked)}
                  />
                </div>
              )}
              {/* #4891 — audible intervention ping toggle. Plays a short
                  chirp in this tab whenever the agent needs input (permission
                  request / question), even when the tab is minimized or
                  idle in the background. Defaults on; mute is per-device. */}
              {onToggleInterventionPing && (
                <div className="settings-field settings-field-checkbox">
                  <label htmlFor="intervention-ping-toggle">
                    <input
                      id="intervention-ping-toggle"
                      type="checkbox"
                      checked={interventionPingEnabled ?? true}
                      onChange={(e) => onToggleInterventionPing(e.target.checked)}
                      data-testid="intervention-ping-toggle"
                    />
                    Play a sound when the agent needs input
                  </label>
                  <p className="settings-hint">
                    A short chirp plays in this browser tab whenever a session
                    needs an intervention (permission prompt or question) — so
                    you get pulled back in even with the tab minimized or idle.
                    Applies to this device only. Repeat alerts for the same
                    request are deduped, and bursts across multiple sessions
                    are throttled into a single ping.
                  </p>
                </div>
              )}
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
              {/* #5356 — loopback by default; LAN exposure is an explicit opt-in. */}
              <div className="settings-field">
                <label htmlFor="expose-on-lan">Expose on local network</label>
                <input
                  id="expose-on-lan"
                  type="checkbox"
                  data-testid="expose-on-lan-toggle"
                  checked={exposeOnLan}
                  onChange={(e) => handleExposeOnLanChange(e.target.checked)}
                />
              </div>
              <p className="settings-help">
                Off (default): the server is reachable only from this machine
                (loopback). On: binds all network interfaces so phones on the
                same Wi-Fi can scan the QR code and connect. Leave off and use a
                tunnel (below) for remote access.
              </p>
              <div className="settings-field">
                {exposeOnLanError && (
                  <p className="tunnel-mode-error" role="alert">{exposeOnLanError}</p>
                )}
                {exposeOnLan !== savedExposeOnLan ? (
                  <button
                    type="button"
                    className="tunnel-restart-btn"
                    disabled={restarting}
                    onClick={async () => {
                      setRestarting(true)
                      await restartServer()
                      setSavedExposeOnLan(exposeOnLan)
                      setTimeout(() => setRestarting(false), 3000)
                    }}
                  >
                    {restarting ? 'Restarting...' : 'Restart Server to Apply'}
                  </button>
                ) : (
                  <p className="tunnel-mode-note">Server restart required after change</p>
                )}
              </div>
              <div className="settings-field">
                <span id="tunnel-mode-label">Tunnel mode</span>
                <div className="tunnel-mode-options" role="radiogroup" aria-labelledby="tunnel-mode-label">
                  {([
                    { value: 'none', label: 'Off', desc: 'No public tunnel' },
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
          {/* #5294 — global summon hotkey: edit/clear with live re-registration. */}
          {inTauri && (
            <section className="settings-section">
              <h3>Desktop</h3>
              <div className="settings-field">
                <label htmlFor="summon-hotkey">Summon hotkey</label>
                <div className="summon-hotkey-row">
                  <input
                    id="summon-hotkey"
                    type="text"
                    aria-label="Summon hotkey accelerator"
                    placeholder="e.g. CmdOrCtrl+Shift+K"
                    value={summonHotkeyInput}
                    onChange={(e) => setSummonHotkeyInput(e.target.value)}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    data-testid="summon-hotkey-input"
                  />
                  <button
                    type="button"
                    className="summon-hotkey-save"
                    disabled={summonHotkeySaving || summonHotkeyInput.trim() === (summonHotkeySaved ?? '')}
                    onClick={handleSaveSummonHotkey}
                    data-testid="summon-hotkey-save"
                  >
                    {summonHotkeySaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="summon-hotkey-clear"
                    disabled={summonHotkeySaving || (!summonHotkeyInput.trim() && !summonHotkeySaved)}
                    onClick={handleClearSummonHotkey}
                    data-testid="summon-hotkey-clear"
                  >
                    Clear
                  </button>
                </div>
                {summonHotkeyError && (
                  <p className="tunnel-mode-error" data-testid="summon-hotkey-error">{summonHotkeyError}</p>
                )}
                <p className="settings-hint">
                  A system-wide shortcut to bring Chroxy to the front, in Tauri
                  accelerator syntax (e.g. <code>CmdOrCtrl+Shift+K</code>). Applies
                  immediately — no restart. Leave blank to disable; the tray
                  &ldquo;Show Chroxy&rdquo; item is always available.
                </p>
              </div>
            </section>
          )}
    </div>
  )
}

/**
 * #5544: legacy slide-out modal. Kept as a thin wrapper around
 * `SettingsContent` so the `settings=1` URL param and any external callers
 * still open a dismissable panel. The primary entry points (gear / Cmd+,)
 * now redirect to the Control Room Settings tab instead — see App.tsx.
 */
export function SettingsPanel({ isOpen, onClose, showConsoleTab, onToggleConsoleTab, interventionPingEnabled, onToggleInterventionPing }: SettingsPanelProps) {
  const backdropRef = useRef<HTMLDivElement>(null)

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
        <SettingsContent
          active={isOpen}
          showConsoleTab={showConsoleTab}
          onToggleConsoleTab={onToggleConsoleTab}
          interventionPingEnabled={interventionPingEnabled}
          onToggleInterventionPing={onToggleInterventionPing}
        />
      </div>
    </>
  )
}
