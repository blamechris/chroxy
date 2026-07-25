/**
 * ControlRoomView capability gating for the Scheduled tasks tab (#6871).
 *
 * The `scheduled-tasks` descriptor is gated on the daemon advertising
 * `scheduledTasks` in auth_ok — i.e. on the server HAVING the WS surface, NOT on
 * scheduled execution being enabled. That distinction is the point: the enable
 * gate is off by default, so gating the tab on it would hide exactly the banner
 * that tells an operator their saved tasks will never fire. An older daemon
 * without the surface shows no dead chrome (fail-closed), and a
 * persisted/deep-linked tab degrades to 'repos'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

let storeState: Record<string, unknown> = {}

function resetStore(over: Record<string, unknown> = {}) {
  storeState = {
    connectionPhase: 'connected',
    hostStatus: null, runnerStatus: null, integrationStatus: null,
    hostStatusLoading: false, runnerStatusLoading: false, integrationStatusLoading: false,
    requestHostStatus: vi.fn(() => true), requestRunnerStatus: vi.fn(() => true), requestIntegrationStatus: vi.fn(() => true),
    sessions: [], activity: { bySession: {} },
    externalSessionsSnapshot: null, requestExternalSessions: vi.fn(() => true),
    orchestrationRuns: null, orchestrationRunsLoading: false,
    requestOrchestrationRuns: vi.fn(() => true),
    scheduledTasks: null, scheduledTasksLoading: false,
    requestScheduledTasks: vi.fn(() => true),
    serverCapabilities: {},
    ...over,
  }
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    typeof selector === 'function' ? selector(storeState) : storeState,
}))

vi.mock('./ControlRoomSection', () => ({
  ControlRoomSection: () => <div data-testid="stub-repos">repos</div>,
  formatGeneratedAgo: () => 'just now',
}))
vi.mock('./ScheduledTasksSection', () => ({
  ScheduledTasksSection: () => <div data-testid="stub-sched">scheduled</div>,
}))
vi.mock('./SettingsPanel', () => ({
  SettingsContent: () => <div data-testid="stub-settings">settings</div>,
}))

import { ControlRoomView } from './ControlRoomView'

beforeEach(() => { resetStore(); localStorage.clear() })
afterEach(() => cleanup())

describe('Scheduled tasks tab capability gating (#6871)', () => {
  it('hides the tab when the scheduledTasks capability is absent (older daemon)', () => {
    render(<ControlRoomView />)
    expect(screen.queryByRole('tab', { name: 'Scheduled tasks' })).toBeNull()
  })

  it('a persisted tab falls back to repos when the capability is off (fail-closed)', () => {
    localStorage.setItem('chroxy_cr_tab', 'scheduled-tasks')
    render(<ControlRoomView />)
    expect(screen.queryByTestId('stub-sched')).toBeNull()
    expect(screen.getByTestId('stub-repos')).toBeTruthy()
  })

  it('shows + renders the tab when the capability is advertised', () => {
    resetStore({ serverCapabilities: { scheduledTasks: true } })
    localStorage.setItem('chroxy_cr_tab', 'scheduled-tasks')
    render(<ControlRoomView />)
    expect(screen.getByRole('tab', { name: 'Scheduled tasks' })).toBeTruthy()
    expect(screen.getByTestId('stub-sched')).toBeTruthy()
  })

  it('the tab is NOT gated on scheduled execution being enabled', () => {
    // The capability is present but the scheduler itself is off (the default).
    // The tab must still appear — its banner is what reports the closed gate.
    resetStore({
      serverCapabilities: { scheduledTasks: true },
      scheduledTasks: {
        type: 'scheduled_tasks',
        generatedAt: '2026-07-24T00:00:00.000Z',
        scheduler: { enabled: false, engineArmed: false, restartRequired: false, source: 'default' },
        schedulableProviders: [], defaultProvider: 'claude-tui', defaultProviderRefusal: 'nope', tasks: [],
      },
    })
    localStorage.setItem('chroxy_cr_tab', 'scheduled-tasks')
    render(<ControlRoomView />)
    expect(screen.getByRole('tab', { name: 'Scheduled tasks' })).toBeTruthy()
    expect(screen.getByTestId('stub-sched')).toBeTruthy()
  })

  it('every ungated tab still renders in the strip (no over-filtering)', () => {
    resetStore({ serverCapabilities: { scheduledTasks: true } })
    render(<ControlRoomView />)
    expect(screen.getByRole('tab', { name: 'Project status' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy()
  })
})
