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
 *   2. The interactive question card is withheld until the user ALLOWS ITS
 *      permission (#4685). `deriveGatedQuestionIds` is the one function for
 *      "which question cards are gated". It keys only off the paired
 *      permission's own decision, so an AskUserQuestion is never auto-answered,
 *      and never skips the prompt, because of its tool name.
 */
import type { ChatMessage, ChatMessageQuestion } from './types'
import { normalizeUserQuestion, OTHER_OPTION_VALUE } from './handlers/user-question'
import { REPLAY_RESOLVED_PLACEHOLDER } from './replay-reconcile'

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

type PermissionState = 'consent' | 'refused' | 'pending' | 'ended'

const OPENING_DECISIONS: readonly string[] = ['allow', 'allowSession', 'allowAlways']

/**
 * What an AskUserQuestion PERMISSION prompt says about consent for its question.
 *
 *   - `consent`: the user allowed it (any allow token, here or on another client).
 *   - `refused`: the user denied it. The question was refused, so it stays hidden.
 *   - `pending`: nobody has decided yet. Hidden until they do.
 *   - `ended`: it ended with no decision -- timed out, stopped, aborted, or the
 *     replay sweep's `'(resolved)'` placeholder. No live decision is pending and
 *     consent was not withheld, so it hides nothing.
 *
 * Fails closed on anything unrecognised: an `answered` string that is not a known
 * token is `pending`, not `ended`.
 */
function permissionState(
  m: ChatMessage,
  resolvedPermissions: Record<string, string> | undefined | null,
  now: number,
): PermissionState {
  const crossClient = m.requestId ? resolvedPermissions?.[m.requestId] : undefined
  if (OPENING_DECISIONS.includes(m.answered ?? '') || OPENING_DECISIONS.includes(crossClient ?? '')) {
    return 'consent'
  }
  if (m.answered === 'deny' || m.permissionOutcome === 'denied') return 'refused'
  if (m.answered === REPLAY_RESOLVED_PLACEHOLDER) return 'ended'
  if (m.answered) return 'pending'
  if (m.permissionOutcome === 'expired' || m.permissionOutcome === 'stopped') return 'ended'
  if (crossClient === 'deny') return 'refused'
  // `permission_expired` stamps `expiresAt: now` without setting `answered`.
  if (m.expiresAt !== undefined && m.expiresAt <= now) return 'ended'
  return 'pending'
}

/** A question card still waiting on the user: unanswered, or only the replay sweep's placeholder. */
function awaitingAnswer(card: ChatMessage): boolean {
  return card.answered == null || card.answered === REPLAY_RESOLVED_PLACEHOLDER
}

const isPermission = (m: ChatMessage): boolean =>
  m.type === 'prompt' && !!m.requestId && m.tool === ASK_USER_QUESTION_TOOL
const isCard = (m: ChatMessage): boolean => m.type === 'prompt' && !m.requestId

/**
 * The ids of the question cards that must render NOTHING right now (#4685).
 *
 * Each question card is gated by ITS OWN AskUserQuestion permission and by
 * nothing else. A session-wide check (any unresolved permission hides every
 * question) hid a later, allowed question forever after one denied or expired
 * permission, and again after a reload, since `history_replay_end` stamps old
 * prompts `'(resolved)'` -- so the agent waited on an answer nobody could give.
 *
 * Pairing is by id: the permission's `permissionToolUseId` against the card's
 * `toolUseId`, the provider's one id for the call (the hook payload's
 * `tool_use_id` reaches both frames). A card or permission with no partner
 * affects nothing else.
 *
 * Fallback, for a daemon that sends no id (or a hook payload that names none):
 * an id-less permission pairs with an unpaired card ADJACENT to it in the list,
 * and only that. The AskUserQuestion `tool_start` bubble of the same call sits in
 * between in practice (the same PreToolUse raises it first), so that one message
 * is skipped; nothing else is. Adjacency is local, so an unpaired item elsewhere
 * cannot shift a later pair. A permission goes to the card after it when both
 * neighbours are free (the order the hook raises them in is not guaranteed, so
 * this is a choice, not a fact).
 *
 * A card with no permission yet is shown: the two are raised at the same instant,
 * so the window is milliseconds, and auto / bypass modes, and a hook that denies
 * a multi-question or multiSelect form before any prompt, never raise one.
 *
 * Only `refused` and `pending` hide a card, and only one still awaiting an answer
 * (the replay placeholder counts as awaiting: after a reload a card whose own
 * permission is pending or denied must stay hidden). A permission is a prompt with
 * a `requestId` and `tool === AskUserQuestion`; a question card is a prompt with
 * no `requestId`. Nothing keys on a card's tool name, and a permission for any
 * other tool never gates a question.
 *
 * `resolvedPermissions` is the optional cross-client decision map (the dashboard
 * keeps one); the app has none and relies on the prompt's own `answered` token,
 * which `permission_resolved` stamps for a decision made on another client.
 */
export function deriveGatedQuestionIds(
  messages: readonly ChatMessage[] | undefined | null,
  resolvedPermissions: Record<string, string> | undefined | null,
  now: number,
): Set<string> {
  const gated = new Set<string>()
  if (!messages) return gated
  // The same call's tool_start bubble sits between its permission and its card.
  const seq = messages.filter((m) => !(m.type === 'tool_use' && m.tool === ASK_USER_QUESTION_TOOL))
  const paired = new Set<ChatMessage>()
  const pairWith = (card: ChatMessage, perm: ChatMessage) => {
    paired.add(card)
    paired.add(perm)
    if (awaitingAnswer(card)) {
      const state = permissionState(perm, resolvedPermissions, now)
      if (state === 'pending' || state === 'refused') gated.add(card.id)
    }
  }

  // 1. By id.
  const permById = new Map<string, ChatMessage>()
  for (const m of seq) {
    if (isPermission(m) && m.permissionToolUseId) permById.set(m.permissionToolUseId, m)
  }
  for (const m of seq) {
    if (!isCard(m) || !m.toolUseId) continue
    const perm = permById.get(m.toolUseId)
    if (perm && !paired.has(perm)) pairWith(m, perm)
  }

  // 2. Adjacent, for a permission that carries no id.
  const free = (m: ChatMessage | undefined): m is ChatMessage => !!m && isCard(m) && !paired.has(m)
  seq.forEach((m, i) => {
    if (!isPermission(m) || m.permissionToolUseId || paired.has(m)) return
    const next = seq[i + 1]
    const prev = seq[i - 1]
    if (free(next)) pairWith(next, m)
    else if (free(prev)) pairWith(prev, m)
  })
  return gated
}
