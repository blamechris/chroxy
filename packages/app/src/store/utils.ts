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
    activityState: { state: 'idle', startedAt: Date.now() },
  };
}

/**
 * #4761 — pretty-print a single multi-question answer value:
 *  - `string[]`   → comma-joined labels (native #4621 path).
 *  - `'[...]'`    → parsed as JSON; if it's an array, joined; else returned as-is.
 *  - anything else → returned unchanged.
 *
 * Mirrors the dashboard's helper in
 * `packages/dashboard/src/utils/questionAnswerSummary.ts` (#4622 / #4735)
 * so multi-question answers render consistently across clients in the
 * server-side terminal echo.
 */
function formatAnswerValue(value: string | string[]): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  // Cheap pre-check to avoid JSON.parse-ing every short-string answer.
  if (!value.startsWith('[')) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!Array.isArray(parsed)) return value;
  return parsed.map((item) => String(item)).join(', ');
}

/**
 * #4761 — turn a multi-question answers map into a single human-readable
 * line for the wire `answer` summary field. Mirrors the dashboard helper
 * (#4622 / #4735); see `packages/dashboard/src/utils/questionAnswerSummary.ts`.
 *
 * Output format: `Q1: A1 | Q2: A2, A3 | Q3: A4`.
 *
 * The string-only `answer` field is required by `UserQuestionResponseSchema`
 * so even multi-question payloads must populate it — older servers that
 * only read `answer` fall through to a default-to-option-1 path if the
 * field is empty, which stalls the form.
 */
export function formatQuestionAnswerSummary(
  answer: string | Record<string, string | string[]>,
): string {
  if (typeof answer === 'string') return answer;
  return Object.entries(answer)
    .map(([question, value]) => `${question}: ${formatAnswerValue(value)}`)
    .join(' | ');
}
