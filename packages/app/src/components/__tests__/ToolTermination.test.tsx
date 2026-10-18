import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import { ToolBubble } from '../chat/ToolBubble';
import { ToolDetailModal } from '../chat/ToolDetailModal';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import type { ChatMessage } from '../../store/connection';

const RAW_RESULT = 'server fallback text';
const CASES = [
  ['permission_mode_switch', 'turn terminated', 'Turn ended (permission-mode switch) before this tool returned a result. Check whether it took effect before retrying.'],
  ['user_stop', 'stopped', 'Stopped before this tool returned a result. Check whether it took effect before retrying.'],
  ['user_stop_before_run', 'stopped', 'Stopped before this tool ran — the turn was stopped while it was waiting for approval, so it was never approved.'],
  ['daemon_restart', 'turn terminated', 'Interrupted by a daemon restart — this tool may or may not have finished. Check before re-sending.'],
  ['future_reason', 'turn terminated', 'Turn ended before this tool returned a result. Check whether it took effect before retrying.'],
];

function render(element: React.ReactElement) {
  let root!: renderer.ReactTestRenderer;
  act(() => { root = renderer.create(element); });
  return root;
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'terminated-tool', type: 'tool_use', tool: 'Bash', toolUseId: 'tu-terminated',
    content: 'echo example', timestamp: 0, toolResult: RAW_RESULT,
    toolResultIsError: true, ...overrides,
  };
}

function bubble(msg: ChatMessage, onOpenDetail = jest.fn()) {
  return render(<ToolBubble message={msg} isSelected={false} isSelecting={false}
    onToggleSelection={() => {}} onOpenDetail={onOpenDetail} />);
}

function text(root: renderer.ReactTestRenderer) {
  return root.root.findAllByType(Text).flatMap(node => node.props.children).join(' ');
}

function expectTermination(root: renderer.ReactTestRenderer, label: string, summary: string) {
  const icon = root.root.findAllByType(Icon).find(node => node.props.accessibilityLabel === label);
  expect(icon).toBeDefined();
  expect(icon!.props.name).toBe('stop');
  expect(icon!.props.color).toBe(COLORS.accentOrange);
  const note = root.root.findAllByType(Text).find(node => node.props.children === summary);
  expect(note).toBeDefined();
  expect(StyleSheet.flatten(note!.props.style).color).toBe(COLORS.accentOrange);
  expect(text(root)).not.toContain(RAW_RESULT);
}

describe('ToolBubble termination', () => {
  it.each(CASES)('shows the amber %s state and safe guidance while collapsed and expanded', (reason, label, summary) => {
    const root = bubble(message({ toolResultTerminatedReason: reason }));
    expectTermination(root, label!, summary!);
    expect(root.root.findAllByProps({ testID: 'tool-bubble-pulse-tu-terminated' })).toHaveLength(0);
    act(() => { root.root.findAllByProps({ activeOpacity: 0.7 })[0]!.props.onPress(); });
    expectTermination(root, label!, summary!);
  });

  it('forwards the termination reason when opening details', () => {
    const open = jest.fn();
    const root = bubble(message({ toolResultTerminatedReason: 'permission_mode_switch' }), open);
    const press = () => root.root.findAllByProps({ activeOpacity: 0.7 })[0]!.props.onPress();
    act(press);
    act(press);
    expect(open).toHaveBeenCalledWith('Bash', 'echo example', RAW_RESULT, undefined, undefined, undefined, 'Bash', 'permission_mode_switch');
  });

  it.each([
    { toolResult: undefined, toolResultIsError: undefined },
    { toolResult: '' },
    { toolResult: 'done', toolResultIsError: false },
    { toolResult: 'command failed', toolResultIsError: true },
  ])('keeps ordinary pending/completed/error tools out of the terminated state: %j', (overrides) => {
    const root = bubble(message(overrides));
    expect(root.root.findAllByType(Icon).filter(node => node.props.name === 'stop')).toHaveLength(0);
    expect(root.root.findAllByProps({ testID: 'tool-bubble-pulse-tu-terminated' })).toHaveLength(overrides.toolResult === undefined ? 2 : 0);
  });
});

describe('ToolDetailModal termination', () => {
  it.each(CASES)('shows the amber %s state and shared guidance', (reason, label, summary) => {
    const root = render(<ToolDetailModal visible toolName="Bash" content="echo example"
      toolResult={RAW_RESULT} toolResultTerminatedReason={reason} onClose={() => {}} onImagePress={() => {}} />);
    expectTermination(root, label!, summary!);
    expect(text(root)).toContain('echo example');
    const close = root.root.findAllByProps({ accessibilityLabel: 'Close tool details' })[0]!;
    const style = StyleSheet.flatten(close.props.style);
    expect(style.width).toBeGreaterThanOrEqual(44);
    expect(style.height).toBeGreaterThanOrEqual(44);
  });

  it.each([undefined, '', 'done', 'command failed'])('retains ordinary result rendering: %s', (result) => {
    const root = render(<ToolDetailModal visible toolName="Bash" content="echo example"
      toolResult={result} onClose={() => {}} onImagePress={() => {}} />);
    expect(root.root.findAllByType(Icon).filter(node => node.props.name === 'stop')).toHaveLength(0);
    if (result) expect(text(root)).toContain(result);
  });
});
