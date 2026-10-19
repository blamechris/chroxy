import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { ToolDetailModal } from '../chat/ToolDetailModal';

function renderModal(reason?: string) {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <ToolDetailModal visible toolName="Bash" content="echo hello"
        toolResult="synthetic result" toolResultTerminatedReason={reason}
        onClose={() => {}} onImagePress={() => {}} />,
    );
  });
  return root;
}

describe('ToolDetailModal — terminated result', () => {
  it('shows the shared reason and cautious next step instead of raw synthetic text', () => {
    const root = renderModal('permission_mode_switch');
    const marker = root.root.findAllByProps({ testID: 'tool-detail-terminated' })[0];
    expect(marker).toBeTruthy();
    expect(marker.props.accessibilityLabel).toBe('turn terminated');
    const text = root.root.findAllByType(Text).map((node) => node.props.children).join(' ');
    expect(text).toContain('permission-mode switch');
    expect(text).toContain('Check whether it took effect before retrying.');
    expect(text).not.toContain('synthetic result');
  });

  it('labels a pending-permission Stop as stopped and leaves ordinary results alone', () => {
    const stopped = renderModal('user_stop_before_run');
    expect(stopped.root.findAllByProps({ testID: 'tool-detail-terminated' })[0].props.accessibilityLabel).toBe('stopped');
    const normal = renderModal();
    expect(normal.root.findAllByProps({ testID: 'tool-detail-terminated' })).toHaveLength(0);
    expect(normal.root.findAllByType(Text).map((node) => node.props.children).join(' ')).toContain('synthetic result');
  });
});
