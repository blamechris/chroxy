/**
 * selectChatMessages — which messages reach the Chat tab.
 *
 * Extracted from SessionScreen's inline `useMemo` (#7201) so the two invariants
 * below are pinned by behavioural tests rather than by reading the source. Both
 * were previously verified only by hand on a booted simulator, which does not
 * survive a refactor.
 *
 * INVARIANT 1 — compaction markers survive, compact mode included.
 *
 *   A compaction boundary is positional: it means "context was dropped HERE",
 *   between these two turns. ChatView reinserts the compactMetadata-carrying
 *   subset inline via insertCompactionMarkers, and that reinsertion reads the
 *   same array this function returns — so dropping markers here makes the
 *   reinsertion dead code and the marker unreachable in the chat flow (#7186,
 *   which is exactly what happened).
 *
 *   The `system` branch returns BEFORE the compact-mode check on purpose.
 *   Compact mode hides tool_use/thinking only (isHiddenInCompactMode is the
 *   shared definition, buildChatViewMessages.ts), and a compaction boundary is
 *   neither. Reordering these two checks would silently start hiding markers
 *   whenever compact mode is on.
 *
 * INVARIANT 2 — every other `system` message is excluded.
 *
 *   They belong on the System tab, which mobile does have
 *   (SessionScreen's `viewMode === 'system'`). `systemMessages` is derived
 *   separately from the unfiltered list, so markers appear there too.
 */
import type { ChatMessage } from '../store/connection';

export interface SelectChatMessagesOptions {
  /** Compact-mode toggle state. */
  chatFilterCompact: boolean;
  /** Shared predicate for what compact mode hides (tool_use / thinking). */
  isHiddenInCompactMode: (type: ChatMessage['type']) => boolean;
}

/** True when `m` belongs on the Chat tab. */
export function shouldShowInChat(
  m: ChatMessage,
  { chatFilterCompact, isHiddenInCompactMode }: SelectChatMessagesOptions,
): boolean {
  // Markers pass regardless of compact mode; every other system event is the
  // System tab's. This branch MUST stay above the compact check — see
  // INVARIANT 1.
  if (m.type === 'system') return m.compactMetadata != null;
  if (chatFilterCompact && isHiddenInCompactMode(m.type)) return false;
  return true;
}

/** Filter a session's messages down to the Chat tab's set. */
export function selectChatMessages(
  messages: ChatMessage[],
  options: SelectChatMessagesOptions,
): ChatMessage[] {
  return messages.filter((m) => shouldShowInChat(m, options));
}
