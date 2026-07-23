/**
 * MessageBubble queued-follow-up edit/cancel controls — #6628
 *
 * A follow-up sent mid-turn sits in the server's outgoing queue with a "Queued"
 * badge under its user bubble. Before it flushes the user must be able to:
 *   - cancel it (existing #5938 affordance), and
 *   - edit it — reopen its text in the composer and cancel the queued entry.
 *
 * This suite asserts the queued row renders both controls with role + label and
 * that tapping Edit fires `onEditQueued(id, text)` while Cancel fires
 * `onCancelQueued(id)`. The cancel-and-reopen wiring lives in SessionScreen; the
 * bubble's job is just to surface the two intents with the right payloads.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';

function makeQueuedUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'uin-1',
    type: 'user_input',
    content: 'follow-up text',
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessage;
}

function render(
  message: ChatMessage,
  handlers: {
    onEditQueued?: jest.Mock;
    onCancelQueued?: jest.Mock;
  } = {},
) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <MessageBubble
        message={message}
        queued
        onCancelQueued={handlers.onCancelQueued}
        onEditQueued={handlers.onEditQueued}
        isSelected={false}
        isSelecting={false}
        onLongPress={() => {}}
        onPress={() => {}}
        onOpenDetail={() => {}}
        onSelectOption={() => {}}
      />,
    );
  });
  return tree;
}

describe('MessageBubble queued edit/cancel (#6628)', () => {
  it('renders an Edit control with role + label that fires onEditQueued(id, text)', () => {
    const onEditQueued = jest.fn();
    const tree = render(makeQueuedUserMessage(), { onEditQueued });
    const edit = tree.root.findByProps({ testID: 'msg-queued-edit-uin-1' });
    expect(edit.props.accessibilityRole).toBe('button');
    expect(edit.props.accessibilityLabel).toBe('Edit queued message');
    act(() => { edit.props.onPress(); });
    expect(onEditQueued).toHaveBeenCalledTimes(1);
    expect(onEditQueued).toHaveBeenCalledWith('uin-1', 'follow-up text');
  });

  it('still fires onCancelQueued(id) from the Cancel control alongside Edit', () => {
    const onCancelQueued = jest.fn();
    const tree = render(makeQueuedUserMessage(), { onCancelQueued, onEditQueued: jest.fn() });
    const cancel = tree.root.findByProps({ testID: 'msg-queued-cancel-uin-1' });
    act(() => { cancel.props.onPress(); });
    expect(onCancelQueued).toHaveBeenCalledTimes(1);
    expect(onCancelQueued).toHaveBeenCalledWith('uin-1');
  });

  it('omits the Edit control when no onEditQueued handler is supplied', () => {
    const tree = render(makeQueuedUserMessage(), { onCancelQueued: jest.fn() });
    expect(tree.root.findAllByProps({ testID: 'msg-queued-edit-uin-1' })).toHaveLength(0);
    // The cancel control (and the queued badge) still render.
    expect(tree.root.findAllByProps({ testID: 'msg-queued-cancel-uin-1' }).length).toBeGreaterThanOrEqual(1);
  });
});
