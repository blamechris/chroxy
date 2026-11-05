/**
 * #8961 -- a session's chat opens at its latest message.
 *
 * ChatView is keyed per session (#8959), so every switch mounts a fresh,
 * unmeasured FlatList at offset 0. The first scroll events of that mount
 * report "scrolled up" (offset 0 against a taller content), which used to
 * latch the follow gate shut so the chat stayed at the top. The opening
 * follows the content to its end -- without animation, on every size change
 * -- until the reader takes over (drag, jump-to-top, search).
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, FlatList } from 'react-native';

jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: { sendInput: () => void; activeSessionId: string | null }) => unknown) =>
    selector({ sendInput: () => {}, activeSessionId: 's1' }),
}));

import { ChatView } from '../ChatView';
import type { ChatMessage } from '../../store/types';

beforeAll(() => {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});
afterAll(() => jest.restoreAllMocks());

const noop = () => {};
const reply = (id: string): ChatMessage =>
  ({ id, type: 'response', content: id, timestamp: 1000 }) as ChatMessage;

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

const scrollEvent = (offsetY: number, contentH: number, layoutH = 600) => ({
  nativeEvent: {
    contentOffset: { x: 0, y: offsetY },
    contentSize: { width: 400, height: contentH },
    layoutMeasurement: { width: 400, height: layoutH },
  },
});

function mount(messages: ChatMessage[]) {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(element(messages)); });
  const flat = () => tree.root.findByType(FlatList);
  const spy = jest.spyOn(flat().instance, 'scrollToEnd').mockImplementation(() => {});
  return { tree, flat, spy };
}

describe('ChatView opens at the latest message (#8961)', () => {
  it('scrolls to the end, unanimated, on the first content size event', () => {
    const { tree, flat, spy } = mount([reply('a'), reply('b')]);
    act(() => { flat().props.onContentSizeChange(400, 900); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ animated: false });
    act(() => tree.unmount());
  });

  it('keeps following the end through the scroll events of its own opening scroll', () => {
    const { tree, flat, spy } = mount([reply('a'), reply('b')]);
    act(() => { flat().props.onContentSizeChange(400, 900); });
    // the mount's first scroll report: offset 0 on a taller, estimated content
    act(() => { flat().props.onScroll(scrollEvent(0, 900)); });
    // rows measure taller than estimated; content grows again
    act(() => { flat().props.onContentSizeChange(400, 1500); });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith({ animated: false });
    act(() => tree.unmount());
  });

  it('leaves a reader who scrolled up in the same session where they are', () => {
    const { tree, flat, spy } = mount([reply('a'), reply('b')]);
    act(() => { flat().props.onContentSizeChange(400, 900); });
    spy.mockClear();
    act(() => { flat().props.onScrollBeginDrag(); });
    act(() => { flat().props.onScroll(scrollEvent(100, 900)); });
    act(() => { flat().props.onContentSizeChange(400, 1000); });
    expect(spy).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('still follows the end for a reader who dragged and is back at the bottom', () => {
    const { tree, flat, spy } = mount([reply('a'), reply('b')]);
    act(() => { flat().props.onScrollBeginDrag(); });
    act(() => { flat().props.onScroll(scrollEvent(300, 900)); }); // at bottom
    spy.mockClear();
    act(() => { flat().props.onContentSizeChange(400, 1000); });
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });
});
