/**
 * ControlRoomView capability gating for the Runs tab (#6691 S-3b).
 *
 * The `runs` descriptor is capability-gated: it renders in the strip (and
 * deep-links/persistence resolve to it) ONLY while the daemon advertises
 * `orchestration` in auth_ok. Fail-closed — a feature-off daemon shows no dead
 * chrome, and a persisted/deep-linked 'runs' tab degrades to 'repos'.
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
vi.mock('./OrchestrationRunsSection', () => ({
  OrchestrationRunsSection: () => <div data-testid="stub-runs">runs</div>,
}))
vi.mock('./SettingsPanel', () => ({
  SettingsContent: () => <div data-testid="stub-settings">settings</div>,
}))

import { ControlRoomView } from './ControlRoomView'

beforeEach(() => { resetStore(); localStorage.clear() })
afterEach(() => cleanup())

describe('Runs tab capability gating (#6691 S-3b)', () => {
  it('hides the Runs tab when the orchestration capability is absent', () => {
    render(<ControlRoomView />)
    expect(screen.queryByRole('tab', { name: 'Runs' })).toBeNull()
  })

  it('a persisted "runs" tab falls back to repos when the capability is off (fail-closed)', () => {
    localStorage.setItem('chroxy_cr_tab', 'runs')
    render(<ControlRoomView />)
    expect(screen.queryByTestId('stub-runs')).toBeNull()
    expect(screen.getByTestId('stub-repos')).toBeTruthy()
  })

  it('shows + renders the Runs tab when the capability is advertised', () => {
    resetStore({ serverCapabilities: { orchestration: true } })
    localStorage.setItem('chroxy_cr_tab', 'runs')
    render(<ControlRoomView />)
    expect(screen.getByRole('tab', { name: 'Runs' })).toBeTruthy()
    expect(screen.getByTestId('stub-runs')).toBeTruthy()
  })

  it('every ungated tab still renders in the strip (no over-filtering)', () => {
    render(<ControlRoomView />)
    expect(screen.getByRole('tab', { name: 'Project status' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy()
  })
})
