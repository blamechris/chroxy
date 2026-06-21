/**
 * ControlRoomView (#5253) — the Control Room tab shell.
 *
 * Covers: all tabs render, the repos tab is the default, clicking a tab swaps
 * the active section, the choice is persisted to localStorage and restored on
 * the next mount, a stale/garbage persisted value degrades to the default, and
 * onInvestigate / onOpenSession are forwarded to the repo section.
 *
 * The child sections each read the zustand store; stub them so this test
 * only exercises the tab shell.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// #5543: the auto-fetch effect reads the connection store. Mock it (matching
// the codebase convention in App.test/ControlRoomSection.test) so these tests
// drive a plain state object + spy actions rather than the real store — which
// also avoids the dual-React-instance hazard of rendering real store hooks
// under testing-library.
const requestHostStatusMock = vi.fn(() => true)
const requestRunnerStatusMock = vi.fn(() => true)
const requestIntegrationStatusMock = vi.fn(() => true)
let storeState: Record<string, unknown> = {}

function resetStore(over: Record<string, unknown> = {}) {
  requestHostStatusMock.mockClear()
  requestRunnerStatusMock.mockClear()
  requestIntegrationStatusMock.mockClear()
  storeState = {
    connectionPhase: 'connected',
    hostStatus: null,
    runnerStatus: null,
    integrationStatus: null,
    hostStatusLoading: false,
    runnerStatusLoading: false,
    integrationStatusLoading: false,
    requestHostStatus: requestHostStatusMock,
    requestRunnerStatus: requestRunnerStatusMock,
    requestIntegrationStatus: requestIntegrationStatusMock,
    // #6183: the mission-control tab's wrapper reads these from the store.
    sessions: [],
    activity: { bySession: {} },
    // #5969: mission control also pulls the external-session snapshot on open.
    externalSessionsSnapshot: null,
    requestExternalSessions: vi.fn(() => true),
    ...over,
  }
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    typeof selector === 'function' ? selector(storeState) : storeState,
}))

vi.mock('./ControlRoomSection', () => ({
  ControlRoomSection: ({ onInvestigate, onOpenSession }: { onInvestigate?: unknown; onOpenSession?: unknown }) => (
    <div
      data-testid="stub-repos"
      data-has-investigate={onInvestigate ? 'yes' : 'no'}
      data-has-open-session={onOpenSession ? 'yes' : 'no'}
    >
      repos
    </div>
  ),
}))
vi.mock('./RunnerStatusSection', () => ({
  RunnerStatusSection: () => <div data-testid="stub-runners">runners</div>,
}))
vi.mock('./IntegrationsSection', () => ({
  IntegrationsSection: () => <div data-testid="stub-integrations">integrations</div>,
}))
// #5544: the Settings tab embeds the (heavy, store-backed) SettingsContent.
// Stub it so the tab-shell tests stay focused on routing/auto-fetch behaviour
// and surface the `active` prop the embed threads through.
vi.mock('./SettingsPanel', () => ({
  SettingsContent: ({ active }: { active?: boolean }) => (
    <div data-testid="stub-settings" data-active={active ? 'yes' : 'no'}>
      settings
    </div>
  ),
}))
// #6183: stub the (store-backed) mission-control view so the tab-shell test stays
// focused on routing (the descriptor↔render-branch wiring), not the aggregate.
vi.mock('./CrossSessionMissionControl', () => ({
  CrossSessionMissionControl: () => <div data-testid="stub-mission-control">mission-control</div>,
}))

import { ControlRoomView, CONTROL_ROOM_STALENESS_MS, CONTROL_ROOM_TABS } from './ControlRoomView'

const KEY = 'chroxy_cr_tab'

beforeEach(() => {
  localStorage.clear()
  resetStore()
})
afterEach(cleanup)

/** A snapshot whose `generatedAt` is `ageMs` in the past. */
function snapshotAt(ageMs: number) {
  return { type: 'host_status_snapshot', generatedAt: new Date(Date.now() - ageMs).toISOString(), root: '/p', repos: [] }
}

describe('ControlRoomView', () => {
  it('renders all tabs and defaults to the repos section', () => {
    render(<ControlRoomView />)
    expect(screen.getByTestId('cr-tab-repos')).toBeTruthy()
    expect(screen.getByTestId('cr-tab-runners')).toBeTruthy()
    expect(screen.getByTestId('cr-tab-integrations')).toBeTruthy()
    // #5544: the converged Settings tab.
    expect(screen.getByTestId('cr-tab-settings')).toBeTruthy()
    expect(screen.getByTestId('stub-repos')).toBeTruthy()
    expect(screen.queryByTestId('stub-runners')).toBeNull()
    expect(screen.queryByTestId('stub-integrations')).toBeNull()
    expect(screen.queryByTestId('stub-settings')).toBeNull()
    expect(screen.getByTestId('cr-tab-repos').getAttribute('aria-selected')).toBe('true')
  })

  it('switches to the runners section when its tab is clicked, and persists it', () => {
    render(<ControlRoomView />)
    fireEvent.click(screen.getByTestId('cr-tab-runners'))
    expect(screen.getByTestId('stub-runners')).toBeTruthy()
    expect(screen.queryByTestId('stub-repos')).toBeNull()
    expect(screen.getByTestId('cr-tab-runners').getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem(KEY)).toBe('runners')
  })

  it('switches to the mission-control section when its tab is clicked, and persists it (#6183)', () => {
    render(<ControlRoomView />)
    fireEvent.click(screen.getByTestId('cr-tab-mission-control'))
    expect(screen.getByTestId('stub-mission-control')).toBeTruthy()
    expect(screen.queryByTestId('stub-repos')).toBeNull()
    expect(screen.getByTestId('cr-tab-mission-control').getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem(KEY)).toBe('mission-control')
  })

  it('exposes a tab for every CONTROL_ROOM_TABS descriptor (no deep-linkable-but-missing tab)', () => {
    // #6183 review: lightweight guard against descriptor drift — every descriptor
    // must surface a clickable tab button. (A full render-each-panel loop isn't
    // feasible here: the unmocked survey sections need store fields the minimal
    // mock omits; the per-tab routing is covered by the targeted tab tests above
    // + the mission-control test, and ControlRoomView.registry.test.ts covers the
    // derived-set consistency.)
    render(<ControlRoomView />)
    for (const t of CONTROL_ROOM_TABS) {
      expect(screen.getByTestId(`cr-tab-${t.key}`)).toBeTruthy()
    }
  })

  it('switches to the integrations section when its tab is clicked, and persists it', () => {
    render(<ControlRoomView />)
    fireEvent.click(screen.getByTestId('cr-tab-integrations'))
    expect(screen.getByTestId('stub-integrations')).toBeTruthy()
    expect(screen.queryByTestId('stub-repos')).toBeNull()
    expect(screen.queryByTestId('stub-runners')).toBeNull()
    expect(screen.getByTestId('cr-tab-integrations').getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem(KEY)).toBe('integrations')
  })

  it('restores the persisted tab on the next mount', () => {
    localStorage.setItem(KEY, 'runners')
    render(<ControlRoomView />)
    expect(screen.getByTestId('stub-runners')).toBeTruthy()
  })

  it('restores a persisted integrations tab on the next mount', () => {
    localStorage.setItem(KEY, 'integrations')
    render(<ControlRoomView />)
    expect(screen.getByTestId('stub-integrations')).toBeTruthy()
  })

  it('degrades a garbage persisted value to the default tab', () => {
    localStorage.setItem(KEY, 'bogus')
    render(<ControlRoomView />)
    expect(screen.getByTestId('stub-repos')).toBeTruthy()
  })

  it('forwards onInvestigate to the repo section', () => {
    render(<ControlRoomView onInvestigate={() => {}} />)
    expect(screen.getByTestId('stub-repos').getAttribute('data-has-investigate')).toBe('yes')
  })

  it('forwards onOpenSession to the repo section', () => {
    render(<ControlRoomView onOpenSession={() => {}} />)
    expect(screen.getByTestId('stub-repos').getAttribute('data-has-open-session')).toBe('yes')
  })

  it('honours an explicit initialTab override', () => {
    render(<ControlRoomView initialTab="runners" />)
    expect(screen.getByTestId('stub-runners')).toBeTruthy()
  })
})

describe('ControlRoomView Settings tab (#5544)', () => {
  it('renders the embedded SettingsContent when the Settings tab is clicked, as active', () => {
    render(<ControlRoomView />)
    fireEvent.click(screen.getByTestId('cr-tab-settings'))
    const settings = screen.getByTestId('stub-settings')
    expect(settings).toBeTruthy()
    expect(settings.getAttribute('data-active')).toBe('yes')
    expect(screen.queryByTestId('stub-repos')).toBeNull()
    expect(screen.getByTestId('cr-tab-settings').getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem(KEY)).toBe('settings')
  })

  it('restores a persisted settings tab on the next mount', () => {
    localStorage.setItem(KEY, 'settings')
    render(<ControlRoomView />)
    expect(screen.getByTestId('stub-settings')).toBeTruthy()
  })

  it('does NOT trigger any survey fetch when the Settings tab is the active one', () => {
    localStorage.setItem(KEY, 'settings')
    render(<ControlRoomView />)
    expect(requestHostStatusMock).not.toHaveBeenCalled()
    expect(requestRunnerStatusMock).not.toHaveBeenCalled()
    expect(requestIntegrationStatusMock).not.toHaveBeenCalled()
  })

  it('does NOT trigger a survey fetch when switching from repos to the Settings tab', () => {
    // Seed a fresh repos snapshot so the initial repos activation does not
    // itself fetch — isolating the assertion to the Settings switch.
    resetStore({ hostStatus: snapshotAt(CONTROL_ROOM_STALENESS_MS / 2) })
    render(<ControlRoomView initialTab="repos" />)
    requestHostStatusMock.mockClear()
    fireEvent.click(screen.getByTestId('cr-tab-settings'))
    expect(requestHostStatusMock).not.toHaveBeenCalled()
    expect(requestRunnerStatusMock).not.toHaveBeenCalled()
    expect(requestIntegrationStatusMock).not.toHaveBeenCalled()
  })

  it('redirects to the Settings tab when forceTabNonce bumps while mounted', () => {
    const { rerender } = render(
      <ControlRoomView forceTab="settings" forceTabNonce={0} initialTab="repos" />,
    )
    // Mount does not redirect — seeded from the incoming nonce.
    expect(screen.getByTestId('stub-repos')).toBeTruthy()
    rerender(<ControlRoomView forceTab="settings" forceTabNonce={1} initialTab="repos" />)
    expect(screen.getByTestId('stub-settings')).toBeTruthy()
    expect(screen.queryByTestId('stub-repos')).toBeNull()
  })

  it('does not redirect on mount even when an initial non-zero nonce is supplied', () => {
    // Models App reopening the CR via the sidebar after a prior gear click left
    // the nonce non-zero: the closed→open path uses initialTab, not the nonce,
    // so a stale nonce must not hijack a plain reopen.
    render(<ControlRoomView forceTab="settings" forceTabNonce={3} initialTab="runners" />)
    expect(screen.getByTestId('stub-runners')).toBeTruthy()
    expect(screen.queryByTestId('stub-settings')).toBeNull()
  })
})

describe('ControlRoomView auto-fetch on activation (#5543)', () => {
  it('fires exactly one request for the active tab on open when its snapshot is null', () => {
    render(<ControlRoomView initialTab="repos" />)
    expect(requestHostStatusMock).toHaveBeenCalledTimes(1)
    expect(requestRunnerStatusMock).not.toHaveBeenCalled()
    expect(requestIntegrationStatusMock).not.toHaveBeenCalled()
  })

  it('opens the persisted tab and fetches it (not the default repos tab)', () => {
    localStorage.setItem(KEY, 'integrations')
    render(<ControlRoomView />)
    expect(requestIntegrationStatusMock).toHaveBeenCalledTimes(1)
    expect(requestHostStatusMock).not.toHaveBeenCalled()
  })

  it('does not re-fetch a snapshot fresher than the staleness window', () => {
    resetStore({ hostStatus: snapshotAt(CONTROL_ROOM_STALENESS_MS / 2) })
    render(<ControlRoomView initialTab="repos" />)
    expect(requestHostStatusMock).not.toHaveBeenCalled()
  })

  it('re-fetches a snapshot older than the staleness window', () => {
    resetStore({ hostStatus: snapshotAt(CONTROL_ROOM_STALENESS_MS + 5_000) })
    render(<ControlRoomView initialTab="repos" />)
    expect(requestHostStatusMock).toHaveBeenCalledTimes(1)
  })

  it('treats an unparseable generatedAt as stale and fetches', () => {
    resetStore({ hostStatus: { type: 'host_status_snapshot', generatedAt: 'not-a-date', root: '/p', repos: [] } })
    render(<ControlRoomView initialTab="repos" />)
    expect(requestHostStatusMock).toHaveBeenCalledTimes(1)
  })

  it('does not fire while a request is already in flight (in-flight guard)', () => {
    resetStore({ hostStatusLoading: true })
    render(<ControlRoomView initialTab="repos" />)
    expect(requestHostStatusMock).not.toHaveBeenCalled()
  })

  it('does not fire when the WS is disconnected', () => {
    resetStore({ connectionPhase: 'disconnected' })
    render(<ControlRoomView initialTab="repos" />)
    expect(requestHostStatusMock).not.toHaveBeenCalled()
    expect(requestRunnerStatusMock).not.toHaveBeenCalled()
    expect(requestIntegrationStatusMock).not.toHaveBeenCalled()
  })

  it('fetches the newly-activated tab on a tab switch', () => {
    render(<ControlRoomView initialTab="repos" />)
    expect(requestHostStatusMock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('cr-tab-runners'))
    expect(requestRunnerStatusMock).toHaveBeenCalledTimes(1)
  })

  it('does not fetch the inactive tab on open', () => {
    render(<ControlRoomView initialTab="repos" />)
    expect(requestRunnerStatusMock).not.toHaveBeenCalled()
    expect(requestIntegrationStatusMock).not.toHaveBeenCalled()
  })
})
