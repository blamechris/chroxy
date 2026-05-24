import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  LayoutAnimation,
} from 'react-native';
import { getPartialSummary } from '@chroxy/store-core';
import type { ChatMessage, ToolResultImage } from '../../store/connection';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import { formatToolName } from './chat-utils';
import { TodoList, parseTodoList } from './TodoList';

/**
 * #4081: while a `tool_use` is streaming its input via
 * `tool_input_delta`, `handleToolStart`'s initial `content` is just the
 * tool name (the server hadn't computed final input yet — see
 * store-core/handlers/index.ts where `content` falls through input →
 * tool name → ''). We surface `message.toolInputPartial` instead so
 * the user sees the JSON forming (canonical case: Bash `command`,
 * needed for early-abort UX #4063). Best-effort pretty-print: try
 * JSON.parse first, fall back to verbatim text on parse failure (mid-
 * stream partial JSON is inherently unparseable — that's normal, NOT
 * an error). Once `toolResult` arrives the bubble renders the result
 * via the existing onOpenDetail path; the partial buffer becomes
 * informational only.
 *
 * #4242: gate the parse behind `tryParseCompleteJson` so we skip the
 * throw on the N-1 mid-stream deltas whose tail can't yet be `}`/`]`.
 */
function formatPartialPreview(partial: string): string {
  const parsed = tryParseCompleteJson(partial);
  if (parsed !== undefined) {
    return JSON.stringify(parsed, null, 2);
  }
  return partial;
}

export function ToolBubble({ message, isSelected, isSelecting, onToggleSelection, onOpenDetail }: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onToggleSelection: () => void;
  onOpenDetail: (toolName: string, content: string, toolResult?: string, toolResultTruncated?: boolean, toolResultImages?: ToolResultImage[], serverName?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const longPressedRef = useRef(false);
  // #4081: streaming inputs land in `toolInputPartial` before `content`
  // is populated. Use it as the bubble body when `content` is empty or
  // identical to the tool name (the placeholder handleToolStart sets
  // when `msg.input` is missing). The result-arrival path is unchanged.
  const partialPreview = !message.toolResult && message.toolInputPartial
    ? formatPartialPreview(message.toolInputPartial)
    : '';
  const rawContent = message.content?.trim() || '';
  const isPlaceholderContent = !rawContent || rawContent === message.tool;
  const content = partialPreview && isPlaceholderContent
    ? partialPreview
    : (rawContent || partialPreview);

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

  // #4243: collapsed-preview field-priority extraction — mirrors the
  // dashboard's `getPartialSummary` so the same useful single field
  // (`command` / `file_path` / `path` / `description`) surfaces on both
  // platforms.
  //
  // Two paths feed this preview:
  //
  // - Streaming partial (`toolInputPartial`): `getPartialSummary`
  //   parses the in-flight buffer and extracts the priority field.
  //   When the partial has just become parseable but the server
  //   hasn't shipped the final input yet, `isPlaceholderContent` is
  //   true and the legacy fallback would otherwise show
  //   `{"command":"ls -la}` truncated to 60 chars — the dashboard
  //   already shows `ls -la` here, so we match it.
  //
  // - Final input (`message.content`): `handleToolStart` in
  //   store-core sets `content = JSON.stringify(msg.input)`. The
  //   legacy 60-char slice of that string gives users `{"command":
  //   "rm -rf node_mod` for a long Bash command. We try the same
  //   field-priority parse against `content` so the collapsed
  //   bubble surfaces `rm -rf node_modules` instead. Falls back to
  //   the raw 60-char slice when content isn't JSON-shaped (raw
  //   string inputs, server-sent placeholder text, etc.).
  //
  // The Bash early-abort UX (#4063) hinges on `command` being
  // legible at a glance without expanding the bubble.
  const partialSummary = message.toolInputPartial
    ? getPartialSummary(message.toolInputPartial)
    : null;
  const contentSummary = !isPlaceholderContent
    ? getPartialSummary(content)
    : null;
  const previewSource = partialSummary && isPlaceholderContent
    ? partialSummary
    : (contentSummary || content);
  const preview = previewSource.length > 60 ? previewSource.slice(0, 60) + '...' : previewSource;

  // #4180: TodoWrite tool_result is rendered as a structured checklist
  // when expanded. Parse once (only when expanded + tool matches + the
  // tool result has arrived) and fall back to plain text on parse
  // failure or before the result lands. Collapsed preview stays the
  // existing text snippet so the bubble's compact height is preserved.
  //
  // Important: parse `message.toolResult` (the executor's output text),
  // NOT `message.content` — `content` is the JSON-stringified tool
  // *input* set by `handleToolStart` in store-core, so it never matches
  // the "Todo list (N items)..." header. Mirrors the dashboard's
  // `parseTodoList(result)` call site.
  const todoParsed = expanded && message.tool === 'TodoWrite' && message.toolResult
    ? parseTodoList(message.toolResult)
    : null;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      onLongPress={!expanded && !isSelecting ? handleLongPress : undefined}
      style={[styles.toolBubble, isSelected && styles.selectedBubble]}
    >
      <View style={styles.toolHeader}>
        {expanded ? <Icon name="chevronDown" size={12} color={COLORS.textMuted} /> : <Icon name="chevronRight" size={12} color={COLORS.textMuted} />}
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
        todoParsed ? (
          <TodoList parsed={todoParsed} />
        ) : (
          <Text selectable style={styles.toolContentExpanded}>{content}</Text>
        )
      ) : (
        <Text style={styles.toolContentCollapsed} numberOfLines={1}>{preview}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
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
  senderLabelTool: {
    color: COLORS.accentPurple,
    fontSize: 11,
    fontWeight: '600',
  },
  mcpServerTag: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: '400',
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
  selectedBubble: {
    borderColor: COLORS.accentBlue,
    borderWidth: 2,
  },
});
