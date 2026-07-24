import { useCallback } from 'react'
import type { ReactNode } from 'react'
import type { ChatMessage, SessionInfo } from '@chroxy/store-core'
import { providerSupportsSingleMultiSelect, isRetryableAskUserQuestionError } from '@chroxy/store-core'
import type { ChatViewMessage } from '../components/ChatView'
import type { ConnectionState } from '../store/connection'
import type { ProviderCapabilities } from '../store/types'
import { ToolGroup } from '../components/ToolGroup'
import { ToolBubble } from '../components/ToolBubble'
import { PermissionPrompt } from '../components/PermissionPrompt'
import { QuestionPrompt } from '../components/QuestionPrompt'
import { EvaluatorRewriteBanner } from '../components/EvaluatorPrompts'
import { CompactionMarker } from '../components/CompactionMarker'
import { StreamStallChip } from '../components/StreamStallChip'
import { AskUserQuestionStallChip } from '../components/AskUserQuestionStallChip'
import { ResumeUnknownChip } from '../components/ResumeUnknownChip'
import { formatQuestionAnswerSummary } from '../utils/questionAnswerSummary'

export interface UseMessageRendererArgs {
  storeMsgMap: Map<string, ChatMessage>
  chatToolGroupPayloads: Map<string, { messages: ChatMessage[]; isActive: boolean }>
  chatTailMessageId: string | null
  sendPermissionResponse: ConnectionState['sendPermissionResponse']
  sendUserQuestionResponse: ConnectionState['sendUserQuestionResponse']
  markPromptAnswered: ConnectionState['markPromptAnswered']
  storeMessages: ChatMessage[]
  sendInput: ConnectionState['sendInput']
  streamStallTimeoutMs: number | null
  allowMultiQuestionForm: boolean
  activeSessionProvider: string | null
  // #5791 — the active provider's advertised capabilities, used to gate the
  // claude-tui single-multiSelect form on the server's `multiSelectReinject` bit.
  activeSessionCaps?: ProviderCapabilities | null
  setViewMode: ConnectionState['setViewMode']
  stalledPromptIds: Set<string>
  hasPendingAskUserQuestionPermission: boolean
  /**
   * #5667 — all connected sessions, used to label a permission prompt with the
   * session that asked (from the message's `originSessionId`). Only consulted
   * when more than one session exists.
   */
  sessions: SessionInfo[]
}

/**
 * #5667 — build a short "which session is asking" label, e.g. "ltl · CLI",
 * from a prompt's `originSessionId`. Returns undefined when there's no origin,
 * the session is unknown, or only one session exists (nothing to disambiguate).
 */
function buildSessionLabel(
  originSessionId: string | undefined,
  sessions: SessionInfo[],
): string | undefined {
  if (!originSessionId || sessions.length <= 1) return undefined
  const session = sessions.find(s => s.sessionId === originSessionId)
  if (!session) return undefined
  const name = session.name?.trim() || originSessionId
  const provider = session.provider?.trim()
  return provider ? `${name} · ${provider}` : name
}

/**
 * #6626 — recover the RAW permission description from a prompt message's stored
 * `content`. `handlePermissionRequest` composes `content` as `"${tool}: ${description}"`
 * (or the bare `tool` when the description is empty — see message-handler.ts).
 * `PermissionPrompt` re-prepends `"${tool}: "` itself, so feeding it the composed
 * `content` as its `description` prop doubled the tool label — the reported
 * `shell: shell: …` on Codex shell approvals (and any provider's prompt). Inverting
 * the exact composition here keeps the single source of truth in the message-handler
 * while stripping the redundant leading `"${tool}: "` before the card re-adds it.
 * Only the FIRST occurrence of the prefix is removed, so a description that itself
 * legitimately begins with `"${tool}: "` is preserved intact.
 */
export function permissionPromptDescription(content: string, tool?: string): string {
  if (!tool) return content
  if (content === tool) return ''
  const prefix = `${tool}: `
  return content.startsWith(prefix) ? content.slice(prefix.length) : content
}

/**
 * The custom chat-message renderer (#5560): permission prompts, question
 * prompts, tool bubbles/groups, the evaluator-rewrite banner, and the
 * stream-stall / ask-user-question-stall / resume-unknown chips.
 *
 * Pure move out of App.tsx — the branch ladder, every prop, and the 14-entry
 * deps array are byte-identical to the inline `renderMessage` useCallback. The
 * renderer components are imported here instead of in App.
 */
export function useMessageRenderer(args: UseMessageRendererArgs): (msg: ChatViewMessage) => ReactNode {
  const {
    storeMsgMap,
    chatToolGroupPayloads,
    chatTailMessageId,
    sendPermissionResponse,
    sendUserQuestionResponse,
    markPromptAnswered,
    storeMessages,
    sendInput,
    streamStallTimeoutMs,
    allowMultiQuestionForm,
    activeSessionProvider,
    activeSessionCaps,
    setViewMode,
    stalledPromptIds,
    hasPendingAskUserQuestionPermission,
    sessions,
  } = args

  return useCallback((msg: ChatViewMessage) => {
    // Tool-group synthetic row (#3747) — id is a group key, not a store id.
    if (msg.type === 'tool_group') {
      const payload = chatToolGroupPayloads.get(msg.id)
      if (!payload) return null
      // #4305 — keep the trailing group expanded so the Chat tab matches
      // Output-tab chronology when a turn ends on a tool run with no
      // follow-up summary.
      return (
        <ToolGroup
          messages={payload.messages}
          isActive={payload.isActive}
          isTail={msg.id === chatTailMessageId}
        />
      )
    }
    const storeMsg = storeMsgMap.get(msg.id)
    if (!storeMsg) return null

    // Permission prompt
    if (storeMsg.requestId && storeMsg.expiresAt && !storeMsg.answered) {
      // #3619 wall-clock site (kept on `Date.now()` intentionally).
      // `storeMsg.expiresAt` is computed at receipt as
      // `Date.now() + msg.remainingMs` in `message-handler.ts`, so this
      // subtraction is wall-clock-vs-wall-clock — both sides use the
      // same clock, no mixing. Switching this site to `performance.now()`
      // would subtract a process-local monotonic clock from a wall-clock
      // anchor and produce garbage. Wall-clock jumps after receipt do
      // change `Date.now()` and therefore affect each re-computation
      // here — that is correct behavior for a wall-clock anchor.
      // Whatever value falls out is what feeds `<PermissionPrompt>`'s
      // local countdown anchor as its initial `remainingMs` prop.
      const remainingMs = Math.max(0, storeMsg.expiresAt - Date.now())
      return (
        <PermissionPrompt
          requestId={storeMsg.requestId}
          tool={storeMsg.tool || 'Unknown'}
          // #6626 — pass the RAW description, not the composed `"<tool>: <desc>"`
          // `content`; PermissionPrompt re-prepends `"<tool>: "` (double label otherwise).
          description={permissionPromptDescription(storeMsg.content, storeMsg.tool)}
          remainingMs={remainingMs}
          onRespond={(reqId, decision, editedInput, reason) => sendPermissionResponse(reqId, decision, editedInput, reason)}
          sessionLabel={buildSessionLabel(storeMsg.originSessionId, sessions)}
        />
      )
    }

    // Question prompt (options or free-text fallback)
    if (storeMsg.type === 'prompt' && storeMsg.options && !storeMsg.requestId) {
      // #4615 — suppress unanswered prompts that have been invalidated by
      // a subsequent ASK_USER_QUESTION_STALL. The chip rendered for the
      // stall error carries the retry affordance; leaving the interactive
      // prompt visible would let the user submit answers into a dead
      // _pendingUserAnswer slot. Already-answered prompts still render
      // (their answer summary is part of chat history).
      if (stalledPromptIds.has(storeMsg.id)) return null
      return (
        <QuestionPrompt
          question={storeMsg.content}
          options={storeMsg.options}
          questions={storeMsg.questions}
          answered={storeMsg.answered}
          // #4735 / #4731 — SDK / BYOK / Codex / Gemini sessions get the
          // interactive MultiQuestionForm; TUI / CLI sessions keep the
          // #4666 deferred notice (their permission-hook still denies
          // multi-question forms per #4648). Derivation lives at
          // `allowMultiQuestionForm` above so the flag flips correctly
          // on session-switch without a full re-render of every prompt.
          allowMultiQuestion={allowMultiQuestionForm}
          // #5776 — render a SINGLE-question multiSelect as a checkbox form.
          // True wherever a structured multi-answer can be consumed: the
          // SDK-family providers AND claude-tui via the multi-select reinject
          // path. The plain CLI providers (claude-cli, docker-cli) are excluded
          // because their respondToQuestion takes only a single text answer
          // with no answersMap channel. #5795 — single source of truth in
          // @chroxy/store-core (keyed off the registered provider `type`).
          allowSingleMultiSelect={providerSupportsSingleMultiSelect(activeSessionProvider, activeSessionCaps)}
          // #4685 — gate the question content render on the matching
          // AskUserQuestion permission_request being resolved. Pre-fix
          // the user_question card rendered the moment the wire event
          // arrived (which the server emits in parallel with the
          // permission_request), leaking the model-supplied question
          // text + options before the user had a chance to click Allow.
          // The derivation `hasPendingAskUserQuestionPermission` scans
          // the same session's messages for any AskUserQuestion
          // permission prompt that is still unresolved on both this
          // client and across clients. Already-answered prompts skip the
          // gate so post-answer chat history renders normally.
          pendingPermission={!storeMsg.answered && hasPendingAskUserQuestionPermission}
          onSelect={(answer) => {
            // #4604 Chunk B / #4735 — answer is `string` for
            // single-question / free-text paths and
            // `Record<string, string | string[]>` for multi-question
            // forms (multi-select values are native arrays on the
            // widened wire). sendUserQuestionResponse handles both
            // shapes; markPromptAnswered records a string summary on
            // the bubble so the post-answer collapse UI has something
            // readable to show.
            sendUserQuestionResponse(answer, storeMsg.toolUseId)
            markPromptAnswered(storeMsg.id, formatQuestionAnswerSummary(answer))
          }}
        />
      )
    }

    // Tool bubble
    if (storeMsg.type === 'tool_use' && storeMsg.toolUseId) {
      // #4313 — singleton activity runs (a single trailing tool_use)
      // bypass the ToolGroup path entirely: `chatToolGroupPayloads`
      // only collapses contiguous runs of 2+ messages (see above,
      // ~line 897). Pass the same `isTail` signal that ToolGroup uses
      // (#4309) so the Chat tab's last item matches Output-tab
      // chronology in the 1-tool case too. Without this, a turn
      // shaped `summary text -> 1 trailing tool` skipped the #4309
      // mitigation entirely and the trailing tool rendered collapsed
      // while Output still showed it inline.
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

    // #3188: auto-evaluator rewrite banner. The system message is pushed
    // by the dashboard's `evaluator_rewrite` handler and persisted in
    // the per-session localStorage cache (`sessionMessagesKey` in
    // packages/dashboard/src/store/persistence.ts). Reconnect/replay
    // re-renders the banner from that cached metadata — no need to
    // re-fire the transient wire event.
    if (storeMsg.type === 'system' && storeMsg.evaluator?.kind === 'rewrite') {
      return <EvaluatorRewriteBanner meta={storeMsg.evaluator} />
    }

    // #6768: distinct "Context compacted" marker for a parsed
    // compact_boundary SDK/CLI event (sdk-session.js / cli-session.js),
    // replacing the generic muted system bubble that used to show the
    // literal string `compact_boundary`.
    if (storeMsg.type === 'system' && storeMsg.compactMetadata) {
      return <CompactionMarker meta={storeMsg.compactMetadata} />
    }

    // #4476: distinct chip for stream-stall errors (server PR #4475 emits
    // `error{code: 'stream_stall'}` after the configured inactivity window).
    // Generic red bubble reads as "broken"; this affordance signals
    // "recoverable, just retry" and offers a one-tap resend of the last
    // user message. Only render the retry button when the stall is the
    // most recent bubble (chatTailMessageId) — replayed historical stalls
    // surface the chip text + tooltip for diagnostics, but resending an
    // ancient user_input from a long-finished turn would be misleading.
    //
    // #4603: thread the active session's provider through so the chip
    // headline can carry a short label ("SDK · ...", "CLI · ...") for
    // one-glance triage, and hand the View-logs affordance a closure
    // that switches the view to the System pane (where session-level
    // context lives). The View-logs button is only shown on the tail
    // entry — replaying historical stalls shouldn't offer to jump the
    // operator out of the chat for an old event.
    if (storeMsg.type === 'error' && storeMsg.code === 'stream_stall') {
      const isTail = msg.id === chatTailMessageId
      const lastUserInput = isTail
        ? [...storeMessages].reverse().find(m => m.type === 'user_input')
        : undefined
      return (
        <StreamStallChip
          errorText={storeMsg.content}
          onRetry={lastUserInput ? () => sendInput(lastUserInput.content) : undefined}
          timeoutMs={streamStallTimeoutMs ?? undefined}
          provider={activeSessionProvider ?? undefined}
          onViewLogs={isTail ? () => setViewMode('system') : undefined}
        />
      )
    }

    // #4615 / #5793: dedicated chip for retryable AskUserQuestion teardown
    // errors. The server emits ASK_USER_QUESTION_STALL (PR #4614) plus five
    // MULTISELECT/MULTI_QUESTION codes (see `isRetryableAskUserQuestionError`)
    // when the Claude TUI never acknowledges an AskUserQuestion answer or
    // denies a multi-select / multi-question form — all carry "Tap Retry" in
    // their copy. Generic red toast reads as "broken"; this affordance
    // signals "recoverable, just retry your original request" and offers a
    // one-tap resend of the last user message. Mirrors the StreamStallChip
    // pattern (#4476): retry only on tail entries so replayed historical
    // stalls show the chip + tooltip for diagnostics but don't offer a
    // misleading resend button.
    if (storeMsg.type === 'error' && isRetryableAskUserQuestionError(storeMsg.code)) {
      const isTail = msg.id === chatTailMessageId
      const lastUserInput = isTail
        ? [...storeMessages].reverse().find(m => m.type === 'user_input')
        : undefined
      return (
        <AskUserQuestionStallChip
          errorText={storeMsg.content}
          onRetry={lastUserInput ? () => sendInput(lastUserInput.content) : undefined}
        />
      )
    }

    // #4947 / #5006: dedicated chip for the two resume-failure error codes:
    //   - `error{code: 'resume_unknown'}` (server PR #4944) — RECOVERABLE.
    //     CliSession has ALREADY auto-fallen-back to a fresh conversation
    //     by the time this lands; chip renders the polite "starting fresh"
    //     copy.
    //   - `error{code: 'resume_unknown_exhausted'}` (server PR #5004) —
    //     TERMINAL. The post-fallback retry ALSO failed; the server has
    //     stopped auto-respawning and the chip renders the "auto-recovery
    //     exhausted, start a fresh session manually" copy + assertive
    //     `role="alert"` so AT users get the urgency signal.
    // Both variants surface `attemptedResumeId` as subtext for operator
    // correlation against `~/.chroxy/session-state.json.resumeConversationId`.
    // Distinct from the stream_stall / ASK_USER_QUESTION_STALL chips
    // because no retry affordance is needed (recoverable: fresh conversation
    // already running; exhausted: user must start a new session manually).
    if (
      storeMsg.type === 'error' &&
      (storeMsg.code === 'resume_unknown' || storeMsg.code === 'resume_unknown_exhausted')
    ) {
      return (
        <ResumeUnknownChip
          variant={storeMsg.code === 'resume_unknown_exhausted' ? 'exhausted' : 'recoverable'}
          errorText={storeMsg.content}
          attemptedResumeId={storeMsg.attemptedResumeId}
        />
      )
    }

    // Default rendering
    return null
  }, [storeMsgMap, chatToolGroupPayloads, chatTailMessageId, sendPermissionResponse, sendUserQuestionResponse, markPromptAnswered, storeMessages, sendInput, streamStallTimeoutMs, allowMultiQuestionForm, activeSessionProvider, activeSessionCaps, setViewMode, stalledPromptIds, hasPendingAskUserQuestionPermission, sessions])
}
