/**
 * IntegrationsSection (#5499) — renderer tests.
 *
 * Covers the surface against a mocked `integration_status_snapshot`:
 *   - empty / loading / not-connected states before the first snapshot
 *   - summary chips render the per-bucket counts
 *   - one row per repo: configured (summarizer + tool groups), quiet
 *     not-configured, degraded (warn accent + reason tooltip)
 *   - cache cell: size / "no cache yet" / "—"
 *   - hit-ratio cell: percentage + counts, "no events", degraded "—"
 *   - tokens saved + entries (incl. stale) cells
 *   - last activity falls back to the cache mtime when the report has none
 *   - the missing-CLI callout renders when the binary probe failed
 *   - the degraded-survey error callout renders from `error`
 *   - Refresh dispatches the request (and is disabled while loading)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { IntegrationRepo, RepoMemoryStatus, ServerIntegrationStatusSnapshotMessage } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      integrationStatus: null,
      integrationStatusLoading: false,
      connectionPhase: 'connected',
      requestIntegrationStatus: () => false,
      // #5500: Reindex action state.
      reindexingRepoPaths: new Set<string>(),
      reindexResults: {},
      sendRepoMemoryReindex: () => false,
    }),
}))
import { IntegrationsSection, formatBytes } from './IntegrationsSection'

afterEach(cleanup)

const NOW = Date.parse('2026-06-10T12:00:00.000Z')

function repoMemory(over: Partial<RepoMemoryStatus> = {}): RepoMemoryStatus {
  return {
    configured: true,
    summarizer: 'ast',
    toolGroups: ['telemetry'],
    cache: { present: true, sizeBytes: 2310144, lastModified: '2026-06-09T22:00:00.000Z' },
    report: {
      totalEvents: 120,
      cacheHits: 90,
      cacheMisses: 30,
      cacheHitRatio: 0.75,
      estimatedTokensSaved: 48211,
      cacheEntryCount: 1391,
      staleEntryCount: 2,
      lastActivity: null,
    },
    reason: null,
    ...over,
  }
}

const NOT_CONFIGURED: RepoMemoryStatus = {
  configured: false,
  summarizer: null,
  toolGroups: [],
  cache: null,
  report: null,
  reason: null,
}

function snapshot(over: Partial<ServerIntegrationStatusSnapshotMessage> = {}): ServerIntegrationStatusSnapshotMessage {
  return {
    type: 'integration_status_snapshot',
    generatedAt: '2026-06-10T11:50:00.000Z',
    root: '/Users/x/Projects',
    summary: { total: 2, configured: 1, notConfigured: 1, degraded: 0 },
    repos: [
      { name: 'chroxy', path: '/Users/x/Projects/chroxy', repoMemory: repoMemory() },
      { name: 'scratch', path: '/Users/x/Projects/scratch', repoMemory: NOT_CONFIGURED },
    ],
    repoMemoryCli: { found: true, path: '/usr/local/bin/repo-memory', note: null },
    ...over,
  }
}

function oneRepoSnapshot(repos: IntegrationRepo[]): ServerIntegrationStatusSnapshotMessage {
  return snapshot({ repos })
}

function renderSection(snap: ServerIntegrationStatusSnapshotMessage | null, extra: Record<string, unknown> = {}) {
  return render(
    <IntegrationsSection
      snapshot={snap}
      loading={false}
      connected={true}
      onRefresh={() => {}}
      now={() => NOW}
      {...extra}
    />,
  )
}

describe('IntegrationsSection — empty / loading / not-connected', () => {
  it('renders the empty state with a Run survey button before the first snapshot', () => {
    renderSection(null)
    expect(screen.getByTestId('integration-empty')).toBeTruthy()
    expect(screen.getByTestId('integration-empty-refresh')).toBeTruthy()
    expect(screen.queryByTestId('integration-table')).toBeNull()
  })

  it('renders a loading state', () => {
    renderSection(null, { loading: true })
    expect(screen.getByTestId('integration-empty').textContent).toContain('Running the integrations survey')
  })

  it('shows a not-connected hint and disables Run survey when disconnected', () => {
    renderSection(null, { connected: false })
    expect(screen.getByTestId('integration-not-connected')).toBeTruthy()
    expect((screen.getByTestId('integration-empty-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('IntegrationsSection — populated', () => {
  it('renders summary chips with the per-bucket counts', () => {
    renderSection(snapshot())
    expect(screen.getByTestId('integration-chip-count-total').textContent).toBe('2')
    expect(screen.getByTestId('integration-chip-count-configured').textContent).toBe('1')
    expect(screen.getByTestId('integration-chip-count-notConfigured').textContent).toBe('1')
    expect(screen.getByTestId('integration-chip-count-degraded').textContent).toBe('0')
  })

  it('renders one row per repo with the status tag accents', () => {
    renderSection(snapshot())
    expect(screen.getByTestId('integration-row-chroxy')).toBeTruthy()
    expect(screen.getByTestId('integration-row-scratch')).toBeTruthy()
    expect(screen.getByTestId('integration-status-chroxy').getAttribute('data-accent')).toBe('ok')
    expect(screen.getByTestId('integration-status-chroxy').textContent).toBe('Configured')
    expect(screen.getByTestId('integration-status-scratch').getAttribute('data-accent')).toBe('neutral')
    expect(screen.getByTestId('integration-status-scratch').textContent).toBe('Not configured')
  })

  it('a degraded repo renders the warn accent with the reason as tooltip', () => {
    const snap = oneRepoSnapshot([
      {
        name: 'broken',
        path: '/p/broken',
        repoMemory: repoMemory({ report: null, reason: 'repo-memory report failed: database is locked' }),
      },
    ])
    renderSection(snap)
    const tag = screen.getByTestId('integration-status-broken')
    expect(tag.getAttribute('data-accent')).toBe('warn')
    expect(tag.textContent).toBe('Degraded')
    expect(tag.getAttribute('title')).toContain('database is locked')
    // CLI-derived cells degrade to "—"; the config/cache cells stay populated.
    expect(screen.getByTestId('integration-ratio-broken').textContent).toBe('—')
    expect(screen.getByTestId('integration-tokens-broken').textContent).toBe('—')
    expect(screen.getByTestId('integration-cache-broken').textContent).toContain('MB')
  })

  it('renders summarizer + tool groups for a configured repo, "—" otherwise', () => {
    renderSection(snapshot())
    expect(screen.getByTestId('integration-config-chroxy').textContent).toContain('ast')
    expect(screen.getByTestId('integration-config-chroxy').textContent).toContain('telemetry')
    expect(screen.getByTestId('integration-config-scratch').textContent).toBe('—')
  })

  it('cache cell shows the human-readable size incl. the wal sidecar total', () => {
    renderSection(snapshot())
    expect(screen.getByTestId('integration-cache-chroxy').textContent).toBe('2.2 MB')
    expect(screen.getByTestId('integration-cache-scratch').textContent).toBe('—')
  })

  it('cache cell shows "no cache yet" for a configured repo without a db', () => {
    const snap = oneRepoSnapshot([
      {
        name: 'fresh',
        path: '/p/fresh',
        repoMemory: repoMemory({ cache: { present: false, sizeBytes: 0, lastModified: null }, report: null, reason: null }),
      },
    ])
    renderSection(snap)
    expect(screen.getByTestId('integration-cache-fresh').textContent).toBe('no cache yet')
  })

  it('hit-ratio cell renders the percentage + hit counts, and "no events" at zero lookups', () => {
    renderSection(snapshot())
    expect(screen.getByTestId('integration-ratio-chroxy').textContent).toContain('75.0%')
    expect(screen.getByTestId('integration-ratio-chroxy').textContent).toContain('(90/120)')
    const quiet = oneRepoSnapshot([
      {
        name: 'quiet',
        path: '/p/quiet',
        repoMemory: repoMemory({
          report: {
            totalEvents: 0, cacheHits: 0, cacheMisses: 0, cacheHitRatio: 0,
            estimatedTokensSaved: 0, cacheEntryCount: 10, staleEntryCount: 0, lastActivity: null,
          },
        }),
      },
    ])
    cleanup()
    renderSection(quiet)
    expect(screen.getByTestId('integration-ratio-quiet').textContent).toBe('no events')
  })

  it('renders tokens saved and entry counts (with stale annotation)', () => {
    renderSection(snapshot())
    expect(screen.getByTestId('integration-tokens-chroxy').textContent).toBe('~48,211')
    expect(screen.getByTestId('integration-stale-chroxy').textContent).toBe('1391 (2 stale)')
  })

  it('last activity falls back to the cache mtime when the report has no timestamp', () => {
    renderSection(snapshot())
    // cache lastModified is 14h before NOW.
    expect(screen.getByTestId('integration-activity-chroxy').textContent).toBe('14h ago')
    expect(screen.getByTestId('integration-activity-scratch').textContent).toBe('—')
  })

  it('renders the missing-CLI callout when the binary probe failed', () => {
    renderSection(snapshot({ repoMemoryCli: { found: false, path: null, note: 'repo-memory CLI not found on PATH' } }))
    expect(screen.getByTestId('integration-cli-note').textContent).toContain('repo-memory CLI not found on PATH')
  })

  it('does not render the CLI callout when the binary was found', () => {
    renderSection(snapshot())
    expect(screen.queryByTestId('integration-cli-note')).toBeNull()
  })

  it('renders the degraded-survey error callout', () => {
    renderSection(snapshot({
      repos: [],
      summary: { total: 0, configured: 0, notConfigured: 0, degraded: 0 },
      error: { code: 'SURVEY_FAILED', message: 'stat exploded' },
    }))
    expect(screen.getByTestId('integration-error').textContent).toContain('stat exploded')
  })

  it('renders the no-repos row when the survey found nothing', () => {
    renderSection(snapshot({ repos: [], summary: { total: 0, configured: 0, notConfigured: 0, degraded: 0 } }))
    expect(screen.getByTestId('integration-no-repos')).toBeTruthy()
  })
})

describe('IntegrationsSection — refresh', () => {
  it('dispatches onRefresh when Refresh is clicked', () => {
    const onRefresh = vi.fn()
    renderSection(snapshot(), { onRefresh })
    fireEvent.click(screen.getByTestId('integration-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disables Refresh while loading and does not dispatch', () => {
    const onRefresh = vi.fn()
    renderSection(snapshot(), { loading: true, onRefresh })
    const btn = screen.getByTestId('integration-refresh') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onRefresh).not.toHaveBeenCalled()
  })
})

describe('IntegrationsSection — Reindex action (#5500)', () => {
  const COUNTS = { scanned: 412, summarized: 12, fresh: 398, skipped: 2 }

  it('renders a Reindex button for a configured repo only', () => {
    renderSection(snapshot())
    expect(screen.getByTestId('integration-reindex-chroxy')).toBeTruthy()
    expect(screen.queryByTestId('integration-reindex-scratch')).toBeNull()
  })

  it('dispatches onReindex with the repo path when clicked', () => {
    const onReindex = vi.fn()
    renderSection(snapshot(), { onReindex })
    fireEvent.click(screen.getByTestId('integration-reindex-chroxy'))
    expect(onReindex).toHaveBeenCalledWith('/Users/x/Projects/chroxy')
  })

  it('shows the pending "Reindexing…" state, disabled, and does not re-dispatch', () => {
    const onReindex = vi.fn()
    renderSection(snapshot(), { onReindex, reindexingRepoPaths: new Set(['/Users/x/Projects/chroxy']) })
    const btn = screen.getByTestId('integration-reindex-chroxy') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toContain('Reindexing…')
    fireEvent.click(btn)
    expect(onReindex).not.toHaveBeenCalled()
  })

  it('disables Reindex when disconnected', () => {
    renderSection(snapshot(), { connected: false })
    const btn = screen.getByTestId('integration-reindex-chroxy') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('renders the ack counts inline after a completed reindex', () => {
    renderSection(snapshot(), {
      reindexResults: { '/Users/x/Projects/chroxy': { counts: COUNTS, error: null, at: NOW } },
    })
    const result = screen.getByTestId('integration-reindex-result-chroxy')
    expect(result.textContent).toContain('12 summarized')
    expect(result.textContent).toContain('398 fresh')
    expect(result.textContent).toContain('2 skipped')
  })

  it('renders a neutral "reindexed" note when the ack carried no counts', () => {
    renderSection(snapshot(), {
      reindexResults: { '/Users/x/Projects/chroxy': { counts: null, error: null, at: NOW } },
    })
    expect(screen.getByTestId('integration-reindex-result-chroxy').textContent?.toLowerCase()).toContain('reindexed')
  })

  it('renders the inline error from an INTEGRATION_ACTION_FAILED reply', () => {
    renderSection(snapshot(), {
      reindexResults: { '/Users/x/Projects/chroxy': { counts: null, error: 'The host is busy', at: NOW } },
    })
    expect(screen.getByTestId('integration-reindex-error-chroxy').textContent).toContain('The host is busy')
  })
})

describe('formatBytes', () => {
  it('formats B / KB / MB buckets', () => {
    expect(formatBytes(96)).toBe('96 B')
    expect(formatBytes(421888)).toBe('412 KB')
    expect(formatBytes(2314240)).toBe('2.2 MB')
    expect(formatBytes(-1)).toBe('—')
  })
})
