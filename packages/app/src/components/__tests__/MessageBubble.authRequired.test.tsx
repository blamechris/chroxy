/**
 * MessageBubble AUTH_REQUIRED integration — #8223
 *
 * MessageBubble special-cases `error{code:'AUTH_REQUIRED'}` and renders the
 * AuthRequiredChip in place of the generic red error bubble, and — like the
 * other chips — it must not steal the stall / resume codes or swallow generic
 * errors. The branch order inside MessageBubble is what this pins.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'err-auth-1',
    type: 'error',
    code: 'AUTH_REQUIRED',
    content: 'Claude is not logged in on this host, or its login expired.',
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessage;
}

function render(message: ChatMessage, onRetryStreamStall?: () => void) {
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
        onRetryStreamStall={onRetryStreamStall}
      />,
    );
  });
  return tree;
}

describe('MessageBubble AUTH_REQUIRED handling (#8223)', () => {
  it('renders the AuthRequiredChip with the server message and the login command', () => {
    const tree = render(makeMessage());
    expect(tree.root.findByProps({ testID: 'auth-required-chip' })).toBeDefined();
    expect(tree.root.findByProps({ testID: 'auth-required-chip-body' }).props.children)
      .toBe('Claude is not logged in on this host, or its login expired.');
    expect(tree.root.findByProps({ testID: 'auth-required-chip-command' }).props.children)
      .toBe('claude auth login');
  });

  it('does not offer the stall chip\'s Retry even when a retry handler is wired', () => {
    const tree = render(makeMessage(), jest.fn());
    expect(tree.root.findAllByProps({ testID: 'stream-stall-chip' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'stream-stall-chip-retry' })).toHaveLength(0);
  });

  it('leaves other error codes to their own chips / the generic bubble', () => {
    for (const code of ['stream_stall', 'resume_unknown', 'SOMETHING_ELSE', undefined]) {
      const tree = render(makeMessage({ code, content: 'x' }));
      expect(tree.root.findAllByProps({ testID: 'auth-required-chip' })).toHaveLength(0);
    }
  });
});
