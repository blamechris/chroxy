import React from 'react';
import { View, Text, Switch } from 'react-native';
import { COLORS } from '../../constants/colors';
import { styles } from './styles';
import { QuietHoursEditor } from './QuietHoursEditor';
import { KnownDevicesList } from './KnownDevicesList';
import {
  NOTIFICATION_CATEGORY_LABELS,
  DEFAULT_BYPASS_CATEGORIES,
  NOTIFICATION_PREFS_UNSUPPORTED_MESSAGE,
} from './constants';

/**
 * NotificationPrefs snapshot shape — the subset of the WS `notification_prefs`
 * payload this section reads. Kept structural (matches what SettingsScreen
 * already selects off the store) so the extraction stays behaviour-preserving.
 */
type NotificationPrefs = {
  categories: Record<string, boolean>;
  bypassCategories?: string[];
  quietHours: { start: string; end: string; timezone: string } | null;
  devices: Record<string, {
    categories?: Record<string, boolean>;
    quietHours?: { start: string; end: string; timezone: string } | null;
    bypassCategories?: string[];
    lastSeenAt?: number;
    platform?: string;
  }>;
};

/**
 * NOTIFICATION CATEGORIES + QUIET HOURS + PER-DEVICE OVERRIDES — the
 * notification-preferences UI. Extracted from SettingsScreen (#5655).
 * Behaviour-preserving: the per-category toggles (#4542), per-device mute
 * overrides (#4543), the WS-closed inline alert (#4559), the capability gate
 * (#4560), quiet-hours editor (#4544), and known-devices list (#4564) are
 * moved verbatim.
 *
 * State lives in SettingsScreen and is passed down — this component reads the
 * notification-prefs snapshot + handlers off props and owns no store wiring
 * (mirroring how QuietHoursEditor / KnownDevicesList already took props).
 */
export function NotificationPrefsSection(props: {
  notifWsClosedError: string | null;
  notificationPrefsSupported: boolean;
  notificationPrefs: NotificationPrefs | null;
  pushToken: string | null;
  orderedNotificationCategories: string[];
  // #4559: the handler wrappers (not the raw store actions) so a write on a
  // closed socket flips the inline WS-closed banner. Named to match what
  // SettingsScreen passes down.
  handleSetCategory: (cat: string, value: boolean) => void;
  handleSetDevice: (deviceKey: string, cat: string, value: boolean) => void;
  handleSetQuietHours: (win: { start: string; end: string; timezone: string } | null) => void;
  handleSetBypassCategories: (cats: string[]) => void;
  handleClearDevice: (deviceKey: string) => void;
}) {
  const {
    notifWsClosedError,
    notificationPrefsSupported,
    notificationPrefs,
    pushToken,
    orderedNotificationCategories,
    handleSetCategory,
    handleSetDevice,
    handleSetQuietHours,
    handleSetBypassCategories,
    handleClearDevice,
  } = props;

  return (
    <>
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
    </>
  );
}
