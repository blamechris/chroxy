/**
 * Model registry metadata surfaced to clients.
 *
 * Re-exported via ../types (barrel) — see ./index.ts.
 */

/** Default context window size (tokens) used when model metadata doesn't specify one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface ModelInfo {
  id: string;
  label: string;
  fullId: string;
  contextWindow?: number;
}
