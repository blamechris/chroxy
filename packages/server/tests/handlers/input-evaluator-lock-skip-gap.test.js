import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { inputHandlers } from '../../src/handlers/input-handlers.js'
import { createSpy, createMockSession, nsCtx } from '../test-helpers.js'
import { boundedRegex } from '../../src/utils/bounded-regex.js'
import { buildMessageCtx } from '../../src/ws-handler-context.js'

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

// Production builds a FRESH ctx object for every message (ws-server.js dispatch,
// `buildMessageCtx`). Everything below goes through that same helper, so a lock
// stored on the ctx itself (instead of on the shared `ctx.runtime`) cannot pass.
let _n = 0
const msgCtx = (ctx) => buildMessageCtx(ctx, `corr-${++_n}`)
const send = (ctx, client, data) => inputHandlers.input(makeWs(), client, { data }, msgCtx(ctx))
const OK = { verdict: 'forward', rewritten: null, clarification: null, reasoning: '' }
const tick = () => new Promise((r) => setImmediate(r))

describe('the per-session evaluator lock is shared across messages', () => {
  after(() => boundedRegex.close())

  it('two substantive drafts reach the evaluator one at a time, with the DEFAULT skip rules (no custom pattern)', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const evaluator = createSpy(async () => { await gate; return OK })
    const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
    const a = send(ctx, makeClient({ id: 'A', activeSessionId: 's1' }), 'first substantive draft awaiting the evaluator')
    await tick()
    const b = send(ctx, makeClient({ id: 'B', activeSessionId: 's1' }), 'second substantive draft arriving right after')
    await new Promise((r) => setTimeout(r, 50))
    const calls = evaluator.callCount
    release()
    await Promise.all([a, b])
    assert.equal(calls, 1, 'the second draft did not reach the evaluator concurrently')
    assert.equal(session.sendMessage.callCount, 1)
    assert.equal(ctx._sent.filter((m) => m.category === 'input_conflict').length, 1)
  })

  describe('with a custom skip pattern (the skip decision is awaited)', () => {
    const PATTERN = '^never matches this zzz$'

    it('a short ack sent right after a substantive draft does not overtake it, and is refused', async () => {
      const evaluator = createSpy(async () => OK)
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      session.promptEvaluatorSkipPattern = PATTERN
      const order = []
      session.sendMessage = createSpy((t) => { order.push(typeof t === 'string' ? t : JSON.stringify(t)) })
      const a = send(ctx, makeClient({ id: 'A', activeSessionId: 's1' }), 'a substantive draft awaiting the evaluator')
      await tick()
      const b = send(ctx, makeClient({ id: 'B', activeSessionId: 's1' }), 'yes')
      await Promise.all([a, b])
      assert.equal(ctx._sent.filter((m) => m.type === 'session_error' && m.category === 'input_conflict').length, 1)
      assert.equal(order.length, 1)
      assert.ok(order[0].includes('substantive draft'))
      assert.equal(evaluator.callCount, 1)
    })

    it('two substantive drafts make a single evaluator call while the first is in flight', async () => {
      let release
      const gate = new Promise((r) => { release = r })
      const evaluator = createSpy(async () => { await gate; return OK })
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      session.promptEvaluatorSkipPattern = PATTERN
      const a = send(ctx, makeClient({ id: 'A', activeSessionId: 's1' }), 'first substantive draft awaiting the evaluator')
      await tick()
      const b = send(ctx, makeClient({ id: 'B', activeSessionId: 's1' }), 'second substantive draft arriving right after')
      await new Promise((r) => setTimeout(r, 300))
      const calls = evaluator.callCount
      release()
      await Promise.all([a, b])
      assert.equal(calls, 1)
      assert.equal(session.sendMessage.callCount, 1)
    })

    it('the lock is released on the skip path: a later input is accepted', async () => {
      const evaluator = createSpy(async () => OK)
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      session.promptEvaluatorSkipPattern = '^skip this draft please$'
      await send(ctx, makeClient({ id: 'A', activeSessionId: 's1' }), 'skip this draft please')
      await send(ctx, makeClient({ id: 'A', activeSessionId: 's1' }), 'skip this draft please')
      assert.equal(evaluator.callCount, 0)
      assert.equal(session.sendMessage.callCount, 2)
      assert.equal(ctx.runtime.pendingEvaluatorAwaits.size, 0)
    })

    it('when the skip check throws the draft is evaluated anyway and the lock is released', async () => {
      const evaluator = createSpy(async () => OK)
      const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
      session.promptEvaluatorSkipPattern = PATTERN
      const real = boundedRegex.test
      boundedRegex.test = () => Promise.reject(new Error('matcher down'))
      try {
        await send(ctx, makeClient({ id: 'A', activeSessionId: 's1' }), 'a substantive draft awaiting the evaluator')
      } finally { boundedRegex.test = real }
      assert.equal(evaluator.callCount, 1, 'the evaluator RAN for the draft whose skip check failed')
      await send(ctx, makeClient({ id: 'A', activeSessionId: 's1' }), 'another substantive draft for the evaluator')
      assert.equal(evaluator.callCount, 2)
      assert.equal(session.sendMessage.callCount, 2)
    })

    it('the matcher queue is keyed by the server-assigned client id', async () => {
      const keys = []
      const real = boundedRegex.test
      boundedRegex.test = (source, text, key) => { keys.push(key); return real.call(boundedRegex, source, text, key) }
      try {
        const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator: createSpy(async () => OK) })
        session.promptEvaluatorSkipPattern = PATTERN
        await send(ctx, makeClient({ id: 'client-A', activeSessionId: 's1' }), 'a substantive draft from the first client')
        await send(ctx, makeClient({ id: 'client-B', activeSessionId: 's1' }), 'a substantive draft from the second client')
      } finally { boundedRegex.test = real }
      assert.deepEqual(keys, ['client-A', 'client-B'])
    })
  })

  it('two trivial inputs in the same tick are both forwarded (they never take the lock)', async () => {
    const evaluator = createSpy(async () => OK)
    const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
    session.promptEvaluatorSkipPattern = '^never matches this zzz$'
    await Promise.all([
      send(ctx, makeClient({ id: 'A', activeSessionId: 's1' }), 'ok'),
      send(ctx, makeClient({ id: 'B', activeSessionId: 's1' }), 'yes'),
    ])
    assert.equal(session.sendMessage.callCount, 2)
    assert.equal(ctx._sent.filter((m) => m.category === 'input_conflict').length, 0)
    assert.equal(evaluator.callCount, 0)
  })

  it('the lock is released when the iteration cap force-forwards: the lock map is empty and the next input is accepted', async () => {
    const evaluator = createSpy(async () => ({ verdict: 'clarify', rewritten: null, clarification: 'which one?', reasoning: '' }))
    const { ctx, session } = makeAutoEvalCtx({ promptEvaluator: true, evaluator })
    const client = makeClient({ id: 'A', activeSessionId: 's1' })
    for (let i = 1; i <= 4; i++) await send(ctx, client, `substantive draft number ${i} for the evaluator`)
    assert.equal(session.sendMessage.callCount, 1, 'the fourth draft was force-forwarded by the cap')
    assert.equal(ctx.runtime.pendingEvaluatorAwaits.size, 0, 'nothing is left locked')
    await send(ctx, client, 'a fifth substantive draft for the evaluator')
    assert.equal(ctx._sent.filter((m) => m.category === 'input_conflict').length, 0)
    assert.equal(evaluator.callCount, 4, 'the fifth input reached the evaluator again')
  })
})
