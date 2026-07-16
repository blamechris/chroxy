import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  LayoutAnimation,
} from 'react-native';
import type { ChatMessage } from '../../store/connection';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import { ThinkingIndicator } from './ThinkingIndicator';
import { TodoList, parseTodoList } from './TodoList';
import { ChildAgentEventList } from './ChildAgentEventList';
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
  getInitialExpanded,
  onExpandedChange,
}: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onToggleSelection: (id: string) => void;
  /** #5517: seed expand state from ChatView's id-keyed registry so it
   *  survives FlatList row recycling (the row may unmount when scrolled
   *  off-screen and remount fresh). */
  getInitialExpanded?: (id: string) => boolean;
  onExpandedChange?: (id: string, expanded: boolean) => void;
}) {
  const longPressedRef = useRef(false);
  // #4201: per-entry expand state so each tool row can independently reveal
  // its structured renderer (TodoList for TodoWrite, future MCP tools,
  // etc.) without expanding every sibling. The pre-#4201 row was a static
  // truncated-text preview — ToolBubble's structured renderer was dead
  // code for chat because ChatView never routes tool_use through
  // MessageBubble → ToolBubble (groupMessages always wraps in activity
  // groups).
  //
  // #5517: seed from the ChatView registry so a recycled row reopens to
  // the user's last choice instead of resetting to collapsed.
  const [expanded, setExpanded] = useState(() => getInitialExpanded?.(message.id) ?? false);

  const setExpandedTracked = (next: boolean) => {
    setExpanded(next);
    onExpandedChange?.(message.id, next);
  };

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
    setExpandedTracked(!expanded);
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
        {/* #6712: a failed tool_result (codex mcpToolCall / orphan sweep) shows a
            red alert icon instead of the green check. */}
        {hasResult ? (
          message.toolResultIsError ? (
            <Icon name="alertCircle" size={12} color={COLORS.accentRed} testID={`activity-entry-error-${message.id}`} />
          ) : (
            <Icon name="check" size={12} color={COLORS.accentGreen} />
          )
        ) : (
          <Icon name="chevronRight" size={12} color={COLORS.textMuted} />
        )}
        <Text style={styles.activityEntryTool}>{displayTool}</Text>
        {imageCount > 0 && (
          <Text style={styles.activityImageBadge}>{imageCount === 1 ? '1 image' : `${imageCount} images`}</Text>
        )}
        <Text style={styles.activityEntryPreview} numberOfLines={1}>
          {hasResult ? (message.toolResult || '').slice(0, 60) : (message.content || '').slice(0, 40)}
        </Text>
      </View>
      {expanded && (
        <>
          {(() => {
            if (todoParsed) return <TodoList parsed={todoParsed} />
            // #4203: prefer toolResult text when present; otherwise fall back to
            // content (pre-result/pending state). When toolResult is undefined
            // but images are attached (e.g. screenshot tool with no text body),
            // the pre-#4203 expression resolved to an empty string and the
            // expanded body was visually blank even though the row's image
            // badge said 'N images'. Render an explicit placeholder so the
            // user sees what's there. Inline image rendering can land later
            // — the placeholder is the minimum signal.
            const resultText = hasResult ? (message.toolResult || '') : (message.content || '')
            if (resultText.length > 0) {
              return (
                <Text selectable style={styles.activityEntryExpanded}>
                  {resultText}
                </Text>
              )
            }
            if (imageCount > 0) {
              return (
                <Text style={styles.activityEntryExpanded}>
                  {imageCount === 1 ? '1 image attached (preview not yet rendered inline)' : `${imageCount} images attached (preview not yet rendered inline)`}
                </Text>
              )
            }
            return (
              <Text style={styles.activityEntryExpanded}>
                (no output)
              </Text>
            )
          })()}
          {/* #5060 — Task subagent nested progress. The child's
              intermediate tool_start/tool_result/tool_input_delta/
              stream_delta events arrive as `agent_event` and accumulate
              in `childAgentEvents`, mirroring the dashboard's nested
              sub-bubble rendering under the parent Task tool_call. */}
          {message.childAgentEvents && message.childAgentEvents.length > 0 && message.toolUseId && (
            <ChildAgentEventList
              events={message.childAgentEvents}
              parentToolUseId={message.toolUseId}
            />
          )}
        </>
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
  groupKey,
  getInitialExpanded,
  onExpandedChange,
}: {
  messages: ChatMessage[];
  isActive: boolean;
  isSelecting: boolean;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  searchMatchIds?: Set<string>;
  /** #5517: stable group id (the `activity-<firstId>` key) used to seed +
   *  persist the group's expand state across FlatList row recycling. */
  groupKey?: string;
  getInitialExpanded?: (id: string) => boolean;
  onExpandedChange?: (id: string, expanded: boolean) => void;
}) {
  // #5517: the group's registry key must stay in the `activity-<id>`
  // namespace so it never collides with an entry's bare `message.id` (entries
  // register under their own id). ChatView always passes `group.key`; the
  // fallback mirrors its `activity-<firstId>` shape so a caller that omits
  // groupKey can't bleed the group's expand flag onto its first entry.
  const registryKey = groupKey
    ?? (activityMessages[0]?.id ? `activity-${activityMessages[0].id}` : '');
  const [expanded, setExpanded] = useState(() => getInitialExpanded?.(registryKey) ?? false);
  const setExpandedTracked = (next: boolean) => {
    setExpanded(next);
    onExpandedChange?.(registryKey, next);
  };
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
      setExpandedTracked(true);
    }
  }, [hasSearchMatch]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePress = () => {
    if (isSelecting) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedTracked(!expanded);
  };

  // Auto-collapse when activity completes
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (wasActiveRef.current && !isActive) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpandedTracked(false);
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
        // #6103: a plain View, not a nested ScrollView. A vertical ScrollView
        // nested inside the virtualized chat list (#5534) is a React Native
        // anti-pattern — it intercepts the entries' touch responders (their
        // onPress never fired, so an entry could not be expanded) and triggers
        // the "VirtualizedLists should never be nested" path. The outer chat
        // list already scrolls; the group grows with its entries.
        <View style={styles.activityList}>
          {activityMessages.map((msg) => (
            <ActivityEntry
              key={msg.id}
              message={msg}
              isSelected={selectedIds.has(msg.id)}
              isSelecting={isSelecting}
              onToggleSelection={onToggleSelection}
              getInitialExpanded={getInitialExpanded}
              onExpandedChange={onExpandedChange}
            />
          ))}
        </View>
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
