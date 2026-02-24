import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  LayoutAnimation,
  NativeSyntheticEvent,
  NativeScrollEvent,
  AccessibilityInfo,
  Animated,
  Modal,
  Pressable,
  Image,
} from 'react-native';
import { ChatMessage, ToolResultImage } from '../store/connection';
import { FormattedResponse } from './MarkdownRenderer';
import { ImageViewer } from './ImageViewer';
import { ICON_CHEVRON_RIGHT, ICON_CHEVRON_DOWN, ICON_ARROW_UP, ICON_ARROW_DOWN, ICON_CLOSE, ICON_CHECK, ICON_DOCUMENT } from '../constants/icons';
import { COLORS } from '../constants/colors';
import { PermissionDetailOrFallback, PermissionCountdown, PermissionPill, permissionStyles } from './PermissionDetail';

/**
 * Format a tool name for display. MCP tools show as "tool_name" with server noted separately.
 * Duplicates the mcp__ prefix parsing from mcp-tools.js as a client-side fallback in case
 * the raw tool name arrives without a pre-extracted serverName.
 */
const MCP_PREFIX = 'mcp__';
function formatToolName(tool?: string): string {
  if (!tool) return 'Thinking';
  if (tool.startsWith(MCP_PREFIX)) {
    const rest = tool.slice(MCP_PREFIX.length);
    const sep = rest.indexOf('__');
    if (sep > 0) return rest.slice(sep + 2);
  }
  return tool;
}


// -- Animated Thinking Indicator --

function ThinkingIndicator() {
  const dot1Opacity = useRef(new Animated.Value(0.3)).current;
  const dot2Opacity = useRef(new Animated.Value(0.3)).current;
  const dot3Opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const createPulseAnimation = (animatedValue: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animatedValue, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(animatedValue, {
            toValue: 0.3,
            duration: 400,
            useNativeDriver: true,
          }),
          // Compensating delay ensures all sequences have the same 1200ms duration
          Animated.delay(400 - delay),
        ]),
      );
    };

    const animation1 = createPulseAnimation(dot1Opacity, 0);
    const animation2 = createPulseAnimation(dot2Opacity, 200);
    const animation3 = createPulseAnimation(dot3Opacity, 400);

    animation1.start();
    animation2.start();
    animation3.start();

    return () => {
      animation1.stop();
      animation2.stop();
      animation3.stop();
    };
  }, [dot1Opacity, dot2Opacity, dot3Opacity]);

  // Announce to screen readers when thinking indicator mounts
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility('Claude is thinking');
  }, []);

  return (
    <View
      style={styles.thinkingIndicator}
      accessible={true}
      accessibilityLabel="Claude is thinking"
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.thinkingLabel}>Claude is thinking</Text>
      <View style={styles.thinkingDots}>
        <Animated.View style={[styles.thinkingDot, { opacity: dot1Opacity }]} />
        <Animated.View style={[styles.thinkingDot, { opacity: dot2Opacity }]} />
        <Animated.View style={[styles.thinkingDot, { opacity: dot3Opacity }]} />
      </View>
    </View>
  );
}

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

// -- Single activity entry with long-press guard --

function ActivityEntry({
  message,
  isSelected,
  isSelecting,
  onToggleSelection,
}: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onToggleSelection: (id: string) => void;
}) {
  const longPressedRef = useRef(false);

  const handlePress = () => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) onToggleSelection(message.id);
  };

  const handleLongPress = () => {
    longPressedRef.current = true;
    onToggleSelection(message.id);
  };

  const hasResult = !!message.toolResult;
  const imageCount = message.toolResultImages?.length || 0;

  const displayTool = formatToolName(message.tool);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onLongPress={isSelecting ? undefined : handleLongPress}
      onPress={handlePress}
      style={[styles.activityEntry, isSelected && styles.selectedBubble]}
    >
      <Text style={styles.activityEntryIcon}>{hasResult ? ICON_CHECK : ICON_CHEVRON_RIGHT}</Text>
      {message.serverName ? (
        <Text style={styles.activityEntryTool}>
          <Text style={styles.mcpServerTag}>{message.serverName}</Text>
          {' '}{displayTool}
        </Text>
      ) : (
        <Text style={styles.activityEntryTool}>{displayTool}</Text>
      )}
      {imageCount > 0 && (
        <Text style={styles.activityImageBadge}>{imageCount === 1 ? '1 image' : `${imageCount} images`}</Text>
      )}
      <Text style={styles.activityEntryPreview} numberOfLines={1}>
        {hasResult ? (message.toolResult || '').slice(0, 60) : (message.content || '').slice(0, 40)}
      </Text>
    </TouchableOpacity>
  );
}

// -- Activity group component --

function ActivityGroup({
  messages: activityMessages,
  isActive,
  isSelecting,
  selectedIds,
  onToggleSelection,
  searchMatchIds,
}: {
  messages: ChatMessage[];
  isActive: boolean;
  isSelecting: boolean;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  searchMatchIds?: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = activityMessages.filter((m) => m.type === 'tool_use').length;
  const lastMessage = activityMessages[activityMessages.length - 1];
  const isThinking = isActive && lastMessage?.type === 'thinking';

  // Auto-expand when a search match is inside this group
  const hasSearchMatch = searchMatchIds
    ? activityMessages.some((m) => searchMatchIds.has(m.id))
    : false;
  useEffect(() => {
    if (hasSearchMatch && !expanded) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded(true);
    }
  }, [hasSearchMatch]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePress = () => {
    if (isSelecting) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => !prev);
  };

  // Auto-collapse when activity completes
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (wasActiveRef.current && !isActive) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded(false);
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

  const summary = isActive
    ? `Working... (${toolCount} tool${toolCount !== 1 ? 's' : ''})`
    : `${toolCount} tool${toolCount !== 1 ? 's' : ''} used`;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      style={styles.activityGroup}
    >
      <View style={styles.activityHeader}>
        {isActive && <View style={styles.activityPulse} />}
        <Text style={styles.activitySummary}>{summary}</Text>
        <Text style={styles.activityChevron}>{expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}</Text>
      </View>
      {isThinking && <ThinkingIndicator />}
      {expanded && (
        <ScrollView style={styles.activityList} nestedScrollEnabled>
          {activityMessages.map((msg) => (
            <ActivityEntry
              key={msg.id}
              message={msg}
              isSelected={selectedIds.has(msg.id)}
              isSelecting={isSelecting}
              onToggleSelection={onToggleSelection}
            />
          ))}
        </ScrollView>
      )}
    </TouchableOpacity>
  );
}

// -- Tool detail modal --

function ToolDetailModal({ visible, toolName, content, toolResult, toolResultTruncated, toolResultImages, serverName, onClose, onImagePress }: {
  visible: boolean;
  toolName: string;
  content: string;
  toolResult?: string;
  toolResultTruncated?: boolean;
  toolResultImages?: ToolResultImage[];
  serverName?: string;
  onClose: () => void;
  onImagePress: (uri: string) => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.toolModalOverlay} onPress={onClose}>
        <Pressable style={styles.toolModalContainer} onPress={(e) => e.stopPropagation()}>
          <View style={styles.toolModalHeader}>
            <View style={styles.toolModalTitleContainer}>
              <Text style={styles.toolModalTitle} numberOfLines={1}>Tool: {toolName}</Text>
              {serverName ? (
                <Text style={styles.toolModalServerLabel}>via MCP server: {serverName}</Text>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={styles.toolModalCloseButton}
              accessibilityRole="button"
              accessibilityLabel="Close tool details"
            >
              <Text style={styles.toolModalCloseIcon}>{ICON_CLOSE}</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.toolModalScroll}>
            {content ? (
              <>
                <Text style={styles.toolModalSectionLabel}>Input</Text>
                <Text selectable style={styles.toolModalContent}>{content}</Text>
              </>
            ) : null}
            {toolResultImages && toolResultImages.length > 0 ? (
              <>
                <Text style={[styles.toolModalSectionLabel, content ? { marginTop: 12 } : undefined]}>
                  {toolResultImages.length === 1 ? 'Image' : `Images (${toolResultImages.length})`}
                </Text>
                <View style={styles.toolImageGrid}>
                  {toolResultImages.map((img, i) => {
                    const uri = `data:${img.mediaType};base64,${img.data}`;
                    return (
                      <TouchableOpacity
                        key={i}
                        onPress={() => onImagePress(uri)}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel={`View image ${i + 1} of ${toolResultImages.length}`}
                      >
                        <Image source={{ uri }} style={styles.toolImageThumb} resizeMode="cover" />
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            ) : null}
            {toolResult != null ? (
              <>
                <Text style={[styles.toolModalSectionLabel, (content || toolResultImages?.length) ? { marginTop: 12 } : undefined]}>Result{toolResultTruncated ? ' (truncated)' : ''}</Text>
                <Text selectable style={styles.toolModalContent}>{toolResult}</Text>
              </>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// -- Collapsible tool use bubble --

function ToolBubble({ message, isSelected, isSelecting, onToggleSelection, onOpenDetail }: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onToggleSelection: () => void;
  onOpenDetail: (toolName: string, content: string, toolResult?: string, toolResultTruncated?: boolean, toolResultImages?: ToolResultImage[], serverName?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const longPressedRef = useRef(false);
  const content = message.content?.trim();

  // Hide empty tool messages
  if (!content) return null;

  const displayTool = formatToolName(message.tool);

  const handlePress = () => {
    // Suppress the tap that fires on release after a long-press
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) {
      onToggleSelection();
    } else if (expanded) {
      onOpenDetail(displayTool, content, message.toolResult, message.toolResultTruncated, message.toolResultImages, message.serverName);
    } else {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded(true);
    }
  };

  const handleLongPress = () => {
    longPressedRef.current = true;
    onToggleSelection();
  };

  const preview = content.length > 60 ? content.slice(0, 60) + '...' : content;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      onLongPress={!expanded && !isSelecting ? handleLongPress : undefined}
      style={[styles.toolBubble, isSelected && styles.selectedBubble]}
    >
      <View style={styles.toolHeader}>
        <Text style={styles.toolChevron}>{expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}</Text>
        <Text style={styles.senderLabelTool}>
          {message.serverName ? (
            <>
              <Text style={styles.mcpServerTag}>{message.serverName}</Text>
              {' '}{displayTool}
            </>
          ) : (
            <>Tool: {displayTool}</>
          )}
        </Text>
      </View>
      {expanded ? (
        <Text selectable style={styles.toolContentExpanded}>{content}</Text>
      ) : (
        <Text style={styles.toolContentCollapsed} numberOfLines={1}>{preview}</Text>
      )}
    </TouchableOpacity>
  );
}

// Permission detail rendering, countdown, summary, and pill components
// are imported from ./PermissionDetail

// PermissionPill imported from ./PermissionDetail

// -- Single message bubble --

function MessageBubble({ message, onSelectOption, isSelected, isSelecting, onLongPress, onPress, onOpenDetail, onImagePress }: {
  message: ChatMessage;
  onSelectOption?: (value: string, messageId: string, requestId?: string, toolUseId?: string) => void;
  isSelected: boolean;
  isSelecting: boolean;
  onLongPress: () => void;
  onPress: () => void;
  onOpenDetail: (toolName: string, content: string, toolResult?: string, toolResultTruncated?: boolean, toolResultImages?: ToolResultImage[], serverName?: string) => void;
  onImagePress?: (uri: string) => void;
}) {
  const longPressedRef = useRef(false);
  const [isExpired, setIsExpired] = useState(() =>
    message.expiresAt != null && message.expiresAt <= Date.now()
  );
  const [permissionExpanded, setPermissionExpanded] = useState(false);
  const isUser = message.type === 'user_input';
  const isTool = message.type === 'tool_use';
  const isThinking = message.type === 'thinking';
  const isPrompt = message.type === 'prompt';
  const isError = message.type === 'error';
  const isSystem = message.type === 'system';

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
      style={[styles.messageBubble, isUser && styles.userBubble, isPrompt && styles.promptBubble, isError && styles.errorBubble, isSystem && styles.systemBubble, isSelected && styles.selectedBubble]}
    >
      <View style={isPrompt && message.expiresAt && !message.answered ? styles.promptHeaderRow : undefined}>
        <Text style={isUser ? styles.senderLabelUser : isPrompt ? styles.senderLabelPrompt : isError ? styles.senderLabelError : isSystem ? styles.senderLabelSystem : styles.senderLabelClaude}>
          {isUser ? 'You' : isPrompt ? (message.tool || 'Action Required') : isError ? 'Error' : isSystem ? 'System' : 'Claude'}
        </Text>
        {isPrompt && !message.answered && message.expiresAt && (
          <PermissionCountdown expiresAt={message.expiresAt} onExpire={() => setIsExpired(true)} />
        )}
      </View>
      {isPrompt && message.toolInput ? (
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
                <Text style={styles.attachmentChipIcon}>{ICON_DOCUMENT}</Text>
                <Text style={styles.attachmentChipName} numberOfLines={1}>{att.name}</Text>
              </View>
            )
          ))}
        </View>
      )}
      {isPrompt && message.options && (
        <View style={styles.promptOptions}>
          {message.options.map((opt, i) => {
            const isAnswered = message.answered != null;
            const isDisabled = isAnswered || isExpired;
            const isChosen = message.answered === opt.value;
            return (
              <TouchableOpacity
                key={i}
                style={[
                  styles.promptOptionButton,
                  isDisabled && !isChosen && styles.promptOptionDisabled,
                  isChosen && styles.promptOptionChosen,
                ]}
                disabled={isDisabled}
                onPress={() => onSelectOption?.(opt.value, message.id, message.requestId, message.toolUseId)}
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
                <ActivityGroup
                  messages={group.messages}
                  isActive={group.isActive}
                  isSelecting={isSelecting}
                  selectedIds={selectedIds}
                  onToggleSelection={onToggleSelection}
                  searchMatchIds={searchMatchIds}
                />
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
          <Text style={styles.scrollButtonText}>{ICON_ARROW_UP}</Text>
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
          <Text style={styles.scrollButtonText}>{ICON_ARROW_DOWN}</Text>
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
  attachmentChipIcon: {
    fontSize: 14,
  },
  attachmentChipName: {
    color: COLORS.textPrimary,
    fontSize: 12,
    maxWidth: 100,
  },
  thinkingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  thinkingLabel: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
  },
  thinkingDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  thinkingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentBlue,
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
  // countdownText, countdownUrgent, countdownExpired → PermissionDetail.tsx
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
  activityGroup: {
    backgroundColor: COLORS.backgroundTertiary,
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.backgroundCard,
    maxWidth: '90%',
  },
  activityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  activityPulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentBlue,
    opacity: 0.8,
  },
  activitySummary: {
    flex: 1,
    color: COLORS.accentPurple,
    fontSize: 12,
    fontWeight: '600',
  },
  activityChevron: {
    color: COLORS.textMuted,
    fontSize: 10,
  },
  activityList: {
    marginTop: 8,
    maxHeight: 200,
  },
  activityEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 44,
    paddingVertical: 10,
  },
  activityEntryIcon: {
    color: COLORS.textDim,
    fontSize: 8,
  },
  activityEntryTool: {
    color: COLORS.accentPurple,
    fontSize: 11,
    fontWeight: '500',
    minWidth: 40,
  },
  activityEntryPreview: {
    flex: 1,
    color: COLORS.textMuted,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  activityImageBadge: {
    color: COLORS.accentBlue,
    fontSize: 10,
    fontWeight: '600',
    marginRight: 4,
  },
  mcpServerTag: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: '400',
  },
  toolBubble: {
    backgroundColor: COLORS.backgroundTertiary,
    padding: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginBottom: 8,
    maxWidth: '85%',
    borderWidth: 1,
    borderColor: COLORS.backgroundCard,
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  toolChevron: {
    color: COLORS.textMuted,
    fontSize: 10,
  },
  senderLabelTool: {
    color: COLORS.accentPurple,
    fontSize: 11,
    fontWeight: '600',
  },
  toolContentCollapsed: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  toolContentExpanded: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 6,
    lineHeight: 18,
  },
  toolModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  toolModalContainer: {
    width: '100%',
    maxHeight: '80%',
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
    overflow: 'hidden',
  },
  toolModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  toolModalTitleContainer: {
    flex: 1,
  },
  toolModalTitle: {
    color: COLORS.accentPurple,
    fontSize: 14,
    fontWeight: '600',
    marginRight: 12,
  },
  toolModalServerLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  toolModalCloseButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -12,
  },
  toolModalCloseIcon: {
    color: COLORS.textMuted,
    fontSize: 18,
  },
  toolModalScroll: {
    padding: 16,
  },
  toolModalContent: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
  },
  toolModalSectionLabel: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  toolImageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  toolImageThumb: {
    width: 140,
    height: 100,
    borderRadius: 8,
    backgroundColor: COLORS.backgroundCard,
  },
  messageText: {
    color: COLORS.textChatMessage,
    fontSize: 15,
    lineHeight: 22,
  },
  userMessageText: {
    color: COLORS.textPrimary,
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
  scrollButtonText: {
    color: COLORS.accentBlue,
    fontSize: 18,
    fontWeight: 'bold',
  },
  // permDetailBlock, permDetailLabel, permDetailCode → PermissionDetail.tsx
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
  // permissionPill*, collapseLink*, permissionInfoNote → PermissionDetail.tsx
});
