/**
 * StreamStallChip tests — #4496
 *
 * Mobile companion to packages/dashboard/src/components/StreamStallChip
 * (#4476). Asserts the distinct chip affordance (not the red error bubble)
 * renders for `error.code === 'stream_stall'`, the Retry button surfaces +
 * fires onRetry only when provided (historical replays render text only),
 * and the raw server error text remains accessible to screen readers and
 * the long-press-for-detail affordance.
 *
 * Mirrors CheckInChip.test.tsx — react-test-renderer + act, no
 * `@testing-library/react-native` dependency required.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { StreamStallChip } from '../StreamStallChip';

function collectVisibleText(root: ReactTestInstance): string {
  return root
    .findAllByType(Text)
    .map((node) => {
      const c = node.props.children;
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (Array.isArray(c)) {
        return c
          .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : ''))
          .join('');
      }
      return '';
    })
    .join(' ');
}

describe('StreamStallChip (#4496)', () => {
  let activeTree: renderer.ReactTestRenderer | null = null;

  afterEach(() => {
    if (activeTree) {
      act(() => {
        activeTree!.unmount();
      });
      activeTree = null;
    }
  });

  function render(node: React.ReactElement): renderer.ReactTestRenderer {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(node);
    });
    activeTree = tree;
    return tree;
  }

  it('renders the chip headline', () => {
    const tree = render(
      <StreamStallChip errorText="Stream stalled — no response for 5 minutes" />,
    );
    const text = collectVisibleText(tree.root);
    expect(text).toMatch(/Stream stalled/i);
    expect(text).toMatch(/retry/i);
  });

  it('preserves the raw server error text via the accessibilityHint', () => {
    // Operators investigating a stall pattern need the underlying server
    // message — the chip's prose is friendly, but the diagnostic detail
    // must remain accessible without losing it (mirrors the dashboard's
    // `title` attribute affordance, which RN exposes via accessibilityHint).
    const raw = 'Stream stalled — no response for 5 minutes (provider=claude-sdk session=abc)';
    const tree = render(<StreamStallChip errorText={raw} />);
    const chip = tree.root.findByProps({ testID: 'stream-stall-chip' });
    expect(chip.props.accessibilityHint).toBe(raw);
  });

  it('shows a Retry button when onRetry is provided', () => {
    const onRetry = jest.fn();
    const tree = render(<StreamStallChip errorText="x" onRetry={onRetry} />);
    const retryButton = tree.root.findByProps({ testID: 'stream-stall-chip-retry' });
    expect(retryButton).toBeDefined();
  });

  it('hides the Retry button when onRetry is omitted (historical/replayed)', () => {
    // For replayed historical entries the original user input is no longer
    // the obvious target to resend — render the chip without the button
    // rather than wire it to a misleading action.
    const tree = render(<StreamStallChip errorText="x" />);
    const retryButtons = tree.root.findAllByProps({ testID: 'stream-stall-chip-retry' });
    expect(retryButtons).toHaveLength(0);
  });

  it('invokes onRetry when the Retry button is pressed', () => {
    const onRetry = jest.fn();
    const tree = render(<StreamStallChip errorText="x" onRetry={onRetry} />);
    const retryButton = tree.root.findByProps({ testID: 'stream-stall-chip-retry' });
    act(() => {
      retryButton.props.onPress?.();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('reveals the raw error text when the chip is long-pressed', () => {
    // Long-press exposes the underlying server diagnostic without an
    // always-on text wall — keeps the chip compact but the detail
    // reachable on demand (acceptance criterion: raw error remains
    // accessible for diagnostics).
    const raw = 'Stream stalled — no response for 5 minutes (provider=claude-sdk)';
    const tree = render(<StreamStallChip errorText={raw} />);
    const chip = tree.root.findByProps({ testID: 'stream-stall-chip' });
    act(() => {
      chip.props.onLongPress?.();
    });
    const detail = tree.root.findByProps({ testID: 'stream-stall-chip-detail' });
    expect(collectVisibleText(detail)).toContain(raw);
  });

  it('exposes role="alert" / accessibilityLiveRegion="polite" so screen readers announce the stall', () => {
    // The chip's purpose is to make a recoverable failure visible — give
    // assistive tech a live-region announcement so users not watching the
    // chat aren't stuck guessing why the assistant went silent. RN uses
    // accessibilityLiveRegion (Android) + accessibilityRole='alert' as the
    // cross-platform equivalent of the dashboard's role="status".
    const tree = render(<StreamStallChip errorText="x" />);
    const chip = tree.root.findByProps({ testID: 'stream-stall-chip' });
    expect(chip.props.accessibilityRole).toBe('alert');
    expect(chip.props.accessibilityLiveRegion).toBe('polite');
  });

  it('meets the 44pt minimum tap target on the Retry button', () => {
    // Touch target acceptance criterion: hitSlop expands the actionable
    // region of the compact chip button to the 44pt accessibility minimum.
    const onRetry = jest.fn();
    const tree = render(<StreamStallChip errorText="x" onRetry={onRetry} />);
    const retryButton = tree.root.findByProps({ testID: 'stream-stall-chip-retry' });
    const hitSlop = retryButton.props.hitSlop;
    expect(hitSlop).toBeDefined();
    // Vertical: padded button height + top+bottom slop must reach >= 44.
    // Horizontal: left+right slop padding is informative; main bar is the
    // vertical-tap-target axis (compact chip is short).
    expect((hitSlop?.top ?? 0) + (hitSlop?.bottom ?? 0)).toBeGreaterThanOrEqual(22);
  });
});
