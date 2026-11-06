import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { inputHandlers } from '../../src/handlers/input-handlers.js'
import { createSpy, createMockSession, nsCtx } from '../test-helpers.js'
import { boundedRegex } from '../../src/utils/bounded-regex.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []
  const broadcasts = []

  // #5563: the input_conflict gate now reads `ctx.transport.getPrimary(sid)`
  // instead of a `primaryClients` Map. Back the primary surface by a local Map;
  // tests seed an existing primary via `ctx.transport.claimPrimary(sid, cid,
  // { force: true })`. `updatePrimary` stays a spy (asserted by clarify-path
  // tests) while still mutating the Map for any post-adoption read.
  const primaryClients = new Map()
  const updatePrimary = createSpy((sid, cid) => { primaryClients.set(sid, cid) })

  return nsCtx({
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    broadcastToSession: createSpy(),
    updatePrimary,
    getPrimary: (sid) => primaryClients.get(sid),
    isPrimary: (sid, cid) => primaryClients.get(sid) === cid,
    claimPrimary: createSpy((sid, cid, opts = {}) => {
      const current = primaryClients.get(sid)
      if (current === cid) return { changed: false, primaryClientId: current }
      if (current && !opts.force) return { changed: false, rejected: true, primaryClientId: current }
      primaryClients.set(sid, cid)
      return { changed: true, primaryClientId: cid }
    }),
    clearPrimary: createSpy((sid) => { primaryClients.delete(sid) }),
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
      isBudgetPaused: createSpy(() => false),
      resumeBudget: createSpy(),
      recordUserInput: createSpy(),
      touchActivity: createSpy(),
      getHistoryCount: createSpy(() => 0),
    },
    checkpointManager: {
      createCheckpoint: createSpy(async () => {}),
    },
    questionSessionMap: new Map(),
    pushManager: null,
    _sent: sent,
    _broadcasts: broadcasts,
    ...overrides,
  })
}

function makeClient(overrides = {}) {
  return {
    id: 'client-1',
    activeSessionId: null,
    ...overrides,
  }
}

function makeWs() { return {} }

// #3186: helper to build a session entry with a configurable promptEvaluator
// flag and capture broadcastToSession calls. Auto-evaluation tests need both.
function makeAutoEvalCtx({ promptEvaluator = false, evaluator } = {}) {
  const sessions = new Map()
  const session = createMockSession()
  session.promptEvaluator = promptEvaluator
  sessions.set('s1', { session, name: 'S', cwd: '/work' })
  const broadcastToSessionCalls = []
  const ctx = makeCtx(sessions, {
    broadcastToSession: createSpy((sid, msg, filter) => {
      broadcastToSessionCalls.push({ sid, msg, filter })
    }),
    evaluateDraft: evaluator,
  })
  ctx._broadcastToSessionCalls = broadcastToSessionCalls
  return { ctx, session }
}

// A configured skip pattern is matched off the event loop, so the skip decision
// is awaited. The per-session lock (#3636/#3666) must already be held while it is
// awaited: an input arriving in that gap is refused, never sent ahead of the first
// one and never allowed to start a second concurrent evaluator call.
describe('the evaluator lock is held while a custom skip pattern is being matched', () => {
  const PATTERN = '^never matches this zzz$'

  it('a short ack sent right after a substantive draft does not overtake it, and is refused', async () => {
    const evaluator = createSpy(async () => ({ verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }))
    const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
    session.promptEvaluatorSkipPattern = PATTERN
    const order = []
    session.sendMessage = createSpy((t) => { order.push(typeof t === 'string' ? t : JSON.stringify(t)) })
    const a = inputHandlers.input(makeWs(), makeClient({ id: 'A', activeSessionId: 's1' }), { data: 'a substantive draft awaiting the evaluator' }, ctx)
    await new Promise((r) => setImmediate(r))
    const b = inputHandlers.input(makeWs(), makeClient({ id: 'B', activeSessionId: 's1' }), { data: 'yes' }, ctx)
    await Promise.all([a, b])
    const conflicts = ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict')
    assert.equal(conflicts.length, 1, 'the second input was refused as a conflict')
    assert.equal(order.length, 1, 'only the first input was sent')
    assert.ok(order[0].includes('substantive draft'), 'and it was the first one')
    assert.equal(evaluator.callCount, 1)
  })

  it('two substantive drafts reach the evaluator one at a time (a single call while the first is in flight)', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const evaluator = createSpy(async () => { await gate; return { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' } })
    const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
    session.promptEvaluatorSkipPattern = PATTERN
    const a = inputHandlers.input(makeWs(), makeClient({ id: 'A', activeSessionId: 's1' }), { data: 'first substantive draft awaiting the evaluator' }, ctx)
    await new Promise((r) => setImmediate(r))
    const b = inputHandlers.input(makeWs(), makeClient({ id: 'B', activeSessionId: 's1' }), { data: 'second substantive draft arriving right after' }, ctx)
    await new Promise((r) => setTimeout(r, 300))
    const calls = evaluator.callCount
    release()
    await Promise.all([a, b])
    assert.equal(calls, 1, 'the second draft did not reach the evaluator concurrently')
    assert.equal(session.sendMessage.callCount, 1)
  })

  it('the lock is released on the skip path: a later input is accepted', async () => {
    const evaluator = createSpy(async () => ({ verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }))
    const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
    session.promptEvaluatorSkipPattern = '^skip this draft please$'
    await inputHandlers.input(makeWs(), makeClient({ id: 'A', activeSessionId: 's1' }), { data: 'skip this draft please' }, ctx)
    await inputHandlers.input(makeWs(), makeClient({ id: 'A', activeSessionId: 's1' }), { data: 'skip this draft please' }, ctx)
    assert.equal(evaluator.callCount, 0, 'the pattern skipped the evaluator')
    assert.equal(session.sendMessage.callCount, 2, 'both inputs were sent: nothing stayed locked')
  })

  it('the lock is released when the skip check throws', async () => {
    const evaluator = createSpy(async () => ({ verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }))
    const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
    session.promptEvaluatorSkipPattern = PATTERN
    const real = boundedRegex.test
    boundedRegex.test = () => Promise.reject(new Error('matcher down'))
    try {
      await inputHandlers.input(makeWs(), makeClient({ id: 'A', activeSessionId: 's1' }), { data: 'a substantive draft awaiting the evaluator' }, ctx)
    } finally { boundedRegex.test = real }
    await inputHandlers.input(makeWs(), makeClient({ id: 'A', activeSessionId: 's1' }), { data: 'another substantive draft for the evaluator' }, ctx)
    assert.equal(session.sendMessage.callCount, 2, 'the failed check did not leave the session locked')
  })

  after(() => boundedRegex.close())
})
