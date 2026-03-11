import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { COLORS } from '../constants/colors';
import { Icon } from './Icon';

interface SessionTimeoutBannerProps {
  remainingMs: number;
  sessionName: string;
  onKeepAlive: () => void;
  onDismiss: () => void;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function SessionTimeoutBanner({
  remainingMs,
  sessionName,
  onKeepAlive,
  onDismiss,
}: SessionTimeoutBannerProps) {
  const [countdown, setCountdown] = useState(remainingMs);
  const startTimeRef = useRef(Date.now());
  const slideAnim = useRef(new Animated.Value(-80)).current;

  useEffect(() => {
    startTimeRef.current = Date.now();
    setCountdown(remainingMs);
  }, [remainingMs]);

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      tension: 80,
      friction: 12,
    }).start();
  }, [slideAnim]);

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = Math.max(0, remainingMs - elapsed);
      setCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [remainingMs]);

  const handleKeepAlive = useCallback(() => {
    Animated.timing(slideAnim, {
      toValue: -80,
      duration: 200,
      useNativeDriver: true,
    }).start(() => {
      onKeepAlive();
    });
  }, [onKeepAlive, slideAnim]);

  return (
    <Animated.View
      style={[styles.container, { transform: [{ translateY: slideAnim }] }]}
      accessibilityRole="alert"
      accessibilityLabel={`Session ${sessionName} will timeout in ${formatCountdown(countdown)}`}
    >
      <View style={styles.content}>
        <Icon name="clock" size={16} color={COLORS.accentOrange} />
        <Text style={styles.text} numberOfLines={1}>
          <Text style={styles.bold}>{sessionName}</Text> timeout in{' '}
          <Text style={styles.countdown}>{formatCountdown(countdown)}</Text>
        </Text>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.keepAliveButton}
          onPress={handleKeepAlive}
          accessibilityRole="button"
          accessibilityLabel="Keep session alive"
        >
          <Text style={styles.keepAliveText}>Keep Alive</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.dismissButton}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss timeout warning"
        >
          <Icon name="close" size={14} color={COLORS.textMuted} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.accentOrangeLight,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.accentOrangeBorder,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  text: {
    color: COLORS.textPrimary,
    fontSize: 13,
    flex: 1,
  },
  bold: {
    fontWeight: '600',
  },
  countdown: {
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    color: COLORS.accentOrange,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  keepAliveButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: COLORS.accentOrange,
  },
  keepAliveText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  dismissButton: {
    padding: 6,
    minWidth: 28,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
