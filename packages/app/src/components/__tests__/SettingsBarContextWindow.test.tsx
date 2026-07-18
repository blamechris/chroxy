/**
 * Render tests for the SettingsBar context meter (#5424 / #6769).
 *
 * #6769: the meter reads the provider's end-of-turn OCCUPANCY SNAPSHOT
 * (`contextOccupancy`) — the SDK's getContextUsage() numbers or byok's
 * final-round prompt size. It is NEVER derived from the billing usage
 * aggregate (`result.usage`), which sums cache_read across agent-loop rounds
 * and over-reads window fill ≈N× on an N-round turn. Providers with no
 * snapshot (claude-cli / claude-tui / codex / gemini / ollama) render no
 * meter at all — the honest dash state.
 *
 * #5424 carries over inside the snapshot model: when occupancy exists but the
 * window is genuinely unknown (no snapshot maxTokens + no registry window),
 * show the raw token count — no percentage, no bar — instead of metering
 * against a fabricated 200k.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { SettingsBar } from '../SettingsBar';
import type { SettingsBarProps } from '../SettingsBar';
import type { ContextOccupancy, ModelInfo } from '../../store/connection';

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

/** byok-style final-round snapshot: total only, no window/threshold. */
function byokSnapshot(totalTokens: number): ContextOccupancy {
  return {
    totalTokens,
    maxTokens: null,
    autoCompactThreshold: null,
    isAutoCompactEnabled: null,
    source: 'final-round-prompt',
  };
}

/** SDK-style snapshot with the real window + auto-compact threshold. */
function sdkSnapshot(
  totalTokens: number,
  maxTokens: number,
  autoCompactThreshold: number,
): ContextOccupancy {
  return {
    totalTokens,
    maxTokens,
    autoCompactThreshold,
    isAutoCompactEnabled: true,
    source: 'context-usage-api',
  };
}

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
    contextOccupancy: byokSnapshot(12_500),
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

describe('SettingsBar context meter — occupancy snapshot (#5424 / #6769)', () => {
  it('collapsed summary shows the raw occupancy count (no percent) when the window is unknown', () => {
    const tree = render(makeProps());
    const text = collectVisibleText(tree.root);
    expect(text).toContain('12.5k tokens');
    expect(text).not.toMatch(/\d+%/);
  });

  it('collapsed summary shows a percent for a claude provider via the 200k default + reserve', () => {
    const tree = render(makeProps({
      provider: 'claude-byok',
      activeModel: 'sonnet',
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6' } as ModelInfo,
      ],
    }));
    const text = collectVisibleText(tree.root);
    // byok snapshot has no threshold → documented reserve fallback:
    // 200k default → 184k effective ceiling → 12_500 / 184_000 ≈ 7%.
    expect(text).toContain('7%');
  });

  it('expanded view renders the unknown-window row (raw count, no percent, no bar)', () => {
    const tree = render(makeProps({ expanded: true }));
    const unknownRow = tree.root.findByProps({ testID: 'context-usage-unknown-window' });
    expect(collectVisibleText(unknownRow)).toContain('12.5k tokens');
    const text = collectVisibleText(tree.root);
    expect(text).not.toMatch(/\(\d+%\)/);
  });

  it('expanded view meters against the registry window when the model reports one', () => {
    const tree = render(makeProps({
      expanded: true,
      availableModels: [
        { id: 'llama3:8b', label: 'llama3:8b', fullId: 'llama3:8b', contextWindow: 32_000 } as ModelInfo,
      ],
    }));
    expect(tree.root.findAllByProps({ testID: 'context-usage-unknown-window' })).toHaveLength(0);
    // Reserve fallback: 32k → 29.44k ceiling → 12_500 / 29_440 ≈ 42%.
    expect(collectVisibleText(tree.root)).toContain('(42%)');
  });

  // #6769 core: the SDK snapshot meters against its real autoCompactThreshold
  // and its own maxTokens — no reserve guessing, no billing aggregate.
  it('meters an SDK snapshot against its real autoCompactThreshold (#6769)', () => {
    const tree = render(makeProps({
      expanded: true,
      provider: 'claude-sdk',
      activeModel: 'sonnet',
      contextOccupancy: sdkSnapshot(110_000, 200_000, 167_000),
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 } as ModelInfo,
      ],
    }));
    const text = collectVisibleText(tree.root);
    expect(text).toContain('110.0k tokens');
    // 110k / 167k threshold ≈ 66% — the real ceiling, not the 8% reserve.
    expect(text).toContain('(66%)');
  });

  // #6769: no snapshot → no meter at all, even for a claude provider with a
  // known window. Deriving fill from billing usage was the bug.
  it('renders NO context row when there is no occupancy snapshot (honest dash) (#6769)', () => {
    const tree = render(makeProps({
      expanded: true,
      provider: 'claude-cli',
      activeModel: 'sonnet',
      contextOccupancy: null,
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 } as ModelInfo,
      ],
    }));
    const text = collectVisibleText(tree.root);
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toMatch(/\d[\d.]*k tokens/);
    expect(tree.root.findAllByProps({ testID: 'context-usage-unknown-window' })).toHaveLength(0);
  });

  it('a smaller later snapshot reads smaller — compaction follows down (#6769)', () => {
    // Pre-compaction: 152k on a 200k window (167k threshold) ≈ 91%.
    const before = render(makeProps({
      expanded: true,
      provider: 'claude-sdk',
      activeModel: 'sonnet',
      contextOccupancy: sdkSnapshot(152_000, 200_000, 167_000),
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 } as ModelInfo,
      ],
    }));
    expect(collectVisibleText(before.root)).toContain('(91%)');
    // Post-compaction snapshot: 40k ≈ 24% — the meter simply follows.
    const after = render(makeProps({
      expanded: true,
      provider: 'claude-sdk',
      activeModel: 'sonnet',
      contextOccupancy: sdkSnapshot(40_000, 200_000, 167_000),
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 } as ModelInfo,
      ],
    }));
    expect(collectVisibleText(after.root)).toContain('(24%)');
  });
});
