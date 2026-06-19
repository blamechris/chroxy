/**
 * #6133 (epic #5530) — Control Room containers & environments survey.
 *
 * Pins the parse/classify/orchestrate behaviour the WS handler + dashboard
 * build on:
 *   - deriveBackend across compose / docker / explicit-backend / unknown
 *   - parseByteSize (binary + decimal units) and parsePercent
 *   - parseDockerStats → id→{cpu,mem,memPercent} map
 *   - toContainerEntry projection (uptime, sessionCount, stats only when running)
 *   - summarize tally
 *   - surveyContainers end-to-end: stats enrichment, docker-absent degradation,
 *     empty/missing EnvironmentManager, schema validity
 *
 * NEVER calls real docker — all environment records + `docker stats` output are
 * canned via the `listEnvironments` / `_execFile` injection seams.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServerContainersStatusSnapshotSchema } from '@chroxy/protocol'
import {
  surveyContainers,
  deriveBackend,
  parseByteSize,
  parsePercent,
  parseDockerStats,
  toContainerEntry,
  summarize,
  collectDockerStats,
} from '../src/control-room/containers.js'

const NOW = new Date('2026-06-19T12:00:00.000Z')
const now = () => NOW

function env(overrides = {}) {
  return {
    id: 'env-1',
    name: 'web',
    cwd: '/Users/me/Projects/app',
    image: 'node:22-slim',
    containerId: 'abcdef123456789',
    status: 'running',
    sessions: ['s1', 's2'],
    createdAt: '2026-06-19T11:00:00.000Z',
    composeProject: null,
    ...overrides,
  }
}

describe('#6133 deriveBackend', () => {
  it('prefers an explicit backend field', () => {
    assert.equal(deriveBackend({ backend: 'k8s', containerId: 'x' }), 'k8s')
  })
  it('infers compose from composeProject', () => {
    assert.equal(deriveBackend({ composeProject: 'chroxy-1', containerId: 'x' }), 'compose')
  })
  it('infers docker from a bare containerId', () => {
    assert.equal(deriveBackend({ containerId: 'x' }), 'docker')
  })
  it('falls back to unknown', () => {
    assert.equal(deriveBackend({}), 'unknown')
    assert.equal(deriveBackend(null), 'unknown')
  })
})

describe('#6133 parseByteSize / parsePercent', () => {
  it('parses binary units', () => {
    assert.equal(parseByteSize('45.2MiB'), Math.round(45.2 * 1024 ** 2))
    assert.equal(parseByteSize('1.952GiB'), Math.round(1.952 * 1024 ** 3))
  })
  it('parses decimal units and bare bytes', () => {
    assert.equal(parseByteSize('3.4kB'), 3400)
    assert.equal(parseByteSize('512B'), 512)
    assert.equal(parseByteSize('512'), 512)
  })
  it('returns null on garbage', () => {
    assert.equal(parseByteSize('nope'), null)
    assert.equal(parseByteSize(undefined), null)
  })
  it('parses percentages', () => {
    assert.equal(parsePercent('2.26%'), 2.26)
    assert.equal(parsePercent('0.00%'), 0)
    assert.equal(parsePercent('x'), null)
  })
})

describe('#6133 parseDockerStats', () => {
  it('parses multi-line stats keyed by short id', () => {
    const out = [
      'abcdef123456|0.50%|45.2MiB / 1.952GiB|2.26%',
      'cafebabe9999|10.0%|512MiB / 2GiB|25.0%',
      '', // blank line tolerated
    ].join('\n')
    const m = parseDockerStats(out)
    assert.equal(m.size, 2)
    assert.deepEqual(m.get('abcdef123456'), {
      cpuPercent: 0.5,
      memBytes: Math.round(45.2 * 1024 ** 2),
      memPercent: 2.26,
    })
    assert.equal(m.get('cafebabe9999').memPercent, 25)
  })
  it('returns an empty map on non-string input', () => {
    assert.equal(parseDockerStats(undefined).size, 0)
  })
})

describe('#6133 toContainerEntry', () => {
  it('projects a running env with stats + uptime', () => {
    const statsById = new Map([['abcdef123456', { cpuPercent: 1, memBytes: 100, memPercent: 2 }]])
    const entry = toContainerEntry(env(), statsById, NOW)
    assert.equal(entry.id, 'env-1')
    assert.equal(entry.backend, 'docker')
    assert.equal(entry.sessionCount, 2)
    assert.equal(entry.uptimeMs, 60 * 60 * 1000) // 1h
    assert.deepEqual(entry.stats, { cpuPercent: 1, memBytes: 100, memPercent: 2 })
  })
  it('matches stats by short-id prefix of a full container id', () => {
    const statsById = new Map([['abcdef123456', { cpuPercent: 9, memBytes: 9, memPercent: 9 }]])
    const entry = toContainerEntry(env({ containerId: 'abcdef123456789beef' }), statsById, NOW)
    assert.equal(entry.stats.cpuPercent, 9)
  })
  it('never reports stats for a non-running container', () => {
    const statsById = new Map([['abcdef123456', { cpuPercent: 1, memBytes: 1, memPercent: 1 }]])
    const entry = toContainerEntry(env({ status: 'stopped' }), statsById, NOW)
    assert.equal(entry.stats, null)
  })
  it('tolerates missing fields', () => {
    const entry = toContainerEntry({ id: 'e' }, new Map(), NOW)
    assert.equal(entry.name, '')
    assert.equal(entry.image, null)
    assert.equal(entry.status, 'unknown')
    assert.equal(entry.uptimeMs, null)
    assert.equal(entry.sessionCount, 0)
  })
})

describe('#6133 summarize', () => {
  it('tallies by status bucket', () => {
    const s = summarize([
      { status: 'running' }, { status: 'running' },
      { status: 'stopped' }, { status: 'exited' }, { status: 'error' },
      { status: 'weird' },
    ])
    assert.deepEqual(s, { total: 6, running: 2, stopped: 3, other: 1 })
  })
})

describe('#6133 collectDockerStats', () => {
  it('returns an empty map without calling exec when there are no ids', async () => {
    let called = false
    const m = await collectDockerStats(async () => { called = true; return { stdout: '' } }, [])
    assert.equal(m.size, 0)
    assert.equal(called, false)
  })
  it('passes the container ids to docker stats', async () => {
    let args
    await collectDockerStats(async (_f, a) => { args = a; return { stdout: 'id1|1%|1MiB / 2GiB|1%' } }, ['id1'])
    assert.ok(args.includes('id1'))
    assert.ok(args.includes('--no-stream'))
  })
})

describe('#6133 surveyContainers (end-to-end)', () => {
  it('produces a schema-valid snapshot with stats for running containers', async () => {
    const execFile = async () => ({ stdout: 'abcdef123456|0.50%|45.2MiB / 1.952GiB|2.26%' })
    const snap = await surveyContainers({
      listEnvironments: () => [env()],
      _execFile: execFile,
      _now: now,
    })
    assert.equal(snap.containers.length, 1)
    assert.equal(snap.summary.running, 1)
    assert.equal(snap.containers[0].stats.cpuPercent, 0.5)
    assert.equal(snap.dockerStatsNote, null)
    // The handler adds `type`; validate the rest of the contract here.
    const parsed = ServerContainersStatusSnapshotSchema.safeParse({ type: 'containers_status_snapshot', ...snap })
    assert.ok(parsed.success, parsed.error && JSON.stringify(parsed.error.issues))
  })

  it('degrades to null stats + a note when docker stats fails', async () => {
    const execFile = async () => { throw new Error('docker: command not found') }
    const snap = await surveyContainers({
      listEnvironments: () => [env()],
      _execFile: execFile,
      _now: now,
    })
    assert.equal(snap.containers[0].stats, null)
    assert.match(snap.dockerStatsNote, /docker stats unavailable/)
    // Inventory still present despite the stats failure.
    assert.equal(snap.summary.total, 1)
  })

  it('does not probe docker when no container is running', async () => {
    let called = false
    const snap = await surveyContainers({
      listEnvironments: () => [env({ status: 'stopped' })],
      _execFile: async () => { called = true; return { stdout: '' } },
      _now: now,
    })
    assert.equal(called, false)
    assert.equal(snap.summary.stopped, 1)
    assert.equal(snap.dockerStatsNote, null)
  })

  it('returns a valid empty snapshot with no EnvironmentManager', async () => {
    const snap = await surveyContainers({ _now: now })
    assert.deepEqual(snap.summary, { total: 0, running: 0, stopped: 0, other: 0 })
    assert.deepEqual(snap.containers, [])
    const parsed = ServerContainersStatusSnapshotSchema.safeParse({ type: 'containers_status_snapshot', ...snap })
    assert.ok(parsed.success)
  })

  it('degrades to empty when listEnvironments throws', async () => {
    const snap = await surveyContainers({
      listEnvironments: () => { throw new Error('state read failed') },
      _now: now,
    })
    assert.equal(snap.summary.total, 0)
  })
})
