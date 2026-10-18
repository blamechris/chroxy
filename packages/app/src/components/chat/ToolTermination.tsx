import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { describeTurnTermination } from '@chroxy/store-core';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';

type Termination = ReturnType<typeof describeTurnTermination>;

/**
 * #7376: a tool cut off because its TURN was terminated underneath it
 * (permission-mode switch, Stop, crash, watchdog) never reported a result. The
 * single place the mobile app decides a tool is "terminated" -- shared by
 * ActivityGroup, ToolBubble and ToolDetailModal so wording and styling cannot
 * drift. Returns null until the result has landed.
 */
export function resolveToolTermination(hasResult: boolean, reason?: string): Termination | null {
  return hasResult && reason ? describeTurnTermination(reason) : null;
}

/** Amber stop icon; wins over the red failed-tool icon. */
export function TerminatedIcon({ termination, iconTestID }: { termination: Termination; iconTestID: string }) {
  return (
    <Icon
      name="stop"
      size={12}
      color={COLORS.accentOrange}
      testID={iconTestID}
      accessibilityLabel={termination.label === 'stopped' ? 'stopped' : 'turn terminated'}
    />
  );
}

/** The "check whether it took effect before retrying" sentence, in amber. */
export function TerminatedNote({ termination }: { termination: Termination }) {
  return <Text selectable style={styles.note}>{termination.summary}</Text>;
}

const styles = StyleSheet.create({
  note: {
    color: COLORS.accentOrange,
    fontSize: 12,
    marginTop: 6,
    lineHeight: 18,
  },
});
