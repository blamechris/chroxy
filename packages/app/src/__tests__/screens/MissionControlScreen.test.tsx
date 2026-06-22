/**
 * Render tests for the mobile MissionControlScreen (#5968 PR1).
 *
 * Proves the read-only cross-session view's grouping + rollups by reusing
 * store-core's `selectCrossSessionActivity` over SEEDED `ActivityState` (built
 * with `createEmptyActivityState` + `applyActivitySnapshot`, mirroring the
 * dashboard's CrossSessionMissionControl.test.tsx fixtures). No device, no live
 * feeder, no store/navigator: the test drives the pure `MissionControlBody`
 * directly with fixtures — same render-test harness as ObserverBanner.test.tsx.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import type { ActivityEntry, ActivityState, CrossSessionMeta } from '@chroxy/store-core';
import { createEmptyActivityState, applyActivitySnapshot } from '@chroxy/store-core';
import { MissionControlBody } from '../../screens/MissionControlScreen';

const T0 = 1_800_000_000_000;

function entry(over: Partial<ActivityEntry> & Pick<ActivityEntry, 'id'>): ActivityEntry {
  const status = over.status ?? 'running';
  const terminal = status === 'done' || status === 'failed';
  return {
    id: over.id,
    kind: over.kind ?? 'tool',
    label: over.label ?? `label-${over.id}`,
    status,
    startedAt: over.startedAt ?? T0,
    endedAt: over.endedAt ?? (terminal ? T0 + 1000 : undefined),
    parentId: over.parentId,
    outputRef: over.outputRef,
  };
}

function stateOf(map: Record<string, ActivityEntry[]>): ActivityState {
  let s = createEmptyActivityState();
  for (const [sid, entries] of Object.entries(map)) {
    s = applyActivitySnapshot(s, { type: 'activity_snapshot', sessionId: sid, schemaVersion: 1, entries });
  }
  return s;
}

const SESSIONS: CrossSessionMeta[] = [
  { sessionId: 's1', cwd: '/home/u/repo-a', name: 'A1' },
  { sessionId: 's2', cwd: '/home/u/repo-a', name: 'A2' },
  { sessionId: 's3', cwd: '/home/u/repo-b', name: 'B1' },
];

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance | null {
  const matches = root.findAll((n) => n.props?.testID === testID);
  return matches.length > 0 ? matches[0] : null;
}

function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((n) => n.props?.testID === testID);
}

function textOf(node: ReactTestInstance | null): string {
  if (node === null) return '';
  return node
    .findAllByType(Text)
    .map((n) => {
      const c = n.props.children;
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('');
      return '';
    })
    .join(' ');
}

describe('MissionControlScreen (#5968 PR1)', () => {
  let tree: renderer.ReactTestRenderer | null = null;
  afterEach(() => {
    if (tree) {
      act(() => tree!.unmount());
      tree = null;
    }
  });

  function render(props: React.ComponentProps<typeof MissionControlBody>): renderer.ReactTestRenderer {
    let t!: renderer.ReactTestRenderer;
    act(() => {
      t = renderer.create(<MissionControlBody {...props} />);
    });
    tree = t;
    return t;
  }

  it('renders the empty state when there are no sessions', () => {
    const t = render({ activity: createEmptyActivityState(), sessions: [] });
    expect(findByTestId(t.root, 'mission-control-empty')).not.toBeNull();
    expect(findByTestId(t.root, 'mission-control-group-label')).toBeNull();
  });

  it('groups sessions by repo+worktree with labels and the overall total', () => {
    const activity = stateOf({
      s1: [entry({ id: 'e1', status: 'running' })],
      s2: [entry({ id: 'e2', status: 'blocked' })],
      s3: [entry({ id: 'e3', status: 'failed' })],
    });
    const t = render({ activity, sessions: SESSIONS });

    const labels = findAllByTestId(t.root, 'mission-control-group-label').map((n) => textOf(n));
    expect(labels).toEqual(['repo-a', 'repo-b']);

    // Overall total: 1 running + 1 blocked + 1 failed.
    expect(textOf(findByTestId(t.root, 'mission-control-total-running'))).toContain('1');
    expect(textOf(findByTestId(t.root, 'mission-control-total-blocked'))).toContain('1');
    expect(textOf(findByTestId(t.root, 'mission-control-total-failed'))).toContain('1');
  });

  it('renders a per-session status badge derived from activity entries', () => {
    const activity = stateOf({
      s1: [entry({ id: 'e1', status: 'running' })],
      s2: [entry({ id: 'e2', status: 'blocked' })],
      // s3 has no activity → idle.
    });
    const t = render({ activity, sessions: SESSIONS });

    expect(textOf(findByTestId(t.root, 'mission-control-session-status-s1'))).toBe('Running');
    expect(textOf(findByTestId(t.root, 'mission-control-session-status-s2'))).toBe('Blocked');
    expect(textOf(findByTestId(t.root, 'mission-control-session-status-s3'))).toBe('Idle');
  });

  it('shows a worktree badge only on a group flagged as a worktree', () => {
    const activity = stateOf({ wt: [entry({ id: 'e', status: 'blocked' })] });
    const t = render({
      activity,
      sessions: [
        { sessionId: 'main', cwd: '/home/u/repo-a', name: 'main' },
        { sessionId: 'wt', cwd: '/home/u/.chroxy/worktrees/repo-a-feat', name: 'feat', worktree: true },
      ],
    });
    // Exactly one group carries the worktree badge.
    expect(findAllByTestId(t.root, 'mission-control-group-worktree').length).toBe(1);
  });
});
