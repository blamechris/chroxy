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

// Frames are driven by hand. The follow runs on the NEXT frame, not inside
// onContentSizeChange: on the device a scrollToEnd issued from the size callback
// of a remounted list produced no scroll event at all (the chat stayed at offset
// 0), while the same call one frame later landed at the end.
let frames: Map<number, () => void>;
let nextFrame: number;
beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  jest.spyOn(global, 'requestAnimationFrame').mockImplementation(((cb: () => void) => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  }) as never);
  jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(((id: number) => {
    frames.delete(id);
  }) as never);
});
afterEach(() => {
  (global.requestAnimationFrame as unknown as jest.SpyInstance).mockRestore();
  (global.cancelAnimationFrame as unknown as jest.SpyInstance).mockRestore();
});
const frame = () => {
  const pending = [...frames.values()];
  frames.clear();
  act(() => { pending.forEach((cb) => cb()); });
};

function mount(messages: ChatMessage[]) {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(element(messages)); });
  const flat = () => tree.root.findByType(FlatList);
  const spy = jest.spyOn(flat().instance, 'scrollToEnd').mockImplementation(() => {});
  return { tree, flat, spy };
}

describe('ChatView opens at the latest message (#8961)', () => {
  it('scrolls to the end, unanimated, one frame after the first content size event -- never inside it', () => {
    const { tree, flat, spy } = mount([reply('a'), reply('b')]);
    act(() => { flat().props.onContentSizeChange(400, 900); });
    expect(spy).not.toHaveBeenCalled(); // the device dropped a scrollToEnd issued here
    frame();
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
    frame();
    expect(spy).toHaveBeenCalledTimes(1); // the two size events share one pending frame
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
    frame();
    expect(spy).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('stops following once the layout has settled, so a reader who scrolls with no drag is not yanked', () => {
    jest.useFakeTimers();
    try {
      const { tree, flat, spy } = mount([reply('a'), reply('b')]);
      act(() => { flat().props.onContentSizeChange(400, 900); });
      act(() => { jest.advanceTimersByTime(1500); });
      frame(); // the settle's own final follow runs on the next frame
      // a VoiceOver / wheel / programmatic scroll up: onScroll only, no drag-begin
      act(() => { flat().props.onScroll(scrollEvent(100, 900)); });
      spy.mockClear();
      act(() => { flat().props.onContentSizeChange(400, 1000); });
      frame();
      expect(spy).not.toHaveBeenCalled();
      act(() => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('a follow still pending when the quiet window closes lands at the end (settle is not a takeover)', () => {
    jest.useFakeTimers();
    try {
      const { tree, flat, spy } = mount([reply('a'), reply('b')]);
      act(() => { flat().props.onContentSizeChange(400, 900); });
      // the mount's offset-0 report latches "scrolled up"
      act(() => { flat().props.onScroll(scrollEvent(0, 900)); });
      // the quiet window closes before the queued frame has run
      act(() => { jest.advanceTimersByTime(1500); });
      frame();
      expect(spy).toHaveBeenCalledWith({ animated: false });
      act(() => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('closing the opening issues one last follow, for a device that needs more than one frame', () => {
    jest.useFakeTimers();
    try {
      const { tree, flat, spy } = mount([reply('a'), reply('b')]);
      act(() => { flat().props.onContentSizeChange(400, 900); });
      frame();
      expect(spy).toHaveBeenCalledTimes(1);
      // the metrics commit late: the list still reports offset 0
      act(() => { flat().props.onScroll(scrollEvent(0, 900)); });
      act(() => { jest.advanceTimersByTime(1500); });
      frame();
      expect(spy).toHaveBeenCalledTimes(2);
      act(() => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('extends the opening while size events keep arriving inside the settle window', () => {
    jest.useFakeTimers();
    try {
      const { tree, flat, spy } = mount([reply('a'), reply('b')]);
      for (let h = 900; h <= 1500; h += 200) {
        act(() => { flat().props.onContentSizeChange(400, h); });
        act(() => { jest.advanceTimersByTime(600); });
      }
      act(() => { flat().props.onScroll(scrollEvent(0, 1500)); });
      spy.mockClear();
      act(() => { flat().props.onContentSizeChange(400, 1600); });
      frame();
      expect(spy).toHaveBeenCalledTimes(1);
      act(() => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops following after the hard cap even if size events never go quiet (streaming)', () => {
    jest.useFakeTimers();
    try {
      const { tree, flat, spy } = mount([reply('a'), reply('b')]);
      // streamed deltas every 500 ms keep re-arming the quiet timer for 7 s
      for (let i = 0; i < 14; i++) {
        act(() => { flat().props.onContentSizeChange(400, 900 + i * 20); });
        act(() => { jest.advanceTimersByTime(500); });
      }
      frame(); // the cap's own final follow runs on the next frame
      // a screen-reader / wheel scroll up: onScroll only, no drag-begin
      act(() => { flat().props.onScroll(scrollEvent(100, 1200)); });
      spy.mockClear();
      act(() => { flat().props.onContentSizeChange(400, 1300); });
      frame();
      expect(spy).not.toHaveBeenCalled();
      act(() => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the settle timer and the opening cap timer on unmount', () => {
    jest.useFakeTimers();
    try {
      const { tree, flat } = mount([reply('a')]);
      const setSpy = jest.spyOn(global, 'setTimeout');
      act(() => { flat().props.onContentSizeChange(400, 900); });
      const settle = setSpy.mock.results[setSpy.mock.calls.findIndex((c) => c[1] === 1500)];
      const cap = setSpy.mock.results[setSpy.mock.calls.findIndex((c) => c[1] === 5000)];
      expect(settle).toBeDefined();
      expect(cap).toBeDefined();
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      act(() => tree.unmount());
      expect(clearSpy).toHaveBeenCalledWith(settle.value);
      expect(clearSpy).toHaveBeenCalledWith(cap.value);
      setSpy.mockRestore();
      clearSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens at the end even when the session has an unanswered prompt', () => {
    const prompt = { id: 'p1', type: 'prompt', content: 'Pick one', timestamp: 1000, options: [{ label: 'x', value: 'x' }] } as unknown as ChatMessage;
    const { tree, flat, spy } = mount([reply('a'), prompt]);
    act(() => { flat().props.onContentSizeChange(400, 900); });
    frame();
    expect(spy).toHaveBeenCalledWith({ animated: false });
    act(() => tree.unmount());
  });

  it('does not follow in selection mode while opening', () => {
    let tree!: renderer.ReactTestRenderer;
    const el = element([reply('a')]);
    act(() => { tree = renderer.create(React.cloneElement(el, { isSelecting: true, isSelectingRef: { current: true } })); });
    const spy = jest.spyOn(tree.root.findByType(FlatList).instance, 'scrollToEnd').mockImplementation(() => {});
    act(() => { tree.root.findByType(FlatList).props.onContentSizeChange(400, 900); });
    frame();
    expect(spy).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('still follows the end for a reader who dragged and is back at the bottom', () => {
    const { tree, flat, spy } = mount([reply('a'), reply('b')]);
    act(() => { flat().props.onScrollBeginDrag(); });
    act(() => { flat().props.onScroll(scrollEvent(300, 900)); }); // at bottom
    spy.mockClear();
    act(() => { flat().props.onContentSizeChange(400, 1000); });
    expect(spy).not.toHaveBeenCalled();
    frame();
    // unanimated: an animated follow lags a fast-growing reply, the lag reads as
    // "scrolled up" in handleScroll and latches the follow off mid-stream
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ animated: false });
    act(() => tree.unmount());
  });

  it('device sequence: a remounted list gets ONE size event and no scroll event, and still ends at the end', () => {
    const { tree, flat, spy } = mount([reply('a'), reply('b'), reply('c')]);
    act(() => { flat().props.onContentSizeChange(400, 2748); });
    expect(spy).not.toHaveBeenCalled();
    frame();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ animated: false });
    act(() => tree.unmount());
  });

  it('follows a reply that grows by hundreds of points at once, without latching off', () => {
    const { tree, flat, spy } = mount([reply('a')]);
    act(() => { flat().props.onScrollBeginDrag(); });
    act(() => { flat().props.onScroll(scrollEvent(300, 900)); }); // at bottom
    for (const h of [1245, 1845, 2748]) {
      act(() => { flat().props.onContentSizeChange(400, h); });
      frame();
    }
    expect(spy).toHaveBeenCalledTimes(3);
    act(() => tree.unmount());
  });

  it('a drag between the size event and the frame cancels the queued follow', () => {
    const { tree, flat, spy } = mount([reply('a')]);
    act(() => { flat().props.onContentSizeChange(400, 900); });
    act(() => { flat().props.onScrollBeginDrag(); });
    frame();
    expect(spy).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('cancels the queued follow frame on unmount', () => {
    const { tree, flat } = mount([reply('a')]);
    act(() => { flat().props.onContentSizeChange(400, 900); });
    expect(frames.size).toBe(1);
    act(() => tree.unmount());
    expect(frames.size).toBe(0);
  });
});
