import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { describeTurnTermination } from '@chroxy/store-core';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';

type TurnTermination = ReturnType<typeof describeTurnTermination>;

/**
 * #7376 / #8364: a tool cut off because its TURN was terminated underneath it
 * (permission-mode switch, Stop, crash, watchdog) never reported a result. It
 * is not "the command failed", so every mobile surface that shows a tool
 * (ActivityGroup entry, lone ToolBubble, ToolDetailModal) renders the same
 * amber terminated state and replaces the server-synthesized result text with
 * the cautious "check whether it took effect before retrying" sentence.
 *
 * Returns null unless the result has landed AND a reason is set. Wins over
 * `toolResultIsError`, which the server also sets on these synthetic results.
 */
export function resolveToolTermination(hasResult: boolean, reason?: string): TurnTermination | null {
  return hasResult && reason ? describeTurnTermination(reason) : null;
}

/** Amber stop icon (a plain function, not a component, so `testID` lands only on the Icon);
 *  the accessibility label distinguishes a user Stop. */
export function renderTerminatedIcon(termination: TurnTermination, testID: string) {
  return (
    <Icon
      name="stop"
      size={12}
      color={COLORS.accentOrange}
      testID={testID}
      accessibilityLabel={termination.label === 'stopped' ? 'stopped' : 'turn terminated'}
    />
  );
}

/** Amber explanatory note carrying the termination summary. */
export function TerminatedNote({ termination, testID }: { termination: TurnTermination; testID: string }) {
  return (
    <Text selectable style={styles.terminatedNote} testID={testID}>
      {termination.summary}
    </Text>
  );
}

const styles = StyleSheet.create({
  terminatedNote: {
    color: COLORS.accentOrange,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
  },
});
