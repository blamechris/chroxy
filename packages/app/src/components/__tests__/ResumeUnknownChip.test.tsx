/**
 * ResumeUnknownChip tests — #4971
 *
 * Mobile companion to packages/dashboard/src/components/ResumeUnknownChip
 * (#4947). Pins the conditional id-subtext slot (so a stale empty value
 * can't produce a broken "Attempted id: " row), the calm headline copy,
 * and `accessibilityRole="alert"` for assistive-tech parity with
 * StreamStallChip.
 *
 * Mirrors StreamStallChip.test.tsx — react-test-renderer + act, no
 * `@testing-library/react-native` dependency required.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { ResumeUnknownChip } from '../ResumeUnknownChip';

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

describe('ResumeUnknownChip (#4971)', () => {
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

  it('renders the calm "starting fresh" headline', () => {
    const tree = render(<ResumeUnknownChip errorText="Resume failed: id unknown" />);
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Previous conversation could not be resumed');
    expect(text).toContain('starting fresh');
  });

  it('renders attempted id subtext when attemptedResumeId is provided', () => {
    const tree = render(
      <ResumeUnknownChip
        errorText="Resume failed"
        attemptedResumeId="abc123-def456-7890"
      />,
    );
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Attempted id: abc123-def456-7890');
    expect(tree.root.findByProps({ testID: 'resume-unknown-chip-id' })).toBeTruthy();
  });

  it('omits attempted id subtext when attemptedResumeId is undefined (pre-#4944 server)', () => {
    const tree = render(<ResumeUnknownChip errorText="Resume failed" />);
    expect(tree.root.findAllByProps({ testID: 'resume-unknown-chip-id' })).toHaveLength(0);
    const text = collectVisibleText(tree.root);
    expect(text).not.toContain('Attempted id:');
  });

  it('omits attempted id subtext when attemptedResumeId is empty string', () => {
    const tree = render(
      <ResumeUnknownChip errorText="Resume failed" attemptedResumeId="" />,
    );
    expect(tree.root.findAllByProps({ testID: 'resume-unknown-chip-id' })).toHaveLength(0);
  });

  it('omits attempted id subtext when attemptedResumeId is whitespace-only (defense in depth)', () => {
    // Mirrors the dashboard chip's empty-string defense — a stale or
    // trimmed empty value shouldn't degrade the headline into a broken
    // "Attempted id: " slot with no value.
    const tree = render(
      <ResumeUnknownChip errorText="Resume failed" attemptedResumeId="   " />,
    );
    expect(tree.root.findAllByProps({ testID: 'resume-unknown-chip-id' })).toHaveLength(0);
  });

  it('exposes the raw error text via accessibilityHint for assistive tech', () => {
    const verbatim = 'Previous Claude conversation could not be resumed (id unknown to local CLI)';
    const tree = render(<ResumeUnknownChip errorText={verbatim} />);
    const chip = tree.root.findByProps({ testID: 'resume-unknown-chip' });
    expect(chip.props.accessibilityHint).toBe(verbatim);
  });

  it('declares accessibilityRole="alert" for parity with StreamStallChip', () => {
    const tree = render(<ResumeUnknownChip errorText="Resume failed" />);
    const chip = tree.root.findByProps({ testID: 'resume-unknown-chip' });
    expect(chip.props.accessibilityRole).toBe('alert');
  });

  it('leaves the attempted id subtext natively accessible (regression: do not hide from SR)', () => {
    // #4971 review: an earlier revision set `accessibilityElementsHidden`
    // / `importantForAccessibility="no"` on the id subtext, which
    // silently masked the attempted conversation id from screen readers
    // even though it was the most operationally relevant detail in the
    // chip. Pin the natural-accessibility behavior so a future
    // refactor can't re-hide it.
    const tree = render(
      <ResumeUnknownChip errorText="Resume failed" attemptedResumeId="abc-123" />,
    );
    const idSubtext = tree.root.findByProps({ testID: 'resume-unknown-chip-id' });
    expect(idSubtext.props.accessibilityElementsHidden).toBeUndefined();
    expect(idSubtext.props.importantForAccessibility).toBeUndefined();
  });
});
