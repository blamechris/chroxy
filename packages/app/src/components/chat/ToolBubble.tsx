import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  LayoutAnimation,
} from 'react-native';
import { getPartialSummary, tryParseCompleteJson, shouldSuppressRawToolInput } from '@chroxy/store-core';
import type { ChatMessage, ToolResultImage } from '../../store/connection';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import { formatToolName } from './chat-utils';
import { TodoList, parseTodoList } from './TodoList';
import { ChildAgentEventList } from './ChildAgentEventList';

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

export function ToolBubble({ message, isSelected, isSelecting, onToggleSelection, onOpenDetail, getInitialExpanded, onExpandedChange }: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onToggleSelection: () => void;
  onOpenDetail: (toolName: string, content: string, toolResult?: string, toolResultTruncated?: boolean, toolResultImages?: ToolResultImage[], serverName?: string) => void;
  /** #5517: seed + persist expand state in ChatView's id-keyed registry so
   *  it survives FlatList row recycling. */
  getInitialExpanded?: (id: string) => boolean;
  onExpandedChange?: (id: string, expanded: boolean) => void;
}) {
  const [expanded, setExpandedRaw] = useState(() => getInitialExpanded?.(message.id) ?? false);
  const setExpanded = (next: boolean) => {
    setExpandedRaw(next);
    onExpandedChange?.(message.id, next);
  };
  const longPressedRef = useRef(false);
  // #6018 / #5770 — AskUserQuestion's tool_input shape is internal: the mobile
  // surface already renders the structured question via the QuestionPrompt /
  // MultiQuestionForm card (driven by the parallel `user_question` event).
  // Surfacing the raw `{"questions":[...` JSON in the collapsed summary or the
  // expanded partial-preview next to that card produces the two-bubbles-for-one-
  // prompt symptom (#4667). Gate computed once so both branches stay in sync.
  // Mirrors `shouldSuppressRawToolInput` usage in the dashboard ToolBubble (#5770).
  // Must be computed before `partialPreview` and `partialSummary` so both gating
  // sites can reference it without a temporal dead zone.
  const suppressRawInput = shouldSuppressRawToolInput(message.tool);
  // #4081: streaming inputs land in `toolInputPartial` before `content`
  // is populated. Use it as the bubble body when `content` is empty or
  // identical to the tool name (the placeholder handleToolStart sets
  // when `msg.input` is missing). The result-arrival path is unchanged.
  // #6018 — gate on suppressRawInput: AskUserQuestion's raw tool_input
  // must never surface in the expanded body (the structured QuestionPrompt
  // card is the canonical render path for that tool).
  const partialPreview = !message.toolResult && message.toolInputPartial && !suppressRawInput
    ? formatPartialPreview(message.toolInputPartial)
    : '';
  const rawContent = message.content?.trim() || '';
  const isPlaceholderContent = !rawContent || rawContent === message.tool;
  const content = partialPreview && isPlaceholderContent
    ? partialPreview
    : (rawContent || partialPreview);

  // Hide empty tool messages (for suppressed tools, content = rawContent = tool
  // name placeholder, which is always non-empty after handleToolStart — so the
  // bubble renders as a quiet placeholder with just the tool name + pulse marker).
  if (!content) return null;

  const displayTool = formatToolName(message.tool);

  // #4321 / #4308 — in-flight pulse marker. The collapsed header was
  // visually identical for running vs. completed tools pre-fix; a small
  // blue dot in the header (mirroring the dashboard `tool-bubble-pulse`)
  // distinguishes them at a glance. Checked against `toolResult ===
  // undefined` (not `!toolResult`) so a tool that finished with no
  // output (`toolResult === ''`) does NOT render as in-flight. Mirrors
  // the same predicate used by the ActivityIndicator above.
  const hasResult =
    message.toolResult !== undefined || (message.toolResultImages?.length ?? 0) > 0;
  const inFlight = !hasResult;

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
  // #6018 — suppress raw tool_input in the collapsed preview for tools whose
  // input is handled by a dedicated structured card. When suppressed, the
  // collapsed bubble shows only the tool name (header). Matches the dashboard
  // ToolBubble's `suppressRawInput` gate on the `summary` computation.
  const partialSummary = message.toolInputPartial && !suppressRawInput
    ? getPartialSummary(message.toolInputPartial)
    : null;
  const contentSummary = !isPlaceholderContent && !suppressRawInput
    ? getPartialSummary(content)
    : null;
  const previewSource = partialSummary && isPlaceholderContent
    ? partialSummary
    : (contentSummary || (suppressRawInput ? '' : content));
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
        {inFlight && (
          <View
            style={styles.pulse}
            testID={`tool-bubble-pulse-${message.toolUseId ?? message.id}`}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        )}
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
        <>
          {todoParsed ? (
            <TodoList parsed={todoParsed} />
          ) : (
            <Text selectable style={styles.toolContentExpanded}>{content}</Text>
          )}
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
      ) : (
        <Text
          testID="tool-collapsed-preview"
          style={styles.toolContentCollapsed}
          numberOfLines={1}
        >{preview}</Text>
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
  // #4321 / #4308 — in-flight marker, mirrors the dashboard's
  // `.tool-bubble-pulse` (6px blue dot, slightly transparent).
  pulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentBlue,
    opacity: 0.8,
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
