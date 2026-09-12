/**
 * Model registry metadata surfaced to clients.
 *
 * Re-exported via ../types (barrel) — see ./index.ts.
 */

import type { ModelProvenance } from '@chroxy/protocol';

export type { ModelProvenance };

/** Default context window size (tokens) used when model metadata doesn't specify one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface ModelInfo {
  id: string;
  label: string;
  fullId: string;
  contextWindow?: number;
  /**
   * How this row got into the server's registry (#7723). Absent means the
   * server did not record one — never assume `manual`.
   */
  provenance?: ModelProvenance;
  /**
   * Reasoning/effort levels this model accepts, verbatim from the provider
   * (#7723). Provider-defined STRINGS, not an enum — codex's app-server
   * declares `reasoningEffort` as a non-empty string and has already shipped
   * six distinct values, so a client must render what it is given.
   */
  reasoningLevels?: string[];
  /** The level the provider applies when a turn names none (#7723). */
  defaultReasoningLevel?: string;
}
