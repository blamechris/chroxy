/**
 * Full-screen overlay that blocks interaction until biometric auth succeeds.
 * Shown when the app returns from background with biometric lock enabled.
 */
import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../constants/colors';

interface LockScreenProps {
  onUnlock: () => Promise<boolean>;
}

export function LockScreen({ onUnlock }: LockScreenProps) {
  // Auto-prompt on mount
  useEffect(() => {
    onUnlock();
  }, [onUnlock]);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.icon}>{'🔒'}</Text>
        <Text style={styles.title}>Chroxy is Locked</Text>
        <Text style={styles.subtitle}>Authenticate to continue</Text>
        <TouchableOpacity style={styles.button} onPress={onUnlock}>
          <Text style={styles.buttonText}>Unlock</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.backgroundPrimary,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  content: {
    alignItems: 'center',
    gap: 12,
  },
  icon: {
    fontSize: 48,
    marginBottom: 8,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 22,
    fontWeight: '600',
  },
  subtitle: {
    color: COLORS.textMuted,
    fontSize: 15,
    marginBottom: 24,
  },
  button: {
    backgroundColor: COLORS.accentBlue,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    minWidth: 160,
    alignItems: 'center',
  },
  buttonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
});
