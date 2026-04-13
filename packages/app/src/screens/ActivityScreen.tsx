import React, { useEffect } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNotificationStore, type ActivityEntry } from '../store/notifications';
import { COLORS } from '../constants/colors';

const EVENT_ICONS: Record<string, string> = {
  permission: 'Key',
  question: '?',
  completed: 'Done',
  error: '!',
  plan: 'Plan',
};

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function ActivityItem({ item }: { item: ActivityEntry }) {
  return (
    <View style={styles.item}>
      <View style={styles.iconContainer}>
        <Text style={styles.icon}>{EVENT_ICONS[item.eventType] || '?'}</Text>
      </View>
      <View style={styles.content}>
        <Text style={styles.sessionName} numberOfLines={1}>{item.sessionName}</Text>
        <Text style={styles.message} numberOfLines={2}>{item.message}</Text>
      </View>
      <Text style={styles.timestamp}>{formatTimestamp(item.timestamp)}</Text>
    </View>
  );
}

export default function ActivityScreen() {
  const insets = useSafeAreaInsets();
  const activityHistory = useNotificationStore((s) => s.activityHistory);
  const loadActivityHistory = useNotificationStore((s) => s.loadActivityHistory);
  const clearActivityHistory = useNotificationStore((s) => s.clearActivityHistory);

  useEffect(() => {
    void loadActivityHistory();
  }, [loadActivityHistory]);

  const sorted = [...activityHistory].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {sorted.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No activity yet</Text>
          <Text style={styles.emptySubtext}>Session events will appear here</Text>
        </View>
      ) : (
        <>
          <FlatList
            data={sorted}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <ActivityItem item={item} />}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            contentContainerStyle={styles.list}
          />
          <TouchableOpacity
            style={styles.clearButton}
            onPress={() => {
              Alert.alert('Clear Activity', 'Remove all activity history?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Clear', style: 'destructive', onPress: () => void clearActivityHistory() },
              ]);
            }}
          >
            <Text style={styles.clearText}>Clear Activity</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.backgroundPrimary },
  list: { paddingHorizontal: 16, paddingTop: 12 },
  item: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10 },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.backgroundSecondary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  icon: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  content: { flex: 1, marginRight: 8 },
  sessionName: { color: COLORS.textPrimary, fontSize: 14, fontWeight: '600', marginBottom: 2 },
  message: { color: COLORS.textSecondary, fontSize: 13 },
  timestamp: { color: COLORS.textSecondary, fontSize: 11, marginTop: 2 },
  separator: { height: 1, backgroundColor: COLORS.accentBlueBorder, marginLeft: 48 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: COLORS.textSecondary, fontSize: 16, fontWeight: '500' },
  emptySubtext: { color: COLORS.textSecondary, fontSize: 13, marginTop: 4, opacity: 0.6 },
  clearButton: { alignItems: 'center', paddingVertical: 14 },
  clearText: { color: '#ff6b6b', fontSize: 15, fontWeight: '500' },
});
