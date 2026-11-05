/**
 * #8953 -- the chat list is rebuilt when the active session changes.
 *
 * SessionScreen passes ChatView a new `messages` array on a tab switch and never
 * remounts it, so the FlatList kept the previous session's scroll offset and
 * measured layouts and rendered blank (or only the first rows) against the other
 * session's messages, while the store held every one. ChatView now keys itself by
 * the active session id. Pinned by observing the FlatList instance itself: it
 * must be a different mounted instance after a switch, the same one on a plain
 * re-render of the same session.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, FlatList } from 'react-native';

let mockActiveSessionId: string | null = 's1';
jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: { sendInput: () => void; activeSessionId: string | null }) => unknown) =>
    selector({ sendInput: () => {}, activeSessionId: mockActiveSessionId }),
}));

import { ChatView } from '../ChatView';
import type { ChatMessage } from '../../store/types';

beforeAll(() => {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});
afterAll(() => jest.restoreAllMocks());

const noop = () => {};
const reply = (id: string, content: string): ChatMessage =>
  ({ id, type: 'response', content, timestamp: 1000 }) as ChatMessage;

function element(messages: ChatMessage[]) {
  const ref = React.createRef<FlatList>();
  return (
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
    />
  );
}

const list = (tree: renderer.ReactTestRenderer) => tree.root.findByType(FlatList).instance;

describe('ChatView is one list per session (#8953)', () => {
  it('mounts a fresh list when the active session changes, and shows that session\'s rows', () => {
    mockActiveSessionId = 's1';
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(element([reply('a1', 'first session')])); });
    const first = list(tree);

    mockActiveSessionId = 's2';
    act(() => tree.update(element([reply('b1', 'second session'), reply('b2', 'more')])));
    const second = list(tree);
    expect(second).not.toBe(first);
    expect(tree.root.findByType(FlatList).props.data).toHaveLength(2);

    mockActiveSessionId = 's1';
    act(() => tree.update(element([reply('a1', 'first session')])));
    expect(list(tree)).not.toBe(second);
    expect(tree.root.findByType(FlatList).props.data).toHaveLength(1);
    act(() => tree.unmount());
  });

  it('mounts a fresh list when moving from no session to a session whose id matches the no-session key', () => {
    mockActiveSessionId = null;
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(element([])); });
    for (const id of ['none', 'no-session']) {
      const before = list(tree);
      mockActiveSessionId = id;
      act(() => tree.update(element([reply('x1', id)])));
      expect(list(tree)).not.toBe(before);
      mockActiveSessionId = null;
      act(() => tree.update(element([])));
    }
    act(() => tree.unmount());
  });

  it('keeps the same list when the same session re-renders with more messages', () => {
    mockActiveSessionId = 's1';
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(element([reply('a1', 'one')])); });
    const first = list(tree);
    act(() => tree.update(element([reply('a1', 'one'), reply('a2', 'two')])));
    expect(list(tree)).toBe(first);
    act(() => tree.unmount());
  });
});
