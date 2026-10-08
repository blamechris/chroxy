/**
 * TurnOutcomeMarker -- #7326 (mobile counterpart of the dashboard's
 * packages/dashboard/src/components/TurnOutcomeMarker.tsx).
 *
 * The chip at the end of a turn that did not complete normally: the reply was
 * cut off by a limit (`truncated`), the model declined (`refused`), or the turn
 * was `stopped`. Before #7326 all three rendered exactly like a finished turn.
 *
 * Built from the `result` frame by store-core's `appendTurnOutcomeMarker` and
 * worded by `describeTurnOutcome`, the SAME helpers the dashboard uses, so the
 * two clients cannot say different things. Rendered inline in the Chat feed by
 * ChatView (the message is a `type: 'system'` row, which `shouldShowInChat` lets
 * through for this one field). Non-interactive, so the 44pt tap floor does not
 * apply.
 */
import { StyleSheet, Text, View } from 'react-native';
import { describeTurnOutcome, TURN_OUTCOME_MARKER_TESTID } from '@chroxy/store-core';
import type { MarkedTurnOutcome } from '@chroxy/store-core';
import { COLORS } from '../constants/colors';

export interface TurnOutcomeMarkerProps {
  outcome: MarkedTurnOutcome;
}

const ICON: Record<MarkedTurnOutcome, string> = {
  truncated: '✂',
  refused: '⊘',
  stopped: '■',
};

export function TurnOutcomeMarker({ outcome }: TurnOutcomeMarkerProps) {
  const description = describeTurnOutcome(outcome);
  if (!description) return null;
  const tone = outcome === 'truncated' ? styles.truncated : outcome === 'refused' ? styles.refused : styles.stopped;
  return (
    <View
      testID={TURN_OUTCOME_MARKER_TESTID}
      accessibilityRole="text"
      accessibilityLabel={`${description.label}. ${description.detail}`}
      style={[styles.container, tone]}
    >
      <Text style={styles.icon} accessibilityElementsHidden importantForAccessibility="no">
        {ICON[outcome]}
      </Text>
      <Text testID={`${TURN_OUTCOME_MARKER_TESTID}-label`} style={styles.text}>
        {description.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  stopped: {
    borderColor: COLORS.accentGrayBorder,
    backgroundColor: COLORS.accentGrayLight,
  },
  truncated: {
    borderColor: COLORS.accentOrangeBorder,
    backgroundColor: COLORS.accentOrangeLight,
  },
  refused: {
    borderColor: COLORS.accentRedBorder,
    backgroundColor: COLORS.accentRedLight,
  },
  icon: {
    fontSize: 12,
    lineHeight: 16,
    color: COLORS.textDim,
  },
  text: {
    fontSize: 11,
    lineHeight: 16,
    color: COLORS.textDim,
  },
});
