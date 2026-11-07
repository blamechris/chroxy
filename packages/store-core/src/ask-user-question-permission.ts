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
 * Pairing is by id and ONLY by id: the permission's `permissionToolUseId`
 * against the card's `toolUseId`, the provider's one id for the call (the hook
 * payload's `tool_use_id` reaches both frames). Position in the list never pairs
 * anything: arrival order and adjacency cannot establish ownership (a denied
 * permission with no card, or a card with no permission, shifts every later
 * pair). So:
 *   - a card with no `toolUseId`, or whose id matches no permission, is shown --
 *     except for the one temporary case below;
 *   - an id-less permission (an older daemon, a hook payload that names no call,
 *     an old journaled permission) is never tied to a card. While one is still
 *     PENDING, unanswered cards that have no permission of their own are held
 *     with it, and released when it resolves. Once it is denied or has ended it
 *     gates nothing, so a denied id-less permission cannot hide its card.
 *
 * Every permission carrying the id counts, not just the last: a hook-supplied id
 * is not guaranteed unique, and one pending or denied permission among several
 * for the same id is enough to keep the card hidden.
 *
 * A card with no permission yet is shown: the two are raised at the same instant
 * (a window of milliseconds, and on a reconnect the server re-sends permissions
 * before questions), and auto / bypass modes, and a hook that denies a
 * multi-question or multiSelect form before any prompt, never raise one.
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
  const holding = new Set<string>() // call ids with a pending or refused permission
  const owned = new Set<string>() // call ids that have any permission at all
  let unnamedPending = false // an AskUserQuestion permission with no id is awaiting a decision
  for (const m of messages) {
    if (!isPermission(m)) continue
    const state = permissionState(m, resolvedPermissions, now)
    if (!m.permissionToolUseId) {
      if (state === 'pending') unnamedPending = true
      continue
    }
    owned.add(m.permissionToolUseId)
    if (state === 'pending' || state === 'refused') holding.add(m.permissionToolUseId)
  }
  if (holding.size === 0 && !unnamedPending) return gated
  for (const m of messages) {
    if (!isCard(m) || !awaitingAnswer(m)) continue
    const own = m.toolUseId ? holding.has(m.toolUseId) : false
    // While an id-less permission is awaiting a decision (the hook payload named
    // no call, so it cannot be tied to one card), a card with no permission of its
    // own may be the card it belongs to: hold it until that decision lands. It
    // clears the moment the permission resolves or ends, so it cannot strand a
    // session; a DENIED or ended id-less permission gates nothing.
    const maybeUnnamed = unnamedPending && !(m.toolUseId && owned.has(m.toolUseId))
    if (own || maybeUnnamed) gated.add(m.id)
  }
  return gated
}
