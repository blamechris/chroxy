/**
 * multi-question-form — framework-agnostic state machine for the
 * AskUserQuestion multi-question form (#5800).
 *
 * The dashboard (`packages/dashboard/src/components/QuestionPrompt.tsx`)
 * and the app (`packages/app/src/components/chat/MultiQuestionForm.tsx`)
 * rendered the SAME form state machine twice — only the render primitives
 * (DOM+ARIA vs RN+StyleSheet) differed. This module hoists the shared
 * business logic so an answer-shape change is a one-file edit.
 *
 * store-core has no `react` dependency (and must not gain one), so this
 * exports PURE helpers rather than a React hook. Each client keeps its
 * own tiny `useState` for `singleSelectByIdx` / `multiSelectByIdx` and
 * delegates the per-question selection state shape, the answersMap
 * builder, and the submit-enabled validation here.
 *
 * State is indexed by question POSITION so two questions with identical
 * text track their selections independently while the form is open. The
 * emitted `answersMap` is keyed by `question.question` TEXT — the wire
 * shape `UserQuestionResponseSchema` /
 * `PermissionManager.respondToQuestion` consume. If a payload ever
 * carried two questions with the exact same text the later one overwrites
 * the earlier in the emitted map; that is an inherent constraint of the
 * question-text-keyed wire contract, not a client-specific one.
 */
import type { ChatMessageQuestion } from './types'

/**
 * #4735 — per-question answer payload emitted by the multi-question form.
 * Values are either a string (single-select chosen value, free-form
 * "Other" text) or a string[] (multi-select chosen values). The wire
 * schema (`UserQuestionResponseSchema`) and server consumers
 * (`PermissionManager.respondToQuestion`, `ClaudeTuiSession`) accept both
 * shapes; the native form (string[] for multi-select) is preferred.
 */
export type MultiQuestionAnswersMap = Record<string, string | string[]>

/**
 * Per-question selection state, indexed by question POSITION. Single-select
 * holds the chosen value string; multi-select holds an array of chosen
 * value strings. Mirrors the `singleSelectByIdx` / `multiSelectByIdx`
 * `useState` pair both clients carried inline.
 */
export interface MultiQuestionFormState {
  singleSelectByIdx: Record<number, string>
  multiSelectByIdx: Record<number, string[]>
}

/**
 * Toggle a multi-select value for one question, returning the next
 * `multiSelectByIdx` map (immutable update — safe to hand straight to a
 * `setState` updater). Adds the value if absent, removes it if present.
 */
export function toggleMultiSelect(
  prev: Record<number, string[]>,
  idx: number,
  value: string,
): Record<number, string[]> {
  const curr = prev[idx] ?? []
  const next = curr.includes(value)
    ? curr.filter((v) => v !== value)
    : [...curr, value]
  return { ...prev, [idx]: next }
}

/**
 * Set the single-select chosen value for one question, returning the next
 * `singleSelectByIdx` map (immutable update).
 */
export function setSingleSelect(
  prev: Record<number, string>,
  idx: number,
  value: string,
): Record<number, string> {
  return { ...prev, [idx]: value }
}

/**
 * Build the wire `answersMap` from the current selection state. Multi-select
 * questions emit a native `string[]` (defaulting to `[]` so a multi-select
 * question always has an entry — the SDK accepts zero selections);
 * single-select questions emit the chosen string, and are omitted entirely
 * when unanswered. Keyed by `question.question` text.
 */
export function buildAnswersMap(
  questions: ChatMessageQuestion[],
  state: MultiQuestionFormState,
): MultiQuestionAnswersMap {
  const answersMap: MultiQuestionAnswersMap = {}
  questions.forEach((q, idx) => {
    if (q.multiSelect) {
      answersMap[q.question] = state.multiSelectByIdx[idx] ?? []
    } else {
      const chosen = state.singleSelectByIdx[idx]
      if (chosen != null) answersMap[q.question] = chosen
    }
  })
  return answersMap
}

/**
 * Submit is enabled only when every single-select question has a choice.
 * Multi-select questions are always allowed to be empty (the SDK accepts
 * zero selections for multi-select).
 */
export function computeCanSubmit(
  questions: ChatMessageQuestion[],
  state: MultiQuestionFormState,
): boolean {
  return questions.every((q, idx) => {
    if (q.multiSelect) return true
    return state.singleSelectByIdx[idx] != null
  })
}

/**
 * #5800 — the single shared shape predicate for "this is a single-question
 * multiSelect AskUserQuestion that should render as a checkbox form".
 * Computed independently before in both renderers
 * (`QuestionPrompt.tsx` and the app's `MessageBubble.tsx`).
 */
export function isSingleMultiSelectForm(
  questions: ChatMessageQuestion[] | undefined,
): boolean {
  return (
    Array.isArray(questions) &&
    questions.length === 1 &&
    questions[0]?.multiSelect === true
  )
}
