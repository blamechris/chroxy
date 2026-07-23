/**
 * useChatMessages — derive the chat-view message list from store messages (#4770).
 *
 * Thin React-memo wrapper around the pure `buildChatViewMessages` function
 * in `@chroxy/store-core` (#4806). The mobile `ChatView` consumes the same
 * pure function inline so both surfaces share the filter + group + overlay +
 * tail-id + storeMsgMap + stalled-prompt derivations.
 *
 * Pipeline (see `buildChatViewMessages` for the canonical doc):
 *   storeMessages
 *     -> filter(m => m.type !== 'system')   // System events render on the
 *                                           //   System tab, not in chat.
 *     -> groupMessages                      // (#3747) collapse contiguous
 *                                           //   tool_use runs into
 *                                           //   ActivityGroups (#6756:
 *                                           //   thinking stays standalone).
 *     -> applyStreamingOverlay              // mark trailing activity group
 *                                           //   as active during streaming.
 *     -> ChatViewMessage[]                  // flatten to chat-view rows.
 *
 * Memoisation
 * -----------
 * The pure function is `useMemo`-wrapped on `storeMessages` and
 * `streamingMessageId`. Passing the same references yields a stable
 * `UseChatMessagesResult` reference across renders.
 */
import { useMemo } from 'react'
import {
  buildChatViewMessages,
  toChatViewMessage,
  type ChatMessage,
  type ChatViewMessage as StoreChatViewMessage,
} from '@chroxy/store-core'
import type { ChatViewMessage } from '../components/ChatView'

// The dashboard re-exports its own `ChatViewMessage` for component prop
// typing; the store-core type is structurally identical (same fields,
// same discriminator). This static assertion catches drift if either
// definition changes without the other.
type _AssertCompatible = ChatViewMessage extends StoreChatViewMessage
  ? StoreChatViewMessage extends ChatViewMessage
    ? true
    : false
  : false
const _assert: _AssertCompatible = true
void _assert

export interface UseChatMessagesProps {
  storeMessages: ChatMessage[]
  streamingMessageId: string | null
  /**
   * #6799 — global compact chat filter. When true, `buildChatViewMessages`
   * drops every `tool_use` and `thinking` row session-wide (mobile parity), so
   * the transcript shows only the conversation. Defaults to false (off).
   */
  hideToolAndThinking?: boolean
}

export interface UseChatMessagesResult {
  /** Chat-view rows, with contiguous tool runs collapsed to `tool_group`. */
  chatMessages: ChatViewMessage[]
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

// Re-export so existing dashboard call sites (App.tsx imports
// `toChatViewMessage` from this module for the System-tab mapping) keep
// compiling without a churn diff.
export { toChatViewMessage }

export function useChatMessages(props: UseChatMessagesProps): UseChatMessagesResult {
  const { storeMessages, streamingMessageId, hideToolAndThinking = false } = props

  const result = useMemo(
    () => buildChatViewMessages(storeMessages, streamingMessageId, { hideToolAndThinking }),
    [storeMessages, streamingMessageId, hideToolAndThinking],
  )

  // Destructure to drop `displayGroups` (dashboard uses the flattened
  // `chatMessages` path; only mobile consumes displayGroups directly).
  const {
    chatMessages,
    chatToolGroupPayloads,
    chatTailMessageId,
    storeMsgMap,
    stalledPromptIds,
  } = result

  return {
    chatMessages,
    chatToolGroupPayloads,
    chatTailMessageId,
    storeMsgMap,
    stalledPromptIds,
  }
}
