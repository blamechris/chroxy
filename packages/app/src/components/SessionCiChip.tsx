import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ServerSessionPrStatusMessage } from '@chroxy/protocol';
import { describeNoPrStatus, formatChecks, formatMergeState } from '@chroxy/store-core';
import { COLORS } from '../constants/colors';

interface Props {
  status: ServerSessionPrStatusMessage | null;
  onRefresh: () => void;
  disabled?: boolean;
}

/** Session-scoped PR/CI state, with reasons readable on touch screens. */
export function SessionCiChip({ status, onRefresh, disabled = false }: Props) {
  if (!status) return null;
  const noPr = !status.pr ? describeNoPrStatus(status) : null;
  const merge = formatMergeState(status.merge);
  const url = status.pr?.url;
  const navigable = typeof url === 'string' && /^https?:\/\//i.test(url);
  return (
    <View style={styles.chip} testID="session-ci-chip">
      {status.pr && (navigable ? (
        <TouchableOpacity style={styles.control} accessibilityRole="link" accessibilityLabel={`Open pull request #${status.pr.number} on GitHub`} onPress={() => void Linking.openURL(url!).catch(() => {})}>
          <Text style={styles.link}>#{status.pr.number}</Text>
        </TouchableOpacity>
      ) : <Text style={styles.label}>#{status.pr.number}</Text>)}
      {status.pr?.isDraft && <Text style={styles.label}>draft</Text>}
      <Text style={styles.label} testID="session-ci-chip-checks">{noPr?.label ?? formatChecks(status.checks)}</Text>
      {status.pr && merge && <Text style={styles.label} testID="session-ci-chip-merge">{merge}</Text>}
      {noPr?.reason != null && <Text style={styles.reason} testID="session-ci-chip-reason">{noPr.reason}</Text>}
      <TouchableOpacity style={styles.control} testID="session-ci-chip-refresh" accessibilityRole="button" accessibilityLabel="Refresh pull-request and CI status" disabled={disabled} onPress={onRefresh}>
        <Text style={styles.label}>↻</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginHorizontal: 12, marginBottom: 4, paddingHorizontal: 8, borderWidth: 1, borderColor: COLORS.borderPrimary, borderRadius: 8 },
  control: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  label: { color: COLORS.textSecondary, fontSize: 12 },
  link: { color: COLORS.accentBlue, fontSize: 12 },
  reason: { color: COLORS.textMuted, fontSize: 12, flexShrink: 1 },
});
