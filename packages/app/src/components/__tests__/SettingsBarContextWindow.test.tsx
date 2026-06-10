/**
 * Render tests for the SettingsBar context-usage meter when the model's
 * context window is unknown (#5424).
 *
 * Ollama deliberately reports `contextWindow: null` (the effective window is
 * the local model file's num_ctx), so the meter must show the raw token
 * count — no percentage, no progress bar — instead of metering against a
 * fabricated 200k. Claude-backed providers keep the 200k default because
 * it's a genuine default there.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { SettingsBar } from '../SettingsBar';
import type { SettingsBarProps } from '../SettingsBar';
import type { ContextUsage, ModelInfo } from '../../store/connection';

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

const contextUsage: ContextUsage = {
  inputTokens: 12_000,
  outputTokens: 500,
  cacheCreation: 0,
  cacheRead: 0,
};

function makeProps(overrides: Partial<SettingsBarProps> = {}): SettingsBarProps {
  return {
    expanded: false,
    onToggle: () => {},
    activeModel: 'llama3:8b',
    availableModels: [
      // Ollama models ship contextWindow: null on the wire; store-core drops
      // non-positive values, so the entry simply has no contextWindow here.
      { id: 'llama3:8b', label: 'llama3:8b', fullId: 'llama3:8b' } as ModelInfo,
    ],
    permissionMode: null,
    availablePermissionModes: [],
    lastResultCost: null,
    lastResultDuration: null,
    sessionCost: null,
    cumulativeUsage: null,
    costBudget: null,
    contextUsage,
    sessionCwd: '/tmp',
    serverMode: 'cli' as const,
    isIdle: true,
    activeAgents: [],
    connectedClients: [],
    customAgents: [],
    mcpServers: [],
    setModel: () => {},
    setPermissionMode: () => {},
    provider: 'ollama',
    ...overrides,
  };
}

function render(props: SettingsBarProps): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<SettingsBar {...props} />);
  });
  return tree;
}

describe('SettingsBar context meter with unknown context window (#5424)', () => {
  it('collapsed summary shows the raw token count (no percent) for an ollama model with no contextWindow', () => {
    const tree = render(makeProps());
    const text = collectVisibleText(tree.root);
    expect(text).toContain('12.5k tokens');
    expect(text).not.toMatch(/\d+%/);
  });

  it('collapsed summary still shows a percent against 200k for a claude provider missing contextWindow', () => {
    const tree = render(makeProps({
      provider: 'claude-sdk',
      activeModel: 'sonnet',
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6' } as ModelInfo,
      ],
    }));
    const text = collectVisibleText(tree.root);
    // 12_500 / 200_000 = 6.25% → rounds to 6%
    expect(text).toContain('6%');
  });

  it('expanded view renders the unknown-window row (raw count, no percent, no bar) for ollama', () => {
    const tree = render(makeProps({ expanded: true }));
    const unknownRow = tree.root.findByProps({ testID: 'context-usage-unknown-window' });
    expect(collectVisibleText(unknownRow)).toContain('12.5k tokens');
    const text = collectVisibleText(tree.root);
    expect(text).not.toMatch(/\(\d+%\)/);
  });

  it('expanded view keeps the percentage + meter when the ollama model reports a real window', () => {
    const tree = render(makeProps({
      expanded: true,
      availableModels: [
        { id: 'llama3:8b', label: 'llama3:8b', fullId: 'llama3:8b', contextWindow: 32_000 } as ModelInfo,
      ],
    }));
    expect(tree.root.findAllByProps({ testID: 'context-usage-unknown-window' })).toHaveLength(0);
    // 12_500 / 32_000 ≈ 39%
    expect(collectVisibleText(tree.root)).toContain('(39%)');
  });

  it('expanded view keeps the 200k-default percentage for a claude provider missing contextWindow', () => {
    const tree = render(makeProps({
      expanded: true,
      provider: 'claude-sdk',
      activeModel: 'sonnet',
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6' } as ModelInfo,
      ],
    }));
    expect(tree.root.findAllByProps({ testID: 'context-usage-unknown-window' })).toHaveLength(0);
    expect(collectVisibleText(tree.root)).toContain('(6%)');
  });
});
