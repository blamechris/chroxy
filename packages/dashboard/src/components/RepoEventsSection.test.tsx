/**
 * RepoEventsSection (#5966) — renderer + pure-helper tests.
 *
 * Covers the pane against a mocked `repo_events_snapshot`:
 *   - pure helpers: repoBasename, activeRepoBasenames, scopeAndGroupEvents (the
 *     newest-first + scope-to-active-repos + group-by-repo logic), formatAgo
 *   - empty / loading / not-connected states before the first snapshot
 *   - events render newest-first, grouped by repo, with kind badge + summary
 *   - active-repo scoping hides other repos; "Show all" reveals them
 *   - the "no events buffered" state when the snapshot is empty
 *   - the degraded refusal error callout renders from `error`
 *   - link safety: only an https URL renders a link
 *   - Refresh dispatches the request (and is disabled while loading)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { RepoEvent, ServerRepoEventsSnapshotMessage } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      repoEventsSnapshot: null,
      repoEventsLoading: false,
      connectionPhase: 'connected',
      sessions: [],
      requestRepoEvents: () => false,
    }),
}))
import {
  RepoEventsSection,
  repoBasename,
  activeRepoBasenames,
  scopeAndGroupEvents,
  formatAgo,
} from './RepoEventsSection'

afterEach(cleanup)

const NOW = Date.parse('2026-07-02T12:05:00.000Z')

function ev(over: Partial<RepoEvent> = {}): RepoEvent {
  return {
    kind: 'pull_request',
    repo: 'blamechris/chroxy',
    actor: 'blamechris',
    at: '2026-07-02T12:00:00.000Z',
    action: 'opened',
    number: 42,
    title: 'feat',
    url: 'https://github.com/blamechris/chroxy/pull/42',
    summary: 'opened PR #42',
    ...over,
  }
}

function snap(over: Partial<ServerRepoEventsSnapshotMessage> = {}): ServerRepoEventsSnapshotMessage {
  return { type: 'repo_events_snapshot', generatedAt: '2026-07-02T12:00:00.000Z', events: [ev()], ...over }
}

describe('RepoEventsSection pure helpers (#5966)', () => {
  it('repoBasename returns the repo part of owner/repo and POSIX/Windows cwds', () => {
    expect(repoBasename('blamechris/chroxy')).toBe('chroxy')
    expect(repoBasename('/Users/me/Projects/chroxy')).toBe('chroxy')
    expect(repoBasename('/Users/me/Projects/chroxy/')).toBe('chroxy') // trailing slash
    expect(repoBasename('C:\\Users\\me\\chroxy')).toBe('chroxy')      // Windows daemon cwd
    expect(repoBasename(null)).toBeNull()
    expect(repoBasename('')).toBeNull()
  })

  it('activeRepoBasenames derives the cwd basenames of live sessions (POSIX + Windows)', () => {
    const set = activeRepoBasenames([{ cwd: '/Users/me/Projects/chroxy' }, { cwd: 'C:\\Users\\me\\widget' }])
    expect([...set].sort()).toEqual(['chroxy', 'widget'])
  })

  // Backward-compat basename fallback (older daemon: exactRepos null).
  const basenameScope = (bases: string[]) => ({ exactRepos: null, basenames: new Set(bases) })

  it('scopeAndGroupEvents reverses to newest-first and groups by repo', () => {
    const events = [
      ev({ repo: 'a/one', at: '2026-07-02T10:00:00.000Z', summary: 'old' }),
      ev({ repo: 'a/two', at: '2026-07-02T11:00:00.000Z', summary: 'mid' }),
      ev({ repo: 'a/one', at: '2026-07-02T12:00:00.000Z', summary: 'new' }),
    ]
    const { groups, hiddenCount } = scopeAndGroupEvents(events, basenameScope([]), false)
    // newest event (a/one 'new') ranks its group first
    expect(groups.map((g) => g.repo)).toEqual(['one', 'two'].map((x) => `a/${x}`))
    expect(groups[0]!.events.map((e) => e.summary)).toEqual(['new', 'old'])
    expect(hiddenCount).toBe(0)
  })

  it('scopeAndGroupEvents filters by basename fallback when exactRepos is null', () => {
    const events = [ev({ repo: 'blamechris/chroxy' }), ev({ repo: 'someone/other' })]
    const { groups, hiddenCount } = scopeAndGroupEvents(events, basenameScope(['chroxy']), false)
    expect(groups.map((g) => g.repo)).toEqual(['blamechris/chroxy'])
    expect(hiddenCount).toBe(1)
  })

  it('scopeAndGroupEvents shows everything when showAll is true or the active set is empty', () => {
    const events = [ev({ repo: 'blamechris/chroxy' }), ev({ repo: 'someone/other' })]
    expect(scopeAndGroupEvents(events, basenameScope(['chroxy']), true).hiddenCount).toBe(0)
    expect(scopeAndGroupEvents(events, basenameScope([]), false).groups.length).toBe(2)
  })

  // #6539: exact owner/repo scoping (the server-provided set takes precedence).
  it('scopeAndGroupEvents matches by EXACT owner/repo when exactRepos is provided', () => {
    const events = [ev({ repo: 'blamechris/chroxy' }), ev({ repo: 'someone/chroxy' })]
    // Both share basename "chroxy", but exact scoping keeps only the right owner.
    const scope = { exactRepos: new Set(['blamechris/chroxy']), basenames: new Set(['chroxy']) }
    const { groups, hiddenCount } = scopeAndGroupEvents(events, scope, false)
    expect(groups.map((g) => g.repo)).toEqual(['blamechris/chroxy'])
    expect(hiddenCount).toBe(1)
  })

  it('scopeAndGroupEvents with an empty exact set (no GitHub-remote sessions) shows all, not none', () => {
    const events = [ev({ repo: 'blamechris/chroxy' }), ev({ repo: 'someone/other' })]
    const scope = { exactRepos: new Set<string>(), basenames: new Set(['chroxy']) }
    // exactRepos is provided-but-empty ⇒ no scoping (don't erroneously hide all).
    expect(scopeAndGroupEvents(events, scope, false).groups.length).toBe(2)
  })

  it('scopeAndGroupEvents prefers exactRepos over the basename fallback', () => {
    const events = [ev({ repo: 'blamechris/chroxy' }), ev({ repo: 'someone/other' })]
    // basenames would keep 'other'; exact set does not — exact wins.
    const scope = { exactRepos: new Set(['blamechris/chroxy']), basenames: new Set(['chroxy', 'other']) }
    const { groups } = scopeAndGroupEvents(events, scope, false)
    expect(groups.map((g) => g.repo)).toEqual(['blamechris/chroxy'])
  })

  it('formatAgo renders a relative label or a dash', () => {
    expect(formatAgo('2026-07-02T12:00:00.000Z', NOW)).toBe('5m ago')
    expect(formatAgo('2026-07-02T12:05:00.000Z', NOW)).toBe('just now')
    expect(formatAgo(null, NOW)).toBe('—')
    expect(formatAgo('nonsense', NOW)).toBe('—')
  })
})

describe('RepoEventsSection render (#5966)', () => {
  it('shows the empty state (no survey yet) with a Run survey button', () => {
    render(<RepoEventsSection snapshot={null} loading={false} connected sessions={[]} />)
    expect(screen.getByTestId('repo-events-empty')).toBeTruthy()
    expect(screen.getByTestId('repo-events-empty-refresh')).toBeTruthy()
  })

  it('renders events newest-first grouped by repo with kind badges', () => {
    const snapshot = snap({
      events: [
        ev({ repo: 'blamechris/chroxy', kind: 'push', at: '2026-07-02T10:00:00.000Z', summary: 'pushed 1 commit to main', url: null }),
        ev({ repo: 'blamechris/chroxy', kind: 'pull_request', at: '2026-07-02T12:00:00.000Z', summary: 'opened PR #42' }),
      ],
    })
    render(<RepoEventsSection snapshot={snapshot} loading={false} connected sessions={[]} now={() => NOW} />)
    const rows = screen.getAllByTestId('repo-event-row')
    expect(rows).toHaveLength(2)
    // newest (PR) first
    expect(within(rows[0]!).getByTestId('repo-event-summary').textContent).toBe('opened PR #42')
    expect(within(rows[1]!).getByTestId('repo-event-summary').textContent).toBe('pushed 1 commit to main')
    expect(screen.getByTestId('repo-events-chip-count-total').textContent).toBe('2')
  })

  it('scopes to active-session repos and reveals the rest on Show all', () => {
    const snapshot = snap({
      events: [ev({ repo: 'blamechris/chroxy' }), ev({ repo: 'someone/other', summary: 'opened PR #7' })],
    })
    render(<RepoEventsSection snapshot={snapshot} loading={false} connected sessions={[{ cwd: '/Users/me/Projects/chroxy' } as never]} now={() => NOW} />)
    // scoped: only the chroxy event is visible
    expect(screen.getAllByTestId('repo-event-row')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('repo-events-show-all-toggle'))
    expect(screen.getAllByTestId('repo-event-row')).toHaveLength(2)
  })

  it('renders the "no events buffered" state for an empty snapshot', () => {
    render(<RepoEventsSection snapshot={snap({ events: [] })} loading={false} connected sessions={[]} />)
    expect(screen.getByTestId('repo-events-none-buffered')).toBeTruthy()
  })

  it('renders the degraded refusal error callout', () => {
    render(<RepoEventsSection snapshot={snap({ events: [], error: { code: 'FORBIDDEN', message: 'nope' } })} loading={false} connected sessions={[]} />)
    expect(screen.getByTestId('repo-events-error').textContent).toContain('FORBIDDEN')
  })

  it('only renders a link for an https URL (rejects null + unsafe schemes)', () => {
    const withLink = snap({ events: [ev({ url: 'https://github.com/blamechris/chroxy/pull/42' })] })
    const { rerender } = render(<RepoEventsSection snapshot={withLink} loading={false} connected sessions={[]} now={() => NOW} />)
    expect(screen.queryByTestId('repo-event-link')).toBeTruthy()
    // Every non-https shape must render NO anchor — a loosened guard would fail here.
    for (const unsafe of [null, 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'http://evil.test', '//evil.test/x']) {
      rerender(<RepoEventsSection snapshot={snap({ events: [ev({ url: unsafe })] })} loading={false} connected sessions={[]} now={() => NOW} />)
      expect(screen.queryByTestId('repo-event-link')).toBeNull()
    }
  })

  it('Refresh dispatches the request and is disabled while loading', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(<RepoEventsSection snapshot={snap()} loading={false} connected sessions={[]} onRefresh={onRefresh} now={() => NOW} />)
    fireEvent.click(screen.getByTestId('repo-events-refresh'))
    expect(onRefresh).toHaveBeenCalledOnce()
    rerender(<RepoEventsSection snapshot={snap()} loading connected sessions={[]} onRefresh={onRefresh} now={() => NOW} />)
    expect((screen.getByTestId('repo-events-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})
