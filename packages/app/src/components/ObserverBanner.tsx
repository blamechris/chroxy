/**
 * ObserverBanner — surfaces this device's shared-session role (#5589 / #5281).
 *
 * The chroxy daemon fans a single session out to every connected client and
 * (since #5589) tracks an explicit *primary* (driver). When ANOTHER device is
 * the primary, this device is an observer: it sees the same output but its
 * input is rejected with `input_conflict` while the agent is mid-request. This
 * banner makes that state legible (an unobtrusive strip, not a disabled input —
 * the server still lets an observer adopt an *idle* session per #5589), names
 * the driving device when known, and offers an explicit "Take over" affordance
 * that sends `claim_primary { force: true }`.
 *
 * Renders nothing unless the active session's role is `'observer'` — primary
 * and unclaimed sessions show no banner (the operator is/can be the driver).
 *
 * Scope: this is the role-AWARENESS surface (#5281 milestone ①.3 slice). The
 * full shared-session-join UX and the desktop-as-LAN-client connect flow are
 * out of scope here.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../constants/colors';
import { Icon } from './Icon';

export interface ObserverBannerProps {
  /** True only when the active session's role is `'observer'`. */
  visible: boolean;
  /** The active session id (claim target). */
  sessionId: string | null;
  /**
   * Human-friendly name of the device currently driving, or null when unknown
   * (the roster hasn't resolved the primary client id to a name yet).
   */
  driverName: string | null;
  /** Send `claim_primary { force: true }` for an explicit take-over. */
  onTakeOver: (sessionId: string) => void;
}

export function ObserverBanner({
  visible,
  sessionId,
  driverName,
  onTakeOver,
}: ObserverBannerProps) {
  if (!visible || !sessionId) return null;

  const label = driverName
    ? `Observing — ${driverName} is driving`
    : 'Observing — another device is driving';

  return (
    <View
      style={styles.container}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${label}. Your input may be rejected while it is busy. Take over to drive.`}
      testID="observer-banner"
    >
      <View style={styles.content}>
        <Icon name="eye" size={16} color={COLORS.accentBlue} />
        <Text style={styles.text} numberOfLines={2} testID="observer-banner-text">
          {label}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.takeOverButton}
        onPress={() => onTakeOver(sessionId)}
        accessibilityRole="button"
        accessibilityLabel="Take over as primary"
        testID="observer-banner-takeover-button"
      >
        <Text style={styles.takeOverText}>Take over</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.accentBlueLight,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.accentBlueBorder,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  text: {
    color: COLORS.textPrimary,
    fontSize: 13,
    flex: 1,
  },
  takeOverButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: COLORS.accentBlue,
    marginLeft: 8,
  },
  takeOverText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
});
