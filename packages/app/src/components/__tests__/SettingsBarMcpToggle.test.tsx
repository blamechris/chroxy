/**
 * Render tests for the mobile SettingsBar MCP enable/disable toggle (#6824).
 *
 * The MCP section lists configured servers; when a server reports `canToggle`
 * (the BYOK lane) and the parent wires `onToggleMcpServer`, the row renders a
 * Switch. Toggling it calls the handler with (serverName, nextEnabled).
 * Servers without `canToggle` (sdk/cli/tui) stay read-only.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Switch, TextInput, TouchableOpacity, Linking } from 'react-native';
import { SettingsBar, MCP_AUTH_HIT_SLOP } from '../SettingsBar';
import type { McpServer } from '@chroxy/store-core';

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    expanded: true,
    onToggle: () => {},
    activeModel: 'claude-opus-4-8',
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
    mcpServers: [] as McpServer[],
    setModel: () => {},
    setPermissionMode: () => {},
    ...overrides,
  };
}

function findSwitchByTestId(root: ReactTestInstance, testID: string): ReactTestInstance | null {
  return root.findAllByType(Switch).find((n) => n.props.testID === testID) ?? null;
}

describe('SettingsBar MCP enable/disable toggle (#6824)', () => {
  it('renders a Switch for a canToggle server and calls onToggleMcpServer on change', () => {
    const onToggle = jest.fn();
    const servers: McpServer[] = [{ name: 'filesystem', status: 'connected', enabled: true, canToggle: true }];
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: servers, onToggleMcpServer: onToggle })} />);
    });
    const sw = findSwitchByTestId(tree.root, 'mcp-server-toggle-filesystem');
    expect(sw).not.toBeNull();
    expect(sw!.props.value).toBe(true);

    act(() => { sw!.props.onValueChange(false); });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('filesystem', false);
  });

  it('reflects a disabled server as an off Switch', () => {
    const servers: McpServer[] = [{ name: 'gh', status: 'disabled', enabled: false, canToggle: true }];
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: servers, onToggleMcpServer: () => {} })} />);
    });
    const sw = findSwitchByTestId(tree.root, 'mcp-server-toggle-gh');
    expect(sw).not.toBeNull();
    expect(sw!.props.value).toBe(false);
  });

  it('does NOT render a Switch for a read-only (non-canToggle) server', () => {
    const servers: McpServer[] = [{ name: 'readonly', status: 'connected' }];
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: servers, onToggleMcpServer: () => {} })} />);
    });
    expect(findSwitchByTestId(tree.root, 'mcp-server-toggle-readonly')).toBeNull();
  });

  it('does NOT render a Switch when the parent wired no onToggleMcpServer handler', () => {
    const servers: McpServer[] = [{ name: 'filesystem', status: 'connected', enabled: true, canToggle: true }];
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: servers })} />);
    });
    expect(findSwitchByTestId(tree.root, 'mcp-server-toggle-filesystem')).toBeNull();
  });
});

function findByTestId(root: ReactTestInstance, type: React.ComponentType, testID: string): ReactTestInstance | null {
  return root.findAllByType(type as never).find((n) => n.props.testID === testID) ?? null;
}

describe('SettingsBar MCP OAuth affordance (#6822)', () => {
  const oauthSrv: McpServer = { name: 'remote', status: 'oauth-required', enabled: true, canToggle: true, authUrl: 'https://as.example/authorize?x=1' };

  it('renders an Authorize button + paste input for an oauth-required server', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: [oauthSrv], onSubmitMcpAuthCode: () => {} })} />);
    });
    expect(findByTestId(tree.root, TouchableOpacity, 'mcp-server-authorize-remote')).not.toBeNull();
    expect(findByTestId(tree.root, TextInput, 'mcp-server-auth-input-remote')).not.toBeNull();
  });

  it('opens the authUrl via Linking on Authorize press', () => {
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: [oauthSrv], onSubmitMcpAuthCode: () => {} })} />);
    });
    const btn = findByTestId(tree.root, TouchableOpacity, 'mcp-server-authorize-remote')!;
    act(() => { btn.props.onPress(); });
    expect(openSpy).toHaveBeenCalledWith('https://as.example/authorize?x=1');
    openSpy.mockRestore();
  });

  it('submits the pasted code (trimmed) via onSubmitMcpAuthCode and clears the input', () => {
    const onSubmit = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: [oauthSrv], onSubmitMcpAuthCode: onSubmit })} />);
    });
    const input = findByTestId(tree.root, TextInput, 'mcp-server-auth-input-remote')!;
    act(() => { input.props.onChangeText('  paste-code  '); });
    const submit = findByTestId(tree.root, TouchableOpacity, 'mcp-server-auth-submit-remote')!;
    act(() => { submit.props.onPress(); });
    expect(onSubmit).toHaveBeenCalledWith('remote', 'paste-code');
  });

  it('does NOT render the affordance for a connected server', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: [{ name: 'fs', status: 'connected', canToggle: true }], onSubmitMcpAuthCode: () => {} })} />);
    });
    expect(findByTestId(tree.root, TextInput, 'mcp-server-auth-input-fs')).toBeNull();
  });
});

// #6822 — Apple HIG: interactive elements need a ≥44×44pt effective touch target.
// The compact Authorize + Submit buttons use minHeight:44 (height) + a shared
// hitSlop (width) to clear it on BOTH axes even for the narrowest label.
describe('SettingsBar MCP OAuth touch targets (#6822)', () => {
  const oauthSrv: McpServer = { name: 'remote', status: 'oauth-required', enabled: true, canToggle: true, authUrl: 'https://as.example/authorize' };
  const FONT = 11; // mcpAuthorizeButtonText / mcpAuthSubmitText fontSize

  function flatStyle(node: ReactTestInstance) {
    const s = node.props.style;
    return Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : (s ?? {});
  }
  // Worst-case (single-glyph) effective bounds from style + hitSlop.
  function effective(node: ReactTestInstance) {
    const style = flatStyle(node);
    const hit = (node.props.hitSlop ?? {}) as { top?: number; bottom?: number; left?: number; right?: number };
    const border = (style.borderWidth ?? 0) * 2;
    const intrinsicW = Math.ceil(FONT * 0.6) + (style.paddingHorizontal ?? 0) * 2 + border;
    const intrinsicH = Math.max(style.minHeight ?? 0, FONT + (style.paddingVertical ?? 0) * 2 + border);
    return {
      width: intrinsicW + (hit.left ?? 0) + (hit.right ?? 0),
      height: intrinsicH + (hit.top ?? 0) + (hit.bottom ?? 0),
    };
  }

  it('exports a shared MCP_AUTH_HIT_SLOP with all four sides set', () => {
    expect(MCP_AUTH_HIT_SLOP).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });
  });

  it('the Authorize button clears 44×44 on both axes', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: [oauthSrv], onSubmitMcpAuthCode: () => {} })} />);
    });
    const btn = findByTestId(tree.root, TouchableOpacity, 'mcp-server-authorize-remote')!;
    expect(btn.props.hitSlop).toBe(MCP_AUTH_HIT_SLOP);
    const e = effective(btn);
    expect(e.width).toBeGreaterThanOrEqual(44);
    expect(e.height).toBeGreaterThanOrEqual(44);
  });

  it('the Submit button clears 44×44 on both axes', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingsBar {...makeProps({ mcpServers: [oauthSrv], onSubmitMcpAuthCode: () => {} })} />);
    });
    const btn = findByTestId(tree.root, TouchableOpacity, 'mcp-server-auth-submit-remote')!;
    expect(btn.props.hitSlop).toBe(MCP_AUTH_HIT_SLOP);
    const e = effective(btn);
    expect(e.width).toBeGreaterThanOrEqual(44);
    expect(e.height).toBeGreaterThanOrEqual(44);
  });
});
