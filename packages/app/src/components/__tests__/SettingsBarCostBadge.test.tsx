/**
 * Render tests for the mobile SessionScreen header cost badge (#4074).
 *
 * Pure formatter (`formatCostBadge`) + badge-visibility rules + tap-to-
 * open breakdown sheet. Mirrors the dashboard's #4073 test surface so
 * the same numerics format identically on both platforms.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { SettingsBar } from '../SettingsBar';
import { formatCostBadge } from '@chroxy/store-core';
import type { CumulativeUsage } from '@chroxy/store-core';

function collectVisibleText(root: ReactTestInstance): string {
  return root.findAllByType(Text).map((node) => {
    const c = node.props.children;
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (Array.isArray(c)) {
      return c.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('');
    }
    return '';
  }).join(' ');
}

function makeProps(overrides: Partial<{ cumulativeUsage: CumulativeUsage | null }> = {}) {
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
    connectedClients: [],
    customAgents: [],
    mcpServers: [],
    setModel: () => {},
    setPermissionMode: () => {},
    ...overrides,
  };
}

const baseUsage: CumulativeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turnsBilled: 0,
};

describe('formatCostBadge (#4074)', () => {
  it('formats values >= $1 with 2 decimal places', () => {
    expect(formatCostBadge(1.0)).toBe('$1.00');
    expect(formatCostBadge(1.234)).toBe('$1.23');
    expect(formatCostBadge(42.5)).toBe('$42.50');
  });

  it('formats values in [$0.01, $1) with 3 decimals (sub-dollar accuracy)', () => {
    expect(formatCostBadge(0.07)).toBe('$0.070');
    expect(formatCostBadge(0.013)).toBe('$0.013');
    expect(formatCostBadge(0.999)).toBe('$0.999');
  });

  it('formats values < $0.01 with 4 decimals (small turns)', () => {
    expect(formatCostBadge(0.0001)).toBe('$0.0001');
    expect(formatCostBadge(0.0023)).toBe('$0.0023');
  });

  it('renders $0 for zero / negative / non-finite (defensive)', () => {
    expect(formatCostBadge(0)).toBe('$0');
    expect(formatCostBadge(-0.5)).toBe('$0');
    expect(formatCostBadge(NaN)).toBe('$0');
    expect(formatCostBadge(Infinity)).toBe('$0');
  });
});

describe('SettingsBar cost badge rendering (#4074)', () => {
  it('renders the badge when cumulativeUsage.costUsd > 0', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar {...makeProps({ cumulativeUsage: { ...baseUsage, costUsd: 0.42, inputTokens: 1000 } })} />,
      );
    });
    const root = tree!.root;
    const badge = root.findByProps({ testID: 'session-cost-badge' });
    expect(badge).toBeTruthy();
    expect(collectVisibleText(badge)).toContain('$0.420');
  });

  it('hides the badge when costUsd === 0 (subscription-billed session)', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar {...makeProps({ cumulativeUsage: { ...baseUsage, inputTokens: 10000, costUsd: 0 } })} />,
      );
    });
    const root = tree!.root;
    expect(() => root.findByProps({ testID: 'session-cost-badge' })).toThrow();
  });

  it('hides the badge when cumulativeUsage is null (no result event yet)', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ cumulativeUsage: null })} />);
    });
    const root = tree!.root;
    expect(() => root.findByProps({ testID: 'session-cost-badge' })).toThrow();
  });

  it('opens the breakdown sheet on tap', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps({
            cumulativeUsage: {
              inputTokens: 1234,
              outputTokens: 567,
              cacheReadTokens: 8000,
              cacheCreationTokens: 200,
              costUsd: 0.0345,
              turnsBilled: 3,
            },
          })}
        />,
      );
    });
    const root = tree!.root;
    const badge = root.findByProps({ testID: 'session-cost-badge' });
    // Tap the badge — this flips visible: true on the Modal, which
    // mounts the sheet contents.
    act(() => badge.props.onPress());
    // Locate the Modal via its `visible` prop (Modal-from-RN doesn't
    // forward testID through its outer wrapper).
    const sheet = root.findByProps({ testID: 'session-cost-breakdown-sheet' });
    const sheetText = collectVisibleText(sheet);
    // Locale-agnostic — derive expected token strings via the runtime's
    // own `toLocaleString()` so the test passes on any system locale
    // (#4121 review).
    const localeNum = (n: number) => n.toLocaleString();
    expect(sheetText).toContain('$0.0345');
    expect(sheetText).toContain(localeNum(1234));
    expect(sheetText).toContain(localeNum(8000));
    expect(sheetText).toContain('Total cost');
    expect(sheetText).toContain('Turns billed');
  });
});
