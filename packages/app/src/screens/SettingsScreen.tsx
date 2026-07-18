import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Switch,
  TouchableOpacity,
  Alert,
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
import {
  isBiometricAvailable,
  getBiometricEnabled,
  setBiometricEnabled,
} from '../hooks/useBiometricLock';
import { styles } from '../components/settings/styles';
import {
  NOTIFICATION_CATEGORY_ORDER,
  WS_CLOSED_MESSAGE,
} from '../components/settings/constants';
import { NotificationPrefsSection } from '../components/settings/NotificationPrefsSection';
import { VoiceInputSection } from '../components/settings/VoiceInputSection';
import { SecuritySection } from '../components/settings/SecuritySection';

const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';

// Stable reference for empty session rules — prevents Zustand selector from
// returning a new [] on every render (which causes infinite re-render loops).
const EMPTY_RULES: PermissionRule[] = [];

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [biometricAvail, setBiometricAvail] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);
  // #4559: surfaces "server disconnected" when a notification-prefs Switch
  // tap fires while the WS is closed. Cleared on a subsequent successful
  // write (post-reconnect) so a stale banner can't persist after recovery.
  const [notifWsClosedError, setNotifWsClosedError] = useState<string | null>(null);

  useEffect(() => {
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

  const {
    inputSettings,
    updateInputSettings,
    forgetSession,
    disconnect,
    clearSavedConnection,
    requestFullHistory,
    setPermissionRules,
    setProjectPermissionRules,
  } = useConnectionStore();

  const activeSessionId = useConnectionStore((s) => s.activeSessionId);
  const sessionRules = useConnectionStore((s) => {
    const id = s.activeSessionId;
    if (!id || !s.sessionStates[id]) return EMPTY_RULES;
    return s.sessionStates[id].sessionRules ?? EMPTY_RULES;
  });
  // #6771 — durable per-project ("always allow") rules for the active session.
  const persistentRules = useConnectionStore((s) => {
    const id = s.activeSessionId;
    if (!id || !s.sessionStates[id]) return EMPTY_RULES;
    return s.sessionStates[id].persistentRules ?? EMPTY_RULES;
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

      {/* PROJECT RULES (#6771) — durable "always allow" grants that survive a
          daemon restart. Removing one sends the reduced set as projectRules. */}
      {activeSessionId != null && persistentRules.length > 0 && (
        <>
          <Text style={styles.sectionHeader} testID="project-rules-header">PROJECT RULES (ALWAYS ALLOW)</Text>
          <View style={styles.section}>
            <View style={styles.rulesContainer}>
              {persistentRules.map((rule: PermissionRule, index: number) => (
                <TouchableOpacity
                  key={`persist-${rule.tool}-${rule.decision}-${index}`}
                  testID={`project-rule-${rule.tool}`}
                  style={[
                    styles.ruleChip,
                    rule.decision === 'allow' ? styles.ruleChipAllow : styles.ruleChipDeny,
                  ]}
                  onPress={() => {
                    const updated = persistentRules.filter((_: PermissionRule, i: number) => i !== index);
                    setProjectPermissionRules(updated);
                  }}
                >
                  <Text
                    style={[
                      styles.ruleChipText,
                      rule.decision === 'allow' ? styles.ruleChipTextAllow : styles.ruleChipTextDeny,
                    ]}
                  >
                    {rule.tool} — {rule.decision === 'allow' ? 'always allow' : 'always deny'}
                  </Text>
                  <Text
                    style={[
                      styles.ruleChipRemove,
                      rule.decision === 'allow' ? styles.ruleChipTextAllow : styles.ruleChipTextDeny,
                    ]}
                  >
                    {' ×'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.separator} />
            <TouchableOpacity
              style={styles.row}
              onPress={() => setProjectPermissionRules([])}
            >
              <Text style={styles.destructiveText}>Clear All Project Rules</Text>
            </TouchableOpacity>
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

      <SecuritySection
        biometricAvail={biometricAvail}
        biometricOn={biometricOn}
        onBiometricChange={setBiometricOn}
      />

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
        <View style={styles.separator} />
        <TouchableOpacity
          style={styles.row}
          onPress={() => navigation.navigate('MissionControl')}
          accessibilityRole="button"
          accessibilityLabel="View mission control"
          testID="settings-mission-control-row"
        >
          <Text style={styles.rowLabel}>Mission Control</Text>
          <Text style={styles.rowValue}>View all</Text>
        </TouchableOpacity>
      </View>

      <NotificationPrefsSection
        notifWsClosedError={notifWsClosedError}
        notificationPrefsSupported={notificationPrefsSupported}
        notificationPrefs={notificationPrefs}
        pushToken={pushToken}
        orderedNotificationCategories={orderedNotificationCategories}
        handleSetCategory={handleSetCategory}
        handleSetDevice={handleSetDevice}
        handleSetQuietHours={handleSetQuietHours}
        handleSetBypassCategories={handleSetBypassCategories}
        handleClearDevice={handleClearDevice}
      />

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

      <VoiceInputSection
        insets={insets}
        inputSettings={inputSettings}
        updateInputSettings={updateInputSettings}
      />

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
    </ScrollView>
  );
}
