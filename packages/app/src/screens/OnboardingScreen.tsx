import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { COLORS } from '../constants/colors';

const STEPS = [
  {
    title: 'Welcome to Chroxy',
    body: 'Control Claude Code from your phone. Run a lightweight daemon on your dev machine, connect via a secure tunnel, and get both a terminal view and a clean chat UI.',
  },
  {
    title: 'Set Up the Server',
    body: 'On your dev machine, install and start the Chroxy server:\n\nnpx chroxy start\n\nThis starts a daemon with a secure Cloudflare tunnel and displays a QR code.',
  },
  {
    title: 'Connect',
    body: 'Scan the QR code shown in your terminal, or enter the server URL manually. You can also use LAN scan to discover servers on your local network.',
  },
];

interface OnboardingScreenProps {
  onComplete: () => void;
}

export function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;

  const handleNext = () => {
    if (isLast) {
      onComplete();
    } else {
      setStep((s) => s + 1);
    }
  };

  const currentStep = STEPS[step];

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.stepIndicator}>
          {STEPS.map((_, i) => (
            <View key={i} style={[styles.dot, i === step && styles.dotActive]} />
          ))}
        </View>
        <Text style={styles.title}>{currentStep.title}</Text>
        <Text style={styles.body}>{currentStep.body}</Text>
      </ScrollView>
      <View style={styles.footer}>
        <TouchableOpacity onPress={onComplete} style={styles.skipButton}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleNext} style={styles.nextButton} accessibilityRole="button">
          <Text style={styles.nextText}>{isLast ? 'Get Started' : 'Next'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 60,
  },
  stepIndicator: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 32,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.textDim,
  },
  dotActive: {
    backgroundColor: COLORS.accentBlue,
    width: 24,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 20,
  },
  body: {
    color: COLORS.textSecondary,
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingBottom: 40,
    paddingTop: 16,
  },
  skipButton: {
    padding: 12,
  },
  skipText: {
    color: COLORS.textDim,
    fontSize: 16,
  },
  nextButton: {
    backgroundColor: COLORS.accentBlue,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  nextText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
