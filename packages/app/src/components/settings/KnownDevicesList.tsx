import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { formatPlatform, formatRelativeTime } from '@chroxy/store-core';
import { styles } from './styles';

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
export function KnownDevicesList(props: {
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
