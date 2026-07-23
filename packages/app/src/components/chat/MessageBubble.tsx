import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  LayoutAnimation,
} from 'react-native';
import { OTHER_OPTION_VALUE, bumpRenderCount, formatThinkingFooter, getErrorPresentation, isRetryableAskUserQuestionError, isSingleMultiSelectForm } from '@chroxy/store-core';
// #4875: `OtherFreeformAnswer` moved to @chroxy/store-core/freeform-answer
// so the mobile store, the mobile screen, and (eventually) the dashboard
// can converge on a single declaration paired with the shared
// `isFreeformAnswer` guard. Re-exported below for the existing call sites
// (SessionScreen, ChatView, MessageBubble's own onSelectOption signature).
import type { OtherFreeformAnswer } from '@chroxy/store-core';
import type { ChatMessage, ToolResultImage, SessionInfo } from '../../store/connection';
import { useConnectionStore } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import { FormattedResponse } from '../MarkdownRenderer';
import { PermissionDetailOrFallback, PermissionCountdown, PermissionPill, permissionStyles } from '../PermissionDetail';
import { PreWriteDiffReview, isReviewableTool } from '../PreWriteDiffReview';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolBubble } from './ToolBubble';
import { StreamStallChip } from '../StreamStallChip';
import { ResumeUnknownChip } from '../ResumeUnknownChip';
import { MultiQuestionForm } from './MultiQuestionForm';
import type { MultiQuestionAnswersMap } from './MultiQuestionForm';

/**
 * #4755 — single-question Other / freeform answer payload (mobile parity
 * with the dashboard's `OtherFreeformAnswer`, see #4651 / PR #4753).
 *
 * When the user picks the synthesized "Other" option (`OTHER_OPTION_VALUE`)
 * and types freeform text, the bubble emits this object shape instead of
 * the typed string. SessionScreen forwards it to `sendUserQuestionResponse`,
 * which serializes `{answer: <otherLabel>, freeformText: <typed>}` on the
 * wire so the server can drive a two-stage TUI write (Other digit → text-
 * input prompt → freeform text + Enter) — sidestepping claude TUI's
 * single-character jump-nav (#4288) that would otherwise wedge the menu.
 *
 * The legacy string path is preserved for regular option taps and zero-
 * options free-text-only AskUserQuestions (#1245) so older servers that
 * ignore `freeformText` keep working unchanged.
 */
// #4875: the interface itself lives in `@chroxy/store-core/freeform-answer`
// (single source of truth, paired with the `isFreeformAnswer` guard); re-
// exported here for downstream importers (ChatView, SessionScreen) that
// already pull `SelectOptionValue` from this file. Keeping the re-export
// avoids churning every existing call site for the type alias.
export type { OtherFreeformAnswer };

export type SelectOptionValue = string | OtherFreeformAnswer;

/**
 * #5674 — mobile parity with the dashboard's `buildSessionLabel` (#5667):
 * a short "which session is asking" label for a permission prompt, derived
 * from the message's `originSessionId`. Returns undefined when there's no
 * origin, the owning session is unknown, or only one session exists (nothing
 * to disambiguate) — so single-session users see no extra chrome.
 */
export function buildPromptSessionLabel(
  originSessionId: string | undefined,
  sessions: SessionInfo[],
): string | undefined {
  if (!originSessionId || sessions.length <= 1) return undefined;
  const session = sessions.find((s) => s.sessionId === originSessionId);
  if (!session) return undefined;
  const name = session.name?.trim() || originSessionId;
  const provider = session.provider?.trim();
  return provider ? `${name} · ${provider}` : name;
}

/**
 * #6756 + #6391 footer-stat — content-capable thinking view. The mobile parity
 * of the dashboard's `ThinkingBody`: a quiet collapsible disclosure ("▸
 * Thinking…" while streaming, and once done a compact turn-footer stat "▸
 * thought for 4.2s · 128 tokens") that reveals the model's reasoning text on
 * tap. The footer degrades gracefully — the server stamps `durationMs` on the
 * thinking stream_end, but old sessions (and the token count, which the claude
 * SDK/BYOK providers can't cleanly separate) may be absent; with neither stat
 * the label falls back to a bare "Thought". Used only when a thinking bubble
 * actually carries reasoning content; an empty thinking bubble (the ephemeral
 * placeholder) keeps the `ThinkingIndicator` animation.
 */
function ThinkingBubble({ content, streaming, truncated, durationMs, tokens }: { content: string; streaming: boolean; truncated?: boolean; durationMs?: number; tokens?: number }) {
  const [expanded, setExpanded] = useState(false);
  // Compose the footer from whatever stats arrived; empty when none, so we fall
  // back to a bare "Thought" (old sessions / no measured stats).
  const footer = formatThinkingFooter({ durationMs, tokens });
  const label = streaming ? 'Thinking…' : (footer || 'Thought');
  return (
    <View style={styles.thinkingBubble} testID="thinking-bubble">
      <TouchableOpacity
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setExpanded((v) => !v);
        }}
        testID="thinking-toggle"
        accessibilityRole="button"
        accessibilityLabel={streaming ? 'Thinking' : (footer || 'Thought')}
        // Small horizontal hitSlop for comfort past the text's visual bounds;
        // the ≥44pt minimum on both axes is carried by the style's
        // minHeight/minWidth (see thinkingToggleTouchable).
        hitSlop={{ top: 0, right: 8, bottom: 0, left: 8 }}
        style={styles.thinkingToggleTouchable}
      >
        <Text style={styles.thinkingToggle}>
          {expanded ? '▾' : '▸'} {label}
        </Text>
      </TouchableOpacity>
      {expanded && (
        <Text style={styles.thinkingContent} testID="thinking-content" selectable>
          {content}
          {/* #6756 — the store bounded this bubble at MAX_THINKING_CONTENT_LEN
              and dropped further deltas; say so instead of cutting silently. */}
          {truncated ? '\n… [thinking truncated]' : ''}
        </Text>
      )}
    </View>
  );
}

function MessageBubbleImpl({ message, queued, onCancelQueued, onEditQueued, onSelectOption, onSubmitMultiQuestion, allowMultiQuestion, allowSingleMultiSelect, isSelected, isSelecting, onLongPress, onPress, onOpenDetail, onImagePress, onRetryStreamStall, getInitialExpanded, onExpandedChange }: {
  message: ChatMessage;
  /**
   * #5938 — true when this `user_input` bubble was sent mid-turn and is sitting
   * in the outgoing queue (awaiting the current turn's completion). Renders a
   * "Queued" badge + cancel affordance under the message body.
   */
  queued?: boolean;
  /** #5938 — cancel this queued follow-up by its message id before it flushes. */
  onCancelQueued?: (id: string) => void;
  /** #6628 — edit this queued follow-up before it flushes: reopens its text in
   *  the composer and cancels the queued entry. Receives the id and its text. */
  onEditQueued?: (id: string, text: string) => void;
  // #6543 (feature B): `editedInput` carries the operator's per-hunk narrowing
  // from a Write/Edit pre-write-diff review — sent on an Approve so the server
  // writes only the kept hunks. `null`/omitted = no narrowing (a plain response);
  // the store's sendPermissionResponse drops it for a deny regardless.
  onSelectOption?: (value: SelectOptionValue, messageId: string, requestId?: string, toolUseId?: string, editedInput?: Record<string, string> | null) => void;
  /**
   * #4973 — submit handler for the multi-question form. Fires with the
   * per-question answers map (`Record<string, string | string[]>`) plus
   * the message + toolUseId so SessionScreen can forward it to
   * `sendUserQuestionResponse` (widened in #4761) and record the
   * comma-joined summary via `markPromptAnswered`.
   */
  onSubmitMultiQuestion?: (answersMap: MultiQuestionAnswersMap, messageId: string, toolUseId?: string) => void;
  /**
   * #4973 / #4735 — opt-in flag for SDK-mode sessions to render the
   * interactive `MultiQuestionForm` instead of falling back to the legacy
   * single-question Q[0] UI. TUI / CLI sessions leave this false because
   * the permission-hook (#4648) denies combined multi-question tool_uses
   * there. Mirrors the dashboard's `allowMultiQuestionForm` gate.
   */
  allowMultiQuestion?: boolean;
  /**
   * #5776 — opt-in to render a SINGLE-question multiSelect as the checkbox
   * `MultiQuestionForm` (it handles a length-1 array) instead of single-select
   * option buttons. A multi-select AskUserQuestion from the TUI is almost
   * always one question; without this the user could only pick one. True for
   * the SDK-family providers (alongside `allowMultiQuestion`) and for claude-tui
   * via the multi-select reinject path; off for claude-cli.
   */
  allowSingleMultiSelect?: boolean;
  isSelected: boolean;
  isSelecting: boolean;
  onLongPress: () => void;
  onPress: () => void;
  onOpenDetail: (toolName: string, content: string, toolResult?: string, toolResultTruncated?: boolean, toolResultImages?: ToolResultImage[], serverName?: string) => void;
  onImagePress?: (uri: string) => void;
  /**
   * #4496: retry handler for stream-stall error chips. ChatView wires
   * this only when the stall IS the tail message (mirrors the dashboard's
   * `isTail` gate) — historical replayed stalls receive `undefined` so
   * the chip renders text only without a misleading Retry affordance.
   */
  onRetryStreamStall?: () => void;
  /**
   * #5517: seed + persist row expand state in ChatView's id-keyed registry
   * so it survives FlatList row recycling. Forwarded to the inner ToolBubble
   * (tool rows) and used for the answered-permission collapse toggle.
   */
  getInitialExpanded?: (id: string) => boolean;
  onExpandedChange?: (id: string, expanded: boolean) => void;
}) {
  // #5516 (epic #5514): dev-only render tally. Proves (in the memoization
  // test and ad-hoc dev profiling) that only the tail/streaming bubble
  // re-renders on a delta flush — non-tail bubbles must skip this entirely
  // thanks to the React.memo comparator below. Cheap Map write; never read on
  // the hot path. Stripped from release builds by the `__DEV__` guard.
  if (__DEV__) bumpRenderCount(`MessageBubble:${message.id}`);

  const longPressedRef = useRef(false);
  const [isExpired, setIsExpired] = useState(() =>
    message.expiresAt != null && message.expiresAt <= Date.now()
  );
  // #5517: seed from the ChatView registry so a recycled permission pill
  // reopens to the user's last choice instead of resetting to collapsed.
  const [permissionExpanded, setPermissionExpandedRaw] = useState(
    () => getInitialExpanded?.(message.id) ?? false,
  );
  const setPermissionExpanded = (next: boolean) => {
    setPermissionExpandedRaw(next);
    onExpandedChange?.(message.id, next);
  };
  // #3746: free-text mode when user picks the synthetic "Other" option
  const [otherActive, setOtherActive] = useState(false);
  const [otherText, setOtherText] = useState('');
  // #4755 — when the user clicks the Other option button, stash the option's
  // label so we can emit it alongside the freeform text. The server resolves
  // the label to its 1-indexed TUI digit, writes that digit BEFORE the
  // freeform text so the TUI's text-input prompt is open when the text
  // lands. Default 'Other' covers the synthesized-sentinel case (#3746)
  // where options[*].value === OTHER_OPTION_VALUE but no real option
  // carries that label. Mirrors `QuestionPrompt` in the dashboard (#4651).
  const [otherLabel, setOtherLabel] = useState<string>('Other');
  // #3753: mirror the dashboard's submittedRef — guarantee one-shot send
  // even if the user rapid-taps Send / hits Enter before the store
  // round-trip flips `message.answered`. Reset when the prompt is
  // re-armed (answered cleared by a future flow).
  const submittedRef = useRef(false);
  useEffect(() => {
    if (message.answered == null) submittedRef.current = false;
  }, [message.answered]);
  const isUser = message.type === 'user_input';
  // Chat redesign #6391 (mobile no-bubble): the assistant 'response' prose
  // loses its card and sits on the bare canvas (parity with the dashboard).
  const isAssistant = message.type === 'response';
  const isTool = message.type === 'tool_use';
  const isThinking = message.type === 'thinking';
  const isPrompt = message.type === 'prompt';
  const isError = message.type === 'error';

  // #5699 — answer buttons must be gated on a live connection, not just the
  // text input. The server expires a pending permission/question request when
  // the socket drops, so answering a cached prompt while disconnected can't
  // land (sendPermissionResponse/sendUserQuestionResponse now refuse it). Gate
  // the buttons here so the user sees a disabled, explained control instead of
  // tapping into a silent no-op. Global selector (not session-keyed) — safe.
  const connected = useConnectionLifecycleStore((s) => s.connectionPhase === 'connected');
  const isSystem = message.type === 'system';

  // #5674 — resolve the owning-session label for permission prompts so a user
  // juggling multiple chats can see WHICH session is asking (dashboard parity,
  // #5667). Read via a selector returning a stable string|undefined: non-prompt
  // bubbles (no originSessionId) resolve to undefined and never re-render on a
  // sessions change, and the #5516 memo skip on delta flushes is preserved (the
  // label only changes when the session list itself does).
  const promptSessionLabel = useConnectionStore((s) =>
    buildPromptSessionLabel(message.originSessionId, s.sessions),
  );

  // #6543 (feature B): per-hunk pre-write review. Gated on the server's `ide`
  // capability (features.ide) + a reviewable tool (Write/Edit), mirroring the
  // dashboard's PermissionPrompt. When eligible, pull the full (secret-redacted)
  // tool input via `get_permission_input` and render a diff whose dropped hunks
  // become `editedInput` on Approve.
  const ideEnabled = useConnectionStore((s) => Boolean(s.serverCapabilities?.ide));
  const requestPermissionInput = useConnectionStore((s) => s.requestPermissionInput);
  const pulledInput = useConnectionStore((s) =>
    message.requestId ? s.permissionInputs?.[message.requestId] : undefined,
  );
  const reviewEligible = isPrompt && ideEnabled && isReviewableTool(message.tool);
  const [editedInput, setEditedInput] = useState<Record<string, string> | null>(null);

  // Pull the full tool input once per eligible, unanswered prompt (idempotent —
  // gated on `pulledInput === undefined` so a re-render doesn't re-request).
  useEffect(() => {
    if (reviewEligible && message.requestId && message.answered == null && pulledInput === undefined) {
      requestPermissionInput(message.requestId);
    }
  }, [reviewEligible, message.requestId, message.answered, pulledInput, requestPermissionInput]);

  // Reset "Other" UI mode when the prompt becomes answered (#3746 review).
  // Without this, otherActive would stay true after an answer arrives from
  // another client, and the component's render flags (`showOptionButtons`
  // vs `showFreetextInput`) would depend on lingering local UI state instead
  // of server-authoritative `message.answered`. Belt-and-suspenders alongside
  // the `message.answered != null` gate in showOptionButtons.
  useEffect(() => {
    if (isPrompt && message.answered != null && otherActive) {
      setOtherActive(false);
      setOtherText('');
    }
  }, [isPrompt, message.answered, otherActive]);
  // #4973 — multi-question AskUserQuestion: render the interactive
  // `MultiQuestionForm` (all N questions) instead of the legacy
  // single-question Q[0] UI when (a) the payload carries more than one
  // question, (b) the session is SDK-mode (`allowMultiQuestion`, mirrors
  // the dashboard's `allowMultiQuestionForm` gate), and (c) the prompt is
  // unanswered. Once answered we render the comma-joined summary chip
  // instead. TUI / CLI sessions (`allowMultiQuestion` false) fall through
  // to the legacy single-question render of Q[0] so the existing
  // single-question pins keep passing.
  const isMultiQuestion =
    isPrompt && Array.isArray(message.questions) && message.questions.length > 1;
  // #5776 — a single-question multiSelect uses the SAME checkbox form +
  // structured-summary path as a multi-question form (the form handles a
  // length-1 array, and submit routes through onSubmitMultiQuestion just like
  // the multi-question case). `useMultiForm` collapses both into one condition:
  // a >1-question form when allowMultiQuestion, OR a single multiSelect when
  // allowSingleMultiSelect (claude-tui reinject + SDK-family; off for claude-cli).
  const isSingleMultiSelect = isPrompt && isSingleMultiSelectForm(message.questions);
  const useMultiForm =
    (isMultiQuestion && !!allowMultiQuestion) || (isSingleMultiSelect && !!allowSingleMultiSelect);
  const showMultiQuestionForm =
    useMultiForm && message.answered == null && !isExpired;
  // #4973 — the per-question structured summary chip needs the
  // `answeredAnswers` map (recorded by `markPromptAnsweredMulti` on the
  // client that submitted). When a multi-question prompt is answered but
  // that map is absent — e.g. it was answered on another client, or
  // rehydrated from history before this field existed — fall back to the
  // flat `message.answered` summary text (Copilot review) so the answer
  // is never shown as blank.
  const hasMultiQuestionAnswers =
    useMultiForm &&
    message.answered != null &&
    message.answeredAnswers != null;
  const showMultiQuestionFallbackSummary =
    useMultiForm &&
    message.answered != null &&
    message.answeredAnswers == null;
  const showMultiQuestionSummary =
    useMultiForm && message.answered != null;
  // #4973 — per-question display labels for the post-answer summary chip.
  // Maps each question's chosen value(s) (from the structured
  // `answeredAnswers` map) back to its option label(s), comma-joined for
  // multi-select. Falls back to the raw value when no matching option is
  // found (defensive — covers free-form values older servers might echo).
  const multiQuestionAnswerLabels = hasMultiQuestionAnswers
    ? (message.questions ?? []).map((q) => {
        const value = message.answeredAnswers?.[q.question];
        const toLabel = (v: string) =>
          q.options.find((o) => o.value === v)?.label ?? v;
        if (Array.isArray(value)) return value.map(toLabel).join(', ');
        if (typeof value === 'string') return toLabel(value);
        return '';
      })
    : [];
  const hasOptions = isPrompt && !!message.options && message.options.length > 0;
  const answeredIsFreeText =
    hasOptions && message.answered != null &&
    !message.options!.some(o => o.value === message.answered);
  // Hide option buttons in free-text-answered case and while user is in
  // "Other" mode without an answer yet. Once an answer arrives, ignore
  // lingering otherActive so the chosen option still renders (e.g. when
  // another client answers while local Other mode is open).
  const showOptionButtons =
    hasOptions && !answeredIsFreeText &&
    // #4973 — suppress the legacy Q[0] option buttons when the
    // interactive multi-question form / summary is rendering.
    !showMultiQuestionForm && !showMultiQuestionSummary &&
    (message.answered != null || !otherActive);
  const showFreetextInput = isPrompt && otherActive && !message.answered && !isExpired;
  // #5699 — when an unanswered, non-expired prompt is showing but we're offline,
  // explain why the (disabled) answer controls can't be used.
  const showDisconnectedAnswerHint =
    isPrompt && !connected && message.answered == null && !isExpired &&
    (hasOptions || useMultiForm || otherActive);

  // Answered permission prompts (with requestId) collapse to a compact pill.
  // user_question prompts (no requestId) are NOT collapsed.
  // Disable pill mode during selection so pills participate in multi-select.
  const showAsPill = isPrompt && message.requestId && message.answered && !permissionExpanded && !isSelecting;

  const handlePress = () => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) onPress();
  };

  const handleLongPress = () => {
    longPressedRef.current = true;
    onLongPress();
  };

  if (isThinking) {
    // #6756 — render the model's reasoning content as an expandable disclosure
    // when present; fall back to the generic animation for the contentless
    // placeholder (or a thinking block that hasn't streamed any text yet).
    const thinkingContent = typeof message.content === 'string' ? message.content : '';
    if (thinkingContent.trim().length > 0) {
      return (
        <ThinkingBubble
          content={thinkingContent}
          streaming={message.thinkingStreaming === true}
          truncated={message.thinkingTruncated === true}
          durationMs={message.thinkingDurationMs}
          tokens={message.thinkingTokens}
        />
      );
    }
    return <ThinkingIndicator />;
  }

  if (isTool) {
    return (
      <ToolBubble
        message={message}
        isSelected={isSelected}
        isSelecting={isSelecting}
        onToggleSelection={onPress}
        onOpenDetail={onOpenDetail}
        getInitialExpanded={getInitialExpanded}
        onExpandedChange={onExpandedChange}
      />
    );
  }

  // #4496 / #5793: distinct chip for stream-stall errors (server PR #4475
  // emits `error{code: 'stream_stall'}` after the configured inactivity
  // window) AND for the retryable AskUserQuestion teardown codes
  // (ASK_USER_QUESTION_STALL + five MULTISELECT/MULTI_QUESTION codes — see
  // `isRetryableAskUserQuestionError`). Both end in "Tap Retry" copy; a
  // generic red bubble reads as "broken", so this affordance signals
  // "recoverable, just retry". `onRetryStreamStall` is only wired by
  // ChatView when this is the tail message — historical replayed stalls
  // render the chip text with the raw error reachable on long-press, but no
  // retry button (resending an ancient user_input from a long-finished turn
  // would be misleading).
  if (isError && (message.code === 'stream_stall' || isRetryableAskUserQuestionError(message.code))) {
    return (
      <StreamStallChip
        errorText={message.content?.trim() || ''}
        onRetry={onRetryStreamStall}
        // #5793 / #6392: the AskUserQuestion teardown codes are a question-
        // delivery failure, not a stream stall — source the copy from the shared
        // error-presentation registry (single source cross-surface). stream_stall
        // falls through to the chip's registry-sourced default.
        headline={
          isRetryableAskUserQuestionError(message.code)
            ? getErrorPresentation(message.code).headline
            : undefined
        }
      />
    );
  }

  // #4971 / #5006: dedicated chip for the two resume-failure error codes:
  //   - `error{code: 'resume_unknown'}` (server PR #4944, dashboard #4947,
  //     mobile #4971) — RECOVERABLE. CliSession has already auto-fallen-
  //     back to a fresh conversation by the time this lands; chip renders
  //     the polite "starting fresh" headline.
  //   - `error{code: 'resume_unknown_exhausted'}` (server PR #5004) —
  //     TERMINAL. The post-fallback retry ALSO failed; chip renders the
  //     "auto-recovery exhausted, start a new session manually" headline
  //     so the user knows auto-recovery has given up.
  // Both variants surface `attemptedResumeId` as subtext for operator
  // correlation against `~/.chroxy/session-state.json.resumeConversationId`.
  if (
    isError &&
    (message.code === 'resume_unknown' || message.code === 'resume_unknown_exhausted')
  ) {
    return (
      <ResumeUnknownChip
        variant={message.code === 'resume_unknown_exhausted' ? 'exhausted' : 'recoverable'}
        // #4971 review: pass the raw content through (no `.trim()`) so
        // any meaningful trailing context / newlines the server includes
        // (e.g. wrapped CLI stderr) survive end-to-end into the chip's
        // `accessibilityHint`. Matches the dashboard call site, which
        // forwards `message.content` verbatim.
        errorText={message.content ?? ''}
        attemptedResumeId={message.attemptedResumeId}
      />
    );
  }

  if (showAsPill) {
    return (
      <PermissionPill
        message={message}
        onExpand={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setPermissionExpanded(true);
        }}
      />
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      onLongPress={isSelecting ? undefined : handleLongPress}
      // #4697: `approval-card-<id>` testID lets Maestro pin the AskUserQuestion
      // and permission-request approve/deny render path on the real RN runtime.
      // Applied to every bubble (cheap, deterministic, and lets the test
      // assert on a stable per-message anchor instead of brittle text matching).
      testID={`approval-card-${message.id}`}
      style={[styles.messageBubble, isAssistant && styles.assistantBubble, isUser && styles.userBubble, isPrompt && styles.promptBubble, isError && styles.errorBubble, isSystem && styles.systemBubble, isSelected && styles.selectedBubble]}
    >
      <View style={isPrompt && message.expiresAt && !message.answered ? styles.promptHeaderRow : undefined}>
        <Text
          // #4697: header testID — Maestro multi-question flow asserts on this
          // to pin the first-question render (MessageBubble renders Q[0]; the
          // server-side multi-question payload still arrives in `message.questions`,
          // which downstream renderers will iterate once multi-question UI lands).
          testID={isPrompt ? `approval-question-0` : undefined}
          style={isUser ? styles.senderLabelUser : isPrompt ? styles.senderLabelPrompt : isError ? styles.senderLabelError : isSystem ? styles.senderLabelSystem : styles.senderLabelClaude}>
          {isUser ? 'You' : isPrompt ? (message.tool || 'Action Required') : isError ? 'Error' : isSystem ? 'System' : 'Claude'}
        </Text>
        {isPrompt && !message.answered && message.expiresAt && (
          <PermissionCountdown expiresAt={message.expiresAt} onExpire={() => setIsExpired(true)} />
        )}
      </View>
      {/* #5674 — which session is asking. Rendered as its own line under the
          header so it never crowds the tool name / countdown row, and only on
          an UNANSWERED prompt with 2+ sessions to disambiguate. Intentionally
          broader than the dashboard (which labels only live permission
          prompts): an AskUserQuestion prompt benefits from the same "which
          chat wants my input" attribution, so we gate on the prompt being
          live rather than on requestId. Answered+collapsed permission prompts
          take the PermissionPill early-return above and never reach here. */}
      {isPrompt && !message.answered && promptSessionLabel && (
        <Text
          testID="prompt-session-label"
          style={styles.promptSessionLabel}
          numberOfLines={1}
        >
          {promptSessionLabel}
        </Text>
      )}
      {/* #4973 — when the multi-question form / summary renders, suppress
          the body content Text. The top-level `message.content` mirrors
          Q[0]'s question (store-core handleUserQuestion), so rendering it
          here would duplicate Q[0] above the form. The form / summary
          renders every question itself. */}
      {showMultiQuestionForm || showMultiQuestionSummary ? null :
        isPrompt && message.toolInput ? (
        <PermissionDetailOrFallback tool={message.tool} toolInput={message.toolInput} fallback={message.content?.trim() || ''} />
      ) : !isUser && !isPrompt && !isError && !isSystem ? (
        <FormattedResponse content={message.content?.trim() || ''} messageTextStyle={styles.messageText} />
      ) : (
        <Text selectable style={[styles.messageText, isUser && styles.userMessageText, isError && styles.errorMessageText, isSystem && styles.systemMessageText]}>
          {message.content?.trim()}
        </Text>
      )}
      {isUser && message.attachments && message.attachments.length > 0 && (
        <View style={styles.attachmentRow}>
          {message.attachments.map((att) => (
            att.type === 'image' ? (
              <TouchableOpacity key={att.id} onPress={() => onImagePress?.(att.uri)} accessibilityRole="button" accessibilityLabel={`View ${att.name}`}>
                <Image source={{ uri: att.uri }} style={styles.attachmentThumbnail} />
              </TouchableOpacity>
            ) : (
              <View key={att.id} style={styles.attachmentChip}>
                <Icon name="document" size={14} color={COLORS.textMuted} />
                <Text style={styles.attachmentChipName} numberOfLines={1}>{att.name}</Text>
              </View>
            )
          ))}
        </View>
      )}
      {/* #5938 — queued follow-up: a "Queued" badge + cancel affordance under
          a user bubble sent mid-turn. The server flushes it when the current
          turn completes; tapping × cancels it before then. Only on user bubbles
          flagged queued by ChatView (via the per-session queue). */}
      {isUser && queued && (
        <View style={styles.queuedRow} testID={`msg-queued-${message.id}`}>
          <Text style={styles.queuedLabel}>Queued</Text>
          {onEditQueued && (
            <TouchableOpacity
              onPress={() => onEditQueued(message.id, typeof message.content === 'string' ? message.content : '')}
              // #6628 — ~44pt tap target (vertical via top/bottom:14). Horizontal
              // hitSlop is ASYMMETRIC so Edit's and Cancel's enlarged targets don't
              // overlap across the row's 10pt gap and dispatch ambiguously: Edit
              // grows LEFT (toward the label), Cancel grows RIGHT (toward the edge),
              // and the facing edges stay small (3 + 3 < 10) so a tap can't hit the
              // wrong — and Cancel is destructive — control.
              hitSlop={{ top: 14, bottom: 14, left: 12, right: 3 }}
              accessibilityRole="button"
              accessibilityLabel="Edit queued message"
              testID={`msg-queued-edit-${message.id}`}
            >
              <Text style={styles.queuedEdit}>Edit</Text>
            </TouchableOpacity>
          )}
          {onCancelQueued && (
            <TouchableOpacity
              onPress={() => onCancelQueued(message.id)}
              // #5938 — pad the tap target to ~44pt (iOS HIG): the "Cancel"
              // text is ~16pt tall, so ≥14pt of vertical hitSlop clears the bar.
              // #6628 — asymmetric horizontal hitSlop (small LEFT toward Edit,
              // full RIGHT toward the edge) so this destructive control's target
              // doesn't overlap Edit's across the 10pt gap.
              hitSlop={{ top: 14, bottom: 14, left: 3, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Cancel queued message"
              testID={`msg-queued-cancel-${message.id}`}
            >
              <Text style={styles.queuedCancel}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {showDisconnectedAnswerHint && (
        <Text testID="prompt-disconnected-hint" style={styles.promptDisconnectedHint}>
          Disconnected — reconnect to respond
        </Text>
      )}
      {showMultiQuestionForm && (
        <MultiQuestionForm
          questions={message.questions!}
          disabled={!connected}
          onSubmit={(answersMap) => {
            if (submittedRef.current) return;
            submittedRef.current = true;
            onSubmitMultiQuestion?.(answersMap, message.id, message.toolUseId);
          }}
        />
      )}
      {hasMultiQuestionAnswers && (
        <View style={styles.multiQuestionSummary} testID="question-multi-summary">
          {message.questions!.map((q, i) => (
            <View key={`s-${i}`} style={styles.multiQuestionSummaryRow}>
              <Icon name="check" size={14} color={COLORS.accentGreen} />
              <Text
                style={styles.multiQuestionSummaryText}
                testID={`question-multi-summary-${i}`}
              >
                {q.question}: {multiQuestionAnswerLabels[i]}
              </Text>
            </View>
          ))}
        </View>
      )}
      {showMultiQuestionFallbackSummary && (
        // #4973 — answered elsewhere / rehydrated without the structured
        // `answeredAnswers` map: render the flat comma-joined summary so
        // the answer is never blank (Copilot review).
        <View style={styles.multiQuestionSummary} testID="question-multi-summary">
          <View style={styles.multiQuestionSummaryRow}>
            <Icon name="check" size={14} color={COLORS.accentGreen} />
            <Text style={styles.multiQuestionSummaryText} testID="question-multi-summary-flat">
              {message.answered}
            </Text>
          </View>
        </View>
      )}
      {/* #6543 (feature B): the per-hunk pre-write diff review — rendered between
          the permission detail and the option buttons, only when features.ide is
          on (serverCapabilities.ide), the tool is reviewable (Write/Edit), and the
          pulled input has landed. Dropped hunks become `editedInput` sent on
          Approve. A refusal / not-yet-pulled state renders nothing (plain Allow). */}
      {reviewEligible && showOptionButtons && message.answered == null && !isExpired && pulledInput?.found && pulledInput.input && (
        <PreWriteDiffReview
          tool={message.tool ?? ''}
          input={pulledInput.input as Record<string, unknown>}
          onEditedInputChange={setEditedInput}
        />
      )}
      {showOptionButtons && (
        <View style={styles.promptOptions}>
          {message.options!.map((opt, i) => {
            const isAnswered = message.answered != null;
            // #5699 — also disable while disconnected: the answer can't reach
            // the (now-expired) pending request, so the control must not look
            // tappable.
            const isDisabled = isAnswered || isExpired || !connected;
            const isChosen = message.answered === opt.value;
            return (
              <TouchableOpacity
                key={i}
                // #4697: `approval-button-<value>` lets Maestro flows tap
                // by semantic intent when the mock-server emits a known
                // value (e.g. 'approve' / 'deny' for the AskUserQuestion
                // fixture). The value-based id is the stable assertion
                // anchor for E2E coverage of the v0.9.x prompt-delivery
                // wedge surface (#4668 / #4679 / #4687 / #4648 / #4669).
                testID={`approval-button-${opt.value}`}
                style={[
                  styles.promptOptionButton,
                  isDisabled && !isChosen && styles.promptOptionDisabled,
                  isChosen && styles.promptOptionChosen,
                ]}
                accessibilityRole="button"
                // #5634 — combine the option label with the tool context so a
                // screen-reader user hears what they are approving/denying
                // (e.g. "Approve, Bash(rm …)"). `message.tool` is the same tool
                // string shown in the bubble header.
                accessibilityLabel={
                  message.tool ? `${opt.label}, ${message.tool}` : opt.label
                }
                accessibilityState={{ disabled: isDisabled, selected: isChosen }}
                disabled={isDisabled}
                onPress={() => {
                  if (opt.value === OTHER_OPTION_VALUE) {
                    // #4755 — capture the label of the option the user
                    // actually clicked so the freeform payload carries the
                    // right label for the server's digit lookup. Synthetic
                    // sentinel options use the label 'Other'; model-supplied
                    // custom labels (rare) preserve their text. Mirrors the
                    // dashboard's QuestionPrompt (#4651).
                    setOtherLabel(opt.label || 'Other');
                    setOtherActive(true);
                    return;
                  }
                  // #3792: gate the option-button path through the same
                  // one-shot guard as the free-text path. Otherwise the
                  // sequence Send → Cancel → tap-option (while the
                  // initial Send is still in flight over a cellular
                  // tunnel) fires two user_question_response messages.
                  if (submittedRef.current) return;
                  submittedRef.current = true;
                  // #6543 (feature B): forward the per-hunk narrowing on an
                  // Approve. `editedInput` is null for non-reviewable prompts and
                  // when every hunk is kept; the store's sendPermissionResponse
                  // drops it for a deny, so passing it unconditionally is safe.
                  onSelectOption?.(opt.value, message.id, message.requestId, message.toolUseId, editedInput);
                }}
              >
                <Text style={[
                  styles.promptOptionText,
                  isDisabled && !isChosen && styles.promptOptionTextDisabled,
                  isChosen && styles.promptOptionTextChosen,
                ]}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      {showFreetextInput && (
        <View style={styles.promptFreetextRow}>
          <TextInput
            value={otherText}
            onChangeText={setOtherText}
            placeholder="Type your response…"
            placeholderTextColor={COLORS.textSecondary}
            style={styles.promptFreetextInput}
            // #4755 — testID anchors the freeform input for both unit
            // tests and Maestro flows. Pairs with `approval-freetext-send`
            // on the Send button so flows can drive Other-mode end-to-end.
            testID="approval-freetext-input"
            autoFocus
            onSubmitEditing={() => {
              const trimmed = otherText.trim();
              // #5699/#6079 — gate the Enter-key path on a live connection too
              // (the Send button is already disabled). Critically, bail BEFORE
              // latching submittedRef: a disconnected submit can't land, and
              // setting the one-shot guard here would block the legitimate retry
              // after reconnect (the guard only resets when message.answered
              // changes, which never happens for a refused answer).
              if (!trimmed || !connected || submittedRef.current) return;
              submittedRef.current = true;
              // #4755 — when the user reached this input by clicking the
              // synthesized "Other" option (otherActive true), emit the
              // structured `{otherLabel, freeformText}` payload so the
              // server can drive the two-stage TUI write. When otherActive
              // is false the user is in the zero-options free-text-only
              // path (#1245) — keep emitting a plain string so the
              // server's existing free-text handler continues to work
              // unchanged. Mirrors dashboard handleSubmit (#4651).
              const payload: SelectOptionValue = otherActive
                ? { otherLabel, freeformText: trimmed }
                : trimmed;
              onSelectOption?.(payload, message.id, message.requestId, message.toolUseId);
            }}
            returnKeyType="send"
          />
          <TouchableOpacity
            style={[styles.promptFreetextSend, (!otherText.trim() || !connected) && styles.promptOptionDisabled]}
            // #5699 — also block the freeform Send while disconnected.
            disabled={!otherText.trim() || !connected}
            accessibilityRole="button"
            // #5634 — name the freeform response in the tool context.
            accessibilityLabel={message.tool ? `Send response, ${message.tool}` : 'Send response'}
            accessibilityState={{ disabled: !otherText.trim() || !connected }}
            // #4755 — see input testID comment above.
            testID="approval-freetext-send"
            onPress={() => {
              const trimmed = otherText.trim();
              if (!trimmed || submittedRef.current) return;
              submittedRef.current = true;
              // #4755 — see onSubmitEditing comment above. Both paths
              // (Enter key + Send button tap) must emit the same shape.
              const payload: SelectOptionValue = otherActive
                ? { otherLabel, freeformText: trimmed }
                : trimmed;
              onSelectOption?.(payload, message.id, message.requestId, message.toolUseId);
            }}
          >
            <Text style={styles.promptFreetextSendText}>Send</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.promptFreetextCancel}
            accessibilityRole="button"
            // #5634 — cancel the freeform response and return to the options.
            accessibilityLabel="Cancel response"
            testID="approval-freetext-cancel"
            onPress={() => {
              setOtherActive(false);
              setOtherText('');
            }}
          >
            <Text style={styles.promptFreetextCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
      {answeredIsFreeText && (
        <Text style={styles.promptFreetextAnswered}>{message.answered}</Text>
      )}
      {isPrompt && message.requestId && message.answered && permissionExpanded && (
        <Text style={permissionStyles.permissionInfoNote}>
          Claude sees the tool result, not your approval decision.
        </Text>
      )}
      {isPrompt && message.requestId && message.answered && permissionExpanded && (
        <TouchableOpacity
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setPermissionExpanded(false);
          }}
          style={permissionStyles.collapseLink}
        >
          <Text style={permissionStyles.collapseLinkText}>Collapse</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

/**
 * #5516 (epic #5514): memoize the bubble so a streaming delta flush only
 * re-renders the ONE message whose content changed — the rest of the
 * transcript skips React reconciliation (and, crucially, the markdown
 * re-parse inside FormattedResponse) entirely.
 *
 * The store's flush replaces ONLY the streamed message's object (`{ ...m,
 * content: m.content + d }` in `flushPendingDeltas`) — every non-tail message
 * keeps its identity across the flush. So a reference check on `message` is
 * both correct and the cheapest possible comparator for the data half.
 *
 * The callback props (`onPress`, `onLongPress`, `onSelectOption`,
 * `onSubmitMultiQuestion`, `onOpenDetail`, `onImagePress`) are recreated by
 * ChatView on every render, so comparing them by identity would defeat the
 * memo — we intentionally ignore them. `onRetryStreamStall` is the one
 * callback whose PRESENCE (not identity) changes render output (the stall
 * chip's Retry affordance is wired only on the tail), so we compare it as a
 * boolean. The remaining render-affecting props are scalar booleans.
 */
export const MessageBubble = React.memo(MessageBubbleImpl, (prev, next) => {
  return (
    prev.message === next.message &&
    prev.isSelected === next.isSelected &&
    prev.isSelecting === next.isSelecting &&
    prev.allowMultiQuestion === next.allowMultiQuestion &&
    // #5791 — allowSingleMultiSelect gates the single-question multiSelect
    // checkbox form and (unlike allowMultiQuestion) depends on the provider's
    // server-advertised multiSelectReinject capability, which can flip under a
    // live prompt when availableProviders updates. Must be compared or the
    // bubble keeps stale gating (the dashboard re-renders via useMessageRenderer's
    // deps; the app relies on this comparator).
    prev.allowSingleMultiSelect === next.allowSingleMultiSelect &&
    // #5938 — re-render when the queued flag flips (badge appears/clears on
    // enqueue/flush) or the cancel handler's presence changes.
    // #6628 — likewise for the edit handler's presence.
    prev.queued === next.queued &&
    (prev.onCancelQueued == null) === (next.onCancelQueued == null) &&
    (prev.onEditQueued == null) === (next.onEditQueued == null) &&
    (prev.onRetryStreamStall == null) === (next.onRetryStreamStall == null)
  );
});
MessageBubble.displayName = 'MessageBubble';

const styles = StyleSheet.create({
  messageBubble: {
    backgroundColor: COLORS.backgroundSecondary,
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '85%',
  },
  // #6756 — content-capable thinking disclosure (mobile parity with the
  // dashboard's ThinkingBody). Deliberately low-noise: a muted toggle line and,
  // when expanded, the reasoning text. No card chrome.
  thinkingBubble: {
    marginBottom: 12,
    maxWidth: '90%',
  },
  // ≥44pt effective touch target on BOTH axes (repo accessibility minimum —
  // same convention as DiffHunkView's toggle row): the 13pt text line alone is
  // far short of 44pt, so the touchable carries explicit min dimensions and
  // centers the label vertically. alignSelf keeps the target hugging the label
  // instead of stretching the full row width.
  thinkingToggleTouchable: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  thinkingToggle: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  thinkingContent: {
    marginTop: 6,
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  // Chat redesign #6391 (mobile no-bubble): bare assistant response — no card,
  // flush, so a long turn reads like a document. User/prompt/tool keep cards.
  assistantBubble: {
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
    paddingVertical: 2,
    borderRadius: 0,
    marginBottom: 8,
    maxWidth: '100%',
  },
  userBubble: {
    backgroundColor: COLORS.accentBlueLight,
    alignSelf: 'flex-end',
    borderColor: COLORS.accentBlueBorder,
    borderWidth: 1,
  },
  // #5938 — queued-follow-up affordance under a user bubble.
  queuedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 6,
  },
  queuedLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  queuedCancel: {
    color: COLORS.accentRed,
    fontSize: 12,
    fontWeight: '600',
  },
  // #6628 — edit affordance sits left of Cancel; neutral (muted) so Cancel's
  // red stays the only destructive accent in the row.
  queuedEdit: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  attachmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  attachmentThumbnail: {
    width: 80,
    height: 80,
    borderRadius: 8,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    gap: 4,
  },
  attachmentChipName: {
    color: COLORS.textPrimary,
    fontSize: 12,
    maxWidth: 100,
  },
  senderLabelUser: {
    color: COLORS.accentBlue,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  senderLabelClaude: {
    color: COLORS.accentGreen,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  senderLabelPrompt: {
    color: COLORS.accentOrange,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  promptBubble: {
    backgroundColor: COLORS.accentOrangeLight,
    borderColor: COLORS.accentOrangeBorder,
    borderWidth: 1,
    maxWidth: '95%',
  },
  promptHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  promptSessionLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 6,
  },
  promptOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  // #5699 — muted caption shown above the disabled answer controls when offline.
  promptDisconnectedHint: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 8,
  },
  promptOptionButton: {
    backgroundColor: COLORS.accentOrangeMedium,
    paddingHorizontal: 16,
    paddingVertical: 8,
    // #5634 — guarantee a 44pt minimum touch target for the security-sensitive
    // approve/deny taps. paddingVertical 8 alone leaves the button ~30pt.
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentOrangeBorderStrong,
  },
  promptOptionText: {
    color: COLORS.accentOrange,
    fontSize: 14,
    fontWeight: '600',
  },
  promptOptionDisabled: {
    opacity: 0.4,
  },
  promptOptionChosen: {
    backgroundColor: COLORS.accentOrange,
    borderColor: COLORS.accentOrange,
  },
  promptOptionTextDisabled: {
    color: COLORS.textSecondary,
  },
  promptOptionTextChosen: {
    color: '#fff',
  },
  promptFreetextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  promptFreetextInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentOrangeBorderStrong,
    backgroundColor: COLORS.backgroundInput,
    color: COLORS.textPrimary,
    fontSize: 14,
  },
  promptFreetextSend: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: COLORS.accentOrange,
  },
  promptFreetextSendText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  promptFreetextCancel: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.textSecondary,
  },
  promptFreetextCancelText: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  promptFreetextAnswered: {
    marginTop: 10,
    color: COLORS.textSecondary,
    fontSize: 14,
    fontStyle: 'italic',
  },
  multiQuestionSummary: {
    marginTop: 10,
    gap: 6,
  },
  multiQuestionSummaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  multiQuestionSummaryText: {
    flex: 1,
    color: COLORS.textChatMessage,
    fontSize: 14,
    lineHeight: 22, // #6391: relaxed leading reaches the prompt-answer summary (22/14 ≈ 1.57)
  },
  errorBubble: {
    backgroundColor: COLORS.accentRedLight,
    borderColor: COLORS.accentRedBorder,
    borderWidth: 1,
  },
  senderLabelError: {
    color: COLORS.accentRed,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  errorMessageText: {
    color: COLORS.textError,
  },
  systemBubble: {
    backgroundColor: COLORS.accentGrayLight,
    borderColor: COLORS.accentGrayBorder,
    borderWidth: 1,
    alignSelf: 'center',
    maxWidth: '90%',
  },
  senderLabelSystem: {
    color: COLORS.accentGray,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  systemMessageText: {
    color: COLORS.textSystem,
    fontSize: 13,
    lineHeight: 20, // #6391: was RN-default (cramped); relax secondary system notices too
  },
  selectedBubble: {
    borderColor: COLORS.accentBlue,
    borderWidth: 2,
  },
  messageText: {
    color: COLORS.textChatMessage,
    fontSize: 15,
    // Chat redesign #6391 (mobile relaxed scale): 24/15 = 1.60 leading — the
    // dashboard's document ratio. Body stays 15px (the correct phone size); the
    // calmer reading rhythm comes from leading, not glyph size. Propagates to
    // all assistant prose (FormattedResponse inherits this as messageTextStyle).
    lineHeight: 24,
  },
  userMessageText: {
    color: COLORS.textPrimary,
  },
});
