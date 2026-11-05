/**
 * #8915 — the model chips mark a model the backend refused for the client this
 * session launched (`providerRuntimeInfo.rejectedModels`, #8909) as
 * non-selectable, matching by `id` or `fullId`. An absent or empty list
 * changes nothing.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import { SettingsBar } from '../SettingsBar';

const MARK = "refused by this session's client";

function chipText(chip: ReactTestInstance): string {
  return chip.findAllByType(Text).map((node) => {
    const c = node.props.children;
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : '')).join('');
    return '';
  }).join(' ');
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    expanded: true,
    onToggle: () => {},
    activeModel: 'gpt-5.5',
    defaultModelId: null,
    availableModels: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.6', label: 'GPT-5.6', fullId: 'openai/gpt-5.6' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
    ],
    permissionMode: 'approve',
    availablePermissionModes: [{ id: 'approve', label: 'Approve' }],
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
    provider: 'codex',
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

function chip(tree: renderer.ReactTestRenderer, id: string): ReactTestInstance {
  return tree.root.find(
    (n) => n.type === TouchableOpacity && n.props.testID === `settings-model-${id}`,
  );
}

describe('SettingsBar refused models (#8915)', () => {
  it('a refused chip (matched by id) is disabled, marked, and cannot select the model', () => {
    const setModel = jest.fn();
    const tree = render(makeProps({ setModel, rejectedModelIds: ['gpt-5.4'] }));
    const refused = chip(tree, 'gpt-5.4');
    expect(refused.props.disabled).toBe(true);
    expect(refused.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    expect(chipText(refused)).toContain(MARK);
    act(() => { refused.props.onPress(); });
    expect(setModel).not.toHaveBeenCalled();
  });

  it('a refused chip matched by fullId is disabled and marked', () => {
    const setModel = jest.fn();
    const tree = render(makeProps({ setModel, rejectedModelIds: ['openai/gpt-5.6'] }));
    const refused = chip(tree, 'gpt-5.6');
    expect(refused.props.disabled).toBe(true);
    expect(chipText(refused)).toContain(MARK);
    act(() => { refused.props.onPress(); });
    expect(setModel).not.toHaveBeenCalled();
  });

  it('other chips stay selectable and unmarked alongside a refused one', () => {
    const setModel = jest.fn();
    const tree = render(makeProps({ setModel, rejectedModelIds: ['gpt-5.4'] }));
    const ok = chip(tree, 'gpt-5.6');
    expect(ok.props.disabled).toBe(false);
    expect(chipText(ok)).not.toContain(MARK);
    act(() => { ok.props.onPress(); });
    expect(setModel).toHaveBeenCalledWith('gpt-5.6');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', []],
  ])('an %s list changes nothing', (_label, rejectedModelIds) => {
    const setModel = jest.fn();
    const tree = render(makeProps({ setModel, rejectedModelIds }));
    for (const id of ['gpt-5.5', 'gpt-5.6', 'gpt-5.4']) {
      const c = chip(tree, id);
      expect(c.props.disabled).toBe(false);
      expect(chipText(c)).not.toContain(MARK);
    }
    act(() => { chip(tree, 'gpt-5.4').props.onPress(); });
    expect(setModel).toHaveBeenCalledWith('gpt-5.4');
  });
});
