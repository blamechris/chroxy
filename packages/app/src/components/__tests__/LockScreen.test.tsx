import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { LockScreen } from '../LockScreen';

/**
 * #6450 — the lock gate blocks all app interaction, so the unlock control must be
 * identifiable + actionable by screen-reader users (role + label + hint).
 */
describe('LockScreen a11y (#6450)', () => {
  let tree: renderer.ReactTestRenderer | null = null;

  afterEach(() => {
    if (tree) {
      act(() => { tree!.unmount(); });
      tree = null;
    }
  });

  it('exposes the unlock control to screen readers (role + label + hint)', () => {
    act(() => {
      tree = renderer.create(<LockScreen onUnlock={async () => true} />);
    });
    const btn = tree!.root.findByProps({ accessibilityLabel: 'Unlock Chroxy' });
    expect(btn.props.accessibilityRole).toBe('button');
    expect(btn.props.accessibilityHint).toMatch(/authenticate|biometric/i);
  });
});
