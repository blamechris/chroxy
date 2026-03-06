import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  AccessibilityInfo,
  Animated,
} from 'react-native';
import { COLORS } from '../../constants/colors';

export function ThinkingIndicator() {
  const dot1Opacity = useRef(new Animated.Value(0.3)).current;
  const dot2Opacity = useRef(new Animated.Value(0.3)).current;
  const dot3Opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const createPulseAnimation = (animatedValue: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animatedValue, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(animatedValue, {
            toValue: 0.3,
            duration: 400,
            useNativeDriver: true,
          }),
          // Compensating delay ensures all sequences have the same 1200ms duration
          Animated.delay(400 - delay),
        ]),
      );
    };

    const animation1 = createPulseAnimation(dot1Opacity, 0);
    const animation2 = createPulseAnimation(dot2Opacity, 200);
    const animation3 = createPulseAnimation(dot3Opacity, 400);

    animation1.start();
    animation2.start();
    animation3.start();

    return () => {
      animation1.stop();
      animation2.stop();
      animation3.stop();
    };
  }, [dot1Opacity, dot2Opacity, dot3Opacity]);

  // Announce to screen readers when thinking indicator mounts
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility('Claude is thinking');
  }, []);

  return (
    <View
      style={styles.thinkingIndicator}
      accessible={true}
      accessibilityLabel="Claude is thinking"
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.thinkingLabel}>Claude is thinking</Text>
      <View style={styles.thinkingDots}>
        <Animated.View style={[styles.thinkingDot, { opacity: dot1Opacity }]} />
        <Animated.View style={[styles.thinkingDot, { opacity: dot2Opacity }]} />
        <Animated.View style={[styles.thinkingDot, { opacity: dot3Opacity }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  thinkingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  thinkingLabel: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
  },
  thinkingDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  thinkingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentBlue,
  },
});
