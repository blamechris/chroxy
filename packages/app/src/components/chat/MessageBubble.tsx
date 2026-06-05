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
import { OTHER_OPTION_VALUE } from '@chroxy/store-core';
// #4875: `OtherFreeformAnswer` moved to @chroxy/store-core/freeform-answer
// so the mobile store, the mobile screen, and (eventually) the dashboard
// can converge on a single declaration paired with the shared
// `isFreeformAnswer` guard. Re-exported below for the existing call sites
// (SessionScreen, ChatView, MessageBubble's own onSelectOption signature).
import type { OtherFreeformAnswer } from '@chroxy/store-core';
import type { ChatMessage, ToolResultImage } from '../../store/connection';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import { FormattedResponse } from '../MarkdownRenderer';
import { PermissionDetailOrFallback, PermissionCountdown, PermissionPill, permissionStyles } from '../PermissionDetail';
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

export function MessageBubble({ message, onSelectOption, onSubmitMultiQuestion, allowMultiQuestion, isSelected, isSelecting, onLongPress, onPress, onOpenDetail, onImagePress, onRetryStreamStall }: {
  message: ChatMessage;
  onSelectOption?: (value: SelectOptionValue, messageId: string, requestId?: string, toolUseId?: string) => void;
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
}) {
  const longPressedRef = useRef(false);
  const [isExpired, setIsExpired] = useState(() =>
    message.expiresAt != null && message.expiresAt <= Date.now()
  );
  const [permissionExpanded, setPermissionExpanded] = useState(false);
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
  const isTool = message.type === 'tool_use';
  const isThinking = message.type === 'thinking';
  const isPrompt = message.type === 'prompt';
  const isError = message.type === 'error';
  const isSystem = message.type === 'system';

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
  const showMultiQuestionForm =
    isMultiQuestion && !!allowMultiQuestion && message.answered == null && !isExpired;
  const showMultiQuestionSummary =
    isMultiQuestion && !!allowMultiQuestion && message.answered != null;
  // #4973 — per-question display labels for the post-answer summary chip.
  // Maps each question's chosen value(s) (from the structured
  // `answeredAnswers` map) back to its option label(s), comma-joined for
  // multi-select. Falls back to the raw value when no matching option is
  // found (defensive — covers free-form values older servers might echo).
  const multiQuestionAnswerLabels = showMultiQuestionSummary
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
      />
    );
  }

  // #4496: distinct chip for stream-stall errors (server PR #4475 emits
  // `error{code: 'stream_stall'}` after the configured inactivity window).
  // Generic red bubble reads as "broken"; this affordance signals
  // "recoverable, just retry". `onRetryStreamStall` is only wired by
  // ChatView when this stall is the tail message — historical replayed
  // stalls render the chip text with the raw error reachable on
  // long-press, but no retry button (resending an ancient user_input
  // from a long-finished turn would be misleading).
  if (isError && message.code === 'stream_stall') {
    return (
      <StreamStallChip
        errorText={message.content?.trim() || ''}
        onRetry={onRetryStreamStall}
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
      style={[styles.messageBubble, isUser && styles.userBubble, isPrompt && styles.promptBubble, isError && styles.errorBubble, isSystem && styles.systemBubble, isSelected && styles.selectedBubble]}
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
      {showMultiQuestionForm && (
        <MultiQuestionForm
          questions={message.questions!}
          onSubmit={(answersMap) => {
            if (submittedRef.current) return;
            submittedRef.current = true;
            onSubmitMultiQuestion?.(answersMap, message.id, message.toolUseId);
          }}
        />
      )}
      {showMultiQuestionSummary && (
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
      {showOptionButtons && (
        <View style={styles.promptOptions}>
          {message.options!.map((opt, i) => {
            const isAnswered = message.answered != null;
            const isDisabled = isAnswered || isExpired;
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
                  onSelectOption?.(opt.value, message.id, message.requestId, message.toolUseId);
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
              if (!trimmed || submittedRef.current) return;
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
            style={[styles.promptFreetextSend, !otherText.trim() && styles.promptOptionDisabled]}
            disabled={!otherText.trim()}
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

const styles = StyleSheet.create({
  messageBubble: {
    backgroundColor: COLORS.backgroundSecondary,
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '85%',
  },
  userBubble: {
    backgroundColor: COLORS.accentBlueLight,
    alignSelf: 'flex-end',
    borderColor: COLORS.accentBlueBorder,
    borderWidth: 1,
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
  promptOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  promptOptionButton: {
    backgroundColor: COLORS.accentOrangeMedium,
    paddingHorizontal: 16,
    paddingVertical: 8,
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
    lineHeight: 20,
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
  },
  selectedBubble: {
    borderColor: COLORS.accentBlue,
    borderWidth: 2,
  },
  messageText: {
    color: COLORS.textChatMessage,
    fontSize: 15,
    lineHeight: 22,
  },
  userMessageText: {
    color: COLORS.textPrimary,
  },
});
