/**
 * MessageBubble stream-stall integration — #4496
 *
 * Asserts that MessageBubble special-cases `error{code:'stream_stall'}`
 * and renders the StreamStallChip in place of the generic red error
 * bubble. Confirms `onRetryStreamStall` is forwarded to the chip and
 * the chip's Retry button only surfaces when the prop is wired
 * (mirrors the dashboard's `isTail` gate handled upstream in ChatView).
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';

function makeStallMessage(): ChatMessage {
  return {
    id: 'err-1',
    type: 'error',
    code: 'stream_stall',
    content: 'Stream stalled — no response for 5 minutes',
    timestamp: Date.now(),
  } as ChatMessage;
}

function makeGenericErrorMessage(): ChatMessage {
  return {
    id: 'err-2',
    type: 'error',
    content: 'Something exploded',
    timestamp: Date.now(),
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

describe('MessageBubble stream-stall handling (#4496)', () => {
  it('renders the StreamStallChip for error{code: "stream_stall"}', () => {
    const tree = render(makeStallMessage());
    const chip = tree.root.findByProps({ testID: 'stream-stall-chip' });
    expect(chip).toBeDefined();
  });

  it('falls through to the generic error bubble when code is missing', () => {
    // Legacy / non-stall errors must still render through the red
    // bubble path — the chip is only for the structured stall signal.
    const tree = render(makeGenericErrorMessage());
    const chips = tree.root.findAllByProps({ testID: 'stream-stall-chip' });
    expect(chips).toHaveLength(0);
  });

  it('shows the Retry button when onRetryStreamStall is wired (tail message)', () => {
    const onRetry = jest.fn();
    const tree = render(makeStallMessage(), onRetry);
    const retry = tree.root.findByProps({ testID: 'stream-stall-chip-retry' });
    act(() => {
      retry.props.onPress?.();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides the Retry button when onRetryStreamStall is undefined (historical)', () => {
    // ChatView leaves the prop unwired for any stall that isn't the
    // tail message — the chip then renders text only.
    const tree = render(makeStallMessage(), undefined);
    const retries = tree.root.findAllByProps({ testID: 'stream-stall-chip-retry' });
    expect(retries).toHaveLength(0);
  });
});
