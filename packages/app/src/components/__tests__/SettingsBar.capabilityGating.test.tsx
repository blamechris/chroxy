/**
 * #5731 — SettingsBar gates the model + permission-mode chips on the active
 * provider's capabilities (mirrors the dashboard's dropdownFlags). A provider
 * that can't switch mid-session (e.g. claude-tui) must not render interactive
 * chips that silently do nothing on tap.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import { SettingsBar } from '../SettingsBar';

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

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    expanded: true, // chips render in the expanded section
    onToggle: () => {},
    activeModel: 'opus',
    defaultModelId: null,
    availableModels: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }],
    permissionMode: 'approve',
    availablePermissionModes: [{ id: 'approve', label: 'Approve' }, { id: 'plan', label: 'Plan' }],
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

describe('SettingsBar capability gating (#5731)', () => {
  it('renders interactive model chips when modelSwitch is supported (default)', () => {
    const tree = render(makeProps());
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Opus');
    expect(text).toContain('Sonnet');
    expect(text).not.toContain('fixed');
  });

  it('renders a read-only model badge (no interactive chips) when modelSwitch is false', () => {
    const setModel = jest.fn();
    const tree = render(makeProps({ modelSwitchSupported: false, setModel }));
    const text = collectVisibleText(tree.root);
    // The fixed-model badge shows the active model label + "fixed".
    expect(text).toContain('Opus');
    expect(text).toContain('fixed');
    // The non-active model ('Sonnet') must NOT appear as a switchable chip.
    expect(text).not.toContain('Sonnet');
  });

  it('uses defaultModelId for the fixed badge when there is no explicit activeModel', () => {
    const tree = render(makeProps({
      modelSwitchSupported: false,
      activeModel: null,
      defaultModelId: 'sonnet',
    }));
    const text = collectVisibleText(tree.root);
    // Falls back to the default model's label rather than rendering no model row.
    expect(text).toContain('Sonnet');
    expect(text).toContain('fixed');
  });

  it('hides the permission-mode chips when permissionModeSwitch is false', () => {
    const tree = render(makeProps({ permissionModeSwitchSupported: false }));
    const text = collectVisibleText(tree.root);
    // 'Plan' is only ever rendered as a permission-mode chip → absent when gated off.
    expect(text).not.toContain('Plan');
  });

  it('shows the permission-mode chips when permissionModeSwitch is supported (default)', () => {
    const tree = render(makeProps());
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Approve');
    expect(text).toContain('Plan');
  });

  it('falls back to interactive (supported) when the flags are omitted', () => {
    // Older callers that don't pass the flags get the prior behaviour.
    const tree = render(makeProps({ modelSwitchSupported: undefined, permissionModeSwitchSupported: undefined }));
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Sonnet');
    expect(text).toContain('Plan');
    expect(text).not.toContain('fixed');
  });
});

describe('SettingsBar target identity (#8260)', () => {
  const aliases = [
    { id: 'haiku', fullId: 'haiku', label: 'Haiku 4.5' },
    { id: 'haiku-4-5', fullId: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    { id: 'haiku-4-5-20251001', fullId: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ];
  it('labels distinct aliases and pins, highlights exactly one, and sends the tapped selection ID', () => {
    const setModel = jest.fn();
    const tree = render(makeProps({ availableModels: aliases, activeModel: aliases[2].fullId, setModel, provider: 'claude-sdk' }));
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Haiku 4.5 (provider alias)');
    expect(text).toContain('Haiku 4.5 (pinned 4.5)');
    expect(text).toContain('Haiku 4.5 (pinned 20251001)');
    const chips = tree.root.findAllByType(TouchableOpacity).filter(node => node.props.testID?.startsWith('settings-model-'));
    expect(chips.filter(node => node.props.accessibilityState.selected)).toHaveLength(1);
    act(() => chips[1].props.onPress());
    expect(setModel).toHaveBeenCalledWith('haiku-4-5');
    act(() => tree.unmount());
  });
  it('uses display fallback without highlighting the family chip', () => {
    const tree = render(makeProps({ availableModels: aliases, activeModel: 'claude-haiku-4-5-20251101', provider: 'claude-sdk' }));
    expect(collectVisibleText(tree.root)).toContain('Haiku 4.5 (pinned 20251101)');
    const chips = tree.root.findAllByType(TouchableOpacity).filter(node => node.props.testID?.startsWith('settings-model-') && node.props.accessibilityState?.selected === true);
    expect(chips).toHaveLength(0);
    act(() => tree.unmount());
  });
});

describe('SettingsBar null active-model default (#8260)', () => {
  it.each([true, false])('shows the known default in collapsed and expanded states with modelSwitch=%s without setting a model', (modelSwitchSupported) => {
    const setModel = jest.fn();
    const props = makeProps({ activeModel: null, defaultModelId: 'haiku', availableModels: [{ id: 'haiku', fullId: 'claude-haiku-4-5', label: 'Haiku 4.5' }], modelSwitchSupported, setModel, provider: 'claude-sdk', expanded: false });
    const tree = render(props);
    expect(collectVisibleText(tree.root)).toContain('Default (Haiku 4.5)');
    expect(tree.root.findAll(node => node.props.accessibilityHint === 'Model target: claude-haiku-4-5').length).toBeGreaterThan(0);
    act(() => tree.update(<SettingsBar {...(props as unknown as React.ComponentProps<typeof SettingsBar>)} expanded />));
    const expandedModel = tree.root.findByProps({ testID: modelSwitchSupported ? 'settings-model-haiku' : 'settings-fixed-model' });
    expect(collectVisibleText(expandedModel)).toContain('Default (Haiku 4.5)');
    expect(expandedModel.props.accessibilityHint).toBe('Model target: claude-haiku-4-5');
    expect(setModel).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

it('shows and selects Chroxy Sonnet 5.5 Default alongside upstream Default and Fable (#8603)', () => {
  const setModel = jest.fn();
  const tree = render(makeProps({
    activeModel: null,
    defaultModelId: 'sonnet-5-5',
    availableModels: [
      { id: 'sonnet-5-5', fullId: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'default', fullId: 'default', label: 'Fable 5.1' },
      { id: 'fable-5-1', fullId: 'claude-fable-5-1', label: 'Fable 5.1' },
    ],
    provider: 'claude-sdk',
    setModel,
  }));
  const chip = tree.root.findByProps({ testID: 'settings-model-sonnet-5-5' });
  expect(collectVisibleText(chip)).toContain('Default (Sonnet 5.5)');
  expect(chip.props.accessibilityHint).toBe('Model target: claude-sonnet-5-5');
  act(() => chip.props.onPress());
  expect(setModel).toHaveBeenCalledWith('sonnet-5-5');
  expect(tree.root.findByProps({ testID: 'settings-model-default' })).toBeDefined();
  expect(tree.root.findByProps({ testID: 'settings-model-fable-5-1' })).toBeDefined();
  act(() => tree.unmount());
});
