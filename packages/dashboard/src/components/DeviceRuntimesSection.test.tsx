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
      // #6137: the Android emulator panel reads these (rendered by DeviceRuntimesSection).
      emulatorStatus: null,
      emulatorStatusLoading: false,
      requestEmulatorStatus: () => false,
      emulatorActioningIds: new Set<string>(),
      emulatorActionResults: {},
      sendEmulatorAction: () => false,
      // #6138: the WSL panel reads these (rendered by DeviceRuntimesSection).
      wslStatus: null,
      wslStatusLoading: false,
      requestWslStatus: () => false,
      wslActioningIds: new Set<string>(),
      wslActionResults: {},
      sendWslAction: () => false,
    }),
}))
import { DeviceRuntimesSection, AndroidEmulatorPanel, WslPanel } from './DeviceRuntimesSection'
import type { ServerEmulatorStatusSnapshotMessage, ServerWslStatusSnapshotMessage } from '@chroxy/protocol'

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

  it('disables the actioning row per-udid, leaving other rows enabled', () => {
    // The server allows concurrent actions on distinct udids (cap 2), so only
    // the in-flight device's button disables — other rows stay actionable.
    render(<DeviceRuntimesSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set(['U-BOOTED1'])} actionResults={{}} />)
    expect((screen.getByTestId('simulator-shutdown-U-BOOTED1') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('simulator-pending-U-BOOTED1')).toBeTruthy()
    expect((screen.getByTestId('simulator-boot-U-SHUT0001') as HTMLButtonElement).disabled).toBe(false)
  })

  it('surfaces deviceType when it differs from the device name', () => {
    render(
      <DeviceRuntimesSection
        snapshot={snapshot({ devices: [{ udid: 'U-RENAMED1', name: 'My Test Phone', state: 'Shutdown', runtime: 'iOS 26.1', deviceType: 'iPhone 15', isAvailable: true }] })}
        loading={false} connected={true} onRefresh={() => {}}
      />,
    )
    expect(screen.getByTestId('simulator-devicetype-U-RENAMED1').textContent).toBe('iPhone 15')
  })

  it('shows a settled note after an action resolves', () => {
    render(<DeviceRuntimesSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set<string>()} actionResults={{ 'U-SHUT0001': { action: 'boot', note: 'Booted', error: null, at: 1 } }} />)
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

function emuSnapshot(over: Partial<ServerEmulatorStatusSnapshotMessage> = {}): ServerEmulatorStatusSnapshotMessage {
  return {
    type: 'emulator_status_snapshot',
    generatedAt: '2026-06-20T12:00:00.000Z',
    available: true,
    note: null,
    devices: [
      { avd: 'Pixel_7_API_34', serial: 'emulator-5554', state: 'running' },
      { avd: 'Pixel_5_API_33', serial: null, state: 'stopped' },
    ],
    readyForMaestro: { ready: true, runningDevice: 'Pixel_7_API_34', metroReachable: true, mockServerReachable: true, reasons: [] },
    ...over,
  } as ServerEmulatorStatusSnapshotMessage
}

describe('AndroidEmulatorPanel (#6137)', () => {
  it('renders the empty state with a Run-survey button when no snapshot', () => {
    render(<AndroidEmulatorPanel snapshot={null} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('emulator-empty')).toBeTruthy()
    expect(screen.queryByTestId('emulator-table')).toBeNull()
  })

  it('renders the unavailable note (no SDK) and no verdict/table', () => {
    render(
      <AndroidEmulatorPanel
        snapshot={emuSnapshot({ available: false, note: 'not available on this host', devices: [], readyForMaestro: { ready: false, runningDevice: null, metroReachable: false, mockServerReachable: false, reasons: [] } })}
        loading={false} connected={true} onRefresh={() => {}}
      />,
    )
    expect(screen.getByTestId('emulator-unavailable').textContent).toContain('not available')
    expect(screen.queryByTestId('emulator-verdict')).toBeNull()
  })

  it('renders the ready verdict and a state-aware Kill (running) + Boot (stopped) buttons', () => {
    render(<AndroidEmulatorPanel snapshot={emuSnapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('emulator-verdict').getAttribute('data-ready')).toBe('true')
    expect(screen.getByTestId('emulator-kill-emulator-5554')).toBeTruthy()
    expect(screen.getByTestId('emulator-boot-Pixel_5_API_33')).toBeTruthy()
  })

  it('renders the not-ready verdict with reasons', () => {
    render(
      <AndroidEmulatorPanel
        snapshot={emuSnapshot({ devices: [{ avd: 'Pixel_5_API_33', serial: null, state: 'stopped' }], readyForMaestro: { ready: false, runningDevice: null, metroReachable: false, mockServerReachable: true, reasons: ['No running emulator', 'Metro not reachable on :8081'] } })}
        loading={false} connected={true} onRefresh={() => {}}
      />,
    )
    expect(screen.getByTestId('emulator-verdict').getAttribute('data-ready')).toBe('false')
    expect(screen.getByTestId('emulator-verdict-reasons').textContent).toContain('No running emulator')
  })

  it('boot routes to onAction(boot, {avd}); kill routes to onAction(kill, {serial})', () => {
    const onAction = vi.fn()
    render(<AndroidEmulatorPanel snapshot={emuSnapshot()} loading={false} connected={true} onRefresh={() => {}} onAction={onAction} />)
    fireEvent.click(screen.getByTestId('emulator-boot-Pixel_5_API_33'))
    expect(onAction).toHaveBeenCalledWith('boot', { avd: 'Pixel_5_API_33' })
    fireEvent.click(screen.getByTestId('emulator-kill-emulator-5554'))
    expect(onAction).toHaveBeenCalledWith('kill', { serial: 'emulator-5554' })
  })

  it('a starting emulator shows a Kill button (live) with the warn state tag', () => {
    render(<AndroidEmulatorPanel snapshot={emuSnapshot({ devices: [{ avd: 'Pixel_7_API_34', serial: 'emulator-5554', state: 'starting' }], readyForMaestro: { ready: false, runningDevice: null, metroReachable: true, mockServerReachable: true, reasons: ['No running emulator'] } })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('emulator-state-emulator-5554').textContent).toBe('starting')
    expect(screen.getByTestId('emulator-kill-emulator-5554')).toBeTruthy()
  })

  it('disables the actioning row per-target, leaving others enabled', () => {
    render(<AndroidEmulatorPanel snapshot={emuSnapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set(['emulator-5554'])} actionResults={{}} />)
    expect((screen.getByTestId('emulator-kill-emulator-5554') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('emulator-pending-emulator-5554')).toBeTruthy()
    expect((screen.getByTestId('emulator-boot-Pixel_5_API_33') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a settled note after an action resolves', () => {
    render(<AndroidEmulatorPanel snapshot={emuSnapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set<string>()} actionResults={{ 'Pixel_5_API_33': { action: 'boot', note: 'Starting…', error: null, at: 1 } }} />)
    expect(screen.getByTestId('emulator-ok-Pixel_5_API_33').textContent).toContain('Starting')
  })

  it('Refresh dispatches and is disabled while loading', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(<AndroidEmulatorPanel snapshot={emuSnapshot()} loading={false} connected={true} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('emulator-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(<AndroidEmulatorPanel snapshot={emuSnapshot()} loading={true} connected={true} onRefresh={onRefresh} />)
    expect((screen.getByTestId('emulator-refresh') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders a no-devices note when no AVDs are installed', () => {
    render(<AndroidEmulatorPanel snapshot={emuSnapshot({ devices: [], readyForMaestro: { ready: false, runningDevice: null, metroReachable: true, mockServerReachable: true, reasons: ['No running emulator'] } })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('emulator-no-devices')).toBeTruthy()
    expect(screen.queryByTestId('emulator-table')).toBeNull()
  })

  it('a live device with no serial renders safely with a disabled Kill (nothing to kill)', () => {
    // Schema-permitted edge: a just-starting emulator the survey hasn't assigned
    // a serial to yet. The row keys off the avd fallback and the Kill button
    // disables (no serial → no kill target) instead of breaking.
    render(<AndroidEmulatorPanel snapshot={emuSnapshot({ devices: [{ avd: 'Pixel_7_API_34', serial: null, state: 'starting' }], readyForMaestro: { ready: false, runningDevice: null, metroReachable: true, mockServerReachable: true, reasons: ['No running emulator'] } })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('emulator-row-Pixel_7_API_34')).toBeTruthy()
    expect((screen.getByTestId('emulator-kill-Pixel_7_API_34') as HTMLButtonElement).disabled).toBe(true)
  })
})

function wslSnapshot(over: Partial<ServerWslStatusSnapshotMessage> = {}): ServerWslStatusSnapshotMessage {
  return {
    type: 'wsl_status_snapshot',
    generatedAt: '2026-06-20T12:00:00.000Z',
    available: true,
    note: null,
    defaultDistro: 'Ubuntu',
    distros: [
      { name: 'Ubuntu', state: 'Running', version: 2, isDefault: true },
      { name: 'Debian', state: 'Stopped', version: 2, isDefault: false },
    ],
    ...over,
  } as ServerWslStatusSnapshotMessage
}

describe('WslPanel (#6138)', () => {
  it('renders the empty state with a Run-survey button when no snapshot', () => {
    render(<WslPanel snapshot={null} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('wsl-empty')).toBeTruthy()
    expect(screen.queryByTestId('wsl-table')).toBeNull()
  })

  it('renders the unavailable note (off Windows) and no table', () => {
    render(
      <WslPanel
        snapshot={wslSnapshot({ available: false, note: 'WSL is only available on Windows hosts.', defaultDistro: null, distros: [] })}
        loading={false} connected={true} onRefresh={() => {}}
      />,
    )
    expect(screen.getByTestId('wsl-unavailable').textContent).toContain('Windows')
    expect(screen.queryByTestId('wsl-table')).toBeNull()
  })

  it('renders state-aware Terminate (Running) + Start (Stopped) buttons and the default marker', () => {
    render(<WslPanel snapshot={wslSnapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('wsl-terminate-Ubuntu')).toBeTruthy()
    expect(screen.getByTestId('wsl-start-Debian')).toBeTruthy()
    expect(screen.getByTestId('wsl-default-Ubuntu')).toBeTruthy()
    expect(screen.queryByTestId('wsl-default-Debian')).toBeNull()
    expect(screen.getByTestId('wsl-version-Ubuntu').textContent).toContain('WSL 2')
  })

  it('start routes to onAction(start, name); terminate routes to onAction(terminate, name)', () => {
    const onAction = vi.fn()
    render(<WslPanel snapshot={wslSnapshot()} loading={false} connected={true} onRefresh={() => {}} onAction={onAction} />)
    fireEvent.click(screen.getByTestId('wsl-start-Debian'))
    expect(onAction).toHaveBeenCalledWith('start', 'Debian')
    fireEvent.click(screen.getByTestId('wsl-terminate-Ubuntu'))
    expect(onAction).toHaveBeenCalledWith('terminate', 'Ubuntu')
  })

  it('a transitional-state distro (Installing) shows a disabled Start (cannot start non-Stopped)', () => {
    render(<WslPanel snapshot={wslSnapshot({ distros: [{ name: 'Ubuntu', state: 'Installing', version: 2, isDefault: true }] })} loading={false} connected={true} onRefresh={() => {}} />)
    expect((screen.getByTestId('wsl-start-Ubuntu') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('wsl-state-Ubuntu').textContent).toBe('Installing')
  })

  it('disables the actioning row per-target, leaving others enabled', () => {
    render(<WslPanel snapshot={wslSnapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set(['Ubuntu'])} actionResults={{}} />)
    expect((screen.getByTestId('wsl-terminate-Ubuntu') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('wsl-pending-Ubuntu')).toBeTruthy()
    expect((screen.getByTestId('wsl-start-Debian') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a settled note after an action resolves', () => {
    render(<WslPanel snapshot={wslSnapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set<string>()} actionResults={{ Ubuntu: { action: 'terminate', note: 'Terminated', error: null, at: 1 } }} />)
    expect(screen.getByTestId('wsl-ok-Ubuntu').textContent).toContain('Terminated')
  })

  it('shows an error note after a failed action', () => {
    render(<WslPanel snapshot={wslSnapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set<string>()} actionResults={{ Debian: { action: 'start', note: null, error: 'wsl.exe ENOENT', at: 1 } }} />)
    expect(screen.getByTestId('wsl-error-Debian').textContent).toContain('ENOENT')
  })

  it('Refresh dispatches and is disabled while loading', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(<WslPanel snapshot={wslSnapshot()} loading={false} connected={true} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('wsl-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(<WslPanel snapshot={wslSnapshot()} loading={true} connected={true} onRefresh={onRefresh} />)
    expect((screen.getByTestId('wsl-refresh') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders a no-distros note when none are installed', () => {
    render(<WslPanel snapshot={wslSnapshot({ defaultDistro: null, distros: [] })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('wsl-no-distros')).toBeTruthy()
    expect(screen.queryByTestId('wsl-table')).toBeNull()
  })

  it('renders a null version as an em dash', () => {
    render(<WslPanel snapshot={wslSnapshot({ distros: [{ name: 'Ubuntu', state: 'Stopped', version: null, isDefault: true }] })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('wsl-version-Ubuntu').textContent).toBe('—')
  })
})
