/**
 * #6774 — mobile plan-approval combined "approve + auto-accept edits" action.
 *
 * The PlanApprovalCard (rendered as the FlatList footer while a plan is
 * pending) gains a third action that approves the plan AND switches the
 * session into acceptEdits. These tests pin:
 *   1. The button renders (with the right testID) when the provider supports
 *      permission-mode switching (`canApproveAcceptEdits`).
 *   2. Tapping it invokes the combined handler.
 *   3. It is gated: hidden when the provider can't switch mode, and hidden
 *      when no combined handler is wired (so the plain Approve path is
 *      unaffected).
 *
 * The mode-switch-BEFORE-approve ordering guarantee is covered where it lives,
 * in `@chroxy/store-core`'s `plan-approval.test.ts`.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { FlatList } from 'react-native';

jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: { sendInput: () => void; activeSessionId: string | null }) => unknown) =>
    selector({ sendInput: () => {}, activeSessionId: null }),
}));

import { AccessibilityInfo } from 'react-native';
import { ChatView } from '../ChatView';
import type { ChatMessage } from '../../store/types';

// Mirror the virtualization test: neutralise the async reduceMotion listener so
// its post-teardown setState doesn't crash react-test-renderer + jsdom.
beforeAll(() => {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});
afterAll(() => jest.restoreAllMocks());

// isPlanPending schedules a `scrollToEnd` on a 100ms timer; the real FlatList's
// scroll path reads I18nManager.isRTL, which is undefined under
// react-test-renderer and crashes if the timer fires. Fake timers keep it
// queued (never executed), and unmounting each tree clears it via the effect
// cleanup.
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const noop = () => {};

type PlanProps = {
  onApprovePlan: () => void;
  onFocusInput: () => void;
  onApprovePlanAcceptEdits?: () => void;
  canApproveAcceptEdits?: boolean;
};

function makeProps(plan: PlanProps) {
  const ref = React.createRef<FlatList>();
  const message: ChatMessage = { id: 'm1', type: 'response', content: 'hi', timestamp: 1000 } as ChatMessage;
  return {
    messages: [message],
    scrollViewRef: ref as unknown as React.RefObject<FlatList<unknown> | null>,
    claudeReady: true,
    onSelectOption: noop,
    isCliMode: false,
    selectedIds: new Set<string>(),
    isSelecting: false,
    isSelectingRef: { current: false } as React.MutableRefObject<boolean>,
    onToggleSelection: noop,
    streamingMessageId: null,
    isPlanPending: true,
    planAllowedPrompts: [],
    ...plan,
  };
}

function renderChatView(plan: PlanProps) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<ChatView {...makeProps(plan)} />);
  });
  return tree;
}

// A testID propagates to several nested host nodes under a TouchableOpacity, so
// presence is "at least one match" rather than an exact count.
function hasTestId(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll((n) => n.props?.testID === testID).length > 0;
}

// The single node that actually carries the press handler.
function pressableWithTestId(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.find(
    (n) => n.props?.testID === testID && typeof n.props?.onPress === 'function',
  );
}

describe('PlanApprovalCard — combined approve + auto-accept edits (#6774)', () => {
  it('renders the combined button when the provider supports mode switching', () => {
    const tree = renderChatView({
      onApprovePlan: noop,
      onFocusInput: noop,
      onApprovePlanAcceptEdits: noop,
      canApproveAcceptEdits: true,
    });
    expect(hasTestId(tree, 'plan-approve-accept-edits-button')).toBe(true);
    // The plain Approve button is still present (AC: plain Approve unchanged).
    expect(hasTestId(tree, 'plan-approve-button')).toBe(true);
    act(() => tree.unmount());
  });

  it('invokes the combined handler when tapped', () => {
    const onApprovePlanAcceptEdits = jest.fn();
    const onApprovePlan = jest.fn();
    const tree = renderChatView({
      onApprovePlan,
      onFocusInput: noop,
      onApprovePlanAcceptEdits,
      canApproveAcceptEdits: true,
    });
    act(() => {
      pressableWithTestId(tree, 'plan-approve-accept-edits-button').props.onPress();
    });
    expect(onApprovePlanAcceptEdits).toHaveBeenCalledTimes(1);
    // The combined action does not also fire the plain approve callback.
    expect(onApprovePlan).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('hides the combined button when the provider cannot switch mode', () => {
    const tree = renderChatView({
      onApprovePlan: noop,
      onFocusInput: noop,
      onApprovePlanAcceptEdits: noop,
      canApproveAcceptEdits: false,
    });
    expect(hasTestId(tree, 'plan-approve-accept-edits-button')).toBe(false);
    // Plain Approve remains.
    expect(hasTestId(tree, 'plan-approve-button')).toBe(true);
    act(() => tree.unmount());
  });

  it('hides the combined button when no combined handler is wired', () => {
    const tree = renderChatView({
      onApprovePlan: noop,
      onFocusInput: noop,
      canApproveAcceptEdits: true,
    });
    expect(hasTestId(tree, 'plan-approve-accept-edits-button')).toBe(false);
    act(() => tree.unmount());
  });
});
