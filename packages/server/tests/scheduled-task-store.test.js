import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ScheduledTaskCadenceCronSchema } from '@chroxy/protocol'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { parseCron } from '../src/schedule-parser.js'
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

  // #7051 — a cron expression the WIRE cannot carry must never enter the
  // registry. ScheduledTaskCadenceCronSchema caps `expression` at 256; the store
  // had no cap at all, so a longer-but-valid cron was store-legal and
  // wire-ILLEGAL. Blast radius is the whole panel, not one row: the dashboard
  // safeParses the entire `scheduled_tasks` snapshot, so ONE such task makes it
  // render zero tasks (plus "may be out of date") while N are armed and firing.
  //
  // REJECT rather than clamp, unlike the string fields projectTask truncates:
  // truncating a cron silently CHANGES THE SCHEDULE, which is worse than
  // refusing it.
  describe('#7051 cron expression wire cap', () => {
    // Fully enumerated minute/hour/day-of-month lists — 319 chars, and every
    // field is legal, so LENGTH is the only thing that can reject it. The
    // self-check below pins that: a fixture that quietly fell under the cap
    // would make the rejection tests fail for an unrelated reason.
    const LONG_VALID_CRON = [
      Array.from({ length: 60 }, (_, i) => i).join(','),
      Array.from({ length: 24 }, (_, i) => i).join(','),
      Array.from({ length: 31 }, (_, i) => i + 1).join(','),
      '*',
      '*',
    ].join(' ')

    it('the fixture is a VALID cron that is merely too long (length is the only defect)', () => {
      assert.ok(LONG_VALID_CRON.length > 256, `fixture must exceed the cap, got ${LONG_VALID_CRON.length}`)
      assert.doesNotThrow(() => parseCron(LONG_VALID_CRON), 'fixture must parse — otherwise the test proves nothing about the cap')
    })

    it('add() rejects a cron expression longer than the wire cap', () => {
      const store = newStore(() => 1000)
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'cron', expression: LONG_VALID_CRON } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'cadence.expression',
        'a store-legal / wire-illegal cron must be refused at the boundary',
      )
    })

    it('accepts a cron expression exactly AT the cap', () => {
      const store = newStore(() => 1000)
      // '*/2 * * * *' padded with trailing spaces trims back under the cap, so
      // build an exactly-256 expression instead of relying on trimming.
      const atCap = [Array.from({ length: 60 }, (_, i) => i).join(','), '*', '*', '*', '*'].join(' ')
      assert.ok(atCap.length <= 256 && atCap.length > 160, `at-cap fixture should sit just under the cap, got ${atCap.length}`)
      assert.doesNotThrow(() => store.add({ prompt: 'x', cadence: { kind: 'cron', expression: atCap } }))
    })

    // The reachable path today: ~/.chroxy/scheduled-tasks.json edited by hand,
    // or a non-WS writer. _normalizeStoredTask must refuse it too, or the
    // snapshot breaks for every client despite add() being guarded.
    //
    // These two cases share one fixture writer and differ ONLY in the cron, so
    // the control below is what gives the drop case its meaning. The first
    // version of this test wrote `{ v: 1 }` instead of `{ version: 1 }`; the
    // store's version gate then ignored the whole file, `list()` was empty for
    // a reason that had nothing to do with the cap, and the test passed with
    // the cap guard deleted. The control fails loudly on that mistake.
    const writeRegistryWithCron = (expression) => {
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        tasks: [{ id: 'a', prompt: 'x', cadence: { kind: 'cron', expression }, createdAt: 1, updatedAt: 1 }],
      }))
      // .load() is explicit — the constructor does NOT read the file.
      return newStore(() => 1000).load()
    }

    // Drift guard. The store's cap is a HAND-COPIED constant; the wire schema is
    // the real authority. This asserts the two boundaries coincide by comparing
    // behaviour at exactly 256 and exactly 257 chars, so raising/lowering
    // ScheduledTaskCadenceCronSchema without touching MAX_CRON_EXPRESSION_LENGTH
    // (or vice versa) fails here rather than silently reopening the bug.
    const cronOfExactLength = (target) => {
      // '<minute-list> * * * *' — the tail is 8 chars, so the list carries the
      // rest. Mixing 1- and 2-digit entries hits any length exactly.
      const want = target - 8
      for (let k = 1; k < 400; k++) {
        for (let j = 0; j <= k; j++) {
          if (3 * k - j - 1 === want) {
            return [...Array(k)].map((_, i) => (i < j ? '1' : '59')).join(',') + ' * * * *'
          }
        }
      }
      throw new Error(`cannot build a cron of length ${target}`)
    }

    it('the store cap and the wire schema agree at the boundary (drift guard)', () => {
      const store = newStore(() => 1000)
      for (const len of [256, 257]) {
        const expression = cronOfExactLength(len)
        assert.equal(expression.length, len, 'builder must hit the length exactly')
        assert.doesNotThrow(() => parseCron(expression), `len ${len} must be a valid cron`)

        const wireOk = ScheduledTaskCadenceCronSchema.safeParse({ kind: 'cron', expression }).success
        let storeOk = true
        try {
          store.add({ prompt: 'x', cadence: { kind: 'cron', expression } })
        } catch {
          storeOk = false
        }
        assert.equal(
          storeOk,
          wireOk,
          `at ${len} chars the store (${storeOk ? 'accepts' : 'rejects'}) and the wire schema ` +
          `(${wireOk ? 'accepts' : 'rejects'}) disagree — MAX_CRON_EXPRESSION_LENGTH has drifted ` +
          'from ScheduledTaskCadenceCronSchema',
        )
      }
    })

    it('CONTROL: the registry fixture loads when the cron is short (so the drop below means something)', () => {
      assert.equal(writeRegistryWithCron('*/5 * * * *').list().length, 1)
    })

    it('padding is not counted against the cap, and cannot sneak past it', () => {
      const store = newStore(() => 1000)
      // Whitespace is stripped before storing, so an at-cap expression stays
      // legal however it is padded...
      const atCap = cronOfExactLength(256)
      const t = store.add({ prompt: 'x', cadence: { kind: 'cron', expression: `   ${atCap}   ` } })
      assert.equal(t.cadence.expression, atCap, 'the stored expression must be the trimmed one')
      // ...and padding an over-cap expression does not make it legal either.
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'cron', expression: `  ${cronOfExactLength(257)}  ` } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'cadence.expression',
      )
    })

    it('a hand-edited registry file with an over-cap cron is rejected on load, not served', () => {
      const store = writeRegistryWithCron(LONG_VALID_CRON)
      assert.deepEqual(store.list(), [], 'an unrepresentable task must be dropped on load rather than served to clients')
    })
  })

  // #6871 review (C3) — an epoch outside the representable Date range is finite,
  // so a finiteness-only check let it be stored and served. It then crashed the
  // dashboard panel during render (`new Date(1e16).toISOString()` throws
  // RangeError), taking the whole dashboard down via the root error boundary.
  // Rejecting it here keeps an unrenderable instant out of the registry.
  describe('#6871 review — out-of-Date-range epochs are rejected', () => {
    const OUT_OF_RANGE = 1e16 // finite, but > 8.64e15 → an Invalid Date

    it('add() rejects a `once` cadence whose `at` cannot be represented', () => {
      const store = newStore(() => 1000)
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'once', at: OUT_OF_RANGE } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'cadence.at',
      )
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'once', at: -OUT_OF_RANGE } }),
        ScheduledTaskValidationError,
      )
    })

    it('add() rejects an interval anchor that cannot be represented', () => {
      const store = newStore(() => 1000)
      assert.throws(
        () => store.add({ prompt: 'x', cadence: { kind: 'interval', everyMs: HOUR, anchor: OUT_OF_RANGE } }),
        (err) => err instanceof ScheduledTaskValidationError && err.field === 'cadence.anchor',
      )
    })

    it('the bound admits every LEGITIMATE instant, including the exact limit', () => {
      // Nothing real is refused: 8.64e15 ms is the year 275760.
      const store = newStore(() => 1000)
      assert.ok(store.add({ prompt: 'a', cadence: { kind: 'once', at: Date.now() + HOUR } }))
      assert.ok(store.add({ prompt: 'b', cadence: { kind: 'once', at: 8.64e15 } }))
      assert.ok(store.add({ prompt: 'c', cadence: { kind: 'once', at: -8.64e15 } }))
      assert.ok(store.add({ prompt: 'd', cadence: { kind: 'interval', everyMs: HOUR, anchor: 0 } }))
    })

    it('load() DROPS a hand-edited out-of-range task without nuking its siblings', () => {
      // The registry is a user-writable file, so a pre-existing bad record must
      // degrade to one dropped task, not an empty scheduler.
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        tasks: [
          { id: 'good', prompt: 'ok', cadence: { kind: 'cron', expression: '0 9 * * *' }, createdAt: 1, updatedAt: 1 },
          { id: 'bad', prompt: 'boom', cadence: { kind: 'once', at: OUT_OF_RANGE }, createdAt: 1, updatedAt: 1 },
        ],
      }))
      const tasks = newStore(() => 1000).load().list()
      assert.deepEqual(tasks.map((t) => t.id), ['good'])
    })
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
