/**
 * Issue 8364 -- the terminated reason must survive the whole lone-tool path:
 * message -> ToolBubble -> ChatView's detail state -> ToolDetailModal.
 *
 * Rendered through the real ChatView so that dropping the reason in
 * `handleOpenDetail`, or the `toolResultTerminatedReason` prop on the modal,
 * turns this red (each component's own test passes the prop directly).
 *
 * The shared grouping pipeline wraps every tool_use in an activity group, so
 * the lone-ToolBubble branch is not reached by real data today. The pipeline
 * is wrapped below to emit the tool message as a single row, which is the shape
 * ChatView's `single` branch (MessageBubble -> ToolBubble -> detail modal) takes.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, FlatList, Text } from 'react-native';

jest.mock('@chroxy/store-core', () => {
  const actual = jest.requireActual('@chroxy/store-core');
  return {
    ...actual,
    buildChatViewMessages: (...args: Parameters<typeof actual.buildChatViewMessages>) => {
      const built = actual.buildChatViewMessages(...args);
      return {
        ...built,
        displayGroups: built.displayGroups.map((g: { type: string; key?: string; messages?: unknown[] }) =>
          g.type === 'activity' ? { type: 'single', message: g.messages![0] } : g),
      };
    },
  };
});

jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: { sendInput: () => void; activeSessionId: string | null }) => unknown) =>
    selector({ sendInput: () => {}, activeSessionId: null }),
}));

import { ChatView } from '../ChatView';
import { selectChatMessages } from '../../screens/selectChatMessages';
import { isHiddenInCompactMode, describeTurnTermination } from '@chroxy/store-core';
import type { ChatMessage } from '../../store/types';

beforeAll(() => {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const noop = () => {};

function toolMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'tool-1',
    type: 'tool_use',
    content: '{"command":"ls"}',
    tool: 'Bash',
    toolUseId: 'toolu_xyz',
    toolResult: 'synthesized placeholder',
    timestamp: 1000,
    ...overrides,
  } as ChatMessage;
}

function renderFeed(message: ChatMessage) {
  const ref = React.createRef<FlatList>();
  const messages = selectChatMessages([message], { chatFilterCompact: false, isHiddenInCompactMode });
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

const byTestId = (tree: renderer.ReactTestRenderer, id: string) =>
  tree.root.findAll((n) => n.props?.testID === id);

const allText = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text)
    .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');

function openDetail(tree: renderer.ReactTestRenderer) {
  const press = () =>
    act(() => {
      tree.root.findAllByProps({ activeOpacity: 0.7 })[0]!.props.onPress();
    });
  press(); // expand the bubble
  press(); // expanded tap opens the detail modal
}

describe('ChatView lone tool -> detail modal terminated state (issue 8364)', () => {
  it('shows the terminated note in the detail modal opened from a terminated lone tool', () => {
    const tree = renderFeed(toolMessage({ toolResultIsError: true, toolResultTerminatedReason: 'permission_mode_switch' }));
    expect(byTestId(tree, 'tool-detail-terminated')).toHaveLength(0);
    openDetail(tree);
    expect(byTestId(tree, 'tool-detail-terminated').length).toBeGreaterThan(0);
    expect(allText(tree)).toContain(describeTurnTermination('permission_mode_switch').summary);
    act(() => tree.unmount());
  });

  it('control: the detail modal of a normal lone tool has no terminated state', () => {
    const tree = renderFeed(toolMessage());
    openDetail(tree);
    expect(byTestId(tree, 'tool-detail-terminated')).toHaveLength(0);
    expect(allText(tree)).toContain('synthesized placeholder');
    act(() => tree.unmount());
  });
});
