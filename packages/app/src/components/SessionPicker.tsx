import React, { useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  LayoutChangeEvent,
} from 'react-native';
import { useConnectionStore, SessionInfo } from '../store/connection';

interface SessionPillProps {
  session: SessionInfo;
  isActive: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
}

function SessionPill({ session, isActive, onPress, onLongPress, onLayout }: SessionPillProps) {
  const isPty = session.type === 'pty';
  return (
    <TouchableOpacity
      style={[styles.pill, isActive && styles.pillActive, isPty && styles.pillPty, isActive && isPty && styles.pillPtyActive]}
      onPress={onPress}
      onLongPress={onLongPress}
      onLayout={onLayout}
      activeOpacity={0.7}
    >
      {session.isBusy && <View style={styles.busyDot} />}
      {isPty && <Text style={[styles.ptyIcon, isActive && styles.ptyIconActive]}>{'\u25A0'} </Text>}
      <Text style={[styles.pillText, isActive && styles.pillTextActive]} numberOfLines={1}>
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
  const switchSession = useConnectionStore((s) => s.switchSession);
  const destroySession = useConnectionStore((s) => s.destroySession);
  const renameSession = useConnectionStore((s) => s.renameSession);

  const scrollViewRef = useRef<ScrollView>(null);
  const pillLayouts = useRef<Map<string, { x: number; width: number }>>(new Map());

  const handlePillLayout = useCallback((sessionId: string, e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    pillLayouts.current.set(sessionId, { x, width });
  }, []);

  // Auto-scroll active session pill into view
  useEffect(() => {
    if (!activeSessionId || !scrollViewRef.current) return;
    // Defer to let layout settle after session switch
    const timer = setTimeout(() => {
      const layout = pillLayouts.current.get(activeSessionId);
      if (layout) {
        // Scroll so the pill is roughly centered, but clamp to 0
        const offset = Math.max(0, layout.x - 40);
        scrollViewRef.current?.scrollTo({ x: offset, animated: true });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [activeSessionId]);

  const handleLongPress = (session: SessionInfo) => {
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

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {sessions.map((session) => (
          <SessionPill
            key={session.sessionId}
            session={session}
            isActive={session.sessionId === activeSessionId}
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
          <Text style={styles.addButtonText}>+</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a4e',
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
    backgroundColor: '#2a2a4e',
    borderWidth: 1,
    borderColor: 'transparent',
    maxWidth: 140,
  },
  pillActive: {
    backgroundColor: '#4a9eff22',
    borderColor: '#4a9eff66',
  },
  pillPty: {
    borderColor: '#22c55e33',
  },
  pillPtyActive: {
    backgroundColor: '#22c55e22',
    borderColor: '#22c55e66',
  },
  ptyIcon: {
    color: '#22c55e66',
    fontSize: 8,
  },
  ptyIconActive: {
    color: '#22c55e',
  },
  pillText: {
    color: '#888',
    fontSize: 13,
    fontWeight: '500',
  },
  pillTextActive: {
    color: '#4a9eff',
  },
  busyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#f59e0b',
    marginRight: 6,
  },
  addButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#2a2a4e',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#3a3a5e',
  },
  addButtonText: {
    color: '#888',
    fontSize: 18,
    fontWeight: '400',
    lineHeight: 20,
  },
});
