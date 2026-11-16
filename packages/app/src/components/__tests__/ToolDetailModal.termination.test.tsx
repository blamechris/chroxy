/** #8364: detail state is independent of whether a result body is present. */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Image, Modal, Text } from 'react-native';
import { ToolDetailModal } from '../chat/ToolDetailModal';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';

type Props = React.ComponentProps<typeof ToolDetailModal>;
const roots: renderer.ReactTestRenderer[] = [];
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); });
function render(overrides: Partial<Props> = {}) {
  const onClose = jest.fn(), onImagePress = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<ToolDetailModal visible toolName="Bash" content="input marker"
    onClose={onClose} onImagePress={onImagePress} {...overrides} />); });
  roots.push(tree);
  return { tree, onClose, onImagePress };
}
const text = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Text)
  .map(node => React.Children.toArray(node.props.children).filter(child => typeof child === 'string').join('')).join(' ');
const stopIcons = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Icon).filter(icon => icon.props.name === 'stop');

describe('ToolDetailModal terminated state (#8364)', () => {
  it.each([
    ['permission_mode_switch', 'terminated', 'Turn ended (permission-mode switch) before this tool returned a result.'],
    ['user_stop', 'stopped', 'Stopped before this tool returned a result.'],
    ['new_server_reason', 'terminated', 'Turn ended before this tool returned a result.'],
  ])('shows amber %s state instead of the synthetic result', (reason, label, summary) => {
    const { tree } = render({ toolResultTerminatedReason: reason, toolResult: 'synthetic result marker' });
    expect(stopIcons(tree)).toHaveLength(1);
    expect(stopIcons(tree)[0]!.props.color).toBe(COLORS.accentOrange);
    expect(stopIcons(tree)[0]!.props.accessibilityLabel).toBe(label === 'stopped' ? 'stopped' : 'turn terminated');
    expect(text(tree)).toContain(label);
    expect(text(tree)).toContain(summary + ' Check whether it took effect before retrying.');
    expect(text(tree)).not.toContain('synthetic result marker');
    expect(text(tree)).toContain('input marker');
  });

  it.each(['', undefined])('renders the caution without a nonempty result (%s)', toolResult => {
    const { tree } = render({ content: '', toolResult, toolResultTerminatedReason: 'daemon_restart' });
    expect(text(tree)).toContain('Interrupted by a daemon restart — this tool may or may not have finished. Check before re-sending.');
    expect(stopIcons(tree)).toHaveLength(1);
  });

  it.each([undefined, '', 'command failed: exit code 1', 'successful output'])('leaves an ordinary result unchanged (%s)', toolResult => {
    const { tree } = render({ toolResult, toolResultTruncated: true });
    expect(stopIcons(tree)).toHaveLength(0);
    expect(text(tree)).not.toContain('Check whether it took effect');
    expect(text(tree)).toContain('input marker');
    if (toolResult !== undefined) {
      expect(text(tree)).toContain('Result (truncated)');
      expect(text(tree)).toContain(toolResult);
    } else expect(text(tree)).not.toContain('Result');
  });

  it('keeps image, MCP origin, close and system-dismiss controls usable', () => {
    const { tree, onClose, onImagePress } = render({ toolResultTerminatedReason: 'user_stop', serverName: 'files',
      toolResultImages: [{ data: 'image-marker', mediaType: 'image/png' }] });
    expect(text(tree)).toContain('via MCP server: files');
    expect(tree.root.findAllByType(Image)).toHaveLength(1);
    act(() => tree.root.find(node => node.props.accessibilityLabel === 'View image 1 of 1' && typeof node.props.onPress === 'function').props.onPress());
    expect(onImagePress).toHaveBeenCalledWith('data:image/png;base64,image-marker');
    act(() => tree.root.find(node => node.props.accessibilityLabel === 'Close tool details' && typeof node.props.onPress === 'function').props.onPress());
    act(() => tree.root.findByType(Modal).props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
