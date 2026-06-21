import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ActivityEntry, ActivityState, CrossSessionMeta } from '@chroxy/store-core'
import { createEmptyActivityState, applyActivitySnapshot } from '@chroxy/store-core'
import type { ExternalSessionEntry } from '@chroxy/protocol'
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
    // Two distinct cwds → two groups; the worktree badge appears on exactly the
    // wt group (asserted by data-group-key below, not by order — the selector
    // sorts by full cwd path so the `.chroxy/worktrees/...` path actually sorts
    // before `/home/u/repo-a`, which is irrelevant to this assertion).
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

  // #5969 — read-only external (/api/events) sessions.
  const EXTERNAL: ExternalSessionEntry[] = [
    { source: 'cli', sessionId: 'x1', name: 'chroxy', project: 'chroxy', cwd: '/home/u/chroxy', status: 'running', subagents: 2, lastActivityTs: T0 + 500 },
    { source: 'cli', sessionId: 'x2', name: 'widget', project: null, cwd: '/home/u/widget', status: 'idle', subagents: 0, lastActivityTs: T0 },
  ]

  it('renders external sessions in their own read-only section', () => {
    render(<CrossSessionMissionControl activity={createEmptyActivityState()} sessions={[]} external={EXTERNAL} now={NOW} />)
    // Not the empty state — external sessions count as content.
    expect(screen.queryByTestId('mission-control-empty')).toBeNull()
    expect(screen.getByTestId('mission-control-external')).toBeTruthy()
    expect(screen.getByTestId('mission-control-external-readonly').textContent).toContain('read-only')
    expect(screen.getByTestId('mission-control-external-x1')).toBeTruthy()
    expect(screen.getByTestId('mission-control-external-x2')).toBeTruthy()
    expect(screen.getByTestId('mission-control-external-status-x1').textContent).toBe('Running')
    expect(screen.getByTestId('mission-control-external-status-x2').textContent).toBe('Idle')
    // Subagent count only when > 0.
    expect(screen.getByTestId('mission-control-external-subagents-x1').textContent).toContain('2 subagents')
    expect(screen.queryByTestId('mission-control-external-subagents-x2')).toBeNull()
  })

  it('offers no control affordance for external sessions (static row, no toggle)', () => {
    render(<CrossSessionMissionControl activity={createEmptyActivityState()} sessions={[]} external={EXTERNAL} now={NOW} />)
    // Managed sessions get a toggle button; external sessions must not.
    expect(screen.queryByTestId('mission-control-session-toggle-x1')).toBeNull()
    expect(screen.queryByTestId('mission-control-session-tree-x1')).toBeNull()
  })

  it('shows both managed groups and the external section together', () => {
    const state = stateOf({ s1: [entry({ id: 'e1', status: 'running' })] })
    render(<CrossSessionMissionControl activity={state} sessions={[SESSIONS[0]!]} external={EXTERNAL} now={NOW} />)
    expect(screen.getByTestId('mission-control-group')).toBeTruthy()
    expect(screen.getByTestId('mission-control-external')).toBeTruthy()
  })

  it('omits the external section when there are no external sessions', () => {
    const state = stateOf({ s1: [entry({ id: 'e1', status: 'running' })] })
    render(<CrossSessionMissionControl activity={state} sessions={[SESSIONS[0]!]} now={NOW} />)
    expect(screen.queryByTestId('mission-control-external')).toBeNull()
  })

  // #6125 — control actions wired into the aggregate view.
  it('wires cancel + jump-to-intervene into each session tree', () => {
    const onCancel = vi.fn()
    const onJump = vi.fn()
    const state = stateOf({ s1: [entry({ id: 'agent1', kind: 'agent', status: 'blocked' })] })
    render(
      <CrossSessionMissionControl
        activity={state}
        sessions={[SESSIONS[0]!]}
        onCancelActivity={onCancel}
        onJumpToSession={onJump}
        now={NOW}
      />,
    )
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-s1'))
    // Cancel a subagent → carries the owning sessionId for the session-scoped cancel.
    fireEvent.click(screen.getByTestId('control-room-cancel-agent1'))
    expect(onCancel).toHaveBeenCalledWith('agent1', 's1')
    // Jump-to-intervene on the blocked node → switches to that session.
    fireEvent.click(screen.getByTestId('control-room-jump-agent1'))
    expect(onJump).toHaveBeenCalledWith('s1')
  })

  it('scopes the ${sessionId}:${activityId} cancelling set down to each tree', () => {
    const state = stateOf({ s1: [entry({ id: 'agent1', kind: 'agent', status: 'running' })] })
    render(
      <CrossSessionMissionControl
        activity={state}
        sessions={[SESSIONS[0]!]}
        onCancelActivity={vi.fn()}
        cancellingActivityIds={new Set(['s1:agent1', 's2:other'])}
        now={NOW}
      />,
    )
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-s1'))
    // The 's1:agent1' entry resolves to this tree's plain 'agent1' id → pending.
    expect((screen.getByTestId('control-room-cancel-agent1') as HTMLButtonElement).textContent).toBe('Cancelling…')
  })
})
