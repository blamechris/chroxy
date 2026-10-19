import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, FlatList, Text } from 'react-native';
import { describeTurnTermination } from '@chroxy/store-core';
import type { ChatMessage } from '../../store/connection';
jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (state: { sendInput: () => void; activeSessionId: null }) => unknown) => selector({ sendInput: () => {}, activeSessionId: null }),
}));
import { ToolBubble } from '../chat/ToolBubble';
import { ToolDetailModal } from '../chat/ToolDetailModal';
import { MessageBubble } from '../chat/MessageBubble';
import { ChatView } from '../ChatView';
const trees: renderer.ReactTestRenderer[] = [];
const noop = () => {};
beforeAll(() => {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: noop } as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
  jest.useRealTimers();
});
function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(element); });
  trees.push(tree);
  return tree;
}
function text(tree: renderer.ReactTestRenderer) {
  return tree.root.findAllByType(Text).flatMap(node => [node.props.children].flat(Infinity)).filter(value => typeof value === 'string').join(' ');
}
function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'tool-1', type: 'tool_use', tool: 'Bash', toolUseId: 'tu-1', content: 'echo hi', timestamp: 1, ...overrides };
}
function bubble(data: ChatMessage, onOpenDetail = jest.fn()) {
  return render(<ToolBubble message={data} isSelected={false} isSelecting={false} onToggleSelection={noop} onOpenDetail={onOpenDetail} />);
}
function tap(tree: renderer.ReactTestRenderer) {
  act(() => { tree.root.findAllByProps({ activeOpacity: 0.7 })[0]!.props.onPress(); });
}
describe('lone tool termination state', () => {
  it.each(['permission_mode_switch', 'user_stop', 'user_stop_before_run'])('shows shared %s guidance before error or running state', reason => {
    const tree = bubble(message({ toolResult: 'raw provider cancellation', toolResultIsError: true, toolResultTerminatedReason: reason }));
    expect(text(tree)).toContain(describeTurnTermination(reason).label);
    expect(text(tree)).toContain(describeTurnTermination(reason).summary);
    expect(text(tree)).not.toContain('raw provider cancellation');
    expect(tree.root.findAllByProps({ testID: 'tool-bubble-pulse-tu-1' })).toHaveLength(0);
    tap(tree);
    expect(text(tree)).toContain(describeTurnTermination(reason).summary);
  });
  it('does not show a running pulse when termination arrives without result text', () => {
    const tree = bubble(message({ toolResultTerminatedReason: 'process_exit' }));
    expect(text(tree)).toContain(describeTurnTermination('process_exit').summary);
    expect(tree.root.findAllByProps({ testID: 'tool-bubble-pulse-tu-1' })).toHaveLength(0);
  });
  it('keeps ordinary pending tools running and completed tools untagged', () => {
    const running = bubble(message());
    expect(running.root.findAllByProps({ testID: 'tool-bubble-pulse-tu-1' }).length).toBeGreaterThan(0);
    const complete = bubble(message({ toolResult: '' }));
    expect(complete.root.findAllByProps({ testID: 'tool-bubble-pulse-tu-1' })).toHaveLength(0);
    expect(text(complete)).not.toContain('terminated');
  });
  it('forwards the reason alongside all existing detail arguments', () => {
    const onOpenDetail = jest.fn();
    const tree = bubble(message({ toolResult: 'cancelled', toolResultTruncated: true, serverName: 'server', toolResultTerminatedReason: 'model_switch' }), onOpenDetail);
    tap(tree); tap(tree);
    expect(onOpenDetail).toHaveBeenCalledWith('Bash', 'echo hi', 'cancelled', true, undefined, 'server', 'Bash', 'model_switch');
  });
});
describe('tool detail termination state', () => {
  it.each(['permission_mode_switch', 'user_stop_before_run'])('shows %s guidance instead of synthetic result text', reason => {
    const tree = render(<ToolDetailModal visible toolName="Bash" content="echo hi" toolResult="raw provider cancellation" toolResultTerminatedReason={reason} onClose={noop} onImagePress={noop} />);
    expect(text(tree)).toContain(describeTurnTermination(reason).label);
    expect(text(tree)).toContain(describeTurnTermination(reason).summary);
    expect(text(tree)).toContain('echo hi');
    expect(text(tree)).not.toContain('raw provider cancellation');
  });
  it('keeps an ordinary result visible', () => {
    const tree = render(<ToolDetailModal visible toolName="Bash" content="echo hi" toolResult="hi" onClose={noop} onImagePress={noop} />);
    expect(text(tree)).toContain('Result');
    expect(text(tree)).toContain('hi');
    expect(text(tree)).not.toContain('terminated');
  });
  it('carries the callback through ChatView state into the real modal', () => {
    const tree = render(<ChatView messages={[{ id: 'reply', type: 'response', content: 'reply', timestamp: 1 }]} scrollViewRef={React.createRef<FlatList>()} claudeReady onSelectOption={noop} isCliMode={false} selectedIds={new Set()} isSelecting={false} isSelectingRef={{ current: false }} onToggleSelection={noop} streamingMessageId={null} />);
    const openDetail = tree.root.findByType(MessageBubble).props.onOpenDetail;
    const lone = bubble(message({ toolResult: 'cancelled', toolResultTerminatedReason: 'process_exit' }), openDetail);
    tap(lone); tap(lone);
    expect(tree.root.findByType(ToolDetailModal).props.visible).toBe(true);
    expect(tree.root.findByType(ToolDetailModal).props.toolResultTerminatedReason).toBe('process_exit');
    expect(text(tree)).toContain(describeTurnTermination('process_exit').summary);
  });
});
