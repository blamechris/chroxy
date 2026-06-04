import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ByokComposeStateStore,
  sweepOrphanedComposeStacks,
} from '../src/byok-compose-state.js'

/**
 * Tests for the docker-byok compose-project-id persistence store (#5081).
 *
 * The store mirrors EnvironmentManager's on-disk shape so a daemon crash
 * between `docker compose up` and `docker compose down` leaves an on-disk
 * paper trail. A boot-time `sweepOrphanedComposeStacks()` then runs
 * `docker compose down --remove-orphans` against every leftover project
 * id before any new sessions launch.
 */

let tmpDir
let statePath

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-byok-compose-state-'))
  statePath = join(tmpDir, 'byok-compose-state.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('ByokComposeStateStore', () => {
  it('starts empty when no state file exists', () => {
    const store = new ByokComposeStateStore({ statePath })
    assert.deepEqual(store.list(), [])
  })

  it('records a compose stack and persists it to disk', () => {
    const store = new ByokComposeStateStore({ statePath })
    store.record({
      projectId: 'chroxy-byok-abcdef',
      composeFile: '/proj/docker-compose.yml',
      cwd: '/work/proj',
    })
    assert.equal(existsSync(statePath), true)
    const raw = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.equal(raw.version, 1)
    assert.equal(Array.isArray(raw.stacks), true)
    assert.equal(raw.stacks.length, 1)
    assert.equal(raw.stacks[0].projectId, 'chroxy-byok-abcdef')
    assert.equal(raw.stacks[0].composeFile, '/proj/docker-compose.yml')
    assert.equal(raw.stacks[0].cwd, '/work/proj')
    assert.equal(typeof raw.stacks[0].createdAt, 'string')
  })

  it('forget(projectId) removes the entry and persists the new state', () => {
    const store = new ByokComposeStateStore({ statePath })
    store.record({ projectId: 'p1', composeFile: '/a/docker-compose.yml', cwd: '/a' })
    store.record({ projectId: 'p2', composeFile: '/b/docker-compose.yml', cwd: '/b' })
    store.forget('p1')
    const ids = store.list().map(s => s.projectId)
    assert.deepEqual(ids, ['p2'])
    // Reload from disk and confirm forget persisted.
    const reloaded = new ByokComposeStateStore({ statePath })
    assert.deepEqual(reloaded.list().map(s => s.projectId), ['p2'])
  })

  it('record() on an existing projectId replaces the prior entry (idempotent)', () => {
    const store = new ByokComposeStateStore({ statePath })
    store.record({ projectId: 'p1', composeFile: '/old/docker-compose.yml', cwd: '/old' })
    store.record({ projectId: 'p1', composeFile: '/new/docker-compose.yml', cwd: '/new' })
    const stacks = store.list()
    assert.equal(stacks.length, 1)
    assert.equal(stacks[0].composeFile, '/new/docker-compose.yml')
    assert.equal(stacks[0].cwd, '/new')
  })

  it('forget() on an unknown projectId is a no-op', () => {
    const store = new ByokComposeStateStore({ statePath })
    store.record({ projectId: 'p1', composeFile: '/a/docker-compose.yml', cwd: '/a' })
    store.forget('does-not-exist')
    assert.equal(store.list().length, 1)
  })

  it('rejects record() calls missing required fields', () => {
    const store = new ByokComposeStateStore({ statePath })
    assert.throws(() => store.record({ composeFile: '/a', cwd: '/a' }), /projectId/)
    assert.throws(() => store.record({ projectId: 'p', cwd: '/a' }), /composeFile/)
    assert.throws(() => store.record({ projectId: 'p', composeFile: '/a' }), /cwd/)
  })

  it('load() ignores a corrupt state file but does not crash', () => {
    writeFileSync(statePath, 'this is not json')
    const store = new ByokComposeStateStore({ statePath })
    assert.deepEqual(store.list(), [])
  })

  it('load() ignores a state file with an unknown version', () => {
    writeFileSync(statePath, JSON.stringify({ version: 99, stacks: [{ projectId: 'p1' }] }))
    const store = new ByokComposeStateStore({ statePath })
    assert.deepEqual(store.list(), [])
  })

  it('survives a round-trip across instances', () => {
    const a = new ByokComposeStateStore({ statePath })
    a.record({ projectId: 'p1', composeFile: '/x/docker-compose.yml', cwd: '/x' })
    a.record({ projectId: 'p2', composeFile: '/y/docker-compose.yml', cwd: '/y' })

    const b = new ByokComposeStateStore({ statePath })
    const ids = b.list().map(s => s.projectId).sort()
    assert.deepEqual(ids, ['p1', 'p2'])
  })
})

describe('sweepOrphanedComposeStacks()', () => {
  it('runs destroyComposeEnvironment for each persisted stack and forgets it', async () => {
    const store = new ByokComposeStateStore({ statePath })
    store.record({ projectId: 'p1', composeFile: '/x/docker-compose.yml', cwd: '/x' })
    store.record({ projectId: 'p2', composeFile: '/y/docker-compose.yml', cwd: '/y' })

    const destroyCalls = []
    const backend = {
      async destroyComposeEnvironment(opts) {
        destroyCalls.push(opts)
      },
    }

    const result = await sweepOrphanedComposeStacks({ store, backend })
    assert.equal(destroyCalls.length, 2)
    const seen = destroyCalls.map(c => c.composeProject).sort()
    assert.deepEqual(seen, ['p1', 'p2'])
    assert.equal(result.swept, 2)
    assert.equal(result.failed, 0)
    // Store must be empty post-sweep.
    assert.deepEqual(store.list(), [])
  })

  it('keeps an entry on disk when destroyComposeEnvironment throws (retry-on-next-boot)', async () => {
    const store = new ByokComposeStateStore({ statePath })
    store.record({ projectId: 'p-fail', composeFile: '/z/docker-compose.yml', cwd: '/z' })

    const backend = {
      async destroyComposeEnvironment() {
        throw new Error('docker daemon unreachable')
      },
    }

    const result = await sweepOrphanedComposeStacks({ store, backend })
    assert.equal(result.swept, 0)
    assert.equal(result.failed, 1)
    // Entry survives so the next boot retries.
    assert.equal(store.list().length, 1)
    assert.equal(store.list()[0].projectId, 'p-fail')
  })

  it('returns { swept: 0, failed: 0 } when the store is empty', async () => {
    const store = new ByokComposeStateStore({ statePath })
    const backend = {
      async destroyComposeEnvironment() {
        throw new Error('should not be called')
      },
    }
    const result = await sweepOrphanedComposeStacks({ store, backend })
    assert.deepEqual(result, { swept: 0, failed: 0 })
  })
})
