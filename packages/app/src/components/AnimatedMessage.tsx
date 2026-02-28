import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

/** Animation parameters for a message type */
export interface AnimationConfig {
  translateX: number;
  translateY: number;
  duration: number;
}

type MessageType = 'response' | 'user_input' | 'tool_use' | 'thinking' | 'prompt' | 'error' | 'system';

/** Return animation config based on message type */
export function getAnimationConfig(type: MessageType): AnimationConfig {
  switch (type) {
    case 'user_input':
      return { translateX: 30, translateY: 0, duration: 200 };
    case 'response':
      return { translateX: -30, translateY: 0, duration: 200 };
    case 'prompt':
      return { translateX: 0, translateY: 20, duration: 250 };
    case 'system':
    case 'error':
      return { translateX: 0, translateY: 0, duration: 150 };
    default:
      return { translateX: 0, translateY: 0, duration: 150 };
  }
}

/**
 * Determine whether a message should be animated.
 * Only animate messages that appeared recently (after mount time).
 */
export function shouldAnimate(
  messageTimestamp: number,
  mountTime: number,
  reduceMotion: boolean = false,
): boolean {
  if (reduceMotion) return false;
  return messageTimestamp > mountTime;
}

interface AnimatedMessageProps {
  type: MessageType;
  timestamp: number;
  mountTime: number;
  reduceMotion: boolean;
  children: React.ReactNode;
}

/** Wrapper that animates message entrance based on type */
export function AnimatedMessage({ type, timestamp, mountTime, reduceMotion, children }: AnimatedMessageProps) {
  const animate = shouldAnimate(timestamp, mountTime, reduceMotion);
  const config = getAnimationConfig(type);

  const opacity = useRef(new Animated.Value(animate ? 0 : 1)).current;
  const translateX = useRef(new Animated.Value(animate ? config.translateX : 0)).current;
  const translateY = useRef(new Animated.Value(animate ? config.translateY : 0)).current;

  useEffect(() => {
    if (!animate) return;
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: config.duration,
        useNativeDriver: true,
      }),
      Animated.timing(translateX, {
        toValue: 0,
        duration: config.duration,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: config.duration,
        useNativeDriver: true,
      }),
    ]).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!animate) {
    return <>{children}</>;
  }

  return (
    <Animated.View style={{ opacity, transform: [{ translateX }, { translateY }] }}>
      {children}
    </Animated.View>
  );
}
