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

import type { ChatMessage, ChatMessageQuestion } from '../types'
import { nextMessageId } from '../utils'
import { parseUserInputMessage } from '../user-input-handler'
import {
  QUESTION_INTERRUPTED_PLACEHOLDER,
  QUESTION_SUPERSEDED_PLACEHOLDER,
  QUESTION_NOT_DELIVERED_PLACEHOLDER,
  REPLAY_RESOLVED_PLACEHOLDER,
  isQuestionNoAnswerToken,
} from '../replay-reconcile'

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
 * #4604 Chunk B — shared per-question normalization. Same dedup +
 * Other-sentinel logic the original single-question path applied,
 * pulled out to module level so every entry in the multi-question payload
 * gets it, and so a client can normalize a raw AskUserQuestion `tool_input`
 * (e.g. the dashboard's permission card, #8264) with exactly the rules the
 * question card itself uses. Returns `null` for malformed entries so the
 * caller can skip them without poisoning the rest of the form.
 */
export function normalizeUserQuestion(rawQ: unknown): ChatMessageQuestion | null {
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

  // Normalize every question. Drop malformed entries (return null from
  // normalizeUserQuestion); if the first question is dropped, fail closed
  // — that's the legacy null-return shape the call site already handles.
  const normalizedAll = (questions as unknown[]).map(normalizeUserQuestion).filter(
    (v): v is ChatMessageQuestion => v != null,
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
  // #8336: a question the daemon cut off (its tool was in flight at shutdown)
  // arrives replayed with `interrupted: true`. Build it already marked, so
  // `history_replay_end`'s sweep (which only stamps an UNanswered prompt) never
  // calls it "(resolved)". Strict `=== true`: anything else is an ordinary
  // question, and a pending or answered one never carries the field.
  if (msg.interrupted === true) {
    chatMessage.answered = QUESTION_INTERRUPTED_PLACEHOLDER
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
// A question that ended with no answer (#8470)
//
// Two server signals end a card without anyone having answered it:
//   - `permission_resolved { toolUseId, reason: 'superseded' }`, broadcast to the
//     session: a newer question replaced this one, so it is no longer waiting.
//   - `error { code: 'QUESTION_NOT_DELIVERED', toolUseId }`, sent to the ANSWERING
//     client only: it marked the card answered when it sent, and the server says
//     the answer reached nothing.
// Both clients apply them through `markQuestionEnded`, and render the result
// through `questionEndedNotice`, so the two cannot disagree on either.
// ---------------------------------------------------------------------------

/** The `error` frame code the server sends when it drops a question answer. */
export const QUESTION_NOT_DELIVERED_CODE = 'QUESTION_NOT_DELIVERED'

/**
 * Parse a `QUESTION_NOT_DELIVERED` error frame: the question id the answer was
 * for, or `null` when the frame is not that error or carries no id.
 */
export function handleQuestionNotDelivered(
  msg: Record<string, unknown>,
): { toolUseId: string } | null {
  if (msg.code !== QUESTION_NOT_DELIVERED_CODE) return null
  const toolUseId = msg.toolUseId
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return null
  return { toolUseId }
}

/**
 * End a question card without an answer. Returns a new messages array, or `null`
 * when no card changed (no such question, or the card already says something
 * truer), so a caller writes the store only on a change.
 *
 *   - `superseded`: only a card still waiting (no `answered`, or the replay
 *     sweep's '(resolved)') changes. A card that holds a real answer keeps it: the
 *     person did answer it; and one already ended keeps its first reason.
 *   - `notDelivered`: the card DOES hold an answer (the client marked it on send);
 *     that is the thing being retracted. Cleared with it: `answeredAt` and the
 *     structured `answeredAnswers`, which would otherwise render the lost answer.
 *     A card already ended without an answer keeps its first reason.
 *
 * Only a question card matches: `type === 'prompt'`, no `requestId` (a permission
 * prompt), and the `toolUseId` the question was raised under.
 */
export function markQuestionEnded(
  messages: ChatMessage[],
  toolUseId: string,
  kind: 'superseded' | 'notDelivered',
): ChatMessage[] | null {
  let changed = false
  const next = messages.map((m) => {
    if (m.type !== 'prompt' || m.requestId || m.toolUseId !== toolUseId) return m
    if (isQuestionNoAnswerToken(m.answered)) return m
    if (kind === 'superseded' && m.answered != null && m.answered !== REPLAY_RESOLVED_PLACEHOLDER) return m
    changed = true
    const { answeredAnswers: _dropped, ...rest } = m
    return {
      ...rest,
      answered: kind === 'superseded' ? QUESTION_SUPERSEDED_PLACEHOLDER : QUESTION_NOT_DELIVERED_PLACEHOLDER,
      answeredAt: undefined,
    }
  })
  return changed ? next : null
}

/**
 * {@link markQuestionEnded} over every session a client holds: the card may sit in
 * ANY session's transcript (a question for a background session, an answer sent
 * from another tab). Returns the session that changed and its new messages, or
 * `null` when no session holds a card that needed the change. The caller owns the
 * store write, since the two clients' stores are shaped differently.
 */
export function endQuestionInSessions(
  sessions: Record<string, { messages: ChatMessage[] } | undefined>,
  toolUseId: string,
  kind: 'superseded' | 'notDelivered',
): { sessionId: string; messages: ChatMessage[] } | null {
  for (const sessionId of Object.keys(sessions)) {
    const ss = sessions[sessionId]
    if (!ss) continue
    const messages = markQuestionEnded(ss.messages, toolUseId, kind)
    if (messages) return { sessionId, messages }
  }
  return null
}

/**
 * What a card whose `answered` is one of the no-answer tokens says, or `null` for
 * every other value (a real answer, a pending card, the replay sweep's
 * '(resolved)'). `kind` is a stable key for test ids / styling.
 */
export function questionEndedNotice(
  answered: unknown,
): { kind: 'interrupted' | 'superseded' | 'notDelivered'; label: string } | null {
  if (answered === QUESTION_INTERRUPTED_PLACEHOLDER) {
    return { kind: 'interrupted', label: 'Interrupted — chroxy restarted before this was answered' }
  }
  if (answered === QUESTION_SUPERSEDED_PLACEHOLDER) {
    return { kind: 'superseded', label: 'Replaced by a newer question — not answered' }
  }
  if (answered === QUESTION_NOT_DELIVERED_PLACEHOLDER) {
    return { kind: 'notDelivered', label: 'Answer not delivered — this question was no longer waiting' }
  }
  return null
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
