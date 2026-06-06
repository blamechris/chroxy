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
import type { ActivityEntry, ActivityState, SessionInfo } from '@chroxy/store-core'
import { applyActivitySnapshot, createEmptyActivityState } from '@chroxy/store-core'

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
  sessionIdForRepoPath,
  HIGH_COUNT_THRESHOLD,
  filterRepos,
  sortRepos,
  type RepoFilterKey,
} from './ControlRoomSection'

// Minimal SessionInfo factory — only the fields the repo→session mapping reads
// (`sessionId`, `cwd`) matter; the rest satisfy the type.
function makeSession(sessionId: string, cwd: string): SessionInfo {
  return {
    sessionId,
    name: sessionId,
    cwd,
    type: 'cli',
    hasTerminal: false,
    model: null,
    permissionMode: null,
    isBusy: false,
    createdAt: 0,
    conversationId: null,
  }
}

function buildActivity(sessionId: string, entries: ActivityEntry[]): ActivityState {
  return applyActivitySnapshot(createEmptyActivityState(), {
    type: 'activity_snapshot',
    sessionId,
    schemaVersion: 1,
    entries,
  })
}

function activityEntry(id: string, over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id,
    kind: 'agent',
    label: `Label ${id}`,
    status: 'running',
    startedAt: 1000,
    ...over,
  }
}

afterEach(() => {
  cleanup()
  // #5226 persists filters/sort to localStorage — clear so view state from one
  // case never leaks into the next (which assumes the default unfiltered view).
  try { localStorage.clear() } catch { /* noop */ }
})

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
        ahead: 0,
        behind: 0,
        openPRs: null,
        prChecks: null,
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
        ahead: 2,
        behind: 1,
        openPRs: 16,
        prChecks: { failing: 1, pending: 0, approved: 2, changesRequested: 1 },
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
        ahead: null,
        behind: null,
        openPRs: 1,
        prChecks: { failing: 0, pending: 0, approved: 0, changesRequested: 0 },
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

  it('#5201: branch + onboarding cells carry the full text as a title for hover-reveal when ellipsis-truncated', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    const branch = screen.getByTestId('cr-branch-medlens')
    expect(branch).toHaveClass('cr-branch')
    expect(branch).toHaveAttribute('title', 'docs/app-store-prep')
    // onboarding cell carries its full value as a title too
    const onboarding = screen.getByText('skipped — dirty tree')
    expect(onboarding).toHaveClass('cr-onboarding')
    expect(onboarding).toHaveAttribute('title', 'skipped — dirty tree')
  })

  it('#5216: renders the ahead/behind badge only for diverged branches', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    // medlens is ahead 2 / behind 1 → badge with both arrows.
    const badge = screen.getByTestId('cr-aheadbehind-medlens')
    expect(badge).toHaveTextContent('↑2')
    expect(badge).toHaveTextContent('↓1')
    // chroxy is up to date (0/0) → no badge; no-it-all has no upstream (null) → no badge.
    expect(screen.queryByTestId('cr-aheadbehind-chroxy')).toBeNull()
    expect(screen.queryByTestId('cr-aheadbehind-no-it-all')).toBeNull()
  })

  it('#5216: shows only the ahead arrow when behind is 0', () => {
    const snap = makeSnapshot({
      repos: [
        {
          name: 'solo',
          path: '/Users/me/Projects/solo',
          branch: 'feature',
          verdict: 'onboarded',
          live: false,
          tree: { state: 'clean', untracked: 0, modified: 0, staged: 0 },
          worktrees: 0,
          ahead: 3,
          behind: 0,
          openPRs: null,
          prChecks: null,
          attribution: null,
          onboarding: '✓ onboarded',
          lastTouched: '2026-06-04T11:12:00.000Z',
        },
      ],
    })
    render(<ControlRoomSection snapshot={snap} loading={false} onRefresh={() => {}} now={() => NOW} />)
    const badge = screen.getByTestId('cr-aheadbehind-solo')
    expect(badge).toHaveTextContent('↑3')
    expect(badge).not.toHaveTextContent('↓')
  })

  it('#5216: renders the PR CI/review rollup badge for repos with attention-needing PRs', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    // medlens: { failing:1, approved:2, changesRequested:1 } → badge with ✗/✎/✓.
    const badge = screen.getByTestId('cr-prchecks-medlens')
    expect(badge).toHaveTextContent('✗1')
    expect(badge).toHaveTextContent('✓2')
    expect(badge).toHaveTextContent('✎1')
    // no-it-all: all-zero counts → no badge. chroxy: prChecks null → no badge.
    expect(screen.queryByTestId('cr-prchecks-no-it-all')).toBeNull()
    expect(screen.queryByTestId('cr-prchecks-chroxy')).toBeNull()
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

// Helper: read the DOM order of rendered repo rows (top-level rows only).
function renderedRepoOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="cr-row-"]')).map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('cr-row-', ''),
  )
}

describe('filterRepos (#5216)', () => {
  const repos = makeSnapshot().repos

  it('returns all repos (a copy) for an empty filter set', () => {
    const out = filterRepos(repos, new Set())
    expect(out.map((r) => r.name)).toEqual(['chroxy', 'medlens', 'no-it-all'])
    expect(out).not.toBe(repos) // a copy, not the original array
  })

  it('dirty → only repos with a dirty tree', () => {
    expect(filterRepos(repos, new Set<RepoFilterKey>(['dirty'])).map((r) => r.name)).toEqual(['medlens'])
  })

  it('live → only live repos', () => {
    expect(filterRepos(repos, new Set<RepoFilterKey>(['live'])).map((r) => r.name)).toEqual(['chroxy'])
  })

  it('prs → repos with >0 open PRs (null counts as 0)', () => {
    expect(filterRepos(repos, new Set<RepoFilterKey>(['prs'])).map((r) => r.name)).toEqual(['medlens', 'no-it-all'])
  })

  it('triage → only investigate/abandoned/recent verdicts', () => {
    expect(filterRepos(repos, new Set<RepoFilterKey>(['triage'])).map((r) => r.name)).toEqual(['medlens'])
  })

  it('combines filters with AND (intersection)', () => {
    // medlens is both dirty and has PRs.
    expect(filterRepos(repos, new Set<RepoFilterKey>(['dirty', 'prs'])).map((r) => r.name)).toEqual(['medlens'])
    // No repo is both dirty AND live (medlens is dirty-not-live, chroxy is live-not-dirty).
    expect(filterRepos(repos, new Set<RepoFilterKey>(['dirty', 'live']))).toEqual([])
  })
})

describe('sortRepos (#5216)', () => {
  const repos = makeSnapshot().repos

  it('default preserves server order and does not mutate the input', () => {
    const out = sortRepos(repos, 'default')
    expect(out.map((r) => r.name)).toEqual(['chroxy', 'medlens', 'no-it-all'])
    expect(out).not.toBe(repos)
    // original untouched
    expect(repos.map((r) => r.name)).toEqual(['chroxy', 'medlens', 'no-it-all'])
  })

  it('recent sorts most-recently-touched first', () => {
    // chroxy 11:47 > no-it-all 11:12 > medlens 2026-05-28
    expect(sortRepos(repos, 'recent').map((r) => r.name)).toEqual(['chroxy', 'no-it-all', 'medlens'])
  })

  it('worktrees sorts highest count first', () => {
    expect(sortRepos(repos, 'worktrees').map((r) => r.name)).toEqual(['medlens', 'chroxy', 'no-it-all'])
  })

  it('prs sorts highest open-PR count first, unknown (null) last', () => {
    // medlens 16 > no-it-all 1 > chroxy null
    expect(sortRepos(repos, 'prs').map((r) => r.name)).toEqual(['medlens', 'no-it-all', 'chroxy'])
  })

  it('verdict sorts by priority (live first, onboarded last)', () => {
    expect(sortRepos(repos, 'verdict').map((r) => r.name)).toEqual(['chroxy', 'medlens', 'no-it-all'])
  })

  it('tree sorts most uncommitted changes first, ties broken by name', () => {
    // medlens has 2 changes; chroxy & no-it-all are clean (0) → name tiebreak.
    expect(sortRepos(repos, 'tree').map((r) => r.name)).toEqual(['medlens', 'chroxy', 'no-it-all'])
  })
})

describe('ControlRoomSection sort/filter controls (#5216)', () => {
  it('renders the controls bar with filter chips, a sort select, and a count', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-controls')).toBeTruthy()
    expect(screen.getByTestId('cr-filter-dirty')).toBeTruthy()
    expect(screen.getByTestId('cr-filter-live')).toBeTruthy()
    expect(screen.getByTestId('cr-filter-prs')).toBeTruthy()
    expect(screen.getByTestId('cr-filter-triage')).toBeTruthy()
    expect(screen.getByTestId('cr-sort')).toBeTruthy()
    // No filter active → plain "N repos" and no Clear button.
    expect(screen.getByTestId('cr-visible-count')).toHaveTextContent('3 repos')
    expect(screen.queryByTestId('cr-clear-filters')).toBeNull()
  })

  it('filtering by dirty narrows the table and updates the count', () => {
    const { container } = render(
      <ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />,
    )
    fireEvent.click(screen.getByTestId('cr-filter-dirty'))
    expect(renderedRepoOrder(container)).toEqual(['medlens'])
    expect(screen.getByTestId('cr-filter-dirty')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('cr-visible-count')).toHaveTextContent('1 of 3 repos')
  })

  it('Clear resets the filters', () => {
    const { container } = render(
      <ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />,
    )
    fireEvent.click(screen.getByTestId('cr-filter-dirty'))
    fireEvent.click(screen.getByTestId('cr-clear-filters'))
    expect(renderedRepoOrder(container)).toEqual(['chroxy', 'medlens', 'no-it-all'])
    expect(screen.getByTestId('cr-visible-count')).toHaveTextContent('3 repos')
    expect(screen.getByTestId('cr-filter-dirty')).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows a no-matches row (with a clear action) when filters exclude everything', () => {
    const { container } = render(
      <ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />,
    )
    // dirty + live → no repo matches both.
    fireEvent.click(screen.getByTestId('cr-filter-dirty'))
    fireEvent.click(screen.getByTestId('cr-filter-live'))
    expect(renderedRepoOrder(container)).toEqual([])
    expect(screen.getByTestId('cr-no-matches')).toBeTruthy()
    fireEvent.click(screen.getByTestId('cr-no-matches-clear'))
    expect(renderedRepoOrder(container)).toEqual(['chroxy', 'medlens', 'no-it-all'])
  })

  it('changing the sort reorders the rendered rows', () => {
    const { container } = render(
      <ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />,
    )
    fireEvent.change(screen.getByTestId('cr-sort'), { target: { value: 'worktrees' } })
    expect(renderedRepoOrder(container)).toEqual(['medlens', 'chroxy', 'no-it-all'])
  })

  it('does not render the controls bar when there are no repos', () => {
    render(
      <ControlRoomSection
        snapshot={makeSnapshot({ repos: [], summary: { live: 0, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 } })}
        loading={false}
        onRefresh={() => {}}
        now={() => NOW}
      />,
    )
    expect(screen.queryByTestId('cr-controls')).toBeNull()
  })
})

describe('ControlRoomSection sort/filter persistence (#5226)', () => {
  it('persists an active filter to localStorage', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    fireEvent.click(screen.getByTestId('cr-filter-dirty'))
    expect(localStorage.getItem('chroxy_cr_filters')).toBe('dirty')
  })

  it('persists the chosen sort to localStorage', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    fireEvent.change(screen.getByTestId('cr-sort'), { target: { value: 'worktrees' } })
    expect(localStorage.getItem('chroxy_cr_sort')).toBe('worktrees')
  })

  it('restores persisted filter + sort on a fresh mount', () => {
    localStorage.setItem('chroxy_cr_filters', 'dirty')
    localStorage.setItem('chroxy_cr_sort', 'worktrees')
    const { container } = render(
      <ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />,
    )
    // dirty filter restored → only medlens, and chip shows pressed.
    expect(screen.getByTestId('cr-filter-dirty')).toHaveAttribute('aria-pressed', 'true')
    expect(renderedRepoOrder(container)).toEqual(['medlens'])
    // sort restored → the select reflects it.
    expect((screen.getByTestId('cr-sort') as HTMLSelectElement).value).toBe('worktrees')
  })

  it('round-trips through unmount/remount (a reload survives)', () => {
    const first = render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    fireEvent.click(screen.getByTestId('cr-filter-live'))
    first.unmount()
    // Re-mount fresh (simulating a page reload reading from localStorage).
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    expect(screen.getByTestId('cr-filter-live')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('cr-visible-count')).toHaveTextContent('1 of 3 repos')
  })

  it('ignores garbage / unknown persisted values, falling back to defaults', () => {
    localStorage.setItem('chroxy_cr_filters', 'dirty,bogus,,live')
    localStorage.setItem('chroxy_cr_sort', 'not-a-real-sort')
    const { container } = render(
      <ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />,
    )
    // Only the valid keys (dirty, live) survive — and they AND to nothing here.
    expect(screen.getByTestId('cr-filter-dirty')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('cr-filter-live')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('cr-filter-prs')).toHaveAttribute('aria-pressed', 'false')
    // Invalid sort → default (server order).
    expect((screen.getByTestId('cr-sort') as HTMLSelectElement).value).toBe('default')
    expect(renderedRepoOrder(container)).toEqual([]) // dirty AND live matches nothing
  })

  it('clearing filters empties the persisted value', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    fireEvent.click(screen.getByTestId('cr-filter-dirty'))
    expect(localStorage.getItem('chroxy_cr_filters')).toBe('dirty')
    fireEvent.click(screen.getByTestId('cr-clear-filters'))
    expect(localStorage.getItem('chroxy_cr_filters')).toBe('')
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

describe('sessionIdForRepoPath (#5176)', () => {
  it('maps a repo path to the session whose cwd matches exactly', () => {
    const sessions = [
      makeSession('s-chroxy', '/Users/me/Projects/chroxy'),
      makeSession('s-other', '/Users/me/Projects/medlens'),
    ]
    expect(sessionIdForRepoPath('/Users/me/Projects/chroxy', sessions)).toBe('s-chroxy')
  })

  it('tolerates a trailing-slash mismatch between repo path and cwd', () => {
    const sessions = [makeSession('s-chroxy', '/Users/me/Projects/chroxy/')]
    expect(sessionIdForRepoPath('/Users/me/Projects/chroxy', sessions)).toBe('s-chroxy')
  })

  it('falls back to the deepest nested cwd under the repo path (e.g. a worktree)', () => {
    const sessions = [
      makeSession('s-shallow', '/Users/me/Projects/chroxy/pkg'),
      makeSession('s-deep', '/Users/me/Projects/chroxy/pkg/server'),
    ]
    expect(sessionIdForRepoPath('/Users/me/Projects/chroxy', sessions)).toBe('s-deep')
  })

  it('matches across Windows backslash vs forward-slash separators (mirrors server pathKey)', () => {
    // The server's repo.path may arrive backslash-separated on Windows while a
    // session cwd is forward-slash (or vice versa); normalization folds both.
    const sessions = [makeSession('s-win', 'C:/Users/me/Projects/chroxy')]
    expect(sessionIdForRepoPath('C:\\Users\\me\\Projects\\chroxy', sessions)).toBe('s-win')
  })

  it('matches a nested Windows cwd under a backslash repo path', () => {
    const sessions = [makeSession('s-wt', 'C:\\Users\\me\\Projects\\chroxy\\wt')]
    expect(sessionIdForRepoPath('C:/Users/me/Projects/chroxy', sessions)).toBe('s-wt')
  })

  it('returns null when no session maps to the repo', () => {
    const sessions = [makeSession('s-other', '/Users/me/Projects/medlens')]
    expect(sessionIdForRepoPath('/Users/me/Projects/chroxy', sessions)).toBeNull()
  })

  it('does not treat a sibling repo with a shared prefix as nested', () => {
    // /chroxy-2 starts with /chroxy but is NOT under /chroxy/.
    const sessions = [makeSession('s-sibling', '/Users/me/Projects/chroxy-2')]
    expect(sessionIdForRepoPath('/Users/me/Projects/chroxy', sessions)).toBeNull()
  })
})

describe('ControlRoomSection activity drill-down (#5176)', () => {
  const NOW_TICK = () => 5000

  it('renders a drill-down toggle only for repos with a mapped active session', () => {
    const sessions = [makeSession('s-chroxy', '/Users/me/Projects/chroxy')]
    const activity = buildActivity('s-chroxy', [activityEntry('a1')])
    render(
      <ControlRoomSection
        snapshot={makeSnapshot()}
        loading={false}
        onRefresh={() => {}}
        now={NOW_TICK}
        sessions={sessions}
        activity={activity}
      />,
    )
    // chroxy has a mapped session → disclosure toggle present.
    expect(screen.getByTestId('cr-drill-toggle-chroxy')).toBeTruthy()
    // medlens / no-it-all have no session → no toggle.
    expect(screen.queryByTestId('cr-drill-toggle-medlens')).toBeNull()
    expect(screen.queryByTestId('cr-drill-toggle-no-it-all')).toBeNull()
  })

  it('reveals the mapped session activity tree when a repo row is expanded', () => {
    const sessions = [makeSession('s-chroxy', '/Users/me/Projects/chroxy')]
    const activity = buildActivity('s-chroxy', [
      activityEntry('a1', { label: 'build agent', status: 'running' }),
      activityEntry('a2', { kind: 'shell', label: 'tail logs', status: 'blocked' }),
    ])
    render(
      <ControlRoomSection
        snapshot={makeSnapshot()}
        loading={false}
        onRefresh={() => {}}
        now={NOW_TICK}
        sessions={sessions}
        activity={activity}
      />,
    )
    // Collapsed by default — no tree yet.
    expect(screen.queryByTestId('cr-activity-row-chroxy')).toBeNull()

    fireEvent.click(screen.getByTestId('cr-drill-toggle-chroxy'))

    // Expanded: the activity tree renders the session's entries with status.
    expect(screen.getByTestId('cr-activity-row-chroxy')).toBeTruthy()
    expect(screen.getByTestId('control-room-tree')).toBeTruthy()
    expect(screen.getByTestId('control-room-entry-label-a1')).toHaveTextContent('build agent')
    expect(screen.getByTestId('control-room-status-a1')).toHaveTextContent('Running')
    expect(screen.getByTestId('control-room-entry-label-a2')).toHaveTextContent('tail logs')
    expect(screen.getByTestId('control-room-status-a2')).toHaveTextContent('Blocked')
  })

  it('shows the empty "no activity" state for a mapped session with no in-flight work', () => {
    const sessions = [makeSession('s-chroxy', '/Users/me/Projects/chroxy')]
    const activity = createEmptyActivityState()
    render(
      <ControlRoomSection
        snapshot={makeSnapshot()}
        loading={false}
        onRefresh={() => {}}
        now={NOW_TICK}
        sessions={sessions}
        activity={activity}
      />,
    )
    fireEvent.click(screen.getByTestId('cr-drill-toggle-chroxy'))
    expect(screen.getByTestId('cr-activity-row-chroxy')).toBeTruthy()
    expect(screen.getByTestId('control-room-empty')).toHaveTextContent('No activity in flight')
  })
})

describe('ControlRoomSection investigate action (#5202)', () => {
  it('renders the investigate verdict as a non-interactive span when no handler is wired', () => {
    render(<ControlRoomSection snapshot={makeSnapshot()} loading={false} onRefresh={() => {}} now={() => NOW} />)
    const tag = screen.getByTestId('cr-verdict-investigate')
    expect(tag.tagName).toBe('SPAN')
  })

  it('renders the investigate verdict as a button when onInvestigate is provided', () => {
    render(
      <ControlRoomSection
        snapshot={makeSnapshot()}
        loading={false}
        onRefresh={() => {}}
        now={() => NOW}
        onInvestigate={() => {}}
      />,
    )
    const tag = screen.getByTestId('cr-verdict-investigate')
    expect(tag.tagName).toBe('BUTTON')
    expect(tag).toHaveClass('cr-tag-action')
  })

  it('gives the investigate button a per-row accessible name including the repo', () => {
    render(
      <ControlRoomSection
        snapshot={makeSnapshot()}
        loading={false}
        onRefresh={() => {}}
        now={() => NOW}
        onInvestigate={() => {}}
      />,
    )
    const tag = screen.getByTestId('cr-verdict-investigate')
    expect(tag).toHaveAttribute('aria-label', expect.stringContaining('medlens'))
  })

  it('calls onInvestigate with the repo cwd, name, and reason note on click', () => {
    const onInvestigate = vi.fn()
    render(
      <ControlRoomSection
        snapshot={makeSnapshot()}
        loading={false}
        onRefresh={() => {}}
        now={() => NOW}
        onInvestigate={onInvestigate}
      />,
    )
    fireEvent.click(screen.getByTestId('cr-verdict-investigate'))
    expect(onInvestigate).toHaveBeenCalledWith({
      cwd: '/Users/me/Projects/medlens',
      name: 'medlens',
      reason: '172 worktrees — likely a leak/runaway.',
    })
  })

  it('passes an empty reason when the repo has no note', () => {
    const onInvestigate = vi.fn()
    const snap = makeSnapshot({
      repos: [
        {
          name: 'noteless',
          path: '/Users/me/Projects/noteless',
          branch: 'main',
          verdict: 'investigate',
          live: false,
          tree: { state: 'dirty', untracked: 1, modified: 0, staged: 0 },
          worktrees: 99,
          ahead: null,
          behind: null,
          openPRs: null,
          prChecks: null,
          attribution: null,
          onboarding: 'skipped',
          lastTouched: '2026-05-28T11:00:00.000Z',
          // no note
        },
      ],
    })
    render(
      <ControlRoomSection snapshot={snap} loading={false} onRefresh={() => {}} now={() => NOW} onInvestigate={onInvestigate} />,
    )
    fireEvent.click(screen.getByTestId('cr-verdict-investigate'))
    expect(onInvestigate).toHaveBeenCalledWith({
      cwd: '/Users/me/Projects/noteless',
      name: 'noteless',
      reason: '',
    })
  })

  it('leaves non-actionable verdicts (live, onboarded) as plain spans even with a handler', () => {
    render(
      <ControlRoomSection
        snapshot={makeSnapshot()}
        loading={false}
        onRefresh={() => {}}
        now={() => NOW}
        onInvestigate={() => {}}
      />,
    )
    expect(screen.getByTestId('cr-verdict-live').tagName).toBe('SPAN')
    expect(screen.getByTestId('cr-verdict-onboarded').tagName).toBe('SPAN')
  })
})
