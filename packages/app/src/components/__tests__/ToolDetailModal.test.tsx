/**
 * ToolDetailModal terminated state (#8364): a tool cut off by a terminated turn
 * shows the shared "check whether it took effect" sentence instead of the raw
 * synthetic result text, matching ActivityGroup and the dashboard.
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
        content="sleep 60"
        toolResult="synthesized placeholder"
        onClose={() => {}}
        onImagePress={() => {}}
        {...props}
      />,
    );
  });
  return root;
}

const texts = (root: renderer.ReactTestRenderer) =>
  root.root.findAllByType(Text)
    .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
    .filter((c): c is string => typeof c === 'string');

describe('ToolDetailModal — terminated state (#8364)', () => {
  it('replaces the raw result text with the terminated sentence', () => {
    const root = renderModal({ toolResultTerminatedReason: 'permission_mode_switch' });
    expect(root.root.findAllByProps({ testID: 'tool-detail-terminated' })[0]).toBeTruthy();
    const all = texts(root).join(' ');
    expect(all).toContain('Check whether it took effect');
    expect(all).not.toContain('synthesized placeholder');
  });

  it('shows the raw result and no terminated state without a reason (control)', () => {
    const root = renderModal();
    expect(root.root.findAllByProps({ testID: 'tool-detail-terminated' })).toHaveLength(0);
    expect(texts(root).join(' ')).toContain('synthesized placeholder');
  });
});
