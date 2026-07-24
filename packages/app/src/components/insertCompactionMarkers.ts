/**
 * insertCompactionMarkers — #6972 mobile parity for the dashboard's
 * CompactionMarker (#6768/#6970).
 *
 * The shared `buildChatViewMessages` pipeline (`@chroxy/store-core`)
 * unconditionally filters `type: 'system'` messages off the Chat-tab
 * derivation for BOTH the dashboard and mobile — see its own doc comment:
 * "System events render on the System tab." That's correct for the
 * dashboard, which has a dedicated System tab to show them on instead. The
 * mobile app has no equivalent surface (its dual-view is Chat/Terminal
 * only), so leaving that filter as the final word makes a `compact_
 * boundary` marker invisible on mobile entirely — worse than the
 * pre-#6970 plain-text fallback it was meant to replace.
 *
 * Deliberate placement decision (#6972 acceptance criterion — "not just
 * copy-pasted from dashboard's System-tab convention"): mobile reinserts
 * ONLY the subset of system messages carrying `compactMetadata` back into
 * the Chat-tab display list, positioned by original timestamp, as their
 * own single-row group rendered by `CompactionMarker`. Every OTHER system
 * message (a stray `evaluator`/`mcpPromptExpansion`/generic system
 * chatter) still has no mobile renderer and stays hidden — this is scoped
 * strictly to the one field this issue is chartered to surface, not a
 * blanket un-filter of `buildChatViewMessages`. Widening the shared
 * filter itself was considered and rejected: `useMessageRenderer` on the
 * dashboard is shared across its Chat AND System tabs, so un-filtering at
 * the store-core layer would make the marker render TWICE there.
 *
 * Pure and React-free so it's unit-testable without mounting a component;
 * `ChatView.tsx` wraps the call in `useMemo`, keyed off the same
 * `displayGroups` + `messages` it already recomputes on.
 */
import type { DisplayGroup } from '@chroxy/store-core';
import type { ChatMessage } from '../store/connection';

function groupTimestamp(group: DisplayGroup): number {
  if (group.type === 'single') return group.message.timestamp;
  return group.messages[0]?.timestamp ?? 0;
}

export function insertCompactionMarkers(
  displayGroups: DisplayGroup[],
  messages: ChatMessage[],
): DisplayGroup[] {
  const markers = messages.filter(
    (m) => m.type === 'system' && m.compactMetadata != null,
  );
  if (markers.length === 0) return displayGroups;

  const merged = [...displayGroups];
  for (const marker of markers) {
    let insertAt = merged.length;
    for (let i = 0; i < merged.length; i++) {
      if (groupTimestamp(merged[i]) > marker.timestamp) {
        insertAt = i;
        break;
      }
    }
    merged.splice(insertAt, 0, { type: 'single', message: marker });
  }
  return merged;
}
