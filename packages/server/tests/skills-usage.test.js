import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyUsage,
  loadUsageStore,
  saveUsageStore,
  SkillsUsageRecorder,
  MAX_ENTRIES,
  MAX_REPOS_PER_SKILL,
  MAX_SKILLS,
} from '../src/skills-usage.js'

/**
 * #5554 Phase 2 — tests for the bounded, atomic skills usage log
 * (skills-usage.js). All disk access targets a temp dir — the real
 * ~/.chroxy/skills-usage.json is never touched (the #4633 sandbox guard would
 * throw otherwise).
 */

describe('applyUsage (bounding + aggregates)', () => {
  it('appends an entry and updates the per-skill aggregate', () => {
    const store = { version: 1, entries: [], aggregates: {} }
    applyUsage(store, { skill: 'batch-merge', sessionId: 's1', repo: '/p/a', ts: 1000 })
    applyUsage(store, { skill: 'batch-merge', sessionId: 's2', repo: '/p/b', ts: 2000 })

    assert.equal(store.entries.length, 2)
    const agg = store.aggregates['batch-merge']
    assert.equal(agg.count, 2)
    assert.equal(agg.lastUsed, 2000)
    assert.deepEqual(agg.repos, ['/p/a', '/p/b'])
  })

  it('lastUsed only advances — an out-of-order older record never rolls it back', () => {
    const store = { version: 1, entries: [], aggregates: {} }
    applyUsage(store, { skill: 'x', ts: 5000 })
    applyUsage(store, { skill: 'x', ts: 3000 })
    assert.equal(store.aggregates['x'].lastUsed, 5000)
    assert.equal(store.aggregates['x'].count, 2)
  })

  it('bounds the ring buffer at MAX_ENTRIES (oldest dropped)', () => {
    const store = { version: 1, entries: [], aggregates: {} }
    for (let i = 0; i < MAX_ENTRIES + 50; i++) {
      applyUsage(store, { skill: `s${i}`, ts: i + 1 })
    }
    assert.equal(store.entries.length, MAX_ENTRIES)
    // The oldest 50 are gone; the first surviving entry is s50.
    assert.equal(store.entries[0].skill, 's50')
  })

  it('caps the per-skill repos list at MAX_REPOS_PER_SKILL', () => {
    const store = { version: 1, entries: [], aggregates: {} }
    for (let i = 0; i < MAX_REPOS_PER_SKILL + 10; i++) {
      applyUsage(store, { skill: 'busy', repo: `/p/${i}`, ts: i + 1 })
    }
    assert.equal(store.aggregates['busy'].repos.length, MAX_REPOS_PER_SKILL)
    // count still reflects every activation, even past the repo cap.
    assert.equal(store.aggregates['busy'].count, MAX_REPOS_PER_SKILL + 10)
  })

  it('caps distinct tracked skills at MAX_SKILLS, evicting least-recently-used', () => {
    const store = { version: 1, entries: [], aggregates: {} }
    // Seed MAX_SKILLS skills with ascending lastUsed.
    for (let i = 0; i < MAX_SKILLS; i++) {
      applyUsage(store, { skill: `s${i}`, ts: i + 1 })
    }
    assert.equal(Object.keys(store.aggregates).length, MAX_SKILLS)
    // One more distinct skill (newest) should evict the oldest (s0).
    applyUsage(store, { skill: 'newest', ts: MAX_SKILLS + 1000 })
    assert.equal(Object.keys(store.aggregates).length, MAX_SKILLS)
    assert.ok(!('s0' in store.aggregates), 'least-recently-used skill should be evicted')
    assert.ok('newest' in store.aggregates)
  })

  it('ignores a record with no skill name', () => {
    const store = { version: 1, entries: [], aggregates: {} }
    applyUsage(store, { skill: '', ts: 1 })
    applyUsage(store, { ts: 1 })
    assert.equal(store.entries.length, 0)
    assert.equal(Object.keys(store.aggregates).length, 0)
  })
})

describe('loadUsageStore / saveUsageStore (atomic, temp paths only)', () => {
  let tmpDir, filePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-skills-usage-'))
    filePath = join(tmpDir, 'nested', 'skills-usage.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns an empty store for a missing file', () => {
    const store = loadUsageStore(filePath)
    assert.deepEqual(store, { version: 1, entries: [], aggregates: {} })
  })

  it('round-trips a store through save → load (creating parent dirs)', () => {
    const store = { version: 1, entries: [], aggregates: {} }
    applyUsage(store, { skill: 'batch-merge', sessionId: 's1', repo: '/p/a', ts: 1000 })
    saveUsageStore(store, filePath)

    assert.ok(existsSync(filePath))
    const loaded = loadUsageStore(filePath)
    assert.equal(loaded.entries.length, 1)
    assert.equal(loaded.aggregates['batch-merge'].count, 1)
  })

  it('leaves no temp sidecar behind after a successful write', () => {
    const store = { version: 1, entries: [], aggregates: {} }
    applyUsage(store, { skill: 'x', ts: 1 })
    saveUsageStore(store, filePath)
    const dir = join(tmpDir, 'nested')
    // #5579: the sidecar is now `.tmp-<pid>` (per-pid), so match any `.tmp`
    // fragment, not just a trailing `.tmp`, to catch a leaked per-pid sidecar.
    const leftover = readdirSync(dir).filter((f) => f.includes('.tmp'))
    assert.deepEqual(leftover, [], 'no temp sidecar should remain after an atomic write')
  })

  it('#5579: uses a per-pid temp sidecar so concurrent writers do not collide', () => {
    // Simulate two daemons (different pids) writing the same target around the
    // same time. The #5309 convention gives each writer its own `.tmp-<pid>`
    // sidecar, so a stale sidecar pre-created by writer B can NOT be torn or
    // clobbered by writer A's write — the only contended step is the atomic
    // rename. We approximate the overlap by pre-creating a foreign-pid sidecar,
    // running a save, and asserting (a) the foreign sidecar is untouched and
    // (b) the final file is the save's intact JSON.
    const dir = join(tmpDir, 'nested')
    mkdirSync(dir, { recursive: true })
    const foreignPid = process.pid + 1
    const foreignSidecar = `${filePath}.tmp-${foreignPid}`
    const foreignBytes = 'OTHER-WRITER-IN-FLIGHT'
    writeFileSync(foreignSidecar, foreignBytes)

    const store = { version: 1, entries: [], aggregates: {} }
    applyUsage(store, { skill: 'mine', ts: 7 })
    saveUsageStore(store, filePath)

    // Our writer used `.tmp-<our pid>` and renamed it away — the foreign
    // writer's sidecar is left exactly as it was (no collision).
    assert.ok(existsSync(foreignSidecar), 'foreign-pid sidecar must survive our write')
    assert.equal(readFileSync(foreignSidecar, 'utf8'), foreignBytes, 'foreign sidecar bytes untouched')

    // The final target is our intact JSON, not a torn interleave.
    const loaded = loadUsageStore(filePath)
    assert.equal(loaded.entries.length, 1)
    assert.equal(loaded.entries[0].skill, 'mine')

    // Our own per-pid sidecar was consumed by the rename — none left behind.
    const ourSidecar = `skills-usage.json.tmp-${process.pid}`
    const leftover = readdirSync(dir).filter((f) => f === ourSidecar)
    assert.deepEqual(leftover, [], 'our per-pid sidecar must be renamed away')
  })

  it('degrades a corrupt file to an empty store rather than throwing', () => {
    writeFileSync(filePath.replace('/nested/', '/'), 'not json at all')
    const store = loadUsageStore(filePath.replace('/nested/', '/'))
    assert.deepEqual(store, { version: 1, entries: [], aggregates: {} })
  })
})

describe('SkillsUsageRecorder', () => {
  let tmpDir, filePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-skills-rec-'))
    filePath = join(tmpDir, 'skills-usage.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records a batch of skills, de-dupes within the batch, and flushes to disk', () => {
    const rec = new SkillsUsageRecorder({ filePath, saveDebounceMs: 0, now: () => 4242 })
    rec.record({ sessionId: 'sess', repo: '/p/chroxy', skills: ['a', 'b', 'a'] })

    const agg = rec.aggregatesByName()
    assert.equal(agg.get('a').count, 1, 'a duplicated skill in one batch counts once')
    assert.equal(agg.get('b').count, 1)
    assert.equal(agg.get('a').lastUsed, 4242)
    assert.deepEqual(agg.get('a').repos, ['/p/chroxy'])

    // saveDebounceMs:0 flushes synchronously.
    const loaded = loadUsageStore(filePath)
    assert.equal(loaded.aggregates['a'].count, 1)
  })

  it('aggregatesByName returns copies that cannot mutate the live store', () => {
    const rec = new SkillsUsageRecorder({ filePath, saveDebounceMs: 0 })
    rec.record({ sessionId: 's', repo: '/p', skills: ['a'] })
    const agg = rec.aggregatesByName()
    agg.get('a').repos.push('/evil')
    assert.deepEqual(rec.aggregatesByName().get('a').repos, ['/p'], 'live store must be insulated from caller mutation')
  })

  it('ignores an empty skills batch (no write)', () => {
    const rec = new SkillsUsageRecorder({ filePath, saveDebounceMs: 0 })
    rec.record({ sessionId: 's', repo: '/p', skills: [] })
    assert.ok(!existsSync(filePath), 'an empty batch should not create the file')
  })

  it('record never throws even when the underlying save fails', () => {
    const rec = new SkillsUsageRecorder({
      filePath,
      saveDebounceMs: 0,
      _save: () => { throw new Error('disk full') },
    })
    // Must not throw — a usage-log failure can never break session creation.
    assert.doesNotThrow(() => rec.record({ sessionId: 's', repo: '/p', skills: ['a'] }))
  })

  it('flush persists pending debounced records', () => {
    const rec = new SkillsUsageRecorder({ filePath, saveDebounceMs: 10_000 })
    rec.record({ sessionId: 's', repo: '/p', skills: ['a'] })
    assert.ok(!existsSync(filePath), 'debounced write should not have landed yet')
    rec.flush()
    assert.ok(existsSync(filePath))
    assert.equal(loadUsageStore(filePath).aggregates['a'].count, 1)
  })

  it('survives a daemon restart (load existing → continue counting)', () => {
    const rec1 = new SkillsUsageRecorder({ filePath, saveDebounceMs: 0 })
    rec1.record({ sessionId: 's1', repo: '/p', skills: ['a'] })

    const rec2 = new SkillsUsageRecorder({ filePath, saveDebounceMs: 0 })
    rec2.record({ sessionId: 's2', repo: '/p', skills: ['a'] })
    assert.equal(rec2.aggregatesByName().get('a').count, 2, 'count should accumulate across restarts')
  })
})
