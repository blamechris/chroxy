/**
 * #8700 — SettingsBar's read-only "Effort" readout.
 *
 * The app has no thinking-level control. For a provider that REPORTS the level
 * it applied (capabilities `thinkingLevel` + `thinkingLevelEffective`, i.e. the
 * claude-sdk family) the expanded bar shows what Claude Code actually ran at —
 * or says it does not know yet — instead of leaving a requested effort that was
 * never applied invisible. Never shown for a provider that makes no such report.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { SettingsBar, describeEffort, providerReportsEffort } from '../SettingsBar';
import { COLORS } from '../../constants/colors';

const TEST_ID = 'settings-effective-effort';

function textOf(node: ReactTestInstance): string {
  return node.findAllByType(Text).map((t) => {
    const c = t.props.children;
    return typeof c === 'string' || typeof c === 'number' ? String(c) : '';
  }).join(' ');
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    expanded: true,
    onToggle: () => {},
    activeModel: 'opus',
    defaultModelId: null,
    availableModels: [{ id: 'opus', label: 'Opus' }],
    permissionMode: 'approve',
    availablePermissionModes: [{ id: 'approve', label: 'Approve' }],
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
    interventions: [],
    connectedClients: [],
    customAgents: [],
    mcpServers: [],
    setModel: () => {},
    setPermissionMode: () => {},
    thinkingLevelEffectiveSupported: true,
    ...overrides,
  };
}

function render(props: Record<string, unknown>) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tree = renderer.create(<SettingsBar {...(props as any)} />);
  });
  return tree;
}

const readout = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({ testID: TEST_ID });
const hasReadout = (tree: renderer.ReactTestRenderer) => tree.root.findAll((n) => n.props.testID === TEST_ID).length > 0;

describe('SettingsBar effort readout (#8700)', () => {
  it('shows the level the provider reports it applied', () => {
    const tree = render(makeProps({ thinkingLevel: 'medium', effectiveThinkingLevel: 'medium' }));
    expect(textOf(readout(tree))).toBe('Effort: Medium');
    expect(readout(tree).props.accessibilityRole).toBe('text');
    // Not a mismatch: no warning border, and no "requested" clause.
    expect(StyleSheet.flatten(readout(tree).props.style).borderColor).not.toBe(COLORS.accentOrangeBorder);
    act(() => tree.unmount());
  });

  it('does not call it a mismatch when the operator left the effort on Auto', () => {
    const tree = render(makeProps({ thinkingLevel: 'default', effectiveThinkingLevel: 'high' }));
    expect(textOf(readout(tree))).toBe('Effort: High');
    expect(StyleSheet.flatten(readout(tree).props.style).borderColor).not.toBe(COLORS.accentOrangeBorder);
    act(() => tree.unmount());
  });

  it.each([[null], [undefined]])('says unknown, with when it resolves, while the report is %s', (effective) => {
    const tree = render(makeProps({ thinkingLevel: 'high', effectiveThinkingLevel: effective }));
    expect(textOf(readout(tree))).toBe('Effort: unknown');
    const hint = tree.root.findByProps({ testID: 'settings-effective-effort-hint' });
    expect(textOf(hint)).toMatch(/once a turn starts/);
    act(() => tree.unmount());
  });

  it('shows both levels, in the warning style, when the applied level differs from an explicit request', () => {
    const tree = render(makeProps({ thinkingLevel: 'high', effectiveThinkingLevel: 'medium' }));
    const node = readout(tree);
    expect(textOf(node)).toBe('Effort: Medium (requested High)');
    const flat = StyleSheet.flatten(node.props.style);
    expect(flat.borderColor).toBe(COLORS.accentOrangeBorder);
    expect(flat.opacity).toBe(1);
    // Colour is not the only signal: the label says the same in words.
    expect(node.props.accessibilityLabel).toContain('Requested High; Claude Code applied Medium.');
    act(() => tree.unmount());
  });

  it('renders nothing when the provider does not declare the capability', () => {
    const tree = render(makeProps({ thinkingLevelEffectiveSupported: false, thinkingLevel: 'high', effectiveThinkingLevel: 'medium' }));
    expect(hasReadout(tree)).toBe(false);
    expect(textOf(tree.root)).not.toContain('Effort');
    act(() => tree.unmount());
  });

  it('renders nothing when the capability prop is omitted (an older daemon / caller)', () => {
    const tree = render(makeProps({ thinkingLevelEffectiveSupported: undefined, thinkingLevel: 'high', effectiveThinkingLevel: 'medium' }));
    expect(hasReadout(tree)).toBe(false);
    act(() => tree.unmount());
  });

  it('is read-only: no tappable control carries the readout', () => {
    const tree = render(makeProps({ thinkingLevel: 'high', effectiveThinkingLevel: 'medium' }));
    // Count, don't assert on the nodes: a failing node assertion would print the
    // whole React fiber tree.
    const tappableCount = tree.root.findAllByType(TouchableOpacity).filter((n) => n.props.testID === TEST_ID).length;
    expect(tappableCount).toBe(0);
    act(() => tree.unmount());
  });

  it('lives in the expanded section only', () => {
    const tree = render(makeProps({ expanded: false, thinkingLevel: 'high', effectiveThinkingLevel: 'medium' }));
    expect(hasReadout(tree)).toBe(false);
    act(() => tree.unmount());
  });
});

describe('describeEffort (#8700)', () => {
  it('maps the three states to their copy', () => {
    expect(describeEffort('default', 'high')).toEqual({ text: 'Effort: High', hint: null, mismatch: false });
    expect(describeEffort(null, null)).toMatchObject({ text: 'Effort: unknown', mismatch: false });
    expect(describeEffort('xhigh', 'high')).toEqual({
      text: 'Effort: High (requested Xhigh)',
      hint: 'Requested Xhigh; Claude Code applied High.',
      mismatch: true,
    });
  });
});

describe('providerReportsEffort (#8700)', () => {
  it('needs BOTH capabilities, strictly true', () => {
    expect(providerReportsEffort({ thinkingLevel: true, thinkingLevelEffective: true })).toBe(true);
    // A reasoning control that reports nothing back: no readout.
    expect(providerReportsEffort({ thinkingLevel: true, thinkingLevelEffective: false })).toBe(false);
    expect(providerReportsEffort({ thinkingLevel: true })).toBe(false);
    // A report with no thinking-level setting to be the effective value of.
    expect(providerReportsEffort({ thinkingLevel: false, thinkingLevelEffective: true })).toBe(false);
    expect(providerReportsEffort({ thinkingLevelEffective: true })).toBe(false);
  });

  it('is false while the provider list has not landed', () => {
    expect(providerReportsEffort(undefined)).toBe(false);
    expect(providerReportsEffort(null)).toBe(false);
  });
});
