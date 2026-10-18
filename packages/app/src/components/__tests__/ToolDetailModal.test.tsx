import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { ToolDetailModal } from '../chat/ToolDetailModal';

function renderModal(props: Partial<React.ComponentProps<typeof ToolDetailModal>> = {}): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <ToolDetailModal
        visible
        toolName="Bash"
        content="sleep 100"
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

describe('ToolDetailModal — terminated state', () => {
  it('renders the terminated note instead of the synthesized result text', () => {
    const root = renderModal({ toolResultTerminatedReason: 'permission_mode_switch' });
    const icon = root.root.findAllByProps({ testID: 'tool-detail-terminated' })[0];
    expect(icon).toBeTruthy();
    expect(icon!.props.accessibilityLabel).toBe('turn terminated');
    const text = textOf(root);
    expect(text).toContain('Check whether it took effect before retrying.');
    expect(text).not.toContain('synthesized placeholder');
  });

  it('labels a Stop-cancelled pending permission as stopped', () => {
    const root = renderModal({ toolResultTerminatedReason: 'user_stop_before_run' });
    expect(root.root.findAllByProps({ testID: 'tool-detail-terminated' })[0]!.props.accessibilityLabel).toBe('stopped');
  });

  it('control: without a terminated reason the raw result is shown and no terminated state', () => {
    const root = renderModal();
    expect(root.root.findAllByProps({ testID: 'tool-detail-terminated' })).toHaveLength(0);
    expect(textOf(root)).toContain('synthesized placeholder');
  });
});
