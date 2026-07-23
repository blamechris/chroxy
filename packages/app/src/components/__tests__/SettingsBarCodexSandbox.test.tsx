/**
 * Render tests for the SettingsBar read-only Codex sandbox badge (#6901).
 *
 * session_list carries `codexSandbox` only for codex sessions; the SettingsBar
 * renders a read-only badge showing the active/resolved sandbox mode with copy
 * noting a change requires a new session (Codex applies the sandbox at thread
 * start — display-only, not an in-place switch).
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { SettingsBar } from '../SettingsBar';
import type { CodexSandboxMode } from '@chroxy/protocol';

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

function makeProps(overrides: Partial<{ codexSandbox: CodexSandboxMode | null }> = {}) {
  return {
    expanded: true,
    onToggle: () => {},
    activeModel: 'gpt-5-codex',
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

describe('SettingsBar codex sandbox badge (#6901)', () => {
  it('renders the read-only badge with the mode label for a codex session', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ codexSandbox: 'read-only' })} />);
    });
    const root = tree!.root;
    const badge = root.findByProps({ testID: 'codex-sandbox-badge' });
    // Label single-sourced from CODEX_SANDBOX_MODE_META ('Read-only').
    expect(collectVisibleText(badge)).toContain('Read-only');
  });

  it('surfaces the mid-session constraint in the sandbox hint', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ codexSandbox: 'workspace-write' })} />);
    });
    const root = tree!.root;
    const hint = root.findByProps({ testID: 'codex-sandbox-hint' });
    expect(collectVisibleText(hint)).toMatch(/new session/i);
  });

  it('renders nothing when codexSandbox is null (non-codex session)', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ codexSandbox: null })} />);
    });
    const root = tree!.root;
    expect(() => root.findByProps({ testID: 'codex-sandbox-badge' })).toThrow();
    expect(() => root.findByProps({ testID: 'codex-sandbox-hint' })).toThrow();
  });
});
