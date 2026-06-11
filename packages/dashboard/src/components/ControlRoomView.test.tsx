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

import { ControlRoomView, CONTROL_ROOM_STALENESS_MS } from './ControlRoomView'

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
    expect(screen.getByTestId('stub-repos')).toBeTruthy()
    expect(screen.queryByTestId('stub-runners')).toBeNull()
    expect(screen.queryByTestId('stub-integrations')).toBeNull()
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
