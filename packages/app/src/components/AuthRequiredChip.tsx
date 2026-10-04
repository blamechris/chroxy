/**
 * AuthRequiredChip — #8223 (mobile-app companion to the dashboard chip).
 *
 * Replaces the generic red error bubble when the server emits
 * `error{code: 'AUTH_REQUIRED'}`: the claude CLI on the host is logged out or
 * its login expired. Retrying cannot help — someone has to sign in on the host —
 * so this chip has no Retry button. It shows the registry headline, the server's
 * message, and the one command that fixes it as selectable text, so it can be
 * long-pressed and copied into a host terminal. There is no button, so the 44pt
 * tap-target rule has nothing to apply to.
 *
 * Headline and live-region politeness come from store-core's
 * `getErrorPresentation('AUTH_REQUIRED')` (role `alert`) so the two surfaces
 * cannot drift. Palette follows ResumeUnknownChip / StreamStallChip.
 */
import { Platform, StyleSheet, Text, View } from 'react-native';
import { getErrorPresentation } from '@chroxy/store-core';
import { COLORS } from '../constants/colors';

/** The command that fixes it — claude 2.1.x's `auth login` (plain `claude login` is stale). */
export const AUTH_LOGIN_COMMAND = 'claude auth login';

export interface AuthRequiredChipProps {
  /**
   * The server's message. Shown as the body and preserved verbatim in
   * `accessibilityHint` for assistive-tech triage.
   */
  errorText: string;
}

export function AuthRequiredChip({ errorText }: AuthRequiredChipProps) {
  const { headline, role } = getErrorPresentation('AUTH_REQUIRED');
  // #6429: politeness derived from the registry role (AUTH_REQUIRED is `alert`).
  const liveRegion = role === 'alert' ? 'assertive' : 'polite';
  const body = typeof errorText === 'string' ? errorText.trim() : '';

  return (
    <View
      testID="auth-required-chip"
      accessibilityRole="alert"
      accessibilityLiveRegion={liveRegion}
      accessibilityLabel={headline}
      accessibilityHint={errorText}
      style={styles.container}
    >
      <View style={styles.headlineRow}>
        <View style={styles.dot} />
        <Text testID="auth-required-chip-headline" style={styles.headline}>{headline}</Text>
      </View>
      {body.length > 0 && (
        <Text testID="auth-required-chip-body" style={styles.body} selectable>
          {body}
        </Text>
      )}
      <Text testID="auth-required-chip-command" style={styles.command} selectable>
        {AUTH_LOGIN_COMMAND}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginVertical: 4,
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.accentYellow500,
    backgroundColor: 'rgba(217, 165, 12, 0.12)',
  },
  headlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentYellow500,
  },
  headline: {
    fontSize: 13,
    color: COLORS.textPrimary,
    fontWeight: '600',
  },
  body: {
    fontSize: 12,
    lineHeight: 16,
    color: COLORS.textSecondary,
  },
  command: {
    alignSelf: 'flex-start',
    fontSize: 12,
    // Same Menlo/monospace pair as ResumeUnknownChip / ToolBubble — iOS has no
    // font literally named "monospace".
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: COLORS.textPrimary,
  },
});
