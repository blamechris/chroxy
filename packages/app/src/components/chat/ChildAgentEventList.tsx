/**
 * ChildAgentEventList (mobile) — #5060
 *
 * React Native port of the dashboard's `ChildAgentEventList` (#5016).
 * Renders the nested per-event timeline inside a Task tool_call bubble
 * when the dispatched subagent has emitted intermediate progress
 * (`tool_start` / `tool_result` / `tool_input_delta` / `stream_delta`)
 * via the server's `agent_event` re-emit path.
 *
 * The reducer (`reduceEvents`) is a verbatim port of the dashboard's
 * load-bearing logic so the two platforms can't drift on how the flat
 * `agent_event` log collapses into per-tool rows + a concatenated
 * assistant-text block. Only the rendering layer differs (RN
 * View/Text/Pressable vs. DOM div/span).
 *
 * Design (mirrors the dashboard):
 *   - One row per `tool_start` / `tool_result` pair, keyed by the
 *     child's `toolUseId`. `tool_input_delta` chunks accumulate onto
 *     the row's `inputPartial`; `tool_result` resolves the row.
 *   - `stream_delta` chunks concatenate into a single text block;
 *     contiguous deltas inside the same `messageId` merge directly,
 *     while a `messageId` transition inserts a blank line so multi-
 *     round child output doesn't fuse unrelated paragraphs.
 *   - Rows open collapsed and expand on tap. Default is "all
 *     collapsed" so a Task with many child tools doesn't explode the
 *     layout the first time the parent bubble expands.
 *   - Unknown event types are silently ignored by the reducer.
 *
 * testIDs mirror the dashboard's data-testids so the mobile Maestro /
 * jest assertions can reuse the same naming:
 *   - child-agent-events-<parentToolUseId>
 *   - child-agent-events-header
 *   - child-agent-tool-<toolUseId>
 *   - child-agent-tool-pulse-<toolUseId>
 *   - child-agent-tool-input-<toolUseId>
 *   - child-agent-tool-result-<toolUseId>
 *   - child-agent-stream-text-<parentToolUseId>
 */

import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, LayoutAnimation } from 'react-native';
import type { ChildAgentEvent } from '@chroxy/store-core';
import { formatToolName, getInputSummary, getPartialSummary } from '@chroxy/store-core';
import { COLORS } from '../../constants/colors';

interface ChildAgentEventListProps {
  events: ChildAgentEvent[];
  /** Parent Task tool_use id — scopes testIDs so sibling Tasks don't collide. */
  parentToolUseId: string;
}

/**
 * One row in the nested list — a tool_use from the child agent, with
 * its accumulated input + final result text (when present).
 */
interface ChildToolRow {
  toolUseId: string;
  toolName: string;
  input?: Record<string, unknown> | string;
  inputPartial?: string;
  result?: string;
  serverName?: string;
  hasResult: boolean;
}

/**
 * Reduce the flat `agent_event` log into a structured per-tool list +
 * one concatenated assistant-text block. Pure — recomputed via
 * `useMemo` when `events` changes. Verbatim port of the dashboard's
 * `reduceEvents` so the two stay in lockstep.
 */
function reduceEvents(events: ChildAgentEvent[]): {
  tools: ChildToolRow[];
  assistantText: string;
} {
  const tools: ChildToolRow[] = [];
  const byId = new Map<string, ChildToolRow>();
  let assistantText = '';
  let lastStreamMessageId: string | null = null;
  for (const ev of events) {
    const p = ev.payload || {};
    if (ev.type === 'tool_start') {
      const toolUseId = typeof p.toolUseId === 'string' ? p.toolUseId : null;
      if (!toolUseId) continue;
      const toolName = typeof p.tool === 'string' ? p.tool : 'tool';
      const serverName = typeof p.serverName === 'string' ? p.serverName : undefined;
      const input =
        (p.input && typeof p.input === 'object') || typeof p.input === 'string'
          ? (p.input as Record<string, unknown> | string)
          : undefined;
      const existing = byId.get(toolUseId);
      if (existing) {
        // Idempotent — a replayed `tool_start` overwrites name/input
        // but preserves the resolved state.
        existing.toolName = toolName;
        existing.input = input ?? existing.input;
        existing.serverName = serverName ?? existing.serverName;
        continue;
      }
      const row: ChildToolRow = {
        toolUseId,
        toolName,
        input,
        serverName,
        hasResult: false,
      };
      byId.set(toolUseId, row);
      tools.push(row);
    } else if (ev.type === 'tool_input_delta') {
      const toolUseId = typeof p.toolUseId === 'string' ? p.toolUseId : null;
      const partialJson = typeof p.partialJson === 'string' ? p.partialJson : null;
      if (!toolUseId || partialJson === null) continue;
      const row = byId.get(toolUseId);
      if (!row) continue;
      row.inputPartial = (row.inputPartial || '') + partialJson;
    } else if (ev.type === 'tool_result') {
      const toolUseId = typeof p.toolUseId === 'string' ? p.toolUseId : null;
      const result = typeof p.result === 'string' ? p.result : '';
      if (!toolUseId) continue;
      let row = byId.get(toolUseId);
      if (!row) {
        // Defensive: tool_result arrived without a preceding tool_start.
        // Synthesise a row so the result is visible.
        row = { toolUseId, toolName: 'tool', hasResult: false };
        byId.set(toolUseId, row);
        tools.push(row);
      }
      row.result = result;
      row.hasResult = true;
    } else if (ev.type === 'stream_delta') {
      const delta = typeof p.delta === 'string' ? p.delta : null;
      if (delta) {
        const messageId = typeof p.messageId === 'string' ? p.messageId : null;
        if (
          messageId &&
          lastStreamMessageId &&
          messageId !== lastStreamMessageId &&
          assistantText.length > 0
        ) {
          assistantText += '\n\n';
        }
        assistantText += delta;
        if (messageId) lastStreamMessageId = messageId;
      }
    }
    // Unknown types fall through silently and are NOT rendered.
  }
  return { tools, assistantText };
}

export function ChildAgentEventList({ events, parentToolUseId }: ChildAgentEventListProps) {
  const reduced = useMemo(() => reduceEvents(events), [events]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((s) => ({ ...s, [id]: !s[id] }));
  };

  if (reduced.tools.length === 0 && !reduced.assistantText) {
    // The parent ToolBubble only mounts us when there is at least one
    // event; this branch is the safety-net for an all-empty payload.
    return null;
  }

  return (
    <View style={styles.list} testID={`child-agent-events-${parentToolUseId}`}>
      <Text style={styles.header} testID="child-agent-events-header">
        Subagent progress
      </Text>
      {reduced.tools.map((row) => {
        const isExpanded = !!expanded[row.toolUseId];
        const summary =
          getInputSummary(row.input) ||
          (row.inputPartial ? getPartialSummary(row.inputPartial) : '') ||
          (row.inputPartial ? row.inputPartial.slice(0, 100) : '');
        return (
          <Pressable
            key={row.toolUseId}
            testID={`child-agent-tool-${row.toolUseId}`}
            accessibilityRole="button"
            accessibilityState={{ expanded: isExpanded }}
            // Tapping a row must NOT bubble to the parent ToolBubble (which
            // would collapse it). RN doesn't propagate Pressable presses to
            // ancestor Touchables by default, so no explicit stopPropagation
            // is needed — but we keep the handler row-scoped regardless.
            onPress={() => toggle(row.toolUseId)}
            style={[styles.row, isExpanded && styles.rowExpanded]}
          >
            <View style={styles.rowHeader}>
              {!row.hasResult && (
                <View
                  style={styles.pulse}
                  testID={`child-agent-tool-pulse-${row.toolUseId}`}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                />
              )}
              <Text style={styles.toolName}>{formatToolName(row.toolName, row.serverName)}</Text>
              {!!summary && (
                <Text
                  style={styles.toolInput}
                  testID={`child-agent-tool-input-${row.toolUseId}`}
                  numberOfLines={1}
                >
                  {summary}
                </Text>
              )}
            </View>
            {isExpanded && row.result !== undefined && (
              <Text
                selectable
                style={styles.toolResult}
                testID={`child-agent-tool-result-${row.toolUseId}`}
              >
                {row.result}
              </Text>
            )}
          </Pressable>
        );
      })}
      {!!reduced.assistantText && (
        <Text
          selectable
          style={styles.streamText}
          testID={`child-agent-stream-text-${parentToolUseId}`}
        >
          {reduced.assistantText}
        </Text>
      )}
    </View>
  );
}

// Exported for unit-test reach into the reducer without rendering RN.
export { reduceEvents as __reduceEventsForTest };

const styles = StyleSheet.create({
  list: {
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.backgroundCard,
    gap: 4,
  },
  header: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  row: {
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  rowExpanded: {
    backgroundColor: COLORS.backgroundCard,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  pulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentBlue,
    opacity: 0.8,
  },
  toolName: {
    color: COLORS.accentPurple,
    fontSize: 11,
    fontWeight: '600',
  },
  toolInput: {
    flexShrink: 1,
    color: COLORS.textMuted,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  toolResult: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 4,
    lineHeight: 16,
  },
  streamText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 4,
    lineHeight: 18,
  },
});
