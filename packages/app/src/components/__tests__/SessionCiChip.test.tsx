import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Linking } from 'react-native';
import type { ServerSessionPrStatusMessage } from '@chroxy/protocol';
import { SessionCiChip } from '../SessionCiChip';

const base: ServerSessionPrStatusMessage = {
  type: 'session_pr_status', sessionId: 's1', generatedAt: '2026-10-13T00:00:00Z',
  branch: 'feat/x', repo: { owner: 'blamechris', name: 'chroxy' }, pr: null, checks: null, merge: null, reason: null,
};
const mounted: renderer.ReactTestRenderer[] = [];
afterEach(() => { act(() => mounted.splice(0).forEach(tree => tree.unmount())); });
function render(status: ServerSessionPrStatusMessage | null, onRefresh = jest.fn(), disabled = false) {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<SessionCiChip status={status} onRefresh={onRefresh} disabled={disabled} />); });
  mounted.push(tree);
  return tree;
}
function text(tree: renderer.ReactTestRenderer) { return JSON.stringify(tree.toJSON()); }

it('shows No repo rather than a CI outage for a non-repository', () => {
  const tree = render({ ...base, branch: null, repo: null, reason: 'session working directory is not a git repository' });
  expect(text(tree)).toContain('No repo');
  expect(text(tree)).not.toContain('CI unavailable');
});
it('shows No PR for a successful survey with no PR', () => {
  expect(text(render(base))).toContain('No PR');
});
it('keeps the survey failure reason visible', () => {
  const tree = render({ ...base, reason: 'gh pr list failed: authentication required' });
  expect(text(tree)).toContain('CI unavailable');
  expect(tree.root.findAllByProps({ testID: 'session-ci-chip-reason' })[0].props.children).toBe('gh pr list failed: authentication required');
});
it('shows PR checks and merge state separately', () => {
  const tree = render({ ...base, pr: { number: 12, url: 'https://github.com/blamechris/chroxy/pull/12', title: 't', headRefOid: 'abc', isDraft: false }, checks: { state: 'success', counts: { total: 3, passed: 3, skipped: 0, failed: 0, pending: 0, unknown: 0 } }, merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: null } });
  expect(text(tree)).toContain('3/3 green');
  expect(text(tree)).toContain('merge: blocked');
});
it('refreshes through the supplied callback and disables refresh offline', () => {
  const onRefresh = jest.fn();
  const tree = render(base, onRefresh);
  act(() => tree.root.findAllByProps({ testID: 'session-ci-chip-refresh' })[0].props.onPress());
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(render(base, onRefresh, true).root.findAllByProps({ testID: 'session-ci-chip-refresh' })[0].props.disabled).toBe(true);
});
it('offers no navigable link for an unsafe PR URL', () => {
  const open = jest.spyOn(Linking, 'openURL');
  const tree = render({ ...base, pr: { number: 12, url: 'javascript:alert(1)', title: 't', headRefOid: null, isDraft: false } });
  expect(tree.root.findAllByProps({ accessibilityRole: 'link' })).toHaveLength(0);
  expect(text(tree)).toContain('#');
  expect(open).not.toHaveBeenCalled();
  open.mockRestore();
});
it('renders nothing before a snapshot arrives', () => {
  expect(render(null).toJSON()).toBeNull();
});
