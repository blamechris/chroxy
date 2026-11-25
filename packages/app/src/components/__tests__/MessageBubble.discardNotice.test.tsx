/**
 * MessageBubble renders the "Not sent" Stop notice (#9069).
 *
 * The visibility tests (selectChatMessages, buildChatViewMessages) prove the
 * row reaches the Chat tab; this one proves the bubble then actually draws it,
 * so a renderer that began dropping a system row carrying `discardedFollowUps`
 * cannot go unnoticed.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';

const CONTENT = 'Not sent — Stop discarded 2 queued messages: “one”, “two”';

function textOf(node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null): string {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children ?? [])
    .map((c) => (typeof c === 'string' ? c : textOf(c)))
    .join('');
}

describe('MessageBubble — Stop discard notice (#9069)', () => {
  it('draws the notice text', () => {
    const message = {
      id: 'queue-discarded-1',
      type: 'system',
      content: CONTENT,
      timestamp: Date.now(),
      discardedFollowUps: [{ id: 'a', preview: 'one' }, { id: 'b', preview: 'two' }],
    } as ChatMessage;
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
    expect(textOf(tree.toJSON())).toContain('Not sent — Stop discarded 2 queued messages');
  });
});
