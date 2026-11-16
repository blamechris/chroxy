import React from 'react';
import TestRenderer, { act, ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { GitView } from '../../components/GitView';
import type { GitFileStatus, GitStatusResult } from '../../store/types';

const mockStore = {
  setGitStatusCallback: jest.fn(),
  setGitBranchesCallback: jest.fn(),
  setGitStageCallback: jest.fn(),
  setGitCommitCallback: jest.fn(),
  requestGitStatus: jest.fn(() => true),
  requestGitBranches: jest.fn(() => true),
  requestGitStage: jest.fn((_paths: string[]) => true),
  requestGitUnstage: jest.fn((_paths: string[]) => true),
  requestGitCommit: jest.fn(() => true),
};

jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}));
jest.mock('../../components/Icon', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Icon: ({ name }: { name: string }) => React.createElement(View, { testID: `icon-${name}` }) };
});

const emptyStatus: GitStatusResult = { branch: 'main', staged: [], unstaged: [], untracked: [], error: null };
const outsideHint = 'Outside this session’s folder';
let renderer: ReactTestRenderer;
let statusCallback: (status: GitStatusResult) => void;

function show(status: Partial<GitStatusResult> = {}) {
  act(() => { renderer = TestRenderer.create(<GitView visible onClose={jest.fn()} />); });
  statusCallback = mockStore.setGitStatusCallback.mock.calls.find(([callback]) => typeof callback === 'function')![0];
  updateStatus(status);
}

function updateStatus(status: Partial<GitStatusResult>) {
  act(() => { statusCallback({ ...emptyStatus, ...status }); });
}

function control(label: string) {
  return renderer.root.findAllByType(TouchableOpacity).find((node) => node.props.accessibilityLabel === label)!;
}

function press(label: string) {
  const node = control(label);
  expect(node).toBeDefined();
  act(() => { node.props.onPress(); });
}

function expectBlocked(label: string) {
  const row = control(label);
  expect(row).toBeDefined();
  expect(row.props.disabled).toBe(true);
  expect(row.props.accessibilityState).toMatchObject({ checked: false, disabled: true });
  expect(row.props.accessibilityHint).toBe(outsideHint);
  expect(StyleSheet.flatten(row.props.style).opacity).toBeLessThan(1);
  expect(row.findAllByType(Text).some((node) => node.props.children === outsideHint)).toBe(true);
  // Invoke the handler too: a disabled native control must not be the only guard.
  press(label);
  expect(control(label).props.accessibilityState.checked).toBe(false);
}

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

describe('GitView session-folder boundary', () => {
  it('renders an empty status without stage actions', () => {
    show();
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Working tree clean')).toBe(true);
    expect(control('Stage selected files')).toBeUndefined();
    expect(control('Unstage selected files')).toBeUndefined();
  });

  it('keeps normal staged, unstaged and untracked files selectable with repeated toggling', () => {
    show({
      staged: [{ path: 'staged.ts', status: 'modified' }],
      unstaged: [{ path: 'changed.ts', status: 'modified' }],
      untracked: ['new.ts'],
    });
    const changed = 'Unstaged modified file changed.ts';
    press(changed);
    expect(control(changed).props.accessibilityState.checked).toBe(true);
    press(changed);
    expect(control(changed).props.accessibilityState.checked).toBe(false);
    expect(control('Stage selected files')).toBeUndefined();
    press(changed);
    press('Untracked file new.ts');
    press('Staged modified file staged.ts');
    press('Stage selected files');
    expect(mockStore.requestGitStage).toHaveBeenCalledWith(['changed.ts', 'new.ts']);
    press('Unstage selected files');
    expect(mockStore.requestGitUnstage).toHaveBeenCalledWith(['staged.ts']);
  });

  it('shows disabled hints for outside staged, unstaged and untracked rows without requests', () => {
    show({
      staged: [{ path: '../staged.ts', status: 'modified' }],
      unstaged: [{ path: '../changed.ts', status: 'modified' }],
      untracked: ['../new.ts'],
    });
    expectBlocked('Staged modified file ../staged.ts');
    expectBlocked('Unstaged modified file ../changed.ts');
    expectBlocked('Untracked file ../new.ts');
    expect(control('Stage selected files')).toBeUndefined();
    expect(control('Unstage selected files')).toBeUndefined();
    expect(mockStore.requestGitStage).not.toHaveBeenCalled();
    expect(mockStore.requestGitUnstage).not.toHaveBeenCalled();
  });

  it.each(['staged', 'unstaged'] as const)('does not re-select a %s row that left and re-entered the folder', (section) => {
    const label = `${section === 'staged' ? 'Staged' : 'Unstaged'} modified file back.ts`;
    show({ [section]: [{ path: 'back.ts', status: 'modified' }] });
    press(label);
    expect(control(label).props.accessibilityState.checked).toBe(true);
    updateStatus({ [section]: [{ path: '/abs/back.ts', status: 'modified' }, { path: 'back.ts', oldPath: '../x', status: 'renamed' }] });
    updateStatus({ [section]: [{ path: 'back.ts', status: 'modified' }] });
    expect(control(label).props.accessibilityState.checked).toBe(false);
    expect(control('Stage selected files')).toBeUndefined();
    expect(control('Unstage selected files')).toBeUndefined();
  });

  it('keeps in-folder names that merely start with two dots selectable', () => {
    show({ unstaged: [{ path: '..notes', status: 'modified' }], untracked: ['..draft.md'] });
    press('Unstaged modified file ..notes');
    press('Untracked file ..draft.md');
    expect(control('Unstaged modified file ..notes').props.disabled).toBeFalsy();
    press('Stage selected files');
    expect([...mockStore.requestGitStage.mock.calls[0][0]].sort()).toEqual(['..draft.md', '..notes']);
  });

  it.each(['staged', 'unstaged'] as const)('rejects both directions of cross-boundary renames in %s', (section) => {
    show({ [section]: [
      { path: '../moved-out.ts', oldPath: 'inside.ts', status: 'renamed' },
      { path: 'moved-in.ts', oldPath: '../outside.ts', status: 'renamed' },
    ] });
    const prefix = section === 'staged' ? 'Staged' : 'Unstaged';
    expectBlocked(`${prefix} renamed file ../moved-out.ts`);
    expectBlocked(`${prefix} renamed file moved-in.ts`);
    expect(control('Stage selected files')).toBeUndefined();
    expect(control('Unstage selected files')).toBeUndefined();
    expect(mockStore.requestGitStage).not.toHaveBeenCalled();
    expect(mockStore.requestGitUnstage).not.toHaveBeenCalled();
  });

  it.each(['staged', 'unstaged'] as const)('preserves inside rename pairs and copy source independence in %s payloads', (section) => {
    const files: GitFileStatus[] = [
      { path: 'new-name.ts', oldPath: 'old-name.ts', status: 'renamed' },
      { path: 'copy.ts', oldPath: '../copy-source.ts', status: 'copied' },
    ];
    show({ [section]: files });
    const prefix = section === 'staged' ? 'Staged' : 'Unstaged';
    press(`${prefix} renamed file new-name.ts`);
    press(`${prefix} copied file copy.ts`);
    expect(control(`${prefix} copied file copy.ts`).props.accessibilityState.checked).toBe(true);
    press(section === 'staged' ? 'Unstage selected files' : 'Stage selected files');
    const request = section === 'staged' ? mockStore.requestGitUnstage : mockStore.requestGitStage;
    expect(request).toHaveBeenCalledTimes(1);
    const paths = request.mock.calls[0][0];
    expect([...paths].sort()).toEqual(['copy.ts', 'new-name.ts', 'old-name.ts']);
  });

  it.each(['staged', 'unstaged'] as const)('invalidates a selected %s row when refreshed rename metadata crosses the boundary', (section) => {
    show({ [section]: [{ path: 'same.ts', oldPath: 'old.ts', status: 'renamed' }] });
    const label = `${section === 'staged' ? 'Staged' : 'Unstaged'} renamed file same.ts`;
    press(label);
    expect(control(label).props.accessibilityState.checked).toBe(true);
    updateStatus({ [section]: [{ path: 'same.ts', oldPath: '../old.ts', status: 'renamed' }] });
    expectBlocked(label);
    expect(control(label).findAll((node) => node.props.testID === 'icon-check')).toHaveLength(0);
    expect(control('Stage selected files')).toBeUndefined();
    expect(control('Unstage selected files')).toBeUndefined();
    expect(mockStore.requestGitStage).not.toHaveBeenCalled();
    expect(mockStore.requestGitUnstage).not.toHaveBeenCalled();
  });
});
