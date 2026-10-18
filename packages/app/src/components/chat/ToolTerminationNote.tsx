import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { describeTurnTermination } from '@chroxy/store-core';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';

/** Shared amber notice for tools whose turn ended before a result arrived. */
export function ToolTerminationNote({ reason, testID }: { reason: string; testID: string }) {
  const termination = describeTurnTermination(reason);
  return (
    <View style={styles.note} testID={testID}>
      <Icon name="stop" size={12} color={COLORS.accentOrange}
        accessibilityLabel={termination.label === 'stopped' ? 'stopped' : 'turn terminated'} />
      <Text selectable style={styles.summary}>{termination.summary}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginVertical: 6,
  },
  summary: {
    flex: 1,
    color: COLORS.accentOrange,
    fontSize: 12,
    lineHeight: 18,
  },
});
