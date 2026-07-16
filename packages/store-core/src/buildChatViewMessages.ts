/**
 * Shared ChatView message pipeline (#4806).
 *
 * Pure function lifted from dashboard's `useChatMessages` hook so both the
 * web dashboard and the mobile app derive the chat-view representation
 * from the same code. Eliminates the silent #4615 mobile gap where the
 * inline mobile pipeline never computed `stalledPromptIds` and rendered
 * interactive QuestionPrompt for ASK_USER_QUESTION_STALL-invalidated
 * prompts.
 *
 * Pipeline:
 *   storeMessages
 *     -> filter(m => m.type !== 'system')   // System events render on
 *                                           //   the System tab.
 *     -> groupMessages                      // (#3747) collapse contiguous
 *                                           //   tool_use / thinking runs
 *                                           //   into ActivityGroups.
 *     -> applyStreamingOverlay              // mark trailing activity group
 *                                           //   as active during streaming.
 *     -> ChatViewMessage[]                  // flatten to chat-view rows.
 *
 * Singleton activity groups (1 message) pass through as the original
 * `tool_use` / `thinking` row so the existing ToolBubble path stays
 * reachable. Runs of 2+ messages collapse to a synthetic `tool_group`
 * row whose `id` is the group key `activity-<firstId>`. The full payload
 * is exposed via `chatToolGroupPayloads: Map<groupId, { messages, isActive }>`
 * so the renderer can look it up when emitting `<ToolGroup>`.
 *
 * `chatTailMessageId` is provided so renderers can detect the trailing
 * row without re-deriving it.
 *
 * `displayGroups` is exposed too — the mobile ChatView renders groups
 * directly (no flatten) while the dashboard consumes `chatMessages`. Both
 * surfaces get derivation parity from a single call.
 *
 * `stalledPromptIds` (#4615) carries the set of `type: 'prompt'` message
 * ids that have been invalidated by a subsequent ASK_USER_QUESTION_STALL
 * error so renderers can suppress the interactive prompt UI.
 *
 * This function is intentionally pure (no hooks, no refs, no I/O) — React
 * memoisation lives in the calling hook / component.
 */
import {
  groupMessages,
  applyStreamingOverlay,
  type DisplayGroup,
} from './group-messages'
import { isRetryableAskUserQuestionError } from './ask-user-question-errors'
import type { ChatMessage, MessageAttachment } from './types'

/**
 * Flattened chat-view row.
 *
 * `tool_group` is a synthetic discriminator emitted by the grouping pass —
 * it has no store-side equivalent and consumers always render it via a
 * custom renderer that looks the payload up in `chatToolGroupPayloads`.
 */
export interface ChatViewMessage {
  id: string
  type: 'response' | 'user_input' | 'system' | 'error' | 'thinking' | 'tool_use' | 'tool_group'
  content: string
  timestamp: number
  isStreaming?: boolean
  /**
   * #4476 — structured error code mirrored from the store ChatMessage so
   * renderers can switch on it (e.g. `'stream_stall'` → chip + retry).
   */
  code?: string
  /**
   * #6632 — attachments on a `user_input` message (images / documents), mirrored
   * from the store ChatMessage so the transcript can render a thumbnail/chip of
   * what the user sent (confirming the attachment after submit / on resume).
   */
  attachments?: MessageAttachment[]
}

export interface ChatViewPipelineResult {
  /** Chat-view rows with contiguous tool runs collapsed to `tool_group`. */
  chatMessages: ChatViewMessage[]
  /**
   * Display groups after filter + group + streaming overlay. Mobile
   * renders these directly; dashboard consumes `chatMessages` instead.
   * Both come from the same source pass.
   */
  displayGroups: DisplayGroup[]
  /** Group key -> original messages + isActive overlay, for `<ToolGroup>`. */
  chatToolGroupPayloads: Map<string, { messages: ChatMessage[]; isActive: boolean }>
  /** Id of the last chat row, or null when empty. */
  chatTailMessageId: string | null
  /** O(1) lookup map `id -> storeMessage` for renderMessage. */
  storeMsgMap: Map<string, ChatMessage>
  /**
   * #4615 — set of `type: 'prompt'` message ids invalidated by a
   * subsequent ASK_USER_QUESTION_STALL error. Renderers suppress these
   * prompts; the stall chip carries the retry affordance instead.
   */
  stalledPromptIds: Set<string>
}

/** Map store ChatMessage to ChatViewMessage. Exported so callers can map
 *  derived lists (e.g. systemMessages on the System tab) using the same
 *  conversion as the chat pipeline. */
export function toChatViewMessage(msg: ChatMessage): ChatViewMessage {
  return {
    id: msg.id,
    type: msg.type === 'prompt' ? 'response' : msg.type,
    content: msg.content,
    timestamp: msg.timestamp,
    // #4476: propagate the structured error code so the chat-view
    // renderMessage path can switch error bubbles into the
    // StreamStallChip variant.
    ...(msg.code ? { code: msg.code } : {}),
    // #6632: carry user-message attachments through so the transcript can
    // preview them (dropped previously → no thumbnail on the sent message).
    // Gated to `user_input` to match the contract (attachments live only on user
    // messages) — don't thread attachment data onto non-user bubbles.
    ...(msg.type === 'user_input' && msg.attachments?.length ? { attachments: msg.attachments } : {}),
  }
}

/**
 * Build the full chat-view derivation set from a list of store messages.
 *
 * Pure — same inputs yield identical outputs. Callers wrap this in
 * `useMemo` (or equivalent) to avoid recomputation on unrelated renders.
 *
 * @param storeMessages full message list from BaseSessionState.messages
 * @param streamingMessageId currently-streaming message id (drives the
 *   trailing activity group's `isActive` overlay); `null` when idle.
 */
export function buildChatViewMessages(
  storeMessages: ChatMessage[],
  streamingMessageId: string | null,
): ChatViewPipelineResult {
  // Filter out `system` events — they belong on the System tab.
  const chatFilteredMessages = storeMessages.filter(m => m.type !== 'system')

  // Group contiguous tool_use / thinking runs, then apply the streaming
  // overlay so the trailing group flips to isActive while streaming.
  const baseGroups = groupMessages(chatFilteredMessages)
  const displayGroups = applyStreamingOverlay(
    baseGroups,
    chatFilteredMessages,
    streamingMessageId ?? null,
  )

  // Map of synthetic group id -> original messages + isActive. Only
  // populated for runs of 2+ messages (#3794 review) — singleton activity
  // groups render as the original `tool_use` / `thinking` row through
  // ToolBubble, so they don't need a payload lookup.
  const chatToolGroupPayloads = new Map<
    string,
    { messages: ChatMessage[]; isActive: boolean }
  >()
  for (const g of displayGroups) {
    if (g.type === 'activity' && g.messages.length >= 2) {
      chatToolGroupPayloads.set(g.key, { messages: g.messages, isActive: g.isActive })
    }
  }

  // Flatten to ChatViewMessage[] — singleton activity groups (1 msg)
  // pass through as `tool_use` / `thinking`; runs of 2+ collapse to a
  // single synthetic `tool_group` row keyed by the group key.
  const chatMessages: ChatViewMessage[] = displayGroups.map((g) => {
    if (g.type === 'single') return toChatViewMessage(g.message)
    if (g.messages.length < 2) {
      // Singleton — emit as the original tool_use / thinking row.
      return toChatViewMessage(g.messages[0]!)
    }
    const last = g.messages[g.messages.length - 1]
    return {
      id: g.key,
      type: 'tool_group',
      content: '',
      timestamp: last?.timestamp ?? 0,
    }
  })

  const chatTailMessageId = chatMessages.length > 0
    ? chatMessages[chatMessages.length - 1]!.id
    : null

  // O(1) lookup map for renderMessage — keyed by store id, value is the
  // original ChatMessage so the renderer can inspect fields the
  // ChatViewMessage shape doesn't carry (toolInput, requestId,
  // questions, etc.). Built from the unfiltered storeMessages so callers
  // can look up system events too.
  const storeMsgMap = new Map(storeMessages.map(m => [m.id, m]))

  // #4615 / #5793: track which `type: 'prompt'` bubbles have been
  // invalidated by a subsequent retryable AskUserQuestion teardown error.
  // The server emits one of these codes (ASK_USER_QUESTION_STALL plus the
  // five MULTISELECT/MULTI_QUESTION codes — see
  // `isRetryableAskUserQuestionError`) when the Claude TUI never
  // acknowledges an AskUserQuestion answer or denies a multi-select /
  // multi-question form. The pending QuestionPrompt is now dead, so
  // submitting it would fire keystrokes into a session that already
  // discarded the prompt context. We suppress the interactive prompt
  // render (the AskUserQuestionStallChip rendered for the error bubble
  // below it carries the retry affordance).
  const stalledPromptIds = new Set<string>()
  // Index of the most recent retryable AskUserQuestion teardown error (STALL
  // plus the multi-select / multi-question codes — see
  // isRetryableAskUserQuestionError); prompts before it are dead and suppressed.
  let lastRetryableErrorIndex = -1
  for (let i = storeMessages.length - 1; i >= 0; i -= 1) {
    const m = storeMessages[i]!
    if (m.type === 'error' && isRetryableAskUserQuestionError(m.code)) {
      lastRetryableErrorIndex = i
      break
    }
  }
  if (lastRetryableErrorIndex >= 0) {
    for (let i = 0; i < lastRetryableErrorIndex; i += 1) {
      const m = storeMessages[i]!
      if (m.type === 'prompt' && !m.answered) stalledPromptIds.add(m.id)
    }
  }

  return {
    chatMessages,
    displayGroups,
    chatToolGroupPayloads,
    chatTailMessageId,
    storeMsgMap,
    stalledPromptIds,
  }
}
