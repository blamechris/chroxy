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
  getExpiredPermissionTurnSummaries,
  type ChatMessage,
  type ChatViewMessage as StoreChatViewMessage,
  type ExpiredPermissionTurnSummary,
  type TurnBoundarySource,
} from '@chroxy/store-core'
import type { ChatViewMessage } from '../components/ChatView'
import { insertPermissionExpiredSummaryRows } from '../utils/permissionExpiredSummaryRows'
import { collapseResolvedPermissionRuns } from '../utils/permissionGroupRows'

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
  /**
   * #7365 (review round 2) — whether the active session's LAST turn has
   * actually ended, i.e. the server-authoritative `isIdle` flag (#4639) — the
   * same one `isSessionBusy` already reads. The end-of-turn summary is gated
   * on this for the trailing turn only (every earlier — `turnBoundary`-marked
   * — turn has, by construction, already ended): per the issue's own wording
   * ("at turn end"), and because rendering it for a still-running turn made
   * its list position unstable (it kept re-anchoring to the transcript tail
   * as more content streamed in). Defaults to `true` — a caller with no live
   * turn at all (`TranscriptViewer`'s closed conversations) has nothing
   * "still running" by definition.
   */
  isSessionIdle?: boolean
  /**
   * #7365 (review round 3, Critical #1) — which signal delimits a turn for
   * the end-of-turn summary, chosen EXPLICITLY by the caller (never inferred
   * from "no `turnBoundary` marks present" — a live session before its first
   * `result` has none either, and must not be mistaken for the other
   * source). Defaults to `'marker'`: the live chat path's `result`-stamped
   * `turnBoundary` messages. `TranscriptViewer` passes `'user_input'`
   * explicitly — its data source (the raw on-disk Claude Code JSONL
   * transcript) never carries a `result` entry at all, so `'marker'` mode
   * would find zero boundaries in it. See
   * `@chroxy/store-core`'s `permission-turn-summary.ts` for the full
   * rationale for each mode.
   */
  turnBoundarySource?: TurnBoundarySource
  /**
   * #6894 — collapse runs of identical RESOLVED permission prompts into one
   * `permission-group` row. Default `true`. `TranscriptViewer` passes `false`:
   * a closed conversation has no resolved-prompt state and its renderer has no
   * group payloads to draw a group row from.
   */
  groupResolvedPermissions?: boolean
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
  /**
   * #7365 — synthetic `permission-expired-summary` row id -> the turn's
   * aggregated expired-permission payload, for the `renderMessage` lookup
   * (mirrors `chatToolGroupPayloads`'s shape). Empty when no turn in the
   * transcript has an expired-unanswered permission prompt.
   */
  permissionExpiredSummaries: Map<string, ExpiredPermissionTurnSummary>
  /**
   * #6894 — synthetic `permission-group` row id -> the store message ids of the
   * identical resolved prompts it stands for, in transcript order. Empty when
   * nothing groups. A pending prompt is never in one.
   */
  permissionPromptGroups: Map<string, string[]>
}

// Re-export so existing dashboard call sites (App.tsx imports
// `toChatViewMessage` from this module for the System-tab mapping) keep
// compiling without a churn diff.
export { toChatViewMessage }

export function useChatMessages(props: UseChatMessagesProps): UseChatMessagesResult {
  const {
    storeMessages,
    streamingMessageId,
    hideToolAndThinking = false,
    isSessionIdle = true,
    turnBoundarySource = 'marker',
    groupResolvedPermissions = true,
  } = props

  const result = useMemo(
    () => buildChatViewMessages(storeMessages, streamingMessageId, { hideToolAndThinking }),
    [storeMessages, streamingMessageId, hideToolAndThinking],
  )

  // Destructure to drop `displayGroups` (dashboard uses the flattened
  // `chatMessages` path; only mobile consumes displayGroups directly).
  const {
    chatMessages: baseChatMessages,
    chatToolGroupPayloads,
    chatTailMessageId,
    storeMsgMap,
    stalledPromptIds,
  } = result

  // #7365 — dashboard-only: splice a synthetic summary row after any
  // COMPLETED turn that contains an expired-unanswered permission prompt.
  // Turns are delimited by `turnBoundary`-marked messages (stamped by
  // `case 'result'` in message-handler.ts, live and replayed alike — see
  // `@chroxy/store-core`'s `turn-boundaries.ts`), not by `user_input`
  // position — a send-while-busy queued follow-up's row is ordinary content
  // wherever it lands, permanently, so `stillQueuedMessageIds` (round 1's
  // fix) is gone: it only ever covered the WINDOW before a flush, and the
  // position-based split it patched over was unsound after one regardless.
  //
  // Recomputed on every `storeMessages` (or `isSessionIdle`) change — a fresh
  // `Date.now()` per derivation, not a ticking interval. This is NOT full
  // parity with the per-prompt marker's countdown: `PermissionPrompt.tsx`
  // reads a `now` it ticks every second itself, so its "Timed out" label can
  // flip a few seconds before this memo re-runs (it only re-runs when
  // `storeMessages`/`isSessionIdle` actually change reference, which in
  // practice follows soon after — either the server's own
  // `permission_expired` frame, which mutates the message, or any other
  // store update in an active session). Low-impact lag, not a guarantee;
  // called out here rather than overclaimed. Mirrors the same tradeoff
  // `derivePendingPermissionCounts` already accepts for the "live pending"
  // badge.
  //
  // `chatTailMessageId` is deliberately NOT recomputed from the spliced rows:
  // it identifies the last REAL content row (for ToolGroup/ToolBubble's
  // `isTail` expand-state and the stream-stall retry button), and shifting it
  // to a synthetic summary row would silently collapse a trailing tool group
  // the moment its turn's permission expired.
  const { chatMessages: summarizedRows, permissionExpiredSummaries } = useMemo(() => {
    const summaries = getExpiredPermissionTurnSummaries(storeMessages, Date.now(), isSessionIdle, turnBoundarySource)
    if (summaries.length === 0) {
      return { chatMessages: baseChatMessages, permissionExpiredSummaries: new Map<string, ExpiredPermissionTurnSummary>() }
    }
    const { rows, payloads } = insertPermissionExpiredSummaryRows(
      baseChatMessages,
      summaries,
      storeMessages,
      chatToolGroupPayloads,
    )
    return { chatMessages: rows, permissionExpiredSummaries: payloads }
  }, [storeMessages, baseChatMessages, chatToolGroupPayloads, isSessionIdle, turnBoundarySource])

  // #6894 — dashboard-only: fold each run of ADJACENT identical resolved
  // permission prompts into one counted row. After the summary splice (which
  // anchors on raw row ids a group would hide); a pending prompt never joins a
  // run. Like the summary rows, it leaves `chatTailMessageId` alone.
  const { rows: chatMessages, groups: permissionPromptGroups } = useMemo(
    () =>
      groupResolvedPermissions
        ? collapseResolvedPermissionRuns(summarizedRows, storeMsgMap)
        : { rows: summarizedRows, groups: new Map<string, string[]>() },
    [summarizedRows, storeMsgMap, groupResolvedPermissions],
  )

  return {
    chatMessages,
    chatToolGroupPayloads,
    chatTailMessageId,
    storeMsgMap,
    stalledPromptIds,
    permissionExpiredSummaries,
    permissionPromptGroups,
  }
}
