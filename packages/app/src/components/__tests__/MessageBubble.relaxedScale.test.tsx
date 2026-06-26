/**
 * Mobile relaxed reading scale (chat redesign #6391).
 *
 * The assistant prose body uses the dashboard's document leading ratio
 * (lineHeight 24 over the 15px body = 1.60). This pins that the relaxed
 * `messageText` leading actually REACHES the rendered prose — catching a future
 * regression where `messageText` is detached from the body or the value drifts
 * back to the old cramped 22. The reflow/scroll behaviour the looser leading
 * produces is visual and verified on-device / via Maestro, not here.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, StyleSheet } from 'react-native';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';

beforeEach(() => {
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
});

function makeResponse(content: string): ChatMessage {
  return { id: 'r-relaxed', type: 'response', content, timestamp: Date.now() };
}

function render(message: ChatMessage): renderer.ReactTestRenderer {
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
      />,
    );
  });
  return tree;
}

describe('MessageBubble relaxed reading scale (chat redesign #6391)', () => {
  it('renders assistant prose at the relaxed 1.60 leading (24 over the 15px body)', () => {
    const tree = render(makeResponse('Hello from the assistant'));
    // Every 15px body text run must carry the relaxed 24px leading (= 1.60),
    // not the old cramped 22. `messageText` is injected as messageTextStyle into
    // FormattedResponse, so the rendered paragraph inherits fontSize 15 + the
    // new lineHeight 24.
    const bodyLeadings = tree.root
      .findAllByType(Text)
      .map((t) => StyleSheet.flatten(t.props.style))
      .filter((s) => s && s.fontSize === 15)
      .map((s) => s.lineHeight);
    expect(bodyLeadings.length).toBeGreaterThan(0);
    expect(bodyLeadings.every((lh) => lh === 24)).toBe(true);
  });
});
