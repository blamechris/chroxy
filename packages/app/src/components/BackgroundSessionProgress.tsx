import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useConnectionStore } from '../store/connection';
import { COLORS } from '../constants/colors';

function getSessionStatus(state: { isIdle: boolean; streamingMessageId: string | null; isPlanPending: boolean }): string | null {
  if (state.isPlanPending) return 'Waiting for approval';
  if (state.streamingMessageId) return 'Writing...';
  if (!state.isIdle) return 'Thinking...';
  return null;
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
      const status = getSessionStatus(state);
      if (!status) return null;
      return { sessionId: s.sessionId, name: s.name, status };
    })
    .filter(Boolean) as { sessionId: string; name: string; status: string }[];

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
          accessibilityLabel={`${s.name}: ${s.status}. Tap to switch.`}
        >
          <View style={styles.dot} />
          <Text style={styles.name} numberOfLines={1}>{s.name}</Text>
          <Text style={styles.status} numberOfLines={1}>{s.status}</Text>
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
    backgroundColor: COLORS.accentOrange,
  },
  name: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 120,
  },
  status: {
    color: COLORS.textMuted,
    fontSize: 12,
    flex: 1,
  },
});
