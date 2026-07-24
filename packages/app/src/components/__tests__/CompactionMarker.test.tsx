/**
 * CompactionMarker tests — #6972 (mobile parity for the dashboard's
 * packages/dashboard/src/components/CompactionMarker.tsx, #6768/#6970).
 *
 * Mirrors ResumeUnknownChip.test.tsx / StreamStallChip.test.tsx — plain
 * react-test-renderer + act, no `@testing-library/react-native` dependency.
 *
 * Covers the three cases called out in #6972's acceptance criteria:
 *   - full metadata renders the token delta + duration + trigger
 *   - null token counts / null duration render gracefully (never the
 *     literal string "null" or "NaN" — store-core's `CompactBoundaryMeta`
 *     uses null, not absent, for an SDK/CLI sub-field the producer omitted)
 *   - trigger renders 'manual' vs 'auto' correctly
 *
 * The "absent compactMetadata → no marker" case lives in
 * insertCompactionMarkers.test.tsx: this component's `meta` prop is
 * required (mirrors the dashboard's signature exactly), so "absent" is a
 * wiring/selector decision, not something this component can be asked to
 * render.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import type { CompactBoundaryMeta } from '@chroxy/store-core';
import { CompactionMarker } from '../CompactionMarker';

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
    .join('');
}

describe('CompactionMarker (#6972)', () => {
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

  const fullMeta: CompactBoundaryMeta = {
    trigger: 'auto',
    preTokens: 128_000,
    postTokens: 12_000,
    durationMs: 2_500,
  };

  it('renders the token delta, duration, and trigger from full metadata', () => {
    const tree = render(<CompactionMarker meta={fullMeta} />);
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Context compacted');
    // Locale-agnostic — assert against the runtime's own toLocaleString()
    // rather than a hard-coded "128,000" (a prior PR was bitten by this,
    // see CLAUDE.md's "Numbers" testing convention).
    expect(text).toContain(`${(128_000).toLocaleString()} → ${(12_000).toLocaleString()} tokens`);
    expect(text).toContain('2s');
    expect(text).toContain('auto');
    expect(tree.root.findByProps({ testID: 'compaction-marker' })).toBeTruthy();
  });

  it('renders the "manual" trigger label when trigger is manual', () => {
    const tree = render(
      <CompactionMarker meta={{ ...fullMeta, trigger: 'manual' }} />,
    );
    const text = collectVisibleText(tree.root);
    expect(text).toContain('manual');
    expect(text).not.toContain('auto');
  });

  it('renders gracefully when preTokens/postTokens/durationMs are all null (never prints "null" or "NaN")', () => {
    const tree = render(
      <CompactionMarker
        meta={{ trigger: 'manual', preTokens: null, postTokens: null, durationMs: null }}
      />,
    );
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Context compacted');
    expect(text).toContain('manual');
    expect(text).not.toMatch(/null/i);
    expect(text).not.toMatch(/nan/i);
    // Both token fields null → the token clause is omitted entirely
    // (mirrors the dashboard: `if (preTokens != null || postTokens != null)`).
    expect(text).not.toContain('tokens');
    expect(tree.root.findAllByProps({ testID: 'compaction-marker-tokens' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'compaction-marker-duration' })).toHaveLength(0);
  });

  it('falls back to "?" for a single null token field without crashing or printing "null"', () => {
    const tree = render(
      <CompactionMarker
        meta={{ trigger: 'auto', preTokens: null, postTokens: 12_000, durationMs: null }}
      />,
    );
    const text = collectVisibleText(tree.root);
    expect(text).toContain(`? → ${(12_000).toLocaleString()} tokens`);
    expect(text).not.toMatch(/null/i);
    expect(text).not.toMatch(/nan/i);
  });

  it('omits the duration clause when durationMs is null but still renders the token delta', () => {
    const tree = render(
      <CompactionMarker
        meta={{ trigger: 'auto', preTokens: 1_000, postTokens: 500, durationMs: null }}
      />,
    );
    const text = collectVisibleText(tree.root);
    expect(text).toContain(`${(1_000).toLocaleString()} → ${(500).toLocaleString()} tokens`);
    expect(tree.root.findAllByProps({ testID: 'compaction-marker-duration' })).toHaveLength(0);
  });
});
