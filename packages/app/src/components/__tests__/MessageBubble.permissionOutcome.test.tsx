/**
 * MessageBubble permission-outcome record -- #8348
 *
 * A permission prompt that has ENDED is rebuilt, on a session switch or a reload,
 * from the server's durable `permission_outcome` history entry (the live card is
 * not replayed). MessageBubble renders it as a compact, non-interactive record:
 * "Permission expired - <tool>: <description> - dropped" for a prompt that ended
 * with no decision (the same line the dashboard shows), and an Allowed / Denied
 * line for an answered one. It must never offer Allow / Deny, a countdown, or an
 * "expand" the record has nothing behind.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';

function makeOutcome(outcome: 'allowed' | 'denied' | 'expired', overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'perm-out-1',
    type: 'prompt',
    content: 'Bash: Commit the restructured fix',
    tool: 'Bash',
    requestId: 'req-out-1',
    permissionOutcome: outcome,
    ...(outcome === 'allowed' ? { answered: 'allow' } : {}),
    ...(outcome === 'denied' ? { answered: 'deny' } : {}),
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessage;
}

function render(message: ChatMessage) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <MessageBubble
        message={message}
        isSelected={false}
        isSelecting={false}
        onLongPress={() => {}}
        onPress={() => {}}
        onOpenDetail={() => {}}
      />,
    );
  });
  return tree;
}

function text(root: ReactTestInstance): string {
  return root
    .findAllByType(Text)
    .map((node) => {
      const c = node.props.children;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('');
      return '';
    })
    .join(' ');
}

describe('MessageBubble permission outcome record (#8348)', () => {
  it('renders an expired outcome as the dropped record', () => {
    const tree = render(makeOutcome('expired'));
    const record = tree.root.findByProps({ testID: 'permission-outcome-perm-out-1' });
    expect(record.props.accessibilityLabel).toBe('Permission expired — Bash: Commit the restructured fix — dropped');
    expect(text(tree.root)).toContain('Permission expired');
    expect(text(tree.root)).toContain('dropped');
  });

  it('renders allowed and denied outcomes with their decision', () => {
    expect(text(render(makeOutcome('allowed')).root)).toMatch(/Allowed: Bash: Commit the restructured fix/);
    expect(text(render(makeOutcome('denied')).root)).toMatch(/Denied: Bash: Commit the restructured fix/);
  });

  it('offers no controls: no Allow/Deny, no countdown, no expand', () => {
    for (const outcome of ['allowed', 'denied', 'expired'] as const) {
      const tree = render(makeOutcome(outcome));
      expect(tree.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
      expect(tree.root.findAllByProps({ accessibilityRole: 'timer' })).toHaveLength(0);
      expect(text(tree.root)).not.toMatch(/Action Required|Tap to expand/);
    }
  });

  it('is a record even if a stray expiresAt is left on it', () => {
    const tree = render(makeOutcome('expired', { expiresAt: Date.now() + 60_000 }));
    expect(tree.root.findAllByProps({ testID: 'permission-outcome-perm-out-1' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ accessibilityRole: 'timer' })).toHaveLength(0);
  });

  it('POSITIVE CONTROL: a live prompt with no outcome still shows its countdown', () => {
    const live = {
      id: 'perm-live', type: 'prompt', content: 'Bash: ls', tool: 'Bash', requestId: 'req-live',
      options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
      expiresAt: Date.now() + 60_000, timestamp: Date.now(),
    } as ChatMessage;
    const tree = render(live);
    expect(tree.root.findAllByProps({ testID: 'permission-outcome-perm-live' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityRole: 'timer' }).length).toBeGreaterThan(0);
    // The countdown holds an interval: unmount so it cannot outlive the test.
    act(() => tree.unmount());
  });
});
