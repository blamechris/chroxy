import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  LayoutAnimation,
} from 'react-native';
import type { ChatMessage } from '../../store/connection';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import { ThinkingIndicator } from './ThinkingIndicator';
import { TodoList, parseTodoList } from './TodoList';
import {
  summarizeToolCounts,
  formatToolBreakdown,
  formatToolName,
} from '@chroxy/store-core';

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
  // #4201: per-entry expand state so each tool row can independently reveal
  // its structured renderer (TodoList for TodoWrite, future MCP tools,
  // etc.) without expanding every sibling. The pre-#4201 row was a static
  // truncated-text preview — ToolBubble's structured renderer was dead
  // code for chat because ChatView never routes tool_use through
  // MessageBubble → ToolBubble (groupMessages always wraps in activity
  // groups).
  const [expanded, setExpanded] = useState(false);

  const handlePress = () => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) {
      onToggleSelection(message.id);
      return;
    }
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => !prev);
  };

  const handleLongPress = () => {
    longPressedRef.current = true;
    onToggleSelection(message.id);
  };

  // `toolResult` is set (possibly to '') as soon as the server's result
  // lands, so an explicit-undefined check distinguishes pending from
  // completed even when the result body is empty (#3794 review).
  const hasResult =
    message.toolResult !== undefined ||
    (message.toolResultImages?.length ?? 0) > 0;
  const imageCount = message.toolResultImages?.length || 0;

  // Use the shared formatter so per-row labels match the header breakdown
  // produced by `summarizeToolCounts` (e.g. "GitHub: List Repos" appears
  // in both places). Passing `serverName` ensures non-MCP-prefixed tools
  // routed through an MCP server still surface that origin (#3794 review).
  const displayTool = formatToolName(message.tool ?? 'Tool', message.serverName);

  // #4201: parse the TodoWrite tool_result only when the entry is
  // expanded and the tool name matches. Mirrors ToolBubble's call site
  // — `message.toolResult` (executor output), not `message.content`
  // (JSON-stringified tool input). Falls back to plain text when the
  // parser returns null, so unparseable results don't blank the entry.
  const todoParsed = expanded && message.tool === 'TodoWrite' && message.toolResult
    ? parseTodoList(message.toolResult)
    : null;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      // #4201: long-press is for entering selection mode; once the entry
      // is expanded the user expects long-press to trigger the system
      // text-selection on the expanded body (mirrors ToolBubble's
      // `!expanded && !isSelecting ? handleLongPress : undefined`
      // pattern at ToolBubble.tsx:74).
      onLongPress={!expanded && !isSelecting ? handleLongPress : undefined}
      onPress={handlePress}
      style={[styles.activityEntry, isSelected && styles.selectedBubble]}
      testID={`activity-entry-${message.id}`}
    >
      <View style={styles.activityEntryRow}>
        {hasResult ? <Icon name="check" size={12} color={COLORS.accentGreen} /> : <Icon name="chevronRight" size={12} color={COLORS.textMuted} />}
        <Text style={styles.activityEntryTool}>{displayTool}</Text>
        {imageCount > 0 && (
          <Text style={styles.activityImageBadge}>{imageCount === 1 ? '1 image' : `${imageCount} images`}</Text>
        )}
        <Text style={styles.activityEntryPreview} numberOfLines={1}>
          {hasResult ? (message.toolResult || '').slice(0, 60) : (message.content || '').slice(0, 40)}
        </Text>
      </View>
      {expanded && (
        todoParsed ? (
          <TodoList parsed={todoParsed} />
        ) : (
          <Text selectable style={styles.activityEntryExpanded}>
            {hasResult ? (message.toolResult || '') : (message.content || '')}
          </Text>
        )
      )}
    </TouchableOpacity>
  );
}

export function ActivityGroup({
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

  // Per-tool breakdown for the header (e.g. "10 Bash, 2 Read") so users can
  // see what the run actually did before expanding. Falls back to the bare
  // count when only thinking messages are present (#3747).
  const toolBreakdown = formatToolBreakdown(summarizeToolCounts(activityMessages));
  const baseSummary = isActive
    ? `Working... (${toolCount} tool${toolCount !== 1 ? 's' : ''})`
    : `${toolCount} tool${toolCount !== 1 ? 's' : ''} used`;
  const summary = toolBreakdown ? `${baseSummary} — ${toolBreakdown}` : baseSummary;

  // #4201: outer container is a View, not a TouchableOpacity, so each
  // ActivityEntry's own TouchableOpacity owns its tap region without
  // iOS accessibility merging the children into a single element. The
  // header row stays tappable via its own dedicated TouchableOpacity.
  return (
    <View style={styles.activityGroup} testID="activity-group">
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={handlePress}
        style={styles.activityHeader}
        testID="activity-group-header"
      >
        {isActive && <View style={styles.activityPulse} />}
        <Text style={styles.activitySummary}>{summary}</Text>
        {expanded ? <Icon name="chevronDown" size={14} color={COLORS.textMuted} /> : <Icon name="chevronRight" size={14} color={COLORS.textMuted} />}
      </TouchableOpacity>
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
    </View>
  );
}

const styles = StyleSheet.create({
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
  activityList: {
    marginTop: 8,
    maxHeight: 200,
  },
  activityEntry: {
    minHeight: 44,
    paddingVertical: 10,
  },
  activityEntryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  activityEntryExpanded: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 6,
    lineHeight: 18,
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
  selectedBubble: {
    borderColor: COLORS.accentBlue,
    borderWidth: 2,
  },
});
