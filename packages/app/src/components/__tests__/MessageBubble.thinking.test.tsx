/**
 * #6756 — mobile content-capable thinking view.
 *
 * A `type: 'thinking'` bubble that carries real reasoning content renders the
 * expandable ThinkingBubble disclosure (parity with the dashboard's
 * ThinkingBody); an empty thinking bubble (the ephemeral placeholder) keeps the
 * generic ThinkingIndicator animation.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
// The real ThinkingIndicator drives a native-driver Animated loop that crashes
// react-test-renderer (findNodeHandle is undefined off-device). Stub it so the
// empty-content fallback branch is still assertable without the animation.
jest.mock('../chat/ThinkingIndicator', () => ({
  ThinkingIndicator: () => {
    const { Text: RNText } = require('react-native');
    return <RNText testID="thinking-indicator-stub">indicator</RNText>;
  },
}));
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';

beforeEach(() => {
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
});

function makeThinking(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1-thinking-0',
    type: 'thinking',
    content: 'weighing the trade-offs',
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessage;
}

function render(message: ChatMessage) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <MessageBubble
        message={message}
        isSelected={false}
        isSelecting={false}
        onLongPress={() => {}}
        onPress={() => {}}
        onOpenDetail={() => {}}
        onSelectOption={jest.fn()}
      />,
    );
  });
  return tree;
}

/** Concatenated text of the toggle line (e.g. "▸ Thought"). */
function toggleLabel(tree: renderer.ReactTestRenderer): string {
  const toggle = tree.root.findByProps({ testID: 'thinking-toggle' });
  const label = toggle.findByType(Text).props.children;
  return (Array.isArray(label) ? label : [label]).join('');
}

describe('MessageBubble thinking content (#6756)', () => {
  it('renders an expandable disclosure with the reasoning content', () => {
    const tree = render(makeThinking({ thinkingStreaming: false }));
    // Label reads "Thought" once streaming has ended.
    expect(toggleLabel(tree)).toContain('Thought');
    // Collapsed by default — no content node yet.
    expect(tree.root.findAllByProps({ testID: 'thinking-content' })).toHaveLength(0);
    // Expand.
    act(() => { tree.root.findByProps({ testID: 'thinking-toggle' }).props.onPress(); });
    const content = tree.root.findByProps({ testID: 'thinking-content' });
    const text = (Array.isArray(content.props.children) ? content.props.children : [content.props.children]).join('');
    expect(text).toBe('weighing the trade-offs');
  });

  it('labels "Thinking…" while thinkingStreaming is true', () => {
    const tree = render(makeThinking({ thinkingStreaming: true }));
    expect(toggleLabel(tree)).toContain('Thinking…');
  });

  // #6391 footer-stat — a finished thinking bubble carrying a measured duration
  // (+ tokens) shows the compact `thought for Xs · N tokens` footer.
  it('renders the footer-stat "thought for Xs · N tokens" when duration + tokens are present (#6391)', () => {
    const tree = render(makeThinking({ thinkingStreaming: false, thinkingDurationMs: 4200, thinkingTokens: 128 }));
    expect(toggleLabel(tree)).toContain('thought for 4.2s · 128 tokens');
  });

  it('renders duration alone when tokens are absent (claude SDK/BYOK) (#6391)', () => {
    const tree = render(makeThinking({ thinkingStreaming: false, thinkingDurationMs: 19000 }));
    const label = toggleLabel(tree);
    expect(label).toContain('thought for 19s');
    expect(label).not.toContain('tokens');
  });

  it('degrades to a bare "Thought" when no footer-stat is present (old sessions) (#6391)', () => {
    const tree = render(makeThinking({ thinkingStreaming: false }));
    const label = toggleLabel(tree);
    expect(label).toContain('Thought');
    expect(label).not.toContain('thought for');
  });

  it('falls back to the ThinkingIndicator animation when there is no content', () => {
    const tree = render(makeThinking({ content: '' }));
    // No disclosure bubble…
    expect(tree.root.findAllByProps({ testID: 'thinking-bubble' })).toHaveLength(0);
    // …instead the generic (stubbed) thinking indicator.
    expect(tree.root.findAllByProps({ testID: 'thinking-indicator-stub' }).length).toBeGreaterThan(0);
  });

  it('appends a "[thinking truncated]" marker when the content hit the size cap (#6756 review)', () => {
    const tree = render(makeThinking({ thinkingStreaming: false, thinkingTruncated: true }));
    act(() => { tree.root.findByProps({ testID: 'thinking-toggle' }).props.onPress(); });
    const content = tree.root.findByProps({ testID: 'thinking-content' });
    const text = (Array.isArray(content.props.children) ? content.props.children : [content.props.children]).join('');
    expect(text).toContain('weighing the trade-offs');
    expect(text).toContain('[thinking truncated]');
  });

  it('omits the truncation marker when the flag is absent (#6756 review)', () => {
    const tree = render(makeThinking({ thinkingStreaming: false }));
    act(() => { tree.root.findByProps({ testID: 'thinking-toggle' }).props.onPress(); });
    const content = tree.root.findByProps({ testID: 'thinking-content' });
    const text = (Array.isArray(content.props.children) ? content.props.children : [content.props.children]).join('');
    expect(text).not.toContain('[thinking truncated]');
  });

  it('exposes a ≥44pt effective touch target on the toggle, both axes (#6756 review)', () => {
    // Same convention as DiffHunkView's ≥44pt toggle test / the MarkdownRenderer
    // copy-button test: min dimensions carried by the style, both axes asserted.
    const tree = render(makeThinking({ thinkingStreaming: false }));
    const toggle = tree.root.findByProps({ testID: 'thinking-toggle' });
    const style = StyleSheet.flatten(toggle.props.style) as { minHeight?: number; minWidth?: number };
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
  });
});
