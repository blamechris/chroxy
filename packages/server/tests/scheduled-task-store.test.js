import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ScheduledTaskStore,
  ScheduledTaskValidationError,
  defaultScheduledTasksPath,
} from '../src/scheduled-task-store.js'

/**
 * #6862 — persisted scheduled-task registry. Covers CRUD round-trips, restart
 * survival (a fresh store reads the file), atomic write + 0600 perms, the
 * version gate + corrupt-json fail-open, per-entry drop of malformed tasks, and
 * next-run computation on add/update/load. No firing — the engine is #6865.
 *
 * Every store writes to a temp dir (never the real ~/.chroxy), so the #4633
 * sandbox guard is satisfied.
 */

const silentLog = { info() {}, warn() {}, error() {} }
const HOUR = 60 * 60 * 1000

describe('#6862 ScheduledTaskStore', () => {
  let dir
  let filePath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sched-store-'))
    filePath = join(dir, 'scheduled-tasks.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const newStore = (now) => new ScheduledTaskStore({ filePath, logger: silentLog, now })

  it('requires a filePath', () => {
    assert.throws(() => new ScheduledTaskStore({}), /requires a filePath/)
  })

  it('defaultScheduledTasksPath sits next to the state file', () => {
    assert.equal(defaultScheduledTasksPath('/home/x/.chroxy/session-state.json'), '/home/x/.chroxy/scheduled-tasks.json')
  })

  it('add() assigns id/timestamps, computes nextRun, and persists', () => {
    const store = newStore(() => 1000)
    const task = store.add({
      prompt: 'run the nightly report',
      cadence: { kind: 'interval', everyMs: HOUR },
      target: { provider: 'claude', model: 'sonnet', cwd: '/proj', permissionMode: 'plan' },
    })
    assert.ok(task.id, 'id assigned')
    assert.equal(task.enabled, true)
    assert.equal(task.createdAt, 1000)
    assert.equal(task.updatedAt, 1000)
    assert.equal(task.nextRun, 1000 + HOUR, 'interval nextRun anchored on createdAt')
    assert.deepEqual(task.target, { provider: 'claude', model: 'sonnet', cwd: '/proj', permissionMode: 'plan' })
    assert.equal(task.lastRun, null)
    assert.ok(existsSync(filePath), 'file written')
  })

  it('add() rejects invalid input with ScheduledTaskValidationError', () => {
    const store = newStore()
    assert.throws(() => store.add({ cadence: { kind: 'interval', everyMs: HOUR } }), ScheduledTaskValidationError) // no prompt
    assert.throws(() => store.add({ prompt: 'x' }), ScheduledTaskValidationError) // no cadence
    assert.throws(() => store.add({ prompt: 'x', cadence: { kind: 'interval', everyMs: 10 } }), ScheduledTaskValidationError) // everyMs below the MIN_INTERVAL_MS floor (1000ms)
    assert.throws(() => store.add({ prompt: 'x', cadence: { kind: 'cron', expression: 'bad cron' } }), ScheduledTaskValidationError) // bad cron
    assert.throws(() => store.add({ prompt: 'x', cadence: { kind: 'once' } }), ScheduledTaskValidationError) // once without `at`
    assert.throws(() => store.add({ prompt: 'x', cadence: { kind: 'weekly' } }), ScheduledTaskValidationError) // unknown kind
  })

  it('normalizeTarget rejects a non-plain-object target (array, etc.)', () => {
    const store = newStore()
    // `typeof [] === 'object'` must NOT slip an array through as a valid target.
    assert.throws(
      () => store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 }, target: ['claude'] }),
      ScheduledTaskValidationError,
    )
    // update() path is equally strict.
    const t = store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 } })
    assert.throws(() => store.update(t.id, { target: [] }), ScheduledTaskValidationError)
  })

  it('normalizeTarget rejects an unknown permissionMode', () => {
    const store = newStore()
    assert.throws(
      () => store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 }, target: { permissionMode: 'yolo' } }),
      ScheduledTaskValidationError,
    )
    const t = store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 } })
    assert.throws(
      () => store.update(t.id, { target: { permissionMode: 'not-a-mode' } }),
      ScheduledTaskValidationError,
    )
  })

  it('normalizeTarget accepts every supported permissionMode', () => {
    const store = newStore()
    for (const mode of ['approve', 'acceptEdits', 'auto', 'plan']) {
      const t = store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 }, target: { permissionMode: mode } })
      assert.equal(t.target.permissionMode, mode, `permissionMode ${mode} accepted`)
    }
  })

  it('load() drops a task with an invalid target permissionMode but keeps valid siblings', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      tasks: [
        { id: 'ok', prompt: 'p', cadence: { kind: 'once', at: 1 }, target: { permissionMode: 'plan' }, createdAt: 0, updatedAt: 0 },
        { id: 'bad-mode', prompt: 'p', cadence: { kind: 'once', at: 1 }, target: { permissionMode: 'bogus' }, createdAt: 0, updatedAt: 0 },
        { id: 'bad-target', prompt: 'p', cadence: { kind: 'once', at: 1 }, target: ['nope'], createdAt: 0, updatedAt: 0 },
      ],
    }))
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.list().map((t) => t.id), ['ok'], 'only the valid task survives')
  })

  it('get()/list() return copies that cannot mutate stored state', () => {
    const store = newStore()
    const added = store.add({ prompt: 'p', cadence: { kind: 'once', at: 5000 } })
    const fetched = store.get(added.id)
    fetched.prompt = 'MUTATED'
    fetched.target.provider = 'evil'
    assert.equal(store.get(added.id).prompt, 'p', 'stored prompt untouched')
    assert.equal(store.get(added.id).target.provider, undefined)
    assert.equal(store.get('nope'), null)
    assert.equal(store.list().length, 1)
  })

  it('update() patches fields, recomputes nextRun, bumps updatedAt, keeps id/createdAt', () => {
    let clock = 1000
    const store = newStore(() => clock)
    const t = store.add({ prompt: 'p', cadence: { kind: 'interval', everyMs: HOUR } })
    clock = 2000
    const updated = store.update(t.id, { cadence: { kind: 'interval', everyMs: 2 * HOUR }, enabled: false, name: 'nightly' })
    assert.equal(updated.id, t.id)
    assert.equal(updated.createdAt, 1000, 'createdAt immutable')
    assert.equal(updated.updatedAt, 2000, 'updatedAt bumped')
    assert.equal(updated.name, 'nightly')
    assert.equal(updated.enabled, false)
    assert.equal(updated.nextRun, null, 'disabled -> nextRun null')
    assert.equal(store.update('missing', { name: 'x' }), null)
  })

  it('update() can set a lastRun stub (engine #6865 territory) and advances nextRun', () => {
    let clock = 0
    const store = newStore(() => clock)
    const t = store.add({ prompt: 'p', cadence: { kind: 'interval', everyMs: HOUR } })
    clock = HOUR + 5
    const updated = store.update(t.id, { lastRun: { at: HOUR, status: 'success', sessionId: 'sess-9' } })
    assert.deepEqual(updated.lastRun, { at: HOUR, status: 'success', sessionId: 'sess-9' })
    assert.equal(updated.nextRun, 2 * HOUR, 'nextRun advanced to the next boundary after now')
    assert.throws(() => store.update(t.id, { lastRun: { at: 1, status: 'bogus' } }), ScheduledTaskValidationError)
  })

  it('remove() deletes and persists; returns false for an unknown id', () => {
    const store = newStore()
    const t = store.add({ prompt: 'p', cadence: { kind: 'once', at: 9999 } })
    assert.equal(store.remove(t.id), true)
    assert.equal(store.get(t.id), null)
    assert.equal(store.remove(t.id), false)
  })

  it('survives a simulated restart: a NEW store reads persisted tasks', () => {
    const store1 = newStore(() => 1000)
    const a = store1.add({ prompt: 'a', cadence: { kind: 'cron', expression: '0 9 * * *' } })
    const b = store1.add({ prompt: 'b', cadence: { kind: 'interval', everyMs: HOUR } })

    const store2 = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    const ids = store2.list().map((t) => t.id).sort()
    assert.deepEqual(ids, [a.id, b.id].sort())
    assert.equal(store2.get(a.id).prompt, 'a')
    assert.equal(store2.get(a.id).cadence.expression, '0 9 * * *')
    assert.ok(Number.isFinite(store2.get(a.id).nextRun), 'cron nextRun recomputed on load')
  })

  it('load() recomputes nextRun rather than trusting a stale stored value', () => {
    // Hand-write a file whose stored nextRun is deliberately wrong.
    const bogus = {
      version: 1,
      tasks: [{
        id: 'fixed', name: null, enabled: true, prompt: 'p',
        target: {}, cadence: { kind: 'interval', everyMs: HOUR, anchor: 0 },
        nextRun: 999999999, lastRun: null, createdAt: 0, updatedAt: 0,
      }],
    }
    writeFileSync(filePath, JSON.stringify(bogus))
    const store = new ScheduledTaskStore({ filePath, logger: silentLog, now: () => 10 }).load()
    assert.equal(store.get('fixed').nextRun, HOUR, 'nextRun recomputed from cadence, not the stored 999999999')
  })

  it('writes atomically (temp+rename) with 0600 perms and no leftover temp', () => {
    const store = newStore()
    store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 } })
    const mode = statSync(filePath).mode & 0o777
    // Windows does not honour POSIX mode bits; assert only on POSIX.
    if (process.platform !== 'win32') assert.equal(mode, 0o600, 'file is owner-only')
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
    assert.deepEqual(leftovers, [], 'no orphaned temp file')
  })

  it('missing file loads as an empty store', () => {
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.list(), [])
  })

  it('corrupt JSON fails open to empty (does not throw)', () => {
    writeFileSync(filePath, '{ this is not json')
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.list(), [])
  })

  it('an unknown version is skipped whole (fail-open)', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 999,
      tasks: [{ id: 'x', prompt: 'p', cadence: { kind: 'once', at: 1 }, createdAt: 0, updatedAt: 0 }],
    }))
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.list(), [])
  })

  it('drops individual malformed entries but keeps valid siblings', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      tasks: [
        { id: 'good', prompt: 'p', cadence: { kind: 'once', at: 1 }, createdAt: 0, updatedAt: 0 },
        { id: 'no-prompt', cadence: { kind: 'once', at: 1 }, createdAt: 0, updatedAt: 0 },
        { id: 'bad-cadence', prompt: 'p', cadence: { kind: 'cron', expression: 'garbage' }, createdAt: 0, updatedAt: 0 },
        { prompt: 'p', cadence: { kind: 'once', at: 1 } }, // no id
        { id: 'good', prompt: 'dup', cadence: { kind: 'once', at: 2 }, createdAt: 0, updatedAt: 0 }, // duplicate id
      ],
    }))
    const store = new ScheduledTaskStore({ filePath, logger: silentLog }).load()
    const ids = store.list().map((t) => t.id)
    assert.deepEqual(ids, ['good'], 'only the first valid task survives')
    assert.equal(store.get('good').prompt, 'p', 'the duplicate did not overwrite')
  })

  it('load() replaces in-memory state (no stale re-persist)', () => {
    const store = newStore()
    store.add({ prompt: 'p', cadence: { kind: 'once', at: 1 } })
    assert.equal(store.list().length, 1)
    // Blow the file away, reload — the in-memory task must not survive.
    rmSync(filePath)
    store.load()
    assert.deepEqual(store.list(), [])
  })

  it('a caller-supplied id is honoured and collisions are rejected', () => {
    const store = newStore()
    const t = store.add({ id: 'my-id', prompt: 'p', cadence: { kind: 'once', at: 1 } })
    assert.equal(t.id, 'my-id')
    assert.throws(() => store.add({ id: 'my-id', prompt: 'q', cadence: { kind: 'once', at: 2 } }), ScheduledTaskValidationError)
  })
})
