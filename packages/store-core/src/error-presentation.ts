/**
 * Canonical error-presentation registry (chat redesign epic #6389, Phase 2 #6392).
 *
 * The dashboard chat stream renders an inline "chip" for recoverable error
 * messages — a stalled stream, an AskUserQuestion delivery that failed, a
 * conversation that couldn't be resumed — instead of a bare red bubble. Today
 * each chip hard-codes its own headline copy + ARIA role, so the error taxonomy
 * is scattered across StreamStallChip / AskUserQuestionStallChip /
 * ResumeUnknownChip. This module defines that mapping ONCE — pure data, no DOM /
 * React Native deps — the same way {@link ./tool-presentation} centralised
 * tool-card presentation. A forthcoming single `ChatErrorFrame` (and a mobile
 * twin) consume it so the two surfaces can't drift, and a new recoverable error
 * code becomes a one-line addition here.
 *
 * `code` is the optional free-form `ChatMessage.code`, mirroring the server's
 * error wire message. The AskUserQuestion family is matched via the existing
 * single-source-of-truth predicate ({@link isRetryableAskUserQuestionError})
 * rather than re-listing its six codes here.
 */

import { isRetryableAskUserQuestionError } from './ask-user-question-errors'

/** Coarse classification of a recoverable chat error by what it represents.
 *  `generic` is the catch-all for an unrecognised / missing error code. */
export type ErrorKind = 'stall' | 'question' | 'resume' | 'generic'

export interface ErrorPresentation {
  kind: ErrorKind
  /** ARIA live politeness: `status` (polite) for recoverable / auto-handled
   *  errors, `alert` (assertive) for terminal ones the user must act on. */
  role: 'status' | 'alert'
  /** Default human-facing headline. Consumers may override for the dynamic
   *  cases (e.g. the stall chip's "No response for 30s — retry?"). */
  headline: string
}

/** Per-code presentation. The AskUserQuestion teardown family (six codes, #5793)
 *  is matched via {@link isRetryableAskUserQuestionError}, not listed here, so a
 *  new code lights up in one place. */
const PRESENTATION_BY_CODE: Readonly<Record<string, ErrorPresentation>> = {
  // Server emits this after the configured stream-inactivity window (#4475).
  stream_stall: {
    kind: 'stall',
    role: 'status',
    headline: 'Stream stalled — retry?',
  },
  // CliSession already auto-fell-back to a fresh conversation (#4944) — polite.
  resume_unknown: {
    kind: 'resume',
    role: 'status',
    headline: 'Previous conversation could not be resumed — starting fresh',
  },
  // Auto-respawn gave up (#5004) — terminal, the user must act, so assertive.
  resume_unknown_exhausted: {
    kind: 'resume',
    role: 'alert',
    headline: 'Auto-recovery exhausted — start a new session manually to continue',
  },
}

/** Shared presentation for the AskUserQuestion teardown family (#5793) — the
 *  prompt is dead but the user can recover by resending their request. */
const QUESTION_PRESENTATION: ErrorPresentation = {
  kind: 'question',
  role: 'status',
  headline: 'Question delivery failed — retry?',
}

/** Catch-all for an unrecognised / missing code — an unexpected error the user
 *  should notice. Consumers typically show the raw server text as well. */
const GENERIC_PRESENTATION: ErrorPresentation = {
  kind: 'generic',
  role: 'alert',
  headline: 'Something went wrong',
}

/** Presentation descriptor for a chat error `code`: kind + ARIA role + a default
 *  headline. The AskUserQuestion family is matched via the shared predicate; any
 *  unrecognised / missing code falls back to `generic` — never throws. */
export function getErrorPresentation(
  code: string | null | undefined,
): ErrorPresentation {
  if (!code) return GENERIC_PRESENTATION
  if (isRetryableAskUserQuestionError(code)) return QUESTION_PRESENTATION
  return PRESENTATION_BY_CODE[code] ?? GENERIC_PRESENTATION
}
