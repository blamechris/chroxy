import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  StyleSheet,
  Alert,
  Platform,
  Animated,
  type AlertButton,
} from 'react-native';
import { useConnectionStore } from '../store/connection';
import type { SessionInfo, SessionHealth, SessionState, SessionNotification } from '../store/types';
import { Icon, type IconName } from './Icon';
import { COLORS } from '../constants/colors';

// -- Status classification --

export type SessionStatus = 'crashed' | 'permission' | 'attention' | 'agents' | 'busy' | 'idle';

interface StatusInput {
  health: SessionHealth;
  isBusy: boolean;
  isIdle: boolean;
  activeAgentCount: number;
  isPlanPending: boolean;
  hasNotification: boolean;
}

/** Classify session into a single status for display. Priority order matters. */
export function getSessionStatus(input: StatusInput): SessionStatus {
  if (input.health === 'crashed') return 'crashed';
  if (input.isPlanPending) return 'permission';
  if (input.hasNotification) return 'attention';
  if (input.activeAgentCount > 0) return 'agents';
  if (input.isBusy) return 'busy';
  return 'idle';
}

/** Format cost for display */
export function formatCost(cost: number | null): string {
  if (cost === null || cost === 0) return '\u2014';
  if (cost > 0 && cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

/** Get color pair for a session status */
export function getStatusColor(status: SessionStatus): { fg: string; bg: string } {
  switch (status) {
    case 'crashed':
      return { fg: COLORS.accentRed, bg: COLORS.accentRedSubtle };
    case 'permission':
      return { fg: COLORS.accentOrange, bg: COLORS.accentOrangeSubtle };
    case 'attention':
      return { fg: COLORS.accentOrange, bg: COLORS.accentOrangeSubtle };
    case 'agents':
      return { fg: COLORS.accentPurple, bg: COLORS.accentPurpleSubtle };
    case 'busy':
      return { fg: COLORS.accentBlue, bg: COLORS.accentBlueSubtle };
    case 'idle':
      return { fg: COLORS.accentGreen, bg: COLORS.accentGreenLight };
  }
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  crashed: 'Crashed',
  permission: 'Needs Approval',
  attention: 'Needs Attention',
  agents: 'Agents Running',
  busy: 'Working',
  idle: 'Idle',
};

const STATUS_ICONS: Record<SessionStatus, IconName> = {
  crashed: 'alertCircle',
  permission: 'alertCircle',
  attention: 'alertCircle',
  agents: 'bullet',
  busy: 'bullet',
  idle: 'checkCircle',
};

/** Priority order for sorting sessions — lower number = higher priority */
const STATUS_PRIORITY: Record<SessionStatus, number> = {
  permission: 0, attention: 1, crashed: 2, agents: 3, busy: 4, idle: 5,
};

// -- Elapsed time formatter --

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// -- Session Card --

interface SessionCardProps {
  session: SessionInfo;
  sessionState: SessionState | undefined;
  isActive: boolean;
  hasNotification: boolean;
  notification: SessionNotification | undefined;
  onPress: () => void;
  onLongPress: () => void;
}

function SessionCard({ session, sessionState, isActive, hasNotification, notification, onPress, onLongPress }: SessionCardProps) {
  const status = getSessionStatus({
    health: sessionState?.health ?? 'healthy',
    isBusy: session.isBusy,
    isIdle: sessionState?.isIdle ?? true,
    activeAgentCount: sessionState?.activeAgents?.length ?? 0,
    isPlanPending: sessionState?.isPlanPending ?? false,
    hasNotification,
  });

  const colors = getStatusColor(status);
  const lastMessage = sessionState?.messages?.length
    ? sessionState.messages[sessionState.messages.length - 1]
    : null;

  // Pulsing animation for attention/permission states
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (status === 'permission' || status === 'attention') {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.6, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    }
    pulseAnim.setValue(1);
  }, [status, pulseAnim]);

  return (
    <TouchableOpacity
      style={[styles.card, isActive && styles.cardActive]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Session ${session.name}, ${STATUS_LABELS[status]}${isActive ? ', active' : ''}`}
    >
      {/* Header: name + status badge */}
      <View style={styles.cardHeader}>
        <Text style={[styles.cardName, isActive && styles.cardNameActive]} numberOfLines={1}>
          {session.name}
        </Text>
        <Animated.View
          style={[
            styles.statusBadge,
            { backgroundColor: colors.bg },
            (status === 'permission' || status === 'attention') ? { opacity: pulseAnim } : undefined,
          ]}
        >
          <Icon name={STATUS_ICONS[status]} size={10} color={colors.fg} />
          <Text style={[styles.statusText, { color: colors.fg }]}>{STATUS_LABELS[status]}</Text>
        </Animated.View>
      </View>

      {/* Active agents */}
      {sessionState?.activeAgents && sessionState.activeAgents.length > 0 && (
        <View style={styles.agentRow}>
          <Icon name="bullet" size={8} color={COLORS.accentPurple} />
          <Text style={styles.agentText} numberOfLines={1}>
            {sessionState.activeAgents.length} agent{sessionState.activeAgents.length > 1 ? 's' : ''}: {sessionState.activeAgents.map((a) => a.description).join(', ')}
          </Text>
        </View>
      )}

      {/* Notification message */}
      {notification && (
        <Text style={styles.notificationText} numberOfLines={1}>
          {notification.message}
        </Text>
      )}

      {/* Last message preview */}
      {lastMessage && !notification && (
        <Text style={styles.previewText} numberOfLines={2}>
          {lastMessage.type === 'user_input' ? 'You: ' : ''}{lastMessage.content?.slice(0, 120) || ''}
        </Text>
      )}

      {/* Footer: model, cost, git, time */}
      <View style={styles.cardFooter}>
        {session.model && (
          <Text style={styles.metaText} numberOfLines={1}>
            {session.model}
          </Text>
        )}
        {sessionState?.sessionCost != null && sessionState.sessionCost > 0 && (
          <Text style={styles.costText}>
            {formatCost(sessionState.sessionCost)}
          </Text>
        )}
        {sessionState?.sessionContext?.gitBranch && (
          <Text style={styles.gitText} numberOfLines={1}>
            {sessionState.sessionContext.gitBranch}
          </Text>
        )}
        <Text style={styles.timeText}>
          {formatTimeAgo(session.createdAt)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// -- Session Overview Panel --

interface SessionOverviewProps {
  onClose: () => void;
}

export function SessionOverview({ onClose }: SessionOverviewProps) {
  const sessions = useConnectionStore((s) => s.sessions);
  const activeSessionId = useConnectionStore((s) => s.activeSessionId);
  const sessionStates = useConnectionStore((s) => s.sessionStates);
  const notifications = useConnectionStore((s) => s.sessionNotifications);
  const switchSession = useConnectionStore((s) => s.switchSession);
  const destroySession = useConnectionStore((s) => s.destroySession);
  const renameSession = useConnectionStore((s) => s.renameSession);
  const totalCost = useConnectionStore((s) => s.totalCost);
  const costBudget = useConnectionStore((s) => s.costBudget);

  const [renameTarget, setRenameTarget] = useState<{ sessionId: string; name: string } | null>(null);
  const [renameText, setRenameText] = useState('');

  // Tick for elapsed time updates
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  const notificationSet = new Set(notifications.map((n) => n.sessionId));
  const notificationMap = new Map(notifications.map((n) => [n.sessionId, n]));

  // Sort: attention-needing first, then active, then by creation time
  const sorted = [...sessions].sort((a, b) => {
    const aStatus = getSessionStatus({
      health: sessionStates[a.sessionId]?.health ?? 'healthy',
      isBusy: a.isBusy,
      isIdle: sessionStates[a.sessionId]?.isIdle ?? true,
      activeAgentCount: sessionStates[a.sessionId]?.activeAgents?.length ?? 0,
      isPlanPending: sessionStates[a.sessionId]?.isPlanPending ?? false,
      hasNotification: notificationSet.has(a.sessionId),
    });
    const bStatus = getSessionStatus({
      health: sessionStates[b.sessionId]?.health ?? 'healthy',
      isBusy: b.isBusy,
      isIdle: sessionStates[b.sessionId]?.isIdle ?? true,
      activeAgentCount: sessionStates[b.sessionId]?.activeAgents?.length ?? 0,
      isPlanPending: sessionStates[b.sessionId]?.isPlanPending ?? false,
      hasNotification: notificationSet.has(b.sessionId),
    });
    if (STATUS_PRIORITY[aStatus] !== STATUS_PRIORITY[bStatus]) return STATUS_PRIORITY[aStatus] - STATUS_PRIORITY[bStatus];
    if (a.sessionId === activeSessionId) return -1;
    if (b.sessionId === activeSessionId) return 1;
    return b.createdAt - a.createdAt;
  });

  const handleLongPress = (session: SessionInfo) => {
    const buttons: AlertButton[] = [];
    buttons.push({
      text: 'Rename',
      onPress: () => {
        setRenameText(session.name);
        setRenameTarget({ sessionId: session.sessionId, name: session.name });
      },
    });
    buttons.push({
      text: 'Delete',
      style: 'destructive',
      onPress: () => {
        Alert.alert('Delete Session', `Delete "${session.name}"?`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => destroySession(session.sessionId) },
        ]);
      },
    });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(session.name, undefined, buttons);
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Sessions</Text>
        <View style={styles.headerMeta}>
          {totalCost != null && totalCost > 0 && (
            <Text style={styles.headerCost}>
              Total: {formatCost(totalCost)}
              {costBudget != null ? ` / $${costBudget.toFixed(0)}` : ''}
            </Text>
          )}
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Close session overview"
          >
            <Icon name="close" size={20} color={COLORS.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Session cards */}
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {sorted.map((session) => (
          <SessionCard
            key={session.sessionId}
            session={session}
            sessionState={sessionStates[session.sessionId]}
            isActive={session.sessionId === activeSessionId}
            hasNotification={notificationSet.has(session.sessionId)}
            notification={notificationMap.get(session.sessionId)}
            onPress={() => {
              switchSession(session.sessionId);
              onClose();
            }}
            onLongPress={() => handleLongPress(session)}
          />
        ))}
        {sessions.length === 0 && (
          <Text style={styles.emptyText}>No sessions yet</Text>
        )}
      </ScrollView>

      {/* Rename modal */}
      <Modal
        visible={renameTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameTarget(null)}
      >
        <View style={styles.renameOverlay}>
          <View style={styles.renameModal}>
            <Text style={styles.renameTitle}>Rename Session</Text>
            <TextInput
              style={styles.renameInput}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              selectTextOnFocus
              placeholder="Session name"
              placeholderTextColor={COLORS.textDim}
              accessibilityLabel="Session name"
            />
            <View style={styles.renameButtons}>
              <TouchableOpacity
                style={styles.renameCancelBtn}
                onPress={() => setRenameTarget(null)}
                accessibilityRole="button"
                accessibilityLabel="Cancel rename"
              >
                <Text style={styles.renameCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.renameSaveBtn}
                onPress={() => {
                  if (renameTarget && renameText.trim()) {
                    renameSession(renameTarget.sessionId, renameText.trim());
                  }
                  setRenameTarget(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Save session name"
              >
                <Text style={styles.renameSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// -- Styles --

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  headerTitle: {
    color: COLORS.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerCost: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
    gap: 8,
  },
  card: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  cardActive: {
    borderColor: COLORS.accentBlueBorder,
    backgroundColor: COLORS.accentBlueLight,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardName: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  cardNameActive: {
    color: COLORS.accentBlue,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  agentText: {
    color: COLORS.accentPurple,
    fontSize: 12,
    flex: 1,
  },
  notificationText: {
    color: COLORS.accentOrange,
    fontSize: 12,
    marginBottom: 4,
  },
  previewText: {
    color: COLORS.textDim,
    fontSize: 12,
    marginBottom: 6,
    lineHeight: 16,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  metaText: {
    color: COLORS.textDim,
    fontSize: 11,
    maxWidth: 100,
  },
  costText: {
    color: COLORS.accentGreen,
    fontSize: 11,
    fontWeight: '600',
  },
  gitText: {
    color: COLORS.accentPurple,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    maxWidth: 120,
  },
  timeText: {
    color: COLORS.textDim,
    fontSize: 11,
    marginLeft: 'auto',
  },
  emptyText: {
    color: COLORS.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 40,
  },
  renameOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  renameModal: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 12,
    padding: 20,
    width: '80%',
    maxWidth: 320,
  },
  renameTitle: {
    color: COLORS.textPrimary,
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 12,
  },
  renameInput: {
    backgroundColor: COLORS.backgroundCard,
    color: COLORS.textPrimary,
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: COLORS.borderSecondary,
    marginBottom: 16,
  },
  renameButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  renameCancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  renameCancelText: {
    color: COLORS.textMuted,
    fontSize: 15,
  },
  renameSaveBtn: {
    backgroundColor: COLORS.accentBlue,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  renameSaveText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
