/**
 * Shared utility functions for the connection store.
 *
 * Extracted from connection.ts to reduce file size. Contains pure
 * functions with no store dependency — safe to import anywhere.
 *
 * The pure helpers (stripAnsi, nextMessageId, withJitter, filterThinking)
 * live in @chroxy/store-core and are re-exported here for convenience.
 */
import type { SessionState } from './types';
import { createEmptyBaseSessionState } from '@chroxy/store-core';

export {
  stripAnsi,
  nextMessageId,
  withJitter,
  filterThinking,
} from '@chroxy/store-core';

/** Create a fresh empty SessionState */
export function createEmptySessionState(): SessionState {
  return {
    ...createEmptyBaseSessionState(),
    terminalRawBuffer: '',
    selectedFilePath: null,
    thinkingLevel: 'default',
    // #3646: default to `null` (not `undefined`) so the field is always
    // present in the same shape the handler uses to clear it. Prevents
    // tests from having to handle `toBeUndefined()` (initial) vs
    // `toBeNull()` (cleared) for the same field.
    pendingEvaluatorClarify: null,
  };
}

/**
 * #7470 — drop every id in `removedIds` from a session-keyed map, returning a
 * NEW object only when something was actually removed.
 *
 * The same-reference return on a no-op is load-bearing, not an optimisation
 * detail: these maps are read through `useShallow` selectors, and rebuilding
 * them on every `session_list` snapshot (one per session lifecycle event, plus
 * every reconnect) would re-render each consumer for a value that did not
 * change.
 *
 * Inputs are treated as immutable — the source map is never mutated.
 */
export function pruneSessionKeyedMap<T>(
  map: Record<string, T>,
  removedIds: readonly string[],
): Record<string, T> {
  let next: Record<string, T> | null = null;
  for (const id of removedIds) {
    if (!(id in map)) continue;
    if (!next) next = { ...map };
    delete next[id];
  }
  return next ?? map;
}
