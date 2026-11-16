/**
 * #8364 callback/state integration. The default mobile grouping puts every tool
 * in ActivityGroup, so explicitly ask the REAL FlatList renderItem for a single
 * tool row, then mount its REAL MessageBubble/ToolBubble. No callback/state or
 * presentation component is mocked. Grouping behavior is deliberately unchanged.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, FlatList, Modal, Text } from 'react-native';
import type { ChatMessage } from '../../store/types';
import { ChatView } from '../ChatView';
import { ToolBubble } from '../chat/ToolBubble';
import { ToolDetailModal } from '../chat/ToolDetailModal';

jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (state: object) => unknown) => selector({
    activeSessionId: null, sessions: [], serverCapabilities: {}, sendInput: jest.fn(), requestPermissionInput: jest.fn(),
  }),
}));
jest.mock('../../store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: (selector: (state: object) => unknown) => selector({ connectionPhase: 'connected' }),
}));

const roots: renderer.ReactTestRenderer[] = [];
beforeAll(() => {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockImplementation(() => ({
    then: (callback: (enabled: boolean) => void) => { callback(true); },
  }) as never);
});
beforeEach(() => jest.useFakeTimers());
afterEach(() => { act(() => roots.splice(0).reverse().forEach(root => root.unmount())); jest.useRealTimers(); });
afterAll(() => jest.restoreAllMocks());
const noop = () => {};
function renderFeed() {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<ChatView messages={[]} scrollViewRef={React.createRef<FlatList>()}
    claudeReady onSelectOption={noop} isCliMode={false} selectedIds={new Set()} isSelecting={false}
    isSelectingRef={{ current: false }} onToggleSelection={noop} streamingMessageId={null} />); });
  roots.push(tree);
  return tree;
}
function renderSingleRow(feed: renderer.ReactTestRenderer, overrides: Partial<ChatMessage> = {}) {
  const message: ChatMessage = { id: 'single-tool', type: 'tool_use', tool: 'Bash', timestamp: 0,
    content: 'input marker', toolResult: 'synthetic result marker', toolResultIsError: true,
    toolResultTerminatedReason: 'permission_mode_switch', ...overrides };
  const element = feed.root.findByType(FlatList).props.renderItem({ item: { type: 'single', message }, index: 0 });
  let row!: renderer.ReactTestRenderer;
  act(() => { row = renderer.create(element); });
  roots.push(row);
  expect(row.root.findByType(ToolBubble).props.message).toBe(message);
  return row;
}
function open(row: renderer.ReactTestRenderer) {
  const press = () => row.root.findByProps({ activeOpacity: 0.7 }).props.onPress();
  act(press); // expand, not yet open
  act(press); // details via ToolBubble → MessageBubble → ChatView callback
}
const text = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Text)
  .map(node => React.Children.toArray(node.props.children).filter(child => typeof child === 'string').join('')).join(' ');

describe('ChatView lone-tool termination callback chain (#8364)', () => {
  it.each(['permission_mode_switch', 'user_stop', 'future_reason'])('carries %s through expansion into stateful details', reason => {
    const feed = renderFeed();
    const row = renderSingleRow(feed, { toolResultTerminatedReason: reason, toolResult: '' });
    expect(feed.root.findByType(ToolDetailModal).props.visible).toBe(false);
    open(row);
    const details = feed.root.findByType(ToolDetailModal);
    expect(details.props.visible).toBe(true);
    expect(details.props.toolResultTerminatedReason).toBe(reason);
    expect(text(feed)).toContain('Check whether it took effect before retrying.');
    act(() => details.findByType(Modal).props.onRequestClose());
    expect(feed.root.findByType(ToolDetailModal).props.visible).toBe(false);
  });

  it('does not leak a previous termination reason into the next ordinary details', () => {
    const feed = renderFeed();
    open(renderSingleRow(feed));
    expect(text(feed)).toContain('Check whether it took effect before retrying.');
    act(() => feed.root.findByType(ToolDetailModal).props.onClose());
    open(renderSingleRow(feed, { id: 'next-tool', toolResultTerminatedReason: undefined, toolResultIsError: false, toolResult: 'successful output' }));
    expect(feed.root.findByType(ToolDetailModal).props.visible).toBe(true);
    expect(text(feed)).toContain('successful output');
    expect(text(feed)).not.toContain('Check whether it took effect');
  });

  it('preserves all original detail fields alongside the reason', () => {
    const feed = renderFeed();
    const images = [{ data: 'x', mediaType: 'image/png' }];
    open(renderSingleRow(feed, { tool: 'web_search', toolResultTruncated: true, toolResultImages: images, serverName: 'search' }));
    expect(feed.root.findByType(ToolDetailModal).props).toMatchObject({
      rawToolName: 'web_search', content: 'input marker', toolResult: 'synthetic result marker',
      toolResultTruncated: true, toolResultImages: images, serverName: 'search', toolResultTerminatedReason: 'permission_mode_switch',
    });
  });
});
