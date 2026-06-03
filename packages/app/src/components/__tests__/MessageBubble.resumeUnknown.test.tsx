/**
 * MessageBubble resume-unknown integration — #4971
 *
 * Asserts that MessageBubble special-cases `error{code:'resume_unknown'}`
 * and renders the ResumeUnknownChip in place of the generic red error
 * bubble (analogous to the stream_stall dispatch covered by
 * MessageBubble.streamStall.test.tsx). Without this, the branch-order
 * inside MessageBubble (stream_stall vs. resume_unknown vs. generic
 * error) could regress unnoticed — e.g. a future refactor that swaps the
 * dispatch table, or a code/type mismatch between server and client.
 *
 * Also pins `attemptedResumeId` passthrough so the operator-correlation
 * subtext survives end-to-end from server payload to chip render.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';

function makeResumeUnknownMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'err-resume-1',
    type: 'error',
    code: 'resume_unknown',
    content: 'Previous Claude conversation could not be resumed',
    attemptedResumeId: 'abc-123',
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
      />,
    );
  });
  return tree;
}

describe('MessageBubble resume-unknown handling (#4971)', () => {
  it('renders the ResumeUnknownChip for error{code: "resume_unknown"}', () => {
    const tree = render(makeResumeUnknownMessage());
    const chip = tree.root.findByProps({ testID: 'resume-unknown-chip' });
    expect(chip).toBeDefined();
  });

  it('forwards attemptedResumeId so the id subtext renders', () => {
    const tree = render(
      makeResumeUnknownMessage({ attemptedResumeId: 'corr-id-xyz' }),
    );
    const idSubtext = tree.root.findByProps({ testID: 'resume-unknown-chip-id' });
    expect(idSubtext).toBeDefined();
  });

  it('omits the id subtext when attemptedResumeId is undefined (pre-#4944 server)', () => {
    const tree = render(
      makeResumeUnknownMessage({ attemptedResumeId: undefined }),
    );
    const ids = tree.root.findAllByProps({ testID: 'resume-unknown-chip-id' });
    expect(ids).toHaveLength(0);
  });

  it('does not render the resume chip for stream_stall (regression: branch order matters)', () => {
    // Guard against a future refactor that swaps the dispatch order or
    // type-checks the wrong code value — the stream_stall branch must
    // continue to win for stream_stall errors.
    const stall = {
      id: 'err-stall-1',
      type: 'error',
      code: 'stream_stall',
      content: 'Stream stalled',
      timestamp: Date.now(),
    } as ChatMessage;
    const tree = render(stall);
    const chips = tree.root.findAllByProps({ testID: 'resume-unknown-chip' });
    expect(chips).toHaveLength(0);
  });

  it('does not render the resume chip for non-error message types (chip is error-only)', () => {
    // Defense-in-depth: even if a non-error message somehow carries
    // `code: 'resume_unknown'` (e.g. a bug in a future server payload),
    // the chip must only surface from the error branch — otherwise we'd
    // mask legitimate assistant text.
    const response = {
      id: 'resp-1',
      type: 'response',
      // @ts-expect-error — deliberately wrong shape for the regression guard
      code: 'resume_unknown',
      content: 'Assistant response content',
      timestamp: Date.now(),
    } as ChatMessage;
    const tree = render(response);
    const chips = tree.root.findAllByProps({ testID: 'resume-unknown-chip' });
    expect(chips).toHaveLength(0);
  });
});
