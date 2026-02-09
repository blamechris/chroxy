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
} from 'react-native';
import { ChatMessage } from '../store/connection';
import { FormattedResponse } from './MarkdownRenderer';

// Named Unicode constants for readability
const ICON_CHEVRON_RIGHT = '\u25B8'; // Right-pointing triangle
const ICON_CHEVRON_DOWN = '\u25BE';  // Down-pointing triangle
const ICON_ARROW_UP = '\u2191';      // Upward arrow
const ICON_ARROW_DOWN = '\u2193';    // Downward arrow

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

function ToolBubble({ message, isSelected, isSelecting, onLongPress, onPress }: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onLongPress: () => void;
  onPress: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const longPressedRef = useRef(false);
  const content = message.content?.trim();

  // Hide empty tool messages
  if (!content) return null;

  const handlePress = () => {
    // Suppress onPress that fires after a long-press gesture
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) {
      onPress();
    } else {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded((prev) => !prev);
    }
  };

  const handleLongPress = () => {
    longPressedRef.current = true;
    onLongPress();
  };

  const preview = content.length > 60 ? content.slice(0, 60) + '...' : content;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      onLongPress={handleLongPress}
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

  if (isThinking) {
    return (
      <View style={styles.thinkingBubble}>
        <Text style={styles.thinkingText}>Thinking...</Text>
      </View>
    );
  }

  if (isTool) {
    return (
      <ToolBubble
        message={message}
        isSelected={isSelected}
        isSelecting={isSelecting}
        onLongPress={onLongPress}
        onPress={onPress}
      />
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={isSelecting ? onPress : undefined}
      onLongPress={isSelecting ? undefined : onLongPress}
      style={[styles.messageBubble, isUser && styles.userBubble, isPrompt && styles.promptBubble, isError && styles.errorBubble, isSelected && styles.selectedBubble]}
    >
      <Text style={isUser ? styles.senderLabelUser : isPrompt ? styles.senderLabelPrompt : isError ? styles.senderLabelError : styles.senderLabelClaude}>
        {isUser ? 'You' : isPrompt ? 'Action Required' : isError ? 'Error' : 'Claude'}
      </Text>
      {!isUser && !isPrompt && !isError ? (
        <FormattedResponse content={message.content?.trim() || ''} messageTextStyle={styles.messageText} />
      ) : (
        <Text selectable style={[styles.messageText, isUser && styles.userMessageText, isError && styles.errorMessageText]}>
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
    color: '#666',
    fontSize: 16,
  },
  messageBubble: {
    backgroundColor: '#1a1a2e',
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '85%',
  },
  userBubble: {
    backgroundColor: '#4a9eff22',
    alignSelf: 'flex-end',
    borderColor: '#4a9eff44',
    borderWidth: 1,
  },
  thinkingBubble: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  thinkingText: {
    color: '#666',
    fontSize: 13,
    fontStyle: 'italic',
  },
  senderLabelUser: {
    color: '#4a9eff',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  senderLabelClaude: {
    color: '#22c55e',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  senderLabelPrompt: {
    color: '#f59e0b',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  promptBubble: {
    backgroundColor: '#f59e0b11',
    borderColor: '#f59e0b44',
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
    backgroundColor: '#f59e0b33',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f59e0b66',
  },
  promptOptionText: {
    color: '#f59e0b',
    fontSize: 14,
    fontWeight: '600',
  },
  errorBubble: {
    backgroundColor: '#ff4a4a11',
    borderColor: '#ff4a4a44',
    borderWidth: 1,
  },
  senderLabelError: {
    color: '#ff4a4a',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  errorMessageText: {
    color: '#e8a0a0',
  },
  selectedBubble: {
    borderColor: '#4a9eff',
    borderWidth: 2,
  },
  activityGroup: {
    backgroundColor: '#16162a',
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2a2a4e',
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
    backgroundColor: '#4a9eff',
    opacity: 0.8,
  },
  activitySummary: {
    flex: 1,
    color: '#a78bfa',
    fontSize: 12,
    fontWeight: '600',
  },
  activityChevron: {
    color: '#888',
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
    color: '#666',
    fontSize: 8,
  },
  activityEntryTool: {
    color: '#a78bfa',
    fontSize: 11,
    fontWeight: '500',
    minWidth: 40,
  },
  activityEntryPreview: {
    flex: 1,
    color: '#888',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  toolBubble: {
    backgroundColor: '#16162a',
    padding: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginBottom: 8,
    maxWidth: '85%',
    borderWidth: 1,
    borderColor: '#2a2a4e',
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  toolChevron: {
    color: '#888',
    fontSize: 10,
  },
  senderLabelTool: {
    color: '#a78bfa',
    fontSize: 11,
    fontWeight: '600',
  },
  toolContentCollapsed: {
    color: '#888',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  toolContentExpanded: {
    color: '#ccc',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 6,
    lineHeight: 18,
  },
  messageText: {
    color: '#e0e0e0',
    fontSize: 15,
    lineHeight: 22,
  },
  userMessageText: {
    color: '#fff',
  },
  scrollButton: {
    position: 'absolute',
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1a1a2ebb',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#4a4a6e',
    shadowColor: '#000',
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
    color: '#4a9eff',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
