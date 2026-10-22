/**
 * ToolDetailModal terminated state (#8364): a tool cut off by a terminated turn
 * shows the amber reason note instead of the server-synthesized result text.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { ToolDetailModal } from '../chat/ToolDetailModal';

function renderModal(props: Partial<React.ComponentProps<typeof ToolDetailModal>> = {}) {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <ToolDetailModal
        visible
        toolName="Bash"
        rawToolName="Bash"
        content='{"command":"sleep 100"}'
        toolResult="synthesized placeholder"
        onClose={() => {}}
        onImagePress={() => {}}
        {...props}
      />,
    );
  });
  return root;
}

const textOf = (root: renderer.ReactTestRenderer) =>
  root.root.findAllByType(Text)
    .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');

describe('ToolDetailModal — terminated state (#8364)', () => {
  it('renders the amber terminated note with the reason instead of the raw result', () => {
    const root = renderModal({ toolResultTerminatedReason: 'permission_mode_switch' });
    expect(root.root.findAllByProps({ testID: 'tool-detail-terminated' }).length).toBeGreaterThan(0);
    expect(textOf(root)).toContain('Check whether it took effect before retrying');
    expect(textOf(root)).not.toContain('synthesized placeholder');
  });

  it('shows the terminated note for an image-only result', () => {
    const root = renderModal({
      toolResult: undefined,
      toolResultImages: [{ data: 'AAAA', mediaType: 'image/png' }],
      toolResultTerminatedReason: 'user_stop',
    });
    expect(root.root.findAllByProps({ testID: 'tool-detail-terminated' }).length).toBeGreaterThan(0);
  });

  it('renders the raw result and no note when no reason is set', () => {
    const root = renderModal();
    expect(root.root.findAllByProps({ testID: 'tool-detail-terminated' })).toHaveLength(0);
    expect(textOf(root)).toContain('synthesized placeholder');
  });

  it('keeps the 44pt close target', () => {
    const root = renderModal({ toolResultTerminatedReason: 'user_stop' });
    const close = root.root.findAllByProps({ accessibilityLabel: 'Close tool details' })[0]!;
    const flat = Object.assign({}, ...[close.props.style].flat());
    expect(flat.width).toBe(44);
    expect(flat.height).toBe(44);
  });
});
