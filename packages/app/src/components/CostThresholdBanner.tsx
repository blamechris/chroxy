/**
 * CostThresholdBanner — surfaces the active session's
 * `costThresholdWarning` (set by the server's `session_cost_threshold_crossed`
 * event, #4075).
 *
 * Renders a dismissible non-fatal banner with the running cost and the
 * configured threshold. The server fires the event ONCE per session
 * (latched in SessionManager._trackUsage), so a missed banner stays
 * missed — there's no store-and-replay. Dismissal sets `dismissedAt` on
 * the per-session warning record so the banner stays hidden for the
 * session's lifetime even if the field repopulates.
 *
 * Mirrors the dashboard cost-threshold toast (App.tsx, #4075) — same
 * format, same dismissal semantics. Subscription-billed sessions never
 * receive the event (cost stays at 0), so this component never renders
 * for them.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../constants/colors';
import { Icon } from './Icon';

export interface CostThresholdBannerProps {
  visible: boolean;
  costUsd: number;
  thresholdUsd: number;
  onDismiss: () => void;
}

export function CostThresholdBanner({
  visible,
  costUsd,
  thresholdUsd,
  onDismiss,
}: CostThresholdBannerProps) {
  if (!visible) return null;
  return (
    <View
      style={styles.container}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Session has used $${costUsd.toFixed(2)}, exceeding the threshold of $${thresholdUsd.toFixed(2)}`}
      testID="cost-threshold-banner"
    >
      <View style={styles.content}>
        <Icon name="alertCircle" size={16} color={COLORS.accentOrange} />
        <Text style={styles.text} numberOfLines={2}>
          Session has used ${costUsd.toFixed(2)}. (Threshold: ${thresholdUsd.toFixed(2)}).
        </Text>
      </View>
      <TouchableOpacity
        style={styles.dismissButton}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss cost warning"
        testID="cost-threshold-banner-dismiss"
      >
        <Text style={styles.dismissText}>Dismiss</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: COLORS.accentOrangeSubtle,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.accentOrange,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 8,
  },
  text: {
    color: COLORS.textPrimary,
    fontSize: 13,
    flex: 1,
  },
  dismissButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: COLORS.backgroundTertiary,
    marginLeft: 8,
  },
  dismissText: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
});
