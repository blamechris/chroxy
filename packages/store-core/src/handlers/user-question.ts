/**
 * User-question + user-input handlers (audit P2-3 split).
 *
 * Parsers for the interactive-prompt wire events: `user_question` (Claude's
 * multiple-choice AskUserQuestion form — `handleUserQuestion` normalises the
 * questions, dedups + appends the #3746 "Other" free-text sentinel, and
 * pre-builds the `prompt`-typed ChatMessage) and `user_input` (the #2902
 * cross-client live echo — `handleUserInput`). Dispatch + notifications stay at
 * the call site.
 *
 * Re-exported from ./index (the barrel) so the public surface is unchanged.
 */

import type { ChatMessage } from '../types'
import { nextMessageId } from '../utils'
import { parseUserInputMessage } from '../user-input-handler'

// ---------------------------------------------------------------------------
// user_question
//
// Server forwards a `user_question` event when Claude wants to prompt the
// user with multiple-choice options. The shared handler validates the
// message shape and pre-builds the `prompt`-typed ChatMessage, the resolved
// session ID for routing, and the truncated notification text.
//
// Side-effects (dispatching the chat message, calling
// `pushSessionNotification`) stay at the call site.
// ---------------------------------------------------------------------------

/**
 * Sentinel `value` appended to the option list of every multi-choice
 * `user_question` (#3746). Renderers detect this value and swap their
 * option buttons for a free-text input so the user can always supply a
 * custom answer outside the model-provided choices — matching the
 * upstream `AskUserQuestion` tool contract.
 *
 * Only appended when at least one real option was provided; questions
 * with zero options keep their free-text-only rendering.
 */
export const OTHER_OPTION_VALUE = '__chroxy_other__'
export const OTHER_OPTION_LABEL = 'Other'

export interface UserQuestionPayload {
  /**
   * Resolved session for the question. Falls back to the active session
   * when the message omits an explicit `sessionId`. May be `null` when both
   * sources are empty (caller routes the chat message to the global log).
   */
  sessionId: string | null
  /**
   * Pre-built `prompt`-typed ChatMessage. The caller dispatches it to the
   * resolved session (or the global log) without further transformation.
   */
  chatMessage: ChatMessage
  /**
   * The first 60 characters of the question text — used by the caller for
   * the `pushSessionNotification` body.
   */
  questionText: string
}

/**
 * Validate and normalize a `user_question` message.
 *
 * Returns `null` when the message is malformed:
 * - `msg.questions` missing, not an array, or empty
 * - first `questions[0]` not a non-null object
 * - `q.question` not a string
 *
 * Otherwise returns:
 * - `sessionId`: `msg.sessionId` when a non-empty string, else `activeSessionId`.
 *   Non-string `msg.sessionId` falls through to `activeSessionId`.
 * - `chatMessage`: `prompt`-typed with a fresh `nextMessageId('question')`,
 *   `content` = `q.question`, `toolUseId` populated only when `msg.toolUseId`
 *   is a string (otherwise omitted), and `options` filtered to objects with
 *   a string `label` (mapped to `{label, value}` where `value === label`).
 *   Missing/non-array `q.options` yields `[]`.
 * - `questionText`: `q.question.slice(0, 60)`.
 *
 * Each non-`questions` field is validated at runtime so the returned payload
 * matches its declared TypeScript types regardless of what the server sends.
 */
export function handleUserQuestion(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): UserQuestionPayload | null {
  const questions = msg.questions as unknown[]
  if (!Array.isArray(questions) || questions.length === 0) return null
  const q = questions[0] as Record<string, unknown>
  if (!q || typeof q !== 'object' || typeof q.question !== 'string') return null

  /**
   * #4604 Chunk B — shared per-question normalization. Same dedup +
   * Other-sentinel logic the original single-question path applied,
   * pulled into a closure so every entry in the multi-question payload
   * gets it. Returns `null` for malformed entries so the caller can
   * skip them without poisoning the rest of the form.
   */
  const normalizeQuestion = (rawQ: unknown): {
    question: string
    options: { label: string; value: string }[]
    multiSelect?: boolean
  } | null => {
    if (!rawQ || typeof rawQ !== 'object') return null
    const qq = rawQ as Record<string, unknown>
    if (typeof qq.question !== 'string') return null
    const rawOptions = Array.isArray(qq.options)
      ? (qq.options as unknown[])
          .filter(
            (o: unknown): o is { label: string } =>
              !!o &&
              typeof o === 'object' &&
              typeof (o as Record<string, unknown>).label === 'string',
          )
          .map((o: { label: string }) => ({ label: o.label, value: o.label }))
      : []
    // #3752: dedup against the synthetic sentinel BEFORE appending it.
    const baseOptions = rawOptions.filter(
      (o) => o.label !== OTHER_OPTION_LABEL && o.value !== OTHER_OPTION_VALUE,
    )
    const modelSuppliedOther = rawOptions.find((o) => o.label === OTHER_OPTION_LABEL)
    const hasUsableOptions = baseOptions.length > 0 || modelSuppliedOther != null
    // #4604 Chunk B: only append the Other sentinel for single-select
    // questions. Multi-select questions render as checkboxes and the
    // free-text escape hatch doesn't compose cleanly with that UI;
    // multi-select forms produced by claude SDK never include a
    // free-text fallback anyway.
    const isMultiSelect = qq.multiSelect === true
    const options = !hasUsableOptions
      ? []
      : isMultiSelect
        ? baseOptions
        : modelSuppliedOther
          ? [...baseOptions, modelSuppliedOther]
          : [...baseOptions, { label: OTHER_OPTION_LABEL, value: OTHER_OPTION_VALUE }]
    const out: { question: string; options: { label: string; value: string }[]; multiSelect?: boolean } = {
      question: qq.question as string,
      options,
    }
    if (isMultiSelect) out.multiSelect = true
    return out
  }

  // Normalize every question. Drop malformed entries (return null from
  // normalizeQuestion); if the first question is dropped, fail closed
  // — that's the legacy null-return shape the call site already handles.
  const normalizedAll = (questions as unknown[]).map(normalizeQuestion).filter(
    (v): v is { question: string; options: { label: string; value: string }[]; multiSelect?: boolean } => v != null,
  )
  // The top-level `options` mirrors q[0].options exactly (legacy
  // contract — every existing test pin still applies). Multi-question
  // renderers iterate `chatMessage.questions` instead.
  const [firstNormalized] = normalizedAll
  if (firstNormalized == null) return null
  const questionContent = firstNormalized.question
  const options = firstNormalized.options
  // #4613 — honour the wire `timestamp` field when present (number). Mirrors
  // the #4607 fix for handleToolStart. The server's history ring buffer
  // stamps `timestamp: Date.now()` at append time
  // (session-message-history.js:208-216) and forwards it on every replay —
  // question events are part of that ring buffer. Pre-#4613 we always
  // overwrote with `Date.now()`, so a question prompt that originally fired
  // at 10:00 showed as "just now" if the user tabbed away and the dashboard
  // rebuilt the prompt ChatMessage during history_replay. Lower-impact than
  // #4607 (affects bubble display only, not the timer pill), but still a
  // correctness bug. The fallback to `Date.now()` covers live (non-replay)
  // user_question broadcasts, which never carry `msg.timestamp` on the wire.
  const wireTimestamp =
    typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
      ? msg.timestamp
      : Date.now()
  const chatMessage: ChatMessage = {
    id: nextMessageId('question'),
    type: 'prompt',
    content: questionContent,
    options,
    // #4604 Chunk B: always populate `questions` (a single-question form
    // is just an N=1 case of the multi-question shape). Renderers can
    // detect multi-question by `questions.length > 1` and switch UI.
    questions: normalizedAll,
    timestamp: wireTimestamp,
  }
  if (typeof msg.toolUseId === 'string') {
    chatMessage.toolUseId = msg.toolUseId
  }
  const msgSessionId =
    typeof msg.sessionId === 'string' && msg.sessionId.length > 0
      ? msg.sessionId
      : null
  const sessionId = msgSessionId ?? activeSessionId
  const questionText = questionContent.slice(0, 60)
  return { sessionId, chatMessage, questionText }
}

// ---------------------------------------------------------------------------
// user_input
//
// Server broadcasts `user_input` to all OTHER clients when someone sends a
// message. Both the app and dashboard render it identically; the dashboard
// additionally writes the prompt to the terminal buffer (handled at the call
// site via the returned `content` field).
// ---------------------------------------------------------------------------

export interface UserInputPayload {
  /** Resolved session for the user_input. */
  sessionId: string
  /**
   * Pre-built `user_input`-typed ChatMessage. Adopts the server's stable
   * `messageId` when present so a later replay of the same entry dedups by
   * id against this live-echo copy (#2902).
   */
  chatMessage: ChatMessage
  /**
   * Original user prompt content. The dashboard uses this to write the
   * terminal buffer (`appendTerminalData`). The app ignores it.
   */
  content: string
}

/**
 * Validate a `user_input` message and build the renderable ChatMessage.
 *
 * Returns `null` when `parseUserInputMessage` returns null — i.e. when the
 * message originated from this client (already shown via optimistic UI) or
 * when no target session can be resolved.
 */
export function handleUserInput(
  msg: Record<string, unknown>,
  myClientId: string | null,
  activeSessionId: string | null,
): UserInputPayload | null {
  const parsed = parseUserInputMessage(msg, myClientId, activeSessionId)
  if (!parsed) return null
  const { sessionId: parsedSessionId, ...parsedMsg } = parsed
  const stableId = typeof msg.messageId === 'string' ? msg.messageId : undefined
  const chatMessage: ChatMessage = {
    id: stableId || nextMessageId('user_input'),
    ...parsedMsg,
  }
  return {
    sessionId: parsedSessionId,
    chatMessage,
    content: parsed.content,
  }
}
