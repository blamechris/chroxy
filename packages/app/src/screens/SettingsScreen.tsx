import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
 * #4544: curated timezone short-list. Same set as the dashboard's
 * `getQuietHoursTimezoneOptions` so mobile + desktop pickers agree on
 * the most-likely picks. The device's resolved zone is prepended so the
 * user can pick "this device" without scrolling.
 */
const QUIET_HOURS_TIMEZONE_CHOICES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
  'Pacific/Auckland',
];

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

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [speechLang, setSpeechLangState] = useState<string>('en-US');
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [biometricAvail, setBiometricAvail] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);

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
  // #4544: quiet-hours editor actions. The window is global; per-device
  // overrides are owned by a future iteration. `bypassCategories` is the
  // list of categories that fire even during quiet hours.
  const setNotificationPrefsQuietHours = useConnectionStore((s) => s.setNotificationPrefsQuietHours);
  const setNotificationPrefsBypassCategories = useConnectionStore((s) => s.setNotificationPrefsBypassCategories);

  useEffect(() => {
    refreshNotificationPrefs();
  }, [refreshNotificationPrefs]);

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
      <View style={styles.section} testID="notification-prefs-section">
        {notificationPrefs == null ? (
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
                    onValueChange={(value) => setNotificationPrefsCategory(cat, value)}
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
                      onValueChange={(value) => setNotificationPrefsDevice(pushToken, cat, !value)}
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
        {notificationPrefs == null ? (
          <View style={styles.row}>
            <Text style={styles.rowHint}>Loading preferences&hellip;</Text>
          </View>
        ) : (
          <QuietHoursEditor
            window={notificationPrefs.quietHours}
            categories={notificationPrefs.categories}
            bypassCategories={notificationPrefs.bypassCategories ?? DEFAULT_BYPASS_CATEGORIES}
            onWindowChange={setNotificationPrefsQuietHours}
            onBypassChange={setNotificationPrefsBypassCategories}
          />
        )}
      </View>

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
  const tzOptions = useMemo(() => {
    const list = [...QUIET_HOURS_TIMEZONE_CHOICES];
    if (browserTz && !list.includes(browserTz)) list.unshift(browserTz);
    return list;
  }, [browserTz]);

  const [enabled, setEnabled] = useState<boolean>(win != null);
  const [start, setStart] = useState<string>(win?.start ?? '22:00');
  const [end, setEnd] = useState<string>(win?.end ?? '07:00');
  const [timezone, setTimezone] = useState<string>(win?.timezone ?? browserTz);
  const [showTzPicker, setShowTzPicker] = useState(false);

  // Re-sync draft when the snapshot changes (remote save, broadcast).
  useEffect(() => {
    setEnabled(win != null);
    if (win) {
      setStart(win.start);
      setEnd(win.end);
      setTimezone(win.timezone);
    }
  }, [win]);

  const handleToggleEnable = useCallback((next: boolean) => {
    setEnabled(next);
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
    onWindowChange({ start, end, timezone });
  }, [start, end, timezone, onWindowChange]);

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

  const dirty = enabled && (start !== (win?.start ?? '') || end !== (win?.end ?? '') || timezone !== (win?.timezone ?? ''));

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
          <View style={styles.separator} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>From</Text>
            <TextInput
              value={start}
              onChangeText={setStart}
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
              onChangeText={setEnd}
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
          {dirty && (
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
                  onPress={() => { setTimezone(tz); setShowTzPicker(false); }}
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
  actionText: {
    color: COLORS.accentBlue,
    fontSize: 15,
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
