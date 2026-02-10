import React, { useRef, useEffect, useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  LayoutChangeEvent,
} from 'react-native';
import { useConnectionStore, SessionInfo, SessionHealth } from '../store/connection';
import { ICON_SQUARE, ICON_PLUS } from '../constants/icons';
import { COLORS } from '../constants/colors';


interface SessionPillProps {
  session: SessionInfo;
  isActive: boolean;
  health: SessionHealth;
  onPress: () => void;
  onLongPress: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
}

function SessionPill({ session, isActive, health, onPress, onLongPress, onLayout }: SessionPillProps) {
  const isPty = session.type === 'pty';
  const isCrashed = health === 'crashed';
  return (
    <TouchableOpacity
      style={[
        styles.pill,
        isActive && styles.pillActive,
        isPty && styles.pillPty,
        isActive && isPty && styles.pillPtyActive,
        isCrashed && styles.pillCrashed,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      onLayout={onLayout}
      activeOpacity={0.7}
    >
      {isCrashed ? <View style={styles.crashDot} /> : session.isBusy && <View style={styles.busyDot} />}
      {isPty && <Text style={[styles.ptyIcon, isActive && styles.ptyIconActive]}>{ICON_SQUARE} </Text>}
      <Text style={[styles.pillText, isActive && styles.pillTextActive, isCrashed && styles.pillTextCrashed]} numberOfLines={1}>
        {session.name}
      </Text>
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

    Alert.alert(
      session.name,
      `CWD: ${session.cwd}`,
      [
        {
          text: 'Rename',
          onPress: () => {
            // Alert.prompt is iOS-only; guard for Android
            if (typeof Alert.prompt === 'function') {
              Alert.prompt(
                'Rename Session',
                'Enter a new name:',
                (name) => {
                  if (name && name.trim()) {
                    renameSession(session.sessionId, name.trim());
                  }
                },
                'plain-text',
                session.name,
              );
            } else {
              Alert.alert('Rename', 'Session renaming is not available on this platform.');
            }
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

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        horizontal
        showsHorizontalScrollIndicator={false}
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
            onPress={() => switchSession(session.sessionId)}
            onLongPress={() => handleLongPress(session)}
            onLayout={(e) => handlePillLayout(session.sessionId, e)}
          />
        ))}
        <TouchableOpacity
          style={styles.addButton}
          onPress={onCreatePress}
          activeOpacity={0.7}
        >
          <Text style={styles.addButtonText}>{ICON_PLUS}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
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
  pillPty: {
    borderColor: COLORS.accentGreenBorder,
  },
  pillPtyActive: {
    backgroundColor: COLORS.accentGreenLight,
    borderColor: COLORS.accentGreenBorderStrong,
  },
  ptyIcon: {
    color: COLORS.accentGreenBorderStrong,
    fontSize: 8,
  },
  ptyIconActive: {
    color: COLORS.accentGreen,
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
  pillTextCrashed: {
    color: COLORS.accentRed,
  },
  crashDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentRed,
    marginRight: 6,
  },
  busyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentOrange,
    marginRight: 6,
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
});
