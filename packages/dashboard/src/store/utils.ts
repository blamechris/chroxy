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
