/**
 * MessageBubble memoization — #5516 (epic #5514, "smooth streaming")
 *
 * Proves the React.memo wrapper added in #5516 stops non-tail chat bubbles
 * from re-rendering (and re-parsing markdown) on a streaming delta flush.
 *
 * The store's `flushPendingDeltas` replaces ONLY the streamed message's object
 * (`{ ...m, content: m.content + d }`) — every other message keeps its
 * identity across the flush. This test reproduces that exact shape: a stable
 * non-tail message + a tail message whose object is swapped for one with more
 * content, then a parent re-render with FRESH callback identities (mirroring
 * ChatView, which recreates callbacks every render). Only the tail bubble may
 * re-render.
 *
 * Render counts are read from the shared dev-only counter in @chroxy/store-core
 * (keyed `MessageBubble:<id>`), the same instrument added for the latency work.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { getRenderCount, resetRenderCounts } from '@chroxy/store-core';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';

function responseMessage(id: string, content: string): ChatMessage {
  return {
    id,
    type: 'response',
    content,
    timestamp: 1000,
  } as ChatMessage;
}

/** Render a list of bubbles the way ChatView does — fresh callbacks each pass. */
function Harness({ messages }: { messages: ChatMessage[] }) {
  return (
    <>
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          // Fresh closures every render — must NOT defeat the memo.
          isSelected={false}
          isSelecting={false}
          onLongPress={() => {}}
          onPress={() => {}}
          onOpenDetail={() => {}}
          onImagePress={() => {}}
          onSelectOption={() => {}}
        />
      ))}
    </>
  );
}

describe('MessageBubble memoization (#5516)', () => {
  beforeEach(() => resetRenderCounts());

  it('only the tail/streaming bubble re-renders on a delta flush', () => {
    const nonTail = responseMessage('m-1', 'Earlier finished message');
    const tailV1 = responseMessage('m-2', 'Streaming so far');

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness messages={[nonTail, tailV1]} />);
    });

    expect(getRenderCount('MessageBubble:m-1')).toBe(1);
    expect(getRenderCount('MessageBubble:m-2')).toBe(1);

    // Simulate flushPendingDeltas: the non-tail object is UNCHANGED (same
    // reference), the tail object is replaced with appended content.
    const tailV2 = { ...tailV1, content: tailV1.content + ' …and more tokens' };
    act(() => {
      tree.update(<Harness messages={[nonTail, tailV2]} />);
    });

    // The non-tail bubble must NOT have re-rendered (no markdown re-parse).
    expect(getRenderCount('MessageBubble:m-1')).toBe(1);
    // The tail bubble re-rendered exactly once to show the new tokens.
    expect(getRenderCount('MessageBubble:m-2')).toBe(2);
  });

  it('re-renders a bubble when a render-affecting scalar prop changes', () => {
    // Guard against an over-aggressive comparator: isSelected toggling must
    // still re-render that bubble.
    const msg = responseMessage('s-1', 'Pick me');

    function SelectableHarness({ selected }: { selected: boolean }) {
      return (
        <MessageBubble
          message={msg}
          isSelected={selected}
          isSelecting
          onLongPress={() => {}}
          onPress={() => {}}
          onOpenDetail={() => {}}
        />
      );
    }

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SelectableHarness selected={false} />);
    });
    expect(getRenderCount('MessageBubble:s-1')).toBe(1);

    act(() => {
      tree.update(<SelectableHarness selected />);
    });
    expect(getRenderCount('MessageBubble:s-1')).toBe(2);
  });
});
