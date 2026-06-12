/**
 * Render tests for the mobile ObserverBanner (#5589 / #5281).
 *
 * Covers: hidden unless visible (observer role) + a session id, names the
 * driver when known, falls back to neutral copy when unknown, and the
 * "Take over" button fires onTakeOver with the session id.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { ObserverBanner } from '../ObserverBanner';

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance | null {
  const matches = root.findAll((n) => n.props?.testID === testID);
  return matches.length > 0 ? matches[0] : null;
}

function collectText(root: ReactTestInstance): string {
  return root
    .findAllByType(Text)
    .map((node) => {
      const c = node.props.children;
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : '')).join('');
      return '';
    })
    .join(' ');
}

describe('ObserverBanner', () => {
  let tree: renderer.ReactTestRenderer | null = null;
  afterEach(() => {
    if (tree) { act(() => tree!.unmount()); tree = null; }
  });

  function render(props: React.ComponentProps<typeof ObserverBanner>): renderer.ReactTestRenderer {
    let t!: renderer.ReactTestRenderer;
    act(() => { t = renderer.create(<ObserverBanner {...props} />); });
    tree = t;
    return t;
  }

  it('renders nothing when not visible', () => {
    const t = render({ visible: false, sessionId: 's1', driverName: 'iPhone', onTakeOver: jest.fn() });
    expect(findByTestId(t.root, 'observer-banner')).toBeNull();
  });

  it('renders nothing when there is no session id', () => {
    const t = render({ visible: true, sessionId: null, driverName: 'iPhone', onTakeOver: jest.fn() });
    expect(findByTestId(t.root, 'observer-banner')).toBeNull();
  });

  it('names the driving device when known', () => {
    const t = render({ visible: true, sessionId: 's1', driverName: 'iPhone 17 Pro', onTakeOver: jest.fn() });
    expect(findByTestId(t.root, 'observer-banner')).not.toBeNull();
    expect(collectText(t.root)).toContain('iPhone 17 Pro is driving');
  });

  it('falls back to neutral copy when the driver is unknown', () => {
    const t = render({ visible: true, sessionId: 's1', driverName: null, onTakeOver: jest.fn() });
    expect(collectText(t.root)).toContain('another device is driving');
  });

  it('fires onTakeOver with the session id when the button is pressed', () => {
    const onTakeOver = jest.fn();
    const t = render({ visible: true, sessionId: 's1', driverName: 'iPhone', onTakeOver });
    const btn = findByTestId(t.root, 'observer-banner-takeover-button');
    expect(btn).not.toBeNull();
    act(() => { btn!.props.onPress(); });
    expect(onTakeOver).toHaveBeenCalledWith('s1');
  });
});
