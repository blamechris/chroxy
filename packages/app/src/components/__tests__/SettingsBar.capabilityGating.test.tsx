/**
 * #5731 — SettingsBar gates the model + permission-mode chips on the active
 * provider's capabilities (mirrors the dashboard's dropdownFlags). A provider
 * that can't switch mid-session (e.g. claude-tui) must not render interactive
 * chips that silently do nothing on tap.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
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
