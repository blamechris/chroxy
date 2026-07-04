/**
 * Render tests for DiffHunkView (#6549, follow-up to #6548/#6542) — the opt-in
 * per-hunk accept/reject toggle on the mobile file-diff viewer.
 *
 * Mirrors the dashboard `HunkView.test.tsx` cases in RN idioms: a read-only hunk
 * renders NO toggle (the existing viewer is unchanged); a selectable hunk renders
 * a ≥44pt checkbox row with the right accessibilityState/label + glyph; onToggle
 * fires on press; the diff lines always render. Uses the repo's established
 * `react-test-renderer` harness (NOT @testing-library/react-native, which is not
 * installed here — see CheckpointView.test.tsx / TodoList.test.tsx).
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { View, Text, StyleSheet } from 'react-native';
import { DiffHunkView } from '../DiffViewer';
import type { DiffHunk } from '../../store/connection';

const HUNK: DiffHunk = {
  header: '@@ -1,3 +1,3 @@',
  lines: [
    { type: 'context', content: 'unchanged line' },
    { type: 'deletion', content: 'old line' },
    { type: 'addition', content: 'new line' },
    { type: 'context', content: 'trailing line' },
  ],
};

function renderHunk(props: React.ComponentProps<typeof DiffHunkView>) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<DiffHunkView {...props} />);
  });
  return tree;
}

/** All text content rendered anywhere in the tree, flattened to strings. */
function allText(root: ReactTestInstance): string[] {
  return root.findAllByType(Text).flatMap((t) => {
    const kids = t.props.children;
    const arr = Array.isArray(kids) ? kids : [kids];
    return arr.filter((c): c is string => typeof c === 'string');
  });
}

describe('DiffHunkView', () => {
  it('read-only (no selectable prop) renders NO toggle but still shows the header + lines', () => {
    const tree = renderHunk({ hunk: HUNK });
    // Regression guard: the existing read-only viewer must be unchanged.
    expect(tree.root.findAllByProps({ testID: 'hunk-toggle' })).toHaveLength(0);
    // Header renders.
    expect(allText(tree.root)).toContain('@@ -1,3 +1,3 @@');
    // All four line contents render.
    const text = allText(tree.root);
    expect(text).toContain('unchanged line');
    expect(text).toContain('old line');
    expect(text).toContain('new line');
    expect(text).toContain('trailing line');
  });

  it('selectable + selected renders a checked accept toggle (Reject label, ☑ glyph, opacity 1)', () => {
    const tree = renderHunk({ hunk: HUNK, selectable: true, selected: true, onToggle: () => {} });
    const toggle = tree.root.findByProps({ testID: 'hunk-toggle' });
    expect(toggle.props.accessibilityRole).toBe('checkbox');
    expect(toggle.props.accessibilityState).toEqual({ checked: true });
    // Selected → the action is to REJECT it (undo the accept).
    expect(toggle.props.accessibilityLabel).toBe('Reject this hunk');
    expect(allText(tree.root)).toContain('☑');
    // A selected hunk is NOT visually rejected (no dim).
    const outer = tree.root.findAllByType(View)[0];
    expect(StyleSheet.flatten(outer.props.style).opacity ?? 1).toBe(1);
  });

  it('selectable + NOT selected renders an unchecked accept toggle (Accept label, ☐ glyph, dimmed)', () => {
    const tree = renderHunk({ hunk: HUNK, selectable: true, selected: false, onToggle: () => {} });
    const toggle = tree.root.findByProps({ testID: 'hunk-toggle' });
    expect(toggle.props.accessibilityState).toEqual({ checked: false });
    expect(toggle.props.accessibilityLabel).toBe('Accept this hunk');
    expect(allText(tree.root)).toContain('☐');
    // A rejected (unselected) hunk is dimmed via styles.hunkRejected (opacity 0.55).
    const outer = tree.root.findAllByType(View)[0];
    expect(StyleSheet.flatten(outer.props.style).opacity).toBe(0.55);
  });

  it('fires onToggle when the checkbox row is pressed', () => {
    const onToggle = jest.fn();
    const tree = renderHunk({ hunk: HUNK, selectable: true, selected: false, onToggle });
    act(() => {
      tree.root.findByProps({ testID: 'hunk-toggle' }).props.onPress();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('exposes a ≥44pt touch target on the toggle row (accessibility min size)', () => {
    const tree = renderHunk({ hunk: HUNK, selectable: true, selected: true, onToggle: () => {} });
    const toggle = tree.root.findByProps({ testID: 'hunk-toggle' });
    const minHeight = StyleSheet.flatten(toggle.props.style).minHeight;
    expect(typeof minHeight).toBe('number');
    expect(minHeight).toBeGreaterThanOrEqual(44);
  });

  it('still renders the diff lines in selectable mode', () => {
    const tree = renderHunk({ hunk: HUNK, selectable: true, selected: true, onToggle: () => {} });
    const text = allText(tree.root);
    expect(text).toContain('old line');
    expect(text).toContain('new line');
  });
});
