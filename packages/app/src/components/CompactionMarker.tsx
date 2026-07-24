/**
 * CompactionMarker — #6972 (mobile parity for the dashboard's
 * packages/dashboard/src/components/CompactionMarker.tsx, #6768/#6970).
 *
 * Distinct "Context compacted" divider for a `compact_boundary` SDK/CLI
 * system event (see store-core `ChatMessage.compactMetadata`). Renders in
 * place of the generic muted system bubble that would otherwise show only
 * the improved-but-plain fallback `content` string (e.g. "Context
 * compacted (auto): 128,000 → 12,000 tokens") — same class of upgrade
 * #6768 gave the dashboard.
 *
 * Placement (#6972 acceptance criterion — deliberate, not copy-pasted from
 * the dashboard's System-tab convention): the dashboard shows this on a
 * dedicated System tab because its shared `buildChatViewMessages` pipeline
 * (`@chroxy/store-core`) filters `type: 'system'` off the Chat tab
 * entirely. Mobile has no System-tab equivalent (dual-view is Chat/
 * Terminal only), so `ChatView.tsx` reinserts compaction-marker messages
 * back into the Chat feed inline via `insertCompactionMarkers` — this
 * component is that inline row, not a System-tab card.
 *
 * Deliberately non-interactive (mirrors the dashboard) — a compaction
 * boundary is informational. `preTokens`/`postTokens`/`durationMs` are
 * `null`, not absent, when the SDK/CLI itself omitted that sub-field
 * (store-core's `CompactBoundaryMeta` gives renderers a stable shape); the
 * `formatTokens` guard below renders `?` instead of the literal string
 * "null", and the duration/token clauses are omitted entirely rather than
 * printing "NaN" when their value is null.
 */
import { StyleSheet, Text, View } from 'react-native';
import { formatDurationTerse } from '@chroxy/store-core';
import type { CompactBoundaryMeta } from '@chroxy/store-core';
import { COLORS } from '../constants/colors';

export interface CompactionMarkerProps {
  meta: CompactBoundaryMeta;
}

function formatTokens(n: number | null): string {
  return n == null ? '?' : n.toLocaleString();
}

export function CompactionMarker({ meta }: CompactionMarkerProps) {
  const hasTokens = meta.preTokens != null || meta.postTokens != null;
  const triggerLabel = meta.trigger === 'manual' ? 'manual' : 'auto';

  return (
    <View testID="compaction-marker" style={styles.container}>
      <Text
        style={styles.icon}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        ⊙
      </Text>
      <Text style={styles.text} selectable>
        <Text>Context compacted</Text>
        {hasTokens && (
          <Text testID="compaction-marker-tokens">
            {` · ${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens)} tokens`}
          </Text>
        )}
        {meta.durationMs != null && (
          <Text testID="compaction-marker-duration">
            {` · ${formatDurationTerse(meta.durationMs)}`}
          </Text>
        )}
        <Text testID="compaction-marker-trigger">{` · ${triggerLabel}`}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    alignSelf: 'stretch',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginVertical: 4,
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentGrayBorder,
    backgroundColor: COLORS.accentGrayLight,
  },
  icon: {
    fontSize: 12,
    lineHeight: 16,
    color: COLORS.textDim,
  },
  text: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    color: COLORS.textDim,
  },
});
