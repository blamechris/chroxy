/**
 * StreamStallChip — #4496
 *
 * Mobile companion to packages/dashboard/src/components/StreamStallChip
 * (#4476). Replaces the generic red error bubble when the server emits
 * `error{code: 'stream_stall'}` (server PR #4475). The chip signals
 * "recoverable, just retry" rather than "something is broken" via an
 * amber/yellow palette and offers a one-tap Retry button that re-sends
 * the most recent user input (caller is responsible for that lookup —
 * the chip itself doesn't know which message to resend).
 *
 * The raw server error text remains accessible on demand:
 *  - exposed to assistive tech via `accessibilityHint`
 *  - revealed inline by long-pressing the chip
 *
 * Uses `accentYellow500` from constants/colors to match the rest of the
 * chroxy amber-yellow warning surfaces (`CheckInChip`, the inactivity
 * warning chips, etc.).
 */
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getErrorPresentation } from '@chroxy/store-core';
import { COLORS } from '../constants/colors';

export interface StreamStallChipProps {
  /** Raw error text from the server (e.g. "Stream stalled — no response for 5 minutes"). */
  errorText: string;
  /**
   * Invoked when the user taps Retry. Caller is responsible for
   * resending the last user message. Setting this to `undefined` hides
   * the Retry button — used for historical entries replayed from
   * `session_messages` where resending an ancient user_input would be
   * misleading.
   */
  onRetry?: () => void;
  /**
   * #5793 — chip headline + accessibility label. Defaults to the
   * stream-stall copy; callers reuse this same amber "recoverable, retry"
   * chip for the AskUserQuestion teardown codes by passing the
   * question-delivery copy (the dashboard has a separate
   * AskUserQuestionStallChip; mobile reuses this one with a different
   * headline to avoid duplicating the whole amber-chip layout).
   */
  headline?: string;
}

export function StreamStallChip({
  errorText,
  onRetry,
  // #6392: the default stream-stall copy is single-sourced from the shared
  // error-presentation registry (callers override for the AskUserQuestion family).
  headline = getErrorPresentation('stream_stall').headline,
}: StreamStallChipProps) {
  const [detailVisible, setDetailVisible] = useState(false);

  // #6429: politeness is derived from the registry role for parity with the
  // other error chips. stream_stall is role 'status', so this chip always
  // resolves to 'polite'; the derivation just guards against a future role
  // change. accessibilityRole stays 'alert' (the RN convention for amber chips).
  const liveRegion = getErrorPresentation('stream_stall').role === 'alert' ? 'assertive' : 'polite';

  const handleRetry = useCallback(() => {
    onRetry?.();
  }, [onRetry]);

  const toggleDetail = useCallback(() => {
    setDetailVisible((v) => !v);
  }, []);

  return (
    <Pressable
      testID="stream-stall-chip"
      accessibilityRole="alert"
      accessibilityLiveRegion={liveRegion}
      accessibilityLabel={headline}
      accessibilityHint={errorText}
      // Long-press reveals the underlying server diagnostic text without
      // an always-on text wall on the chip — preserves the "raw error
      // accessible for diagnostics" acceptance criterion compactly.
      onLongPress={toggleDetail}
      style={styles.container}
    >
      <View style={styles.dot} />
      <Text style={styles.label}>{headline}</Text>
      {onRetry && (
        <Pressable
          testID="stream-stall-chip-retry"
          accessibilityRole="button"
          accessibilityLabel="Retry — resend last message"
          onPress={handleRetry}
          // Compact chip button: expand the actionable region via hitSlop
          // to meet the 44pt accessibility minimum without inflating the
          // visual chip. Mirrors CheckInChip's slop convention.
          hitSlop={{ top: 11, bottom: 11, left: 14, right: 14 }}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonLabel}>Retry</Text>
        </Pressable>
      )}
      {detailVisible && (
        <Text
          testID="stream-stall-chip-detail"
          style={styles.detail}
          accessibilityElementsHidden
          importantForAccessibility="no"
          selectable
        >
          {errorText}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginVertical: 4,
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.accentYellow500,
    // Subtle amber-yellow fill — matches the CheckInChip / warning chip
    // surface convention rather than the red error palette so users read
    // the bubble as "recoverable" rather than "broken".
    backgroundColor: 'rgba(217, 165, 12, 0.12)',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentYellow500,
  },
  label: {
    fontSize: 13,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  button: {
    backgroundColor: COLORS.accentYellow500,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    // Visible button area is intentionally compact — the 44pt
    // accessibility minimum is reached via hitSlop above.
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonLabel: {
    color: COLORS.backgroundPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  detail: {
    // Full-width row that wraps under the chip header when expanded.
    width: '100%',
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.accentYellow500,
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 16,
  },
});
