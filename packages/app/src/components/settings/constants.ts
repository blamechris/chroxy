import type { VoiceInputMode } from '@chroxy/store-core';

/**
 * Shared constants for SettingsScreen and its extracted section components.
 * Lifted out of SettingsScreen.tsx so NotificationPrefsSection, VoiceInputSection,
 * and the QuietHoursEditor can reference the same label maps / option lists
 * without re-declaring them.
 */

/**
 * #4542: friendly labels for per-category notification toggles. Keys MUST
 * match the server-side `ALL_CATEGORIES` enum from notification-prefs.js
 * (mirrors RATE_LIMITS in push.js). Unknown keys fall back to the raw key
 * so a future server-side category is never silently hidden.
 */
export const NOTIFICATION_CATEGORY_LABELS: Record<string, { label: string; hint?: string }> = {
  permission: { label: 'Permission requests', hint: 'Tool-use prompts awaiting allow / deny.' },
  result: { label: 'Task completion', hint: 'Sent when a Claude turn finishes unattended.' },
  activity_update: { label: 'Activity updates', hint: 'Foreground task progress when you are away.' },
  activity_waiting: { label: 'Waiting for input', hint: 'Claude paused on a question or prompt.' },
  activity_error: { label: 'Session errors', hint: 'Crashes, tunnel drops, fatal session failures.' },
  inactivity_warning: { label: 'Inactivity warnings', hint: 'Heads-up before a long-idle session is paused.' },
  // #5828: billing canary early-warnings (silent metered default, claude-tui
  // reclassification, datacenter egress).
  billing_warning: { label: 'Billing alerts', hint: 'Metered-credit and datacenter-egress warnings from the billing canary.' },
  live_activity: { label: 'Live Activity (iOS)', hint: 'iOS Dynamic Island / lock-screen updates.' },
  // #5413 Phase 3: external-session categories fed by POST /api/events.
  session_online: { label: 'External session online', hint: 'An external session reported in via /api/events.' },
  session_offline: { label: 'External session offline', hint: 'An external session ended or went away.' },
  session_activity: { label: 'External session activity', hint: 'Subagent and tool activity from external sessions.' },
  // Mailbox live-interrupt: "new mail" pings fed by POST /api/mailbox.
  mailbox: { label: 'Mailbox', hint: 'New agent-to-agent mailbox messages waiting for a session.' },
};

/** Render order for known categories. Unknown keys append in snapshot order. */
export const NOTIFICATION_CATEGORY_ORDER = [
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
];

/**
 * #4544: documented defaults for the quiet-hours bypass list. Mirrors
 * `DEFAULT_BYPASS_CATEGORIES` from packages/server/src/notification-prefs.js.
 * Used when a snapshot omits the field (older server, fresh install) so
 * the UI shows the right initial checkboxes.
 */
export const DEFAULT_BYPASS_CATEGORIES = ['permission', 'activity_error'];

/**
 * #4544: HH:MM validation predicate. Mirrors the server-side regex in
 * `notification-prefs.js` so the mobile UI rejects malformed times before
 * round-tripping them.
 */
const HHMM_RE = /^\d{2}:\d{2}$/;
export function isValidHHMM(s: string): boolean {
  if (!HHMM_RE.test(s)) return false;
  const [h, m] = s.split(':').map(Number);
  return h <= 23 && m <= 59;
}

/**
 * #4807: voice input mode picker options. Mirrors the dashboard
 * `SettingsPanel` select (`packages/dashboard/src/components/SettingsPanel.tsx`)
 * and the shared `InputSettings.voiceInputMode` field. The mode union
 * itself is consolidated in `@chroxy/store-core` (#4825).
 */
export const VOICE_INPUT_MODES: { value: VoiceInputMode; label: string; hint: string }[] = [
  {
    value: 'continuous',
    label: 'Continuous',
    hint: 'Mic stays open until you tap stop.',
  },
  {
    value: 'auto-pause',
    label: 'Auto-pause',
    hint: 'Mic stops automatically on silence.',
  },
];

export const SPEECH_LANGUAGES = [
  { tag: 'en-US', label: 'English (US)' },
  { tag: 'en-GB', label: 'English (UK)' },
  { tag: 'es-ES', label: 'Spanish (Spain)' },
  { tag: 'es-MX', label: 'Spanish (Mexico)' },
  { tag: 'fr-FR', label: 'French' },
  { tag: 'de-DE', label: 'German' },
  { tag: 'it-IT', label: 'Italian' },
  { tag: 'pt-BR', label: 'Portuguese (Brazil)' },
  { tag: 'pt-PT', label: 'Portuguese (Portugal)' },
  { tag: 'nl-NL', label: 'Dutch' },
  { tag: 'ja-JP', label: 'Japanese' },
  { tag: 'ko-KR', label: 'Korean' },
  { tag: 'zh-CN', label: 'Chinese (Simplified)' },
  { tag: 'zh-TW', label: 'Chinese (Traditional)' },
  { tag: 'ru-RU', label: 'Russian' },
  { tag: 'ar-SA', label: 'Arabic' },
];

// #4559: shared inline-error copy for notification-prefs writes that fired
// while the WS was closed. Pre-#4559 the action silently no-op'd and the
// Switch revert looked like a misfire. The mobile copy mirrors the
// dashboard's banner so users see the same instruction on both clients.
export const WS_CLOSED_MESSAGE =
  'Settings save failed — server disconnected. Reconnect and try again.';

// #4585: shared copy for the capability-gated "not supported" hint. Both the
// Categories and Quiet-hours sections render this when the server lacks the
// `notificationPrefs` capability. Previously the quiet-hours section showed
// a terser one-liner that made it ambiguous whether quiet hours needed a
// different upgrade than the rest of notifications — the dashboard avoids
// this by colocating both controls under a single capability-gated hint,
// but the mobile layout keeps them as separate sections so the fix is to
// echo the same long copy in both.
export const NOTIFICATION_PREFS_UNSUPPORTED_MESSAGE =
  'Your server does not support notification preferences. Upgrade to chroxy v0.9.14 or newer to manage per-category opt-in, per-device mutes, and quiet hours from here.';
