/**
 * Touch-target tests for the mobile SessionScreen header badges (#4876).
 *
 * Apple HIG requires interactive elements to have an effective
 * touch target of at least 44 × 44 logical pixels. The visible header badges
 * (cost badge from #4074, intervention badge from #4764) intentionally use a
 * compact look (paddingVertical: 2, paddingHorizontal: 6, fontSize: 10) for
 * the strip-of-chips header design — so each tappable badge MUST add a
 * `hitSlop` large enough to bring the effective touch zone above 44pt.
 *
 * This test fixes that contract: every tappable header badge has a hitSlop
 * whose top+bottom and left+right margins are big enough that the smallest
 * conceivable badge size (a single character) still exceeds 44 × 44pt.
 *
 * Non-tappable badges (`deviceBadge`, `agentBadge`, `qualityBadge`) are
 * informational `accessibilityRole="text"` views and intentionally do NOT
 * get a hitSlop (they aren't pressable, so the 44pt rule does not apply).
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { SettingsBar, HEADER_BADGE_HIT_SLOP } from '../SettingsBar';
import type { CumulativeUsage, SessionIntervention } from '@chroxy/store-core';

type HitSlop = { top?: number; bottom?: number; left?: number; right?: number };

/**
 * Lower-bound estimate of a header badge's intrinsic size given its style.
 * paddingVertical contributes top+bottom, paddingHorizontal contributes
 * left+right, and fontSize is the cap-height approximation of the text row.
 * A single-char "$" badge would be ~fontSize wide, so this models the
 * smallest plausible visible bounds — the worst case for the 44pt rule.
 */
function intrinsicMinSize(style: {
  paddingVertical: number;
  paddingHorizontal: number;
  fontSize: number;
  borderWidth?: number;
}) {
  const border = (style.borderWidth ?? 0) * 2;
  // Width is dominated by the smallest one-glyph string; ~fontSize × 0.6 is
  // a conservative approximation of a single-char width at the default font.
  return {
    width: Math.ceil(style.fontSize * 0.6) + style.paddingHorizontal * 2 + border,
    height: style.fontSize + style.paddingVertical * 2 + border,
  };
}

function effectiveTouchSize(intrinsic: { width: number; height: number }, hitSlop: HitSlop) {
  return {
    width: intrinsic.width + (hitSlop.left ?? 0) + (hitSlop.right ?? 0),
    height: intrinsic.height + (hitSlop.top ?? 0) + (hitSlop.bottom ?? 0),
  };
}

function makeProps(overrides: Partial<{
  cumulativeUsage: CumulativeUsage | null;
  interventions: SessionIntervention[];
}> = {}) {
  return {
    expanded: false,
    onToggle: () => {},
    activeModel: 'claude-opus-4-7',
    availableModels: [],
    permissionMode: null,
    availablePermissionModes: [],
    lastResultCost: null,
    lastResultDuration: null,
    sessionCost: null,
    cumulativeUsage: null,
    costBudget: null,
    contextOccupancy: null,
    sessionCwd: '/tmp',
    serverMode: 'cli' as const,
    isIdle: true,
    activeAgents: [],
    interventions: [] as SessionIntervention[],
    connectedClients: [],
    customAgents: [],
    mcpServers: [],
    setModel: () => {},
    setPermissionMode: () => {},
    ...overrides,
  };
}

const usage: CumulativeUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.42,
  turnsBilled: 1,
};

const oneIntervention: SessionIntervention[] = [
  { kind: 'multi_question', toolUseId: 'toolu_x', count: 3, timestamp: Date.now() },
];

describe('SettingsBar header tappable badges hit a 44pt touch target (#4876)', () => {
  it('exports a shared HEADER_BADGE_HIT_SLOP with all four sides set', () => {
    expect(HEADER_BADGE_HIT_SLOP).toEqual({ top: 16, bottom: 16, left: 14, right: 14 });
  });

  it('cost badge has hitSlop large enough for a 44pt effective target', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ cumulativeUsage: usage })} />);
    });
    const badge = tree!.root.findByProps({ testID: 'session-cost-badge' });
    const hitSlop = badge.props.hitSlop as HitSlop;
    expect(hitSlop).toBeDefined();

    // The cost badge uses paddingVertical 2, paddingHorizontal 6, fontSize 11,
    // borderWidth 1 (see styles.costBadge / costBadgeText in SettingsBar.tsx).
    const intrinsic = intrinsicMinSize({
      paddingVertical: 2,
      paddingHorizontal: 6,
      fontSize: 11,
      borderWidth: 1,
    });
    const effective = effectiveTouchSize(intrinsic, hitSlop);
    expect(effective.width).toBeGreaterThanOrEqual(44);
    expect(effective.height).toBeGreaterThanOrEqual(44);
  });

  it('intervention badge has hitSlop large enough for a 44pt effective target', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ interventions: oneIntervention })} />);
    });
    const badge = tree!.root.findByProps({ testID: 'session-interventions-badge' });
    const hitSlop = badge.props.hitSlop as HitSlop;
    expect(hitSlop).toBeDefined();

    // The intervention badge uses paddingVertical 2, paddingHorizontal 6,
    // fontSize 10 (see styles.interventionBadge / interventionBadgeText).
    const intrinsic = intrinsicMinSize({
      paddingVertical: 2,
      paddingHorizontal: 6,
      fontSize: 10,
    });
    const effective = effectiveTouchSize(intrinsic, hitSlop);
    expect(effective.width).toBeGreaterThanOrEqual(44);
    expect(effective.height).toBeGreaterThanOrEqual(44);
  });

  it('cost and intervention badges share the same hitSlop constant', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps({ cumulativeUsage: usage, interventions: oneIntervention })}
        />,
      );
    });
    const costSlop = tree!.root.findByProps({ testID: 'session-cost-badge' }).props.hitSlop;
    const ivSlop = tree!.root.findByProps({ testID: 'session-interventions-badge' }).props.hitSlop;
    expect(costSlop).toBe(HEADER_BADGE_HIT_SLOP);
    expect(ivSlop).toBe(HEADER_BADGE_HIT_SLOP);
  });
});

/**
 * #4893 — the same SettingsBar exposes a `conversationIdRow` in the expanded
 * panel that copies the conversation ID to the clipboard on tap. It is the
 * sibling of the header-badge fix above and was originally under-sized at
 * `minHeight: 32` (below Apple HIG's 44pt minimum). The expanded panel has
 * plenty of horizontal whitespace, so the chosen fix grows the visible row to
 * 44pt (Option 1 from the issue) rather than adding `hitSlop`.
 *
 * This test asserts the row's effective tap target is at least 44pt tall,
 * computed as `max(style.minHeight, style.paddingVertical * 2)` plus the
 * top + bottom `hitSlop` (defaulting to 0 when unset). `minHeight` in RN
 * already accounts for padding + content, so we take the larger of the two
 * lower bounds rather than summing them. The row's width spans the parent's
 * flex space, so we only assert on the height dimension that the original
 * bug was about.
 */
describe('SettingsBar conversationIdRow hits a 44pt touch target (#4893)', () => {
  it('row is rendered (expanded, with a conversationId)', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps()}
          expanded
          conversationId="abc12345-deadbeef-0000-1111-222233334444"
        />,
      );
    });
    const row = tree!.root.findByProps({ testID: 'conversation-id-row' });
    expect(row).toBeDefined();
  });

  it('row style has minHeight ≥ 44 so the visible target clears Apple HIG', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps()}
          expanded
          conversationId="abc12345-deadbeef-0000-1111-222233334444"
        />,
      );
    });
    const row = tree!.root.findByProps({ testID: 'conversation-id-row' });
    // RN TouchableOpacity merges style arrays/objects; flatten by reading
    // the style prop and pulling minHeight off the resolved object.
    const style = Array.isArray(row.props.style)
      ? Object.assign({}, ...row.props.style)
      : row.props.style;
    const hitSlop: HitSlop = (row.props.hitSlop as HitSlop) ?? {};
    const paddingVertical = style.paddingVertical ?? 0;
    const minHeight = style.minHeight ?? 0;
    // Effective tap-target height is the larger of minHeight or paddingVertical*2
    // (a conservative lower bound — actual content height is not measured here),
    // plus any top/bottom hitSlop. minHeight wins for this row because it is set
    // explicitly to 44; the paddingVertical fallback only matters if a future
    // change drops minHeight and relies on padding alone.
    const effectiveHeight = Math.max(minHeight, paddingVertical * 2)
      + (hitSlop.top ?? 0)
      + (hitSlop.bottom ?? 0);
    expect(effectiveHeight).toBeGreaterThanOrEqual(44);
  });
});
