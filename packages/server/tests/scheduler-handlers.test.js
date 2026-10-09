import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schedulerHandlers } from '../src/handlers/scheduler-handlers.js'
import { ScheduledTaskStore } from '../src/scheduled-task-store.js'
import { ServerScheduledTasksSchema } from '@chroxy/protocol'
import { listSchedulableProviders } from '../src/scheduler.js'

// #6871 — the scheduled-tasks WS surface. Driven against a REAL
// ScheduledTaskStore backed by a temp file (never ~/.chroxy — the sandbox guard
// would throw), with a stub engine for the gate/quarantine readout. No provider
// is ever spawned and no session is created.

const WS = {} // opaque handle passed to ctx.transport.send

const TMP = mkdtempSync(join(tmpdir(), 'chroxy-sched-ws-'))
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ } })

let storeSeq = 0
function mkStore() {
  // A fresh temp file per store so tests never share persisted state.
  return new ScheduledTaskStore({ filePath: join(TMP, `tasks-${++storeSeq}.json`) })
}

/** A provider the engine ACCEPTS for unattended runs, read off the live registry. */
const SCHEDULABLE = listSchedulableProviders()[0]

function mkCtx({
  store = mkStore(),
  enabled = false,
  engine = null,
  providerType = SCHEDULABLE,
} = {}) {
  const sent = []
  const ctx = {
    transport: { send: (_ws, msg) => sent.push(msg) },
    sessions: {
      sessionManager: { scheduledTaskStore: store, providerType },
    },
    services: {
      config: { features: { scheduler: enabled } },
      schedulerEngine: engine,
    },
  }
  return { ctx, sent, store }
}

const primaryClient = { isPrimaryToken: true, boundSessionId: null }
const nonPrimaryClient = { isPrimaryToken: false, boundSessionId: null }
const boundPrimaryClient = { isPrimaryToken: true, boundSessionId: 's-bound' }
const boundPairingClient = { isPrimaryToken: false, boundSessionId: 's-bound' }

const req = (over = {}) => ({ type: 'scheduled_tasks_request', requestId: 'r-1', ...over })
const action = (over = {}) => ({ type: 'scheduled_task_action', requestId: 'a-1', ...over })

/** A valid create payload targeting a provider the engine accepts. */
const goodTask = () => ({
  name: 'nightly',
  prompt: 'run the nightly sweep',
  cadence: { kind: 'cron', expression: '0 9 * * *' },
  target: { provider: SCHEDULABLE },
})

describe('scheduler handlers — authority gates', () => {
  it('rejects EVERY mutation from a non-primary (pairing) token', () => {
    for (const msg of [
      action({ action: 'create', task: goodTask() }),
      action({ action: 'update', taskId: 't1', task: { prompt: 'x' } }),
      action({ action: 'pause', taskId: 't1' }),
      action({ action: 'resume', taskId: 't1' }),
      action({ action: 'delete', taskId: 't1' }),
      action({ action: 'discard_unreadable', handle: '0123456789abcdef' }),
      { type: 'set_scheduler_enabled', enabled: true, requestId: 'g-1' },
    ]) {
      const { ctx, sent } = mkCtx()
      const fn = schedulerHandlers[msg.type]
      fn(WS, nonPrimaryClient, msg, ctx)
      assert.equal(sent.length, 1, `${msg.type}/${msg.action ?? ''} should send exactly one reply`)
      assert.equal(sent[0].type, 'session_error')
      assert.equal(sent[0].code, 'SCHEDULER_FORBIDDEN_NON_PRIMARY_CLIENT')
      assert.equal(sent[0].requestId, msg.requestId, 'the rejection must echo requestId so the client clears pending')
    }
  })

  it('a non-primary token cannot create a task even with a perfectly valid payload', () => {
    const { ctx, store } = mkCtx()
    schedulerHandlers.scheduled_task_action(
      WS, nonPrimaryClient, action({ action: 'create', task: goodTask() }), ctx,
    )
    assert.equal(store.list().length, 0, 'the payload must never reach the registry')
  })

  it('a pairing-BOUND client cannot read the host registry', () => {
    const { ctx, sent } = mkCtx()
    schedulerHandlers.scheduled_tasks_request(WS, boundPairingClient, req(), ctx)
    assert.equal(sent[0].type, 'session_error')
    assert.equal(sent[0].code, 'SCHEDULER_FORBIDDEN_BOUND_CLIENT')
  })

  it('a bound client is refused the read even when it holds the primary token', () => {
    const { ctx, sent } = mkCtx()
    schedulerHandlers.scheduled_tasks_request(WS, boundPrimaryClient, req(), ctx)
    assert.equal(sent[0].code, 'SCHEDULER_FORBIDDEN_BOUND_CLIENT')
  })

  // #7025 — the MUTATION gate must be strictly STRONGER than the READ gate.
  // It used to be weaker in exactly the unsafe direction: a bound + primary
  // client was refused the harmless registry read (the test above) yet was
  // permitted every mutation, because the write gate returned early on
  // `isPrimaryToken === true` without ever looking at `boundSessionId`.
  it('a bound client is refused EVERY mutation even when it holds the primary token', () => {
    // The seven mutations enumerated from the handler map: the six
    // `scheduled_task_action` verbs plus the persisted global gate flip.
    const mutations = [
      action({ action: 'create', task: goodTask() }),
      action({ action: 'update', taskId: 't1', task: { prompt: 'x' } }),
      action({ action: 'pause', taskId: 't1' }),
      action({ action: 'resume', taskId: 't1' }),
      action({ action: 'delete', taskId: 't1' }),
      action({ action: 'discard_unreadable', handle: '0123456789abcdef' }),
      { type: 'set_scheduler_enabled', enabled: true, requestId: 'g-1' },
    ]
    assert.equal(mutations.length, 7, 'all seven scheduler mutations must be covered')

    for (const msg of mutations) {
      const label = `${msg.type}${msg.action ? `/${msg.action}` : ''}`
      const { ctx, sent, store } = mkCtx()
      schedulerHandlers[msg.type](WS, boundPrimaryClient, msg, ctx)
      assert.equal(sent.length, 1, `${label} should send exactly one reply`)
      assert.equal(sent[0].type, 'session_error', label)
      assert.equal(sent[0].code, 'SCHEDULER_FORBIDDEN_NON_PRIMARY_CLIENT', label)
      assert.equal(sent[0].requestId, msg.requestId, `${label}: the rejection must echo requestId`)
      assert.equal(store.list().length, 0, `${label} must never reach the registry`)
      // The two refusals share one code, so the MESSAGE is the only thing that
      // can describe the real bar. It must name the whole requirement (an
      // unbound primary token) rather than only the reachable half — a bound
      // primary told its problem is being "pairing-issued" is a dishonest status.
      assert.match(
        sent[0].message, /unbound primary/i,
        `${label}: the refusal must state the actual requirement, not just the pairing case`,
      )
    }
  })

  // POSITIVE CONTROL for the loop above: the SAME messages, from an UNBOUND
  // primary, still clear the authority gate. Without this the loop could pass
  // for free on a fixture that never reached a handler at all.
  //
  // `set_scheduler_enabled` is deliberately absent here: it is the one mutation
  // that persists to the real config.json once past the gate, and this suite
  // must not write outside its temp dir.
  it('the same mutations from an UNBOUND primary still clear the authority gate', () => {
    for (const msg of [
      action({ action: 'create', task: goodTask() }),
      action({ action: 'update', taskId: 't1', task: { prompt: 'x' } }),
      action({ action: 'pause', taskId: 't1' }),
      action({ action: 'resume', taskId: 't1' }),
      action({ action: 'delete', taskId: 't1' }),
      action({ action: 'discard_unreadable', handle: '0123456789abcdef' }),
    ]) {
      const { ctx, sent } = mkCtx()
      schedulerHandlers.scheduled_task_action(WS, primaryClient, msg, ctx)
      assert.equal(sent.length, 1, `scheduled_task_action/${msg.action} should send exactly one reply`)
      assert.notEqual(
        sent[0].code, 'SCHEDULER_FORBIDDEN_NON_PRIMARY_CLIENT',
        `scheduled_task_action/${msg.action} must pass the authority gate for an unbound primary`,
      )
    }
  })

  it('the primary token is allowed to read and mutate', () => {
    const { ctx, sent, store } = mkCtx()
    schedulerHandlers.scheduled_task_action(
      WS, primaryClient, action({ action: 'create', task: goodTask() }), ctx,
    )
    assert.equal(sent[0].type, 'scheduled_tasks', 'the ack is the re-emitted snapshot')
    assert.equal(store.list().length, 1)
  })
})

describe('scheduler handlers — snapshot shape + gate honesty', () => {
  it('emits a schema-valid snapshot', () => {
    const { ctx, sent } = mkCtx()
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    const parsed = ServerScheduledTasksSchema.safeParse(sent[0])
    assert.equal(parsed.success, true, parsed.error?.message)
    assert.equal(parsed.data.requestId, 'r-1')
  })

  it('reports the gate CLOSED by default, with no engine armed', () => {
    const { ctx, sent } = mkCtx({ enabled: false, engine: null })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.deepEqual(sent[0].scheduler, {
      enabled: false,
      engineArmed: false,
      restartRequired: false,
      source: 'default',
    })
  })

  it('reports restartRequired when the gate is OPEN but no engine is armed', () => {
    const { ctx, sent } = mkCtx({ enabled: true, engine: null })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(sent[0].scheduler.enabled, true)
    assert.equal(sent[0].scheduler.engineArmed, false)
    assert.equal(sent[0].scheduler.restartRequired, true)
    assert.equal(sent[0].scheduler.source, 'config')
  })

  it('reports restartRequired when the engine is STILL armed but the gate was closed', () => {
    // The dangerous direction: an operator disabled the gate, but the running
    // daemon keeps firing. The panel must not present this as "disabled, done".
    const engine = { armed: true, quarantinedTaskIds: new Set() }
    const { ctx, sent } = mkCtx({ enabled: false, engine })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(sent[0].scheduler.enabled, false)
    assert.equal(sent[0].scheduler.engineArmed, true)
    assert.equal(sent[0].scheduler.restartRequired, true)
  })

  it('no restart is required when the gate and the live engine agree', () => {
    const engine = { armed: true, quarantinedTaskIds: new Set() }
    const { ctx, sent } = mkCtx({ enabled: true, engine })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(sent[0].scheduler.restartRequired, false)
  })

  it('degrades to a schema-valid empty snapshot when there is no registry', () => {
    const { ctx, sent } = mkCtx()
    ctx.sessions.sessionManager = null
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    const parsed = ServerScheduledTasksSchema.safeParse(sent[0])
    assert.equal(parsed.success, true, parsed.error?.message)
    assert.deepEqual(parsed.data.tasks, [])
    assert.equal(parsed.data.error?.code, 'SCHEDULER_REGISTRY_UNAVAILABLE')
  })
})

// #6871 review — the store enforces NO length caps but the wire schema does, so
// a perfectly store-legal task could make the WHOLE snapshot fail the dashboard's
// safeParse. Every task then vanished and the tab hung on "Loading…" with no
// error, unrecoverable without a page reload. The projection must always emit
// something the contract can represent.
describe('scheduler handlers — a store-legal task is always WIRE-legal', () => {
  it('clamps over-cap strings so the snapshot still validates', () => {
    const { ctx, sent, store } = mkCtx()
    // All store-legal: the store caps none of these.
    store.add({
      name: 'n'.repeat(400),
      prompt: 'p',
      cadence: { kind: 'cron', expression: '0 9 * * *' },
      target: { provider: 'x'.repeat(200), model: 'm'.repeat(400), cwd: `/${'d'.repeat(5000)}` },
    })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)

    const parsed = ServerScheduledTasksSchema.safeParse(sent[0])
    assert.ok(parsed.success, `snapshot must stay wire-valid: ${parsed.error?.message}`)
    const task = parsed.data.tasks[0]
    assert.equal(task.name.length, 256)
    assert.equal(task.target.provider.length, 128)
    assert.equal(task.target.model.length, 256)
    assert.equal(task.target.cwd.length, 4096)
    // The task is still THERE — clamping a display string beats dropping the
    // whole snapshot (or hiding a scheduled task from its operator).
    assert.equal(parsed.data.tasks.length, 1)
  })

  it('clamps a long lastRun error (the realistic case — an engine stack trace)', () => {
    const { ctx, sent, store } = mkCtx()
    const task = store.add({ prompt: 'p', cadence: { kind: 'cron', expression: '0 9 * * *' } })
    store.update(task.id, { lastRun: { at: 1, status: 'error', error: 'e'.repeat(9000) } })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)

    const parsed = ServerScheduledTasksSchema.safeParse(sent[0])
    assert.ok(parsed.success, `snapshot must stay wire-valid: ${parsed.error?.message}`)
    assert.equal(parsed.data.tasks[0].lastRun.error.length, 2048)
  })

  it('leaves normal-length values untouched', () => {
    const { ctx, sent, store } = mkCtx()
    store.add({ name: 'nightly', prompt: 'p', cadence: { kind: 'cron', expression: '0 9 * * *' }, target: { provider: SCHEDULABLE } })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)

    const parsed = ServerScheduledTasksSchema.safeParse(sent[0])
    assert.ok(parsed.success)
    assert.equal(parsed.data.tasks[0].name, 'nightly')
    assert.equal(parsed.data.tasks[0].target.provider, SCHEDULABLE)
  })
})

describe('scheduler handlers — engine verdicts are passed through, not re-derived', () => {
  it('flags a task whose provider the engine REFUSES, naming the provider', () => {
    const { ctx, sent, store } = mkCtx()
    store.add({ prompt: 'p', cadence: { kind: 'cron', expression: '* * * * *' }, target: { provider: 'claude-tui' } })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    const task = sent[0].tasks[0]
    assert.equal(task.effectiveProvider, 'claude-tui')
    assert.ok(task.providerRefusal, 'a hook-routed provider must carry a refusal reason')
    assert.match(task.providerRefusal, /claude-tui/)
    assert.match(task.providerRefusal, /permission hook/)
  })

  it('carries NO refusal for a provider the engine accepts', () => {
    const { ctx, sent, store } = mkCtx()
    store.add({ prompt: 'p', cadence: { kind: 'cron', expression: '* * * * *' }, target: { provider: SCHEDULABLE } })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(sent[0].tasks[0].providerRefusal, null)
  })

  it('resolves a task with NO target.provider against the daemon default', () => {
    const { ctx, sent, store } = mkCtx({ providerType: 'claude-tui' })
    store.add({ prompt: 'p', cadence: { kind: 'cron', expression: '* * * * *' } })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    const task = sent[0].tasks[0]
    assert.equal(task.effectiveProvider, 'claude-tui', 'must judge the provider the run would ACTUALLY use')
    assert.ok(task.providerRefusal, 'a task inheriting a refused default must be flagged')
  })

  it('surfaces the DEFAULT provider refusal on the snapshot so the create form can warn up front', () => {
    const { ctx, sent } = mkCtx({ providerType: 'claude-tui' })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(sent[0].defaultProvider, 'claude-tui')
    assert.ok(sent[0].defaultProviderRefusal, 'a refused default must be advertised before a task is saved')
    assert.ok(Array.isArray(sent[0].schedulableProviders))
    assert.deepEqual(sent[0].schedulableProviders, listSchedulableProviders())
  })

  it('reports the CLAMPED permission mode and flags that it was clamped', () => {
    const { ctx, sent, store } = mkCtx()
    store.add({
      prompt: 'p',
      cadence: { kind: 'cron', expression: '* * * * *' },
      target: { provider: SCHEDULABLE, permissionMode: 'auto' },
    })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    const task = sent[0].tasks[0]
    assert.equal(task.effectivePermissionMode, 'approve', 'auto must clamp to the unattended floor')
    assert.equal(task.permissionModeClamped, true)
  })

  it('does not report a clamp for a mode the engine allows, or for no mode at all', () => {
    const { ctx, sent, store } = mkCtx()
    store.add({ prompt: 'a', cadence: { kind: 'cron', expression: '* * * * *' }, target: { provider: SCHEDULABLE, permissionMode: 'plan' } })
    store.add({ prompt: 'b', cadence: { kind: 'cron', expression: '* * * * *' }, target: { provider: SCHEDULABLE } })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    const [plan, none] = sent[0].tasks
    assert.equal(plan.effectivePermissionMode, 'plan')
    assert.equal(plan.permissionModeClamped, false)
    assert.equal(none.effectivePermissionMode, 'approve')
    assert.equal(none.permissionModeClamped, false, 'an absent mode is a default, not a downgrade to warn about')
  })

  it('marks a task the engine has QUARANTINED (state the record cannot express)', () => {
    const store = mkStore()
    const created = store.add({ prompt: 'p', cadence: { kind: 'cron', expression: '* * * * *' }, target: { provider: SCHEDULABLE } })
    const engine = { armed: true, quarantinedTaskIds: new Set([created.id]) }
    const { ctx, sent } = mkCtx({ store, enabled: true, engine })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(sent[0].tasks[0].quarantined, true)
  })

  it('passes a lastRun through VERBATIM, including a quarantine explanation', () => {
    const store = mkStore()
    store.add({
      prompt: 'p',
      cadence: { kind: 'cron', expression: '* * * * *' },
      target: { provider: SCHEDULABLE },
      lastRun: { at: 1700000000000, status: 'refused', error: 'quarantined until daemon restart: disk full' },
    })
    const { ctx, sent } = mkCtx({ store })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.deepEqual(sent[0].tasks[0].lastRun, {
      at: 1700000000000,
      status: 'refused',
      error: 'quarantined until daemon restart: disk full',
    })
  })
})

describe('scheduler handlers — mutations', () => {
  it('create persists the task and acks with the re-emitted snapshot', () => {
    const { ctx, sent, store } = mkCtx()
    schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'create', task: goodTask() }), ctx)
    assert.equal(store.list().length, 1)
    assert.equal(store.list()[0].prompt, 'run the nightly sweep')
    assert.equal(sent[0].type, 'scheduled_tasks')
    assert.equal(sent[0].requestId, 'a-1', 'the ack must echo requestId')
    assert.equal(sent[0].tasks.length, 1)
  })

  it('pause / resume flip `enabled` and clear / restore nextRun', () => {
    const { ctx, sent, store } = mkCtx()
    const t = store.add(goodTask())
    schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'pause', taskId: t.id }), ctx)
    assert.equal(store.get(t.id).enabled, false)
    assert.equal(sent.at(-1).tasks[0].enabled, false)
    schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'resume', taskId: t.id }), ctx)
    assert.equal(store.get(t.id).enabled, true)
  })

  it('update applies the patch', () => {
    const { ctx, store } = mkCtx()
    const t = store.add(goodTask())
    schedulerHandlers.scheduled_task_action(
      WS, primaryClient, action({ action: 'update', taskId: t.id, task: { prompt: 'changed' } }), ctx,
    )
    assert.equal(store.get(t.id).prompt, 'changed')
  })

  it('delete removes the task', () => {
    const { ctx, store } = mkCtx()
    const t = store.add(goodTask())
    schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'delete', taskId: t.id }), ctx)
    assert.equal(store.get(t.id), null)
    assert.equal(store.list().length, 0)
  })

  it('surfaces the store\'s field-precise validation error rather than a generic failure', () => {
    const { ctx, sent, store } = mkCtx()
    schedulerHandlers.scheduled_task_action(
      WS, primaryClient,
      action({ action: 'create', task: { prompt: '', cadence: { kind: 'cron', expression: '0 9 * * *' } } }),
      ctx,
    )
    assert.equal(sent[0].type, 'session_error')
    assert.equal(sent[0].code, 'SCHEDULED_TASK_INVALID')
    assert.match(sent[0].message, /prompt/)
    assert.equal(store.list().length, 0, 'a rejected create must not persist anything')
  })

  it('reports a bad cron expression against the cadence field', () => {
    const { ctx, sent } = mkCtx()
    schedulerHandlers.scheduled_task_action(
      WS, primaryClient,
      action({ action: 'create', task: { prompt: 'p', cadence: { kind: 'cron', expression: 'not a cron' } } }),
      ctx,
    )
    assert.equal(sent[0].code, 'SCHEDULED_TASK_INVALID')
    assert.match(sent[0].message, /cadence\.expression/)
  })

  it('reports an unknown taskId as NOT_FOUND for every id-taking action', () => {
    for (const act of ['update', 'pause', 'resume', 'delete']) {
      const { ctx, sent } = mkCtx()
      schedulerHandlers.scheduled_task_action(
        WS, primaryClient, action({ action: act, taskId: 'nope', task: { prompt: 'x' } }), ctx,
      )
      assert.equal(sent[0].code, 'SCHEDULED_TASK_NOT_FOUND', act)
    }
  })

  it('rejects an action missing its required taskId / task payload', () => {
    const cases = [
      { action: 'update', task: { prompt: 'x' } }, // no taskId
      { action: 'pause' },                          // no taskId
      { action: 'create' },                         // no task
      { action: 'update', taskId: 't1' },           // no task
    ]
    for (const c of cases) {
      const { ctx, sent } = mkCtx()
      schedulerHandlers.scheduled_task_action(WS, primaryClient, action(c), ctx)
      assert.equal(sent[0].type, 'session_error', JSON.stringify(c))
      assert.equal(sent[0].code, 'SCHEDULED_TASK_ACTION_FAILED', JSON.stringify(c))
    }
  })

  it('refreshes a running engine so a mutation is picked up without waiting a tick', () => {
    let refreshed = 0
    const engine = { armed: true, quarantinedTaskIds: new Set(), refresh: () => { refreshed++ } }
    const { ctx } = mkCtx({ enabled: true, engine })
    schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'create', task: goodTask() }), ctx)
    assert.equal(refreshed, 1)
  })

  it('a throwing engine.refresh does not turn an APPLIED mutation into a reported failure', () => {
    const engine = { armed: true, quarantinedTaskIds: new Set(), refresh: () => { throw new Error('boom') } }
    const { ctx, sent, store } = mkCtx({ enabled: true, engine })
    schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'create', task: goodTask() }), ctx)
    assert.equal(store.list().length, 1)
    assert.equal(sent.at(-1).type, 'scheduled_tasks')
  })
})

describe('scheduler handlers — the enable gate', () => {
  it('refuses a non-boolean `enabled`', () => {
    const { ctx, sent } = mkCtx()
    schedulerHandlers.set_scheduler_enabled(WS, primaryClient, { type: 'set_scheduler_enabled', enabled: 'yes', requestId: 'g-1' }, ctx)
    assert.equal(sent[0].code, 'SCHEDULER_GATE_FAILED')
  })

  it('refuses to "disable" a gate the environment forces ON, instead of writing a lie', () => {
    const prev = process.env.CHROXY_ENABLE_SCHEDULER
    process.env.CHROXY_ENABLE_SCHEDULER = '1'
    try {
      const { ctx, sent } = mkCtx()
      schedulerHandlers.set_scheduler_enabled(WS, primaryClient, { type: 'set_scheduler_enabled', enabled: false, requestId: 'g-1' }, ctx)
      assert.equal(sent[0].code, 'SCHEDULER_GATE_ENV_FORCED')
      assert.match(sent[0].message, /CHROXY_ENABLE_SCHEDULER/)
    } finally {
      if (prev === undefined) delete process.env.CHROXY_ENABLE_SCHEDULER
      else process.env.CHROXY_ENABLE_SCHEDULER = prev
    }
  })

  it('reports source `env` when the environment forces the gate open', () => {
    const prev = process.env.CHROXY_ENABLE_SCHEDULER
    process.env.CHROXY_ENABLE_SCHEDULER = '1'
    try {
      const { ctx, sent } = mkCtx({ enabled: false })
      schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
      assert.equal(sent[0].scheduler.enabled, true, 'the env var overrides config')
      assert.equal(sent[0].scheduler.source, 'env')
    } finally {
      if (prev === undefined) delete process.env.CHROXY_ENABLE_SCHEDULER
      else process.env.CHROXY_ENABLE_SCHEDULER = prev
    }
  })
})

// #7079 — load-refused ("unreadable") stored entries: visible on the snapshot,
// discardable by an opaque handle. The wire cap on a task id is NOT widened.
describe('scheduler handlers — unreadable stored entries (#7079)', () => {
  const TYPO_EPOCH = 1795000000000000000
  const storePath = () => join(TMP, `unreadable-${++storeSeq}.json`)

  /** A store whose file holds one good task and `bad` refused entries, loaded. */
  function mkStoreWith(bad) {
    const filePath = storePath()
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      tasks: [
        { id: 'good', prompt: 'keep me', cadence: { kind: 'cron', expression: '*/5 * * * *' }, createdAt: 1, updatedAt: 1 },
        ...bad,
      ],
    }))
    return { store: new ScheduledTaskStore({ filePath, logger: { info() {}, warn() {}, error() {} } }).load(), filePath }
  }
  const badEntry = (over = {}) => ({
    id: 'typo', prompt: 'SECRET PROMPT TEXT', cadence: { kind: 'once', at: TYPO_EPOCH }, createdAt: 1, updatedAt: 1, ...over,
  })

  it('the snapshot reports the unreadable count and per-entry { handle, reason }, never raw contents', () => {
    const { store } = mkStoreWith([badEntry()])
    const { ctx, sent } = mkCtx({ store })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)

    const parsed = ServerScheduledTasksSchema.safeParse(sent[0])
    assert.equal(parsed.success, true, parsed.error?.message)
    assert.equal(sent[0].unreadableCount, 1)
    assert.equal(sent[0].unreadable.length, 1)
    assert.match(sent[0].unreadable[0].handle, /^[0-9a-f]{16}$/)
    assert.match(sent[0].unreadable[0].reason, /epoch|representable/i)
    assert.deepEqual(Object.keys(sent[0].unreadable[0]).sort(), ['handle', 'reason'], 'no id, no raw entry')
    assert.ok(!JSON.stringify(sent[0]).includes('SECRET PROMPT TEXT'), 'the raw contents never travel')
    assert.ok(!sent[0].tasks.some((t) => t.id === 'typo'), 'and it is still not served as a live task')
  })

  it('a registry with nothing unreadable reports a zero count and an empty list', () => {
    const { ctx, sent } = mkCtx()
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(sent[0].unreadableCount, 0)
    assert.deepEqual(sent[0].unreadable, [])
  })

  it('an over-cap id entry is surfaced and the snapshot STILL parses (the id never reaches the wire)', () => {
    const { store } = mkStoreWith([badEntry({ id: 'x'.repeat(300) })])
    const { ctx, sent } = mkCtx({ store })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(ServerScheduledTasksSchema.safeParse(sent[0]).success, true)
    assert.equal(sent[0].unreadableCount, 1)
    assert.ok(!JSON.stringify(sent[0]).includes('x'.repeat(300)))
  })

  it('lists at most 100 rows but reports the TRUE count, and a 130-entry file still parses', () => {
    const many = Array.from({ length: 130 }, (_, i) => badEntry({ id: `bad${i}` }))
    const { store } = mkStoreWith(many)
    const { ctx, sent } = mkCtx({ store })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(ServerScheduledTasksSchema.safeParse(sent[0]).success, true, 'a 130-entry file must not brick the snapshot')
    assert.equal(sent[0].unreadableCount, 130)
    assert.equal(sent[0].unreadable.length, 100)
  })

  it('clamps a reason longer than the wire cap (a loader message that echoes operator input)', () => {
    // No refusal message the loader produces today is this long, so drive the
    // clamp with a store that returns one — the snapshot is safeParsed WHOLE by
    // the dashboard, and one over-cap reason would blank the panel.
    const stub = {
      list: () => [],
      unreadableCount: () => 1,
      listUnreadable: () => [{ handle: '0123456789abcdef', id: null, reason: 'r'.repeat(5000) }],
    }
    const { ctx, sent } = mkCtx({ store: stub })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(sent[0].unreadable[0].reason.length, 512)
    assert.equal(ServerScheduledTasksSchema.safeParse(sent[0]).success, true)
  })

  it('FULL LOOP: present -> reported -> discard_unreadable -> gone from disk AND from the next snapshot', () => {
    const { store, filePath } = mkStoreWith([badEntry()])
    const { ctx, sent } = mkCtx({ store })
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    const handle = sent[0].unreadable[0].handle

    schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'discard_unreadable', handle }), ctx)

    const ack = sent.at(-1)
    assert.equal(ack.type, 'scheduled_tasks', 'the ack is the re-emitted snapshot')
    assert.equal(ack.requestId, 'a-1')
    assert.equal(ack.unreadableCount, 0)
    assert.deepEqual(ack.unreadable, [])
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf-8')).tasks.map((t) => t.id), ['good'], 'gone from disk')
    assert.ok(store.get('good'), 'the live task is untouched')
  })

  it('a registry write that FAILS is answered with an error, never an ack (discard and delete)', () => {
    for (const act of ['discard_unreadable', 'delete']) {
      const { store, filePath } = mkStoreWith([badEntry()])
      const { ctx, sent } = mkCtx({ store })
      const msg = act === 'delete' ? { taskId: 'good' } : { handle: store.listUnreadable()[0].handle }
      mkdirSync(`${filePath}.tmp-${process.pid}`) // the atomic write cannot succeed
      schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: act, ...msg }), ctx)
      assert.equal(sent.length, 1, act)
      assert.equal(sent[0].type, 'session_error', `${act}: a failed write must not ack`)
      assert.equal(sent[0].code, 'SCHEDULED_TASK_ACTION_FAILED', act)
      assert.match(sent[0].message, /could not write/i)
      assert.ok(store.get('good'), `${act}: nothing was removed in memory`)
      assert.equal(store.unreadableCount(), 1, act)
    }
  })

  it('a stale / unknown handle is NOT_FOUND and discards nothing', () => {
    const { store, filePath } = mkStoreWith([badEntry()])
    const { ctx, sent } = mkCtx({ store })
    schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'discard_unreadable', handle: 'ffffffffffffffff' }), ctx)
    assert.equal(sent[0].type, 'session_error')
    assert.equal(sent[0].code, 'SCHEDULED_TASK_NOT_FOUND')
    assert.equal(sent[0].requestId, 'a-1')
    assert.equal(store.unreadableCount(), 1)
    assert.ok(JSON.parse(readFileSync(filePath, 'utf-8')).tasks.some((t) => t.id === 'typo'))
  })

  it('requires a handle, and a taskId is never accepted in its place', () => {
    const { store } = mkStoreWith([badEntry()])
    for (const c of [{}, { handle: '' }, { handle: 7 }, { taskId: 'typo' }, { taskId: 'good' }]) {
      const { ctx, sent } = mkCtx({ store })
      schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'discard_unreadable', ...c }), ctx)
      assert.equal(sent[0].type, 'session_error', JSON.stringify(c))
      assert.equal(sent[0].code, 'SCHEDULED_TASK_ACTION_FAILED', JSON.stringify(c))
    }
    assert.equal(store.unreadableCount(), 1, 'nothing was discarded')
    assert.ok(store.get('good'), 'and a live task id passed as a taskId is not deleted by this action')
  })

  it('a non-primary client cannot discard (same authority as delete)', () => {
    const { store } = mkStoreWith([badEntry()])
    const { ctx, sent } = mkCtx({ store })
    const [{ handle }] = store.listUnreadable()
    schedulerHandlers.scheduled_task_action(WS, nonPrimaryClient, action({ action: 'discard_unreadable', handle }), ctx)
    assert.equal(sent[0].code, 'SCHEDULER_FORBIDDEN_NON_PRIMARY_CLIENT')
    assert.equal(store.unreadableCount(), 1)
  })

  it('a running engine is refreshed after a discard, like any other mutation', () => {
    let refreshed = 0
    const engine = { armed: true, quarantinedTaskIds: new Set(), refresh: () => { refreshed++ } }
    const { store } = mkStoreWith([badEntry()])
    const { ctx } = mkCtx({ store, enabled: true, engine })
    const [{ handle }] = store.listUnreadable()
    schedulerHandlers.scheduled_task_action(WS, primaryClient, action({ action: 'discard_unreadable', handle }), ctx)
    assert.equal(refreshed, 1)
  })

  it('a degraded snapshot (registry missing) clamps its error and reports no unreadable rows', () => {
    const ctx = {
      transport: { send: (_w, m) => { ctx.sent.push(m) } },
      sent: [],
      sessions: { sessionManager: { scheduledTaskStore: null, providerType: SCHEDULABLE } },
      services: { config: { features: { scheduler: false } }, schedulerEngine: null },
    }
    schedulerHandlers.scheduled_tasks_request(WS, primaryClient, req(), ctx)
    assert.equal(ctx.sent[0].unreadableCount, 0)
    assert.equal(ServerScheduledTasksSchema.safeParse(ctx.sent[0]).success, true)
  })

  it('the store cap and the snapshot `tasks` bound agree (drift guard)', async () => {
    const { MAX_STORED_TASKS } = await import('../src/scheduled-task-store.js')
    const { SCHEDULED_TASKS_MAX } = await import('@chroxy/protocol')
    assert.equal(SCHEDULED_TASKS_MAX, MAX_STORED_TASKS)
  })
})
