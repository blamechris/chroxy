/**
 * StdinDisabledBanner — surfaces the latched `stdinForwardingDisabled` flag
 * from `session_list` metadata (#3540 / #3564 / #3567 / #3595).
 *
 * Once a SidecarProcess emits `stdin_disabled` (#3402, #3501) the sidecar's
 * stdin pipe is permanently broken. The server latches the flag onto the
 * session, persists it across restarts, and surfaces it via `session_list`
 * so reconnecting clients can render this banner without waiting for a fresh
 * `error{code:'stdin_disabled'}` event (which only fires once on the original
 * process). Restarting the session is the only recovery path — tapping
 * "Restart" invokes the parent's `onRestart` handler which creates a fresh
 * replacement session (same cwd / name / provider / worktree) and then
 * destroys the broken one (create-first ordering avoids the server's
 * "Cannot destroy the last session" rejection when the wedged session is
 * the only one open). No confirm dialog — the destruction is implicit in
 * "restart".
 *
 * Mirrors `packages/dashboard/src/components/StdinDisabledBanner.tsx` for
 * the React Native mobile app.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../constants/colors';
import { Icon } from './Icon';

export interface StdinDisabledBannerProps {
  visible: boolean;
  sessionId: string | null;
  onRestart: (sessionId: string) => void;
}

export function StdinDisabledBanner({
  visible,
  sessionId,
  onRestart,
}: StdinDisabledBannerProps) {
  if (!visible || !sessionId) return null;

  return (
    // accessibilityRole="alert" so screen readers announce the disabled
    // state — pairs with the dashboard's role="status" + aria-live="polite"
    // semantics. RN's "alert" role maps to assertive-live on iOS/Android,
    // but the disabled state is a recovery hint, not an emergency. Use
    // accessibilityLiveRegion="polite" on Android to soften the urgency.
    <View
      style={styles.container}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel="Stdin forwarding lost — restart this session to continue"
      testID="stdin-disabled-banner"
    >
      <View style={styles.content}>
        <Icon name="alertCircle" size={16} color={COLORS.accentOrange} />
        <Text style={styles.text} numberOfLines={2}>
          Stdin forwarding lost — restart this session to continue.
        </Text>
      </View>
      <TouchableOpacity
        style={styles.restartButton}
        onPress={() => onRestart(sessionId)}
        accessibilityRole="button"
        accessibilityLabel="Restart session"
        testID="stdin-disabled-restart-button"
      >
        <Text style={styles.restartText}>Restart</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.accentOrangeLight,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.accentOrangeBorder,
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
  restartButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: COLORS.accentOrange,
    marginLeft: 8,
  },
  restartText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
});

