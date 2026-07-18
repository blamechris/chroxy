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

  it('collapsed summary still shows a percent for a claude provider missing contextWindow', () => {
    const tree = render(makeProps({
      provider: 'claude-sdk',
      activeModel: 'sonnet',
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6' } as ModelInfo,
      ],
    }));
    const text = collectVisibleText(tree.root);
    // #6769: metered against the auto-compact-adjusted effective ceiling
    // (200k → 184k), so 12_500 / 184_000 = 6.79% → rounds to 7%.
    expect(text).toContain('7%');
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
    // #6769: metered against the effective ceiling (32k → 29.44k), so
    // 12_500 / 29_440 ≈ 42%.
    expect(collectVisibleText(tree.root)).toContain('(42%)');
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
    // #6769: 200k default → 184k effective ceiling → 12_500 / 184_000 ≈ 7%.
    expect(collectVisibleText(tree.root)).toContain('(7%)');
  });

  // #6769: a mid-conversation cached turn — tiny new input/output but a large
  // cache_read history. The meter must read the CUMULATIVE occupancy, not the
  // near-empty per-turn input+output.
  it('includes cache_read history in the meter total (#6769)', () => {
    const cachedUsage: ContextUsage = {
      inputTokens: 500,
      outputTokens: 1_500,
      cacheRead: 150_000,
      cacheCreation: 0,
    };
    const tree = render(makeProps({
      expanded: true,
      provider: 'claude-sdk',
      activeModel: 'sonnet',
      contextUsage: cachedUsage,
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 } as ModelInfo,
      ],
    }));
    const text = collectVisibleText(tree.root);
    // Occupancy = 152k (500 + 1.5k + 150k), NOT the 2k per-turn input+output.
    expect(text).toContain('152.0k tokens');
    // 152k / 184k effective ceiling ≈ 83% — well past the per-turn ~1%.
    expect(text).toContain('(83%)');
  });
});
