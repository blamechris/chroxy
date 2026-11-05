/** #8238 — collapsed summary row is per-session: location + provider. */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SettingsBar } from '../SettingsBar';

function summary(overrides: Record<string, unknown> = {}) {
  const props = {
    expanded: false, onToggle: () => {}, activeModel: null, defaultModelId: null,
    availableModels: [], permissionMode: null, availablePermissionModes: [],
    lastResultCost: null, lastResultDuration: null, sessionCost: null,
    cumulativeUsage: null, costBudget: null, contextOccupancy: null,
    sessionCwd: '/Users/me/server/default-root/4e3ea80d/scratchpad/smoke-repo',
    serverMode: 'cli' as const, isIdle: true, activeAgents: [], interventions: [],
    connectedClients: [], customAgents: [], mcpServers: [],
    setModel: () => {}, setPermissionMode: () => {}, ...overrides,
  };
  let tree!: renderer.ReactTestRenderer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  act(() => { tree = renderer.create(<SettingsBar {...(props as any)} />); });
  const text = tree.root.findAllByType(Text).map((t) => String(t.props.children)).join('|');
  act(() => tree.unmount());
  return text;
}

describe('SettingsBar summary (#8238)', () => {
  it('worktree session: repo name + provider, no cli, no server default cwd', () => {
    const t = summary({
      activeSession: { cwd: '/Users/me/.chroxy/worktrees/34914672f8578ecdf71accf8f8aec47e', repoCwd: '/Users/me/Projects/chroxy' },
      provider: 'claude-sdk',
    });
    expect(t).toContain('chroxy');
    expect(t).toContain('SDK');
    expect(t).not.toContain('cli');
    expect(t).not.toContain('smoke-repo');
    expect(t).not.toContain('34914672');
  });
  it('plain session: boundary-shortened cwd + provider', () => {
    const t = summary({ activeSession: { cwd: '/Users/me/Projects/chroxy', repoCwd: null }, provider: 'codex' });
    expect(t).toContain('Projects/chroxy');
    expect(t).toContain('Codex');
    expect(t).not.toContain('cli');
  });
  it('no session: falls back to the default cwd at a boundary', () => {
    const t = summary({ activeSession: null });
    expect(t).toContain('scratchpad/smoke-repo');
    expect(t).not.toContain('4e3ea80d');
  });
});
