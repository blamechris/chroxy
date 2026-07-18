/**
 * Render tests for the mobile SessionScreen header intervention badge (#4764).
 *
 * Counter visibility + tap-to-open recent-interventions sheet + the two
 * humanisation helpers. Mirrors the dashboard's #4758 FooterBar test surface
 * so the same intervention narrates identically on both platforms.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text, View } from 'react-native';
import {
  SettingsBar,
  describeIntervention,
  formatInterventionTimestamp,
} from '../SettingsBar';
import type { SessionIntervention } from '@chroxy/store-core';

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

function makeProps(overrides: Partial<{ interventions: SessionIntervention[] }> = {}) {
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

describe('describeIntervention (#4764)', () => {
  it('humanises multi_question with the question count', () => {
    const iv: SessionIntervention = {
      kind: 'multi_question',
      toolUseId: 'toolu_a',
      count: 4,
      timestamp: 0,
    };
    expect(describeIntervention(iv)).toContain('4 questions');
    expect(describeIntervention(iv)).toContain('one at a time');
  });
});

describe('formatInterventionTimestamp (#4764)', () => {
  const now = 1_000_000_000_000;

  it('renders sub-minute deltas in seconds', () => {
    expect(formatInterventionTimestamp(now - 3_000, now)).toBe('3s ago');
    expect(formatInterventionTimestamp(now - 59_000, now)).toBe('59s ago');
  });

  it('renders sub-hour deltas in minutes', () => {
    expect(formatInterventionTimestamp(now - 60_000, now)).toBe('1m ago');
    expect(formatInterventionTimestamp(now - 59 * 60_000, now)).toBe('59m ago');
  });

  it('renders sub-day deltas in hours', () => {
    expect(formatInterventionTimestamp(now - 60 * 60_000, now)).toBe('1h ago');
    expect(formatInterventionTimestamp(now - 23 * 60 * 60_000, now)).toBe('23h ago');
  });

  it('falls back to ISO date for entries older than 24h', () => {
    // 25h ago — should render the YYYY-MM-DD slice of the ISO string.
    const ts = now - 25 * 60 * 60_000;
    const out = formatInterventionTimestamp(ts, now);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('renders "just now" for future timestamps (clock skew defensive)', () => {
    expect(formatInterventionTimestamp(now + 1000, now)).toBe('just now');
  });
});

describe('SettingsBar intervention badge rendering (#4764)', () => {
  it('hides the badge when interventions is undefined', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ interventions: undefined })} />);
    });
    const root = tree!.root;
    expect(() => root.findByProps({ testID: 'session-interventions-badge' })).toThrow();
  });

  it('hides the badge when interventions is empty', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ interventions: [] })} />);
    });
    const root = tree!.root;
    expect(() => root.findByProps({ testID: 'session-interventions-badge' })).toThrow();
  });

  it('renders the badge with the singular noun when count === 1', () => {
    const interventions: SessionIntervention[] = [
      { kind: 'multi_question', toolUseId: 'toolu_a', count: 3, timestamp: Date.now() },
    ];
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ interventions })} />);
    });
    const root = tree!.root;
    const badge = root.findByProps({ testID: 'session-interventions-badge' });
    expect(collectVisibleText(badge)).toBe('1 intervention');
  });

  it('renders the badge with the plural noun when count > 1', () => {
    const interventions: SessionIntervention[] = [
      { kind: 'multi_question', toolUseId: 'toolu_a', count: 3, timestamp: Date.now() },
      { kind: 'multi_question', toolUseId: 'toolu_b', count: 2, timestamp: Date.now() },
    ];
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ interventions })} />);
    });
    const root = tree!.root;
    const badge = root.findByProps({ testID: 'session-interventions-badge' });
    expect(collectVisibleText(badge)).toBe('2 interventions');
  });

  it('updates the counter when the interventions prop grows', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps({
            interventions: [
              { kind: 'multi_question', toolUseId: 'toolu_a', count: 3, timestamp: Date.now() },
            ],
          })}
        />,
      );
    });
    expect(collectVisibleText(tree!.root.findByProps({ testID: 'session-interventions-badge' }))).toBe(
      '1 intervention',
    );
    act(() => {
      tree!.update(
        <SettingsBar
          {...makeProps({
            interventions: [
              { kind: 'multi_question', toolUseId: 'toolu_a', count: 3, timestamp: Date.now() },
              { kind: 'multi_question', toolUseId: 'toolu_b', count: 5, timestamp: Date.now() },
              { kind: 'multi_question', toolUseId: 'toolu_c', count: 4, timestamp: Date.now() },
            ],
          })}
        />,
      );
    });
    expect(collectVisibleText(tree!.root.findByProps({ testID: 'session-interventions-badge' }))).toBe(
      '3 interventions',
    );
  });

  it('opens the recent-interventions sheet on tap', () => {
    const ts = Date.now();
    const interventions: SessionIntervention[] = [
      { kind: 'multi_question', toolUseId: 'toolu_a', count: 3, timestamp: ts - 60_000 },
      { kind: 'multi_question', toolUseId: 'toolu_b', count: 5, timestamp: ts - 5_000 },
    ];
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ interventions })} />);
    });
    const root = tree!.root;
    const badge = root.findByProps({ testID: 'session-interventions-badge' });
    act(() => badge.props.onPress());
    const sheet = root.findByProps({ testID: 'session-interventions-sheet' });
    const sheetText = collectVisibleText(sheet);
    expect(sheetText).toContain('Recent chroxy interventions');
    // Both intervention rows are rendered, and the newest (toolu_b) appears
    // first because the panel reverses for newest-first ordering.
    expect(sheetText).toContain('5 questions');
    expect(sheetText).toContain('3 questions');
    const newest = root.findByProps({ testID: 'session-intervention-toolu_b' });
    const oldest = root.findByProps({ testID: 'session-intervention-toolu_a' });
    expect(newest).toBeTruthy();
    expect(oldest).toBeTruthy();
    // #4862 (Copilot review) — explicit ordering assertion so a regression
    // in the `.reverse()` call is caught. Walk every rendered row testID in
    // document order and check that newest (toolu_b) comes BEFORE oldest
    // (toolu_a). `findAll` returns nodes in tree order, so the row testIDs
    // collected from the sheet subtree are the visible order on screen.
    // Filter on the View host type to avoid the testID prop being collected
    // from a child Text that inherits via parent layout (defensive).
    const renderedRowIds = sheet
      .findAll(
        (node) =>
          node.type === View &&
          typeof node.props.testID === 'string' &&
          node.props.testID.startsWith('session-intervention-toolu_'),
      )
      .map((node) => node.props.testID as string);
    expect(renderedRowIds).toEqual([
      'session-intervention-toolu_b',
      'session-intervention-toolu_a',
    ]);
  });
});
