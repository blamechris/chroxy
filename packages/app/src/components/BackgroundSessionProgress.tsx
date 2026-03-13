import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useConnectionStore } from '../store/connection';
import { COLORS } from '../constants/colors';
import type { ActivityState } from '../store/session-activity';

export function getActivityLabel(state: ActivityState, detail?: string): string | null {
  switch (state) {
    case 'thinking':
      return 'Thinking...';
    case 'busy':
      return detail || 'Working...';
    case 'waiting':
      return detail ? `Waiting: ${detail}` : 'Waiting for approval';
    case 'error':
      return 'Error';
    case 'idle':
      return null;
  }
}

export function getActivityColor(state: ActivityState): string {
  switch (state) {
    case 'thinking':
      return COLORS.accentBlue;
    case 'busy':
      return COLORS.accentOrange;
    case 'waiting':
      return COLORS.accentOrange;
    case 'error':
      return COLORS.accentRed;
    case 'idle':
      return COLORS.textMuted;
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(Date.now() - startedAt);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setElapsed(Date.now() - startedAt);
    intervalRef.current = setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startedAt]);

  return <Text style={styles.elapsed}>{formatElapsed(elapsed)}</Text>;
}

export function BackgroundSessionProgress() {
  const sessions = useConnectionStore((s) => s.sessions);
  const activeSessionId = useConnectionStore((s) => s.activeSessionId);
  const sessionStates = useConnectionStore((s) => s.sessionStates);
  const switchSession = useConnectionStore((s) => s.switchSession);

  const busySessions = sessions
    .filter((s) => s.sessionId !== activeSessionId)
    .map((s) => {
      const state = sessionStates[s.sessionId];
      if (!state) return null;
      const activity = state.activityState;
      if (!activity || activity.state === 'idle') return null;
      const label = getActivityLabel(activity.state, activity.detail);
      if (!label) return null;
      const color = getActivityColor(activity.state);
      return { sessionId: s.sessionId, name: s.name, label, color, startedAt: activity.startedAt };
    })
    .filter(Boolean) as { sessionId: string; name: string; label: string; color: string; startedAt: number }[];

  if (busySessions.length === 0) return null;

  return (
    <View style={styles.container}>
      {busySessions.map((s) => (
        <TouchableOpacity
          key={s.sessionId}
          style={styles.row}
          onPress={() => switchSession(s.sessionId)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`${s.name}: ${s.label}. Tap to switch.`}
        >
          <View style={[styles.dot, { backgroundColor: s.color }]} />
          <Text style={styles.name} numberOfLines={1}>{s.name}</Text>
          <Text style={[styles.status, { color: s.color }]} numberOfLines={1}>{s.label}</Text>
          <ElapsedTimer startedAt={s.startedAt} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.backgroundSecondary,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.backgroundTertiary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  name: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 120,
  },
  status: {
    fontSize: 12,
    flex: 1,
  },
  elapsed: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});
