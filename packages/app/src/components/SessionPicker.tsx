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
import { useConnectionStore } from '../store/connection';
import type { SessionInfo, SessionHealth } from '../store/connection';
import type { ChatMessage } from '@chroxy/store-core';
import { Icon } from './Icon';
import { COLORS } from '../constants/colors';
import { getProviderInfo } from '../constants/providers';
import { hapticMedium } from '../utils/haptics';

/**
 * #5750 — count live, unanswered permission prompts in a session's messages so
 * a background tab can surface a "needs your permission" dot (mobile parity
 * with the dashboard's per-tab indicator, #5667/#5674).
 *
 * Mirrors the dashboard's `isLivePermissionPrompt` predicate
 * (packages/dashboard/src/utils/pendingPermissions.ts): a permission prompt is
 * `type:'prompt'` with a `requestId` + a future `expiresAt` and no `answered`
 * decision. The requestId+expiresAt pair distinguishes a permission prompt
 * from an AskUserQuestion (also `type:'prompt'`, but with neither), and the
 * `expiresAt > now` check clears the dot once the prompt times out (the expiry
 * handlers clear the prompt's options but do NOT set `answered`).
 *
 * NOTE: this predicate is duplicated from the dashboard. Converging both clients
 * onto a single store-core helper is tracked as a follow-up (see #5750).
 */
export function countLivePermissionPrompts(messages: ChatMessage[], now: number): number {
  let count = 0;
  for (const m of messages) {
    if (m.type === 'prompt' && !!m.requestId && !!m.expiresAt && m.expiresAt > now && !m.answered) {
      count++;
    }
  }
  return count;
}

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
  // #4422 — number of backgrounded shells the session is still waiting on.
  // Projected from sessionStates[id]?.pendingBackgroundShells?.length so the
  // pill can surface a "z" dot when the session is idle but parked on a
  // long-running shell. SECONDARY to the busy pulse — the busy dot wins
  // during an active turn.
  pendingShellCount: number;
  // #5750 — number of live, unanswered permission prompts the session is
  // blocked on. Projected from its messages so a background tab surfaces a
  // "needs your permission" dot (parity with the dashboard per-tab indicator).
  pendingPermissionCount: number;
  onPress: () => void;
  onLongPress: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
}

function SessionPill({ session, isActive, health, notificationCount, pendingShellCount, pendingPermissionCount, onPress, onLongPress, onLayout }: SessionPillProps) {
  const isCrashed = health === 'crashed';
  const hasNotification = notificationCount > 0 && !isActive;
  // #5750 — a session blocked on a permission prompt is the most actionable
  // (non-crashed) state: it can't progress until the user answers. Surface it
  // on background tabs (on the active tab the prompt itself is already on
  // screen). It takes precedence over the generic busy pulse — a session
  // waiting on you isn't merely "processing".
  const showPendingPermission = !isCrashed && !isActive && pendingPermissionCount > 0;
  const showBusy = !isCrashed && !showPendingPermission && session.isBusy;
  // #4422 — only surface the pending-shells dot when the session is idle
  // (showBusy=false). During an active turn the busy pulse already conveys
  // "work happening"; the pending-shells indicator is for the "idle but
  // waiting on background work" gap the dashboard ActivityIndicator now
  // surfaces (#4419). Skip on crashed too — a crashed session's red dot is
  // the more urgent signal.
  const showPendingShells = !isCrashed && !showBusy && !showPendingPermission && pendingShellCount > 0;
  const hasIndicators = isCrashed || showPendingPermission || showBusy || hasNotification || showPendingShells;
  // Mobile parity with dashboard SessionBar chips (#3940): surface the
  // provider's short label as a small badge on the pill so claude-tui,
  // codex, gemini, docker-cli, etc. are distinguishable at-a-glance
  // without long-pressing. Same gate as the long-press alert title from
  // #3937 — skip the claude-sdk default and any session with no provider.
  const providerInfo =
    session.provider && session.provider !== 'claude-sdk'
      ? getProviderInfo(session.provider)
      : null;
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
      accessibilityLabel={`Session ${session.name}${providerInfo ? `, ${providerInfo.short} provider` : ''}${session.worktree ? ', isolated worktree' : ''}${showPendingPermission ? ', waiting for your permission' : ''}${showPendingShells ? `, waiting on ${pendingShellCount} background ${pendingShellCount === 1 ? 'shell' : 'shells'}` : ''}`}
      accessibilityState={{ selected: isActive }}
      accessibilityHint={isCrashed ? 'Session has crashed and needs attention' : showPendingPermission ? 'Session is waiting for you to allow or deny a permission request' : showBusy ? 'Session is currently processing' : showPendingShells ? 'Session is idle but waiting on a backgrounded shell' : undefined}
    >
      {hasIndicators && (
        <View style={styles.indicators} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {isCrashed && <View style={styles.crashDot} />}
          {showPendingPermission && <View style={styles.permissionDot} />}
          {showBusy && <PulsingDot />}
          {showPendingShells && <View style={styles.pendingShellsDot} />}
          {hasNotification && <NotificationBadge count={notificationCount} />}
        </View>
      )}
      <Text style={[styles.pillText, isActive && styles.pillTextActive, isCrashed && styles.pillTextCrashed]} numberOfLines={1}>
        {session.name}
      </Text>
      {providerInfo && (
        <View
          style={styles.providerBadge}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={styles.providerBadgeText} numberOfLines={1} accessibilityLabel="">
            {providerInfo.short}
          </Text>
        </View>
      )}
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

    // Suffix the alert title with the provider's short label for any
    // non-default provider (default is claude-sdk). Pre-#3937 this only
    // covered claude-cli; now it covers claude-tui, codex, gemini, and
    // any future provider getProviderInfo knows about.
    const providerLabel = session.provider && session.provider !== 'claude-sdk'
      ? ` (${getProviderInfo(session.provider).short})`
      : '';
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

  // #5750 — per-session live permission-prompt counts, for the "needs your
  // permission" tab dot. Recomputes when any session's messages change (which
  // is also when a prompt is answered or its expiry handler fires, clearing
  // the dot). `Date.now()` is read at compute time; an unanswered prompt that
  // simply times out clears on the next message change via the `expiresAt >
  // now` check — matching the dashboard's behavior.
  const pendingPermissionCounts = useMemo(() => {
    const now = Date.now();
    const counts = new Map<string, number>();
    for (const id in sessionStates) {
      const messages = sessionStates[id]?.messages;
      if (!messages || messages.length === 0) continue;
      const c = countLivePermissionPrompts(messages, now);
      if (c > 0) counts.set(id, c);
    }
    return counts;
  }, [sessionStates]);

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
            // #4422 — project the per-session pendingBackgroundShells count
            // from sessionStates. `?? 0` covers both pre-#4307 servers (field
            // is undefined) and sessions whose state slot hasn't been seeded
            // yet (no entry in sessionStates).
            pendingShellCount={sessionStates[session.sessionId]?.pendingBackgroundShells?.length ?? 0}
            pendingPermissionCount={pendingPermissionCounts.get(session.sessionId) || 0}
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
  // #5750 — "needs your permission" dot. Amber (the warning/attention accent)
  // so it reads as actionable, distinct from the blue busy pulse and the green
  // pending-shells dot. Static (no pulse) — the urgency is "you must answer",
  // not "work is happening".
  permissionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentOrange,
  },
  busyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentBlue,
  },
  // #4422 — pending-background-shell dot. Static (no pulse) and styled
  // green to match the dashboard ActivityIndicator chip (#4419) — both
  // surfaces say the same thing in the same colour: "idle, but parked on
  // backgrounded work". Distinct from the blue busyDot (pulsing) so users
  // can tell the two states apart at-a-glance.
  pendingShellsDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentGreen,
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
  providerBadge: {
    marginLeft: 4,
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    maxWidth: 60,
  },
  providerBadgeText: {
    // Render the canonical short label exactly as `getProviderInfo(...).short`
    // returns it ("Codex", "Gemini", "Docker CLI", "TUI", "CLI"), matching
    // the dashboard SessionBar chip text for cross-surface parity. No
    // textTransform — uppercasing would mangle "Codex" -> "CODEX" and
    // diverge from the shared label source.
    color: COLORS.textMuted,
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
