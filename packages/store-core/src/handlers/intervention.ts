/**
 * Intervention handlers (audit P2-3 split).
 *
 * Parser for the #4653 `multi_question_intervention` session_event:
 * `handleMultiQuestionIntervention` builds a dedup-by-toolUseId, ring-capped
 * (`MAX_SESSION_INTERVENTIONS`) interventions array, and `applyInterventionBuilder`
 * runs that builder while reporting whether it was the session's first
 * intervention (for the one-time inline notice). State lookup + write stay at
 * the call site.
 *
 * Re-exported from ./index (the barrel) so the public surface is unchanged.
 */

import type { SessionIntervention } from '../types'
import { MAX_SESSION_INTERVENTIONS } from '../utils'
import { resolveSessionId } from './_shared'

// ---------------------------------------------------------------------------
// multi_question_intervention (#4653)
//
// Server fires this event when ClaudeTuiSession's PreToolUse handler sees a
// multi-question AskUserQuestion — i.e. the exact condition the permission-
// hook bash script (#4648) denies on. The dashboard renders a per-session
// counter + a first-time inline notice so the user can tell chroxy intervened
// (rather than wondering why the model is suddenly being polite).
//
// Builder shape (not a flat patch): the new array is computed from the
// existing one — dedup-by-toolUseId so a stuck model re-emitting the same
// multi-q payload doesn't inflate the counter falsely, and ring-cap at
// MAX_SESSION_INTERVENTIONS so long-running sessions don't accumulate memory.
// ---------------------------------------------------------------------------

/** Builder result for handlers whose patch depends on existing intervention state. */
export interface SessionInterventionBuilder {
  /** Session ID the patch targets (may be null if no session context). */
  sessionId: string | null
  /**
   * `true` when this intervention is the FIRST one in this session (the caller
   * uses it to gate a one-time inline notice / system ChatMessage — repeat
   * denials should just bump the counter, not re-spam the chat). Always `false`
   * when the toolUseId duplicates an existing entry (no append happens).
   */
  isFirst: boolean
  /** Apply the builder to the session's current interventions list. */
  applyTo: (current: SessionIntervention[]) => { interventions: SessionIntervention[] }
}

/**
 * Parse a `multi_question_intervention` session_event payload (wire shape
 * `{ toolUseId, questionCount, reason: 'multi_question', timestamp }` — see
 * `ClaudeTuiSession._emitToolHookEvent` in packages/server) and produce a
 * builder that appends a {@link SessionIntervention} entry to the targeted
 * session's `interventions` array.
 *
 * Returns null when the payload is malformed (missing/non-string toolUseId,
 * non-finite questionCount). Callers should leave existing state alone — the
 * counter just doesn't tick, no fallback "unknown intervention" entry is
 * inserted (those would lie about what happened).
 *
 * Dedup-by-toolUseId: the caller's `applyTo` returns the existing array
 * unchanged when an entry with the same `toolUseId` is already present (the
 * known-stuck-model re-emit pattern from #4666 / #4668). When that happens
 * `isFirst` is also false even on the very first event the session sees, so
 * the inline-notice gate stays consistent with what's actually appended.
 *
 * Ring-cap at MAX_SESSION_INTERVENTIONS: when the new array would exceed the
 * cap, the oldest entry is dropped (`.slice(-MAX)` — FIFO).
 */
export function handleMultiQuestionIntervention(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionInterventionBuilder | null {
  const toolUseIdRaw = msg.toolUseId
  if (typeof toolUseIdRaw !== 'string' || toolUseIdRaw.length === 0) return null

  const countRaw = msg.questionCount
  // `questionCount` from the server is always >= 2 (the permission-hook
  // only denies multi-question forms — single-q is the happy path). Mirror
  // the protocol Zod schema (`ServerMultiQuestionInterventionSchema`) here
  // as defence in depth: floor BEFORE the threshold check so 1.9 doesn't
  // sneak past as 1, then drop anything < 2 so a malformed payload doesn't
  // render "0 questions" or "1 question" in the counter UI (both would lie
  // about what happened — the hook only fires for >= 2).
  if (typeof countRaw !== 'number' || !Number.isFinite(countRaw)) {
    return null
  }
  const count = Math.floor(countRaw)
  if (count < 2) return null

  const tsRaw = msg.timestamp
  // Mirror the protocol schema's `timestamp >= 0` bound — epoch 0 is
  // explicitly allowed so a clock-skewed dev environment doesn't bounce
  // the event off the wire. Only fall back to Date.now() when the payload
  // is missing or non-numeric, NOT when timestamp is legitimately 0.
  const timestamp =
    typeof tsRaw === 'number' && Number.isFinite(tsRaw) && tsRaw >= 0
      ? Math.floor(tsRaw)
      : Date.now()

  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    isFirst: false, // recomputed by applyTo based on the current list
    applyTo: (current) => {
      const dup = current.some((iv) => iv.toolUseId === toolUseIdRaw)
      if (dup) {
        // Stuck-model re-emit — return the array unchanged so the counter
        // stays accurate and React's referential-equality skips a re-render.
        return { interventions: current }
      }
      const entry: SessionIntervention = {
        kind: 'multi_question',
        toolUseId: toolUseIdRaw,
        count,
        timestamp,
      }
      const next = [...current, entry]
      // Ring-cap from the OLDEST side — newest entry always stays so the
      // user sees the most recent intervention reflected in the counter.
      const capped = next.length > MAX_SESSION_INTERVENTIONS
        ? next.slice(-MAX_SESSION_INTERVENTIONS)
        : next
      return { interventions: capped }
    },
  }
}

/**
 * #4653 helper — runs the builder against a current array and returns BOTH
 * the new array AND whether this intervention was the session's first (i.e.
 * the previous array was empty AND this call actually appended an entry).
 * Lets the call site gate a one-time inline notice without re-walking the
 * dedup state itself.
 */
export function applyInterventionBuilder(
  builder: SessionInterventionBuilder,
  current: SessionIntervention[],
): { interventions: SessionIntervention[]; isFirst: boolean } {
  const wasEmpty = current.length === 0
  const result = builder.applyTo(current)
  const actuallyAppended = result.interventions.length > current.length
  return {
    interventions: result.interventions,
    isFirst: wasEmpty && actuallyAppended,
  }
}
