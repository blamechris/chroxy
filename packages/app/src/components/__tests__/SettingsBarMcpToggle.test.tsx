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
import { Switch } from 'react-native';
import { SettingsBar } from '../SettingsBar';
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
