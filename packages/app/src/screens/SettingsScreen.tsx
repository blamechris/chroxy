import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Switch,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
  Modal,
  Pressable,
  Platform,
  AccessibilityInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import { useConnectionStore } from '../store/connection';
import { useConnectionLifecycleStore } from '../store/connection-lifecycle';
import { COLORS } from '../constants/colors';
import type { PermissionRule } from '../store/types';
import type { RootStackParamList } from '../App';
import { getSpeechLang, setSpeechLang } from '../hooks/useSpeechRecognition';
import {
  isBiometricAvailable,
  getBiometricEnabled,
  setBiometricEnabled,
  authenticate,
} from '../hooks/useBiometricLock';
import {
  buildQuietHoursTimezoneList,
  formatPlatform,
  formatRelativeTime,
} from '@chroxy/store-core';

const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';

// Stable reference for empty session rules — prevents Zustand selector from
// returning a new [] on every render (which causes infinite re-render loops).
const EMPTY_RULES: PermissionRule[] = [];

/**
 * #4542: friendly labels for per-category notification toggles. Keys MUST
 * match the server-side `ALL_CATEGORIES` enum from notification-prefs.js
 * (mirrors RATE_LIMITS in push.js). Unknown keys fall back to the raw key
 * so a future server-side category is never silently hidden.
 */
const NOTIFICATION_CATEGORY_LABELS: Record<string, { label: string; hint?: string }> = {
  permission: { label: 'Permission requests', hint: 'Tool-use prompts awaiting allow / deny.' },
  result: { label: 'Task completion', hint: 'Sent when a Claude turn finishes unattended.' },
  activity_update: { label: 'Activity updates', hint: 'Foreground task progress when you are away.' },
  activity_waiting: { label: 'Waiting for input', hint: 'Claude paused on a question or prompt.' },
  activity_error: { label: 'Session errors', hint: 'Crashes, tunnel drops, fatal session failures.' },
  inactivity_warning: { label: 'Inactivity warnings', hint: 'Heads-up before a long-idle session is paused.' },
  live_activity: { label: 'Live Activity (iOS)', hint: 'iOS Dynamic Island / lock-screen updates.' },
};

/** Render order for known categories. Unknown keys append in snapshot order. */
const NOTIFICATION_CATEGORY_ORDER = [
  'permission',
  'activity_waiting',
  'activity_error',
  'activity_update',
  'inactivity_warning',
  'result',
  'live_activity',
];

/**
 * #4544: documented defaults for the quiet-hours bypass list. Mirrors
 * `DEFAULT_BYPASS_CATEGORIES` from packages/server/src/notification-prefs.js.
 * Used when a snapshot omits the field (older server, fresh install) so
 * the UI shows the right initial checkboxes.
 */
const DEFAULT_BYPASS_CATEGORIES = ['permission', 'activity_error'];

/**
 * #4544: HH:MM validation predicate. Mirrors the server-side regex in
 * `notification-prefs.js` so the mobile UI rejects malformed times before
 * round-tripping them.
 */
const HHMM_RE = /^\d{2}:\d{2}$/;
function isValidHHMM(s: string): boolean {
  if (!HHMM_RE.test(s)) return false;
  const [h, m] = s.split(':').map(Number);
  return h <= 23 && m <= 59;
}

const SPEECH_LANGUAGES = [
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
const WS_CLOSED_MESSAGE =
  'Settings save failed — server disconnected. Reconnect and try again.';

// #4585: shared copy for the capability-gated "not supported" hint. Both the
// Categories and Quiet-hours sections render this when the server lacks the
// `notificationPrefs` capability. Previously the quiet-hours section showed
// a terser one-liner that made it ambiguous whether quiet hours needed a
// different upgrade than the rest of notifications — the dashboard avoids
// this by colocating both controls under a single capability-gated hint,
// but the mobile layout keeps them as separate sections so the fix is to
// echo the same long copy in both.
const NOTIFICATION_PREFS_UNSUPPORTED_MESSAGE =
  'Your server does not support notification preferences. Upgrade to chroxy v0.9.14 or newer to manage per-category opt-in, per-device mutes, and quiet hours from here.';

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [speechLang, setSpeechLangState] = useState<string>('en-US');
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [biometricAvail, setBiometricAvail] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);
  // #4559: surfaces "server disconnected" when a notification-prefs Switch
  // tap fires while the WS is closed. Cleared on a subsequent successful
  // write (post-reconnect) so a stale banner can't persist after recovery.
  const [notifWsClosedError, setNotifWsClosedError] = useState<string | null>(null);

  useEffect(() => {
    getSpeechLang()
      .then(setSpeechLangState)
      .catch(() => {
        // Ignore — falls back to default 'en-US'
      });
    isBiometricAvailable().then((avail) => {
      setBiometricAvail(avail);
      // Auto-disable if biometrics became unavailable (e.g., enrollment removed)
      if (!avail) {
        getBiometricEnabled().then((wasOn) => {
          if (wasOn) {
            setBiometricEnabled(false);
            setBiometricOn(false);
          }
        });
      }
    });
    getBiometricEnabled().then(setBiometricOn);
  }, []);

  const handleSelectLang = async (tag: string) => {
    setSpeechLangState(tag);
    await setSpeechLang(tag);
    setShowLangPicker(false);
  };

  const currentLangLabel = SPEECH_LANGUAGES.find((l) => l.tag === speechLang)?.label ?? speechLang;

  const {
    inputSettings,
    updateInputSettings,
    forgetSession,
    disconnect,
    clearSavedConnection,
    requestFullHistory,
    setPermissionRules,
  } = useConnectionStore();

  const activeSessionId = useConnectionStore((s) => s.activeSessionId);
  const sessionRules = useConnectionStore((s) => {
    const id = s.activeSessionId;
    if (!id || !s.sessionStates[id]) return EMPTY_RULES;
    return s.sessionStates[id].sessionRules ?? EMPTY_RULES;
  });

  // Use the connection store as source of truth — same store SessionScreen and
  // SessionNotificationBanner read from, so counts and dismissals stay in sync.
  const sessionNotifications = useConnectionStore((s) => s.sessionNotifications);
  const serverErrors = useConnectionStore((s) => s.serverErrors);
  const dismissSessionNotification = useConnectionStore((s) => s.dismissSessionNotification);
  const dismissServerError = useConnectionStore((s) => s.dismissServerError);
  const totalActiveNotifications = sessionNotifications.length + serverErrors.length;

  // #4542: per-category notification preferences. Snapshot arrives via the
  // WS `notification_prefs` message; we request it on mount and toggle a
  // single category at a time via `notification_prefs_set` (server shallow-
  // merges so untouched categories are preserved).
  const notificationPrefs = useConnectionStore((s) => s.notificationPrefs);
  const refreshNotificationPrefs = useConnectionStore((s) => s.refreshNotificationPrefs);
  const setNotificationPrefsCategory = useConnectionStore((s) => s.setNotificationPrefsCategory);
  // #4543: per-device override. `pushToken` is the registered Expo token
  // for THIS device, used as the key into `notificationPrefs.devices`. Null
  // when push registration hasn't completed (simulator, permission denied,
  // pre-`register_push_token`); the per-device toggle row is suppressed in
  // that state so we never ship a `devices[null]` patch.
  const pushToken = useConnectionStore((s) => s.pushToken);
  const setNotificationPrefsDevice = useConnectionStore((s) => s.setNotificationPrefsDevice);
  // #4564: drop an entire per-device entry — the per-row "Clear" button in
  // the known-devices list calls this to drain orphans from the prefs
  // file (token refresh / app reinstall / browser-id wipe).
  const deleteNotificationPrefsDevice = useConnectionStore((s) => s.deleteNotificationPrefsDevice);
  // #4544: quiet-hours editor actions. The window is global; per-device
  // overrides are owned by a future iteration. `bypassCategories` is the
  // list of categories that fire even during quiet hours.
  const setNotificationPrefsQuietHours = useConnectionStore((s) => s.setNotificationPrefsQuietHours);
  const setNotificationPrefsBypassCategories = useConnectionStore((s) => s.setNotificationPrefsBypassCategories);
  // #4560: capability gate for the Notifications sections. Pre-#4541 servers
  // have no `notification_prefs_get` handler — without this gate the
  // category list + quiet-hours editor sat on "Loading preferences…" forever
  // waiting for a snapshot that would never arrive. Empty map = fail-closed
  // so an older server (or a still-connecting one) surfaces the explicit
  // "not supported" message instead of dead UI. Declared above the refresh
  // useEffect so it can be referenced from both the dep array and the
  // early-return guard.
  const notificationPrefsSupported = useConnectionLifecycleStore(
    (s) => !!s.serverCapabilities?.notificationPrefs,
  );

  useEffect(() => {
    // #4559: ignore the boolean return on initial refresh — a closed
    // socket on mount is the common case (mobile re-opens the app while
    // the tunnel is still recovering). The inline banner only fires for
    // user-initiated writes; the snapshot will arrive once the connection
    // settles.
    //
    // #4560: skip the refresh entirely when the server doesn't advertise
    // the `notificationPrefs` capability. Pre-#4541 servers have no handler
    // for `notification_prefs_get`, so the request would either get
    // rejected as an `unknown_message` error or silently dropped — either
    // way no snapshot lands and the loading hint sits forever. Skipping
    // the WS write also keeps the gated render decisions self-consistent.
    if (!notificationPrefsSupported) return;
    refreshNotificationPrefs();
  }, [notificationPrefsSupported, refreshNotificationPrefs]);

  // #4559: thin wrappers around the four notification-prefs setters. Each
  // delegates to the store action (which returns `true` when sent, `false`
  // when the WS is closed) and updates the inline banner accordingly.
  // Sharing the wrappers keeps the success → clear / failure → set
  // behaviour uniform so we can't forget to clear on a later success.
  const handleSetCategory = useCallback((cat: string, value: boolean) => {
    const sent = setNotificationPrefsCategory(cat, value);
    setNotifWsClosedError(sent ? null : WS_CLOSED_MESSAGE);
  }, [setNotificationPrefsCategory]);

  const handleSetDevice = useCallback((deviceKey: string, cat: string, value: boolean) => {
    const sent = setNotificationPrefsDevice(deviceKey, cat, value);
    setNotifWsClosedError(sent ? null : WS_CLOSED_MESSAGE);
  }, [setNotificationPrefsDevice]);

  // #4564: per-row "Clear" handler. Same WS-closed banner contract as the
  // other notification-prefs setters so a botched clear isn't silent.
  //
  // #4588: clearing the row matching `pushToken` (the operator's own
  // device) silently wipes whatever per-category mutes / quiet-hours
  // overrides they had set up; the next push will fire under global
  // defaults with no other warning. Prompt with a destructive Clear
  // button only for that row — orphan rows (key !== pushToken) flow
  // straight through so the orphan-cleanup affordance stays one-tap.
  const handleClearDevice = useCallback((deviceKey: string) => {
    const dispatch = () => {
      const sent = deleteNotificationPrefsDevice(deviceKey);
      setNotifWsClosedError(sent ? null : WS_CLOSED_MESSAGE);
    };
    if (deviceKey === pushToken) {
      Alert.alert(
        'Clear this device?',
        'Notifications on this device will fall back to global defaults.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Clear', style: 'destructive', onPress: dispatch },
        ],
      );
      return;
    }
    dispatch();
  }, [deleteNotificationPrefsDevice, pushToken]);

  const handleSetQuietHours = useCallback((win: { start: string; end: string; timezone: string } | null) => {
    const sent = setNotificationPrefsQuietHours(win);
    setNotifWsClosedError(sent ? null : WS_CLOSED_MESSAGE);
  }, [setNotificationPrefsQuietHours]);

  const handleSetBypassCategories = useCallback((cats: string[]) => {
    const sent = setNotificationPrefsBypassCategories(cats);
    setNotifWsClosedError(sent ? null : WS_CLOSED_MESSAGE);
  }, [setNotificationPrefsBypassCategories]);

  const orderedNotificationCategories = useMemo(() => {
    if (!notificationPrefs) return [];
    const cats = notificationPrefs.categories;
    const known = NOTIFICATION_CATEGORY_ORDER.filter((k) => k in cats);
    const unknown = Object.keys(cats).filter((k) => !NOTIFICATION_CATEGORY_ORDER.includes(k));
    return [...known, ...unknown];
  }, [notificationPrefs]);

  const serverVersion = useConnectionLifecycleStore((s) => s.serverVersion);
  const latestVersion = useConnectionLifecycleStore((s) => s.latestVersion);
  const serverMode = useConnectionLifecycleStore((s) => s.serverMode);
  const wsUrl = useConnectionLifecycleStore((s) => s.wsUrl);
  const connectionPhase = useConnectionLifecycleStore((s) => s.connectionPhase);

  const conversationId = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].conversationId : null;
  });

  // Permission history summary counts
  const sessions = useConnectionStore((s) => s.sessions);
  const sessionStates = useConnectionStore((s) => s.sessionStates);

  const permissionSummary = useMemo(() => {
    let allowed = 0;
    let denied = 0;
    let total = 0;

    const countMsg = (msg: { type: string; requestId?: string; answered?: string }) => {
      if (msg.type !== 'prompt' || !msg.requestId) return;
      total++;
      if (msg.answered === 'allow' || msg.answered === 'allowAlways' || msg.answered === 'allowSession') allowed++;
      else if (msg.answered === 'deny') denied++;
    };

    for (const s of sessions) {
      const ss = sessionStates[s.sessionId];
      if (ss) ss.messages.forEach(countMsg);
    }

    return { allowed, denied, total };
  }, [sessions, sessionStates]);

  // Simple semver comparison: check if latest > current (not just different)
  const updateAvailable = (() => {
    if (!serverVersion || !latestVersion || latestVersion === serverVersion) return false;
    const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
    const cur = parse(serverVersion);
    const lat = parse(latestVersion);
    for (let i = 0; i < 3; i++) {
      if ((lat[i] || 0) > (cur[i] || 0)) return true;
      if ((lat[i] || 0) < (cur[i] || 0)) return false;
    }
    return false;
  })();

  const handleClearSessionHistory = () => {
    Alert.alert(
      'Clear Session History',
      'This will erase all chat messages and disconnect from the server.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            disconnect();
            forgetSession();
          },
        },
      ],
    );
  };

  const handleClearSavedConnection = () => {
    Alert.alert(
      'Clear Saved Connection',
      'This will remove the saved server URL and token used for quick reconnect.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearSavedConnection();
            Alert.alert('Done', 'Saved connection has been cleared.');
          },
        },
      ],
    );
  };

  const truncatedUrl = wsUrl
    ? wsUrl.length > 40
      ? wsUrl.slice(0, 37) + '...'
      : wsUrl
    : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      {/* SESSION */}
      <Text style={styles.sectionHeader}>SESSION</Text>
      <View style={styles.section}>
        <TouchableOpacity style={styles.row} onPress={handleClearSessionHistory}>
          <Text style={styles.destructiveText}>Clear Session History</Text>
        </TouchableOpacity>
      </View>

      {/* PERMISSIONS */}
      {permissionSummary.total > 0 && (
        <>
          <Text style={styles.sectionHeader}>PERMISSIONS</Text>
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.row}
              onPress={() => navigation.navigate('PermissionHistory')}
            >
              <Text style={styles.rowLabel}>Permission History</Text>
              <Text style={styles.rowValue}>
                {permissionSummary.allowed} allowed{permissionSummary.denied > 0 ? `, ${permissionSummary.denied} denied` : ''}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* SESSION RULES */}
      {activeSessionId != null && (
        <>
          <Text style={styles.sectionHeader}>SESSION RULES</Text>
          <View style={styles.section}>
            {sessionRules.length === 0 ? (
              <View style={styles.row}>
                <Text style={styles.rowHint}>No active rules</Text>
              </View>
            ) : (
              <>
                <View style={styles.rulesContainer}>
                  {sessionRules.map((rule: PermissionRule, index: number) => (
                    <TouchableOpacity
                      key={`${rule.tool}-${rule.decision}-${index}`}
                      style={[
                        styles.ruleChip,
                        rule.decision === 'allow' ? styles.ruleChipAllow : styles.ruleChipDeny,
                      ]}
                      onPress={() => {
                        const updated = sessionRules.filter((_: PermissionRule, i: number) => i !== index);
                        setPermissionRules(updated);
                      }}
                    >
                      <Text
                        style={[
                          styles.ruleChipText,
                          rule.decision === 'allow' ? styles.ruleChipTextAllow : styles.ruleChipTextDeny,
                        ]}
                      >
                        {rule.tool}
                        {rule.pattern ? ` (${rule.pattern})` : ''} — {rule.decision === 'allow' ? 'auto-allow' : 'auto-deny'}
                      </Text>
                      <Text
                        style={[
                          styles.ruleChipRemove,
                          rule.decision === 'allow' ? styles.ruleChipTextAllow : styles.ruleChipTextDeny,
                        ]}
                      >
                        {' \u00d7'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.separator} />
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => setPermissionRules([])}
                >
                  <Text style={styles.destructiveText}>Clear All Rules</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </>
      )}

      {/* CONNECTION */}
      <Text style={styles.sectionHeader}>CONNECTION</Text>
      <View style={styles.section}>
        <TouchableOpacity style={styles.row} onPress={handleClearSavedConnection}>
          <Text style={styles.destructiveText}>Clear Saved Connection</Text>
        </TouchableOpacity>
      </View>

      {/* SECURITY — show when hardware available, or when preference is
           still enabled (so user can disable it even if biometrics were revoked) */}
      {(biometricAvail || biometricOn) && (
        <>
          <Text style={styles.sectionHeader}>SECURITY</Text>
          <View style={styles.section}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Biometric Lock</Text>
              <Switch
                value={biometricOn}
                disabled={!biometricAvail && !biometricOn}
                onValueChange={async (value) => {
                  if (value) {
                    // Verify biometric before enabling
                    const ok = await authenticate();
                    if (!ok) return;
                  }
                  setBiometricOn(value);
                  await setBiometricEnabled(value);
                }}
                trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
              />
            </View>
            <View style={styles.separator} />
            <View style={styles.row}>
              <Text style={[styles.rowLabel, styles.rowHint]}>
                {biometricAvail
                  ? 'Require Face ID / Touch ID when returning to the app'
                  : 'Biometric hardware unavailable — toggle off to disable lock'}
              </Text>
            </View>
          </View>
        </>
      )}

      {/* NOTIFICATIONS */}
      <Text style={styles.sectionHeader}>NOTIFICATIONS</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Active Banners</Text>
          <Text style={styles.rowValue}>
            {totalActiveNotifications === 0 ? 'None' : `${totalActiveNotifications} pending`}
          </Text>
        </View>
        {totalActiveNotifications > 0 && (
          <>
            <View style={styles.separator} />
            <TouchableOpacity
              style={styles.row}
              onPress={() => {
                sessionNotifications.forEach((n) => dismissSessionNotification(n.id));
                serverErrors.forEach((e) => dismissServerError(e.id));
              }}
            >
              <Text style={styles.actionText}>Dismiss All</Text>
            </TouchableOpacity>
          </>
        )}
        <View style={styles.separator} />
        <TouchableOpacity
          style={styles.row}
          onPress={() => navigation.navigate('Activity')}
          accessibilityRole="button"
          accessibilityLabel="View activity history"
        >
          <Text style={styles.rowLabel}>Activity History</Text>
          <Text style={styles.rowValue}>View all</Text>
        </TouchableOpacity>
      </View>

      {/* NOTIFICATIONS — Categories (#4542) + per-device opt-in/out (#4543) */}
      <Text style={styles.sectionHeader}>NOTIFICATION CATEGORIES</Text>
      {/* #4559: inline "server disconnected" warning. Surfaces when any
          notification-prefs Switch tap fires while the WS is closed so the
          revert is no longer a silent no-op. accessibilityRole='alert' so
          VoiceOver / TalkBack announce the failure rather than letting the
          Switch revert pass without explanation. */}
      {notifWsClosedError && (
        <View style={styles.wsClosedBanner} testID="notification-prefs-ws-closed-error">
          <Text
            style={styles.wsClosedBannerText}
            accessibilityRole="alert"
          >
            {notifWsClosedError}
          </Text>
        </View>
      )}
      <View style={styles.section} testID="notification-prefs-section">
        {!notificationPrefsSupported ? (
          // #4560: capability-gated branch. Pre-#4541 servers don't have a
          // `notification_prefs_get` handler — the user must upgrade to
          // chroxy v0.9.14+ to manage these. Without this branch the
          // section sat on "Loading preferences…" forever.
          <View style={styles.row}>
            <Text style={styles.rowHint} testID="notification-prefs-not-supported">
              {NOTIFICATION_PREFS_UNSUPPORTED_MESSAGE}
            </Text>
          </View>
        ) : notificationPrefs == null ? (
          <View style={styles.row}>
            <Text style={styles.rowHint} testID="notification-prefs-loading">
              Loading preferences&hellip;
            </Text>
          </View>
        ) : (
          orderedNotificationCategories.map((cat, idx) => {
            const meta = NOTIFICATION_CATEGORY_LABELS[cat];
            const label = meta?.label ?? cat;
            const hint = meta?.hint;
            const checked = notificationPrefs.categories[cat] !== false;
            // #4543: per-device override resolution for THIS device.
            //   - explicit `false` → muted on this device.
            //   - explicit `true`  → unmuted on this device (overrides a
            //                        `false` global default).
            //   - missing entry    → falls through to global default; mute
            //                        toggle shows unchecked.
            // The mute Switch carries the inverse boolean: a tap to enable
            // mute === sending `enabled: false` on the wire.
            const deviceOverride = pushToken
              ? notificationPrefs.devices?.[pushToken]?.categories?.[cat]
              : undefined;
            const mutedOnThisDevice = deviceOverride === false;
            return (
              <React.Fragment key={cat}>
                {idx > 0 && <View style={styles.separator} />}
                <View style={styles.row}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.rowLabel}>{label}</Text>
                    {hint && (
                      <Text style={[styles.rowHint, { marginTop: 2 }]}>{hint}</Text>
                    )}
                  </View>
                  <Switch
                    value={checked}
                    onValueChange={(value) => handleSetCategory(cat, value)}
                    trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
                    testID={`notification-prefs-toggle-${cat}`}
                  />
                </View>
                {pushToken && (
                  <View
                    style={[styles.row, styles.deviceOverrideRow]}
                    testID={`notification-prefs-device-row-${cat}`}
                  >
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={styles.rowHint}>Mute on this device</Text>
                    </View>
                    <Switch
                      value={mutedOnThisDevice}
                      onValueChange={(value) => handleSetDevice(pushToken, cat, !value)}
                      trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
                      testID={`notification-prefs-device-toggle-${cat}`}
                    />
                  </View>
                )}
              </React.Fragment>
            );
          })
        )}
      </View>

      {/* NOTIFICATIONS — Quiet hours (#4544) */}
      <Text style={styles.sectionHeader}>QUIET HOURS</Text>
      <View style={styles.section} testID="quiet-hours-section">
        {!notificationPrefsSupported ? (
          // #4560: same capability gate as the categories section above.
          // The QuietHoursEditor reads from `notificationPrefs.quietHours`
          // which never lands on a pre-#4541 server, so rendering the
          // editor would put it in a permanent loading state.
          <View style={styles.row}>
            <Text style={styles.rowHint} testID="quiet-hours-not-supported">
              {NOTIFICATION_PREFS_UNSUPPORTED_MESSAGE}
            </Text>
          </View>
        ) : notificationPrefs == null ? (
          <View style={styles.row}>
            <Text style={styles.rowHint}>Loading preferences&hellip;</Text>
          </View>
        ) : (
          <QuietHoursEditor
            window={notificationPrefs.quietHours}
            categories={notificationPrefs.categories}
            bypassCategories={notificationPrefs.bypassCategories ?? DEFAULT_BYPASS_CATEGORIES}
            onWindowChange={handleSetQuietHours}
            onBypassChange={handleSetBypassCategories}
          />
        )}
      </View>

      {/* NOTIFICATIONS — Known devices (#4564). Renders even when empty
          so users find the affordance once orphans accumulate. Gated on
          the notificationPrefs capability + a loaded snapshot, mirroring
          the categories/quiet-hours sections. */}
      {notificationPrefsSupported && notificationPrefs != null && (
        <>
          <Text style={styles.sectionHeader}>PER-DEVICE OVERRIDES</Text>
          <View style={styles.section}>
            <KnownDevicesList
              devices={notificationPrefs.devices}
              currentDeviceKey={pushToken}
              onClear={handleClearDevice}
            />
          </View>
        </>
      )}

      {/* PORTABILITY */}
      {conversationId != null && (
        <>
          <Text style={styles.sectionHeader}>PORTABILITY</Text>
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.row}
              onPress={async () => {
                try {
                  await Clipboard.setStringAsync(conversationId);
                  Alert.alert(
                    'Copied',
                    `Resume from terminal:\n\nclaude --resume ${conversationId}`,
                  );
                } catch {
                  Alert.alert('Error', 'Failed to copy.');
                }
              }}
            >
              <Text style={styles.rowLabel}>Conversation ID</Text>
              <Text style={[styles.rowValue, styles.rowValueSmall]} numberOfLines={1}>
                {conversationId.slice(0, 8)}...
              </Text>
            </TouchableOpacity>
            <View style={styles.separator} />
            <TouchableOpacity
              style={styles.row}
              onPress={() => {
                requestFullHistory();
                Alert.alert('Syncing', 'Full conversation history requested from server.');
              }}
            >
              <Text style={styles.actionText}>Sync Full History</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* INPUT */}
      <Text style={styles.sectionHeader}>INPUT</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Chat: Enter to Send</Text>
          <Switch
            value={inputSettings.chatEnterToSend}
            onValueChange={(value) => updateInputSettings({ chatEnterToSend: value })}
            trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
          />
        </View>
        <View style={styles.separator} />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Terminal: Enter to Send</Text>
          <Switch
            value={inputSettings.terminalEnterToSend}
            onValueChange={(value) => updateInputSettings({ terminalEnterToSend: value })}
            trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
          />
        </View>
        <View style={styles.separator} />
        <TouchableOpacity style={styles.row} onPress={() => setShowLangPicker(true)}>
          <Text style={styles.rowLabel}>Speech Language</Text>
          <Text style={styles.rowValue}>{currentLangLabel}</Text>
        </TouchableOpacity>
      </View>

      {/* ABOUT */}
      <Text style={styles.sectionHeader}>ABOUT</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>App Version</Text>
          <Text style={styles.rowValue}>{APP_VERSION}</Text>
        </View>
        {serverVersion != null && (
          <>
            <View style={styles.separator} />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Server Version</Text>
              <View style={styles.versionRow}>
                <Text style={styles.rowValue}>{serverVersion}</Text>
                {updateAvailable && (
                  <View style={styles.updateBadge}>
                    <Text style={styles.updateBadgeText}>{latestVersion} available</Text>
                  </View>
                )}
              </View>
            </View>
          </>
        )}
        {serverMode != null && (
          <>
            <View style={styles.separator} />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Server Mode</Text>
              <Text style={styles.rowValue}>{serverMode}</Text>
            </View>
          </>
        )}
        {truncatedUrl != null && (
          <>
            <View style={styles.separator} />
            <TouchableOpacity
              style={styles.row}
              onPress={async () => {
                if (wsUrl) {
                  try {
                    await Clipboard.setStringAsync(wsUrl);
                    Alert.alert('Copied', 'Server URL copied to clipboard.');
                  } catch (error) {
                    console.error('Failed to copy server URL to clipboard:', error);
                    Alert.alert('Error', 'Failed to copy server URL to clipboard.');
                  }
                }
              }}
            >
              <Text style={styles.rowLabel}>Server</Text>
              <Text style={[styles.rowValue, styles.rowValueSmall]} numberOfLines={1}>
                {truncatedUrl}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* DEBUG — UX landmine #9: Copy Diagnostics + #10: Re-show onboarding */}
      <Text style={styles.sectionHeader}>DEBUG</Text>
      <View style={styles.section}>
        <TouchableOpacity
          style={styles.row}
          onPress={async () => {
            const urlHost = wsUrl ? new URL(wsUrl).host : 'none';
            const recentErrors = serverErrors.slice(-5).map((e: { message?: string; code?: string }) =>
              `${e.code || 'ERR'}: ${e.message || 'unknown'}`
            );
            const diag = [
              `app: ${APP_VERSION}`,
              `server: ${serverVersion ?? 'unknown'}`,
              `phase: ${connectionPhase}`,
              `mode: ${serverMode ?? 'unknown'}`,
              `host: ${urlHost}`,
              `platform: ${Platform.OS} ${Platform.Version}`,
              `sessions: ${sessions.length}`,
              ...(recentErrors.length > 0 ? [`errors: ${recentErrors.join('; ')}`] : []),
            ].join('\n');
            try {
              await Clipboard.setStringAsync(diag);
              Alert.alert('Copied', 'Diagnostics copied to clipboard.');
            } catch {
              Alert.alert('Error', 'Failed to copy diagnostics.');
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Copy diagnostics to clipboard"
        >
          <Text style={styles.rowLabel}>Copy Diagnostics</Text>
          <Text style={styles.rowValue}>Tap to copy</Text>
        </TouchableOpacity>
        <View style={styles.separator} />
        <TouchableOpacity
          style={styles.row}
          onPress={async () => {
            try {
              const SecureStore = await import('expo-secure-store');
              await SecureStore.deleteItemAsync('onboarding_complete');
              Alert.alert('Tutorial Reset', 'The onboarding tutorial will show next time you open the app.');
            } catch {
              Alert.alert('Error', 'Failed to reset onboarding state.');
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Show tutorial again"
        >
          <Text style={styles.rowLabel}>Show Tutorial</Text>
          <Text style={styles.rowValue}>Reset onboarding</Text>
        </TouchableOpacity>
      </View>

      {/* Speech language picker */}
      <Modal visible={showLangPicker} transparent animationType="slide" onRequestClose={() => setShowLangPicker(false)}>
        <Pressable style={styles.sheetOverlay} onPress={() => setShowLangPicker(false)}>
          <Pressable style={[styles.sheetContent, { paddingBottom: Math.max(insets.bottom, 8) }]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Speech Language</Text>
            <ScrollView style={styles.sheetList} bounces={false}>
              {SPEECH_LANGUAGES.map((lang) => (
                <TouchableOpacity
                  key={lang.tag}
                  style={[styles.sheetOption, lang.tag === speechLang && styles.sheetOptionActive]}
                  onPress={() => handleSelectLang(lang.tag)}
                >
                  <Text style={[styles.sheetOptionText, lang.tag === speechLang && styles.sheetOptionTextActive]}>
                    {lang.label}
                  </Text>
                  <Text style={styles.sheetOptionTag}>{lang.tag}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={[styles.sheetOption, styles.sheetCancel]} onPress={() => setShowLangPicker(false)}>
              <Text style={[styles.sheetOptionText, styles.sheetCancelText]}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

/**
 * #4544: mobile quiet-hours editor.
 *
 * Mirrors the dashboard `QuietHoursEditor` shape: enable toggle, HH:MM
 * inputs for start/end, timezone picker (modal), and a per-category bypass
 * list. Owns draft state so partial edits don't round-trip every keystroke;
 * `Save` commits the window in one WS message. Bypass toggles patch
 * immediately because they're booleans without an intermediate form
 * stage.
 */
function QuietHoursEditor(props: {
  window: { start: string; end: string; timezone: string } | null;
  categories: Record<string, boolean>;
  bypassCategories: string[];
  onWindowChange: (w: { start: string; end: string; timezone: string } | null) => void;
  onBypassChange: (categories: string[]) => void;
}) {
  const { window: win, categories, bypassCategories, onWindowChange, onBypassChange } = props;
  // Resolve the device's IANA timezone once. `Intl.DateTimeFormat` is
  // available in modern Hermes / JSC — the try/catch covers an extremely
  // old runtime gracefully.
  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
  }, []);
  const tzOptions = useMemo(() => buildQuietHoursTimezoneList(browserTz), [browserTz]);

  const [enabled, setEnabled] = useState<boolean>(win != null);
  const [start, setStart] = useState<string>(win?.start ?? '22:00');
  const [end, setEnd] = useState<string>(win?.end ?? '07:00');
  const [timezone, setTimezone] = useState<string>(win?.timezone ?? browserTz);
  const [showTzPicker, setShowTzPicker] = useState(false);

  // #4570: track "user has typed but not saved" so an incoming snapshot
  // broadcast doesn't clobber the in-flight draft. Cleared on save / disable
  // / explicit accept. Read via ref inside the snapshot effect so the
  // dependency array stays minimal (adding `dirty` would re-run the effect
  // when dirty changes and re-apply the snapshot we just skipped).
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  // #4570: parked snapshot when a broadcast arrives mid-edit. `undefined`
  // means no pending conflict; `null` means "remote disabled"; an object
  // means "remote changed window".
  const [pendingSnapshot, setPendingSnapshot] = useState<
    | { start: string; end: string; timezone: string }
    | null
    | undefined
  >(undefined);

  // #4595: VoiceOver fallback for the conflict banner on iOS.
  // #4594 (the original a11y wiring) set `accessibilityLiveRegion="polite"`
  // on the banner View, which is what Android TalkBack uses to auto-announce
  // a region as it mounts. The prop is Android-only — iOS VoiceOver does
  // NOT auto-announce live regions; it only speaks when focus moves to the
  // View. A user editing the field via VoiceOver would never hear about the
  // divergent snapshot. AccessibilityInfo.announceForAccessibility is the
  // iOS equivalent of the live-region announce. We gate on Platform.OS so
  // Android (which already gets the announcement via the live-region prop)
  // doesn't double-speak the same line. The effect fires on every mount of
  // a new pending conflict (`pendingSnapshot !== undefined` transition);
  // resolving the conflict (banner unmounts) does not re-announce.
  useEffect(() => {
    if (pendingSnapshot !== undefined && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(
        'Another client updated quiet hours. Keep your edits, or discard and load the latest values.',
      );
    }
  }, [pendingSnapshot]);

  // Re-sync draft when the snapshot changes (remote save, broadcast).
  //
  // #4570: skip the apply when the editor is dirty AND the incoming
  // snapshot diverges from the local draft. Park the snapshot so the user
  // can resolve it via the conflict banner instead of losing their typing.
  useEffect(() => {
    const isDirty = dirtyRef.current;
    const matchesDraft = win
      ? (win.start === start && win.end === end && win.timezone === timezone && enabled)
      : !enabled;
    if (isDirty && !matchesDraft) {
      setPendingSnapshot(win);
      return;
    }
    setEnabled(win != null);
    if (win) {
      setStart(win.start);
      setEnd(win.end);
      setTimezone(win.timezone);
    }
    setPendingSnapshot(undefined);
    setDirty(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win]);

  const handleToggleEnable = useCallback((next: boolean) => {
    setEnabled(next);
    setDirty(false);
    setPendingSnapshot(undefined);
    if (!next) {
      onWindowChange(null);
    } else if (win == null) {
      onWindowChange({ start, end, timezone });
    }
  }, [win, start, end, timezone, onWindowChange]);

  const handleSaveWindow = useCallback(() => {
    if (!isValidHHMM(start) || !isValidHHMM(end)) {
      Alert.alert('Invalid time', 'Use HH:MM (24-hour). Example: 22:00');
      return;
    }
    setDirty(false);
    setPendingSnapshot(undefined);
    onWindowChange({ start, end, timezone });
  }, [start, end, timezone, onWindowChange]);

  // #4570: keep the local draft, dismiss the parked snapshot.
  const handleAcceptDraft = useCallback(() => {
    setPendingSnapshot(undefined);
  }, []);

  // #4570: take the remote snapshot, overwrite the draft, clear dirty.
  const handleDiscardDraft = useCallback(() => {
    const snap = pendingSnapshot;
    if (snap === undefined) return;
    setEnabled(snap != null);
    if (snap) {
      setStart(snap.start);
      setEnd(snap.end);
      setTimezone(snap.timezone);
    }
    setDirty(false);
    setPendingSnapshot(undefined);
  }, [pendingSnapshot]);

  // #4570: dirty-tracking wrappers around field setters so every edit path
  // flips the flag — used by the TextInputs and the timezone picker.
  const setStartDirty = useCallback((next: string) => { setStart(next); setDirty(true); }, []);
  const setEndDirty = useCallback((next: string) => { setEnd(next); setDirty(true); }, []);
  const setTimezoneDirty = useCallback((next: string) => { setTimezone(next); setDirty(true); }, []);

  const handleToggleBypass = useCallback((cat: string, next: boolean) => {
    const set = new Set(bypassCategories);
    if (next) set.add(cat); else set.delete(cat);
    onBypassChange([...set]);
  }, [bypassCategories, onBypassChange]);

  const bypassCandidates = useMemo(() => {
    const known = NOTIFICATION_CATEGORY_ORDER.filter((k) => k in categories || bypassCategories.includes(k));
    const extras = bypassCategories.filter((k) => !NOTIFICATION_CATEGORY_ORDER.includes(k) && !(k in categories));
    return [...known, ...extras];
  }, [categories, bypassCategories]);

  // Save button visibility: surface whenever the draft diverges from the
  // last known snapshot (existing behaviour) OR whenever dirty is set.
  const saveVisible = enabled && (dirty || start !== (win?.start ?? '') || end !== (win?.end ?? '') || timezone !== (win?.timezone ?? ''));

  return (
    <View testID="quiet-hours-editor">
      <View style={styles.row}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={styles.rowLabel}>Enable quiet hours</Text>
          <Text style={[styles.rowHint, { marginTop: 2 }]}>
            Mute pushes during a fixed window. Operator-blocking categories
            still fire by default — uncheck them below to silence too.
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={handleToggleEnable}
          trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
          testID="quiet-hours-enabled-toggle"
        />
      </View>
      {enabled && (
        <>
          {pendingSnapshot !== undefined && (
            <>
              <View style={styles.separator} />
              {/* #4581: accessibilityLiveRegion="polite" lets TalkBack /
                  VoiceOver announce the divergence the moment the banner
                  mounts — a screen-reader user editing the field would
                  otherwise miss the conflict entirely. Matches the
                  dashboard's role="alert" semantic without using `assertive`,
                  which would interrupt mid-typing speech. The two action
                  TouchableOpacity children get accessibilityRole="button"
                  + accessibilityLabel below for the same reason. */}
              <View
                style={styles.row}
                testID="quiet-hours-conflict-banner"
                accessibilityLiveRegion="polite"
                accessible={true}
              >
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={styles.rowLabel}>Another client updated quiet hours</Text>
                  <Text style={[styles.rowHint, { marginTop: 2 }]}>
                    Keep your unsaved edits, or discard them and load the
                    latest values?
                  </Text>
                </View>
              </View>
              <View style={styles.separator} />
              <TouchableOpacity
                style={styles.row}
                onPress={handleAcceptDraft}
                testID="quiet-hours-conflict-accept"
                accessibilityRole="button"
                accessibilityLabel="Keep my edits"
              >
                <Text style={styles.actionText}>Keep my edits</Text>
              </TouchableOpacity>
              <View style={styles.separator} />
              <TouchableOpacity
                style={styles.row}
                onPress={handleDiscardDraft}
                testID="quiet-hours-conflict-discard"
                accessibilityRole="button"
                accessibilityLabel="Discard and load latest"
              >
                <Text style={styles.actionText}>Discard and load latest</Text>
              </TouchableOpacity>
            </>
          )}
          <View style={styles.separator} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>From</Text>
            <TextInput
              value={start}
              onChangeText={setStartDirty}
              placeholder="22:00"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.timeInput}
              testID="quiet-hours-start-input"
            />
          </View>
          <View style={styles.separator} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>To</Text>
            <TextInput
              value={end}
              onChangeText={setEndDirty}
              placeholder="07:00"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.timeInput}
              testID="quiet-hours-end-input"
            />
          </View>
          <View style={styles.separator} />
          <TouchableOpacity
            style={styles.row}
            onPress={() => setShowTzPicker(true)}
            testID="quiet-hours-timezone-picker"
          >
            <Text style={styles.rowLabel}>Timezone</Text>
            <Text style={styles.rowValue}>{timezone}</Text>
          </TouchableOpacity>
          {saveVisible && (
            <>
              <View style={styles.separator} />
              <TouchableOpacity
                style={styles.row}
                onPress={handleSaveWindow}
                testID="quiet-hours-save-button"
              >
                <Text style={styles.actionText}>Save Quiet Hours</Text>
              </TouchableOpacity>
            </>
          )}
          <View style={styles.separator} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Bypass during quiet hours</Text>
          </View>
          {bypassCandidates.map((cat, idx) => {
            const meta = NOTIFICATION_CATEGORY_LABELS[cat];
            const label = meta?.label ?? cat;
            const checked = bypassCategories.includes(cat);
            return (
              <React.Fragment key={cat}>
                {idx === 0 ? null : <View style={styles.separator} />}
                <View style={styles.row}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.rowLabel}>{label}</Text>
                  </View>
                  <Switch
                    value={checked}
                    onValueChange={(value) => handleToggleBypass(cat, value)}
                    trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
                    testID={`quiet-hours-bypass-toggle-${cat}`}
                  />
                </View>
              </React.Fragment>
            );
          })}
        </>
      )}
      <Modal
        visible={showTzPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowTzPicker(false)}
      >
        <Pressable style={styles.sheetOverlay} onPress={() => setShowTzPicker(false)}>
          <Pressable
            style={[styles.sheetContent, { paddingBottom: 16 }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.sheetTitle}>Timezone</Text>
            <ScrollView style={styles.sheetList} bounces={false}>
              {tzOptions.map((tz) => (
                <TouchableOpacity
                  key={tz}
                  style={[styles.sheetOption, tz === timezone && styles.sheetOptionActive]}
                  onPress={() => { setTimezoneDirty(tz); setShowTzPicker(false); }}
                >
                  <Text style={[styles.sheetOptionText, tz === timezone && styles.sheetOptionTextActive]}>
                    {tz === browserTz ? `${tz} (this device)` : tz}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={[styles.sheetOption, styles.sheetCancel]}
              onPress={() => setShowTzPicker(false)}
            >
              <Text style={[styles.sheetOptionText, styles.sheetCancelText]}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/**
 * #4564: token label truncation. Expo push tokens look like
 * `ExponentPushToken[~40-base64-chars]` — too wide for a list row. Trim
 * to a stable first-N prefix plus an ellipsis so the operator can match
 * the row to a clear action without exposing the full token.
 */
function truncateDeviceLabel(key: string): string {
  const MAX = 24;
  if (key.length <= MAX) return key;
  return `${key.slice(0, MAX)}…`;
}

/**
 * #4564: list of per-device override entries with a "Clear" button per
 * row. The map can accumulate orphans when Expo refreshes the push token
 * or the app is reinstalled — without this list the only way to drain
 * them is hand-editing `~/.chroxy/notification-prefs.json`. The list
 * always renders (even when empty) so users find the affordance.
 */
function KnownDevicesList(props: {
  devices: Record<string, {
    categories?: Record<string, boolean>;
    quietHours?: { start: string; end: string; timezone: string } | null;
    bypassCategories?: string[];
    // #4587: optional last-seen + platform metadata stamped by the server.
    // Pre-#4587 servers omit both fields, in which case the row renders
    // exactly as before (truncated token + optional "this device" tag).
    lastSeenAt?: number;
    platform?: string;
  }>;
  currentDeviceKey: string | null;
  onClear: (deviceKey: string) => void;
}) {
  const { devices, currentDeviceKey, onClear } = props;
  // Stable order: current device first, then lexicographic.
  const keys = Object.keys(devices);
  const sorted = keys.slice().sort((a, b) => {
    if (a === currentDeviceKey) return -1;
    if (b === currentDeviceKey) return 1;
    return a.localeCompare(b);
  });

  if (sorted.length === 0) {
    return (
      <View style={styles.row} testID="notification-prefs-devices-empty">
        <Text style={styles.rowHint}>
          No per-device overrides yet. Mute a category on this device above to
          create one.
        </Text>
      </View>
    );
  }

  return (
    <View testID="notification-prefs-devices-list">
      {sorted.map((key, idx) => {
        const isCurrent = key === currentDeviceKey;
        const entry = devices[key];
        return (
          <React.Fragment key={key}>
            {idx > 0 && <View style={styles.separator} />}
            <View
              style={styles.row}
              testID={`notification-prefs-device-entry-${key}`}
            >
              <View style={styles.deviceLabelGroup}>
                <Text
                  style={styles.deviceLabelText}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {truncateDeviceLabel(key)}
                </Text>
                {isCurrent && (
                  <Text style={styles.deviceSelfTag}> (this device)</Text>
                )}
                {/* #4587: optional platform + last-seen metadata. Both
                    hidden when absent (pre-#4587 server snapshot) so the
                    row degrades to the original token-only render. */}
                {entry.platform ? (
                  <Text
                    style={styles.deviceMetaText}
                    testID={`notification-prefs-device-platform-${key}`}
                  >
                    {' · '}{formatPlatform(entry.platform)}
                  </Text>
                ) : null}
                {entry.lastSeenAt ? (
                  <Text
                    style={styles.deviceMetaText}
                    testID={`notification-prefs-device-last-seen-${key}`}
                  >
                    {' · Last seen '}{formatRelativeTime(entry.lastSeenAt)}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                onPress={() => onClear(key)}
                testID={`notification-prefs-device-clear-${key}`}
                style={styles.deviceClearButton}
              >
                <Text style={styles.deviceClearText}>Clear</Text>
              </TouchableOpacity>
            </View>
          </React.Fragment>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  sectionHeader: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 6,
    marginHorizontal: 16,
  },
  section: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 10,
    marginHorizontal: 16,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  // #4543: subordinate per-device row sits flush under the parent category
  // row with a slight indent so the visual hierarchy makes it clear that
  // "Mute on this device" is layered on top of the global toggle, not a
  // peer of it.
  deviceOverrideRow: {
    paddingLeft: 32,
    paddingTop: 4,
    paddingBottom: 8,
    minHeight: 36,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.backgroundCard,
    marginLeft: 16,
  },
  rowLabel: {
    color: COLORS.textPrimary,
    fontSize: 15,
  },
  rowValue: {
    color: COLORS.textMuted,
    fontSize: 15,
  },
  rowValueSmall: {
    fontSize: 13,
    maxWidth: 200,
  },
  // #4544: HH:MM picker field — small fixed width so the keyboard slots
  // straight into the row layout without pushing the label.
  timeInput: {
    color: COLORS.textPrimary,
    fontSize: 15,
    minWidth: 64,
    paddingVertical: 6,
    paddingHorizontal: 8,
    textAlign: 'right',
  },
  rowHint: {
    color: COLORS.textMuted,
    fontSize: 13,
    flex: 1,
  },
  destructiveText: {
    color: COLORS.accentRed,
    fontSize: 15,
  },
  // #4559: inline banner shown above the NOTIFICATION CATEGORIES section
  // when a notification-prefs Switch tap fires while the WS is closed.
  // Matches the section header indent (marginHorizontal: 16) so the
  // banner aligns with the section it describes; tinted with the
  // destructive red used by Clear actions so the failure tone reads
  // immediately.
  wsClosedBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: COLORS.backgroundCard,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentRed,
  },
  wsClosedBannerText: {
    color: COLORS.accentRed,
    fontSize: 13,
  },
  actionText: {
    color: COLORS.accentBlue,
    fontSize: 15,
  },
  // #4564: known-devices list styles. The label group flexes so a long
  // truncated token still leaves the Clear button room; the self-tag
  // borrows the accent blue used elsewhere for "this device" markers
  // (LAN scan, etc.) so cross-screen styling stays consistent.
  deviceLabelGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    marginRight: 12,
  },
  deviceLabelText: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontFamily: 'Courier',
    flexShrink: 1,
  },
  deviceSelfTag: {
    color: COLORS.accentBlue,
    fontSize: 12,
  },
  // #4587: subdued meta text for the platform + last-seen badges. Borrows
  // the same `textMuted` accent already used for hints and section
  // headers so the badges read as secondary content next to the token.
  deviceMetaText: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  deviceClearButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: COLORS.backgroundCard,
  },
  deviceClearText: {
    color: COLORS.accentRed,
    fontSize: 13,
    fontWeight: '600',
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  updateBadge: {
    backgroundColor: COLORS.accentOrangeSubtle,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  updateBadgeText: {
    color: COLORS.accentOrange,
    fontSize: 11,
    fontWeight: '600',
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheetContent: {
    backgroundColor: COLORS.backgroundSecondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
    maxHeight: '60%',
  },
  sheetTitle: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 12,
  },
  sheetList: {
    flexShrink: 1,
  },
  sheetOption: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    minHeight: 48,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sheetOptionActive: {
    backgroundColor: COLORS.accentBlueLight,
  },
  sheetOptionText: {
    color: COLORS.textPrimary,
    fontSize: 16,
  },
  sheetOptionTextActive: {
    color: COLORS.accentBlue,
    fontWeight: '600',
  },
  sheetOptionTag: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  sheetCancel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderPrimary,
    marginTop: 4,
    justifyContent: 'center',
  },
  sheetCancelText: {
    color: COLORS.accentRed,
    textAlign: 'center',
  },
  rulesContainer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  ruleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  ruleChipAllow: {
    backgroundColor: COLORS.accentGreenLight,
    borderColor: COLORS.accentGreenBorder,
  },
  ruleChipDeny: {
    backgroundColor: COLORS.accentRedSubtle,
    borderColor: COLORS.accentRedBorder,
  },
  ruleChipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  ruleChipTextAllow: {
    color: COLORS.accentGreen,
  },
  ruleChipTextDeny: {
    color: COLORS.accentRed,
  },
  ruleChipRemove: {
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 2,
  },
});
