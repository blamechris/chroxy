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
} from 'react-native';
import { ChatMessage } from '../store/connection';
import { FormattedResponse } from './MarkdownRenderer';
import { ICON_CHEVRON_RIGHT, ICON_CHEVRON_DOWN, ICON_ARROW_UP, ICON_ARROW_DOWN } from '../constants/icons';
import { COLORS } from '../constants/colors';


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
  onSelectOption: (value: string, requestId?: string) => void;
  isCliMode: boolean;
  selectedIds: Set<string>;
  isSelecting: boolean;
  isSelectingRef: React.MutableRefObject<boolean>;
  onToggleSelection: (id: string) => void;
  streamingMessageId: string | null;
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

// -- Activity group component --

function ActivityGroup({
  messages: activityMessages,
  isActive,
  isSelecting,
  selectedIds,
  onToggleSelection,
}: {
  messages: ChatMessage[];
  isActive: boolean;
  isSelecting: boolean;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = activityMessages.filter((m) => m.type === 'tool_use').length;
  const lastMessage = activityMessages[activityMessages.length - 1];
  const isThinking = isActive && lastMessage?.type === 'thinking';

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
            <TouchableOpacity
              key={msg.id}
              activeOpacity={0.7}
              onLongPress={isSelecting ? undefined : () => onToggleSelection(msg.id)}
              onPress={isSelecting ? () => onToggleSelection(msg.id) : undefined}
              style={[styles.activityEntry, selectedIds.has(msg.id) && styles.selectedBubble]}
            >
              <Text style={styles.activityEntryIcon}>{ICON_CHEVRON_RIGHT}</Text>
              <Text style={styles.activityEntryTool}>{msg.tool || 'Thinking'}</Text>
              <Text style={styles.activityEntryPreview} numberOfLines={1}>
                {(msg.content || '').slice(0, 40)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </TouchableOpacity>
  );
}

// -- Collapsible tool use bubble --

function ToolBubble({ message, isSelected, isSelecting, onToggleSelection }: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onToggleSelection: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const longPressedRef = useRef(false);
  const content = message.content?.trim();

  // Hide empty tool messages
  if (!content) return null;

  const handlePress = () => {
    // Suppress the tap that fires on release after a long-press
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) {
      onToggleSelection();
    } else {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded((prev) => !prev);
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
        <Text style={styles.senderLabelTool}>Tool: {message.tool}</Text>
      </View>
      {expanded ? (
        <Text selectable style={styles.toolContentExpanded}>{content}</Text>
      ) : (
        <Text style={styles.toolContentCollapsed} numberOfLines={1}>{preview}</Text>
      )}
    </TouchableOpacity>
  );
}

// -- Permission detail renderer --

function PermissionDetail({ tool, toolInput }: { tool?: string; toolInput?: Record<string, unknown> }) {
  if (!toolInput || !tool) return null;

  const toolName = tool.toLowerCase();

  // Bash: show command in code block
  if (toolName === 'bash' && typeof toolInput.command === 'string') {
    return (
      <View style={styles.permDetailBlock}>
        <Text style={styles.permDetailLabel}>Command</Text>
        <Text selectable style={styles.permDetailCode}>{toolInput.command}</Text>
      </View>
    );
  }

  // Edit/Write: show file path and content preview
  if ((toolName === 'edit' || toolName === 'write') && typeof toolInput.file_path === 'string') {
    const preview = typeof toolInput.new_string === 'string'
      ? toolInput.new_string
      : typeof toolInput.content === 'string'
        ? toolInput.content
        : null;
    return (
      <View style={styles.permDetailBlock}>
        <Text style={styles.permDetailLabel}>File</Text>
        <Text selectable style={styles.permDetailCode}>{toolInput.file_path}</Text>
        {preview && (
          <>
            <Text style={[styles.permDetailLabel, { marginTop: 6 }]}>
              {toolName === 'edit' ? 'Change' : 'Content'}
            </Text>
            <Text selectable style={styles.permDetailCode} numberOfLines={6}>
              {preview.slice(0, 500)}
            </Text>
          </>
        )}
      </View>
    );
  }

  // Read/Glob/Grep: show path or pattern with correct label
  if (toolName === 'read' || toolName === 'glob' || toolName === 'grep') {
    let target: string | null = null;
    let label = 'Path';
    if (typeof toolInput.file_path === 'string') {
      target = toolInput.file_path;
    } else if (typeof toolInput.pattern === 'string') {
      target = toolInput.pattern;
      label = 'Pattern';
    } else if (typeof toolInput.path === 'string') {
      target = toolInput.path;
    }
    if (target) {
      return (
        <View style={styles.permDetailBlock}>
          <Text style={styles.permDetailLabel}>{label}</Text>
          <Text selectable style={styles.permDetailCode}>{target}</Text>
        </View>
      );
    }
  }

  // Fallback: show description or first meaningful field
  const desc = typeof toolInput.description === 'string'
    ? toolInput.description
    : null;
  if (desc) {
    return (
      <View style={styles.permDetailBlock}>
        <Text selectable style={styles.permDetailCode}>{desc}</Text>
      </View>
    );
  }

  return null;
}

function PermissionDetailOrFallback({ tool, toolInput, fallback }: { tool?: string; toolInput?: Record<string, unknown>; fallback: string }) {
  const detail = PermissionDetail({ tool, toolInput });
  if (detail) return detail;
  return <Text selectable style={styles.messageText}>{fallback}</Text>;
}

// -- Single message bubble --

function MessageBubble({ message, onSelectOption, isSelected, isSelecting, onLongPress, onPress }: {
  message: ChatMessage;
  onSelectOption?: (value: string, requestId?: string) => void;
  isSelected: boolean;
  isSelecting: boolean;
  onLongPress: () => void;
  onPress: () => void;
}) {
  const isUser = message.type === 'user_input';
  const isTool = message.type === 'tool_use';
  const isThinking = message.type === 'thinking';
  const isPrompt = message.type === 'prompt';
  const isError = message.type === 'error';
  const isSystem = message.type === 'system';

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
      />
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={isSelecting ? onPress : undefined}
      onLongPress={isSelecting ? undefined : onLongPress}
      style={[styles.messageBubble, isUser && styles.userBubble, isPrompt && styles.promptBubble, isError && styles.errorBubble, isSystem && styles.systemBubble, isSelected && styles.selectedBubble]}
    >
      <Text style={isUser ? styles.senderLabelUser : isPrompt ? styles.senderLabelPrompt : isError ? styles.senderLabelError : isSystem ? styles.senderLabelSystem : styles.senderLabelClaude}>
        {isUser ? 'You' : isPrompt ? (message.tool || 'Action Required') : isError ? 'Error' : isSystem ? 'System' : 'Claude'}
      </Text>
      {isPrompt && message.toolInput ? (
        <PermissionDetailOrFallback tool={message.tool} toolInput={message.toolInput} fallback={message.content?.trim() || ''} />
      ) : !isUser && !isPrompt && !isError && !isSystem ? (
        <FormattedResponse content={message.content?.trim() || ''} messageTextStyle={styles.messageText} />
      ) : (
        <Text selectable style={[styles.messageText, isUser && styles.userMessageText, isError && styles.errorMessageText, isSystem && styles.systemMessageText]}>
          {message.content?.trim()}
        </Text>
      )}
      {isPrompt && message.options && (
        <View style={styles.promptOptions}>
          {message.options.map((opt, i) => (
            <TouchableOpacity
              key={i}
              style={styles.promptOptionButton}
              onPress={() => onSelectOption?.(opt.value, message.requestId)}
            >
              <Text style={styles.promptOptionText}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </TouchableOpacity>
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
}: ChatViewProps) {
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

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
          if (!isSelectingRef.current) scrollViewRef.current?.scrollToEnd();
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
              <ActivityGroup
                key={group.key}
                messages={group.messages}
                isActive={group.isActive}
                isSelecting={isSelecting}
                selectedIds={selectedIds}
                onToggleSelection={onToggleSelection}
              />
            );
          }
          const msg = group.message;
          return (
            <MessageBubble
              key={msg.id}
              message={msg}
              onSelectOption={onSelectOption}
              isSelected={selectedIds.has(msg.id)}
              isSelecting={isSelecting}
              onLongPress={() => onToggleSelection(msg.id)}
              onPress={() => onToggleSelection(msg.id)}
            />
          );
        })
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
    </View>
  );
}

// -- Styles --

const styles = StyleSheet.create({
  chatContainer: {
    flex: 1,
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
    paddingVertical: 3,
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
  permDetailBlock: {
    marginTop: 4,
  },
  permDetailLabel: {
    color: COLORS.accentOrange,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  permDetailCode: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: COLORS.backgroundTertiary,
    padding: 8,
    borderRadius: 6,
    overflow: 'hidden',
  },
});
