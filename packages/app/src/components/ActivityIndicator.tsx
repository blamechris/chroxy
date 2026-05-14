/**
 * ActivityIndicator — "Working… last activity Ns ago" UI (#3758).
 *
 * Renders only while the active session is busy. Shows the elapsed time
 * since the last activity-bearing server event (stream_start, stream_delta,
 * stream_end, tool_start, tool_result, message, result, user_question,
 * permission_request — see ACTIVITY_EVENT_TYPES in @chroxy/store-core).
 *
 * Mobile companion to packages/dashboard/src/components/ActivityIndicator.tsx
 * — same selector + tick-once-per-second pattern, React Native styling.
 *
 * Color escalation:
 *   0-30s         green   (active)
 *   30-60s        yellow  (quiet)
 *   60s-threshold orange  (slow)
 *   approaching   red     (last 60s before timeout)
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useConnectionStore } from '../store/connection';
import { useConnectionLifecycleStore } from '../store/connection-lifecycle';
import { COLORS } from '../constants/colors';

/** Fallback default matching the server's BaseSession.DEFAULT_RESULT_TIMEOUT_MS (#3754 / #3884) */
const FALLBACK_TIMEOUT_MS = 30 * 60 * 1000;

function formatElapsed(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS === 0 ? `${m}m ago` : `${m}m ${remS}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function statusColor(elapsedMs: number, timeoutMs: number): string {
  if (elapsedMs >= timeoutMs - 60_000) return COLORS.accentRed500;
  if (elapsedMs >= 60_000) return COLORS.accentOrange500;
  if (elapsedMs >= 30_000) return COLORS.accentYellow500;
  return COLORS.accentGreen;
}

export function ActivityIndicator() {
  const isIdle = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessionStates[id]?.isIdle ?? true : true;
  });
  const lastActivityAt = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessionStates[id]?.lastClientActivityAt ?? null : null;
  });
  const referenceTimeoutMs = useConnectionLifecycleStore(
    (s) => s.serverResultTimeoutMs ?? FALLBACK_TIMEOUT_MS,
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isIdle) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isIdle]);

  if (isIdle) return null;

  if (lastActivityAt == null) {
    return (
      <View style={styles.container}>
        <View style={[styles.dot, { backgroundColor: COLORS.accentGreen }]} />
        <Text style={[styles.label, { color: COLORS.accentGreen }]}>Working…</Text>
      </View>
    );
  }

  const elapsed = Math.max(0, now - lastActivityAt);
  const remaining = referenceTimeoutMs - elapsed;
  const approaching = remaining > 0 && remaining <= 60_000;
  const color = statusColor(elapsed, referenceTimeoutMs);

  return (
    <View style={styles.container}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]} accessibilityRole="text">
        Working… last activity {formatElapsed(elapsed)}
      </Text>
      {approaching && (
        <Text style={[styles.warning, { color }]}>
          · approaching timeout ({Math.ceil(remaining / 1000)}s left)
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  warning: {
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 4,
  },
});

