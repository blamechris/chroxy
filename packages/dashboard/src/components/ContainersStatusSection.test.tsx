/**
 * ContainersStatusSection (#6133, epic #5530) — renderer tests.
 *
 * Covers the surface against a mocked `containers_status_snapshot`:
 *   - empty / loading / not-connected states before the first snapshot
 *   - summary chips render the per-bucket counts
 *   - one group header per cwd + one row per container
 *   - status tag accent maps running→ok, stopped→warn, error→bad, other→neutral
 *   - stats cell renders cpu/mem or "—" when stats are null
 *   - the docker-stats degradation note renders when present
 *   - Refresh dispatches the request (and is disabled while loading)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerContainersStatusSnapshotMessage } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      containersStatus: null,
      containersStatusLoading: false,
      connectionPhase: 'connected',
      requestContainersStatus: () => false,
      containerActioningIds: new Set<string>(),
      containerActionResults: {},
      sendContainersAction: () => false,
    }),
}))
import { ContainersStatusSection } from './ContainersStatusSection'

afterEach(cleanup)

type ContainerEntry = ServerContainersStatusSnapshotMessage['containers'][number]

function container(over: Partial<ContainerEntry> = {}): ContainerEntry {
  return {
    id: 'env-1',
    name: 'web',
    cwd: '/Users/me/Projects/app',
    image: 'node:22-slim',
    status: 'running',
    backend: 'docker',
    containerId: 'abcdef123456789',
    composeProject: null,
    sessionCount: 2,
    createdAt: '2026-06-19T11:00:00.000Z',
    uptimeMs: 3000000,
    stats: { cpuPercent: 0.5, memBytes: 47400000, memPercent: 2.26 },
    ...over,
  }
}

function snapshot(over: Partial<ServerContainersStatusSnapshotMessage> = {}): ServerContainersStatusSnapshotMessage {
  return {
    type: 'containers_status_snapshot',
    generatedAt: '2026-06-19T12:00:00.000Z',
    summary: { total: 3, running: 2, stopped: 1, other: 0 },
    containers: [
      container({ id: 'env-1', name: 'web', cwd: '/Users/me/Projects/app', status: 'running' }),
      container({ id: 'env-2', name: 'worker', cwd: '/Users/me/Projects/app', status: 'running' }),
      container({
        id: 'env-3',
        name: 'api',
        cwd: '/Users/me/Projects/other',
        status: 'stopped',
        backend: 'compose',
        containerId: null,
        composeProject: 'chroxy-env-3',
        sessionCount: 0,
        uptimeMs: null,
        stats: null,
      }),
    ],
    dockerStatsNote: null,
    ...over,
  }
}

describe('ContainersStatusSection — empty / loading / not-connected', () => {
  it('renders the empty state with a Run survey button before the first snapshot', () => {
    render(<ContainersStatusSection snapshot={null} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('containers-empty')).toBeTruthy()
    expect(screen.getByTestId('containers-empty-refresh')).toBeTruthy()
    expect(screen.queryByTestId('containers-table')).toBeNull()
  })

  it('renders a loading state', () => {
    render(<ContainersStatusSection snapshot={null} loading={true} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('containers-empty').textContent).toContain('Running the containers survey')
  })

  it('shows a not-connected hint and disables Run survey when disconnected', () => {
    render(<ContainersStatusSection snapshot={null} loading={false} connected={false} onRefresh={() => {}} />)
    expect(screen.getByTestId('containers-not-connected')).toBeTruthy()
    expect((screen.getByTestId('containers-empty-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ContainersStatusSection — populated', () => {
  it('renders summary chips with the per-bucket counts', () => {
    render(<ContainersStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('containers-chip-count-total').textContent).toBe('3')
    expect(screen.getByTestId('containers-chip-count-running').textContent).toBe('2')
    expect(screen.getByTestId('containers-chip-count-stopped').textContent).toBe('1')
  })

  it('groups containers by cwd (one header per workdir) and a row per container', () => {
    render(<ContainersStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('container-cwd-/Users/me/Projects/app')).toBeTruthy()
    expect(screen.getByTestId('container-cwd-/Users/me/Projects/other')).toBeTruthy()
    expect(screen.getByTestId('container-row-env-1')).toBeTruthy()
    expect(screen.getByTestId('container-row-env-2')).toBeTruthy()
    expect(screen.getByTestId('container-row-env-3')).toBeTruthy()
  })

  it('maps status → tag accent', () => {
    render(<ContainersStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('container-status-env-1').getAttribute('data-accent')).toBe('ok') // running
    expect(screen.getByTestId('container-status-env-3').getAttribute('data-accent')).toBe('warn') // stopped
  })

  it('error status renders the bad accent; an unknown status is neutral', () => {
    const snap = snapshot({
      summary: { total: 2, running: 0, stopped: 0, other: 2 },
      containers: [
        container({ id: 'e-err', status: 'error', cwd: '/c' }),
        container({ id: 'e-weird', status: 'provisioning', cwd: '/c' }),
      ],
    })
    render(<ContainersStatusSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('container-status-e-err').getAttribute('data-accent')).toBe('bad')
    expect(screen.getByTestId('container-status-e-weird').getAttribute('data-accent')).toBe('neutral')
  })

  it('stats cell shows cpu/mem when present and "—" when null', () => {
    render(<ContainersStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    const running = screen.getByTestId('container-stats-env-1')
    expect(running.textContent).toContain('0.5% cpu')
    expect(running.textContent).toContain('MiB')
    expect(screen.getByTestId('container-stats-env-3').textContent).toBe('—')
  })

  it('stats cell shows "—" when stats is present but every field is null', () => {
    const snap = snapshot({
      summary: { total: 1, running: 1, stopped: 0, other: 0 },
      containers: [container({ id: 'e-null', stats: { cpuPercent: null, memBytes: null, memPercent: null } })],
    })
    render(<ContainersStatusSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('container-stats-e-null').textContent).toBe('—')
  })

  it('surfaces a degraded-survey error banner instead of looking like an empty survey', () => {
    const snap = snapshot({
      summary: { total: 0, running: 0, stopped: 0, other: 0 },
      containers: [],
      error: { code: 'SURVEY_FAILED', message: 'docker daemon unreachable' },
    })
    render(<ContainersStatusSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    const banner = screen.getByTestId('containers-error')
    expect(banner.textContent).toContain('SURVEY_FAILED')
    expect(banner.textContent).toContain('docker daemon unreachable')
  })

  it('renders the docker-stats degradation note when present', () => {
    render(<ContainersStatusSection snapshot={snapshot({ dockerStatsNote: 'docker stats unavailable: docker not found' })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('containers-stats-note').textContent).toContain('docker stats unavailable')
  })

  it('renders the no-containers row when the survey found nothing', () => {
    render(<ContainersStatusSection snapshot={snapshot({ containers: [], summary: { total: 0, running: 0, stopped: 0, other: 0 } })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('containers-none')).toBeTruthy()
  })
})

describe('ContainersStatusSection — refresh', () => {
  it('dispatches onRefresh when Refresh is clicked', () => {
    const onRefresh = vi.fn()
    render(<ContainersStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('containers-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disables Refresh while loading and does not dispatch', () => {
    const onRefresh = vi.fn()
    render(<ContainersStatusSection snapshot={snapshot()} loading={true} connected={true} onRefresh={onRefresh} />)
    const btn = screen.getByTestId('containers-refresh') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onRefresh).not.toHaveBeenCalled()
  })
})

describe('ContainersStatusSection — lifecycle actions (#6134)', () => {
  function renderWith(over: Partial<Parameters<typeof ContainersStatusSection>[0]> = {}) {
    const onAction = vi.fn()
    render(
      <ContainersStatusSection
        snapshot={snapshot()}
        loading={false}
        connected={true}
        onRefresh={() => {}}
        actioningIds={new Set()}
        actionResults={{}}
        onAction={onAction}
        {...over}
      />,
    )
    return onAction
  }

  it('Stop/Restart/Destroy render for a single-container docker env', () => {
    renderWith()
    expect(screen.getByTestId('container-stop-env-1')).toBeTruthy()
    expect(screen.getByTestId('container-restart-env-1')).toBeTruthy()
    expect(screen.getByTestId('container-destroy-env-1')).toBeTruthy()
  })

  it('hides Stop/Restart for a compose env (only Destroy remains)', () => {
    renderWith()
    // env-3 is the compose env (containerId null, composeProject set).
    expect(screen.queryByTestId('container-stop-env-3')).toBeNull()
    expect(screen.queryByTestId('container-restart-env-3')).toBeNull()
    expect(screen.getByTestId('container-destroy-env-3')).toBeTruthy()
  })

  it('Stop dispatches immediately (no confirmation); Restart too', () => {
    const onAction = renderWith()
    fireEvent.click(screen.getByTestId('container-stop-env-1'))
    expect(onAction).toHaveBeenCalledWith('env-1', 'stop')
    fireEvent.click(screen.getByTestId('container-restart-env-1'))
    expect(onAction).toHaveBeenCalledWith('env-1', 'restart')
  })

  it('Destroy opens a confirmation dialog and only dispatches on confirm', () => {
    const onAction = renderWith()
    fireEvent.click(screen.getByTestId('container-destroy-env-1'))
    // Dialog is shown; nothing dispatched yet.
    expect(screen.getByTestId('confirm-dialog')).toBeTruthy()
    expect(onAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    expect(onAction).toHaveBeenCalledWith('env-1', 'destroy')
  })

  it('Destroy cancel closes the dialog without dispatching', () => {
    const onAction = renderWith()
    fireEvent.click(screen.getByTestId('container-destroy-env-1'))
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('Stop is disabled for a non-running container', () => {
    const snap = snapshot({
      summary: { total: 1, running: 0, stopped: 1, other: 0 },
      containers: [container({ id: 'env-x', status: 'stopped' })],
    })
    renderWith({ snapshot: snap })
    expect((screen.getByTestId('container-stop-env-x') as HTMLButtonElement).disabled).toBe(true)
    // Restart and Destroy stay enabled (restart a stopped container is valid).
    expect((screen.getByTestId('container-restart-env-x') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('container-destroy-env-x') as HTMLButtonElement).disabled).toBe(false)
  })

  it('an in-flight env disables all its buttons and shows Working…', () => {
    renderWith({ actioningIds: new Set(['env-1']) })
    expect((screen.getByTestId('container-stop-env-1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('container-restart-env-1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('container-destroy-env-1') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('container-action-pending-env-1').textContent).toContain('Working')
  })

  it('disconnected disables every action button', () => {
    renderWith({ connected: false })
    expect((screen.getByTestId('container-stop-env-1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('container-destroy-env-1') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders a settled success outcome inline', () => {
    renderWith({ actionResults: { 'env-1': { action: 'stop', status: 'stopped', error: null, at: 1 } } })
    expect(screen.getByTestId('container-action-ok-env-1').textContent).toContain('stopped')
  })

  it('renders a settled failure outcome inline (role=alert)', () => {
    renderWith({ actionResults: { 'env-1': { action: 'stop', status: null, error: 'docker stop failed', at: 1 } } })
    const err = screen.getByTestId('container-action-error-env-1')
    expect(err.textContent).toContain('docker stop failed')
    expect(err.getAttribute('role')).toBe('alert')
  })
})
