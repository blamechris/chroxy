/**
 * CheckInChip — soft inactivity check-in prompt (#3899).
 *
 * Renders when the server has fired an `inactivity_warning` for the
 * active session and not yet been dismissed by activity or by a fresh
 * user input. Shows elapsed silence and a one-tap button that sends
 * the server-supplied prefab text through the normal user-input path.
 *
 * Mobile companion to packages/dashboard/src/components/CheckInChip.tsx
 * — same store selector + clear-on-activity contract, React Native
 * Pressable + StyleSheet styling.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, AccessibilityInfo } from 'react-native';
import { useConnectionStore } from '../store/connection';
import { useConnectionLifecycleStore } from '../store/connection-lifecycle';
import { COLORS } from '../constants/colors';

function formatElapsed(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS === 0 ? `${m}m` : `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function CheckInChip() {
  // Each `inactivity_warning` from the server replaces the slot with a
  // fresh object — referential equality (Zustand's default) is the
  // right selector contract here.
  const warning = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessionStates[id]?.inactivityWarning ?? null : null;
  });
  const sendInput = useConnectionStore((s) => s.sendInput);
  const isConnected = useConnectionLifecycleStore(
    (s) => s.connectionPhase === 'connected',
  );

  // Re-render once per second so the elapsed label stays current while
  // the warning is outstanding. Cleared by the store on activity or on
  // sendInput, so this only ticks during genuine silence.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!warning) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [warning]);

  // Fire a one-shot accessibility announcement the first time a warning
  // appears for this session — equivalent to the dashboard's hidden
  // `role="status" aria-live="polite"` span. The ticking elapsed label
  // is NOT announced repeatedly (would spam screen readers); only the
  // initial state change is.
  useEffect(() => {
    if (!warning) return;
    AccessibilityInfo.announceForAccessibility?.(
      `Agent has gone quiet. ${warning.prefab}`,
    );
  }, [warning]);

  if (!warning) return null;

  // Total silence shown = server-reported `idleMs` (the silence the
  // server already accumulated before firing) + however long we've
  // held the warning client-side. Monotonically increasing label.
  const heldFor = Math.max(0, Date.now() - warning.receivedAt);
  const totalIdle = warning.idleMs + heldFor;

  const handleCheckIn = () => {
    if (!isConnected) return;
    sendInput(warning.prefab);
  };

  return (
    <View style={styles.container} testID="check-in-chip">
      <View style={styles.dot} />
      <Text style={styles.label} accessibilityElementsHidden importantForAccessibility="no">
        Agent quiet for {formatElapsed(totalIdle)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Send check-in: ${warning.prefab}`}
        accessibilityState={{ disabled: !isConnected }}
        disabled={!isConnected}
        onPress={handleCheckIn}
        style={({ pressed }) => [
          styles.button,
          !isConnected && styles.buttonDisabled,
          pressed && isConnected && styles.buttonPressed,
        ]}
      >
        <Text style={styles.buttonLabel}>{warning.prefab}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginHorizontal: 12,
    marginVertical: 4,
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.accentYellow500,
    backgroundColor: 'rgba(217, 165, 12, 0.12)',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentYellow500,
  },
  label: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  button: {
    backgroundColor: COLORS.accentYellow500,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    color: COLORS.backgroundPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
});
