// `chroxy schedule` command handlers (#6868). Exercises the pure exported
// functions in src/cli/schedule-cmd.js directly against a REAL
// ScheduledTaskStore pointed at a per-test temp file — never the real
// ~/.chroxy/ tree (the sandbox guard in tests/_setup.mjs would throw loudly
// if we tried). Using the real store means cadence validation and nextRun
// computation run through the actual schedule-parser.js code path, not a
// re-implemented fake.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir, homedir } from 'os'
import { ScheduledTaskStore, defaultScheduledTasksPath } from '../src/scheduled-task-store.js'
import { defaultStateFile } from '../src/session-manager.js'
import {
  runScheduleCreate,
  runScheduleList,
  runScheduleEdit,
  runSchedulePause,
  runScheduleResume,
  runScheduleDelete,
  runScheduleLastRun,
  defaultScheduleRegistryPath,
} from '../src/cli/schedule-cmd.js'

const NOW = 1_800_000_000_000 // fixed clock so nextRun/formatted timestamps are deterministic

function makeStore(now = NOW) {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-cli-test-'))
  const store = new ScheduledTaskStore({ filePath: join(dir, 'scheduled-tasks.json'), now: () => now })
  store.load()
  return store
}

function cap() {
  const lines = []
  return { write: (s) => lines.push(String(s)), lines, text: () => lines.join('\n') }
}

/** Deps with every engine-reuse seam stubbed to a harmless default; override per test. */
function baseDeps(store, w, overrides = {}) {
  return {
    store,
    write: w,
    defaultProviderName: 'claude-tui',
    checkProviderRefusal: () => null,
    resolvePermissionMode: (mode) => mode,
    checkSchedulerEnabled: () => true,
    ...overrides,
  }
}

describe('chroxy schedule create (#6868)', () => {
  it('creates a recurring task from --cron and persists via the store (computed nextRun surfaced)', () => {
    const store = makeStore()
    const w = cap()
    const res = runScheduleCreate(
      { prompt: 'summarize the inbox', cron: '0 9 * * *', name: 'Morning summary' },
      baseDeps(store, w.write),
    )
    assert.equal(res.created, true)
    assert.equal(res.task.name, 'Morning summary')
    assert.deepEqual(res.task.cadence, { kind: 'cron', expression: '0 9 * * *' })
    assert.equal(typeof res.task.nextRun, 'number')
    assert.equal(store.list().length, 1, 'persisted to the store')
    assert.match(w.text(), /Created scheduled task/)
    assert.match(w.text(), /cron "0 9 \* \* \*"/)
  })

  it('creates a one-time task from an ISO --at and from an epoch-ms --at', () => {
    const store = makeStore()
    const w = cap()
    const iso = runScheduleCreate({ prompt: 'once', at: '2099-01-01T00:00:00Z' }, baseDeps(store, w.write))
    assert.equal(iso.created, true)
    assert.deepEqual(iso.task.cadence, { kind: 'once', at: Date.parse('2099-01-01T00:00:00Z') })

    const epoch = runScheduleCreate({ prompt: 'once2', at: '4102444800000' }, baseDeps(store, w.write))
    assert.equal(epoch.created, true)
    assert.deepEqual(epoch.task.cadence, { kind: 'once', at: 4102444800000 })
  })

  it('rejects an invalid cron expression via schedule-parser.js and persists nothing', () => {
    const store = makeStore()
    const w = cap()
    const res = runScheduleCreate({ prompt: 'bad', cron: 'not a cron' }, baseDeps(store, w.write))
    assert.equal(res.created, false)
    assert.equal(res.error, 'validation')
    assert.equal(res.field, 'cadence.expression')
    assert.match(res.message, /invalid cron expression/)
    assert.equal(store.list().length, 0, 'nothing persisted on validation failure')
    assert.match(w.text(), /Invalid schedule/)
  })

  it('rejects an unparseable --at and persists nothing', () => {
    const store = makeStore()
    const w = cap()
    const res = runScheduleCreate({ prompt: 'bad', at: 'not-a-date' }, baseDeps(store, w.write))
    assert.equal(res.created, false)
    assert.equal(res.error, 'invalid-cadence')
    assert.equal(store.list().length, 0)
  })

  // #7015 — the invalid-date hint has to be copy-pasteable without changing
  // meaning. This CLI renders every timestamp in UTC (formatEpoch), but
  // Date.parse reads an offset-less date-time as LOCAL time, so suggesting
  // "2026-08-01T09:00:00" told the operator to write something that lands at a
  // different instant than the one they then see echoed back. The parse
  // behaviour is deliberately unchanged (that would move existing scripted
  // invocations); the hint has to disclose it instead.
  it('the unparseable --at hint carries an explicit timezone and names the local/UTC split', () => {
    const store = makeStore()
    const w = cap()
    const res = runScheduleCreate({ prompt: 'bad', at: 'not-a-date' }, baseDeps(store, w.write))
    assert.equal(res.created, false)
    assert.match(res.message, /2026-08-01T09:00:00Z/, 'the suggested example must carry an explicit zone')
    assert.match(res.message, /UTC/, 'must say times are displayed in UTC')
    assert.match(res.message, /local time/i, 'must say an offset-less value is read as local time')
    // Guard the regression directly: a bare, zone-less example must not come back.
    assert.doesNotMatch(res.message, /2026-08-01T09:00:00(?![Z+])/)
    // The operator sees the same hint on stdout, not just in the return value.
    assert.match(w.text(), /2026-08-01T09:00:00Z/)
  })

  it('requires exactly one of --at / --cron', () => {
    const store = makeStore()
    const neither = runScheduleCreate({ prompt: 'x' }, baseDeps(store, cap().write))
    assert.equal(neither.error, 'invalid-cadence')
    assert.match(neither.message, /specify a cadence/)

    const both = runScheduleCreate({ prompt: 'x', at: '2099-01-01T00:00:00Z', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    assert.equal(both.error, 'invalid-cadence')
    assert.match(both.message, /mutually exclusive/)
    assert.equal(store.list().length, 0)
  })

  it('requires a non-empty prompt', () => {
    const store = makeStore()
    const res = runScheduleCreate({ cron: '0 9 * * *' }, baseDeps(store, cap().write))
    assert.equal(res.error, 'missing-prompt')
    assert.equal(store.list().length, 0)
  })

  it('--paused creates the task disabled with no next run', () => {
    const store = makeStore()
    const w = cap()
    const res = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', paused: true }, baseDeps(store, w.write))
    assert.equal(res.task.enabled, false)
    assert.equal(res.task.nextRun, null)
    assert.match(w.text(), /paused; resume with/)
  })

  // The core honesty requirement: a task whose target provider the engine
  // would REFUSE (e.g. the daemon default claude-tui — no in-process
  // permission answering) must warn AT CREATE TIME, using the engine's own
  // check (injected here as checkProviderRefusal) rather than a re-derived rule.
  it('warns at create time when the target provider would be refused by the engine', () => {
    const store = makeStore()
    const w = cap()
    const reason = "provider 'claude-tui' routes permission prompts through the permission hook..."
    const res = runScheduleCreate(
      { prompt: 'x', cron: '0 9 * * *' },
      baseDeps(store, w.write, { checkProviderRefusal: (name) => (name === 'claude-tui' ? reason : null) }),
    )
    assert.equal(res.created, true, 'the task is still created — a warning, not a hard error')
    assert.ok(res.warnings.some((msg) => msg.includes('will be REFUSED') && msg.includes(reason)))
    assert.match(w.text(), /WARNING:.*will be REFUSED/)
  })

  it('does not warn about the provider when the engine reports it schedulable', () => {
    const store = makeStore()
    const w = cap()
    const res = runScheduleCreate(
      { prompt: 'x', cron: '0 9 * * *', provider: 'claude-sdk' },
      baseDeps(store, w.write, { checkProviderRefusal: () => null }),
    )
    assert.equal(res.warnings.length, 0)
    assert.doesNotMatch(w.text(), /REFUSED/)
  })

  // The scheduler is default-off: create must still succeed but say plainly
  // that nothing will fire until the gate is opened.
  it('warns plainly when the scheduler is globally disabled, but still creates the task', () => {
    const store = makeStore()
    const w = cap()
    const res = runScheduleCreate(
      { prompt: 'x', cron: '0 9 * * *' },
      baseDeps(store, w.write, { checkSchedulerEnabled: () => false }),
    )
    assert.equal(res.created, true)
    assert.ok(res.warnings.some((msg) => /DISABLED/.test(msg) && /features\.scheduler/.test(msg)))
    assert.match(w.text(), /WARNING:.*DISABLED/)
  })

  it('does not warn about the scheduler gate when it is enabled', () => {
    const store = makeStore()
    const w = cap()
    const res = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, w.write, { checkSchedulerEnabled: () => true }))
    assert.equal(res.warnings.length, 0)
  })

  it('warns when the requested permission mode will be clamped by the engine', () => {
    const store = makeStore()
    const w = cap()
    const res = runScheduleCreate(
      { prompt: 'x', cron: '0 9 * * *', permissionMode: 'auto' },
      baseDeps(store, w.write, { resolvePermissionMode: () => 'approve' }),
    )
    assert.ok(res.warnings.some((msg) => msg.includes("clamped to 'approve'")))
  })

  it('rejects a malformed permission mode via the store\'s own validation', () => {
    const store = makeStore()
    const res = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', permissionMode: 'godmode' }, baseDeps(store, cap().write))
    assert.equal(res.error, 'validation')
    assert.equal(res.field, 'target.permissionMode')
  })
})

describe('chroxy schedule list (#6868)', () => {
  it('reports the scheduler enable-gate state up top', () => {
    const store = makeStore()
    const wOn = cap()
    runScheduleList({}, baseDeps(store, wOn.write, { checkSchedulerEnabled: () => true }))
    assert.match(wOn.text(), /Scheduled execution: ENABLED/)

    const wOff = cap()
    runScheduleList({}, baseDeps(store, wOff.write, { checkSchedulerEnabled: () => false }))
    assert.match(wOff.text(), /Scheduled execution: DISABLED/)
  })

  it('a never-fired task renders as [NEVER RUN], never blank or healthy-looking', () => {
    const store = makeStore()
    runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', name: 'Fresh' }, baseDeps(store, cap().write))
    const w = cap()
    const res = runScheduleList({}, baseDeps(store, w.write))
    assert.equal(res.tasks[0].health, 'NEVER RUN')
    assert.match(w.text(), /\[NEVER RUN\] Fresh/)
    assert.match(w.text(), /last run: never run/)
  })

  it('a refused-outcome task renders as [REFUSED] with the reason visible, never as healthy', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', name: 'Nightly' }, baseDeps(store, cap().write))
    store.update(created.task.id, {
      lastRun: { at: NOW - 1000, status: 'refused', error: "provider 'claude-tui' routes permission prompts..." },
    })
    const w = cap()
    const res = runScheduleList({}, baseDeps(store, w.write))
    const row = res.tasks.find((r) => r.task.id === created.task.id)
    assert.equal(row.health, 'REFUSED')
    assert.match(w.text(), /\[REFUSED\] Nightly/)
    assert.match(w.text(), /last run: refused @ .* — provider 'claude-tui'/)
  })

  // Quarantine (scheduler.js's `_quarantine`) is process-scoped and has no
  // dedicated persisted field — its only durable trace is a best-effort
  // lastRun write of status `refused` with a "quarantined until daemon
  // restart" message. `list` must render that exactly as unhealthy as any
  // other refusal — it must NEVER look like a clean/successful task just
  // because the underlying status enum only has `refused`.
  it('a quarantined task (persisted as refused + quarantine message) never looks healthy', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', name: 'Quarantined one' }, baseDeps(store, cap().write))
    store.update(created.task.id, {
      lastRun: {
        at: NOW - 1000,
        status: 'refused',
        error: 'quarantined until daemon restart: its run outcome could not be recorded: disk full',
      },
    })
    const w = cap()
    const res = runScheduleList({}, baseDeps(store, w.write))
    const row = res.tasks.find((r) => r.task.id === created.task.id)
    assert.equal(row.health, 'REFUSED', 'quarantine surfaces as REFUSED, never OK')
    assert.notEqual(row.health, 'OK')
    assert.match(w.text(), /\[REFUSED\] Quarantined one/)
    assert.match(w.text(), /quarantined until daemon restart/)
  })

  it('a paused task renders as [PAUSED] with no next run', () => {
    const store = makeStore()
    runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', name: 'Off', paused: true }, baseDeps(store, cap().write))
    const w = cap()
    runScheduleList({}, baseDeps(store, w.write))
    assert.match(w.text(), /\[PAUSED\] Off/)
    assert.match(w.text(), /next run: — \(paused\)/)
  })

  it('a successfully-run task renders as [OK]', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', name: 'Healthy' }, baseDeps(store, cap().write))
    store.update(created.task.id, { lastRun: { at: NOW - 1000, status: 'success', sessionId: 'sess-1' } })
    const w = cap()
    const res = runScheduleList({}, baseDeps(store, w.write))
    assert.equal(res.tasks.find((r) => r.task.id === created.task.id).health, 'OK')
    assert.match(w.text(), /\[OK\] Healthy/)
    assert.match(w.text(), /session sess-1/)
  })

  it('--json emits the same data machine-readably, including health and providerRefusal', () => {
    const store = makeStore()
    runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', name: 'J' }, baseDeps(store, cap().write))
    const w = cap()
    runScheduleList({ json: true }, baseDeps(store, w.write, { checkProviderRefusal: () => 'nope' }))
    const parsed = JSON.parse(w.text())
    assert.equal(parsed.schedulerEnabled, true)
    assert.equal(parsed.tasks.length, 1)
    assert.equal(parsed.tasks[0].health, 'NEVER RUN')
    assert.equal(parsed.tasks[0].providerRefusal, 'nope')
  })

  it('an empty registry says so instead of printing nothing', () => {
    const store = makeStore()
    const w = cap()
    runScheduleList({}, baseDeps(store, w.write))
    assert.match(w.text(), /No scheduled tasks/)
  })
})

describe('chroxy schedule edit (#6868)', () => {
  it('updates the prompt in place', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'old', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    const w = cap()
    const res = runScheduleEdit(created.task.id, { prompt: 'new prompt' }, baseDeps(store, w.write))
    assert.equal(res.updated, true)
    assert.equal(res.task.prompt, 'new prompt')
  })

  it('replaces the cadence via --cron and recomputes nextRun', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', at: '2099-01-01T00:00:00Z' }, baseDeps(store, cap().write))
    const res = runScheduleEdit(created.task.id, { cron: '0 9 * * *' }, baseDeps(store, cap().write))
    assert.equal(res.updated, true)
    assert.deepEqual(res.task.cadence, { kind: 'cron', expression: '0 9 * * *' })
  })

  it('rejects mutually-exclusive --at and --cron on edit', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    const res = runScheduleEdit(created.task.id, { at: '2099-01-01T00:00:00Z', cron: '0 8 * * *' }, baseDeps(store, cap().write))
    assert.equal(res.error, 'invalid-cadence')
  })

  it('rejects an invalid cron on edit without mutating the stored task', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    const res = runScheduleEdit(created.task.id, { cron: 'garbage' }, baseDeps(store, cap().write))
    assert.equal(res.updated, false)
    assert.equal(res.error, 'validation')
    assert.deepEqual(store.get(created.task.id).cadence, { kind: 'cron', expression: '0 9 * * *' }, 'unchanged')
  })

  // store.update() REPLACES the whole target object on a `target` patch key,
  // so editing just --model must not silently drop an existing --provider.
  it('merges a single target field onto the EXISTING target rather than replacing it wholesale', () => {
    const store = makeStore()
    const created = runScheduleCreate(
      { prompt: 'x', cron: '0 9 * * *', provider: 'claude-sdk', cwd: '/work' },
      baseDeps(store, cap().write),
    )
    const res = runScheduleEdit(created.task.id, { model: 'sonnet' }, baseDeps(store, cap().write))
    assert.equal(res.task.target.provider, 'claude-sdk', 'provider survives an unrelated --model edit')
    assert.equal(res.task.target.cwd, '/work', 'cwd survives an unrelated --model edit')
    assert.equal(res.task.target.model, 'sonnet')
  })

  it('rejects editing an unknown id', () => {
    const store = makeStore()
    const res = runScheduleEdit('does-not-exist', { name: 'x' }, baseDeps(store, cap().write))
    assert.equal(res.updated, false)
    assert.equal(res.error, 'no-match')
  })

  it('is a no-op (and says so) when no fields are passed', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    const w = cap()
    const res = runScheduleEdit(created.task.id, {}, baseDeps(store, w.write))
    assert.equal(res.updated, false)
    assert.equal(res.error, 'no-changes')
    assert.match(w.text(), /Nothing to edit/)
  })

  it('surfaces the same create-time-style warnings after an edit (e.g. a provider swap into a refused one)', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', provider: 'claude-sdk' }, baseDeps(store, cap().write))
    const res = runScheduleEdit(
      created.task.id,
      { provider: 'claude-tui' },
      baseDeps(store, cap().write, { checkProviderRefusal: (name) => (name === 'claude-tui' ? 'nope' : null) }),
    )
    assert.ok(res.warnings.some((m) => m.includes('will be REFUSED')))
  })
})

describe('chroxy schedule pause / resume (#6868)', () => {
  it('pause sets enabled=false and clears nextRun', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    const w = cap()
    const res = runSchedulePause(created.task.id, {}, baseDeps(store, w.write))
    assert.equal(res.changed, true)
    assert.equal(res.task.enabled, false)
    assert.equal(res.task.nextRun, null)
    assert.match(w.text(), /paused/)
  })

  it('resume sets enabled=true and recomputes nextRun', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', paused: true }, baseDeps(store, cap().write))
    assert.equal(created.task.nextRun, null)
    const w = cap()
    const res = runScheduleResume(created.task.id, {}, baseDeps(store, w.write))
    assert.equal(res.task.enabled, true)
    assert.equal(typeof res.task.nextRun, 'number')
    assert.match(w.text(), /resumed/)
  })

  it('pausing an unknown id fails clearly without touching the store', () => {
    const store = makeStore()
    const res = runSchedulePause('nope', {}, baseDeps(store, cap().write))
    assert.equal(res.changed, false)
    assert.equal(res.error, 'no-match')
  })

  it('pause does not require --yes (fully reversible via resume)', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    const res = runSchedulePause(created.task.id, {}, baseDeps(store, cap().write))
    assert.equal(res.changed, true)
  })
})

describe('chroxy schedule delete (#6868)', () => {
  it('without --yes explains what would be removed and deletes nothing', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', name: 'ToDelete' }, baseDeps(store, cap().write))
    const w = cap()
    const res = runScheduleDelete(created.task.id, {}, baseDeps(store, w.write))
    assert.equal(res.deleted, false)
    assert.equal(res.confirmed, false)
    assert.equal(store.list().length, 1, 'nothing removed without --yes')
    assert.match(w.text(), /re-run with --yes/)
    assert.match(w.text(), /cannot be undone/)
  })

  it('with --yes permanently deletes the task', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    const w = cap()
    const res = runScheduleDelete(created.task.id, { yes: true }, baseDeps(store, w.write))
    assert.equal(res.deleted, true)
    assert.equal(store.list().length, 0)
    assert.match(w.text(), /Deleted scheduled task/)
  })

  it('deleting an unknown id fails clearly', () => {
    const store = makeStore()
    const res = runScheduleDelete('nope', { yes: true }, baseDeps(store, cap().write))
    assert.equal(res.deleted, false)
    assert.equal(res.error, 'no-match')
  })

  it('resolves a unique id prefix for delete', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    const prefix = created.task.id.slice(0, 8)
    const res = runScheduleDelete(prefix, { yes: true }, baseDeps(store, cap().write))
    assert.equal(res.deleted, true)
  })
})

describe('chroxy schedule last-run (#6868)', () => {
  it('a never-run task is reported honestly, not blank or omitted', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *', name: 'Fresh' }, baseDeps(store, cap().write))
    const w = cap()
    const res = runScheduleLastRun(created.task.id, {}, baseDeps(store, w.write))
    assert.equal(res.found, true)
    assert.equal(res.health, 'NEVER RUN')
    assert.match(w.text(), /\[NEVER RUN\] never run/)
    assert.match(w.text(), /This task has never fired/)
  })

  it('a refused task shows the refusal reason, tagged unhealthy', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    store.update(created.task.id, { lastRun: { at: NOW, status: 'refused', error: 'bad cwd' } })
    const w = cap()
    const res = runScheduleLastRun(created.task.id, {}, baseDeps(store, w.write))
    assert.equal(res.health, 'REFUSED')
    assert.match(w.text(), /\[REFUSED\] refused @ .* — bad cwd/)
  })

  it('notes when the scheduler is globally disabled even for a healthy-looking task', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    store.update(created.task.id, { lastRun: { at: NOW, status: 'success' } })
    const w = cap()
    runScheduleLastRun(created.task.id, {}, baseDeps(store, w.write, { checkSchedulerEnabled: () => false }))
    assert.match(w.text(), /scheduled execution is DISABLED/)
  })

  it('an unknown id fails clearly', () => {
    const store = makeStore()
    const res = runScheduleLastRun('nope', {}, baseDeps(store, cap().write))
    assert.equal(res.found, false)
    assert.equal(res.error, 'no-match')
  })
})

describe('chroxy schedule — id / id-prefix resolution (#6868)', () => {
  // #7015 — the old version of this test derived its ambiguous prefix from
  // two random UUIDs' *actual* shared leading characters, which only exist
  // ~6% of the time (1/16 chance two random hex digits match); every other
  // run silently returned early with nothing asserted. `resolveTaskId`
  // guards every mutating command (`edit`/`pause`/`resume`/`delete`) against
  // resolving an ambiguous prefix to the WRONG task — on `delete` that is a
  // destructive/irreversible action, so this must be deterministic, not
  // probabilistic. Seed two tasks via `store.add()`'s caller-supplied `id`
  // (a real, store-supported input field, not a stub) with a fixed shared
  // prefix, guaranteeing ambiguity on every run.
  function seedTask(store, id) {
    return store.add({ id, prompt: 'x', cadence: { kind: 'cron', expression: '0 9 * * *' } })
  }

  it('a prefix matching >1 task is rejected as ambiguous and resolves NO task on edit or delete', () => {
    const store = makeStore()
    const a = seedTask(store, 'ambig-0001-AAAA')
    const b = seedTask(store, 'ambig-0002-BBBB')

    const editRes = runScheduleEdit('ambig-000', { name: 'x' }, baseDeps(store, cap().write))
    assert.equal(editRes.updated, false)
    assert.equal(editRes.error, 'ambiguous')
    assert.match(editRes.message, /matches 2 tasks/)
    assert.equal(store.get(a.id).name, null, 'task A untouched by the ambiguous edit')
    assert.equal(store.get(b.id).name, null, 'task B untouched by the ambiguous edit')

    // The destructive command is the one that actually matters here: an
    // ambiguous prefix must never delete the wrong (or any) task.
    const delRes = runScheduleDelete('ambig-000', { yes: true }, baseDeps(store, cap().write))
    assert.equal(delRes.deleted, false)
    assert.equal(delRes.error, 'ambiguous')
    assert.equal(store.list().length, 2, 'neither task was deleted')
  })

  it('a prefix matching exactly 1 task still resolves correctly', () => {
    const store = makeStore()
    const a = seedTask(store, 'ambig-0001-AAAA')
    const b = seedTask(store, 'ambig-0002-BBBB')

    // 'ambig-0001' is a prefix of only task A's id, even though both ids
    // share the shorter 'ambig-000' prefix exercised above.
    const res = runScheduleEdit('ambig-0001', { name: 'Edited A' }, baseDeps(store, cap().write))
    assert.equal(res.updated, true)
    assert.equal(res.task.id, a.id)
    assert.equal(store.get(a.id).name, 'Edited A')
    assert.equal(store.get(b.id).name, null, 'the other task is untouched')
  })

  it('a prefix matching 0 tasks errors as not-found and resolves nothing', () => {
    const store = makeStore()
    seedTask(store, 'ambig-0001-AAAA')
    const res = runScheduleEdit('does-not-exist', { name: 'x' }, baseDeps(store, cap().write))
    assert.equal(res.updated, false)
    assert.equal(res.error, 'no-match')
  })

  it('a unique id prefix resolves correctly for last-run', () => {
    const store = makeStore()
    const created = runScheduleCreate({ prompt: 'x', cron: '0 9 * * *' }, baseDeps(store, cap().write))
    const res = runScheduleLastRun(created.task.id.slice(0, 12), {}, baseDeps(store, cap().write))
    assert.equal(res.found, true)
    assert.equal(res.task.id, created.task.id)
  })
})

// #7015 / #7052 — the registry file this CLI touches must be the one the RUNNING
// daemon reads. The invariant is AGREEMENT between the two; which root they
// agree on is a detail that has now changed once.
//
// Until #7052 both were home-rooted, and this guard pinned that: it asserted
// SessionManager's default state file ignored `CHROXY_CONFIG_DIR`, and said in
// as many words that if the session-state family were ever migrated onto the
// env var, the premise check would go red and schedule-cmd.js must move with
// it. That is exactly what happened — `defaultStateFile()` is now
// `configPath('session-state.json')` and the CLI resolver follows through
// `configDir()`. The guard did its job; this is the other side of it.
//
// The premises are now asserted BEHAVIOURALLY rather than by grepping
// session-manager.js's source. A source-grep guard pins a spelling, so it goes
// red on a harmless rename and — worse — goes green if the code moves somewhere
// the regex still matches. Relocating the env var and observing where both
// resolvers actually land tests the thing the CLI depends on. The end-to-end
// half (a spawned CLI and the daemon reading the same file) lives in
// tests/cli/schedule-cmd.test.js.
describe('chroxy schedule — registry path agrees with the daemon (#7015, #7052)', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
  const readSrc = (rel) => readFileSync(join(srcDir, rel), 'utf-8')

  const withConfigDir = async (dir, fn) => {
    const prev = process.env.CHROXY_CONFIG_DIR
    if (dir === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = dir
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env.CHROXY_CONFIG_DIR
      else process.env.CHROXY_CONFIG_DIR = prev
    }
  }

  it('resolves to the daemon-derived sibling of session-state.json', async () => {
    await withConfigDir(undefined, () => {
      assert.equal(
        defaultScheduleRegistryPath(),
        defaultScheduledTasksPath(join(homedir(), '.chroxy', 'session-state.json')),
      )
    })
  })

  it('premise 1: server-cli.js passes no stateFilePath, so SessionManager falls back to its default', () => {
    assert.ok(
      !readSrc('server-cli.js').includes('stateFilePath'),
      'server-cli.js now sets stateFilePath — re-derive defaultScheduleRegistryPath() from whatever it passes',
    )
  })

  it('premise 2: the CLI and SessionManager land on the same registry when CHROXY_CONFIG_DIR moves', async () => {
    // `defaultStateFile()` is the daemon's fallback — server-cli.js injects no
    // stateFilePath (premise 1), so this IS the path the live scheduler opens.
    // Asserted directly rather than by constructing a SessionManager, which
    // would need a stateFilePath of its own and defeat the point.
    const relocated = join(tmpdir(), 'chroxy-sched-envdir-fixture')
    await withConfigDir(relocated, () => {
      assert.equal(
        defaultScheduleRegistryPath(),
        defaultScheduledTasksPath(defaultStateFile()),
        'the CLI and the daemon derive different registries under CHROXY_CONFIG_DIR — '
          + '`schedule create` would report success for a task that can never fire',
      )
      assert.ok(
        defaultScheduleRegistryPath().startsWith(relocated),
        'the registry did not follow CHROXY_CONFIG_DIR',
      )
    })
  })

  it('premise 2b: with CHROXY_CONFIG_DIR unset, both fall back to $HOME/.chroxy', async () => {
    // The positive control for the case above: without it, "both agree" would
    // also be satisfied by two resolvers that each ignore the env var.
    await withConfigDir(undefined, () => {
      assert.ok(
        defaultScheduleRegistryPath().startsWith(join(homedir(), '.chroxy')),
        'the home fallback no longer applies',
      )
    })
  })

  it('premise 3: SessionManager derives its registry from that state file', () => {
    assert.match(
      readSrc('session-manager.js'),
      /new ScheduledTaskStore\(\{ filePath: defaultScheduledTasksPath\(this\._stateFilePath\) \}\)/,
      'the daemon no longer derives its registry from the session-state path — re-check the CLI resolver',
    )
  })
})
