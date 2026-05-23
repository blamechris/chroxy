/**
 * Integration tests for the chat ToolBubble's TodoWrite renderer wiring (#4180).
 *
 * The structured `TodoList` parser/renderer is covered by `TodoList.test.tsx`.
 * This file covers the *integration site* in `ToolBubble.tsx`: that the
 * structured renderer is only used for TodoWrite messages, only after the
 * bubble has been expanded, only when `message.toolResult` is present, and
 * falls back to the raw-text path otherwise. The Copilot review on #4194
 * caught an early version that parsed `message.content` (JSON-stringified
 * tool input from `handleToolStart`) instead of `message.toolResult` — these
 * tests pin that regression.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { ToolBubble } from '../chat/ToolBubble';
import type { ChatMessage } from '../../store/connection';

const TODOWRITE_RESULT = [
  'Todo list (3 items): 1 in progress, 1 pending, 1 completed',
  '  [x] Wrote helper (t1)',
  '  [~] Running tests (t2)',
  '  [ ] Address review (t3)',
].join('\n');

function makeToolMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'tool-1',
    type: 'tool_use',
    // `content` is JSON-stringified tool *input* (per handleToolStart);
    // intentionally NOT the executor's checklist text so the tests fail
    // loudly if ToolBubble ever parses `content` again.
    content: '{"todos":[{"id":"t1","status":"completed","content":"Wrote helper"}]}',
    tool: 'TodoWrite',
    toolUseId: 'toolu_xyz',
    toolResult: TODOWRITE_RESULT,
    timestamp: 0,
    ...overrides,
  };
}

function renderBubble(message: ChatMessage): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <ToolBubble
        message={message}
        isSelected={false}
        isSelecting={false}
        onToggleSelection={() => {}}
        onOpenDetail={() => {}}
      />,
    );
  });
  return root;
}

function findByTestId(root: renderer.ReactTestRenderer, id: string) {
  return root.root.findAllByProps({ testID: id });
}

function tapToExpand(root: renderer.ReactTestRenderer) {
  // The outer TouchableOpacity's onPress flips `expanded` to true on first
  // tap (when not already expanded and not in selection mode).
  const touchables = root.root.findAllByProps({ activeOpacity: 0.7 });
  expect(touchables.length).toBeGreaterThan(0);
  act(() => {
    touchables[0]!.props.onPress();
  });
}

describe('ToolBubble — TodoWrite integration (#4180)', () => {
  it('does not render the structured TodoList while collapsed', () => {
    const root = renderBubble(makeToolMessage());
    // No expanded structured list yet — header testID must be absent.
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
  });

  it('renders the structured TodoList after expanding when toolResult is present', () => {
    const root = renderBubble(makeToolMessage());
    tapToExpand(root);
    // Structured renderer now visible.
    expect(findByTestId(root, 'todo-list-header')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-item-t1')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-item-t2')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-item-t3')[0]).toBeTruthy();
  });

  it('parses message.toolResult — not message.content (pins #4194 regression)', () => {
    // `content` is plainly NOT a TodoWrite header here; if the parser were
    // pointed at it, the structured renderer would not appear and we'd see
    // the raw JSON in the fallback Text instead.
    const root = renderBubble(makeToolMessage({
      content: '{"some":"input"}',
      toolResult: TODOWRITE_RESULT,
    }));
    tapToExpand(root);
    // Structured render confirms we parsed toolResult.
    expect(findByTestId(root, 'todo-list-header')[0]).toBeTruthy();
    // And the raw JSON input must NOT appear inside the expanded body.
    const texts = root.root.findAllByType(Text);
    const allText = texts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(allText).not.toMatch(/"some":"input"/);
  });

  it('falls back to raw-text rendering when toolResult is missing (result not arrived yet)', () => {
    const root = renderBubble(makeToolMessage({ toolResult: undefined }));
    tapToExpand(root);
    // No structured renderer (no result yet).
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
    // Raw `content` is shown in the expanded fallback Text instead.
    const texts = root.root.findAllByType(Text);
    const allText = texts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(allText).toMatch(/"todos"/);
  });

  it('falls back to raw-text rendering when toolResult is present but unparseable', () => {
    const root = renderBubble(makeToolMessage({
      content: 'tool-input-marker-string',
      toolResult: 'bash output: command not found',
    }));
    tapToExpand(root);
    // Structured renderer must not appear — parser returns null on the
    // unparseable toolResult.
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
    // ToolBubble's existing fallback Text renders `content` (pre-PR
    // behavior — broader UX question of rendering toolResult in the
    // unparseable case is outside #4180's scope).
    const texts = root.root.findAllByType(Text);
    const allText = texts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(allText).toMatch(/tool-input-marker-string/);
  });

  it('does not invoke the structured renderer for non-TodoWrite tools', () => {
    const root = renderBubble(makeToolMessage({
      tool: 'Bash',
      toolResult: TODOWRITE_RESULT, // even with a TodoWrite-shaped string
    }));
    tapToExpand(root);
    // Tool gate is tool === 'TodoWrite'; Bash must NEVER render the list.
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
  });
});
