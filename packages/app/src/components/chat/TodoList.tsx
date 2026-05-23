/**
 * TodoList — React Native structured renderer for TodoWrite tool_result.
 *
 * Port of `packages/dashboard/src/components/TodoList.tsx` (#4179) to the
 * mobile app's chat UI. Same parser, same status taxonomy, same fallback
 * contract: if the header doesn't match `parseTodoList` returns null and
 * the caller renders the raw text instead.
 *
 * Executor output (`packages/server/src/byok-tool-executor.js` runTodoWrite):
 *
 *     Todo list (N items): X in progress, Y pending, Z completed
 *       [x] completed task (id-1)
 *       [~] in-progress task (id-2)
 *       [ ] pending task (id-3)
 *       … (showing first 100 of 150; full list retained server-side)
 *
 * Closes #4180.
 */
import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { COLORS } from '../../constants/colors';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  status: TodoStatus;
  content: string;
}

export interface ParsedTodoList {
  header: string;
  items: TodoItem[];
  truncationMarker?: string;
}

// Greedy content match + last (id) capture so "Run tests (timeout)" parses
// without the inner parens stealing the id capture group. Mirrors the
// dashboard regex (#4179).
const TODO_LINE_RE = /^\s*\[([ x~])\]\s+(.+)\s+\(([^)]+)\)\s*$/;

function statusFromMarker(marker: string): TodoStatus | null {
  switch (marker) {
    case 'x': return 'completed';
    case '~': return 'in_progress';
    case ' ': return 'pending';
    default: return null;
  }
}

/**
 * Parse the executor's text output into structured items. Returns null
 * when the FIRST line doesn't look like a TodoWrite header — the caller
 * (ToolBubble) then falls back to the raw-text rendering so nothing is
 * lost. Lines that don't match the line-item shape inside a valid list
 * are silently skipped (graceful degradation).
 */
export function parseTodoList(text: string): ParsedTodoList | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split('\n');
  if (lines.length === 0) return null;
  const header = lines[0] ?? '';
  if (!/^Todo list\s*\(\d+\s+items?\)/.test(header)) return null;
  const items: TodoItem[] = [];
  let truncationMarker: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) continue;
    const m = line.match(TODO_LINE_RE);
    if (m) {
      const status = statusFromMarker(m[1] ?? '');
      const content = (m[2] ?? '').trim();
      const id = (m[3] ?? '').trim();
      if (status && id.length > 0 && content.length > 0) {
        items.push({ id, status, content });
        continue;
      }
    }
    // Truncation marker pattern: '  … (showing first X of Y; ...)'
    if (line.includes('showing first')) {
      truncationMarker = line.trim();
    }
  }
  return { header, items, truncationMarker };
}

const STATUS_SYMBOL: Record<TodoStatus, string> = {
  completed: '✓',
  in_progress: '⋯',
  pending: '○',
};

const STATUS_LABEL: Record<TodoStatus, string> = {
  completed: 'completed',
  in_progress: 'in progress',
  pending: 'pending',
};

const STATUS_COLOR: Record<TodoStatus, string> = {
  completed: COLORS.accentGreen,
  in_progress: COLORS.accentOrange,
  pending: COLORS.textMuted,
};

export interface TodoListProps {
  /**
   * Raw text from the TodoWrite tool_result, OR a pre-parsed list. Pass
   * `parsed` when the caller has already invoked `parseTodoList` to
   * avoid a second parse pass (mirrors the dashboard prop shape).
   */
  text?: string;
  parsed?: ParsedTodoList | null;
}

export function TodoList({ text, parsed: parsedProp }: TodoListProps) {
  const parsed = parsedProp !== undefined ? parsedProp : parseTodoList(text ?? '');
  if (!parsed) return null;

  return (
    <View style={styles.container} testID="todo-list">
      <Text style={styles.header} testID="todo-list-header">
        {parsed.header}
      </Text>
      {parsed.items.length === 0 ? (
        <Text style={styles.empty}>No items.</Text>
      ) : (
        <View>
          {parsed.items.map((item) => (
            <View
              key={item.id}
              style={styles.item}
              testID={`todo-list-item-${item.id}`}
              accessibilityRole="text"
            >
              <Text
                style={[styles.marker, { color: STATUS_COLOR[item.status] }]}
                accessibilityLabel={STATUS_LABEL[item.status]}
              >
                {STATUS_SYMBOL[item.status]}
              </Text>
              <Text
                style={[
                  styles.content,
                  item.status === 'completed' && styles.contentCompleted,
                ]}
              >
                {item.content}
              </Text>
            </View>
          ))}
        </View>
      )}
      {parsed.truncationMarker ? (
        <Text style={styles.truncated} testID="todo-list-truncated">
          {parsed.truncationMarker}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accentBlue,
    marginVertical: 2,
  },
  header: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 1,
  },
  marker: {
    width: 16,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    marginRight: 6,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  content: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  contentCompleted: {
    color: COLORS.textMuted,
    textDecorationLine: 'line-through',
  },
  empty: {
    color: COLORS.textMuted,
    fontStyle: 'italic',
    fontSize: 11,
  },
  truncated: {
    color: COLORS.textMuted,
    fontStyle: 'italic',
    fontSize: 11,
    marginTop: 4,
  },
});
