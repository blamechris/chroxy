import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { applyActivitySnapshot, createEmptyActivityState } from '@chroxy/store-core'

let storeState: Record<string, unknown> = {}
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}))
vi.mock('./SettingsPanel', () => ({ SettingsContent: () => null }))

import { ControlRoomView } from './ControlRoomView'

const repo = '/srv/projects/chroxy'
const sessions = [
  { sessionId: 'wt-b', cwd: '/home/u/.chroxy/worktrees/22222222222222222222222222222222', repoCwd: repo, name: 'Worktree B', worktree: true },
  { sessionId: 'main', cwd: repo, name: 'Main' },
  { sessionId: 'wt-a', cwd: '/home/u/.chroxy/worktrees/11111111111111111111111111111111', repoCwd: repo, name: 'Worktree A', worktree: true },
]

beforeEach(() => {
  localStorage.clear()
  let activity = createEmptyActivityState()
  for (const [sessionId, status] of [['wt-b', 'blocked'], ['main', 'running'], ['wt-a', 'failed']] as const) {
    activity = applyActivitySnapshot(activity, { type: 'activity_snapshot', schemaVersion: 1, sessionId, entries: [
      { id: 'shared-entry-id', kind: 'agent', label: sessionId, status, startedAt: 1, ...(status === 'failed' ? { endedAt: 2 } : {}) },
    ] })
  }
  storeState = {
    sessions, activity, connectionPhase: 'connected', serverCapabilities: {},
    externalSessionsSnapshot: null, requestExternalSessions: vi.fn(() => true),
    sendCancelActivity: vi.fn(), switchSession: vi.fn(), cancellingActivityIds: new Set(),
  }
})
afterEach(cleanup)

describe('Control Room repository grouping (#8199)', () => {
  it('passes repository metadata from the store through the actual adapter to the real mission control', () => {
    const onSwitchSession = vi.fn()
    const { rerender } = render(<ControlRoomView initialTab="mission-control" onSwitchSession={onSwitchSession} />)
    expect(storeState.requestExternalSessions).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId('mission-control-group')).toHaveLength(1)
    const group = screen.getByTestId('mission-control-group')
    expect(group.getAttribute('data-group-key')).toBe(repo)
    expect(within(group).getByTestId('mission-control-group-label').textContent).toBe('chroxy')
    expect(within(group).getByTestId('mission-control-group-worktree')).toBeTruthy()
    expect([...group.querySelectorAll('.mission-control-session')].map((n) => n.getAttribute('data-testid'))).toEqual([
      'mission-control-session-wt-b', 'mission-control-session-main', 'mission-control-session-wt-a',
    ])
    for (const status of ['running', 'blocked', 'failed']) {
      expect(screen.getByTestId(`mission-control-total-${status}`).textContent).toBe(`1 ${status}`)
      expect(within(group).getByTestId(`mission-control-group-rollup-${status}`).textContent).toBe(`1 ${status}`)
    }
    // Merging changes grouping only: expansion, jump, and cancel still target session IDs.
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-wt-b'))
    fireEvent.click(screen.getByTestId('control-room-jump-shared-entry-id'))
    expect(onSwitchSession).toHaveBeenCalledWith('wt-b')
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-wt-b'))
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-main'))
    fireEvent.click(screen.getByTestId('control-room-cancel-shared-entry-id'))
    expect(storeState.sendCancelActivity).toHaveBeenCalledWith('shared-entry-id', 'main')
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-main'))
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-wt-b'))
    // Moving a worktree preserves its expanded tree, because identity is not the group key.
    storeState = { ...storeState, sessions: sessions.map((s) => s.sessionId === 'main' ? s : { ...s, cwd: '/new/' + s.sessionId }) }
    rerender(<ControlRoomView initialTab="mission-control" onSwitchSession={onSwitchSession} />)
    expect(screen.getAllByTestId('mission-control-group')).toHaveLength(1)
    expect(screen.getByTestId('mission-control-session-tree-wt-b')).toBeTruthy()
  })
})
