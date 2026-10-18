/**
 * The lone chat ToolBubble must show the same amber "terminated" state that
 * ActivityGroup shows for a tool cut off by a terminated turn, instead of
 * rendering as a plain (or red-failed) tool with the raw synthesized result.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { describeTurnTermination } from '@chroxy/store-core';
import { ToolBubble } from '../chat/ToolBubble';
import type { ChatMessage } from '../../store/connection';

function makeToolMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'tool-1',
    type: 'tool_use',
    content: '{"command":"ls"}',
    tool: 'Bash',
    toolUseId: 'toolu_xyz',
    toolResult: 'synthesized placeholder',
    timestamp: 0,
    ...overrides,
  };
}

function renderBubble(
  message: ChatMessage,
  onOpenDetail: (...args: unknown[]) => void = () => {},
): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <ToolBubble
        message={message}
        isSelected={false}
        isSelecting={false}
        onToggleSelection={() => {}}
        onOpenDetail={onOpenDetail}
      />,
    );
  });
  return root;
}

function findByTestId(root: renderer.ReactTestRenderer, id: string) {
  return root.root.findAllByProps({ testID: id });
}

function allText(root: renderer.ReactTestRenderer): string {
  return root.root.findAllByType(Text)
    .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function press(root: renderer.ReactTestRenderer) {
  act(() => {
    root.root.findAllByProps({ activeOpacity: 0.7 })[0]!.props.onPress();
  });
}

describe('ToolBubble terminated state (#8364)', () => {
  it('shows the amber terminated icon and note, visible without expanding', () => {
    const root = renderBubble(makeToolMessage({
      toolResultIsError: true,
      toolResultTerminatedReason: 'permission_mode_switch',
    }));
    expect(findByTestId(root, 'tool-bubble-terminated-icon-tool-1')[0]).toBeTruthy();
    expect(findByTestId(root, 'tool-bubble-terminated-tool-1')[0]).toBeTruthy();
    expect(allText(root)).toContain(describeTurnTermination('permission_mode_switch').summary);
  });

  it('labels a Stop-cancelled tool as stopped, anything else as terminated', () => {
    const stopped = renderBubble(makeToolMessage({ toolResultTerminatedReason: 'user_stop_before_run' }));
    expect(findByTestId(stopped, 'tool-bubble-terminated-icon-tool-1')[0]!.props.accessibilityLabel).toBe('stopped');
    const cut = renderBubble(makeToolMessage({ toolResultTerminatedReason: 'permission_mode_switch' }));
    expect(findByTestId(cut, 'tool-bubble-terminated-icon-tool-1')[0]!.props.accessibilityLabel).toBe('turn terminated');
  });

  it('shows nothing terminated for a normal or failed result, or a still-pending tool', () => {
    const ok = renderBubble(makeToolMessage());
    const failed = renderBubble(makeToolMessage({ toolResultIsError: true }));
    const pending = renderBubble(makeToolMessage({ toolResult: undefined, toolResultTerminatedReason: 'permission_mode_switch' }));
    for (const root of [ok, failed, pending]) {
      expect(findByTestId(root, 'tool-bubble-terminated-icon-tool-1')).toHaveLength(0);
      expect(findByTestId(root, 'tool-bubble-terminated-tool-1')).toHaveLength(0);
    }
  });

  it('hands the terminated reason to the detail modal when opened', () => {
    const onOpenDetail = jest.fn();
    const root = renderBubble(makeToolMessage({ toolResultTerminatedReason: 'user_stop' }), onOpenDetail);
    press(root); // expand
    press(root); // open detail
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail.mock.calls[0]![7]).toBe('user_stop');
  });
});
