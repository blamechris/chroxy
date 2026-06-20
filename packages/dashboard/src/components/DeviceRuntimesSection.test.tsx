/**
 * DeviceRuntimesSection (#6136, epic #5530) — renderer tests.
 *
 * Covers the surface against a mocked `simulator_status_snapshot`:
 *   - empty / loading / not-connected states before the first snapshot
 *   - off-macOS (available:false) note (no verdict/table)
 *   - the "Ready for Maestro" verdict (ready + not-ready with reasons)
 *   - device table with boot/shutdown buttons keyed to device state
 *   - boot/shutdown route to onAction (non-destructive — no confirm)
 *   - buttons disable while any action is in flight
 *   - pending → settled note; Refresh dispatch + disabled-while-loading
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerSimulatorStatusSnapshotMessage } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      simulatorStatus: null,
      simulatorStatusLoading: false,
      connectionPhase: 'connected',
      requestSimulatorStatus: () => false,
      simulatorActioningIds: new Set<string>(),
      simulatorActionResults: {},
      sendSimulatorAction: () => false,
    }),
}))
import { DeviceRuntimesSection } from './DeviceRuntimesSection'

afterEach(cleanup)

function snapshot(over: Partial<ServerSimulatorStatusSnapshotMessage> = {}): ServerSimulatorStatusSnapshotMessage {
  return {
    type: 'simulator_status_snapshot',
    generatedAt: '2026-06-20T12:00:00.000Z',
    available: true,
    note: null,
    devices: [
      { udid: 'U-BOOTED1', name: 'iPhone 16 Pro', state: 'Booted', runtime: 'iOS 26.1', deviceType: 'iPhone 16 Pro', isAvailable: true },
      { udid: 'U-SHUT0001', name: 'iPhone 15', state: 'Shutdown', runtime: 'iOS 26.1', deviceType: 'iPhone 15', isAvailable: true },
    ],
    readyForMaestro: { ready: true, bootedSimulator: 'iPhone 16 Pro', metroReachable: true, mockServerReachable: true, reasons: [] },
    ...over,
  } as ServerSimulatorStatusSnapshotMessage
}

describe('DeviceRuntimesSection — empty / loading / not-connected', () => {
  it('renders the empty state with a Run-survey button when no snapshot', () => {
    render(<DeviceRuntimesSection snapshot={null} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('device-runtimes-empty')).toBeTruthy()
    expect(screen.queryByTestId('device-runtimes-table')).toBeNull()
  })

  it('disables the run button when not connected', () => {
    render(<DeviceRuntimesSection snapshot={null} loading={false} connected={false} onRefresh={() => {}} />)
    expect((screen.getByTestId('device-runtimes-empty-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('DeviceRuntimesSection — unavailable (off macOS)', () => {
  it('renders the unavailable note and no verdict/table', () => {
    render(
      <DeviceRuntimesSection
        snapshot={snapshot({ available: false, note: 'not available on this host', devices: [], readyForMaestro: { ready: false, bootedSimulator: null, metroReachable: false, mockServerReachable: false, reasons: [] } })}
        loading={false}
        connected={true}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByTestId('device-runtimes-unavailable').textContent).toContain('not available')
    expect(screen.queryByTestId('device-runtimes-verdict')).toBeNull()
    expect(screen.queryByTestId('device-runtimes-table')).toBeNull()
  })
})

describe('DeviceRuntimesSection — Ready for Maestro verdict', () => {
  it('renders the ready verdict when all conditions pass', () => {
    render(<DeviceRuntimesSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    const verdict = screen.getByTestId('device-runtimes-verdict')
    expect(verdict.getAttribute('data-ready')).toBe('true')
    expect(screen.getByTestId('device-runtimes-verdict-ready').textContent).toContain('Ready for Maestro')
  })

  it('renders the not-ready verdict with reasons', () => {
    render(
      <DeviceRuntimesSection
        snapshot={snapshot({ readyForMaestro: { ready: false, bootedSimulator: null, metroReachable: false, mockServerReachable: true, reasons: ['No booted simulator', 'Metro not reachable on :8081'] } })}
        loading={false}
        connected={true}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByTestId('device-runtimes-verdict').getAttribute('data-ready')).toBe('false')
    expect(screen.getByTestId('device-runtimes-verdict-reasons').textContent).toContain('No booted simulator')
  })
})

describe('DeviceRuntimesSection — device table + actions', () => {
  it('renders a Shut down button for booted and a Boot button for shutdown devices', () => {
    render(<DeviceRuntimesSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('simulator-shutdown-U-BOOTED1')).toBeTruthy()
    expect(screen.getByTestId('simulator-boot-U-SHUT0001')).toBeTruthy()
  })

  it('boot routes to onAction with (boot, udid) — no confirm gate', () => {
    const onAction = vi.fn()
    render(<DeviceRuntimesSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} onAction={onAction} />)
    fireEvent.click(screen.getByTestId('simulator-boot-U-SHUT0001'))
    expect(onAction).toHaveBeenCalledWith('boot', 'U-SHUT0001')
  })

  it('shutdown routes to onAction with (shutdown, udid)', () => {
    const onAction = vi.fn()
    render(<DeviceRuntimesSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} onAction={onAction} />)
    fireEvent.click(screen.getByTestId('simulator-shutdown-U-BOOTED1'))
    expect(onAction).toHaveBeenCalledWith('shutdown', 'U-BOOTED1')
  })

  it('disables every action button while any action is in flight', () => {
    render(<DeviceRuntimesSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set(['U-BOOTED1'])} actionResults={{}} />)
    expect((screen.getByTestId('simulator-boot-U-SHUT0001') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('simulator-pending-U-BOOTED1')).toBeTruthy()
  })

  it('shows a settled note after an action resolves', () => {
    render(<DeviceRuntimesSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set<string>()} actionResults={{ 'U-SHUT0001': { action: 'boot', note: 'Booted (Booted)', error: null, at: 1 } }} />)
    expect(screen.getByTestId('simulator-ok-U-SHUT0001').textContent).toContain('Booted')
  })

  it('renders a no-devices note when the host has none installed', () => {
    render(<DeviceRuntimesSection snapshot={snapshot({ devices: [], readyForMaestro: { ready: false, bootedSimulator: null, metroReachable: true, mockServerReachable: true, reasons: ['No booted simulator'] } })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('device-runtimes-no-devices')).toBeTruthy()
    expect(screen.queryByTestId('device-runtimes-table')).toBeNull()
  })
})

describe('DeviceRuntimesSection — refresh', () => {
  it('Refresh dispatches and is disabled while loading', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(<DeviceRuntimesSection snapshot={snapshot()} loading={false} connected={true} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('device-runtimes-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(<DeviceRuntimesSection snapshot={snapshot()} loading={true} connected={true} onRefresh={onRefresh} />)
    expect((screen.getByTestId('device-runtimes-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})
