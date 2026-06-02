/**
 * useChatMessages — derive the chat-view message list from store messages (#4770).
 *
 * Pipeline (extracted from App.tsx):
 *   storeMessages
 *     -> filter(m => m.type !== 'system')   // System events render on the
 *                                           //   System tab, not in chat.
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
 * row without re-deriving it (used by ToolBubble / StreamStallChip /
 * AskUserQuestionStallChip).
 *
 * Memoisation
 * -----------
 * Each derivation step is `useMemo`-wrapped on its true input deps —
 * passing the same `storeMessages` reference + same `streamingMessageId`
 * across renders yields the same output references.
 */
import { useMemo } from 'react'
import {
  groupMessages,
  applyStreamingOverlay,
  type ChatMessage,
} from '@chroxy/store-core'
import type { ChatViewMessage } from '../components/ChatView'

export interface UseChatMessagesProps {
  storeMessages: ChatMessage[]
  streamingMessageId: string | null
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
  }
}

export function useChatMessages(props: UseChatMessagesProps): UseChatMessagesResult {
  const { storeMessages, streamingMessageId } = props

  // Filter out `system` events — they belong on the System tab.
  const chatFilteredMessages = useMemo(
    () => storeMessages.filter(m => m.type !== 'system'),
    [storeMessages],
  )

  // Group contiguous tool_use / thinking runs into ActivityGroups, then
  // apply the streaming overlay so the trailing group flips to isActive
  // while streaming is in progress.
  const chatDisplayGroups = useMemo(() => {
    const base = groupMessages(chatFilteredMessages)
    return applyStreamingOverlay(base, chatFilteredMessages, streamingMessageId ?? null)
  }, [chatFilteredMessages, streamingMessageId])

  // Map of synthetic group id -> original messages + isActive. Only
  // populated for runs of 2+ messages (#3794 review) — singleton
  // activity groups render as the original `tool_use` / `thinking` row
  // through ToolBubble, so they don't need a payload lookup.
  const chatToolGroupPayloads = useMemo(() => {
    const map = new Map<string, { messages: ChatMessage[]; isActive: boolean }>()
    for (const g of chatDisplayGroups) {
      if (g.type === 'activity' && g.messages.length >= 2) {
        map.set(g.key, { messages: g.messages, isActive: g.isActive })
      }
    }
    return map
  }, [chatDisplayGroups])

  // Flatten to ChatViewMessage[] — singleton activity groups (1 msg)
  // pass through as `tool_use` / `thinking`; runs of 2+ collapse to a
  // single synthetic `tool_group` row keyed by the group key.
  const chatMessages = useMemo<ChatViewMessage[]>(
    () =>
      chatDisplayGroups.map((g) => {
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
      }),
    [chatDisplayGroups],
  )

  const chatTailMessageId = chatMessages.length > 0
    ? chatMessages[chatMessages.length - 1]!.id
    : null

  // O(1) lookup map for renderMessage — keyed by store id, value is
  // the original ChatMessage so the renderer can inspect fields the
  // ChatViewMessage shape doesn't carry (toolInput, requestId,
  // questions, etc.).
  const storeMsgMap = useMemo(
    () => new Map(storeMessages.map(m => [m.id, m])),
    [storeMessages],
  )

  // #4615: track which `type: 'prompt'` bubbles have been invalidated by a
  // subsequent ASK_USER_QUESTION_STALL error. The server emits the error
  // when the Claude TUI never acknowledges an AskUserQuestion answer —
  // typically a multi-question form wedge. The pending QuestionPrompt is
  // now dead, so submitting it would fire keystrokes into a session that
  // already discarded the prompt context. We suppress the interactive
  // prompt render (the AskUserQuestionStallChip rendered for the error
  // bubble below it carries the retry affordance).
  const stalledPromptIds = useMemo(() => {
    const stalled = new Set<string>()
    let lastStallIndex = -1
    for (let i = storeMessages.length - 1; i >= 0; i -= 1) {
      const m = storeMessages[i]!
      if (m.type === 'error' && m.code === 'ASK_USER_QUESTION_STALL') {
        lastStallIndex = i
        break
      }
    }
    if (lastStallIndex >= 0) {
      for (let i = 0; i < lastStallIndex; i += 1) {
        const m = storeMessages[i]!
        if (m.type === 'prompt' && !m.answered) stalled.add(m.id)
      }
    }
    return stalled
  }, [storeMessages])

  return {
    chatMessages,
    chatToolGroupPayloads,
    chatTailMessageId,
    storeMsgMap,
    stalledPromptIds,
  }
}
