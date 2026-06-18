/**
 * #6018 — AskUserQuestion raw tool_input must never leak into the mobile chat.
 *
 * The dashboard surface gained this suppression in #5770 (#4667 original fix).
 * The mobile `ToolBubble` was a parallel leak surface: it rendered
 * `toolInputPartial` raw via `formatPartialPreview` (expanded body) and
 * `getPartialSummary` (collapsed preview) with no AskUserQuestion suppression.
 * On the claude-tui provider, AskUserQuestion streams its input as
 * `tool_input_delta` chunks, so the raw `{"questions":[...` JSON could appear
 * next to the structured QuestionPrompt / MultiQuestionForm card — two bubbles
 * for the same prompt.
 *
 * These tests drive the PRODUCTION wire path:
 *   handleToolStart + handleToolInputDelta → buildChatViewMessages → ToolBubble
 *
 * mirroring the dashboard's `AskUserQuestionRawInputLeak.test.tsx` (#5770)
 * for the React Native surface.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import {
  handleToolStart,
  handleToolInputDelta,
  buildChatViewMessages,
} from '@chroxy/store-core';
import type { ChatMessage } from '@chroxy/store-core';
import { ToolBubble } from '../chat/ToolBubble';

const SESSION = 'sess-mobile-1';

// Raw AskUserQuestion input JSON that must NEVER reach the mobile UI.
const ASK_QUESTION_CHUNKS = [
  '{"questions":[{"question":"Pick a deploy target",',
  '"header":"Deploy","options":[{"label":"staging"},',
  '{"label":"production"}]}]}',
];

/**
 * Build a store message list exactly as the mobile app would after receiving
 * the wire sequence for an AskUserQuestion tool_start + tool_input_delta
 * stream, mirroring the claude-tui provider's streaming behaviour.
 */
function buildAskUserQuestionMessages(): ChatMessage[] {
  const start = handleToolStart(
    {
      sessionId: SESSION,
      tool: 'AskUserQuestion',
      toolUseId: 'tu-ask',
      messageId: 'm-ask',
      // No `input` field — claude-tui streams input via tool_input_delta.
    },
    SESSION,
    false,
    [],
  );

  let messages: ChatMessage[] = [];
  if (start.chatMessage) messages.push(start.chatMessage);

  // Stream the raw JSON in chunks, exactly like the wire deltas.
  for (const partialJson of ASK_QUESTION_CHUNKS) {
    const delta = handleToolInputDelta(
      { sessionId: SESSION, toolUseId: 'tu-ask', partialJson },
      SESSION,
    );
    if (delta) messages = delta.applyTo(messages);
  }
  return messages;
}

function renderToolBubble(message: ChatMessage): renderer.ReactTestRenderer {
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

function tapToExpand(root: renderer.ReactTestRenderer) {
  const touchables = root.root.findAllByProps({ activeOpacity: 0.7 });
  expect(touchables.length).toBeGreaterThan(0);
  act(() => {
    touchables[0]!.props.onPress();
  });
}

/**
 * Collect every rendered string in the host tree. Walks the `toJSON()` output
 * (fragments already flattened) so nested `<Text>Tool: {displayTool}</Text>`
 * fragment children are captured — a one-level `findAllByType(Text)` flatten
 * misses them.
 */
function collectStrings(node: unknown): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(collectStrings);
  if (typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
    return collectStrings((node as { children: unknown }).children);
  }
  return [];
}

function getAllTextContent(root: renderer.ReactTestRenderer): string {
  return collectStrings(root.toJSON()).join(' ');
}

describe('#6018 AskUserQuestion raw tool_input must not leak on mobile', () => {
  it('wire path accumulates the raw JSON into toolInputPartial (sanity)', () => {
    const messages = buildAskUserQuestionMessages();
    const ask = messages.find((m) => m.toolUseId === 'tu-ask')!;
    expect(ask.tool).toBe('AskUserQuestion');
    // Confirm the accumulator holds the raw JSON — this is what must NOT render.
    expect(ask.toolInputPartial).toContain('"questions"');
    expect(ask.toolInputPartial).toContain('Pick a deploy target');
  });

  it('does NOT render the raw AskUserQuestion tool_input JSON in the collapsed preview', () => {
    const messages = buildAskUserQuestionMessages();
    const ask = messages.find((m) => m.toolUseId === 'tu-ask')!;
    const root = renderToolBubble(ask);

    // The collapsed preview (`testID="tool-collapsed-preview"`) must contain
    // neither the raw JSON brace nor the question text.
    const collapsed = root.root.findAllByProps({ testID: 'tool-collapsed-preview' });
    // The preview Text is rendered (bubble is visible as a quiet placeholder).
    expect(collapsed.length).toBeGreaterThan(0);
    const previewText = collapsed[0]!.props.children ?? '';
    const previewStr = Array.isArray(previewText)
      ? previewText.filter((c: unknown): c is string => typeof c === 'string').join('')
      : String(previewText);
    expect(previewStr).not.toMatch(/"questions"/);
    expect(previewStr).not.toMatch(/Pick a deploy target/);
    expect(previewStr).not.toMatch(/\{"questions"/);
  });

  it('does NOT render the raw AskUserQuestion tool_input JSON in the expanded body', () => {
    const messages = buildAskUserQuestionMessages();
    const ask = messages.find((m) => m.toolUseId === 'tu-ask')!;
    const root = renderToolBubble(ask);

    tapToExpand(root);

    const allText = getAllTextContent(root);
    expect(allText).not.toMatch(/"questions"/);
    expect(allText).not.toMatch(/Pick a deploy target/);
    expect(allText).not.toMatch(/\{"questions"/);
  });

  it('still renders the ToolBubble as a visible placeholder (tool name in header)', () => {
    const messages = buildAskUserQuestionMessages();
    const ask = messages.find((m) => m.toolUseId === 'tu-ask')!;
    const root = renderToolBubble(ask);

    // The bubble must not return null — it renders as a quiet placeholder
    // with the tool name in the header so the user knows a question is coming.
    const allText = getAllTextContent(root);
    // "AskUserQuestion" appears as the tool name in the header.
    expect(allText).toMatch(/AskUserQuestion/);
  });

  it('does NOT suppress non-AskUserQuestion tool input (Bash early-abort UX must be unaffected)', () => {
    // A Bash tool whose command streams in via tool_input_delta must still
    // be visible in the collapsed preview (Bash early-abort #4063).
    const start = handleToolStart(
      {
        sessionId: SESSION,
        tool: 'Bash',
        toolUseId: 'tu-bash',
        messageId: 'm-bash',
      },
      SESSION,
      false,
      [],
    );
    let messages: ChatMessage[] = [];
    if (start.chatMessage) messages.push(start.chatMessage);

    const delta = handleToolInputDelta(
      { sessionId: SESSION, toolUseId: 'tu-bash', partialJson: '{"command":"rm -rf node_modules"}' },
      SESSION,
    );
    if (delta) messages = delta.applyTo(messages);

    const bash = messages.find((m) => m.toolUseId === 'tu-bash')!;
    const root = renderToolBubble(bash);

    const collapsed = root.root.findByProps({ testID: 'tool-collapsed-preview' });
    const previewText = collapsed.props.children ?? '';
    const previewStr = Array.isArray(previewText)
      ? previewText.filter((c: unknown): c is string => typeof c === 'string').join('')
      : String(previewText);
    // The command must be visible in the collapsed preview (field-priority extraction).
    expect(previewStr).toMatch(/rm -rf node_modules/);
  });

  it('buildChatViewMessages round-trips — the ask survives as a tool_use bubble, raw partial held in the store', () => {
    // The AskUserQuestion survives the view pipeline as a tool_use bubble (so the
    // ToolBubble still renders) rather than being dropped — suppression happens at
    // RENDER time, not by discarding the message.
    const messages = buildAskUserQuestionMessages();
    const { chatMessages } = buildChatViewMessages(messages, null);
    expect(chatMessages.some((m) => m.type === 'tool_use')).toBe(true);
    // The store message still holds the raw partial (the data isn't scrubbed —
    // the ToolBubble just refuses to render it for suppressed tools).
    const ask = messages.find((m) => m.toolUseId === 'tu-ask')!;
    expect(ask.toolInputPartial).toContain('"questions"');
  });
});
