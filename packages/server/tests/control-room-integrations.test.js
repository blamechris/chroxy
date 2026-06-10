import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRepoMemoryConfig,
  parseRepoMemoryReport,
  resolveRepoMemoryBin,
  surveyIntegrations,
  CLI_MISSING_NOTE,
} from '../src/control-room/integrations.js'
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
    })
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
        if (file === 'which') return { stdout: '/usr/local/bin/repo-memory\n' }
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
    assert.deepEqual(snapshot.summary, { total: 2, configured: 1, notConfigured: 1, degraded: 0 })

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
    const whichCalls = manyConfigured.execCalls.filter(([file]) => file === 'which')
    assert.equal(whichCalls.length, 1, 'exactly one binary probe per snapshot')
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

    assert.deepEqual(snapshot.summary, { total: 2, configured: 1, notConfigured: 1, degraded: 1 })

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
    assert.equal(world.execCalls.filter(([file]) => file === 'which').length, 0)
    assert.equal(snapshot.repoMemoryCli.path, '/opt/custom/repo-memory')
    assert.equal(world.execCalls[0][0], '/opt/custom/repo-memory')
  })

  it('an empty repo set is a valid empty snapshot', async () => {
    const world = makeWorld()
    const snapshot = await surveyIntegrations([], world.opts)
    assert.deepEqual(snapshot.repos, [])
    assert.deepEqual(snapshot.summary, { total: 0, configured: 0, notConfigured: 0, degraded: 0 })
    const parsed = ServerIntegrationStatusSnapshotSchema.safeParse({ type: 'integration_status_snapshot', ...snapshot })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })
})
