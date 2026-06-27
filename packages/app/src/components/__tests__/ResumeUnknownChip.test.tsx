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

  // #5006: terminal-escalation variant for `resume_unknown_exhausted`
  // (server PR #5004). When the post-fallback retry ALSO matches the
  // unknown-resume pattern, the server has stopped auto-respawning — the
  // user MUST start a fresh session manually. The chip switches to a
  // distinct headline so the user doesn't mistake this for the recoverable
  // variant on its second occurrence and wait for an auto-fallback that
  // isn't coming.
  describe('variant="exhausted" (#5006 — terminal escalation)', () => {
    it('renders the "auto-recovery exhausted" headline instead of "starting fresh"', () => {
      const tree = render(
        <ResumeUnknownChip
          variant="exhausted"
          errorText="Auto-recovery exhausted: …"
        />,
      );
      const text = collectVisibleText(tree.root);
      // Headline must convey the terminal nature (operator action required
      // is "start a new session manually") — distinct from the recoverable
      // variant's "starting fresh" auto-fallback phrasing.
      expect(text).toMatch(/auto-recovery|exhausted/i);
      expect(text).toMatch(/start a (new|fresh) session/i);
      expect(text).not.toContain('starting fresh');
    });

    it('still surfaces attemptedResumeId subtext on the exhausted variant', () => {
      const tree = render(
        <ResumeUnknownChip
          variant="exhausted"
          errorText="x"
          attemptedResumeId="abc123-def456-7890"
        />,
      );
      const text = collectVisibleText(tree.root);
      expect(text).toContain('Attempted id: abc123-def456-7890');
    });

    it('reflects the variant on the accessibilityLabel for AT announcement parity', () => {
      // The mobile chip already uses accessibilityRole="alert" for both
      // variants (RN convention is louder by default than the dashboard's
      // status/alert split). The variant difference rides on the
      // accessibilityLabel so AT users hear the right copy.
      const tree = render(<ResumeUnknownChip variant="exhausted" errorText="x" />);
      const chip = tree.root.findByProps({ testID: 'resume-unknown-chip' });
      expect(chip.props.accessibilityLabel).toMatch(/exhausted|start a (new|fresh) session/i);
      expect(chip.props.accessibilityLabel).not.toContain('starting fresh');
    });

    // #6429: live-region politeness is derived from the registry role —
    // exhausted (terminal/alert) announces assertively, recoverable (status)
    // politely. accessibilityRole stays 'alert' for both (label carries copy).
    it('derives accessibilityLiveRegion from the role: exhausted→assertive, recoverable→polite (#6429)', () => {
      const exhausted = render(<ResumeUnknownChip variant="exhausted" errorText="x" />)
        .root.findByProps({ testID: 'resume-unknown-chip' });
      const recoverable = render(<ResumeUnknownChip variant="recoverable" errorText="x" />)
        .root.findByProps({ testID: 'resume-unknown-chip' });
      expect(exhausted.props.accessibilityLiveRegion).toBe('assertive');
      expect(recoverable.props.accessibilityLiveRegion).toBe('polite');
      expect(exhausted.props.accessibilityRole).toBe('alert');
      expect(recoverable.props.accessibilityRole).toBe('alert');
    });

    it('defaults to the recoverable headline when variant is omitted (back-compat)', () => {
      // Existing call sites pass no variant — they must continue to render
      // the recoverable copy unchanged.
      const tree = render(<ResumeUnknownChip errorText="x" />);
      const text = collectVisibleText(tree.root);
      expect(text).toContain('starting fresh');
    });
  });
});
