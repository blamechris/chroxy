import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager } from '../src/permission-manager.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { inputHandlers } from '../src/handlers/input-handlers.js'

/**
 * #8470 -- the permission manager holds ONE pending AskUserQuestion. A second one
 * arriving while the first is open used to overwrite the slot: the first tool call
 * hung, its card read pending on every client, and a late answer to it went nowhere
 * without a word to the client that sent it.
 */

const Q1 = { questions: [{ question: 'First?', options: [{ label: 'A1' }, { label: 'B1' }] }] }
const Q2 = { questions: [{ question: 'Second?', options: [{ label: 'A2' }, { label: 'B2' }] }] }

const silentLog = { info() {}, warn() {} }
const settled = (p) => Promise.race([p.then(() => true), new Promise((r) => setImmediate(() => r(false)))])

/** Await a promise that must settle; a mutant that strands it fails instead of hanging. */
async function within(p, ms = 2000) {
  let t
  try {
    return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`still pending after ${ms}ms`)), ms) })])
  } finally {
    clearTimeout(t)
  }
}

describe('a superseded AskUserQuestion is resolved as a deny (#8470)', () => {
  const live = []
  afterEach(() => { mock.timers.reset(); for (const pm of live.splice(0)) pm.clearAll() })
  // A short timeout bounds the damage of a mutant that strands a question's timer:
  // the run then ends a few seconds late instead of waiting out the 15-minute default.
  const manager = (opts) => { const pm = new PermissionManager({ log: silentLog, timeoutMs: 3000, ...opts }); live.push(pm); return pm }

  it('the first question is denied when the second arrives, and says why', async () => {
    const pm = manager()
    const events = []
    pm.on('user_question', (d) => events.push(['user_question', d.toolUseId]))
    pm.on('permission_resolved', (d) => events.push(['permission_resolved', d.toolUseId, d.reason, d.decision]))
    const p1 = pm._handleAskUserQuestion(Q1, null, 'toolu_1')
    pm._handleAskUserQuestion(Q2, null, 'toolu_2')

    const r1 = await within(p1)
    assert.equal(r1.behavior, 'deny')
    assert.ok(/superseded/i.test(r1.message), 'the agent is told the question was replaced')
    const id1 = events[0][1]
    const id2 = events[2][1]
    assert.notEqual(id1, id2)
    assert.deepEqual(events, [
      ['user_question', id1],
      ['permission_resolved', id1, 'superseded', 'deny'],
      ['user_question', id2],
    ], 'the resolution is announced before the new question, for the OLD id')
  })

  it('the second question stays pending and is answered normally', async () => {
    const pm = manager()
    const ids = []
    pm.on('user_question', (d) => ids.push(d.toolUseId))
    const p1 = pm._handleAskUserQuestion(Q1, null)
    const p2 = pm._handleAskUserQuestion(Q2, null)
    await within(p1)
    assert.equal(await settled(p2), false, 'question 2 is still blocked')
    assert.deepEqual(pm.getPendingQuestions().map((q) => q.toolUseId), [ids[1]])
    assert.equal(pm._waitingForAnswer, true)
    assert.ok(pm._questionTimer !== null, 'question 2 owns a timeout')

    // The superseded question's late answer reaches nothing.
    assert.equal(pm.respondToQuestion('LATE', undefined, ids[0]), false)
    assert.equal(await settled(p2), false)

    pm.respondToQuestion('A2', undefined, ids[1])
    const r2 = await within(p2)
    assert.equal(r2.behavior, 'allow')
    assert.deepEqual(r2.updatedInput.answers, { 'Second?': 'A2' })
  })

  it('a question with nothing before it emits no superseded resolution', async () => {
    const pm = manager()
    const resolved = []
    pm.on('permission_resolved', (d) => resolved.push(d))
    const p = pm._handleAskUserQuestion(Q1, null)
    assert.deepEqual(resolved, [])
    pm.clearAll()
    await within(p)
  })

  it('the superseded question\'s timer does not expire the question that replaced it', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const pm = manager({ timeoutMs: 1000 })
    const resolved = []
    pm.on('permission_resolved', (d) => resolved.push([d.toolUseId, d.reason]))
    const ids = []
    pm.on('user_question', (d) => ids.push(d.toolUseId))
    // setTimeout is mocked here, so `within` (a setTimeout race) cannot be used:
    // `settled` races on setImmediate, which is not.
    const p1 = pm._handleAskUserQuestion(Q1, null)
    mock.timers.tick(600)
    const p2 = pm._handleAskUserQuestion(Q2, null)
    assert.equal(await settled(p1), true, 'question 1 was ended by the second question')
    mock.timers.tick(600) // 1200ms after Q1, 600ms after Q2
    assert.equal(await settled(p2), false, 'question 2 has not timed out on question 1\'s clock')
    mock.timers.tick(500) // 1100ms after Q2
    assert.equal(await settled(p2), true, 'question 2 times out on its own clock')
    const r2 = await p2
    assert.equal(r2.message, 'Question timed out')
    assert.deepEqual(resolved, [[ids[0], 'superseded'], [ids[1], 'timeout']])
  })

  it('aborting the turn cancels the CURRENT question once, not the one it replaced', async () => {
    const pm = manager()
    const ac = new AbortController()
    const resolved = []
    pm.on('permission_resolved', (d) => resolved.push([d.toolUseId, d.reason]))
    const ids = []
    pm.on('user_question', (d) => ids.push(d.toolUseId))
    const p1 = pm._handleAskUserQuestion(Q1, ac.signal)
    const p2 = pm._handleAskUserQuestion(Q2, ac.signal)
    await within(p1)
    ac.abort()
    const r2 = await within(p2)
    assert.equal(r2.message, 'Cancelled')
    assert.deepEqual(resolved, [[ids[0], 'superseded'], [ids[1], 'aborted']])
    assert.equal(pm.getPendingQuestions().length, 0)
  })
})

describe('the superseded resolution reaches the clients (#8470)', () => {
  const normalizer = new EventNormalizer()
  const norm = (data) => normalizer.normalize('permission_resolved', data, { sessionId: 's1' })

  it('a superseded question is announced by toolUseId, and its route is pruned', () => {
    const out = norm({ toolUseId: 'ask-1', decision: 'deny', reason: 'superseded' })
    assert.deepEqual(out.messages.map((m) => m.msg), [
      { type: 'permission_resolved', toolUseId: 'ask-1', decision: 'deny', reason: 'superseded', sessionId: 's1' },
    ])
    assert.deepEqual(out.registrations, [{ map: 'question', key: 'ask-1', action: 'delete' }])
  })

  for (const reason of ['answered', 'timeout', 'aborted', 'cleared']) {
    it(`a question ended by '${reason}' still emits no frame (route cleanup only)`, () => {
      const out = norm({ toolUseId: 'ask-1', reason })
      assert.deepEqual(out.messages, [])
      assert.deepEqual(out.registrations, [{ map: 'question', key: 'ask-1', action: 'delete' }])
    })
  }

  it('a permission prompt resolution is unchanged', () => {
    const out = norm({ requestId: 'req-1', decision: 'allow', reason: 'user' })
    assert.equal(out.messages[0].msg.requestId, 'req-1')
    assert.equal(out.messages[0].msg.toolUseId, undefined)
  })
})

describe('the answering client is told when its answer was not delivered (#8470)', () => {
  const live = []
  afterEach(() => { for (const pm of live.splice(0)) pm.clearAll() })

  function setup() {
    const pm = new PermissionManager({ log: silentLog, timeoutMs: 3000 })
    live.push(pm)
    const history = new SessionMessageHistory({ maxHistory: 50 })
    const sid = 's1'
    const ids = []
    pm.on('user_question', (d) => { ids.push(d.toolUseId); history.recordHistory(sid, 'user_question', d) })
    const marked = []
    const sent = []
    const sessionManager = {
      getSession: () => ({ session: { respondToQuestion: (...a) => pm.respondToQuestion(...a) } }),
      recordQuestionAnswered: (s, id) => { marked.push(id); history.markQuestionAnswered(s, id) },
    }
    const questionSessionMap = new Map()
    const transport = { send: (ws, frame) => sent.push({ ws, frame }) }
    const ctx = { permissions: { questionSessionMap }, sessions: { sessionManager }, transport }
    const client = { id: 'c1', boundSessionId: sid, activeSessionId: sid }
    const ws = { readyState: 1 }
    const answer = (c, body) => inputHandlers.user_question_response(ws, c, { type: 'user_question_response', ...body }, ctx)
    return { pm, ids, marked, sent, ctx, client, ws, answer, history, sid, questionSessionMap }
  }

  it('a late answer to a superseded question gets a QUESTION_NOT_DELIVERED frame and records nothing', async () => {
    const { pm, ids, marked, sent, ws, answer, questionSessionMap, client } = setup()
    // Mirror the wiring: the route is registered at dispatch and pruned on resolve.
    pm.on('user_question', (d) => questionSessionMap.set(d.toolUseId, 's1'))
    pm.on('permission_resolved', (d) => { if (d.toolUseId) questionSessionMap.delete(d.toolUseId) })
    const p1 = pm._handleAskUserQuestion(Q1, null)
    const p2 = pm._handleAskUserQuestion(Q2, null)
    await within(p1)

    answer(client, { toolUseId: ids[0], answer: 'LATE-A1' })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].ws, ws, 'only the answering client is told')
    assert.equal(sent[0].frame.type, 'error')
    assert.equal(sent[0].frame.code, 'QUESTION_NOT_DELIVERED')
    assert.equal(sent[0].frame.toolUseId, ids[0])
    assert.equal(sent[0].frame.sessionId, 's1')
    assert.equal(sent[0].frame.fatal, false, 'the session is fine: a warning, not an error')
    assert.equal(typeof sent[0].frame.message, 'string')
    assert.deepEqual(marked, [], 'not recorded as answered')
    assert.equal(await settled(p2), false, 'question 2 untouched')
  })

  it('a manager refusal (route still mapped, id is not the pending one) is reported too', async () => {
    const { pm, ids, marked, sent, answer, questionSessionMap, client } = setup()
    const p1 = pm._handleAskUserQuestion(Q1, null)
    pm.respondToQuestion('A1', undefined, ids[0])
    await within(p1)
    const p2 = pm._handleAskUserQuestion(Q2, null)
    questionSessionMap.set(ids[0], 's1') // the stale route survived somehow

    answer(client, { toolUseId: ids[0], answer: 'LATE-A1' })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].frame.code, 'QUESTION_NOT_DELIVERED')
    assert.equal(sent[0].frame.toolUseId, ids[0])
    assert.deepEqual(marked, [])
    assert.equal(await settled(p2), false)
  })

  it('an answer that is delivered gets no error frame', async () => {
    const { pm, ids, marked, sent, answer, questionSessionMap, client } = setup()
    const p = pm._handleAskUserQuestion(Q1, null)
    questionSessionMap.set(ids[0], 's1')
    answer(client, { toolUseId: ids[0], answer: 'A1' })
    assert.equal((await within(p)).behavior, 'allow')
    assert.deepEqual(sent, [])
    assert.deepEqual(marked, [ids[0]])
  })

  it('a client that may not answer (another session) is not told anything', () => {
    const { ids, sent, answer, questionSessionMap, pm } = setup()
    pm._handleAskUserQuestion(Q1, null)
    questionSessionMap.set(ids[0], 's1')
    answer({ id: 'c2', boundSessionId: 'other', activeSessionId: 'other' }, { toolUseId: ids[0], answer: 'A1' })
    assert.deepEqual(sent, [], 'no oracle for another session\'s question ids')
    assert.ok(questionSessionMap.has(ids[0]), 'the legitimate route is left intact')
  })
})

describe('a superseded question\'s history record (#8470)', () => {
  it('is not marked answered, and is not interrupted once its denial result lands', () => {
    const history = new SessionMessageHistory({ maxHistory: 50 })
    const sid = 's1'
    history.recordHistory(sid, 'tool_start', { toolUseId: 'toolu_1', tool: 'AskUserQuestion', input: Q1 })
    history.recordHistory(sid, 'user_question', { toolUseId: 'ask-1', sourceToolUseId: 'toolu_1', questions: Q1.questions })
    // The superseded question resolves as a deny; the SDK reports the tool's result.
    history.recordHistory(sid, 'tool_result', { toolUseId: 'toolu_1', result: 'Superseded by a newer question', isError: true })

    const entries = history.getHistory(sid)
    const q = entries.find((e) => e.type === 'user_question')
    assert.notEqual(q.answered, true, 'a superseded question is never recorded as answered')
    const swept = SessionMessageHistory.sweepUnresolvedToolStarts(entries)
    assert.equal(swept.some((e) => e.interrupted === true), false, 'nothing is left interrupted')
  })
})
