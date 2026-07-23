import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Platform,
  NativeSyntheticEvent,
  NativeScrollEvent,
  AccessibilityInfo,
  ListRenderItemInfo,
} from 'react-native';
import type { ChatMessage, ToolResultImage } from '../store/connection';
import type { DisplayGroup } from '@chroxy/store-core';
import { ImageViewer } from './ImageViewer';
import { AnimatedMessage } from './AnimatedMessage';
import { ICON_CHEVRON_RIGHT } from '../constants/icons';
import { Icon } from './Icon';
import { COLORS } from '../constants/colors';
import { ActivityGroup } from './chat/ActivityGroup';
import { ToolDetailModal } from './chat/ToolDetailModal';
import { MessageBubble } from './chat/MessageBubble';
import type { SelectOptionValue } from './chat/MessageBubble';
import type { MultiQuestionAnswersMap } from './chat/MultiQuestionForm';
import { buildChatViewMessages, isRetryableAskUserQuestionError } from '@chroxy/store-core';
import { useConnectionStore } from '../store/connection';
import { usePermissionAnnouncer } from '../hooks/usePermissionAnnouncer';

// -- Props --

export interface ChatViewProps {
  messages: ChatMessage[];
  /**
   * #5517: the chat list is now a virtualized FlatList. SessionScreen owns
   * the ref and only passes it through (it never calls methods on it) — all
   * imperative scrolling happens inside ChatView. Typed as FlatList; the
   * `<unknown>` data param keeps SessionScreen's `useRef<FlatList>` simple.
   */
  scrollViewRef: React.RefObject<FlatList<unknown> | null>;
  claudeReady: boolean;
  /**
   * #4755 — `value` is `string` for regular option taps + zero-options
   * free-text answers, or `{otherLabel, freeformText}` (`OtherFreeformAnswer`)
   * when the user picked the synthesized "Other" option and typed
   * freeform text. The widened shape rides through to
   * `sendUserQuestionResponse`, which serializes the wire payload
   * (`answer: <otherLabel>, freeformText`). See
   * `MessageBubble.SelectOptionValue` for the union type.
   */
  // #6543 (feature B): the optional 5th `editedInput` carries a Write/Edit
  // pre-write-diff narrowing straight through to SessionScreen's handler (ChatView
  // forwards the ref unchanged); null/omitted for every other prompt.
  onSelectOption: (value: SelectOptionValue, messageId: string, requestId?: string, toolUseId?: string, editedInput?: Record<string, string> | null) => void;
  /**
   * #4973 — submit handler for the multi-question AskUserQuestion form.
   * Fires with the per-question answers map; SessionScreen forwards it to
   * `sendUserQuestionResponse` and records the structured summary.
   */
  onSubmitMultiQuestion?: (answersMap: MultiQuestionAnswersMap, messageId: string, toolUseId?: string) => void;
  /**
   * #4973 / #4735 — when true, multi-question AskUserQuestion payloads
   * render the interactive `MultiQuestionForm`. SDK-mode sessions only;
   * TUI / CLI sessions leave this false (permission-hook denies combined
   * multi-question tool_uses). Mirrors the dashboard's
   * `allowMultiQuestionForm` gate.
   */
  allowMultiQuestion?: boolean;
  /**
   * #5776 — opt-in to render a SINGLE-question multiSelect as a checkbox form
   * (passed through to MessageBubble). True for the SDK family and claude-tui
   * (multi-select reinject); off for claude-cli.
   */
  allowSingleMultiSelect?: boolean;
  isCliMode: boolean;
  selectedIds: Set<string>;
  isSelecting: boolean;
  isSelectingRef: React.MutableRefObject<boolean>;
  onToggleSelection: (id: string) => void;
  streamingMessageId: string | null;
  /**
   * #5938 — clientMessageIds of the active session's user bubbles that are
   * currently queued (sent mid-turn, awaiting flush). A matching `user_input`
   * row renders a "Queued" badge + cancel affordance. Per-session, derived in
   * SessionScreen from the store's `queuedMessages` so it survives the
   * session-switch re-render without leaking across sessions.
   */
  queuedIds?: Set<string>;
  /** #5938 — cancel a still-queued follow-up by its clientMessageId. */
  onCancelQueued?: (id: string) => void;
  /** #6628 — edit a still-queued follow-up: reopen its text in the composer and
   *  cancel the queued entry. Receives the message id and its current text. */
  onEditQueued?: (id: string, text: string) => void;
  isPlanPending?: boolean;
  planAllowedPrompts?: { tool: string; prompt: string }[];
  onApprovePlan?: () => void;
  /**
   * #6774 — combined "approve + auto-accept edits": approve the plan AND switch
   * the session into acceptEdits in one tap. Only wired where the provider
   * supports permission-mode switching (see {@link canApproveAcceptEdits}).
   */
  onApprovePlanAcceptEdits?: () => void;
  /**
   * #6774 — gate for the combined action. Mirrors the SettingsBar mode-chip
   * gating (`caps?.permissionModeSwitch !== false`); false hides the button
   * for providers that can't switch mode (e.g. claude-tui).
   */
  canApproveAcceptEdits?: boolean;
  onFocusInput?: () => void;
  /** Search query for highlighting matching messages */
  searchQuery?: string;
  /** Set of message IDs that match the current search query */
  searchMatchIds?: Set<string>;
  /** ID of the currently focused search match (for scroll-into-view) */
  currentMatchId?: string | null;
  /** Whether the keyboard is currently visible (triggers scroll-to-bottom) */
  keyboardVisible?: boolean;
}

// -- Plan Approval Card --

function PlanApprovalCard({
  allowedPrompts,
  onApprove,
  onApproveAcceptEdits,
  showAcceptEdits,
  onFeedback,
}: {
  allowedPrompts: { tool: string; prompt: string }[];
  onApprove: () => void;
  // #6774 — combined "approve + auto-accept edits" action. Optional +
  // capability-gated so it only renders where the provider supports it.
  onApproveAcceptEdits?: () => void;
  showAcceptEdits?: boolean;
  onFeedback: () => void;
}) {
  return (
    <View style={styles.planCard} testID="plan-approval-card">
      <Text style={styles.planCardHeader}>Plan Ready for Review</Text>
      {allowedPrompts.length > 0 && (
        <View style={styles.planPromptsList} testID="plan-content">
          <Text style={styles.planPromptsLabel}>Permissions needed:</Text>
          {allowedPrompts.map((p, i) => (
            <Text key={i} style={styles.planPromptItem}>
              {ICON_CHEVRON_RIGHT} {p.tool}: {p.prompt}
            </Text>
          ))}
        </View>
      )}
      <View style={styles.planButtonRow}>
        <TouchableOpacity
          style={styles.planApproveButton}
          onPress={onApprove}
          accessibilityRole="button"
          accessibilityLabel="Approve plan"
          testID="plan-approve-button"
        >
          <Text style={styles.planApproveText}>Approve</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.planFeedbackButton}
          onPress={onFeedback}
          accessibilityRole="button"
          accessibilityLabel="Give feedback on plan"
          testID="plan-deny-button"
        >
          <Text style={styles.planFeedbackText}>Give Feedback</Text>
        </TouchableOpacity>
      </View>
      {/* #6774 — full-width secondary action below the primary row so three
          touch targets don't crowd a narrow phone. */}
      {showAcceptEdits && onApproveAcceptEdits && (
        <TouchableOpacity
          style={styles.planAcceptEditsButton}
          onPress={onApproveAcceptEdits}
          accessibilityRole="button"
          accessibilityLabel="Approve plan and auto-accept edits"
          testID="plan-approve-accept-edits-button"
        >
          <Text style={styles.planAcceptEditsText}>Approve &amp; auto-accept edits</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// -- Main ChatView component --

export function ChatView({
  messages,
  scrollViewRef,
  claudeReady,
  onSelectOption,
  onSubmitMultiQuestion,
  allowMultiQuestion,
  allowSingleMultiSelect,
  isCliMode,
  selectedIds,
  isSelecting,
  isSelectingRef,
  onToggleSelection,
  streamingMessageId,
  queuedIds,
  onCancelQueued,
  onEditQueued,
  isPlanPending,
  planAllowedPrompts,
  onApprovePlan,
  onApprovePlanAcceptEdits,
  canApproveAcceptEdits,
  onFocusInput,
  searchQuery,
  searchMatchIds,
  currentMatchId,
  keyboardVisible,
}: ChatViewProps) {
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const showScrollToBottomRef = useRef(false);
  const [toolDetail, setToolDetail] = useState<{ toolName: string; content: string; toolResult?: string; toolResultTruncated?: boolean; toolResultImages?: ToolResultImage[]; serverName?: string } | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);

  // #5750 (item 2) — assertively announce a newly-arrived permission prompt to
  // screen readers (the prompt auto-denies on timeout, so silence loses the
  // user an action they might have allowed). Mirrors the dashboard's #5733
  // assertive treatment; fires once per prompt and stays silent for a prompt
  // already present at mount OR in the session we just switched to (the hook
  // re-seeds on activeSessionId change — ChatView isn't remounted per switch).
  const announcerSessionId = useConnectionStore((s) => s.activeSessionId);
  usePermissionAnnouncer(messages, announcerSessionId);

  // #5517: row expand/collapse registry, keyed by message id / activity
  // group key. The list is now a virtualized FlatList, so an off-screen tool
  // bubble / activity group / answered-permission pill can unmount and remount
  // as the user scrolls. Holding the expanded flags HERE — outside the
  // recyclable row — means a recycled row reopens to the user's last choice
  // instead of snapping back to collapsed. Rows seed from this map on mount
  // (`getInitialExpanded`) and write back on toggle (`handleExpandedChange`).
  // A ref (not state) keeps writes off the render hot path — recycled rows
  // re-read it on their own mount, so ChatView never needs to re-render to
  // surface a persisted flag.
  const expandedIdsRef = useRef<Map<string, boolean>>(new Map());
  const getInitialExpanded = useCallback(
    (id: string) => expandedIdsRef.current.get(id) ?? false,
    [],
  );
  const handleExpandedChange = useCallback((id: string, expanded: boolean) => {
    if (expanded) expandedIdsRef.current.set(id, true);
    else expandedIdsRef.current.delete(id);
  }, []);

  // Animation: only animate messages arriving after initial mount
  const mountTimeRef = useRef(Date.now());
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    return () => listener.remove();
  }, []);

  // #5517: search scroll-to-match. The pre-virtualization ScrollView tracked
  // each row's pixel y via onLayout and called `scrollTo({ y })`. A FlatList
  // can't scroll to an arbitrary pixel offset for an off-screen (unmeasured)
  // row, so we scroll to the row's INDEX instead. `groupIndexByMessageId`
  // maps every message id (including each message inside an activity group)
  // to its row index; `scrollToIndex` with `viewPosition: 0` lands the match
  // near the top of the viewport (mirroring the old `y - 80` headroom).
  const groupIndexByMessageIdRef = useRef<Map<string, number>>(new Map());

  // Scroll to the current search match when it changes
  useEffect(() => {
    if (!currentMatchId) return;
    const index = groupIndexByMessageIdRef.current.get(currentMatchId);
    if (index != null) {
      scrollViewRef.current?.scrollToIndex({
        index,
        animated: true,
        viewPosition: 0,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollViewRef is a stable ref
  }, [currentMatchId]);

  // Pause auto-scroll when an unanswered prompt is visible — user needs to read context
  const hasUnansweredPrompt = useMemo(
    () => messages.some((m) => m.type === 'prompt' && !m.answered),
    [messages],
  );

  // Auto-scroll when keyboard opens (keep latest message visible)
  useEffect(() => {
    if (keyboardVisible && !isSelectingRef.current && !showScrollToBottomRef.current) {
      const timer = setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 300);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollViewRef, isSelectingRef, and showScrollToBottomRef are stable refs
  }, [keyboardVisible]);

  // Auto-scroll when plan approval card appears
  useEffect(() => {
    if (isPlanPending && !isSelectingRef.current) {
      // Small delay to let the card render before scrolling
      const timer = setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollViewRef and isSelectingRef are stable refs
  }, [isPlanPending]);

  // Auto-scroll when a permission prompt newly appears (#1711)
  const prevHasUnansweredPrompt = useRef(hasUnansweredPrompt);
  useEffect(() => {
    const appearedNow = hasUnansweredPrompt && !prevHasUnansweredPrompt.current;
    prevHasUnansweredPrompt.current = hasUnansweredPrompt;
    if (appearedNow && !isSelectingRef.current && !showScrollToBottomRef.current) {
      const timer = setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollViewRef, isSelectingRef, and showScrollToBottomRef are stable refs
  }, [hasUnansweredPrompt]);

  const handleOpenDetail = (toolName: string, content: string, toolResult?: string, toolResultTruncated?: boolean, toolResultImages?: ToolResultImage[], serverName?: string) => {
    setToolDetail({ toolName, content, toolResult, toolResultTruncated, toolResultImages, serverName });
  };

  // #4806: shared ChatView message pipeline (lifted from dashboard's
  // `useChatMessages`). Single source of truth for filter + group +
  // overlay + tail-id + stalledPromptIds — both dashboard and mobile
  // derive identically. The mobile renderer below consumes
  // `displayGroups` (groups, not flattened rows) so it can keep using
  // ActivityGroup / MessageBubble; `chatTailMessageId` and
  // `stalledPromptIds` (#4615) flow straight through.
  const {
    displayGroups,
    chatTailMessageId,
    stalledPromptIds,
  } = useMemo(
    () => buildChatViewMessages(messages, streamingMessageId),
    [messages, streamingMessageId],
  );

  // #5517: map every message id (and each id inside an activity group) to its
  // FlatList row index so search-match scroll can target a row by index. Kept
  // in a ref synced from this memo — the search effect reads it imperatively.
  useMemo(() => {
    const map = new Map<string, number>();
    displayGroups.forEach((group, index) => {
      if (group.type === 'activity') {
        for (const m of group.messages) map.set(m.id, index);
      } else {
        map.set(group.message.id, index);
      }
    });
    groupIndexByMessageIdRef.current = map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref write, no render dependency
  }, [displayGroups]);

  // #4496: last user input — used to gate the stream-stall chip's Retry
  // button. Mirrors the dashboard's `isTail` check (only the most recent
  // stall retry-button-wires; historical replayed stalls render chip
  // text only). Walking messages once here is cheaper than recomputing
  // per bubble.
  const sendInput = useConnectionStore((s) => s.sendInput);
  const lastUserInputContent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user_input') return messages[i].content;
    }
    return null;
  }, [messages]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const threshold = 100;

    // Show "jump to top" when scrolled down from the top
    setShowScrollToTop(contentOffset.y > threshold);

    // Show "jump to bottom" when scrolled up from the bottom
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const isScrolledUp = distanceFromBottom > threshold;
    setShowScrollToBottom(isScrolledUp);
    showScrollToBottomRef.current = isScrolledUp;
  };

  const scrollToTop = () => {
    scrollViewRef.current?.scrollToOffset({ offset: 0, animated: true });
  };

  const scrollToBottom = () => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  };

  // #5517: stable per-row key. Activity groups carry a synthetic
  // `activity-<firstId>` key (so a group never collapses onto a member id);
  // single rows key by their message id. Identity-stable keys are what let
  // the #5516 MessageBubble memo skip reconciliation on a streaming flush —
  // the FlatList must not key by array index.
  const keyExtractor = useCallback(
    (group: DisplayGroup) => (group.type === 'activity' ? group.key : group.message.id),
    [],
  );

  // #5517: FlatList row renderer — the body of the old `displayGroups.map`,
  // lifted out so FlatList can mount/unmount rows on demand. Behaviour is
  // otherwise identical: ActivityGroup for grouped tool/thinking runs,
  // MessageBubble for single rows, with the #4615 stalled-prompt suppression
  // and the #4496 tail-only stream-stall retry wiring preserved.
  const renderItem = useCallback(
    ({ item: group }: ListRenderItemInfo<DisplayGroup>) => {
      if (group.type === 'activity') {
        const firstMsg = group.messages[0];
        return (
          <AnimatedMessage
            type={firstMsg.type}
            timestamp={firstMsg.timestamp}
            mountTime={mountTimeRef.current}
            reduceMotion={reduceMotion}
          >
            <ActivityGroup
              messages={group.messages}
              isActive={group.isActive}
              isSelecting={isSelecting}
              selectedIds={selectedIds}
              onToggleSelection={onToggleSelection}
              searchMatchIds={searchMatchIds}
              groupKey={group.key}
              getInitialExpanded={getInitialExpanded}
              onExpandedChange={handleExpandedChange}
            />
          </AnimatedMessage>
        );
      }
      const msg = group.message;
      // #4615 (mobile parity via #4806): suppress unanswered prompts
      // invalidated by a subsequent ASK_USER_QUESTION_STALL. The pending
      // prompt has already been discarded server-side; the stall-chip
      // rendered for the error bubble carries the retry affordance.
      if (
        msg.type === 'prompt' &&
        msg.options &&
        !msg.requestId &&
        stalledPromptIds.has(msg.id)
      ) {
        return null;
      }
      const isSearchMatch = searchMatchIds?.has(msg.id) ?? false;
      const isCurrentMatch = currentMatchId === msg.id;
      return (
        <View
          style={isSearchMatch ? (isCurrentMatch ? styles.searchMatchCurrent : styles.searchMatch) : undefined}
        >
          <AnimatedMessage
            type={msg.type}
            timestamp={msg.timestamp}
            mountTime={mountTimeRef.current}
            reduceMotion={reduceMotion}
          >
            <MessageBubble
              allowSingleMultiSelect={allowSingleMultiSelect}
              message={msg}
              queued={msg.type === 'user_input' && (queuedIds?.has(msg.id) ?? false)}
              onCancelQueued={onCancelQueued}
              onEditQueued={onEditQueued}
              onSelectOption={onSelectOption}
              onSubmitMultiQuestion={onSubmitMultiQuestion}
              allowMultiQuestion={allowMultiQuestion}
              isSelected={selectedIds.has(msg.id)}
              isSelecting={isSelecting}
              onLongPress={() => onToggleSelection(msg.id)}
              onPress={() => onToggleSelection(msg.id)}
              onOpenDetail={handleOpenDetail}
              onImagePress={setViewerUri}
              getInitialExpanded={getInitialExpanded}
              onExpandedChange={handleExpandedChange}
              onRetryStreamStall={
                // #4496 / #5793: only wire retry when this stall/teardown is
                // the tail bubble AND there's a user_input to resend. Covers
                // stream_stall plus the retryable AskUserQuestion codes
                // (ASK_USER_QUESTION_STALL + the MULTISELECT/MULTI_QUESTION
                // teardown codes) so all of them get the resend affordance.
                msg.type === 'error' &&
                (msg.code === 'stream_stall' || isRetryableAskUserQuestionError(msg.code)) &&
                msg.id === chatTailMessageId &&
                lastUserInputContent != null
                  ? () => sendInput(lastUserInputContent)
                  : undefined
              }
            />
          </AnimatedMessage>
        </View>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mountTimeRef/getInitialExpanded/handleExpandedChange are stable; the rest are render-affecting and intentionally tracked
    [
      reduceMotion,
      isSelecting,
      selectedIds,
      onToggleSelection,
      searchMatchIds,
      currentMatchId,
      stalledPromptIds,
      onSelectOption,
      onSubmitMultiQuestion,
      allowMultiQuestion,
      allowSingleMultiSelect,
      queuedIds,
      onCancelQueued,
      onEditQueued,
      chatTailMessageId,
      lastUserInputContent,
      sendInput,
    ],
  );

  return (
    <View style={styles.chatContainer}>
      <FlatList
        ref={scrollViewRef as React.RefObject<FlatList<DisplayGroup>>}
        style={styles.scrollView}
        contentContainerStyle={styles.chatContent}
        data={displayGroups}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        // #5517: auto-scroll-to-bottom on new content (sticky streaming).
        //
        // The pre-virtualization ScrollView called scrollToEnd on every
        // onContentSizeChange (gated only by selecting / unanswered-prompt).
        // That was safe because a ScrollView's content size changed ONLY when
        // real content did. A FlatList also fires onContentSizeChange as rows
        // mount/unmount during scroll (windowing) — a literal port would yank
        // a user who scrolled up back to the bottom mid-read. To preserve the
        // observable UX (sticky to bottom while at the bottom; never yank a
        // scrolled-up reader) we additionally gate on `showScrollToBottomRef`
        // — the same "is the user near the bottom?" signal the keyboard and
        // prompt auto-scroll effects already honour.
        onContentSizeChange={() => {
          if (
            !isSelectingRef.current &&
            !hasUnansweredPrompt &&
            !showScrollToBottomRef.current
          ) {
            scrollViewRef.current?.scrollToEnd();
          }
        }}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        // #5517: search match scroll uses scrollToIndex; rows are variable-
        // height and unmeasured until laid out, so RN throws when the target
        // is past `highestMeasuredFrameIndex`. Recover with the RN-recommended
        // two-step: first `scrollToOffset` to the target's *estimated* offset
        // (`index * averageItemLength`) — this mounts/measures the rows in
        // between — then retry `scrollToIndex` on the next frame to land
        // precisely. Bare-retrying scrollToIndex (the old path) could re-throw
        // repeatedly when the row is still far off-screen.
        onScrollToIndexFailed={(info) => {
          scrollViewRef.current?.scrollToOffset({
            offset: info.index * info.averageItemLength,
            animated: true,
          });
          setTimeout(() => {
            scrollViewRef.current?.scrollToIndex({
              index: info.index,
              animated: true,
              viewPosition: 0,
            });
          }, 100);
        }}
        // #5517: keep a couple screens of rows mounted so near-viewport
        // expand state and scroll feel native; recycle the rest.
        windowSize={11}
        removeClippedSubviews={Platform.OS === 'android'}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>
              {claudeReady
                ? 'Connected. Send a message to Claude!'
                : isCliMode
                  ? 'Connecting...'
                  : 'Starting Claude Code...'}
            </Text>
          </View>
        }
        ListFooterComponent={
          isPlanPending && onApprovePlan && onFocusInput ? (
            <PlanApprovalCard
              allowedPrompts={planAllowedPrompts || []}
              onApprove={onApprovePlan}
              onApproveAcceptEdits={onApprovePlanAcceptEdits}
              showAcceptEdits={canApproveAcceptEdits}
              onFeedback={onFocusInput}
            />
          ) : null
        }
      />

      {/* Scroll navigation buttons */}
      {showScrollToTop && (
        <TouchableOpacity
          style={[styles.scrollButton, styles.scrollButtonTop]}
          onPress={scrollToTop}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Scroll to top of conversation"
        >
          <Icon name="arrowUp" size={16} color={COLORS.textPrimary} />
        </TouchableOpacity>
      )}
      {showScrollToBottom && (
        <TouchableOpacity
          style={[styles.scrollButton, styles.scrollButtonBottom]}
          onPress={scrollToBottom}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Scroll to bottom of conversation"
        >
          <Icon name="arrowDown" size={16} color={COLORS.textPrimary} />
        </TouchableOpacity>
      )}

      <ToolDetailModal
        visible={toolDetail !== null}
        toolName={toolDetail?.toolName || ''}
        content={toolDetail?.content || ''}
        toolResult={toolDetail?.toolResult}
        toolResultTruncated={toolDetail?.toolResultTruncated}
        toolResultImages={toolDetail?.toolResultImages}
        serverName={toolDetail?.serverName}
        onClose={() => setToolDetail(null)}
        onImagePress={(uri) => { setToolDetail(null); setViewerUri(uri); }}
      />
      <ImageViewer uri={viewerUri} onClose={() => setViewerUri(null)} />
    </View>
  );
}

// -- Styles --

const styles = StyleSheet.create({
  chatContainer: {
    flex: 1,
  },
  searchMatch: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentBlue,
    borderRadius: 4,
    paddingLeft: 2,
  },
  searchMatchCurrent: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentOrange,
    borderRadius: 4,
    paddingLeft: 2,
    backgroundColor: COLORS.accentOrangeLight,
  },
  scrollView: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    paddingBottom: 24,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 100,
  },
  emptyStateText: {
    color: COLORS.textDim,
    fontSize: 16,
  },
  scrollButton: {
    position: 'absolute',
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.scrollButtonBackground,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    shadowColor: COLORS.shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  scrollButtonTop: {
    top: 16,
  },
  scrollButtonBottom: {
    bottom: 16,
  },
  planCard: {
    backgroundColor: COLORS.accentGreenLight,
    borderColor: COLORS.accentGreenBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
    marginBottom: 12,
    maxWidth: '95%',
  },
  planCardHeader: {
    color: COLORS.accentGreen,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  planPromptsList: {
    marginBottom: 10,
  },
  planPromptsLabel: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginBottom: 4,
  },
  planPromptItem: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    paddingVertical: 2,
    paddingLeft: 4,
  },
  planButtonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  planApproveButton: {
    backgroundColor: COLORS.accentGreen,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  planApproveText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  planFeedbackButton: {
    backgroundColor: COLORS.accentGreenLight,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentGreenBorderStrong,
    minHeight: 44,
    justifyContent: 'center',
  },
  planFeedbackText: {
    color: COLORS.accentGreen,
    fontSize: 14,
    fontWeight: '600',
  },
  // #6774 — combined "approve + auto-accept edits". Full-width tinted-green
  // outline below the primary row: reads as a sibling of Approve (same intent)
  // while staying distinct from the solid primary Approve button.
  planAcceptEditsButton: {
    marginTop: 10,
    backgroundColor: COLORS.accentGreenLight,
    borderWidth: 1,
    borderColor: COLORS.accentGreen,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  planAcceptEditsText: {
    color: COLORS.accentGreen,
    fontSize: 14,
    fontWeight: '700',
  },
});
