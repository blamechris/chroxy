import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ActivityEntry, ActivityState, CrossSessionMeta } from '@chroxy/store-core'
import { createEmptyActivityState, applyActivitySnapshot } from '@chroxy/store-core'
import { CrossSessionMissionControl } from './CrossSessionMissionControl'

const T0 = 1_800_000_000_000
const NOW = () => T0 + 5000

function entry(over: Partial<ActivityEntry> & Pick<ActivityEntry, 'id'>): ActivityEntry {
  const status = over.status ?? 'running'
  const terminal = status === 'done' || status === 'failed'
  return {
    id: over.id,
    kind: over.kind ?? 'tool',
    label: over.label ?? `label-${over.id}`,
    status,
    startedAt: over.startedAt ?? T0,
    endedAt: over.endedAt ?? (terminal ? T0 + 1000 : undefined),
    parentId: over.parentId,
    outputRef: over.outputRef,
  }
}

function stateOf(map: Record<string, ActivityEntry[]>): ActivityState {
  let s = createEmptyActivityState()
  for (const [sid, entries] of Object.entries(map)) {
    s = applyActivitySnapshot(s, { type: 'activity_snapshot', sessionId: sid, schemaVersion: 1, entries })
  }
  return s
}

const SESSIONS: CrossSessionMeta[] = [
  { sessionId: 's1', cwd: '/home/u/repo-a', name: 'A1' },
  { sessionId: 's2', cwd: '/home/u/repo-a', name: 'A2' },
  { sessionId: 's3', cwd: '/home/u/repo-b', name: 'B1' },
]

describe('CrossSessionMissionControl', () => {
  afterEach(() => cleanup())

  it('renders the empty state when there are no sessions', () => {
    render(<CrossSessionMissionControl activity={createEmptyActivityState()} sessions={[]} now={NOW} />)
    expect(screen.getByTestId('mission-control-empty')).toBeTruthy()
    expect(screen.queryByTestId('mission-control-group')).toBeNull()
  })

  it('groups sessions by repo+worktree with labels and the overall total', () => {
    const state = stateOf({
      s1: [entry({ id: 'e1', status: 'running' })],
      s2: [entry({ id: 'e2', status: 'blocked' })],
      s3: [entry({ id: 'e3', status: 'failed' })],
    })
    render(<CrossSessionMissionControl activity={state} sessions={SESSIONS} now={NOW} />)
    const labels = screen.getAllByTestId('mission-control-group-label').map((n) => n.textContent)
    expect(labels).toEqual(['repo-a', 'repo-b'])
    // Overall total: 1 running + 1 blocked + 1 failed.
    expect(screen.getByTestId('mission-control-total-running').textContent).toContain('1')
    expect(screen.getByTestId('mission-control-total-blocked').textContent).toContain('1')
    expect(screen.getByTestId('mission-control-total-failed').textContent).toContain('1')
  })

  it('renders per-group rollups and a worktree badge only where flagged', () => {
    const state = stateOf({ wt: [entry({ id: 'e', status: 'blocked' })] })
    render(<CrossSessionMissionControl activity={state} sessions={[
      { sessionId: 'main', cwd: '/home/u/repo-a', name: 'main' },
      { sessionId: 'wt', cwd: '/home/u/.chroxy/worktrees/repo-a-feat', name: 'feat', worktree: true },
    ]} now={NOW} />)
    const groups = screen.getAllByTestId('mission-control-group')
    // repo-a (named) sorts before the worktrees path; worktree badge only on the wt group.
    const worktreeBadges = screen.getAllByTestId('mission-control-group-worktree')
    expect(worktreeBadges.length).toBe(1)
    // The flagged group is the one containing the wt session.
    const wtGroup = groups.find((g) => g.getAttribute('data-group-key') === '/home/u/.chroxy/worktrees/repo-a-feat')!
    expect(wtGroup.querySelector('[data-testid="mission-control-group-worktree"]')).toBeTruthy()
  })

  it('shows a derived status badge per session', () => {
    const state = stateOf({
      s1: [entry({ id: 'e1', status: 'running' })],
      s2: [entry({ id: 'e2', status: 'blocked' })],
    })
    render(<CrossSessionMissionControl activity={state} sessions={SESSIONS} now={NOW} />)
    expect(screen.getByTestId('mission-control-session-status-s1').textContent).toBe('Running')
    expect(screen.getByTestId('mission-control-session-status-s2').textContent).toBe('Blocked')
    expect(screen.getByTestId('mission-control-session-status-s3').textContent).toBe('Idle') // no activity
  })

  it('expands a session into its v1 ActivityTree (no regression — reuses the tree)', () => {
    const state = stateOf({ s1: [entry({ id: 'tool-1', status: 'running', label: 'grep src' })] })
    render(<CrossSessionMissionControl activity={state} sessions={SESSIONS} now={NOW} />)
    // Collapsed: no tree yet.
    expect(screen.queryByTestId('mission-control-session-tree-s1')).toBeNull()
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-s1'))
    // Expanded: the per-session ActivityTree renders the entry from the v1 path.
    expect(screen.getByTestId('mission-control-session-tree-s1')).toBeTruthy()
    expect(screen.getByTestId('control-room-entry-label-tool-1').textContent).toBe('grep src')
    // Collapse again.
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-s1'))
    expect(screen.queryByTestId('mission-control-session-tree-s1')).toBeNull()
  })

  it('orders named groups ascending with the Ungrouped bucket last', () => {
    render(<CrossSessionMissionControl activity={createEmptyActivityState()} sessions={[
      { sessionId: 'z', cwd: '/home/u/repo-z', name: 'Z' },
      { sessionId: 'a', cwd: '/home/u/repo-a', name: 'A' },
      { sessionId: 'u', cwd: null, name: 'U' },
    ]} now={NOW} />)
    const labels = screen.getAllByTestId('mission-control-group-label').map((n) => n.textContent)
    expect(labels).toEqual(['repo-a', 'repo-z', 'Ungrouped'])
  })

  it('reflects updated activity on re-render (live rollups)', () => {
    const before = stateOf({ s1: [entry({ id: 'e1', status: 'running' })] })
    const { rerender } = render(<CrossSessionMissionControl activity={before} sessions={[SESSIONS[0]!]} now={NOW} />)
    expect(screen.getByTestId('mission-control-total-blocked').textContent).toContain('0')
    const after = stateOf({ s1: [entry({ id: 'e1', status: 'blocked' })] })
    rerender(<CrossSessionMissionControl activity={after} sessions={[SESSIONS[0]!]} now={NOW} />)
    expect(screen.getByTestId('mission-control-total-blocked').textContent).toContain('1')
    expect(screen.getByTestId('mission-control-total-running').textContent).toContain('0')
  })
})
