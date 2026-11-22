// #8554: rejected execution results still belong in the run's spend. Keep this
// boundary synthetic: importing git-ops would resolve the host's git binary even
// when a fake is injected into the manager. Persistence/logging are inert too;
// the real RunLedger, reducer, budget evaluator and TurnDriver remain in use.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
function fixture(t, { role = 'audit', label = 'execute', priceTurn, maxParseRetries = 2, sendImpl } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), 'rejected-usage-'))
  const sm = installTurnDrivenRegistry(new EventEmitter())
  const sent = []
  const session = {
    sendMessage(prompt) { sent.push(prompt); return sendImpl?.() },
    interrupt() {},
  }
  sm.getSession = (sid) => sid === 's1' ? { session } : null
  const emit = (event, data = {}) => sm.emit('session_event', { sessionId: 's1', event, data })
  const driver = new TurnDriver({ sessionManager: sm, defaultTimeoutMs: 5000 })
  const ledger = new RunLedger({ baseDir, priceTurn, now: () => 1000 })
  const { runId } = ledger.createRun({ configSnapshot: { budget: { maxUsd: 0.5, warnPercent: 80 } } })
  const subtaskId = role === 'architect' ? null : 'st1'
  if (subtaskId) {
    ledger.createSubtask(runId, { subtaskId, role: `worker.${role}`, title: 'fixture' })
    ledger.attachSession(runId, subtaskId, { sessionId: 's1', provider: 'fixture-provider', model: 'fixture-model' })
  }
  const manager = new OrchestrationManager({
    sessionManager: sm, ledger, turnDriver: driver, gitOps: {}, config: { maxParseRetries },
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
  return { sm, driver, ledger, manager, run, runId, emit, sent, drive, calls, events, budgets,
    totals: () => ledger.getRun(runId).usageTotals.overall }
}
async function rejection(promise, code) {
  let caught
  await assert.rejects(promise, (err) => { caught = err; return err instanceof TurnError && err.code === code })
  return caught
}

for (const failureMessage of [undefined, 'fixture stream failed']) {
  it(`driver carries terminal result on ${failureMessage ? 'TURN_ERROR' : 'TURN_STOPPED'} without resolving`, async (t) => {
    const f = fixture(t)
    const p = f.driver.driveTurn('s1', 'go')
    f.emit('stream_delta', { messageId: 'm', delta: 'partial' })
    const data = terminal({ interrupted: true, failureMessage, privateExtra: 'not projected' })
    f.emit('result', data)
    const err = await rejection(p, failureMessage ? 'TURN_ERROR' : 'TURN_STOPPED')
    assert.equal(err.partialText, 'partial')
    assert.equal(err.message, failureMessage || 'turn interrupted before completing')
    assert.deepEqual(err.result, projected(data))
    assert.equal(err.terminalEvent, 'result')
    assert.equal(Object.hasOwn(err.result, 'interrupted'), false)
    assert.equal(Object.hasOwn(err.result, 'privateExtra'), false)
    assert.equal(data.interrupted, true)
  })
}

it('driver uses the successful payload projection for missing and nonfinite reject metadata', async (t) => {
  const f = fixture(t)
  const p = f.driver.driveTurn('s1', 'go')
  const data = { interrupted: true, numTurns: Infinity, apiDurationMs: NaN }
  f.emit('result', data)
  const err = await rejection(p, 'TURN_STOPPED')
  assert.deepEqual(err.result, projected(data))
})

for (const [role, label, expected] of [
  ['architect', 'plan', 'architect'], ['architect', 'synthesis', 'architect'],
  ['architect', 'poa_review', 'architect.review'], ['architect', 'result_review', 'architect.review'],
  ['audit', 'execute', 'worker.audit'], ['implement', 'execute', 'worker.implement'],
]) {
  it(`records rejected ${role}/${label} usage once with its ledger attribution and budget`, async (t) => {
    const f = fixture(t, { role, label })
    const p = f.drive()
    f.emit('stream_delta', { delta: decision }) // valid-looking text must NOT become success
    const data = terminal({ interrupted: true })
    f.emit('result', data)
    const err = await rejection(p, 'TURN_STOPPED')
    assert.equal(f.sent.length, 1)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].role, expected)
    assert.equal(f.calls[0].sessionId, 's1')
    assert.equal(f.calls[0].subtaskId, role === 'architect' ? null : 'st1')
    assert.equal(f.calls[0].turnLabel, label)
    assert.equal(f.calls[0].terminalEvent, 'result')
    assert.deepEqual(f.calls[0].data, err.result)
    assert.equal(f.totals().turns, 1)
    assert.equal(f.totals().costUsd, 0.6)
    assert.equal(f.totals().inputTokens, 12)
    assert.equal(f.ledger.getRun(f.runId).usageTotals.byRole[expected].turns, 1)
    assert.equal(f.ledger.getRun(f.runId).usageTotals.byModel['fixture-model'].turns, 1)
    assert.equal(f.ledger.getRun(f.runId).usageTotals.bySession.s1.turns, 1)
    assert.equal(f.ledger.evaluateBudget(f.runId).level, 'capped')
    assert.deepEqual(f.budgets, ['warn', 'cap'])
  })
}

it('records an errored execution payload before rethrowing TURN_ERROR', async (t) => {
  const f = fixture(t)
  const p = f.drive()
  f.emit('result', terminal({ interrupted: true, failureMessage: 'stream failed' }))
  const err = await rejection(p, 'TURN_ERROR')
  assert.equal(err.message, 'stream failed')
  assert.equal(f.calls.length, 1)
  assert.equal(f.totals().effectiveUsd, 0.6)
  assert.equal(f.ledger.evaluateBudget(f.runId).ok, false)
})

for (const cost of [0, -0.2, 0.45]) {
  it(`records finite cost ${cost} without usage, preserving signed and zero money`, async (t) => {
    const f = fixture(t)
    const p = f.drive()
    f.emit('result', { interrupted: true, cost, usage: null })
    await rejection(p, 'TURN_STOPPED')
    assert.equal(f.calls.length, 1)
    assert.equal(f.totals().turns, 1)
    assert.equal(f.totals().costUsd, cost)
    assert.equal(f.totals().costKnownTurns, 1)
    assert.equal(f.totals().unknownCostTurns, 0)
  })
}

for (const [field, cell] of [
  ['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'],
  ['cache_read_input_tokens', 'cacheReadTokens'], ['cached_input_tokens', 'cacheReadTokens'],
  ['cache_creation_input_tokens', 'cacheCreationTokens'], ['web_search_requests', 'webSearchRequests'],
]) {
  it(`records ${field}-only rejected usage without inventing provider cost`, async (t) => {
    const f = fixture(t)
    const p = f.drive()
    f.emit('result', { interrupted: true, cost: null, usage: { [field]: 7 } })
    await rejection(p, 'TURN_STOPPED')
    assert.equal(f.calls.length, 1)
    assert.equal(f.totals()[cell], 7)
    assert.equal(f.totals().turns, 1)
    assert.equal(f.totals().costUsd, 0)
    assert.equal(f.totals().unknownCostTurns, 1)
  })
}

it('prices unknown-cost rejected tokens through the real ledger before evaluating budget', async (t) => {
  const prices = []
  const f = fixture(t, { priceTurn: (args) => { prices.push(args); return 0.7 } })
  const p = f.drive()
  f.emit('result', terminal({ interrupted: true, cost: null }))
  await rejection(p, 'TURN_STOPPED')
  assert.equal(prices.length, 1)
  assert.equal(prices[0].provider, 'fixture-provider')
  assert.equal(prices[0].model, 'fixture-model')
  assert.equal(f.totals().costUsd, 0)
  assert.equal(f.totals().pricedCostUsd, 0.7)
  assert.equal(f.totals().effectiveUsd, 0.7)
  assert.equal(f.totals().unknownCostTurns, 0)
  assert.equal(f.ledger.evaluateBudget(f.runId).level, 'capped')
})

for (const [label, data] of [
  ['synthetic stall', { cost: null, usage: null, failureMessage: 'stall' }],
  ['missing payload', {}], ['empty usage', { usage: {} }],
  ['nonfinite cost and invalid tokens', { cost: NaN, usage: { input_tokens: Infinity, output_tokens: -1 } }],
  ['zero tokens', { cost: null, usage: { input_tokens: 0, output_tokens: 0 } }],
]) {
  it(`records nothing for ${label}`, async (t) => {
    const f = fixture(t)
    const p = f.drive()
    f.emit('result', { ...data, interrupted: true })
    await rejection(p, data.failureMessage ? 'TURN_ERROR' : 'TURN_STOPPED')
    assert.equal(f.calls.length, 0)
    assert.equal(f.totals().turns, 0)
    assert.equal(f.totals().unknownCostTurns, 0)
    assert.deepEqual(f.budgets, [])
  })
}

it('drops repeated and late terminal results after rejection instead of double accounting', async (t) => {
  const f = fixture(t)
  const p = f.drive()
  const payload = terminal({ interrupted: true, failureMessage: 'failed' })
  f.emit('result', payload)
  f.emit('result', payload)
  f.emit('error', { message: 'trailing' })
  f.emit('stopped')
  await rejection(p, 'TURN_ERROR')
  await flush()
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.totals().turns, 1)
  assert.equal(f.totals().effectiveUsd, 0.6)
  assert.deepEqual(f.budgets, ['warn', 'cap'])
})

it('keeps the queued epoch separate from rejected result/error/stopped trailing events', async (t) => {
  const f = fixture(t)
  const first = f.drive()
  const second = f.drive().then((value) => ({ value }), (error) => ({ error }))
  f.emit('result', terminal({ interrupted: true }))
  f.emit('result', terminal({ cost: 99 }))
  f.emit('error', { message: 'trailing error' })
  f.emit('stopped')
  await rejection(first, 'TURN_STOPPED')
  await flush()
  assert.equal(f.sent.length, 2)
  assert.equal(f.calls.length, 1)
  f.emit('stream_delta', { delta: decision })
  f.emit('result', terminal({ cost: 0.1 }))
  const outcome = await second
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.value.decision.summary, 'finished')
  assert.equal(f.calls.length, 2)
  assert.equal(f.totals().turns, 2)
  assert.equal(f.totals().effectiveUsd, 0.7)
  assert.deepEqual(f.budgets, ['warn', 'cap'])
})

it('accounts a parse-repair success and then a rejected attempt once each, without retrying rejection', async (t) => {
  const f = fixture(t)
  const p = f.drive()
  f.emit('stream_delta', { delta: 'not a decision' })
  f.emit('result', terminal({ cost: 0.1 }))
  await flush()
  assert.equal(f.sent.length, 2)
  f.emit('result', terminal({ cost: 0.2, interrupted: true }))
  await rejection(p, 'TURN_STOPPED')
  assert.equal(f.sent.length, 2)
  assert.equal(f.calls.length, 2)
  assert.equal(f.totals().turns, 2)
  assert.ok(Math.abs(f.totals().costUsd - 0.3) < 1e-12)
})

it('keeps successful parsing and successful repair accounting unchanged', async (t) => {
  const f = fixture(t)
  const p = f.drive()
  f.emit('stream_delta', { delta: 'bad decision' })
  f.emit('result', terminal({ cost: 0.1 }))
  await flush()
  f.emit('stream_delta', { delta: decision })
  f.emit('result', terminal({ cost: 0.2 }))
  assert.equal((await p).decision.summary, 'finished')
  assert.equal(f.calls.length, 2)
  assert.equal(f.totals().turns, 2)
})

for (const event of ['stopped']) {
  it(`does not mistake arbitrary ${event} event metadata for an execution result`, async (t) => {
    const f = fixture(t)
    const p = f.drive()
    f.emit(event, { ...terminal(), message: 'not a result', result: terminal() })
    const err = await rejection(p, event === 'error' ? 'TURN_ERROR' : 'TURN_STOPPED')
    assert.equal(err.result, null)
    assert.equal(f.calls.length, 0)
    f.emit('result', terminal())
    assert.equal(f.calls.length, 0)
  })
}
for (const asyncReject of [false, true]) {
  it(`does not trust result metadata on a ${asyncReject ? 'rejected' : 'thrown'} send error`, async (t) => {
    const original = Object.assign(new Error('send failed'), { result: terminal(), cost: 99, usage: { input_tokens: 99 } })
    const f = fixture(t, { sendImpl: () => { if (asyncReject) return Promise.reject(original); throw original } })
    const err = await rejection(f.drive(), 'SEND_FAILED')
    assert.equal(err.result, null)
    assert.equal(f.calls.length, 0)
  })
}
it('rethrows non-TurnError driver failures without trusting attached usage', async (t) => {
  const f = fixture(t)
  const original = Object.assign(new Error('foreign driver error'), { result: terminal(), code: 'TURN_STOPPED' })
  f.manager._driver = { driveTurn: async () => { throw original } }
  await assert.rejects(f.drive(), (err) => err === original)
  assert.equal(f.calls.length, 0)
})

it('does not catch and count an accounting failure a second time', async (t) => {
  // #9147: the failure is now logged and swallowed (the turn's result resolves), but it
  // must still be attempted exactly once, never retried by the catch arm.
  const f = fixture(t)
  const original = Object.assign(new TurnError('TURN_ERROR', 'ledger callback failed'), { result: terminal() })
  let count = 0
  f.ledger.recordTurnUsage = () => { count++; throw original }
  const p = f.drive()
  f.emit('stream_delta', { delta: decision })
  f.emit('result', terminal())
  assert.equal((await p).decision.summary, 'finished')
  assert.equal(count, 1)
})

it('counts a zero-cost zero-token terminal result, unlike an unmetered null synthetic', async (t) => {
  const f = fixture(t)
  let p = f.drive()
  f.emit('result', { interrupted: true, cost: 0, usage: { input_tokens: 0, output_tokens: 0 } })
  await rejection(p, 'TURN_STOPPED')
  await flush()
  p = f.drive()
  f.emit('result', { interrupted: true, failureMessage: 'stall', cost: null, usage: null })
  await rejection(p, 'TURN_ERROR')
  assert.equal(f.calls.length, 1)
  assert.equal(f.totals().turns, 1)
  assert.equal(f.totals().costKnownTurns, 1)
  assert.equal(f.totals().unknownCostTurns, 0)
})

it('folds spend and evaluates budget before the unchanged rejection reaches its caller', async (t) => {
  const f = fixture(t)
  const order = []
  let terminalError
  const driveTurn = f.driver.driveTurn.bind(f.driver)
  f.manager._driver = { driveTurn: (...args) => driveTurn(...args).catch((err) => { terminalError = err; throw err }) }
  const record = f.ledger.recordTurnUsage.bind(f.ledger)
  f.ledger.recordTurnUsage = (...args) => {
    order.push('record')
    const value = record(...args)
    order.push('recorded')
    return value
  }
  const evaluate = f.ledger.evaluateBudget.bind(f.ledger)
  f.ledger.evaluateBudget = (...args) => { order.push('evaluate'); return evaluate(...args) }
  f.ledger.on('run_usage_updated', () => order.push('usage'))
  f.ledger.on('run_budget_warning', () => order.push('warn'))
  f.ledger.on('run_budget_cap_reached', () => order.push('cap'))
  const p = f.drive().catch((err) => {
    order.push('rejected')
    assert.equal(err, terminalError)
    throw err
  })
  f.emit('result', terminal({ interrupted: true, failureMessage: 'failed execution' }))
  await rejection(p, 'TURN_ERROR')
  assert.deepEqual(order, ['record', 'usage', 'evaluate', 'warn', 'cap', 'recorded', 'rejected'])
  assert.equal(f.calls.length, 1)
})

// Literal eligible BYOK error envelope, verified source-only at
// byok-session.js:_emitTurnError. No provider/session-manager graph is imported.
function errorEnvelope(code = 'STREAM_ERROR', overrides = {}) {
  return {
    messageId: 'fixture-byok-turn', message: code === 'ABORT' ? 'Interrupted by user' : 'stream failed', code,
    cost: 0.6, usage: { input_tokens: 12, output_tokens: 3 },
    modelUsage: { 'fixture-model': { input_tokens: 12, output_tokens: 3 } },
    ...overrides,
  }
}
function journal(f) {
  return readFileSync(f.ledger._journalPath(f.runId), 'utf8').trim().split('\n').map(JSON.parse)
}
for (const code of ['ABORT', 'STREAM_ERROR', 'HTTP_429']) {
  it(`accounts genuine BYOK ${code} terminal error with error provenance before rejecting`, async (t) => {
    const f = fixture(t)
    const p = f.drive()
    f.emit('stream_delta', { delta: decision })
    const data = errorEnvelope(code)
    f.emit('error', data)
    const err = await rejection(p, 'TURN_ERROR')
    assert.equal(err.message, data.message)
    assert.deepEqual(err.result, projected(data))
    assert.equal(err.terminalEvent, 'error')
    assert.equal(f.sent.length, 1)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].terminalEvent, 'error')
    assert.equal(f.totals().turns, 1)
    assert.equal(f.totals().costUsd, 0.6)
    assert.equal(f.totals().inputTokens, 12)
    assert.equal(f.ledger.evaluateBudget(f.runId).level, 'capped')
    assert.deepEqual(f.budgets, ['warn', 'cap'])
    const events = journal(f)
    assert.equal(events.filter((e) => e.type === 'turn_usage').length, 1)
    const usage = events.find((e) => e.type === 'turn_usage')
    assert.equal(usage.terminalEvent, 'error')
    assert.deepEqual(usage.modelUsage, data.modelUsage)
    assert.equal(events.filter((e) => e.type === 'budget_warning').length, 1)
    assert.equal(events.filter((e) => e.type === 'budget_cap_reached').length, 1)
  })
}
for (const cost of [0, -0.2, 0.6]) {
  it(`records genuine terminal error cost ${cost} without tokens exactly once`, async (t) => {
    const f = fixture(t)
    const p = f.drive()
    f.emit('error', errorEnvelope('STREAM_ERROR', { cost, usage: null, modelUsage: null }))
    await rejection(p, 'TURN_ERROR')
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].terminalEvent, 'error')
    assert.equal(f.totals().costUsd, cost)
    assert.equal(f.totals().costKnownTurns, 1)
    assert.equal(f.totals().turns, 1)
  })
}
for (const [field, cell] of [
  ['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'],
  ['cache_read_input_tokens', 'cacheReadTokens'], ['cached_input_tokens', 'cacheReadTokens'],
  ['cache_creation_input_tokens', 'cacheCreationTokens'], ['web_search_requests', 'webSearchRequests'],
]) {
  it(`records genuine terminal error ${field}-only usage without fabricating cost`, async (t) => {
    const f = fixture(t)
    const p = f.drive()
    f.emit('error', errorEnvelope('STREAM_ERROR', { cost: null, usage: { [field]: 7 } }))
    await rejection(p, 'TURN_ERROR')
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].terminalEvent, 'error')
    assert.equal(f.totals()[cell], 7)
    assert.equal(f.totals().unknownCostTurns, 1)
    assert.equal(f.totals().turns, 1)
  })
}
for (const [label, data] of [
  ['plain non-accounting error', { message: 'failed' }],
  ['null synthetic error', { message: 'stall', cost: null, usage: null }],
  ['invalid error accounting', { message: 'failed', cost: Infinity, usage: { input_tokens: -1, output_tokens: NaN } }],
  ['nested thrown-error-like metadata', { message: 'failed', result: terminal() }],
]) {
  it(`does not manufacture accounting for ${label}`, async (t) => {
    const f = fixture(t)
    const p = f.drive()
    f.emit('error', data)
    await rejection(p, 'TURN_ERROR')
    assert.equal(f.calls.length, 0)
    assert.equal(journal(f).filter((e) => e.type === 'turn_usage').length, 0)
    assert.equal(f.totals().turns, 0)
    assert.deepEqual(f.budgets, [])
  })
}
it('prices genuine token-only error spend through the ledger before reporting the fault', async (t) => {
  const prices = []
  const f = fixture(t, { priceTurn: (data) => { prices.push(data); return 0.7 } })
  const p = f.drive()
  f.emit('error', errorEnvelope('STREAM_ERROR', { cost: null }))
  await rejection(p, 'TURN_ERROR')
  assert.equal(prices.length, 1)
  assert.equal(prices[0].provider, 'fixture-provider')
  assert.equal(prices[0].model, 'fixture-model')
  assert.equal(f.totals().costUsd, 0)
  assert.equal(f.totals().pricedCostUsd, 0.7)
  assert.equal(f.ledger.evaluateBudget(f.runId).level, 'capped')
})
it('counts error partial spend once across repeated error and same-frame or late results', async (t) => {
  const f = fixture(t)
  const p = f.drive()
  f.emit('error', errorEnvelope())
  f.emit('error', errorEnvelope())
  f.emit('result', terminal())
  f.emit('stopped')
  await rejection(p, 'TURN_ERROR')
  await flush()
  f.emit('result', terminal({ cost: 99 }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.totals().effectiveUsd, 0.6)
  assert.equal(journal(f).filter((e) => e.type === 'turn_usage').length, 1)
})
it('keeps a queued turn separate from the genuine error partial-spend frame', async (t) => {
  const f = fixture(t)
  const first = f.drive()
  const second = f.drive().then((value) => ({ value }), (error) => ({ error }))
  f.emit('error', errorEnvelope())
  f.emit('result', terminal({ cost: 99 }))
  f.emit('stopped')
  await rejection(first, 'TURN_ERROR')
  await flush()
  assert.equal(f.sent.length, 2)
  f.emit('stream_delta', { delta: decision })
  f.emit('result', terminal({ cost: 0.1 }))
  const outcome = await second
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.value.decision.summary, 'finished')
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls.map((call) => call.terminalEvent), ['error', 'result'])
  assert.equal(f.totals().turns, 2)
  assert.equal(f.totals().effectiveUsd, 0.7)
})
it('evaluates genuine terminal error spend before rethrowing the same fault', async (t) => {
  const f = fixture(t)
  const order = []
  let original
  const drive = f.driver.driveTurn.bind(f.driver)
  f.manager._driver = { driveTurn: (...args) => drive(...args).catch((err) => { original = err; throw err }) }
  f.ledger.on('run_usage_updated', () => order.push('usage'))
  f.ledger.on('run_budget_warning', () => order.push('warn'))
  f.ledger.on('run_budget_cap_reached', () => order.push('cap'))
  const p = f.drive().catch((err) => { assert.equal(err, original); order.push('rejected'); throw err })
  f.emit('error', errorEnvelope())
  await rejection(p, 'TURN_ERROR')
  assert.deepEqual(order, ['usage', 'warn', 'cap', 'rejected'])
})
it('does not accept attached TurnError usage without terminal-event provenance', async (t) => {
  const f = fixture(t)
  const original = new TurnError('TURN_ERROR', 'foreign exception', { result: terminal() })
  f.manager._driver = { driveTurn: async () => { throw original } }
  await assert.rejects(f.drive(), (err) => err === original)
  assert.equal(f.calls.length, 0)
})
