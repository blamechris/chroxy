// #9147: spend after a TURN_TIMEOUT, and a ledger failure must not mask the turn's
// own error. Same synthetic boundary as orchestration-rejected-usage.test.js (#8554):
// rejected execution results still belong in the run's spend. Keep this
// boundary synthetic: importing git-ops would resolve the host's git binary even
// when a fake is injected into the manager. Persistence/logging are inert too;
// the real RunLedger, reducer, budget evaluator and TurnDriver remain in use.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, it, mock } from 'node:test'
import { installTurnDrivenRegistry } from './helpers/turn-driven-registry.js'

const snapshots = new Map()
const mocks = [
  mock.module('../src/orchestration/git-ops.js', {
    namedExports: { createGitOps: () => { throw new Error('git must be injected') } },
  }),
  mock.module('../src/logger.js', {
    namedExports: { createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }) },
  }),
  mock.module('../src/json-state-file.js', {
    namedExports: {
      saveJsonState: (path, value) => { snapshots.set(path, structuredClone(value)) },
      loadJsonState: (path, fallback) => snapshots.has(path) ? structuredClone(snapshots.get(path)) : fallback(),
    },
  }),
]
after(() => { for (const context of mocks) context.restore() })

const { TurnDriver, TurnError } = await import('../src/orchestration/turn-driver.js')
const { OrchestrationManager } = await import('../src/orchestration/orchestration-manager.js')
const { RunLedger } = await import('../src/orchestration/run-ledger.js')

const flush = () => new Promise((resolve) => setImmediate(resolve))
const decision = '```chroxy-decision\n{"kind":"work_result","summary":"finished"}\n```'
function terminal(overrides = {}) {
  return {
    cost: 0.6, usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 },
    duration: 50, model: 'fixture-model', modelUsage: { 'fixture-model': { input_tokens: 12 } },
    numTurns: 2, apiDurationMs: 30, ...overrides,
  }
}
function projected(data) {
  return {
    cost: data.cost ?? null, duration: data.duration ?? null, usage: data.usage ?? null,
    modelUsage: data.modelUsage ?? null, model: data.model ?? null,
    numTurns: Number.isFinite(data.numTurns) ? data.numTurns : null,
    apiDurationMs: Number.isFinite(data.apiDurationMs) ? data.apiDurationMs : null,
  }
}
function fixture(t, { role = 'audit', label = 'execute', priceTurn, maxParseRetries = 2, sendImpl, turnTimeoutMs = 5000, drainTimeoutMs } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), 'rejected-usage-'))
  const sm = installTurnDrivenRegistry(new EventEmitter())
  const warnings = []
  const log = { warn: (m) => warnings.push(String(m)), info() {}, error() {}, debug() {} }
  const sent = []
  let interrupts = 0
  const session = {
    sendMessage(prompt) { sent.push(prompt); return sendImpl?.() },
    interrupt() { interrupts += 1 },
  }
  sm.getSession = (sid) => sid === 's1' ? { session } : null
  const emit = (event, data = {}) => sm.emit('session_event', { sessionId: 's1', event, data })
  const driver = new TurnDriver({ sessionManager: sm, defaultTimeoutMs: 5000, log, ...(drainTimeoutMs ? { drainTimeoutMs } : {}) })
  const ledger = new RunLedger({ baseDir, priceTurn, now: () => 1000 })
  const { runId } = ledger.createRun({ configSnapshot: { budget: { maxUsd: 0.5, warnPercent: 80 } } })
  const subtaskId = role === 'architect' ? null : 'st1'
  if (subtaskId) {
    ledger.createSubtask(runId, { subtaskId, role: `worker.${role}`, title: 'fixture' })
    ledger.attachSession(runId, subtaskId, { sessionId: 's1', provider: 'fixture-provider', model: 'fixture-model' })
  }
  const manager = new OrchestrationManager({
    sessionManager: sm, ledger, turnDriver: driver, gitOps: {}, log, config: { maxParseRetries, turnTimeoutMs },
  })
  const run = { runId, ownedSessions: new Map([['s1', { role, subtaskId }]]) }
  const events = []
  const budgets = []
  ledger.on('run_event', (event) => events.push(event))
  ledger.on('run_budget_warning', () => budgets.push('warn'))
  ledger.on('run_budget_cap_reached', () => budgets.push('cap'))
  const calls = []
  const record = ledger.recordTurnUsage.bind(ledger)
  ledger.recordTurnUsage = (...args) => { calls.push(args[1]); return record(...args) }
  const drive = () => manager._driveDecision(run, 's1', 'fixture prompt', 'work_result', label, subtaskId)
  t.after(async () => {
    driver.dispose()
    await manager.dispose()
    ledger.dispose()
    rmSync(baseDir, { recursive: true, force: true })
    for (const path of snapshots.keys()) if (path.startsWith(baseDir)) snapshots.delete(path)
  })
  return { warnings, interrupts: () => interrupts, sm, driver, ledger, manager, run, runId, emit, sent, drive, calls, events, budgets,
    totals: () => ledger.getRun(runId).usageTotals.overall }
}
async function rejection(promise, code) {
  let caught
  await assert.rejects(promise, (err) => { caught = err; return err instanceof TurnError && err.code === code })
  return caught
}


// Let the watchdog fire (turnTimeoutMs 15) and the driver enter its drain.
async function timedOut(f, p) {
  const err = await rejection(p, 'TURN_TIMEOUT')
  assert.equal(f.interrupts(), 1)
  return err
}

it('records spend that arrives while a TURN_TIMEOUT drains, once, and still rejects TURN_TIMEOUT', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  const err = await timedOut(f, p)
  assert.equal(err.result, null)
  assert.equal(f.calls.length, 0)
  f.emit('result', terminal({ interrupted: true }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].role, 'worker.audit')
  assert.equal(f.calls[0].sessionId, 's1')
  assert.equal(f.calls[0].subtaskId, 'st1')
  assert.equal(f.calls[0].turnLabel, 'execute')
  assert.equal(f.calls[0].terminalEvent, 'result')
  assert.equal(f.totals().turns, 1)
  assert.equal(f.totals().costUsd, 0.6)
  assert.equal(f.ledger.evaluateBudget(f.runId).level, 'capped')
  assert.deepEqual(f.budgets, ['warn', 'cap'])
})

it('counts a timeout-drain result once across the trailing result, error, stopped and stream_end of its frame', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  await timedOut(f, p)
  f.emit('result', terminal({ interrupted: true }))
  f.emit('result', terminal({ cost: 99 }))
  f.emit('error', { message: 'trailing', cost: 99 })
  f.emit('stopped')
  f.emit('stream_end')
  await flush()
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.totals().effectiveUsd, 0.6)
})

it("keeps the spend when the drain ends on stream_end before the same frame's result", async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  await timedOut(f, p)
  f.emit('stream_end')
  f.emit('result', terminal({ interrupted: true }))
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.totals().effectiveUsd, 0.6)
})

it('records a drain-time terminal ERROR carrying partial spend with error provenance', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  await timedOut(f, p)
  f.emit('error', { message: 'aborted', ...terminal() })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].terminalEvent, 'error')
  assert.equal(f.totals().turns, 1)
})

it('does not leak a drained result into the queued next turn, and counts each turn once (no double count)', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const first = f.drive()
  const second = f.drive().then((value) => ({ value }), (error) => ({ error }))
  await timedOut(f, first)
  f.emit('result', terminal({ interrupted: true })) // first turn's own late spend
  f.emit('result', terminal({ cost: 99 }))
  await flush()
  assert.equal(f.sent.length, 2, 'the queued turn starts after the drain')
  f.emit('stream_delta', { delta: decision })
  f.emit('result', terminal({ cost: 0.1 }))
  const outcome = await second
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.value.decision.summary, 'finished')
  assert.equal(f.calls.length, 2)
  assert.equal(f.totals().turns, 2)
  assert.equal(f.totals().effectiveUsd, 0.7)
})

for (const [label, data] of [['no payload', {}], ['null synthetic', { cost: null, usage: null }], ['zero tokens', { usage: { input_tokens: 0 } }]]) {
  it(`records nothing for a timeout-drain result with ${label}`, async (t) => {
    const f = fixture(t, { turnTimeoutMs: 15 })
    const p = f.drive()
    await timedOut(f, p)
    f.emit('result', data)
    assert.equal(f.calls.length, 0)
    assert.equal(f.totals().turns, 0)
  })
}

it('records nothing when no terminal event arrives before the drain gives up', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const f = fixture(t, { turnTimeoutMs: 15, drainTimeoutMs: 15 })
  const p = f.drive()
  mock.timers.tick(15) // watchdog fires -> TURN_TIMEOUT, drain starts
  await timedOut(f, p)
  mock.timers.tick(15) // drain timer fires -> mutex released, ctx gone
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 0)
})

it('a bare stopped carries no spend: nothing is recorded, and the next turn is counted once', async (t) => {
  const f = fixture(t)
  const first = f.drive()
  const second = f.drive().then((value) => ({ value }), (error) => ({ error }))
  f.emit('stopped', { stopRequested: true })
  const err = await rejection(first, 'TURN_STOPPED')
  assert.equal(err.result, null)
  assert.equal(f.calls.length, 0)
  await flush()
  f.emit('stream_delta', { delta: decision })
  f.emit('result', terminal({ cost: 0.1 }))
  assert.equal((await second).value.decision.summary, 'finished')
  assert.equal(f.calls.length, 1)
  assert.equal(f.totals().turns, 1)
  assert.equal(f.totals().effectiveUsd, 0.1)
})

it('driver: onLateUsage fires at most once, with the projection, and only on a TURN_TIMEOUT drain', async (t) => {
  const f = fixture(t)
  const got = []
  const p = f.driver.driveTurn('s1', 'go', { timeoutMs: 15, onLateUsage: (r, e) => got.push([r, e]) })
  await rejection(p, 'TURN_TIMEOUT')
  const data = terminal({ privateExtra: 'x' })
  f.emit('result', data)
  f.emit('error', { message: 'x', ...terminal({ cost: 5 }) })
  assert.equal(got.length, 1)
  assert.deepEqual(got[0], [projected(data), 'result'])
  // ordinary terminal results never go through it
  const p2 = f.driver.driveTurn('s1', 'go', { onLateUsage: (r, e) => got.push([r, e]) })
  await flush()
  f.emit('result', terminal())
  await p2
  assert.equal(got.length, 1)
})

it('driver: a throwing onLateUsage is logged, the drain still ends and the next turn runs', async (t) => {
  const f = fixture(t)
  const p = f.driver.driveTurn('s1', 'go', { timeoutMs: 15, onLateUsage: () => { throw new Error('boom') } })
  const next = f.driver.driveTurn('s1', 'again')
  await rejection(p, 'TURN_TIMEOUT')
  f.emit('result', terminal())
  assert.ok(f.warnings.some((w) => w.includes('onLateUsage failed: boom')))
  await flush()
  f.emit('result', terminal())
  assert.equal((await next).text, '')
})

it('driver: callers passing no onLateUsage see the unchanged drain', async (t) => {
  const f = fixture(t)
  const p = f.driver.driveTurn('s1', 'go', { timeoutMs: 15 })
  const next = f.driver.driveTurn('s1', 'again')
  await rejection(p, 'TURN_TIMEOUT')
  f.emit('result', terminal())
  await flush()
  f.emit('result', terminal())
  await next
  assert.equal(f.warnings.length, 0)
})

// --- gap 2: a ledger failure must not mask the turn's own outcome -----------

function breakLedger(f) {
  let thrown = 0
  f.ledger.recordTurnUsage = () => { thrown += 1; throw new Error('ledger write failed') }
  return () => thrown
}

for (const [label, finish] of [
  ['TURN_STOPPED (interrupted result)', (f) => f.emit('result', terminal({ interrupted: true }))],
  ['TURN_ERROR (terminal error with spend)', (f) => f.emit('error', { message: 'partial', ...terminal() })],
]) {
  it(`a throwing recordUsage on the reject path is logged and the original ${label} propagates`, async (t) => {
    const f = fixture(t)
    const thrown = breakLedger(f)
    let original
    const drive = f.driver.driveTurn.bind(f.driver)
    f.manager._driver = { driveTurn: (...a) => drive(...a).catch((err) => { original = err; throw err }) }
    const p = f.drive()
    finish(f)
    await assert.rejects(p, (err) => err === original && err instanceof TurnError && err.message !== 'ledger write failed')
    assert.equal(thrown(), 1)
    assert.equal(f.warnings.filter((w) => w.includes('usage failed') && w.includes('ledger write failed')).length, 1)
    assert.ok(f.warnings.some((w) => w.includes('at ')), 'the stack, not just the message, is logged')
  })
}

it('a throwing recordUsage on the resolve path is logged and the decision still resolves', async (t) => {
  const f = fixture(t)
  const thrown = breakLedger(f)
  const p = f.drive()
  f.emit('stream_delta', { delta: decision })
  f.emit('result', terminal())
  assert.equal((await p).decision.summary, 'finished')
  assert.equal(thrown(), 1)
  assert.equal(f.warnings.filter((w) => w.includes('ledger write failed')).length, 1)
})

it('a throwing late-usage write is logged and TURN_TIMEOUT still propagates', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const thrown = breakLedger(f)
  const p = f.drive()
  await timedOut(f, p)
  f.emit('result', terminal({ interrupted: true }))
  assert.equal(thrown(), 1)
  assert.equal(f.warnings.filter((w) => w.includes('ledger write failed')).length, 1)
})

// --- late-slot lifetime (F1) and no-spend drain ends (F3) -------------------

it('a lone stream_end slot is cleared at the frame boundary: a later result is not delivered', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  await timedOut(f, p)
  f.emit('stream_end') // arms the same-frame slot; no result in this frame
  await flush()
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 0)
})

it('a stale slot never steals the next turn\'s spend', async (t) => {
  const f = fixture(t)
  const got = { a: [], b: [] }
  const a = f.driver.driveTurn('s1', 'a', { timeoutMs: 15, onLateUsage: (r) => got.a.push(r) })
  await rejection(a, 'TURN_TIMEOUT')
  f.emit('stream_end')
  await flush()
  const b = f.driver.driveTurn('s1', 'b', { onLateUsage: (r) => got.b.push(r) })
  await flush()
  f.emit('stream_delta', { delta: 'ok' })
  f.emit('result', terminal({ cost: 0.1 }))
  await b
  f.emit('result', terminal({ cost: 0.2 })) // trailing, after B finished
  assert.equal(got.a.length, 0)
  assert.equal(got.b.length, 0)
})

it('a drain ended by a no-spend error still delivers the same frame\'s spend-bearing result once', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  await timedOut(f, p)
  f.emit('error', { message: 'max tool rounds', fatal: false, code: 'MAX_TOOL_ROUNDS_REACHED' })
  assert.equal(f.calls.length, 0)
  f.emit('result', terminal({ interrupted: true }))
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].terminalEvent, 'result')
  assert.equal(f.totals().effectiveUsd, 0.6)
})

it('a no-spend result then a spend-bearing error in one drain frame is delivered once', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  await timedOut(f, p)
  f.emit('result', { cost: null, usage: null })
  f.emit('error', { message: 'x', ...terminal() })
  f.emit('error', { message: 'again', ...terminal({ cost: 99 }) })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].terminalEvent, 'error')
  assert.equal(f.totals().effectiveUsd, 0.6)
})

it('a spend-bearing error followed by a result in the same frame is delivered once', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  await timedOut(f, p)
  f.emit('error', { message: 'aborted', ...terminal() })
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].terminalEvent, 'error')
  assert.equal(f.totals().effectiveUsd, 0.6)
})

// --- one spend predicate shared by the driver and the ledger (G1) ----------

for (const [label, usage] of [['total_tokens only', { total_tokens: 5 }], ['a fractional token count', { input_tokens: 0.4 }]]) {
  it(`a drain-ending result whose usage is ${label} is no spend to the driver either: a same-frame spend result is still delivered`, async (t) => {
    const f = fixture(t, { turnTimeoutMs: 15 })
    const p = f.drive()
    await timedOut(f, p)
    f.emit('result', { cost: null, usage })
    assert.equal(f.calls.length, 0)
    f.emit('result', terminal({ interrupted: true }))
    assert.equal(f.calls.length, 1)
    assert.equal(f.totals().effectiveUsd, 0.6)
  })
}

it('a string token count the ledger coerces is spend to the driver too: delivered and recorded once', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  await timedOut(f, p)
  f.emit('result', { cost: null, usage: { output_tokens: '7' } })
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.totals().outputTokens, 7)
})

it('a no-spend result, a no-spend error and then a spend result in one drain frame give exactly one call', async (t) => {
  const f = fixture(t, { turnTimeoutMs: 15 })
  const p = f.drive()
  await timedOut(f, p)
  f.emit('result', { cost: null, usage: null })
  f.emit('error', { message: 'non-fatal', fatal: false })
  f.emit('result', terminal({ interrupted: true }))
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.totals().effectiveUsd, 0.6)
})
