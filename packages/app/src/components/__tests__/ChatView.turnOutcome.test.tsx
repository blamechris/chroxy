/**
 * #7326 -- the mobile Chat feed shows a chip on a turn that was cut off, refused
 * or stopped, and nothing extra on one that finished.
 *
 * Rendered through the real ChatView (the shared buildChatViewMessages pipeline
 * + the app's own row branch) and the real store-core marker builder, so removing
 * either the pipeline's pass-through for the marker row or ChatView's branch for
 * it turns this red rather than leaving a transcript that looks complete.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, FlatList, Text } from 'react-native';
import { appendTurnOutcomeMarker } from '@chroxy/store-core';

jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: { sendInput: () => void; activeSessionId: string | null }) => unknown) =>
    selector({ sendInput: () => {}, activeSessionId: null }),
}));

import { ChatView } from '../ChatView';
import { selectChatMessages } from '../../screens/selectChatMessages';
import { isHiddenInCompactMode } from '@chroxy/store-core';
import type { ChatMessage } from '../../store/types';

beforeAll(() => {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const noop = () => {};
const reply = (id: string, content: string): ChatMessage =>
  ({ id, type: 'response', content, timestamp: 1000 }) as ChatMessage;

function renderFeed(messages: ChatMessage[]) {
  const ref = React.createRef<FlatList>();
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ChatView
        messages={messages}
        scrollViewRef={ref as unknown as React.RefObject<FlatList<unknown> | null>}
        claudeReady
        onSelectOption={noop}
        isCliMode={false}
        selectedIds={new Set<string>()}
        isSelecting={false}
        isSelectingRef={{ current: false } as React.MutableRefObject<boolean>}
        onToggleSelection={noop}
        streamingMessageId={null}
        isPlanPending={false}
        planAllowedPrompts={[]}
        onApprovePlan={noop}
        onFocusInput={noop}
      />,
    );
  });
  return tree;
}

const chips = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll((n) => n.props?.testID === 'turn-outcome-marker' && typeof n.type === 'string');

const labels = (tree: renderer.ReactTestRenderer) =>
  tree.root
    .findAll((n) => n.props?.testID === 'turn-outcome-marker-label' && n.type === Text)
    .map((n) => n.props.children);

describe('ChatView turn-outcome chip (#7326)', () => {
  it.each([
    ['truncated', 'Reply cut off'],
    ['refused', 'The model declined'],
    ['stopped', 'Stopped'],
  ] as const)('shows the "%s" chip after the turn it describes', (outcome, label) => {
    const messages = appendTurnOutcomeMarker([reply('r1', 'half an answer')], { outcome, timestamp: 1 });
    const tree = renderFeed(selectChatMessages(messages, { chatFilterCompact: false, isHiddenInCompactMode }));
    expect(chips(tree).length).toBeGreaterThan(0);
    expect(labels(tree)).toEqual([label]);
    act(() => tree.unmount());
  });

  it('shows no chip for a turn that finished (no marker message is ever built)', () => {
    const messages = appendTurnOutcomeMarker([reply('r1', 'all done')], null);
    const tree = renderFeed(messages);
    expect(chips(tree)).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('keeps the chip with compact mode on (it is not a tool or thinking row)', () => {
    const messages = appendTurnOutcomeMarker([reply('r1', 'x')], { outcome: 'refused', timestamp: 1 });
    const tree = renderFeed(selectChatMessages(messages, { chatFilterCompact: true, isHiddenInCompactMode }));
    expect(labels(tree)).toEqual(['The model declined']);
    act(() => tree.unmount());
  });
});
