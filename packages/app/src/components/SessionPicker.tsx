import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  StyleSheet,
  Alert,
  Animated,
  LayoutChangeEvent,
} from 'react-native';
import { useConnectionStore, SessionInfo, SessionHealth } from '../store/connection';
import { Icon } from './Icon';
import { COLORS } from '../constants/colors';
import { hapticMedium } from '../utils/haptics';

/** Pulsing dot for busy sessions */
function PulsingDot() {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return <Animated.View style={[styles.busyDot, { opacity }]} />;
}

/** Small notification count badge */
function NotificationBadge({ count }: { count: number }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
    </View>
  );
}

interface SessionPillProps {
  session: SessionInfo;
  isActive: boolean;
  health: SessionHealth;
  notificationCount: number;
  onPress: () => void;
  onLongPress: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
}

function SessionPill({ session, isActive, health, notificationCount, onPress, onLongPress, onLayout }: SessionPillProps) {
  const isCrashed = health === 'crashed';
  const hasNotification = notificationCount > 0 && !isActive;
  const showBusy = !isCrashed && session.isBusy;
  const hasIndicators = isCrashed || showBusy || hasNotification;
  return (
    <TouchableOpacity
      style={[
        styles.pill,
        isActive && styles.pillActive,
        isCrashed && styles.pillCrashed,
        hasNotification && styles.pillAttention,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      onLayout={onLayout}
      activeOpacity={0.7}
      accessibilityRole="tab"
      accessibilityLabel={`Session ${session.name}${session.worktree ? ', isolated worktree' : ''}`}
      accessibilityState={{ selected: isActive }}
      accessibilityHint={isCrashed ? 'Session has crashed and needs attention' : showBusy ? 'Session is currently processing' : undefined}
    >
      {hasIndicators && (
        <View style={styles.indicators} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {isCrashed && <View style={styles.crashDot} />}
          {showBusy && <PulsingDot />}
          {hasNotification && <NotificationBadge count={notificationCount} />}
        </View>
      )}
      <Text style={[styles.pillText, isActive && styles.pillTextActive, isCrashed && styles.pillTextCrashed]} numberOfLines={1}>
        {session.name}
      </Text>
      {session.worktree && (
        <View style={styles.worktreeBadge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={styles.worktreeBadgeText} accessibilityLabel="">W</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

interface SessionPickerProps {
  onCreatePress: () => void;
}

export function SessionPicker({ onCreatePress }: SessionPickerProps) {
  const sessions = useConnectionStore((s) => s.sessions);
  const activeSessionId = useConnectionStore((s) => s.activeSessionId);
  const sessionStates = useConnectionStore((s) => s.sessionStates);
  const switchSession = useConnectionStore((s) => s.switchSession);
  const destroySession = useConnectionStore((s) => s.destroySession);
  const renameSession = useConnectionStore((s) => s.renameSession);
  const sessionNotifications = useConnectionStore((s) => s.sessionNotifications);
  const followMode = useConnectionStore((s) => s.followMode);
  const setFollowMode = useConnectionStore((s) => s.setFollowMode);
  const connectedClients = useConnectionStore((s) => s.connectedClients);

  const [renameTarget, setRenameTarget] = useState<{ sessionId: string; name: string } | null>(null);
  const [renameText, setRenameText] = useState('');

  const scrollViewRef = useRef<ScrollView>(null);
  const pillLayouts = useRef<Map<string, { x: number; width: number }>>(new Map());
  const [viewportWidth, setViewportWidth] = useState(0);
  const pendingScrollRef = useRef<string | null>(null);

  const scrollToSession = useCallback((sessionId: string) => {
    const layout = pillLayouts.current.get(sessionId);
    if (!layout || !scrollViewRef.current || viewportWidth === 0) {
      // Layout not ready yet, mark for scroll when it is
      pendingScrollRef.current = sessionId;
      return;
    }
    // Center the pill within the viewport, clamped to 0
    const offset = Math.max(0, layout.x - (viewportWidth - layout.width) / 2);
    scrollViewRef.current.scrollTo({ x: offset, animated: true });
    pendingScrollRef.current = null;
  }, [viewportWidth]);

  const handlePillLayout = useCallback((sessionId: string, e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    pillLayouts.current.set(sessionId, { x, width });
    // If this pill is the active session or has a pending scroll, scroll to it now
    if (sessionId === activeSessionId || sessionId === pendingScrollRef.current) {
      scrollToSession(sessionId);
    }
  }, [activeSessionId, scrollToSession]);

  // Prune stale entries when sessions change
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.sessionId));
    for (const key of pillLayouts.current.keys()) {
      if (!currentIds.has(key)) {
        pillLayouts.current.delete(key);
      }
    }
  }, [sessions]);

  // Auto-scroll active session pill into view when it changes
  useEffect(() => {
    if (!activeSessionId) return;
    scrollToSession(activeSessionId);
  }, [activeSessionId, scrollToSession]);

  const handleLongPress = (session: SessionInfo) => {
    hapticMedium();
    const health = sessionStates[session.sessionId]?.health || 'healthy';
    const isCrashed = health === 'crashed';

    if (isCrashed) {
      Alert.alert(
        `${session.name} (crashed)`,
        'This session has crashed and is no longer running.',
        [
          {
            text: 'Delete Crashed Session',
            style: 'destructive',
            onPress: () => {
              if (sessions.length <= 1) {
                Alert.alert('Cannot Delete', 'You must have at least one session.');
                return;
              }
              destroySession(session.sessionId);
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }

    const providerLabel = session.provider === 'claude-cli' ? ' (CLI)' : '';
    Alert.alert(
      session.name + providerLabel,
      `CWD: ${session.cwd}`,
      [
        {
          text: 'Rename',
          onPress: () => {
            setRenameText(session.name);
            setRenameTarget({ sessionId: session.sessionId, name: session.name });
          },
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (sessions.length <= 1) {
              Alert.alert('Cannot Delete', 'You must have at least one session.');
              return;
            }
            Alert.alert(
              'Delete Session',
              `Delete "${session.name}"? This will stop its Claude process.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => destroySession(session.sessionId),
                },
              ],
            );
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const handleContentSizeChange = useCallback(() => {
    // When content size changes (e.g., new session added), scroll to show the active session
    if (activeSessionId) {
      scrollToSession(activeSessionId);
    }
  }, [activeSessionId, scrollToSession]);

  const notificationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of sessionNotifications) {
      counts.set(n.sessionId, (counts.get(n.sessionId) || 0) + 1);
    }
    return counts;
  }, [sessionNotifications]);

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        onLayout={(e) => setViewportWidth(e.nativeEvent.layout.width)}
        onContentSizeChange={handleContentSizeChange}
      >
        {sessions.map((session) => (
          <SessionPill
            key={session.sessionId}
            session={session}
            isActive={session.sessionId === activeSessionId}
            health={sessionStates[session.sessionId]?.health || 'healthy'}
            notificationCount={notificationCounts.get(session.sessionId) || 0}
            onPress={() => switchSession(session.sessionId)}
            onLongPress={() => handleLongPress(session)}
            onLayout={(e) => handlePillLayout(session.sessionId, e)}
          />
        ))}
        <TouchableOpacity
          style={styles.addButton}
          onPress={onCreatePress}
          activeOpacity={0.7}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel="Create new session"
        >
          <Icon name="plus" size={20} color={COLORS.textPrimary} />
        </TouchableOpacity>
      </ScrollView>
      {connectedClients.some((c) => !c.isSelf) && (
        <TouchableOpacity
          style={[styles.followButton, followMode && styles.followButtonActive]}
          onPress={() => setFollowMode(!followMode)}
          activeOpacity={0.7}
          accessibilityRole="switch"
          accessibilityLabel="Toggle follow mode"
          accessibilityState={{ checked: followMode }}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text style={styles.followButtonText}>{'\u{1F517}'}</Text>
        </TouchableOpacity>
      )}
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

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: COLORS.backgroundCard,
    borderWidth: 1,
    borderColor: COLORS.borderTransparent,
    maxWidth: 140,
  },
  pillActive: {
    backgroundColor: COLORS.accentBlueLight,
    borderColor: COLORS.accentBlueBorderStrong,
  },
  pillText: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },
  pillTextActive: {
    color: COLORS.accentBlue,
  },
  pillCrashed: {
    borderColor: COLORS.accentRedBorder,
  },
  pillAttention: {
    borderColor: COLORS.accentOrangeBorderStrong,
  },
  pillTextCrashed: {
    color: COLORS.accentRed,
  },
  indicators: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginRight: 4,
  },
  crashDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentRed,
  },
  busyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentBlue,
  },
  badge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: COLORS.accentOrange,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 14,
  },
  worktreeBadge: {
    marginLeft: 4,
    backgroundColor: COLORS.accentGreenLight,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  worktreeBadgeText: {
    color: COLORS.accentGreen,
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 13,
  },
  addButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.backgroundCard,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.borderSecondary,
  },
  addButtonText: {
    color: COLORS.textMuted,
    fontSize: 18,
    fontWeight: '400',
    lineHeight: 20,
  },
  followButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.backgroundCard,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.borderSecondary,
    marginRight: 8,
    opacity: 0.5,
  },
  followButtonActive: {
    backgroundColor: COLORS.accentBlueLight,
    borderColor: COLORS.accentBlueBorderStrong,
    opacity: 1,
  },
  followButtonText: {
    fontSize: 14,
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
