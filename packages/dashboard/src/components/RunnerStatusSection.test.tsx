/**
 * RunnerStatusSection (#5253) — renderer tests.
 *
 * Covers the surface against a mocked `runner_status_snapshot`:
 *   - empty / loading / not-connected states before the first snapshot
 *   - summary chips render the per-bucket counts
 *   - one group header per project + one row per runner
 *   - verdict tag accent maps busy/idle→ok, stopped/unregistered→warn, offline→bad
 *   - service cell: running+pid / stopped+exit / no-service
 *   - GitHub cell: online/offline + busy, "—" when unknown
 *   - the Runner settings deep link renders when runnersUrl is present
 *   - Refresh dispatches the request (and is disabled while loading)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerRunnerStatusSnapshotMessage, RunnerInfo } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      runnerStatus: null,
      runnerStatusLoading: false,
      connectionPhase: 'connected',
      requestRunnerStatus: () => false,
    }),
}))
import { RunnerStatusSection } from './RunnerStatusSection'

afterEach(cleanup)

function runner(over: Partial<RunnerInfo> = {}): RunnerInfo {
  return {
    name: 'medlens-mac-arm64',
    dir: '/Users/x/github-runners/actions-runner-medlens',
    verdict: 'idle',
    service: { manager: 'launchd', label: 'actions.runner.o-r.n', running: true, pid: 1778, lastExitCode: 0 },
    githubStatus: 'online',
    busy: false,
    os: 'macOS',
    labels: ['self-hosted', 'macOS'],
    ...over,
  }
}

function snapshot(over: Partial<ServerRunnerStatusSnapshotMessage> = {}): ServerRunnerStatusSnapshotMessage {
  return {
    type: 'runner_status_snapshot',
    generatedAt: '2026-06-06T12:00:00.000Z',
    root: '/Users/x/github-runners',
    summary: { total: 3, busy: 1, idle: 1, offline: 0, stopped: 1, unregistered: 0 },
    repos: [
      {
        name: 'medlens',
        owner: 'blamechris',
        repo: 'medlens',
        githubUrl: 'https://github.com/blamechris/medlens',
        runnersUrl: 'https://github.com/blamechris/medlens/settings/actions/runners',
        runners: [runner({ name: 'medlens-mac-arm64', verdict: 'busy', busy: true })],
      },
      {
        name: 'archery-apprentice',
        owner: 'blamechris',
        repo: 'archery-apprentice',
        githubUrl: 'https://github.com/blamechris/archery-apprentice',
        runnersUrl: 'https://github.com/blamechris/archery-apprentice/settings/actions/runners',
        runners: [
          runner({ name: 'aa-1', verdict: 'idle', dir: '/d/aa-1' }),
          runner({
            name: 'aa-2',
            verdict: 'stopped',
            dir: '/d/aa-2',
            service: { manager: 'launchd', label: 'l', running: false, pid: null, lastExitCode: 1 },
            githubStatus: 'offline',
            busy: false,
          }),
        ],
      },
    ],
    ...over,
  }
}

// A one-project snapshot carrying exactly the given runners (avoids mutating
// indexed array access, which trips noUncheckedIndexedAccess).
function oneRepoSnapshot(runners: RunnerInfo[]): ServerRunnerStatusSnapshotMessage {
  return snapshot({
    repos: [
      {
        name: 'medlens',
        owner: 'blamechris',
        repo: 'medlens',
        githubUrl: 'https://github.com/blamechris/medlens',
        runnersUrl: 'https://github.com/blamechris/medlens/settings/actions/runners',
        runners,
      },
    ],
  })
}

describe('RunnerStatusSection — empty / loading / not-connected', () => {
  it('renders the empty state with a Run survey button before the first snapshot', () => {
    render(<RunnerStatusSection snapshot={null} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-empty')).toBeTruthy()
    expect(screen.getByTestId('runner-empty-refresh')).toBeTruthy()
    expect(screen.queryByTestId('runner-table')).toBeNull()
  })

  it('renders a loading state', () => {
    render(<RunnerStatusSection snapshot={null} loading={true} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-empty').textContent).toContain('Running the runner survey')
  })

  it('shows a not-connected hint and disables Run survey when disconnected', () => {
    render(<RunnerStatusSection snapshot={null} loading={false} connected={false} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-not-connected')).toBeTruthy()
    expect((screen.getByTestId('runner-empty-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('RunnerStatusSection — populated', () => {
  it('renders summary chips with the per-bucket counts', () => {
    render(<RunnerStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-chip-count-total').textContent).toBe('3')
    expect(screen.getByTestId('runner-chip-count-busy').textContent).toBe('1')
    expect(screen.getByTestId('runner-chip-count-stopped').textContent).toBe('1')
  })

  it('renders one group header per project and a row per runner', () => {
    render(<RunnerStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-repo-medlens')).toBeTruthy()
    expect(screen.getByTestId('runner-repo-archery-apprentice')).toBeTruthy()
    expect(screen.getByTestId('runner-row-medlens-mac-arm64')).toBeTruthy()
    expect(screen.getByTestId('runner-row-aa-1')).toBeTruthy()
    expect(screen.getByTestId('runner-row-aa-2')).toBeTruthy()
  })

  it('maps verdict → tag accent', () => {
    render(<RunnerStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-verdict-medlens-mac-arm64').getAttribute('data-accent')).toBe('ok') // busy
    expect(screen.getByTestId('runner-verdict-aa-1').getAttribute('data-accent')).toBe('ok') // idle
    expect(screen.getByTestId('runner-verdict-aa-2').getAttribute('data-accent')).toBe('warn') // stopped
  })

  it('offline verdict renders the bad accent', () => {
    const snap = oneRepoSnapshot([runner({ name: 'off', verdict: 'offline', githubStatus: 'offline' })])
    render(<RunnerStatusSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-verdict-off').getAttribute('data-accent')).toBe('bad')
  })

  it('service cell shows running+pid, and stopped+exit', () => {
    render(<RunnerStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-svc-aa-1').textContent).toContain('running')
    expect(screen.getByTestId('runner-svc-aa-1').textContent).toContain('1778')
    const stopped = screen.getByTestId('runner-svc-aa-2')
    expect(stopped.textContent).toContain('stopped')
    expect(stopped.textContent).toContain('exit 1')
  })

  it('service cell shows "no service" for an unregistered runner', () => {
    const snap = oneRepoSnapshot([runner({
      name: 'orphan',
      verdict: 'unregistered',
      service: { manager: 'none', label: null, running: false, pid: null, lastExitCode: null },
    })])
    render(<RunnerStatusSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-svc-orphan').textContent).toContain('no service')
  })

  it('GitHub cell shows online+busy and offline, and "—" when unknown', () => {
    const snap = oneRepoSnapshot([
      runner({ name: 'medlens-mac-arm64', githubStatus: 'online', busy: true }),
      runner({ name: 'nogh', githubStatus: null, busy: null, dir: '/d/nogh' }),
    ])
    render(<RunnerStatusSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-gh-medlens-mac-arm64').textContent).toContain('online')
    expect(screen.getByTestId('runner-gh-medlens-mac-arm64').textContent).toContain('busy')
    expect(screen.getByTestId('runner-gh-nogh').textContent).toBe('—')
  })

  it('renders a Runner settings deep link with the snapshot URL', () => {
    render(<RunnerStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    const link = screen.getByTestId('runner-settings-medlens') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://github.com/blamechris/medlens/settings/actions/runners')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('renders the no-repos row when the survey found nothing', () => {
    render(<RunnerStatusSection snapshot={snapshot({ repos: [], summary: { total: 0, busy: 0, idle: 0, offline: 0, stopped: 0, unregistered: 0 } })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('runner-no-repos')).toBeTruthy()
  })

  // #6144: a degraded survey (forbidden / failed / in-progress) carries an
  // additive `error` annotation — render it as an alert banner, not as an
  // empty survey.
  it('renders a degraded-survey error banner (role=alert)', () => {
    const snap = snapshot({ repos: [], summary: { total: 0, busy: 0, idle: 0, offline: 0, stopped: 0, unregistered: 0 }, error: { code: 'FORBIDDEN', message: 'host-level authority required' } })
    render(<RunnerStatusSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    const banner = screen.getByTestId('runner-error')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('FORBIDDEN')
    expect(banner.textContent).toContain('host-level authority required')
  })
})

describe('RunnerStatusSection — refresh', () => {
  it('dispatches onRefresh when Refresh is clicked', () => {
    const onRefresh = vi.fn()
    render(<RunnerStatusSection snapshot={snapshot()} loading={false} connected={true} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('runner-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disables Refresh while loading and does not dispatch', () => {
    const onRefresh = vi.fn()
    render(<RunnerStatusSection snapshot={snapshot()} loading={true} connected={true} onRefresh={onRefresh} />)
    const btn = screen.getByTestId('runner-refresh') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
