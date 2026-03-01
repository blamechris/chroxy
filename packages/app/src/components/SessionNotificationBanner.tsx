import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useConnectionStore, SessionNotification } from '../store/connection';
import { Icon } from './Icon';
import { COLORS } from '../constants/colors';

const MAX_VISIBLE = 3;

const EVENT_LABELS: Record<SessionNotification['eventType'], string> = {
  permission: 'needs permission',
  question: 'has a question',
  completed: 'finished',
  error: 'error',
};

function NotificationRow({ notification }: { notification: SessionNotification }) {
  const switchSession = useConnectionStore((s) => s.switchSession);
  const dismiss = useConnectionStore((s) => s.dismissSessionNotification);

  const dotColor =
    notification.eventType === 'error' ? COLORS.accentRed :
    notification.eventType === 'completed' ? COLORS.accentGreen :
    COLORS.accentOrange;

  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={styles.rowContent}
        onPress={() => switchSession(notification.sessionId)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Switch to ${notification.sessionName}`}
      >
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.sessionName} numberOfLines={1}>
          {notification.sessionName}
        </Text>
        <Text style={styles.eventLabel} numberOfLines={1}>
          {EVENT_LABELS[notification.eventType]}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => dismiss(notification.id)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel="Dismiss notification"
      >
        <Icon name="close" size={14} color={COLORS.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

export function SessionNotificationBanner() {
  const notifications = useConnectionStore((s) => s.sessionNotifications);

  if (notifications.length === 0) return null;

  const visible = notifications.slice(-MAX_VISIBLE);
  const overflow = notifications.length - MAX_VISIBLE;

  return (
    <View style={styles.container}>
      {visible.map((n) => (
        <NotificationRow key={n.id} notification={n} />
      ))}
      {overflow > 0 && (
        <Text style={styles.overflow}>+{overflow} more</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.accentOrangeSubtle,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.accentOrangeBorder,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  sessionName: {
    color: COLORS.accentOrange,
    fontSize: 13,
    fontWeight: '600',
    maxWidth: 120,
  },
  eventLabel: {
    color: COLORS.textSecondary,
    fontSize: 13,
    flex: 1,
  },
  dismissText: {
    color: COLORS.textMuted,
    fontSize: 14,
    paddingLeft: 8,
  },
  overflow: {
    color: COLORS.textMuted,
    fontSize: 12,
    textAlign: 'center',
    paddingBottom: 4,
  },
});
