/** #8364: lone tools must have the same cautious terminated state as grouped tools. */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { ToolBubble } from '../chat/ToolBubble';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import type { ChatMessage } from '../../store/types';

const CHECK = 'Check whether it took effect before retrying.';
const roots: renderer.ReactTestRenderer[] = [];
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); });
const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'lone-tool', type: 'tool_use', tool: 'Bash', toolUseId: 'tu-lone',
  timestamp: 0, content: '{"command":"write a file"}', ...overrides,
});
function render(overrides: Partial<ChatMessage> = {}) {
  const onOpenDetail = jest.fn();
  const onToggleSelection = jest.fn();
  const onExpandedChange = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<ToolBubble message={message(overrides)} isSelected={false} isSelecting={false}
    onToggleSelection={onToggleSelection} onOpenDetail={onOpenDetail} onExpandedChange={onExpandedChange} />); });
  roots.push(tree);
  return { tree, onOpenDetail, onExpandedChange };
}
const text = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Text)
  .map(node => React.Children.toArray(node.props.children).filter(child => typeof child === 'string').join('')).join(' ');
const press = (tree: renderer.ReactTestRenderer) => act(() => tree.root.findByProps({ activeOpacity: 0.7 }).props.onPress());
const stopIcons = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Icon).filter(icon => icon.props.name === 'stop');

describe('ToolBubble terminated state (#8364)', () => {
  it.each([
    ['permission_mode_switch', 'terminated', 'Turn ended (permission-mode switch) before this tool returned a result.'],
    ['user_stop', 'stopped', 'Stopped before this tool returned a result.'],
    ['future_reason', 'terminated', 'Turn ended before this tool returned a result.'],
  ])('shows amber %s state and cautious copy collapsed and expanded', (reason, label, summary) => {
    const { tree, onExpandedChange } = render({ toolResult: 'synthetic result marker', toolResultIsError: true, toolResultTerminatedReason: reason });
    expect(stopIcons(tree)).toHaveLength(1);
    expect(stopIcons(tree)[0]!.props.color).toBe(COLORS.accentOrange);
    expect(stopIcons(tree)[0]!.props.accessibilityLabel).toBe(label === 'stopped' ? 'stopped' : 'turn terminated');
    expect(text(tree)).toContain(summary + ' ' + CHECK);
    expect(text(tree)).not.toContain('synthetic result marker');
    expect(tree.root.findAllByType(Icon).some(icon => icon.props.name === 'alertCircle')).toBe(false);
    press(tree);
    expect(onExpandedChange).toHaveBeenCalledWith('lone-tool', true);
    expect(text(tree)).toContain(summary + ' ' + CHECK);
    expect(text(tree)).not.toContain('write a file');
  });

  it.each(['', undefined])('still shows termination for an empty or absent result (%s)', toolResult => {
    const { tree } = render({ toolResult, toolResultTerminatedReason: 'stream_stall', toolResultIsError: true });
    expect(stopIcons(tree)).toHaveLength(1);
    expect(text(tree)).toContain(CHECK);
    expect(tree.root.findAllByProps({ testID: 'tool-bubble-pulse-tu-lone' })).toHaveLength(0);
  });

  it('does not hide a terminated tool with no input or result', () => {
    const { tree } = render({ content: '', toolResultTerminatedReason: 'process_exit' });
    expect(text(tree)).toContain('Turn ended (session process exit)');
    expect(stopIcons(tree)).toHaveLength(1);
  });

  it('passes the original result and termination reason through the real expand/open callback', () => {
    const images = [{ data: 'image-marker', mediaType: 'image/png' }];
    const { tree, onOpenDetail } = render({ toolResult: '', toolResultTruncated: true, toolResultImages: images,
      serverName: 'local', toolResultTerminatedReason: 'hard_timeout' });
    press(tree);
    expect(onOpenDetail).not.toHaveBeenCalled();
    press(tree);
    expect(onOpenDetail).toHaveBeenCalledWith('Bash', '{"command":"write a file"}', '', true, images, 'local', 'Bash', 'hard_timeout');
  });

  it.each([
    ['pending', undefined, false, undefined, true],
    ['success', 'done', false, undefined, false],
    ['empty success', '', false, undefined, false],
    ['failure', 'exit code 1', true, undefined, false],
    ['image-only', undefined, false, [{ data: 'x', mediaType: 'image/png' }], false],
  ] as const)('preserves ordinary %s presentation', (_name, toolResult, toolResultIsError, images, pending) => {
    const { tree } = render({ toolResult, toolResultIsError, toolResultImages: images ? [...images] : undefined });
    expect(stopIcons(tree)).toHaveLength(0);
    expect(text(tree)).not.toContain(CHECK);
    expect(tree.root.findAllByProps({ testID: 'tool-bubble-pulse-tu-lone' }).length > 0).toBe(pending);
    expect(text(tree)).toContain('write a file');
    press(tree);
    expect(text(tree)).toContain('write a file');
  });
});
