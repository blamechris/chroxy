import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  NativeSyntheticEvent,
  NativeScrollEvent,
  AccessibilityInfo,
} from 'react-native';
import { ChatMessage, ToolResultImage } from '../store/connection';
import { ImageViewer } from './ImageViewer';
import { AnimatedMessage } from './AnimatedMessage';
import { ICON_CHEVRON_RIGHT } from '../constants/icons';
import { Icon } from './Icon';
import { COLORS } from '../constants/colors';
import { ActivityGroup } from './chat/ActivityGroup';
import { ToolDetailModal } from './chat/ToolDetailModal';
import { MessageBubble } from './chat/MessageBubble';

// -- Props --

export interface ChatViewProps {
  messages: ChatMessage[];
  scrollViewRef: React.RefObject<ScrollView | null>;
  claudeReady: boolean;
  onSelectOption: (value: string, messageId: string, requestId?: string, toolUseId?: string) => void;
  isCliMode: boolean;
  selectedIds: Set<string>;
  isSelecting: boolean;
  isSelectingRef: React.MutableRefObject<boolean>;
  onToggleSelection: (id: string) => void;
  streamingMessageId: string | null;
  isPlanPending?: boolean;
  planAllowedPrompts?: { tool: string; prompt: string }[];
  onApprovePlan?: () => void;
  onFocusInput?: () => void;
  /** Search query for highlighting matching messages */
  searchQuery?: string;
  /** Set of message IDs that match the current search query */
  searchMatchIds?: Set<string>;
  /** ID of the currently focused search match (for scroll-into-view) */
  currentMatchId?: string | null;
}

// -- Display group types for message grouping --

type DisplayGroup =
  | { type: 'single'; message: ChatMessage }
  | { type: 'activity'; messages: ChatMessage[]; isActive: boolean; key: string };

/** Group consecutive tool_use and thinking messages into ActivityGroups */
function groupMessages(messages: ChatMessage[], streamingMessageId: string | null): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  let activityBuf: ChatMessage[] = [];

  const flushActivity = () => {
    if (activityBuf.length > 0) {
      const lastMsg = activityBuf[activityBuf.length - 1];
      const isLastMessage = lastMsg === messages[messages.length - 1];
      const isActive = isLastMessage && streamingMessageId !== null;
      groups.push({
        type: 'activity',
        messages: [...activityBuf],
        isActive,
        key: `activity-${activityBuf[0].id}`,
      });
      activityBuf = [];
    }
  };

  for (const msg of messages) {
    if (msg.type === 'tool_use' || msg.type === 'thinking') {
      activityBuf.push(msg);
    } else {
      flushActivity();
      groups.push({ type: 'single', message: msg });
    }
  }
  flushActivity();

  return groups;
}

// -- Plan Approval Card --

function PlanApprovalCard({
  allowedPrompts,
  onApprove,
  onFeedback,
}: {
  allowedPrompts: { tool: string; prompt: string }[];
  onApprove: () => void;
  onFeedback: () => void;
}) {
  return (
    <View style={styles.planCard}>
      <Text style={styles.planCardHeader}>Plan Ready for Review</Text>
      {allowedPrompts.length > 0 && (
        <View style={styles.planPromptsList}>
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
        >
          <Text style={styles.planApproveText}>Approve</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.planFeedbackButton}
          onPress={onFeedback}
          accessibilityRole="button"
          accessibilityLabel="Give feedback on plan"
        >
          <Text style={styles.planFeedbackText}>Give Feedback</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// -- Main ChatView component --

export function ChatView({
  messages,
  scrollViewRef,
  claudeReady,
  onSelectOption,
  isCliMode,
  selectedIds,
  isSelecting,
  isSelectingRef,
  onToggleSelection,
  streamingMessageId,
  isPlanPending,
  planAllowedPrompts,
  onApprovePlan,
  onFocusInput,
  searchQuery,
  searchMatchIds,
  currentMatchId,
}: ChatViewProps) {
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [toolDetail, setToolDetail] = useState<{ toolName: string; content: string; toolResult?: string; toolResultTruncated?: boolean; toolResultImages?: ToolResultImage[]; serverName?: string } | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);

  // Animation: only animate messages arriving after initial mount
  const mountTimeRef = useRef(Date.now());
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    return () => listener.remove();
  }, []);

  // Track message layout positions for search scroll-to-match
  const messageLayoutsRef = useRef<Map<string, number>>(new Map());

  // Scroll to the current search match when it changes
  useEffect(() => {
    if (!currentMatchId) return;
    const y = messageLayoutsRef.current.get(currentMatchId);
    if (y != null) {
      scrollViewRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollViewRef is a stable ref
  }, [currentMatchId]);

  // Pause auto-scroll when an unanswered prompt is visible — user needs to read context
  const hasUnansweredPrompt = useMemo(
    () => messages.some((m) => m.type === 'prompt' && !m.answered),
    [messages],
  );

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

  const handleOpenDetail = (toolName: string, content: string, toolResult?: string, toolResultTruncated?: boolean, toolResultImages?: ToolResultImage[], serverName?: string) => {
    setToolDetail({ toolName, content, toolResult, toolResultTruncated, toolResultImages, serverName });
  };

  const displayGroups = useMemo(
    () => groupMessages(messages, streamingMessageId),
    [messages, streamingMessageId],
  );

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const threshold = 100;

    // Show "jump to top" when scrolled down from the top
    setShowScrollToTop(contentOffset.y > threshold);

    // Show "jump to bottom" when scrolled up from the bottom
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setShowScrollToBottom(distanceFromBottom > threshold);
  };

  const scrollToTop = () => {
    scrollViewRef.current?.scrollTo({ y: 0, animated: true });
  };

  const scrollToBottom = () => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  };

  return (
    <View style={styles.chatContainer}>
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        contentContainerStyle={styles.chatContent}
        onContentSizeChange={() => {
          if (!isSelectingRef.current && !hasUnansweredPrompt) scrollViewRef.current?.scrollToEnd();
        }}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
      {messages.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>
            {claudeReady
              ? 'Connected. Send a message to Claude!'
              : isCliMode
                ? 'Connecting...'
                : 'Starting Claude Code...'}
          </Text>
        </View>
      ) : (
        displayGroups.map((group) => {
          if (group.type === 'activity') {
            const firstMsg = group.messages[0];
            return (
              <View
                key={group.key}
                onLayout={(e) => {
                  const y = e.nativeEvent.layout.y;
                  for (const m of group.messages) {
                    messageLayoutsRef.current.set(m.id, y);
                  }
                }}
              >
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
                  />
                </AnimatedMessage>
              </View>
            );
          }
          const msg = group.message;
          const isSearchMatch = searchMatchIds?.has(msg.id) ?? false;
          const isCurrentMatch = currentMatchId === msg.id;
          return (
            <View
              key={msg.id}
              style={isSearchMatch ? (isCurrentMatch ? styles.searchMatchCurrent : styles.searchMatch) : undefined}
              onLayout={(e) => {
                messageLayoutsRef.current.set(msg.id, e.nativeEvent.layout.y);
              }}
            >
              <AnimatedMessage
                type={msg.type}
                timestamp={msg.timestamp}
                mountTime={mountTimeRef.current}
                reduceMotion={reduceMotion}
              >
                <MessageBubble
                  message={msg}
                  onSelectOption={onSelectOption}
                  isSelected={selectedIds.has(msg.id)}
                  isSelecting={isSelecting}
                  onLongPress={() => onToggleSelection(msg.id)}
                  onPress={() => onToggleSelection(msg.id)}
                  onOpenDetail={handleOpenDetail}
                  onImagePress={setViewerUri}
                />
              </AnimatedMessage>
            </View>
          );
        })
      )}
      {isPlanPending && onApprovePlan && onFocusInput && (
        <PlanApprovalCard
          allowedPrompts={planAllowedPrompts || []}
          onApprove={onApprovePlan}
          onFeedback={onFocusInput}
        />
      )}
      </ScrollView>

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
});
