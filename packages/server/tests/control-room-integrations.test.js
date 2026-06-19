import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRepoMemoryConfig,
  parseRepoMemoryReport,
  resolveRepoMemoryBin,
  surveyIntegrations,
  CLI_MISSING_NOTE,
  // #5501: repo-relay observability.
  parseRelayPin,
  parseRelayRuns,
  compareVersions,
  computeRelayFailureStreak,
  classifyRelay,
  GH_MISSING_NOTE,
  NO_GITHUB_REMOTE_REASON,
  RELAY_RELEASE_CACHE_TTL_MS,
  _clearRelayReleaseCache,
} from '../src/control-room/integrations.js'
import { validateConfig } from '../src/config.js'
import { ServerIntegrationStatusSnapshotSchema } from '@chroxy/protocol'

/**
 * Tests for the Control Room Integrations survey (#5499, epic #5498).
 *
 * Every fs/exec interaction is injected (`_readFile` / `_stat` / `_execFile`)
 * so nothing here touches the real disk, PATH, or any repo-memory install.
 */

// Verified against `repo-memory report --json --diagnostics` from
// @blamechris/repo-memory 0.15.0.
const SAMPLE_REPORT_JSON = JSON.stringify({
  period: 'all',
  totalEvents: 120,
  cacheHits: 90,
  cacheMisses: 30,
  cacheHitRatio: 0.75,
  estimatedTokensSaved: 48211,
  topFiles: [],
  eventBreakdown: { cache_hit: 90, cache_miss: 30 },
  diagnostics: {
    cacheEntryCount: 1391,
    staleEntryCount: 2,
    dbFileSizeBytes: 2310144,
    cacheAgeDistribution: { '< 1 day': 1391, '1-7 days': 0, '7-30 days': 0, '> 30 days': 0 },
  },
})

describe('parseRepoMemoryConfig', () => {
  it('parses summarizer and enabled tool groups', () => {
    const parsed = parseRepoMemoryConfig(JSON.stringify({
      summarizer: 'ast',
      tools: { telemetry: true, graph: false, search: true },
    }))
    assert.deepEqual(parsed, { summarizer: 'ast', toolGroups: ['search', 'telemetry'] })
  })

  it('tolerates a config with no tools map / no summarizer', () => {
    assert.deepEqual(parseRepoMemoryConfig('{}'), { summarizer: null, toolGroups: [] })
  })

  it('strips a leading BOM', () => {
    assert.deepEqual(parseRepoMemoryConfig('﻿{"summarizer":"ast"}'), { summarizer: 'ast', toolGroups: [] })
  })

  it('returns null for absent / unparseable / non-object input', () => {
    assert.equal(parseRepoMemoryConfig(null), null)
    assert.equal(parseRepoMemoryConfig('not json'), null)
    assert.equal(parseRepoMemoryConfig('[1,2]'), null)
  })
})

describe('parseRepoMemoryReport', () => {
  it('distils the CLI report JSON into the protocol shape', () => {
    const report = parseRepoMemoryReport(SAMPLE_REPORT_JSON)
    assert.deepEqual(report, {
      totalEvents: 120,
      cacheHits: 90,
      cacheMisses: 30,
      cacheHitRatio: 0.75,
      estimatedTokensSaved: 48211,
      cacheEntryCount: 1391,
      staleEntryCount: 2,
      lastActivity: null,
      // #5681 — absent on the 0.15.0 sample (pre-0.17.0), defaults to [].
      topMissedQueries: [],
    })
  })

  it('maps topMissedQueries (#5681) and drops malformed entries', () => {
    const report = parseRepoMemoryReport(JSON.stringify({
      totalEvents: 10, cacheHits: 3, cacheMisses: 7, cacheHitRatio: 0.3, estimatedTokensSaved: 0,
      topMissedQueries: [
        { query: 'websocket reconnect', count: 3 },
        { query: 'oauth refresh', count: 1.9 },     // count truncated to 1
        { query: 'no count' },                        // dropped (count missing)
        { count: 2 },                                 // dropped (query missing)
        { query: 5, count: 2 },                       // dropped (query not a string)
        { query: 'negative', count: -1 },             // dropped (count negative)
        'not an object',                              // dropped
      ],
    }))
    assert.deepEqual(report.topMissedQueries, [
      { query: 'websocket reconnect', count: 3 },
      { query: 'oauth refresh', count: 1 },
    ])
  })

  it('defaults topMissedQueries to [] when absent or not an array (#5681)', () => {
    const absent = parseRepoMemoryReport(JSON.stringify({ totalEvents: 1, cacheHits: 1, cacheMisses: 0, cacheHitRatio: 1, estimatedTokensSaved: 5 }))
    assert.deepEqual(absent.topMissedQueries, [])
    const wrongType = parseRepoMemoryReport(JSON.stringify({ totalEvents: 1, cacheHits: 1, cacheMisses: 0, cacheHitRatio: 1, estimatedTokensSaved: 5, topMissedQueries: 'nope' }))
    assert.deepEqual(wrongType.topMissedQueries, [])
  })

  it('tolerates a missing diagnostics block (entry counts null)', () => {
    const report = parseRepoMemoryReport(JSON.stringify({ totalEvents: 1, cacheHits: 1, cacheMisses: 0, cacheHitRatio: 1, estimatedTokensSaved: 5 }))
    assert.equal(report.cacheEntryCount, null)
    assert.equal(report.staleEntryCount, null)
  })

  it('tolerates missing numeric fields (defaults to 0) and clamps the ratio', () => {
    const report = parseRepoMemoryReport('{"cacheHitRatio": 1.5}')
    assert.equal(report.totalEvents, 0)
    assert.equal(report.estimatedTokensSaved, 0)
    assert.equal(report.cacheHitRatio, 1)
  })

  it('derives lastActivity from a future-version timestamp field when present', () => {
    const epoch = Date.parse('2026-06-09T22:00:00.000Z')
    const fromNumber = parseRepoMemoryReport(JSON.stringify({ lastEventAt: epoch }))
    assert.equal(fromNumber.lastActivity, '2026-06-09T22:00:00.000Z')
    const fromString = parseRepoMemoryReport(JSON.stringify({ lastActivity: '2026-06-09T22:00:00.000Z' }))
    assert.equal(fromString.lastActivity, '2026-06-09T22:00:00.000Z')
  })

  it('returns null for absent / unparseable / non-object output', () => {
    assert.equal(parseRepoMemoryReport(null), null)
    assert.equal(parseRepoMemoryReport('boom'), null)
    assert.equal(parseRepoMemoryReport('[]'), null)
  })
})

describe('resolveRepoMemoryBin', () => {
  it('returns the explicit override without probing', async () => {
    let probed = false
    const execFn = async () => { probed = true; return { stdout: '' } }
    assert.equal(await resolveRepoMemoryBin(execFn, '/opt/bin/repo-memory'), '/opt/bin/repo-memory')
    assert.equal(probed, false)
  })

  it('probes `which repo-memory` and trims the result', async () => {
    const calls = []
    const execFn = async (file, args) => { calls.push([file, args]); return { stdout: '/usr/local/bin/repo-memory\n' } }
    assert.equal(await resolveRepoMemoryBin(execFn), '/usr/local/bin/repo-memory')
    assert.deepEqual(calls[0], ['which', ['repo-memory']])
  })

  it('resolves null when the probe fails or finds nothing', async () => {
    assert.equal(await resolveRepoMemoryBin(async () => { throw new Error('not found') }), null)
    assert.equal(await resolveRepoMemoryBin(async () => ({ stdout: '\n' })), null)
  })
})

// ---------------------------------------------------------------------------
// surveyIntegrations — orchestration with injected fs/exec fakes.
// ---------------------------------------------------------------------------

const CONFIG_JSON = JSON.stringify({ summarizer: 'ast', tools: { telemetry: true } })

/**
 * Build an injected-fs world:
 *   files:  path -> string contents (readFile resolves these, rejects others)
 *   stats:  path -> { size, mtimeMs } (stat resolves these, rejects others)
 *   exec:   (file, args) -> { stdout } or throws
 */
function makeWorld({ files = {}, stats = {}, exec } = {}) {
  const execCalls = []
  return {
    execCalls,
    opts: {
      root: '/home/user/Projects',
      _readFile: async (p) => {
        if (p in files) return files[p]
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      },
      _stat: async (p) => {
        if (p in stats) return stats[p]
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      },
      _execFile: async (file, args, o) => {
        execCalls.push([file, args])
        if (exec) return exec(file, args, o)
        if (file === 'which') {
          if (args[0] === 'repo-memory') return { stdout: '/usr/local/bin/repo-memory\n' }
          if (args[0] === 'gh') return { stdout: '/usr/local/bin/gh\n' }
          throw new Error(`which: no ${args[0]}`)
        }
        if (file === 'git') return { stdout: 'git@github.com:blamechris/chroxy.git\n' }
        if (file === '/usr/local/bin/gh') {
          if (args[0] === 'api') return { stdout: JSON.stringify({ tag_name: 'v1.1.0' }) }
          if (args[0] === 'run') return { stdout: '[]' }
          throw new Error(`unexpected gh invocation: ${args.join(' ')}`)
        }
        return { stdout: SAMPLE_REPORT_JSON }
      },
      _now: () => new Date('2026-06-10T12:00:00.000Z'),
    },
  }
}

const REPO_A = { name: 'chroxy', path: '/home/user/Projects/chroxy' }
const REPO_B = { name: 'scratch', path: '/home/user/Projects/scratch' }

const MTIME = Date.parse('2026-06-09T22:00:00.000Z')

function configuredWorld(extra = {}) {
  return makeWorld({
    files: { '/home/user/Projects/chroxy/.repo-memory.json': CONFIG_JSON },
    stats: {
      '/home/user/Projects/chroxy/.repo-memory/cache.db': { size: 2310144, mtimeMs: MTIME - 1000 },
      '/home/user/Projects/chroxy/.repo-memory/cache.db-wal': { size: 4096, mtimeMs: MTIME },
    },
    ...extra,
  })
}

describe('surveyIntegrations (#5499)', () => {
  it('produces a schema-conformant snapshot for a configured repo with a live cache', async () => {
    const world = configuredWorld()
    const snapshot = await surveyIntegrations([REPO_A, REPO_B], world.opts)

    const parsed = ServerIntegrationStatusSnapshotSchema.safeParse({ type: 'integration_status_snapshot', ...snapshot })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

    assert.equal(snapshot.generatedAt, '2026-06-10T12:00:00.000Z')
    assert.equal(snapshot.root, '/home/user/Projects')
    assert.deepEqual(snapshot.summary, {
      total: 2, configured: 1, notConfigured: 1, degraded: 0,
      relayInstalled: 0, relayFailing: 0, relayDrifted: 0,
    })

    const [a, b] = snapshot.repos
    assert.equal(a.name, 'chroxy')
    assert.equal(a.repoMemory.configured, true)
    assert.equal(a.repoMemory.summarizer, 'ast')
    assert.deepEqual(a.repoMemory.toolGroups, ['telemetry'])
    // Cache size includes the -wal sidecar; lastModified is the newest mtime.
    assert.deepEqual(a.repoMemory.cache, { present: true, sizeBytes: 2310144 + 4096, lastModified: '2026-06-09T22:00:00.000Z' })
    assert.equal(a.repoMemory.report.cacheHitRatio, 0.75)
    assert.equal(a.repoMemory.report.estimatedTokensSaved, 48211)
    assert.equal(a.repoMemory.reason, null)

    // Unconfigured repo: quiet row, not an error.
    assert.equal(b.name, 'scratch')
    assert.deepEqual(b.repoMemory, { configured: false, summarizer: null, toolGroups: [], cache: null, report: null, reason: null })

    assert.deepEqual(snapshot.repoMemoryCli, { found: true, path: '/usr/local/bin/repo-memory', note: null })
  })

  it('probes the binary exactly ONCE per snapshot, not per repo', async () => {
    const world = configuredWorld()
    const manyConfigured = makeWorld({
      files: {
        '/home/user/Projects/a/.repo-memory.json': CONFIG_JSON,
        '/home/user/Projects/b/.repo-memory.json': CONFIG_JSON,
        '/home/user/Projects/c/.repo-memory.json': CONFIG_JSON,
      },
    })
    await surveyIntegrations([
      { name: 'a', path: '/home/user/Projects/a' },
      { name: 'b', path: '/home/user/Projects/b' },
      { name: 'c', path: '/home/user/Projects/c' },
    ], manyConfigured.opts)
    const whichCalls = manyConfigured.execCalls.filter(([file, args]) => file === 'which' && args[0] === 'repo-memory')
    assert.equal(whichCalls.length, 1, 'exactly one binary probe per snapshot')
    // #5501: the gh probe is also once-per-snapshot.
    const ghProbes = manyConfigured.execCalls.filter(([file, args]) => file === 'which' && args[0] === 'gh')
    assert.equal(ghProbes.length, 1, 'exactly one gh probe per snapshot')
    void world
  })

  it('runs the report command against each configured repo root', async () => {
    const world = configuredWorld()
    await surveyIntegrations([REPO_A, REPO_B], world.opts)
    const reportCalls = world.execCalls.filter(([file]) => file === '/usr/local/bin/repo-memory')
    assert.equal(reportCalls.length, 1, 'no CLI call for the unconfigured repo')
    assert.deepEqual(reportCalls[0][1], ['report', '/home/user/Projects/chroxy', '--json', '--diagnostics'])
  })

  it('missing binary → every configured repo degrades with a reason + snapshot-level note', async () => {
    const world = configuredWorld({
      exec: async (file) => {
        if (file === 'which') throw new Error('which: no repo-memory')
        throw new Error('should never run the report without a binary')
      },
    })
    const snapshot = await surveyIntegrations([REPO_A, REPO_B], world.opts)

    assert.equal(snapshot.repoMemoryCli.found, false)
    assert.equal(snapshot.repoMemoryCli.path, null)
    assert.equal(snapshot.repoMemoryCli.note, CLI_MISSING_NOTE)

    const [a, b] = snapshot.repos
    assert.equal(a.repoMemory.report, null)
    assert.equal(a.repoMemory.reason, CLI_MISSING_NOTE)
    // Config + cache cells still populate — only the CLI-derived cells degrade.
    assert.equal(a.repoMemory.configured, true)
    assert.equal(a.repoMemory.cache.present, true)
    // The unconfigured repo stays a quiet row (no reason).
    assert.equal(b.repoMemory.reason, null)

    assert.deepEqual(snapshot.summary, {
      total: 2, configured: 1, notConfigured: 1, degraded: 1,
      relayInstalled: 0, relayFailing: 0, relayDrifted: 0,
    })

    const parsed = ServerIntegrationStatusSnapshotSchema.safeParse({ type: 'integration_status_snapshot', ...snapshot })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })

  it('a per-repo CLI failure degrades that repo only — never the snapshot', async () => {
    const world = configuredWorld({
      exec: async (file, args) => {
        if (file === 'which') return { stdout: '/usr/local/bin/repo-memory\n' }
        if (args[1] === '/home/user/Projects/chroxy') {
          throw Object.assign(new Error('Command failed'), { stderr: 'repo-memory report: database is locked\n' })
        }
        return { stdout: SAMPLE_REPORT_JSON }
      },
    })
    const snapshot = await surveyIntegrations([REPO_A, REPO_B], world.opts)

    const [a] = snapshot.repos
    assert.equal(a.repoMemory.report, null)
    assert.match(a.repoMemory.reason, /database is locked/)
    assert.equal(snapshot.summary.degraded, 1)

    const parsed = ServerIntegrationStatusSnapshotSchema.safeParse({ type: 'integration_status_snapshot', ...snapshot })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })

  it('unparseable report output degrades the cell with a reason', async () => {
    const world = configuredWorld({
      exec: async (file) => {
        if (file === 'which') return { stdout: '/usr/local/bin/repo-memory\n' }
        return { stdout: 'Token report for /x (all recorded events)\n' }
      },
    })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    assert.equal(snapshot.repos[0].repoMemory.report, null)
    assert.match(snapshot.repos[0].repoMemory.reason, /unparseable/)
  })

  it('configured repo with no cache file yet → present: false, sizeBytes 0', async () => {
    const world = makeWorld({
      files: { '/home/user/Projects/chroxy/.repo-memory.json': CONFIG_JSON },
    })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    assert.deepEqual(snapshot.repos[0].repoMemory.cache, { present: false, sizeBytes: 0, lastModified: null })
  })

  it('cache without a -wal sidecar still stats cleanly', async () => {
    const world = makeWorld({
      files: { '/home/user/Projects/chroxy/.repo-memory.json': CONFIG_JSON },
      stats: { '/home/user/Projects/chroxy/.repo-memory/cache.db': { size: 1024, mtimeMs: MTIME } },
    })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    assert.deepEqual(snapshot.repos[0].repoMemory.cache, { present: true, sizeBytes: 1024, lastModified: '2026-06-09T22:00:00.000Z' })
  })

  it('an unparseable config still counts as configured (file exists) with null summarizer', async () => {
    const world = makeWorld({
      files: { '/home/user/Projects/chroxy/.repo-memory.json': 'not json' },
      exec: async (file) => {
        if (file === 'which') return { stdout: '/usr/local/bin/repo-memory\n' }
        return { stdout: SAMPLE_REPORT_JSON }
      },
    })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const rm = snapshot.repos[0].repoMemory
    assert.equal(rm.configured, true)
    assert.equal(rm.summarizer, null)
    assert.deepEqual(rm.toolGroups, [])
  })

  it('uses the explicit bin override without probing the PATH', async () => {
    const world = configuredWorld()
    const snapshot = await surveyIntegrations([REPO_A], { ...world.opts, bin: '/opt/custom/repo-memory' })
    assert.equal(world.execCalls.filter(([file, args]) => file === 'which' && args[0] === 'repo-memory').length, 0)
    assert.equal(snapshot.repoMemoryCli.path, '/opt/custom/repo-memory')
    assert.ok(world.execCalls.some(([file]) => file === '/opt/custom/repo-memory'))
  })

  it('an empty repo set is a valid empty snapshot', async () => {
    const world = makeWorld()
    const snapshot = await surveyIntegrations([], world.opts)
    assert.deepEqual(snapshot.repos, [])
    assert.deepEqual(snapshot.summary, {
      total: 0, configured: 0, notConfigured: 0, degraded: 0,
      relayInstalled: 0, relayFailing: 0, relayDrifted: 0,
    })
    const parsed = ServerIntegrationStatusSnapshotSchema.safeParse({ type: 'integration_status_snapshot', ...snapshot })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })
})

// ---------------------------------------------------------------------------
// #5501 — repo-relay observability: pure helpers.
// ---------------------------------------------------------------------------

// Chroxy's own live workflow form: sha-pinned with a version comment.
const USES_SHA_COMMENT = '      - uses: blamechris/repo-relay@f08840b9c336b50f6aef8d6e157d8f7e705fa875 # v1.1.0'

function workflowWith(usesLine) {
  return [
    'name: Repo Relay',
    'on:',
    '  pull_request:',
    'jobs:',
    '  notify:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4',
    usesLine,
    '        with:',
    '          discord_bot_token: x',
    '',
  ].join('\n')
}

describe('parseRelayPin (#5501)', () => {
  it('parses a tag pin', () => {
    assert.deepEqual(
      parseRelayPin(workflowWith('      - uses: blamechris/repo-relay@v1.1.0')),
      { ref: 'v1.1.0', sha: null, version: 'v1.1.0' },
    )
  })

  it('parses a sha pin with a version comment (chroxy live form)', () => {
    assert.deepEqual(parseRelayPin(workflowWith(USES_SHA_COMMENT)), {
      ref: 'f08840b9c336b50f6aef8d6e157d8f7e705fa875',
      sha: 'f08840b9c336b50f6aef8d6e157d8f7e705fa875',
      version: 'v1.1.0',
    })
  })

  it('parses a bare sha pin (no comment) with version null', () => {
    assert.deepEqual(
      parseRelayPin(workflowWith('      - uses: blamechris/repo-relay@f08840b9c336b50f6aef8d6e157d8f7e705fa875')),
      { ref: 'f08840b9c336b50f6aef8d6e157d8f7e705fa875', sha: 'f08840b9c336b50f6aef8d6e157d8f7e705fa875', version: null },
    )
  })

  it('a branch pin yields neither sha nor version', () => {
    assert.deepEqual(
      parseRelayPin(workflowWith('      - uses: blamechris/repo-relay@main')),
      { ref: 'main', sha: null, version: null },
    )
  })

  it('tolerates quotes around the uses value', () => {
    const pin = parseRelayPin(workflowWith("      - uses: 'blamechris/repo-relay@v1.0.2'"))
    assert.deepEqual(pin, { ref: 'v1.0.2', sha: null, version: 'v1.0.2' })
  })

  it('does not match the cache action pin (other uses lines)', () => {
    const pin = parseRelayPin(workflowWith('      - uses: blamechris/repo-relay@v1.1.0'))
    assert.equal(pin.ref, 'v1.1.0')
  })

  it('returns null when there is no repo-relay uses line / empty input', () => {
    assert.equal(parseRelayPin(workflowWith('      - uses: actions/checkout@v4')), null)
    assert.equal(parseRelayPin(''), null)
    assert.equal(parseRelayPin(null), null)
  })
})

describe('compareVersions (#5501)', () => {
  it('orders semver tags, with or without the v prefix', () => {
    assert.equal(compareVersions('v1.0.0', 'v1.1.0'), -1)
    assert.equal(compareVersions('v1.1.0', 'v1.0.9'), 1)
    assert.equal(compareVersions('1.1.0', 'v1.1.0'), 0)
    assert.equal(compareVersions('v1.1', 'v1.1.0'), 0)
    assert.equal(compareVersions('v2.0.0', 'v10.0.0'), -1)
  })

  it('returns null for unparseable versions', () => {
    assert.equal(compareVersions('main', 'v1.1.0'), null)
    assert.equal(compareVersions('v1.1.0', null), null)
  })
})

describe('parseRelayRuns (#5501)', () => {
  it('parses gh run list JSON into the protocol run shape (createdAt normalised to ISO)', () => {
    const runs = parseRelayRuns(JSON.stringify([
      { status: 'completed', conclusion: 'success', event: 'pull_request', createdAt: '2026-06-09T22:00:00Z', databaseId: 123 },
      { status: 'in_progress', conclusion: null, event: 'issues', createdAt: '2026-06-09T21:00:00Z', databaseId: 122 },
    ]))
    assert.deepEqual(runs, [
      { databaseId: 123, status: 'completed', conclusion: 'success', event: 'pull_request', createdAt: '2026-06-09T22:00:00.000Z' },
      { databaseId: 122, status: 'in_progress', conclusion: null, event: 'issues', createdAt: '2026-06-09T21:00:00.000Z' },
    ])
  })

  it('drops entries without a numeric databaseId', () => {
    const runs = parseRelayRuns(JSON.stringify([{ status: 'completed' }, { databaseId: 5 }]))
    assert.deepEqual(runs, [{ databaseId: 5, status: null, conclusion: null, event: null, createdAt: null }])
  })

  it('returns null for absent / unparseable / non-array output', () => {
    assert.equal(parseRelayRuns(null), null)
    assert.equal(parseRelayRuns('boom'), null)
    assert.equal(parseRelayRuns('{}'), null)
  })
})

describe('computeRelayFailureStreak (#5501)', () => {
  const run = (conclusion) => ({ databaseId: 1, status: 'completed', conclusion, event: null, createdAt: null })

  it('counts consecutive failures from the most recent run backwards', () => {
    assert.equal(computeRelayFailureStreak([run('failure'), run('failure'), run('success')]), 2)
  })

  it('a leading success means streak 0', () => {
    assert.equal(computeRelayFailureStreak([run('success'), run('failure')]), 0)
  })

  it('skips in-progress (unconcluded) runs without breaking the streak', () => {
    assert.equal(computeRelayFailureStreak([run(null), run('failure'), run('failure')]), 2)
  })

  it('a non-failure conclusion (cancelled) breaks the streak', () => {
    assert.equal(computeRelayFailureStreak([run('failure'), run('cancelled'), run('failure')]), 1)
  })

  it('empty / missing runs → 0', () => {
    assert.equal(computeRelayFailureStreak([]), 0)
    assert.equal(computeRelayFailureStreak(null), 0)
  })
})

describe('classifyRelay (#5501)', () => {
  const run = (conclusion) => ({ databaseId: 1, status: 'completed', conclusion, event: null, createdAt: null })

  it('not installed wins everything', () => {
    assert.equal(classifyRelay({ installed: false, pinnedVersion: 'v1.0.0', latestVersion: 'v1.1.0', runs: [run('failure')] }), 'not_installed')
  })

  it('latest concluded run failed → failing (wins over drift)', () => {
    assert.equal(classifyRelay({ installed: true, pinnedVersion: 'v1.0.0', latestVersion: 'v1.1.0', runs: [run('failure')] }), 'failing')
  })

  it('skips an in-progress run when finding the latest concluded one', () => {
    assert.equal(classifyRelay({ installed: true, pinnedVersion: 'v1.1.0', latestVersion: 'v1.1.0', runs: [run(null), run('failure')] }), 'failing')
  })

  it('pinned < latest → drifted (wins over ok)', () => {
    assert.equal(classifyRelay({ installed: true, pinnedVersion: 'v1.0.0', latestVersion: 'v1.1.0', runs: [run('success')] }), 'drifted')
  })

  it('latest concluded run success, no drift → ok', () => {
    assert.equal(classifyRelay({ installed: true, pinnedVersion: 'v1.1.0', latestVersion: 'v1.1.0', runs: [run('success')] }), 'ok')
  })

  it('unresolvable pin cannot drift — falls through to the runs verdict', () => {
    assert.equal(classifyRelay({ installed: true, pinnedVersion: null, latestVersion: 'v1.1.0', runs: [run('success')] }), 'ok')
  })

  it('no concluded runs and no drift signal → unknown', () => {
    assert.equal(classifyRelay({ installed: true, pinnedVersion: 'v1.1.0', latestVersion: 'v1.1.0', runs: [] }), 'unknown')
    assert.equal(classifyRelay({ installed: true, pinnedVersion: null, latestVersion: null, runs: [run(null)] }), 'unknown')
  })
})

// ---------------------------------------------------------------------------
// #5501 — surveyIntegrations: repoRelay block with injected gh fakes.
// ---------------------------------------------------------------------------

const RUNS_OK = [
  { status: 'completed', conclusion: 'success', event: 'pull_request', createdAt: '2026-06-10T11:00:00Z', databaseId: 9001 },
  { status: 'completed', conclusion: 'success', event: 'issues', createdAt: '2026-06-10T10:00:00Z', databaseId: 9000 },
]
const RUNS_FAILING = [
  { status: 'completed', conclusion: 'failure', event: 'pull_request', createdAt: '2026-06-10T11:00:00Z', databaseId: 9003 },
  { status: 'completed', conclusion: 'failure', event: 'issues', createdAt: '2026-06-10T10:00:00Z', databaseId: 9002 },
  { status: 'completed', conclusion: 'success', event: 'release', createdAt: '2026-06-10T09:00:00Z', databaseId: 9001 },
]

const WORKFLOW_PATH = '/home/user/Projects/chroxy/.github/workflows/repo-relay.yml'

/**
 * Injected-exec world for relay tests: configurable workflow file, git remote,
 * `gh run list` runs, and `gh api releases/latest` payload.
 */
function relayWorld({
  usesLine = '      - uses: blamechris/repo-relay@v1.1.0',
  files = {},
  remote = 'git@github.com:blamechris/chroxy.git\n',
  runsJson = JSON.stringify(RUNS_OK),
  latestJson = JSON.stringify({ tag_name: 'v1.1.0' }),
  ghFound = true,
  onExec,
} = {}) {
  const worldFiles = usesLine === null ? { ...files } : { [WORKFLOW_PATH]: workflowWith(usesLine), ...files }
  return makeWorld({
    files: worldFiles,
    exec: async (file, args) => {
      if (onExec) {
        const handled = onExec(file, args)
        if (handled !== undefined) return handled
      }
      if (file === 'which') {
        if (args[0] === 'gh') {
          if (!ghFound) throw new Error('which: no gh')
          return { stdout: '/usr/local/bin/gh\n' }
        }
        if (args[0] === 'repo-memory') throw new Error('which: no repo-memory')
        throw new Error(`which: no ${args[0]}`)
      }
      if (file === 'git' && args[0] === 'remote') {
        if (remote === null) throw new Error('fatal: no such remote')
        return { stdout: remote }
      }
      if (file === '/usr/local/bin/gh') {
        if (args[0] === 'api') return { stdout: latestJson }
        if (args[0] === 'run') return { stdout: runsJson }
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
    },
  })
}

describe('surveyIntegrations repoRelay (#5501)', () => {
  beforeEach(() => _clearRelayReleaseCache())

  it('installed + latest run success + up-to-date pin → ok, schema-conformant', async () => {
    const world = relayWorld()
    const snapshot = await surveyIntegrations([REPO_A], world.opts)

    const parsed = ServerIntegrationStatusSnapshotSchema.safeParse({ type: 'integration_status_snapshot', ...snapshot })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

    const relay = snapshot.repos[0].repoRelay
    assert.equal(relay.installed, true)
    assert.equal(relay.verdict, 'ok')
    assert.equal(relay.pinnedVersion, 'v1.1.0')
    assert.equal(relay.pinnedSha, null)
    assert.equal(relay.latestVersion, 'v1.1.0')
    assert.equal(relay.failureStreak, 0)
    assert.equal(relay.driftUnknown, false)
    assert.equal(relay.reason, null)
    assert.equal(relay.workflowUrl, 'https://github.com/blamechris/chroxy/actions/workflows/repo-relay.yml')
    // Run ids + conclusions ride along for #5502's rerun action.
    assert.deepEqual(relay.runs.map(r => [r.databaseId, r.conclusion]), [[9001, 'success'], [9000, 'success']])
    assert.equal(relay.runs[0].createdAt, '2026-06-10T11:00:00.000Z')

    assert.deepEqual(snapshot.ghCli, { found: true, path: '/usr/local/bin/gh', note: null })
    assert.equal(snapshot.summary.relayInstalled, 1)
    assert.equal(snapshot.summary.relayFailing, 0)
    assert.equal(snapshot.summary.relayDrifted, 0)
  })

  it('asks gh for the right run list (workflow, -R owner/repo from the git remote, limit 5)', async () => {
    const world = relayWorld()
    await surveyIntegrations([REPO_A], world.opts)
    const runCall = world.execCalls.find(([file, args]) => file === '/usr/local/bin/gh' && args[0] === 'run')
    assert.deepEqual(runCall[1], [
      'run', 'list', '--workflow=repo-relay.yml', '-R', 'blamechris/chroxy',
      '--limit', '5', '--json', 'status,conclusion,event,createdAt,databaseId',
    ])
  })

  it('latest concluded run failed → failing, with the failure streak counted', async () => {
    const world = relayWorld({ runsJson: JSON.stringify(RUNS_FAILING), latestJson: JSON.stringify({ tag_name: 'v1.2.0' }) })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    // failing wins over the simultaneous drift (v1.1.0 < v1.2.0).
    assert.equal(relay.verdict, 'failing')
    assert.equal(relay.failureStreak, 2)
    assert.equal(snapshot.summary.relayFailing, 1)
  })

  it('tag pin behind the latest release → drifted', async () => {
    const world = relayWorld({
      usesLine: '      - uses: blamechris/repo-relay@v1.0.0',
      latestJson: JSON.stringify({ tag_name: 'v1.1.0' }),
    })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    assert.equal(relay.verdict, 'drifted')
    assert.equal(relay.pinnedVersion, 'v1.0.0')
    assert.equal(relay.latestVersion, 'v1.1.0')
    assert.equal(snapshot.summary.relayDrifted, 1)
  })

  it('sha pin resolves drift via its version comment (chroxy live form)', async () => {
    const world = relayWorld({ usesLine: USES_SHA_COMMENT, latestJson: JSON.stringify({ tag_name: 'v1.2.0' }) })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    assert.equal(relay.pinnedSha, 'f08840b9c336b50f6aef8d6e157d8f7e705fa875')
    assert.equal(relay.pinnedVersion, 'v1.1.0')
    assert.equal(relay.verdict, 'drifted')
    assert.equal(relay.driftUnknown, false)
  })

  it('bare sha pin (no comment) → driftUnknown, never drifted', async () => {
    const world = relayWorld({
      usesLine: '      - uses: blamechris/repo-relay@f08840b9c336b50f6aef8d6e157d8f7e705fa875',
      latestJson: JSON.stringify({ tag_name: 'v9.9.9' }),
    })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    assert.equal(relay.pinnedVersion, null)
    assert.equal(relay.driftUnknown, true)
    assert.equal(relay.verdict, 'ok', 'runs are green — drift simply cannot be assessed')
  })

  it('no workflow file → quiet installed:false row, no gh calls for that repo', async () => {
    const world = relayWorld({ usesLine: null })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    assert.deepEqual(relay, {
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
    })
    assert.equal(world.execCalls.filter(([file]) => file === '/usr/local/bin/gh').length, 0)
    assert.equal(snapshot.summary.relayInstalled, 0)
  })

  it('makes exactly ONE releases/latest call regardless of installed repo count', async () => {
    const world = makeWorld({
      files: {
        '/home/user/Projects/a/.github/workflows/repo-relay.yml': workflowWith('      - uses: blamechris/repo-relay@v1.1.0'),
        '/home/user/Projects/b/.github/workflows/repo-relay.yml': workflowWith('      - uses: blamechris/repo-relay@v1.0.0'),
        '/home/user/Projects/c/.github/workflows/repo-relay.yml': workflowWith(USES_SHA_COMMENT),
      },
      exec: async (file, args) => {
        if (file === 'which' && args[0] === 'gh') return { stdout: '/usr/local/bin/gh\n' }
        if (file === 'which') throw new Error('not found')
        if (file === 'git') return { stdout: 'git@github.com:blamechris/x.git\n' }
        if (file === '/usr/local/bin/gh' && args[0] === 'api') return { stdout: JSON.stringify({ tag_name: 'v1.1.0' }) }
        if (file === '/usr/local/bin/gh' && args[0] === 'run') return { stdout: JSON.stringify(RUNS_OK) }
        throw new Error(`unexpected exec: ${file}`)
      },
    })
    await surveyIntegrations([
      { name: 'a', path: '/home/user/Projects/a' },
      { name: 'b', path: '/home/user/Projects/b' },
      { name: 'c', path: '/home/user/Projects/c' },
    ], world.opts)
    const apiCalls = world.execCalls.filter(([file, args]) => file === '/usr/local/bin/gh' && args[0] === 'api')
    assert.equal(apiCalls.length, 1, 'exactly one releases/latest call per snapshot')
    assert.deepEqual(apiCalls[0][1], ['api', 'repos/blamechris/repo-relay/releases/latest'])
  })

  it('caches the latest release across snapshots within the TTL, refetches after it', async () => {
    const t0 = Date.parse('2026-06-10T12:00:00.000Z')
    const makeAt = (ms) => {
      const world = relayWorld()
      world.opts._now = () => new Date(ms)
      return world
    }

    const first = makeAt(t0)
    await surveyIntegrations([REPO_A], first.opts)
    assert.equal(first.execCalls.filter(([f, a]) => f === '/usr/local/bin/gh' && a[0] === 'api').length, 1)

    // Second snapshot inside the TTL: served from the module cache, no call.
    const second = makeAt(t0 + RELAY_RELEASE_CACHE_TTL_MS - 1)
    const snapshot = await surveyIntegrations([REPO_A], second.opts)
    assert.equal(second.execCalls.filter(([f, a]) => f === '/usr/local/bin/gh' && a[0] === 'api').length, 0)
    assert.equal(snapshot.repos[0].repoRelay.latestVersion, 'v1.1.0')

    // Past the TTL: a fresh call.
    const third = makeAt(t0 + RELAY_RELEASE_CACHE_TTL_MS + 1)
    await surveyIntegrations([REPO_A], third.opts)
    assert.equal(third.execCalls.filter(([f, a]) => f === '/usr/local/bin/gh' && a[0] === 'api').length, 1)
  })

  it('gh missing → relay cells degrade with a reason, snapshot still returns', async () => {
    const world = relayWorld({ ghFound: false })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    assert.equal(relay.installed, true, 'installed is answered from the filesystem')
    assert.equal(relay.pinnedVersion, 'v1.1.0', 'the pin is answered from the filesystem')
    assert.equal(relay.latestVersion, null)
    assert.deepEqual(relay.runs, [])
    assert.equal(relay.reason, GH_MISSING_NOTE)
    assert.equal(relay.verdict, 'unknown')
    assert.deepEqual(snapshot.ghCli, { found: false, path: null, note: GH_MISSING_NOTE })

    const parsed = ServerIntegrationStatusSnapshotSchema.safeParse({ type: 'integration_status_snapshot', ...snapshot })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })

  it('rate-limited releases/latest degrades with the stderr reason; runs still populate', async () => {
    const world = relayWorld({
      onExec: (file, args) => {
        if (file === '/usr/local/bin/gh' && args[0] === 'api') {
          throw Object.assign(new Error('gh: HTTP 403'), { stderr: 'API rate limit exceeded for user\n' })
        }
        return undefined
      },
    })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    assert.equal(relay.latestVersion, null)
    assert.match(relay.reason, /rate limit/)
    // Runs were fetched fine — the verdict still reflects them.
    assert.equal(relay.verdict, 'ok')
    assert.equal(relay.runs.length, 2)
  })

  it('a rate-limited (failed) latest fetch is NOT cached — the next snapshot retries', async () => {
    let fail = true
    const world = relayWorld({
      onExec: (file, args) => {
        if (file === '/usr/local/bin/gh' && args[0] === 'api' && fail) {
          throw Object.assign(new Error('gh: HTTP 403'), { stderr: 'API rate limit exceeded\n' })
        }
        return undefined
      },
    })
    await surveyIntegrations([REPO_A], world.opts)
    fail = false
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    assert.equal(snapshot.repos[0].repoRelay.latestVersion, 'v1.1.0')
  })

  it('a failed run list degrades that repo with a reason; the snapshot survives', async () => {
    const world = relayWorld({
      onExec: (file, args) => {
        if (file === '/usr/local/bin/gh' && args[0] === 'run') {
          throw Object.assign(new Error('gh: network'), { stderr: 'error connecting to api.github.com\n' })
        }
        return undefined
      },
    })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    assert.deepEqual(relay.runs, [])
    assert.match(relay.reason, /api\.github\.com/)
    assert.equal(relay.verdict, 'unknown')
  })

  it('no GitHub remote → installed from the filesystem, run cells degrade, drift still assessable', async () => {
    const world = relayWorld({
      usesLine: '      - uses: blamechris/repo-relay@v1.0.0',
      remote: null,
      latestJson: JSON.stringify({ tag_name: 'v1.1.0' }),
    })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    assert.equal(relay.installed, true)
    assert.deepEqual(relay.runs, [])
    assert.equal(relay.workflowUrl, null)
    assert.equal(relay.reason, NO_GITHUB_REMOTE_REASON)
    // Pin (filesystem) + latest (repo-independent) are both known → drift holds.
    assert.equal(relay.verdict, 'drifted')
    assert.equal(world.execCalls.filter(([f, a]) => f === '/usr/local/bin/gh' && a[0] === 'run').length, 0)
  })

  it('an unparseable uses pin degrades with a reason and driftUnknown', async () => {
    const world = relayWorld({ usesLine: '      - uses: actions/checkout@v4' })
    const snapshot = await surveyIntegrations([REPO_A], world.opts)
    const relay = snapshot.repos[0].repoRelay
    assert.equal(relay.installed, true)
    assert.equal(relay.pinnedVersion, null)
    assert.equal(relay.pinnedSha, null)
    assert.equal(relay.driftUnknown, true)
    assert.match(relay.reason, /uses pin/)
  })
})

// ---------------------------------------------------------------------------
// controlRoomRepoMemoryBin — config-schema registration. Same posture as the
// worktreeGc config test: the key must be a known schema key (no "Unknown
// config key" warning, which claims the value "will be ignored" when the
// handler does read it) and the wrong type must warn.
// ---------------------------------------------------------------------------

describe('controlRoomRepoMemoryBin config key (#5499)', () => {
  it('is a known schema key (no unknown-key warning)', () => {
    const result = validateConfig({ controlRoomRepoMemoryBin: '/opt/bin/repo-memory' })
    const unknown = result.warnings.find(w => w.includes('Unknown config key') && w.includes('controlRoomRepoMemoryBin'))
    assert.equal(unknown, undefined)
    const typeWarn = result.warnings.find(w => w.includes("Invalid type for 'controlRoomRepoMemoryBin'"))
    assert.equal(typeWarn, undefined)
  })

  it('warns when the value is not a string', () => {
    const result = validateConfig({ controlRoomRepoMemoryBin: 42 })
    const typeWarn = result.warnings.find(w => w.includes("Invalid type for 'controlRoomRepoMemoryBin'"))
    assert.ok(typeWarn, 'expected a type warning for a non-string value')
  })
})
