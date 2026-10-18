/**
 * ToolDetailModal must show the terminated state (and withhold the server's
 * synthesized placeholder result) for a tool cut off by a terminated turn.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { describeTurnTermination } from '@chroxy/store-core';
import { ToolDetailModal } from '../chat/ToolDetailModal';

function renderModal(props: Partial<React.ComponentProps<typeof ToolDetailModal>> = {}): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <ToolDetailModal
        visible
        toolName="Bash"
        rawToolName="Bash"
        content='{"command":"ls"}'
        toolResult="synthesized placeholder"
        onClose={() => {}}
        onImagePress={() => {}}
        {...props}
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

describe('ToolDetailModal terminated state (#8364)', () => {
  it('shows the terminated note and withholds the synthesized result', () => {
    const root = renderModal({ toolResultTerminatedReason: 'permission_mode_switch' });
    expect(findByTestId(root, 'tool-detail-terminated-icon')[0]).toBeTruthy();
    expect(findByTestId(root, 'tool-detail-terminated')[0]).toBeTruthy();
    expect(allText(root)).toContain(describeTurnTermination('permission_mode_switch').summary);
    expect(allText(root)).not.toContain('synthesized placeholder');
  });

  it('labels a Stop-cancelled tool as stopped', () => {
    const root = renderModal({ toolResultTerminatedReason: 'user_stop_before_run' });
    expect(findByTestId(root, 'tool-detail-terminated-icon')[0]!.props.accessibilityLabel).toBe('stopped');
  });

  it('control: without a reason the raw result renders and no terminated state shows', () => {
    const root = renderModal();
    expect(findByTestId(root, 'tool-detail-terminated')).toHaveLength(0);
    expect(findByTestId(root, 'tool-detail-terminated-icon')).toHaveLength(0);
    expect(allText(root)).toContain('synthesized placeholder');
  });

  it('control: a reason with no result yet is not terminated', () => {
    const root = renderModal({ toolResult: undefined, toolResultTerminatedReason: 'permission_mode_switch' });
    expect(findByTestId(root, 'tool-detail-terminated')).toHaveLength(0);
  });
});
