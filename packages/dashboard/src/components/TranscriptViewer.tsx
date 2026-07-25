/**
 * TranscriptViewer — read-only viewer for a closed conversation's transcript
 * (#6863, epic #6765).
 *
 * Opened via the "View" action added alongside "Resume" in
 * `ConversationSearch` and the sidebar's `resumable` right-click menu
 * (`sidebarContextMenuItems.ts`). The transcript itself comes from the
 * read-only `request_conversation_transcript` endpoint (#6860) — reading a
 * CLOSED conversation straight off disk, with NO `SessionManager` entry and
 * NO provider process spawned on either side of the wire. Works uniformly
 * for conversations from providers whose `capabilities.resume === false`
 * (BYOK, Codex, Gemini, user-shell), for which Resume is refused outright.
 *
 * Read-only is structural, not just visual:
 *  - No composer/input is rendered anywhere in this component tree.
 *  - `ChatView` is driven with `renderMessage={transcriptRenderMessage}`,
 *    which reuses only the PRESENTATIONAL branches of the live chat renderer
 *    (`useMessageRenderer` — tool groups/bubbles, compaction/evaluator/MCP
 *    markers). It deliberately OMITS the interactive branches
 *    (`PermissionPrompt`/`QuestionPrompt`, whose `onRespond`/`onSelect` send
 *    live decisions, and the stall chips' `onRetry`, which resends a
 *    message) — anything transcriptRenderMessage doesn't handle falls back
 *    to ChatView's default row (a plain markdown/text bubble), never an
 *    interactive control.
 *  - The messages themselves live in the store's dedicated `transcriptViewer`
 *    slice, never `sessionStates` — see message-handler.ts's
 *    `applyTranscriptFrame` for how the wire frames are kept out of the
 *    live-session path entirely.
 *  - There is no callback prop here that can send input, respond to a
 *    prompt, or spawn a session — only `onClose` and `onRetry` (re-fetch).
 */
import { useCallback } from 'react'
import type { ChatMessage } from '@chroxy/store-core'
import { Modal } from './Modal'
import { ChatView, type ChatViewMessage } from './ChatView'
import { ToolGroup } from './ToolGroup'
import { ToolBubble } from './ToolBubble'
import { CompactionMarker } from './CompactionMarker'
import { EvaluatorRewriteBanner } from './EvaluatorPrompts'
import { McpPromptExpansionMarker } from './McpPromptExpansionMarker'
import { useChatMessages } from '../hooks/useChatMessages'
import type { TranscriptViewerState } from '../store/types'
import './TranscriptViewer.css'

export interface TranscriptViewerProps {
  conversationId: string
  status: TranscriptViewerState['status']
  messages: ChatMessage[]
  error: string | null
  onClose: () => void
  onRetry: () => void
}

/**
 * Presentational-only reuse of `useMessageRenderer`'s tool-group / tool-bubble
 * / marker branches — see the module doc above for why the interactive
 * branches are intentionally left out. Exported for direct unit testing.
 */
export function transcriptRenderMessage(
  msg: ChatViewMessage,
  chatToolGroupPayloads: Map<string, { messages: ChatMessage[]; isActive: boolean }>,
  chatTailMessageId: string | null,
  storeMsgMap: Map<string, ChatMessage>,
) {
  if (msg.type === 'tool_group') {
    const payload = chatToolGroupPayloads.get(msg.id)
    if (!payload) return null
    // A closed conversation has no in-flight activity — always inactive.
    return <ToolGroup messages={payload.messages} isActive={false} isTail={msg.id === chatTailMessageId} />
  }
  const storeMsg = storeMsgMap.get(msg.id)
  if (!storeMsg) return null

  if (storeMsg.type === 'tool_use' && storeMsg.toolUseId) {
    return (
      <ToolBubble
        toolName={storeMsg.tool || 'Tool'}
        toolUseId={storeMsg.toolUseId}
        input={storeMsg.toolInput}
        inputPartial={storeMsg.toolInputPartial}
        result={storeMsg.toolResult}
        serverName={storeMsg.serverName}
        isTail={msg.id === chatTailMessageId}
        resultImages={storeMsg.toolResultImages}
        childAgentEvents={storeMsg.childAgentEvents}
      />
    )
  }
  if (storeMsg.type === 'system' && storeMsg.compactMetadata) {
    return <CompactionMarker meta={storeMsg.compactMetadata} />
  }
  if (storeMsg.type === 'system' && storeMsg.evaluator?.kind === 'rewrite') {
    return <EvaluatorRewriteBanner meta={storeMsg.evaluator} />
  }
  if (storeMsg.type === 'system' && storeMsg.mcpPromptExpansion) {
    return <McpPromptExpansionMarker meta={storeMsg.mcpPromptExpansion} />
  }
  // Permission prompts, question prompts, error chips, etc. all fall through
  // to ChatView's plain default row — content is still visible (the prompt's
  // text, the resolved answer summary if one was recorded), just without any
  // interactive control.
  return null
}

export function TranscriptViewer({ conversationId, status, messages, error, onClose, onRetry }: TranscriptViewerProps) {
  // Same pure pipeline the live session view uses (filter system events,
  // group contiguous tool runs, flatten) — reuse, not a fork.
  const { chatMessages, chatToolGroupPayloads, chatTailMessageId, storeMsgMap } = useChatMessages({
    storeMessages: messages,
    streamingMessageId: null,
  })

  const renderMessage = useCallback(
    (msg: ChatViewMessage) => transcriptRenderMessage(msg, chatToolGroupPayloads, chatTailMessageId, storeMsgMap),
    [chatToolGroupPayloads, chatTailMessageId, storeMsgMap],
  )

  return (
    <Modal open onClose={onClose} title="Conversation transcript" maxWidth="900px">
      <p className="transcript-viewer-readonly-badge" data-testid="transcript-viewer-readonly-badge">
        Read-only — viewing does not resume this conversation.
      </p>
      <div
        className="transcript-viewer-body"
        data-testid="transcript-viewer-body"
        data-conversation-id={conversationId}
      >
        {status === 'loading' && (
          <div className="transcript-viewer-status" data-testid="transcript-viewer-loading">
            Loading transcript…
          </div>
        )}
        {status === 'error' && (
          <div className="transcript-viewer-status transcript-viewer-error" data-testid="transcript-viewer-error">
            {error || 'Failed to load transcript.'}
          </div>
        )}
        {status === 'ready' && chatMessages.length === 0 && (
          <div className="transcript-viewer-status" data-testid="transcript-viewer-empty">
            No messages in this conversation.
          </div>
        )}
        {status === 'ready' && chatMessages.length > 0 && (
          // ChatView windows/virtualizes above its own row-count threshold
          // (#5561) — a very large transcript renders exactly like a long
          // live session and never locks the UI.
          <ChatView messages={chatMessages} isStreaming={false} renderMessage={renderMessage} />
        )}
      </div>
      <div className="transcript-viewer-footer">
        {status === 'error' && (
          <button
            type="button"
            className="transcript-viewer-button"
            data-testid="transcript-viewer-retry"
            onClick={onRetry}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          className="transcript-viewer-button"
          data-testid="transcript-viewer-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </Modal>
  )
}
