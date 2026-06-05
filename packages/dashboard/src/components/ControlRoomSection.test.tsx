/**
 * ControlRoomSection (#5175, epic #5170) — renderer tests.
 *
 * Covers the brief's surface against a mocked `host_status_snapshot`:
 *   - summary chips render the per-verdict counts with the right dot accent
 *   - the "how to read the verdict" callout renders
 *   - the table renders one row per repo with a colour-coded verdict tag
 *   - the `↳` note sub-row renders under a repo that has a note (and is absent
 *     when it doesn't)
 *   - the live green dot renders only for repos with `live: true`
 *   - alarmingly-high worktree / PR counts render in the "bad" colour
 *   - the Refresh button dispatches the request
 *   - the empty / loading state renders before the first snapshot
 *
 * The "generated Nm ago" formatter is unit-tested directly (no DOM needed).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerHostStatusSnapshotMessage } from '@chroxy/protocol'

// The component reads the store as a fallback when props are omitted; these
// render tests always pass explicit props, so the store-selector path only
// needs to return harmless defaults. Mock it (the established pattern from
// ActivityIndicator.*.test.tsx) so the real zustand hook isn't invoked under
// jsdom — invoking it directly trips a null-React-internals error.
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      hostStatus: null,
      hostStatusLoading: false,
      connectionPhase: 'connected',
      requestHostStatus: () => false,
    }),
}))
import {
  ControlRoomSection,
  formatGeneratedAgo,
  HIGH_COUNT_THRESHOLD,
} from './ControlRoomSection'

afterEach(() => cleanup())

const NOW = Date.parse('2026-06-04T12:00:00.000Z')

function makeSnapshot(over: Partial<ServerHostStatusSnapshotMessage> = {}): ServerHostStatusSnapshotMessage {
  return {
    type: 'host_status_snapshot',
    generatedAt: '2026-06-04T11:50:00.000Z',
    root: '/Users/me/Projects',
    summary: { live: 3, onboarded: 5, abandoned: 5, investigate: 2, recent: 2 },
    repos: [
      {
        name: 'chroxy',
        path: '/Users/me/Projects/chroxy',
        branch: 'main',
        verdict: 'live',
        live: true,
        tree: { state: 'clean', untracked: 0, modified: 0, staged: 0 },
        worktrees: 1,
        openPRs: null,
        attribution: null,
        onboarding: 'deferred (live)',
        lastTouched: '2026-06-04T11:47:00.000Z',
        note: 'Active Claude Code agent here right now — do not touch.',
      },
      {
        name: 'medlens',
        path: '/Users/me/Projects/medlens',
        branch: 'docs/app-store-prep',
        verdict: 'investigate',
        live: false,
        tree: { state: 'dirty', untracked: 2, modified: 0, staged: 0 },
        worktrees: 172,
        openPRs: 16,
        attribution: null,
        onboarding: 'skipped — dirty tree',
        lastTouched: '2026-05-28T11:00:00.000Z',
        note: '172 worktrees — likely a leak/runaway.',
      },
      {
        name: 'no-it-all',
        path: '/Users/me/Projects/no-it-all',
        branch: 'main',
        verdict: 'onboarded',
        live: false,
        tree: { state: 'clean', untracked: 0, modified: 0, staged: 0 },
        worktrees: 0,
        openPRs: 1,
        attribution: true,
        onboarding: '✓ onboarded',
        lastTouched: '2026-06-04T11:12:00.000Z',
        // no note → no ↳ row
      },
    ],
    ...over,
  }
}

describe('ControlRoomSection (#5175)', () => {
  it('renders summary chips with per-verdict counts and dot accents', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-chip-count-live')).toHaveTextContent('3')
    expect(screen.getByTestId('cr-chip-count-onboarded')).toHaveTextContent('5')
    expect(screen.getByTestId('cr-chip-count-abandoned')).toHaveTextContent('5')
    expect(screen.getByTestId('cr-chip-count-investigate')).toHaveTextContent('2')
    expect(screen.getByTestId('cr-chip-count-recent')).toHaveTextContent('2')

    // The live chip dot is the "bad" accent; onboarded is "ok".
    expect(screen.getByTestId('cr-chip-live').querySelector('.cr-dot-bad')).toBeTruthy()
    expect(screen.getByTestId('cr-chip-onboarded').querySelector('.cr-dot-ok')).toBeTruthy()
  })

  it('renders the "how to read the verdict" callout', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-callout')).toHaveTextContent('How to read the verdict')
  })

  it('renders one row per repo with a colour-coded verdict tag', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-row-chroxy')).toBeTruthy()
    expect(screen.getByTestId('cr-row-medlens')).toBeTruthy()
    expect(screen.getByTestId('cr-row-no-it-all')).toBeTruthy()

    // LIVE → bad accent; investigate → warn; onboarded → ok.
    expect(screen.getByTestId('cr-verdict-live').getAttribute('data-accent')).toBe('bad')
    expect(screen.getByTestId('cr-verdict-live')).toHaveTextContent('LIVE')
    expect(screen.getByTestId('cr-verdict-investigate').getAttribute('data-accent')).toBe('warn')
    expect(screen.getByTestId('cr-verdict-onboarded').getAttribute('data-accent')).toBe('ok')
  })

  it('renders the ↳ note sub-row only for repos with a note', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-note-row-chroxy')).toHaveTextContent('do not touch')
    expect(screen.getByTestId('cr-note-row-medlens')).toHaveTextContent('leak/runaway')
    // no-it-all has no note → no sub-row.
    expect(screen.queryByTestId('cr-note-row-no-it-all')).toBeNull()
  })

  it('shows the live green dot only for live repos', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-live-dot-chroxy')).toBeTruthy()
    expect(screen.queryByTestId('cr-live-dot-medlens')).toBeNull()
    expect(screen.queryByTestId('cr-live-dot-no-it-all')).toBeNull()
  })

  it('renders alarmingly-high worktree / PR counts in the bad colour', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    // medlens: 172 worktrees → high; chroxy: 1 worktree → not high.
    expect(screen.getByTestId('cr-wt-medlens').getAttribute('data-high')).toBe('true')
    expect(screen.getByTestId('cr-wt-medlens').className).toContain('cr-bad')
    expect(screen.getByTestId('cr-wt-chroxy').getAttribute('data-high')).toBe('false')
    // medlens PRs: 16 (< threshold 20) → not high.
    expect(screen.getByTestId('cr-prs-medlens').getAttribute('data-high')).toBe('false')
    expect(HIGH_COUNT_THRESHOLD).toBe(20)
  })

  it('renders a clean tree as "clean" and a dirty tree with counts', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-tree-chroxy')).toHaveTextContent('clean')
    expect(screen.getByTestId('cr-tree-medlens')).toHaveTextContent('2')
    expect(screen.getByTestId('cr-tree-medlens')).toHaveTextContent('(2u/0m/0s)')
  })

  it('renders the eyebrow with the survey date and the "generated ago" line', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-eyebrow')).toHaveTextContent('2026-06-04')
    // generatedAt 11:50, now 12:00 → 10m ago.
    expect(screen.getByTestId('cr-generated')).toHaveTextContent('generated 10m ago')
  })

  it('Refresh button dispatches the refresh handler', () => {
    const onRefresh = vi.fn()
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={onRefresh} now={() => NOW} />)
    fireEvent.click(screen.getByTestId('cr-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disables the Refresh button while loading', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={true} onRefresh={() => {}} now={() => NOW} />)
    const btn = screen.getByTestId('cr-refresh') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn).toHaveTextContent('Refreshing')
  })

  it('renders the empty state with a Run survey button before the first snapshot', () => {
    const onRefresh = vi.fn()
    render(<ControlRoomSection snapshot={null} loading={false} onRefresh={onRefresh} now={() => NOW} />)
    expect(screen.getByTestId('cr-empty')).toBeTruthy()
    expect(screen.queryByTestId('cr-table')).toBeNull()
    fireEvent.click(screen.getByTestId('cr-empty-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('renders a loading message in the empty state while the first survey runs', () => {
    render(<ControlRoomSection snapshot={null} loading={true} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-empty')).toHaveTextContent('Running the host survey')
  })

  it('disables Refresh and does not dispatch when disconnected', () => {
    const onRefresh = vi.fn()
    render(
      <ControlRoomSection snapshot={makeSnapshot()} loading={false} connected={false} onRefresh={onRefresh} now={() => NOW} />,
    )
    const btn = screen.getByTestId('cr-refresh') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('disables the empty-state Run survey button and shows a not-connected hint when disconnected', () => {
    const onRefresh = vi.fn()
    render(<ControlRoomSection snapshot={null} loading={false} connected={false} onRefresh={onRefresh} now={() => NOW} />)
    const btn = screen.getByTestId('cr-empty-refresh') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByTestId('cr-not-connected')).toBeTruthy()
    fireEvent.click(btn)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('renders a "no repos" row for an empty (but present) survey', () => {
    render(
      <ControlRoomSection
        snapshot={makeSnapshot({ repos: [], summary: { live: 0, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 } })}
        loading={false}
        onRefresh={() => {}}
        now={() => NOW}
      />,
    )
    expect(screen.getByTestId('cr-no-repos')).toBeTruthy()
  })
})

describe('formatGeneratedAgo (#5175)', () => {
  const base = Date.parse('2026-06-04T12:00:00.000Z')
  it('renders < 1 min as "just now"', () => {
    expect(formatGeneratedAgo(base - 30_000, base)).toBe('generated just now')
  })
  it('renders minutes', () => {
    expect(formatGeneratedAgo(base - 5 * 60_000, base)).toBe('generated 5m ago')
  })
  it('renders hours', () => {
    expect(formatGeneratedAgo(base - 3 * 3_600_000, base)).toBe('generated 3h ago')
  })
  it('renders days', () => {
    expect(formatGeneratedAgo(base - 2 * 86_400_000, base)).toBe('generated 2d ago')
  })
  it('clamps a future / clock-skewed timestamp to "just now"', () => {
    expect(formatGeneratedAgo(base + 60_000, base)).toBe('generated just now')
  })
})
