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
import type { IntegrationRepo, RepoMemoryStatus, RepoRelayStatus, ServerIntegrationStatusSnapshotMessage } from '@chroxy/protocol'

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
      // #5502: relay Re-run action state.
      relayRerunningRepoPaths: new Set<string>(),
      relayRerunResults: {},
      sendRepoRelayRerun: () => false,
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

// ---------------------------------------------------------------------------
// #5501 — repo-relay columns.
// ---------------------------------------------------------------------------

function repoRelay(over: Partial<RepoRelayStatus> = {}): RepoRelayStatus {
  return {
    installed: true,
    pinnedVersion: 'v1.1.0',
    pinnedSha: null,
    latestVersion: 'v1.1.0',
    runs: [
      { databaseId: 9001, status: 'completed', conclusion: 'success', event: 'pull_request', createdAt: '2026-06-10T11:00:00.000Z' },
      { databaseId: 9000, status: 'completed', conclusion: 'success', event: 'issues', createdAt: '2026-06-10T10:00:00.000Z' },
    ],
    failureStreak: 0,
    verdict: 'ok',
    driftUnknown: false,
    workflowUrl: 'https://github.com/blamechris/chroxy/actions/workflows/repo-relay.yml',
    reason: null,
    ...over,
  }
}

const RELAY_NOT_INSTALLED: RepoRelayStatus = {
  installed: false,
  pinnedVersion: null,
  pinnedSha: null,
  latestVersion: null,
  runs: [],
  failureStreak: 0,
  verdict: 'not_installed',
  driftUnknown: false,
  workflowUrl: null,
  reason: null,
}

function relayRepo(name: string, relay: RepoRelayStatus | undefined): IntegrationRepo {
  return { name, path: `/p/${name}`, repoMemory: NOT_CONFIGURED, ...(relay !== undefined ? { repoRelay: relay } : {}) }
}

describe('IntegrationsSection — repo-relay (#5501)', () => {
  it('renders the grouped repo-memory / repo-relay column headers', () => {
    renderSection(snapshot())
    expect(screen.getByTestId('integration-group-memory').textContent).toBe('repo-memory')
    expect(screen.getByTestId('integration-group-relay').textContent).toBe('repo-relay')
  })

  it('renders the verdict chips with their accents', () => {
    renderSection(oneRepoSnapshot([
      relayRepo('green', repoRelay()),
      relayRepo('red', repoRelay({ verdict: 'failing', failureStreak: 2 })),
      relayRepo('stale', repoRelay({ verdict: 'drifted', pinnedVersion: 'v1.0.0' })),
      relayRepo('bare', RELAY_NOT_INSTALLED),
    ]))
    expect(screen.getByTestId('integration-relay-status-green').textContent).toBe('OK')
    expect(screen.getByTestId('integration-relay-status-green').getAttribute('data-accent')).toBe('ok')
    expect(screen.getByTestId('integration-relay-status-red').getAttribute('data-accent')).toBe('bad')
    expect(screen.getByTestId('integration-relay-status-stale').getAttribute('data-accent')).toBe('warn')
    expect(screen.getByTestId('integration-relay-status-bare').textContent).toBe('Not installed')
    expect(screen.getByTestId('integration-relay-status-bare').getAttribute('data-accent')).toBe('neutral')
  })

  it('an unknown verdict carries its degradation reason as tooltip', () => {
    renderSection(oneRepoSnapshot([
      relayRepo('island', repoRelay({ verdict: 'unknown', runs: [], reason: 'no GitHub remote' })),
    ]))
    expect(screen.getByTestId('integration-relay-status-island').getAttribute('title')).toContain('no GitHub remote')
  })

  it('version cell shows pinned → latest with a drift highlight when behind', () => {
    renderSection(oneRepoSnapshot([
      relayRepo('stale', repoRelay({ verdict: 'drifted', pinnedVersion: 'v1.0.0', latestVersion: 'v1.1.0' })),
    ]))
    const cell = screen.getByTestId('integration-relay-version-stale')
    expect(cell.textContent).toContain('v1.0.0 → v1.1.0')
    expect(cell.querySelector('.cr-warn')).toBeTruthy()
  })

  it('an up-to-date pin renders without the drift highlight', () => {
    renderSection(oneRepoSnapshot([relayRepo('green', repoRelay())]))
    const cell = screen.getByTestId('integration-relay-version-green')
    expect(cell.textContent).toContain('v1.1.0')
    expect(cell.querySelector('.cr-warn')).toBeNull()
  })

  it('a bare sha pin renders the short sha with a drift-unknown tooltip and the latest for context', () => {
    renderSection(oneRepoSnapshot([
      relayRepo('sha', repoRelay({
        pinnedVersion: null,
        pinnedSha: 'f08840b9c336b50f6aef8d6e157d8f7e705fa875',
        driftUnknown: true,
        verdict: 'ok',
      })),
    ]))
    const cell = screen.getByTestId('integration-relay-version-sha')
    expect(cell.textContent).toContain('f08840b')
    expect(cell.textContent).toContain('→ v1.1.0')
    expect(cell.getAttribute('title')?.toLowerCase()).toContain('drift')
  })

  it('a drift-unknown row prefers the per-repo reason as the tooltip (branch pin, unparseable uses line)', () => {
    renderSection(oneRepoSnapshot([
      relayRepo('branchy', repoRelay({
        pinnedVersion: null,
        pinnedSha: null,
        driftUnknown: true,
        verdict: 'ok',
        reason: 'could not parse the repo-relay uses pin from the workflow',
      })),
    ]))
    const cell = screen.getByTestId('integration-relay-version-branchy')
    expect(cell.getAttribute('title')).toContain('could not parse the repo-relay uses pin')
  })

  it('an equal-but-differently-formatted pin (no drift) renders without the → latest arrow', () => {
    // Server-side compareVersions treats v1.1 == v1.1.0 → verdict ok, no
    // driftUnknown. The cell must not suggest an upgrade is available.
    renderSection(oneRepoSnapshot([
      relayRepo('formatted', repoRelay({ pinnedVersion: 'v1.1', latestVersion: 'v1.1.0', verdict: 'ok' })),
    ]))
    const cell = screen.getByTestId('integration-relay-version-formatted')
    expect(cell.textContent).toBe('v1.1')
    expect(cell.textContent).not.toContain('→')
  })

  it('last-run cell shows the conclusion, age, and the Actions deep link', () => {
    renderSection(oneRepoSnapshot([relayRepo('green', repoRelay())]))
    const cell = screen.getByTestId('integration-relay-lastrun-green')
    expect(cell.textContent).toContain('success')
    expect(cell.textContent).toContain('1h ago')
    const link = screen.getByTestId('integration-relay-link-green') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://github.com/blamechris/chroxy/actions/workflows/repo-relay.yml')
  })

  it('streak cell shows the failure streak with the bad accent, "—" when clean', () => {
    renderSection(oneRepoSnapshot([
      relayRepo('red', repoRelay({ verdict: 'failing', failureStreak: 3 })),
      relayRepo('green', repoRelay()),
    ]))
    const streak = screen.getByTestId('integration-relay-streak-red')
    expect(streak.textContent).toContain('3')
    expect(streak.querySelector('.cr-bad')).toBeTruthy()
    expect(screen.getByTestId('integration-relay-streak-green').textContent).toBe('—')
  })

  it('a snapshot without repoRelay blocks (pre-#5501 producer) renders quiet relay cells', () => {
    renderSection(oneRepoSnapshot([relayRepo('legacy', undefined)]))
    expect(screen.getByTestId('integration-relay-status-legacy').textContent).toBe('Not installed')
    expect(screen.getByTestId('integration-relay-version-legacy').textContent).toBe('—')
    expect(screen.getByTestId('integration-relay-lastrun-legacy').textContent).toBe('—')
    expect(screen.getByTestId('integration-relay-streak-legacy').textContent).toBe('—')
  })

  it('renders the relay summary chips (defaulting to 0 for pre-#5501 summaries)', () => {
    renderSection(snapshot({
      summary: { total: 3, configured: 1, notConfigured: 2, degraded: 0, relayInstalled: 2, relayFailing: 1, relayDrifted: 1 },
    }))
    expect(screen.getByTestId('integration-chip-count-relayInstalled').textContent).toBe('2')
    expect(screen.getByTestId('integration-chip-count-relayFailing').textContent).toBe('1')
    expect(screen.getByTestId('integration-chip-count-relayDrifted').textContent).toBe('1')
    cleanup()
    renderSection(snapshot()) // summary without the relay keys
    expect(screen.getByTestId('integration-chip-count-relayFailing').textContent).toBe('0')
  })

  it('renders the gh-missing callout when the snapshot says gh was not found', () => {
    renderSection(snapshot({ ghCli: { found: false, path: null, note: 'gh CLI not found on PATH' } }))
    expect(screen.getByTestId('integration-gh-note').textContent).toContain('gh CLI not found on PATH')
  })

  it('renders no gh callout when gh was found', () => {
    renderSection(snapshot({ ghCli: { found: true, path: '/usr/local/bin/gh', note: null } }))
    expect(screen.queryByTestId('integration-gh-note')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// #5502 — repo-relay Re-run action (+ the upstream-blocked Sync now stub).
// ---------------------------------------------------------------------------

describe('IntegrationsSection — relay Re-run action (#5502)', () => {
  const FAILED_LATEST = repoRelay({
    verdict: 'failing',
    failureStreak: 1,
    runs: [
      { databaseId: 9001, status: 'completed', conclusion: 'failure', event: 'pull_request', createdAt: '2026-06-10T11:00:00.000Z' },
      { databaseId: 9000, status: 'completed', conclusion: 'success', event: 'issues', createdAt: '2026-06-10T10:00:00.000Z' },
    ],
  })

  it('renders a Re-run button only when the latest run concluded failure', () => {
    renderSection(oneRepoSnapshot([
      relayRepo('red', FAILED_LATEST),
      relayRepo('green', repoRelay()),
      relayRepo('bare', RELAY_NOT_INSTALLED),
      // Latest run in progress (no conclusion) — older failure must not arm the button.
      relayRepo('running', repoRelay({
        runs: [
          { databaseId: 9002, status: 'in_progress', conclusion: null, event: 'pull_request', createdAt: '2026-06-10T11:30:00.000Z' },
          { databaseId: 9001, status: 'completed', conclusion: 'failure', event: 'pull_request', createdAt: '2026-06-10T11:00:00.000Z' },
        ],
      })),
    ]))
    expect(screen.getByTestId('integration-relay-rerun-red')).toBeTruthy()
    expect(screen.queryByTestId('integration-relay-rerun-green')).toBeNull()
    expect(screen.queryByTestId('integration-relay-rerun-bare')).toBeNull()
    expect(screen.queryByTestId('integration-relay-rerun-running')).toBeNull()
  })

  it('dispatches onRelayRerun with the repo path and the latest run id', () => {
    const onRelayRerun = vi.fn()
    renderSection(oneRepoSnapshot([relayRepo('red', FAILED_LATEST)]), { onRelayRerun })
    fireEvent.click(screen.getByTestId('integration-relay-rerun-red'))
    expect(onRelayRerun).toHaveBeenCalledWith('/p/red', 9001)
  })

  it('shows the pending "Re-running…" state, disabled, and does not re-dispatch', () => {
    const onRelayRerun = vi.fn()
    renderSection(oneRepoSnapshot([relayRepo('red', FAILED_LATEST)]), {
      onRelayRerun,
      relayRerunningRepoPaths: new Set(['/p/red']),
    })
    const btn = screen.getByTestId('integration-relay-rerun-red') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toContain('Re-running…')
    fireEvent.click(btn)
    expect(onRelayRerun).not.toHaveBeenCalled()
  })

  it('disables Re-run when disconnected', () => {
    renderSection(oneRepoSnapshot([relayRepo('red', FAILED_LATEST)]), { connected: false })
    expect((screen.getByTestId('integration-relay-rerun-red') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the "re-run requested" note (inviting a refresh) after the ack', () => {
    renderSection(oneRepoSnapshot([relayRepo('red', FAILED_LATEST)]), {
      relayRerunResults: { '/p/red': { error: null, at: NOW } },
    })
    const note = screen.getByTestId('integration-relay-rerun-result-red')
    expect(note.textContent?.toLowerCase()).toContain('re-run requested')
    expect(note.textContent?.toLowerCase()).toContain('refresh')
  })

  it('renders the inline error from an INTEGRATION_ACTION_FAILED reply', () => {
    renderSection(oneRepoSnapshot([relayRepo('red', FAILED_LATEST)]), {
      relayRerunResults: { '/p/red': { error: 'run 9001 did not fail (success)', at: NOW } },
    })
    expect(screen.getByTestId('integration-relay-rerun-error-red').textContent).toContain('did not fail')
  })

  it('renders a disabled Sync now stub naming the upstream blocker for installed repos', () => {
    renderSection(oneRepoSnapshot([
      relayRepo('red', FAILED_LATEST),
      relayRepo('green', repoRelay()),
      relayRepo('bare', RELAY_NOT_INSTALLED),
    ]))
    for (const name of ['red', 'green']) {
      const sync = screen.getByTestId(`integration-relay-syncnow-${name}`) as HTMLButtonElement
      expect(sync.disabled).toBe(true)
      expect(sync.getAttribute('title')).toContain('repo-relay#168')
    }
    expect(screen.queryByTestId('integration-relay-syncnow-bare')).toBeNull()
  })
})
