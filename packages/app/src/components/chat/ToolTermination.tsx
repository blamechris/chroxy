import React from 'react';
import { Text, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { describeTurnTermination } from '@chroxy/store-core';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';

export type ToolTermination = ReturnType<typeof describeTurnTermination>;

/**
 * #7376 / #8364: a tool cut off because its TURN was terminated underneath it
 * (permission-mode switch, Stop, crash, watchdog) never reported a result. It
 * is not "the command failed", so every tool surface (activity entry, lone
 * bubble, detail modal) gives it the same amber state instead of the red error
 * state, and shows the cautious "check whether it took effect" sentence in
 * place of the server's synthesized result text. Returns null unless a result
 * has landed and a reason is set; wins over `toolResultIsError`, which the
 * server also sets on these synthetic results.
 */
export function getToolTermination(hasResult: boolean, reason?: string): ToolTermination | null {
  return hasResult && reason ? describeTurnTermination(reason) : null;
}

// `markerId` (not `testID`) becomes the inner element's testID, so a
// findAllByProps({ testID }) lookup lands on the Icon / Text itself rather
// than on this wrapper.
export function TerminatedIcon({ termination, markerId }: { termination: ToolTermination; markerId: string }) {
  return (
    <Icon
      name="stop"
      size={12}
      color={COLORS.accentOrange}
      testID={markerId}
      accessibilityLabel={termination.label === 'stopped' ? 'stopped' : 'turn terminated'}
    />
  );
}

export function TerminatedNote({ termination, markerId, style }: { termination: ToolTermination; markerId: string; style?: StyleProp<TextStyle> }) {
  return (
    <Text style={[styles.note, style]} testID={markerId} accessibilityRole="text">
      {termination.summary}
    </Text>
  );
}

const styles = StyleSheet.create({
  note: {
    color: COLORS.accentOrange,
    fontSize: 12,
    lineHeight: 18,
    flexShrink: 1,
  },
});
