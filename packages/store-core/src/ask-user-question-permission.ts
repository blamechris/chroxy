/**
 * AskUserQuestion permission card + consent gate — shared by both clients
 * (#8264 dashboard, #8357 mobile app).
 *
 * In Approve mode the AskUserQuestion tool call still passes through the
 * permission gate. Two rules follow, and both clients must apply them
 * identically:
 *
 *   1. The permission card reads as a question ("Claude wants to ask you a
 *      question") with the question and options as text, never as the tool
 *      input's JSON cut at 200 characters (#8264). `readAskUserQuestions` and
 *      the headline helpers below are the one place that is derived.
 *   2. The interactive question card is withheld until the user ALLOWS the
 *      permission (#4685). `hasPendingAskUserQuestionPermission` is the one
 *      predicate for "is the gate still closed". It keys only off the
 *      permission's own decision, so an AskUserQuestion is never auto-answered,
 *      and never skips the prompt, because of its tool name.
 */
import type { ChatMessage, ChatMessageQuestion } from './types'
import { normalizeUserQuestion, OTHER_OPTION_VALUE } from './handlers/user-question'

/** Tool name the permission card and the consent gate specialise on. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * Parse the questions out of a raw AskUserQuestion tool input. Returns `[]` for
 * anything that is not a usable `{ questions: [...] }`. The synthetic "Other"
 * free-text sentinel the question card appends is dropped: it is a UI affordance
 * the model never wrote, so listing it would put words in Claude's mouth.
 */
export function readAskUserQuestions(
  toolInput: Record<string, unknown> | undefined,
): ChatMessageQuestion[] {
  const raw = toolInput?.questions
  if (!Array.isArray(raw)) return []
  const out: ChatMessageQuestion[] = []
  for (const entry of raw) {
    const q = normalizeUserQuestion(entry)
    if (!q) continue
    out.push({ ...q, options: q.options.filter((o) => o.value !== OTHER_OPTION_VALUE) })
  }
  return out
}

/** One-line statement of what is being asked; also the dropped-record text. */
export function askUserQuestionHeadline(questionCount: number): string {
  return questionCount > 1
    ? `Claude wants to ask you ${questionCount} questions`
    : 'Claude wants to ask you a question'
}

/** What the card says when it is dropped unanswered: the first question, or the headline. */
export function askUserQuestionSummary(toolInput: Record<string, unknown> | undefined): string {
  const questions = readAskUserQuestions(toolInput)
  return questions[0]?.question ?? askUserQuestionHeadline(1)
}

/**
 * The decisions that OPEN the gate. `deny` (and a missing / placeholder decision)
 * keeps it closed: a refusal means the user declined to see the question, so
 * revealing the model-supplied text after a deny defeats the gate (#4685).
 */
function opensAskUserQuestionGate(decision: string | undefined | null): boolean {
  return decision === 'allow' || decision === 'allowSession' || decision === 'allowAlways'
}

/**
 * True iff some AskUserQuestion PERMISSION prompt in `messages` is still
 * unresolved-or-denied, in which case every unanswered question card of that
 * session must render nothing (#4685). A permission prompt is one carrying a
 * `requestId`; the question card itself carries none, so it never gates itself.
 *
 * `resolvedPermissions` is the optional cross-client decision map (the dashboard
 * keeps one); the app has none and relies on the prompt's own `answered` token,
 * which `permission_resolved` stamps for a decision made on another client.
 * Fails closed: an `answered` that is not an allow token — `deny`, or the
 * `'(resolved)'` replay placeholder — leaves the gate shut.
 */
export function hasPendingAskUserQuestionPermission(
  messages: readonly ChatMessage[] | undefined | null,
  resolvedPermissions?: Record<string, string> | undefined | null,
): boolean {
  if (!messages) return false
  for (const m of messages) {
    if (m.type !== 'prompt') continue
    if (!m.requestId) continue
    if (m.tool !== ASK_USER_QUESTION_TOOL) continue
    if (opensAskUserQuestionGate(m.answered)) continue
    if (opensAskUserQuestionGate(resolvedPermissions?.[m.requestId])) continue
    return true
  }
  return false
}
