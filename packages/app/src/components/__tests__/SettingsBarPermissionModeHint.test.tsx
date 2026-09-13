/**
 * Render tests for the SettingsBar permission-mode hint (#4213).
 *
 * Mobile follow-up to the dashboard #4019/#4211 plumbing: the server's
 * PERMISSION_MODES table exports a description for every mode and the
 * mobile SettingsBar must surface the selected mode's description under
 * the chip row. Falls back to the hardcoded copy when the server didn't
 * send a description (older server).
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { SettingsBar } from '../SettingsBar';
import type { PermissionMode } from '@chroxy/store-core';

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

function makeProps(overrides: Partial<{
  expanded: boolean;
  permissionMode: string | null;
  availablePermissionModes: PermissionMode[];
}> = {}) {
  return {
    expanded: true,
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

describe('SettingsBar permission-mode hint (#4213)', () => {
  it('disables a permission-mode chip reported as unsupported', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps({
            permissionMode: 'approve',
            availablePermissionModes: [
              { id: 'approve', label: 'Approve', supported: true, enforcement: 'chroxy' },
              { id: 'auto', label: 'Auto (unavailable)', supported: false, enforcement: 'unsupported' },
            ],
          })}
        />,
      );
    });
    const unsupported = tree!.root.findByProps({ testID: 'permission-mode-auto' });
    expect(unsupported.props.disabled).toBe(true);
    expect(unsupported.props.accessibilityState).toEqual({ selected: false, disabled: true });
    expect(collectVisibleText(unsupported)).toContain('Auto (unavailable)');
  });

  it('renders the server-supplied description for the selected mode', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps({
            permissionMode: 'auto',
            availablePermissionModes: [
              { id: 'approve', label: 'Approve', description: 'Server-said APPROVE explainer.' },
              { id: 'auto', label: 'Auto', description: 'Server-said AUTO explainer.' },
            ],
          })}
        />,
      );
    });
    const root = tree!.root;
    const hint = root.findByProps({ testID: 'permission-mode-hint' });
    expect(collectVisibleText(hint)).toContain('Server-said AUTO explainer.');
  });

  it('falls back to the hardcoded copy when the server omits description (older server)', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps({
            permissionMode: 'plan',
            availablePermissionModes: [
              { id: 'approve', label: 'Approve' },
              { id: 'plan', label: 'Plan' },
            ],
          })}
        />,
      );
    });
    const root = tree!.root;
    const hint = root.findByProps({ testID: 'permission-mode-hint' });
    expect(collectVisibleText(hint)).toContain('provider is asked to plan before acting');
    expect(collectVisibleText(hint)).toContain('enforcement is not reported by this provider');
    expect(collectVisibleText(hint)).not.toContain('always require a Chroxy prompt');
  });

  it.each(['approve', 'acceptEdits', 'auto', 'plan'])(
    'uses conservative fallback copy for %s when enforcement metadata is missing',
    (mode) => {
      let tree: renderer.ReactTestRenderer | null = null;
      act(() => {
        tree = renderer.create(
          <SettingsBar
            {...makeProps({
              permissionMode: mode,
              availablePermissionModes: [{ id: mode, label: mode }],
            })}
          />,
        );
      });
      const hint = tree!.root.findByProps({ testID: 'permission-mode-hint' });
      const text = collectVisibleText(hint);
      expect(text).toContain('enforcement is not reported by this provider');
      expect(text).not.toContain('always require a Chroxy prompt');
    },
  );

  it('retains the protected-path guarantee when the server reports Chroxy enforcement', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps({
            permissionMode: 'auto',
            availablePermissionModes: [
              { id: 'auto', label: 'Auto', supported: true, enforcement: 'chroxy' },
            ],
          })}
        />,
      );
    });
    const hint = tree!.root.findByProps({ testID: 'permission-mode-hint' });
    expect(collectVisibleText(hint)).toContain('always require a Chroxy prompt');
    expect(collectVisibleText(hint)).not.toContain('enforcement is not reported');
  });

  it('hides the hint when no permission mode is selected', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps({
            permissionMode: null,
            availablePermissionModes: [
              { id: 'approve', label: 'Approve', description: 'A description.' },
            ],
          })}
        />,
      );
    });
    const root = tree!.root;
    expect(() => root.findByProps({ testID: 'permission-mode-hint' })).toThrow();
  });

  // #4251: parity with dashboard #4019 — when the selected mode has neither
  // a server-supplied description nor a hardcoded fallback (e.g. a future
  // provider added a new mode the mobile build doesn't recognise), the
  // hint must render the same catch-all string CreateSessionModal.tsx
  // emits at the end of its fallback chain.
  it('renders catch-all hint when the selected mode has neither server nor fallback copy', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <SettingsBar
          {...makeProps({
            permissionMode: 'customMode',
            availablePermissionModes: [
              { id: 'customMode', label: 'Custom' },
            ],
          })}
        />,
      );
    });
    const root = tree!.root;
    const hint = root.findByProps({ testID: 'permission-mode-hint' });
    expect(collectVisibleText(hint)).toContain(
      'Uses whatever the server’s --default-permission-mode was set to (usually Approve).',
    );
  });
});
