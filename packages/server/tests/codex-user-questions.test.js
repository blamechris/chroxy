import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { CodexAppServerClient } from '../src/codex-app-server-client.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { inputHandlers } from '../src/handlers/input-handlers.js'
import { QuestionRouteMap } from '../src/question-route-map.js'
import { SessionManager } from '../src/session-manager.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { setupForwarding } from '../src/ws-forwarding.js'
import { CAPABILITY_HISTORY_QUESTION_RESOLVED, resendPendingQuestions, resolveReplayPlan, sendHistoryEntry } from '../src/ws-history.js'

const SESSION_ID = 'chroxy-session'
const METHOD = 'item/tool/requestUserInput'
const QUESTION = {
  id: 'target', header: 'Target', question: 'Which target?', isOther: true, isSecret: false,
  options: [{ label: 'Core', description: 'Inspect core' }, { label: 'UI', description: 'Inspect UI' }],
}
const PARAMS = { threadId: 'parent', turnId: 'parent-turn', itemId: 'parent-item', questions: [QUESTION], isBlocking: true, autoResolutionMs: null }
const WORKER_PARAMS = { threadId: 'worker', turnId: 'worker-turn', itemId: 'worker-item' }

async function setup(t, { active = true, maxMessages, rejectInterrupt = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-codex-question-'))
  const replies = []
  const requests = []
  const notices = []
  const senderFrames = []
  // A local fake stdio process. Session.start and the actual transport both
  // run, but every frame is synthetic and no native binary or login is used.
  const child = Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {},
  })
  const receive = (frame) => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  child.stdin.write = (line) => {
    const frame = JSON.parse(line)
    const { id, method } = frame
    if (!method) replies.push(frame)
    else if (id !== undefined) {
      requests.push(frame)
      const results = {
        initialize: { userAgent: 'codex_cli_rs/0.163.0 (synthetic) chroxy' },
        'thread/start': { thread: { id: 'parent' } },
      }
      if (rejectInterrupt && method === 'turn/interrupt') {
        queueMicrotask(() => receive({ id, error: { code: -32602, message: 'Interrupt refused by fixture' } }))
      } else {
        queueMicrotask(() => receive({ id, result: results[method] ?? {} }))
      }
    }
    return false // writable backpressure still admits the write
  }
  const session = new CodexAppServerSession({
    cwd: dir, skillsDir: dir, repoSkillsDir: null,
    spawnPreflight: () => '/fixture/codex',
    binaryFailureLabeler: () => null,
    bundledClientFinder: () => null,
    clientFactory: (config) => new CodexAppServerClient({ ...config, spawnFn: () => child }),
  })
  const sessionManager = new SessionManager({ maxMessages, skipPreflight: true, stateFilePath: join(dir, 'state.json') })
  const questionSessionMap = new QuestionRouteMap()
  sessionManager._sessions.set(SESSION_ID, { session, name: SESSION_ID, cwd: dir })
  sessionManager._wireSessionEvents(SESSION_ID, session)
  setupForwarding({
    normalizer: new EventNormalizer(), sessionManager, permissionSessionMap: new Map(), questionSessionMap,
    devPreview: Object.assign(new EventEmitter(), { closeSession() {} }),
    broadcast() {}, broadcastSessionList() {},
    broadcastToSession: (_id, frame) => notices.push(frame),
  })
  t.after(async () => {
    await session.destroy()
    await sessionManager.destroyAll()
    rmSync(dir, { recursive: true, force: true })
  })
  await session.start()
  if (active) receive({ method: 'turn/started', params: { threadId: 'parent', turn: { id: 'parent-turn' } } })

  const socket = { readyState: 1 }
  const viewer = { id: 'viewer', boundSessionId: SESSION_ID, activeSessionId: SESSION_ID }
  const ctx = {
    permissions: { questionSessionMap }, sessions: { sessionManager },
    transport: { send: (_ws, frame) => senderFrames.push(frame) },
  }
  const answer = (body, client = viewer) => inputHandlers.user_question_response(socket, client, { type: 'user_question_response', ...body }, ctx)
  const ask = (id, overrides) => receive({ id, method: METHOD, params: { ...PARAMS, ...overrides } })
  const resolve = (requestId, threadId = 'parent') => receive({ method: 'serverRequest/resolved', params: { requestId, threadId } })
  const questions = () => notices.filter(frame => frame.type === 'user_question')
  const resolutions = () => notices.filter(frame => frame.type === 'permission_resolved')
  const replayPending = () => {
    const frames = []
    resendPendingQuestions({ sessionManager, send: (_ws, frame) => frames.push(frame) }, socket, SESSION_ID)
    return frames
  }
  return { session, sessionManager, child, receive, ask, resolve, answer, questions, resolutions, replayPending, requests, replies, notices, senderFrames, questionSessionMap }
}

it('surfaces a native form separately from approvals and sends only a matching explicit human answer', async (t) => {
  const { session, ask, resolve, answer, questions, resolutions, replies, notices, senderFrames } = await setup(t)
  const second = { ...QUESTION, header: 'Scope', question: 'Which scope?', id: '__proto__', isOther: false }
  ask(71, { questions: [QUESTION, second], autoResolutionMs: 1 })
  session.permissionMode = 'auto'
  session._onPermissionModeChanged('auto')
  await new Promise(resolveWait => setTimeout(resolveWait, 10))

  assert.equal(questions().length, 1)
  assert.equal(notices.some(frame => frame.type === 'permission_request'), false)
  assert.deepEqual(replies, [], 'Auto mode and autoResolutionMs do not answer the question')
  const [{ toolUseId, questions: [firstQ, secondQ] }] = questions()
  assert.equal(firstQ.question, 'Target\nWhich target?')
  assert.deepEqual(firstQ.options, QUESTION.options)
  assert.equal(firstQ.allowOther, false, 'the existing multi-question form offers choices only')
  assert.equal(session.respondToQuestion('Core'), false, 'an explicit local id is required')

  const selected = { [firstQ.question]: 'Core', [secondQ.question]: 'UI' }
  answer({ toolUseId, answer: 'Core, UI', answers: selected })
  assert.deepEqual(senderFrames, [])
  assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 71, result: { answers: { target: { answers: ['Core'] }, ['__proto__']: { answers: ['UI'] } } } }])
  assert.deepEqual(resolutions(), [{
    type: 'permission_resolved', toolUseId, reason: 'resolved', decision: 'allow', resolvedBy: { kind: 'user' }, sessionId: SESSION_ID,
  }])
  resolve(71)
  answer({ toolUseId, answer: 'Core, UI', answers: selected })
  assert.equal(replies.length, 1, 'native resolution and duplicate human answer are idempotent')
  assert.equal(resolutions().length, 1)
  assert.deepEqual(senderFrames, [], 'the duplicate of the delivered answer is harmless')
})

it('maps single-question free text and Other through the same human response path', async (t) => {
  const { ask, answer, questions, replies } = await setup(t)
  ask('choices')
  assert.equal(questions()[0].questions[0].allowOther, true)
  answer({ toolUseId: questions()[0].toolUseId, answer: 'Other', freeformText: 'Inspect docs' })
  ask('free-text', { questions: [{ ...QUESTION, options: null }] })
  answer({ toolUseId: questions()[1].toolUseId, answer: 'Read the summary' })
  assert.deepEqual(replies.map(frame => [frame.id, frame.result]), [
    ['choices', { answers: { target: { answers: ['user_note: Inspect docs'] } } }],
    ['free-text', { answers: { target: { answers: ['user_note: Read the summary'] } } }],
  ])
})

it('leaves the exact route pending when a human response is invalid and refuses unentitled callers', async (t) => {
  const { ask, answer, questions, replies, senderFrames, questionSessionMap } = await setup(t)
  ask(1, { questions: [{ ...QUESTION, isOther: false }] })
  const [{ toolUseId }] = questions()
  answer({ toolUseId, answer: 'Other', freeformText: 'Unlisted option' })
  answer({ toolUseId, answer: 'Core', answers: {} })
  answer({ toolUseId, answer: 'Core', answers: { 'Target\nWhich target?': ' ' } })
  answer({ toolUseId, answer: 'Core' }, { id: 'outside', boundSessionId: 'other', activeSessionId: 'other' })
  assert.deepEqual(replies, [])
  assert.deepEqual(senderFrames.map(frame => frame.code), Array(3).fill('QUESTION_NOT_DELIVERED'))
  assert.equal(questionSessionMap.get(toolUseId), SESSION_ID)
  answer({ toolUseId, answer: 'Core' })
  assert.equal(questionSessionMap.has(toolUseId), false)
  assert.deepEqual(replies[0].result, { answers: { target: { answers: ['Core'] } } })
})

it('rejects malformed, ambiguous, secret and unrenderable requests without sending a result', async (t) => {
  const { ask, receive, questions, replies } = await setup(t)
  const distinct = { ...QUESTION, id: 'scope', header: 'Scope', question: 'Which scope?' }
  const cases = [
    { threadId: '' }, { turnId: '' }, { itemId: 2 }, { isBlocking: 'yes' }, { autoResolutionMs: -1 },
    { questions: [] }, { questions: [null] }, { questions: [{ ...QUESTION, isSecret: true }] },
    { questions: [QUESTION, { ...distinct, id: QUESTION.id }] },
    { questions: [QUESTION, { ...QUESTION, id: 'duplicate-looking-text' }] },
    { questions: [QUESTION, { ...distinct, options: null }] },
    { questions: [{ ...QUESTION, options: [QUESTION.options[0], QUESTION.options[0]] }] },
    { questions: [{ ...QUESTION, options: [{ label: '__chroxy_other__', description: '' }] }] },
  ]
  cases.forEach((params, id) => ask(id, params))
  receive({ id: 'alias', method: 'tool/requestUserInput', params: PARAMS })
  assert.deepEqual(questions(), [])
  assert.equal(replies.length, cases.length + 1)
  assert.ok(replies.slice(0, -1).every(frame => frame.error?.code === -32602 && frame.result === undefined))
  assert.equal(replies.at(-1).error.code, -32601)
})

it('rejects the two display keys reserved for a single custom answer', async (t) => {
  const { ask, answer, questions, replies } = await setup(t)
  const labelQuestion = { ...QUESTION, id: 'label', header: '', question: 'otherLabel' }
  const textQuestion = { ...QUESTION, id: 'text', header: '', question: 'freeformText' }
  ask(1, { questions: [labelQuestion, textQuestion] })
  assert.equal(questions().length, 0, 'the shared client would send this form as a single custom answer')
  assert.equal(replies[0]?.error?.code, -32602)

  ask(2, { questions: [labelQuestion, textQuestion, QUESTION] })
  const [{ toolUseId }] = questions()
  answer({ toolUseId, answer: 'Core, UI, Core', answers: { otherLabel: 'Core', freeformText: 'UI', ['Target\nWhich target?']: 'Core' } })
  assert.deepEqual(replies[1]?.result, { answers: { label: { answers: ['Core'] }, text: { answers: ['UI'] }, target: { answers: ['Core'] } } })
})

it('clears a relayed worker question by exact typed request and thread while the parent remains active', async (t) => {
  const { session, ask, resolve, answer, questions, resolutions, replayPending, replies, notices, senderFrames } = await setup(t)
  const worker = { threadId: 'worker', turnId: 'worker-turn', itemId: 'worker-item' }
  ask(8)
  ask('8', worker)
  ask('8', worker)
  assert.equal(questions().length, 2, 'duplicate native requests do not send duplicate cards')
  const [parentQ, workerQ] = questions()
  assert.deepEqual(replayPending().map(frame => frame.toolUseId), [parentQ.toolUseId, workerQ.toolUseId])

  resolve(8, 'worker')
  resolve('8', 'parent')
  resolve('unknown', 'worker')
  assert.deepEqual(resolutions(), [], 'wrong thread or unknown request resolves nothing')

  resolve('8', 'worker')
  resolve('8', 'worker')
  ask('8', worker)
  assert.deepEqual(resolutions(), [{
    type: 'permission_resolved', toolUseId: workerQ.toolUseId, reason: 'resolved', decision: 'deny', resolvedBy: { kind: 'cleared' }, sessionId: SESSION_ID,
  }])
  assert.equal(questions().length, 2, 'late repeat cannot resurrect the resolved question')
  assert.deepEqual(replayPending().map(frame => frame.toolUseId), [parentQ.toolUseId])
  assert.equal(session._activeTurn.turnId, 'parent-turn')
  assert.equal(notices.some(frame => frame.type === 'result'), false)
  assert.equal(session._resultTimeout, null, 'the parent blocking question still owns the pause')
  answer({ toolUseId: workerQ.toolUseId, answer: 'Core' })
  assert.deepEqual(replies, [])
  assert.equal(senderFrames.at(-1).code, 'QUESTION_NOT_DELIVERED')
  resolve(8)
  assert.ok(session._resultTimeout, 'resolving the last blocking question re-arms the result timeout')
  assert.deepEqual(replayPending(), [])
})

it('journals closures for full and cursor replay without reviving a closed question on older clients', async (t) => {
  const { ask, resolve, sessionManager, questions, replayPending } = await setup(t)
  ask(2)
  const [{ toolUseId }] = questions()
  const pendingCursor = sessionManager.getLatestHistorySeq(SESSION_ID)
  resolve(2)
  resolve(2)
  const history = sessionManager.getHistory(SESSION_ID).filter(frame => frame.type === 'user_question')
  assert.equal(history.length, 2, 'one verdict on the original and one cursor-visible update')
  assert.ok(history.every(frame => frame.toolUseId === toolUseId && frame.resolved === true && frame.answered !== true))
  const capable = { clientCapabilities: new Set([CAPABILITY_HISTORY_QUESTION_RESOLVED]) }
  const out = []
  for (const frame of history) sendHistoryEntry((_ws, event) => out.push(event), null, SESSION_ID, frame, capable)
  assert.equal(out.length, 2)
  assert.ok(out.every(frame => frame.resolved === true))
  assert.equal(out.filter(frame => frame.historySeq > pendingCursor).length, 1)
  for (const frame of history) sendHistoryEntry((_ws, event) => out.push(event), null, SESSION_ID, frame, null)
  assert.equal(out.length, 2, 'older clients receive no closed question replay')
  assert.deepEqual(replayPending(), [])
})

for (const answered of [false, true]) {
  it(`replays one terminal row for an evicted native question ${answered ? 'answered by a person' : 'closed by Codex'}`, async (t) => {
    const { ask, resolve, answer, sessionManager, questions, replayPending } = await setup(t, { maxMessages: 2 })
    ask(1)
    const [evicted] = questions()
    ask(2, { itemId: 'second-item' })
    ask(3, { itemId: 'third-item' })
    assert.equal(sessionManager.getHistory(SESSION_ID).some(row => row.toolUseId === evicted.toolUseId), false)
    assert.ok(replayPending().some(frame => frame.toolUseId === evicted.toolUseId))
    const cursor = sessionManager.getLatestHistorySeq(SESSION_ID)

    if (answered) answer({ toolUseId: evicted.toolUseId, answer: 'Core' })
    resolve(1)
    resolve(1)
    const history = sessionManager.getHistory(SESSION_ID)
    const matching = history.filter(row => row.toolUseId === evicted.toolUseId)
    assert.equal(history.length, 2, 'the closure stays inside the bounded history ring')
    assert.equal(matching.length, 1, 'an evicted question gets one new terminal row')
    assert.equal(matching[0].answered === true, answered)
    assert.equal(replayPending().some(frame => frame.toolUseId === evicted.toolUseId), false)

    const capable = { clientCapabilities: new Set([CAPABILITY_HISTORY_QUESTION_RESOLVED]) }
    for (const after of [0, cursor]) {
      const out = []
      const plan = resolveReplayPlan(sessionManager, history, SESSION_ID, after, sessionManager.getLatestHistorySeq(SESSION_ID))
      assert.equal(plan.fullHistory, after === 0)
      for (const row of history.slice(plan.startOffset)) {
        sendHistoryEntry((_ws, frame) => out.push(frame), null, SESSION_ID, row, capable)
      }
      const verdicts = out.filter(frame => frame.toolUseId === evicted.toolUseId)
      assert.equal(verdicts.length, 1, 'a replay can retire a retained client card')
      assert.equal(verdicts[0].resolved, true)
      assert.equal(verdicts[0].answered, undefined, 'the persisted acceptance flag stays server-side')
      assert.deepEqual(verdicts[0].questions, evicted.questions)
      assert.ok(verdicts[0].historySeq > cursor)
    }
  })
}

it('restoration closes a question that lost its native request while preserving a recorded human answer', async (t) => {
  const { ask, answer, sessionManager, questions } = await setup(t)
  ask(3)
  ask(4, { itemId: 'second-item' })
  const [open, answered] = questions()
  answer({ toolUseId: answered.toolUseId, answer: 'UI' })
  const history = sessionManager._history
  const persisted = JSON.parse(JSON.stringify(history.getHistory(SESSION_ID).map(entry => history.truncateEntry(entry))))
  const restored = SessionMessageHistory.sweepUnresolvedToolStarts(persisted)
  const closedOnRestore = restored.filter(entry => entry.toolUseId === open.toolUseId)
  assert.equal(closedOnRestore.length, 2, 'restore includes an in-place verdict and an update for a cursor replay')
  assert.ok(closedOnRestore.every(entry => entry.resolved === true && entry.answered !== true))
  assert.equal(restored.at(-1).toolUseId, open.toolUseId)
  assert.ok(restored.some(entry => entry.toolUseId === answered.toolUseId && entry.answered === true && entry.resolved === true))
  assert.deepEqual(SessionMessageHistory.sweepUnresolvedToolStarts(restored), restored, 'another restart does not repeat the verdict')
})

it('keeps the normal result timeout alive for nonblocking questions and cleans them at the matching worker turn end', async (t) => {
  const { session, ask, receive, replies, questions, resolutions, replayPending } = await setup(t)
  const worker = { threadId: 'worker', turnId: 'worker-turn', itemId: 'worker-item', isBlocking: false }
  ask(4, worker)
  assert.ok(session._resultTimeout)
  receive({ method: 'turn/completed', params: { threadId: 'worker', turn: { id: 'unrelated-turn', status: 'completed' } } })
  assert.equal(replayPending().length, 1)
  receive({ method: 'turn/completed', params: { threadId: 'worker', turn: { id: 'worker-turn', status: 'completed' } } })
  assert.deepEqual(replayPending(), [])
  assert.equal(resolutions()[0]?.toolUseId, questions()[0].toolUseId)
  assert.equal(session._activeTurn.turnId, 'parent-turn')
  assert.deepEqual(replies, [])
})

it('clears the parent question on completion without consuming a different worker question', async (t) => {
  const { session, ask, receive, questions, resolutions, replayPending, replies } = await setup(t)
  ask(6)
  ask(7, { threadId: 'worker', turnId: 'worker-turn', itemId: 'worker-item' })
  const [parent, worker] = questions()
  receive({ method: 'turn/completed', params: { threadId: 'parent', turn: { id: 'parent-turn', status: 'completed' } } })
  assert.equal(session._activeTurn, null)
  assert.deepEqual(resolutions().map(frame => frame.toolUseId), [parent.toolUseId])
  assert.deepEqual(replayPending().map(frame => frame.toolUseId), [worker.toolUseId])
  assert.deepEqual(replies, [])
})

it('clearing a native question leaves the result timeout paused for a still-pending approval', async (t) => {
  const { session, ask, receive, resolve, replies, notices } = await setup(t)
  ask(8)
  receive({ id: 9, method: 'item/commandExecution/requestApproval', params: { command: 'ls', reason: 'List the fixture' } })
  const approval = notices.find(frame => frame.type === 'permission_request')
  assert.ok(approval?.requestId)
  resolve(8)
  assert.equal(session._resultTimeout, null, 'the unanswered approval still owns the pause')
  assert.deepEqual(replies, [])
  session.respondToPermission(approval.requestId, 'deny')
  await new Promise(resolveTick => setImmediate(resolveTick))
  assert.deepEqual(replies[0].result, { decision: 'decline' })
  assert.ok(session._resultTimeout)
})

for (const [label, options, expectedInterrupt] of [
  ['a parent-only Stop', {}, true],
  ['Stop with an idle parent', { active: false }, false],
  ['a rejected parent interrupt', { rejectInterrupt: true }, true],
]) {
  it(`keeps the worker question answerable after ${label}`, async (t) => {
    const { session, ask, answer, requests, questions, replayPending, resolutions, replies } = await setup(t, options)
    ask('worker-question', WORKER_PARAMS)
    const [{ toolUseId }] = questions()
    await session.interrupt()
    assert.deepEqual(requests.filter(frame => frame.method === 'turn/interrupt').map(frame => frame.params),
      expectedInterrupt ? [{ threadId: 'parent', turnId: 'parent-turn' }] : [])
    assert.deepEqual(replayPending().map(frame => frame.toolUseId), [toolUseId])
    assert.deepEqual(resolutions(), [])
    answer({ toolUseId, answer: 'UI' })
    assert.deepEqual(replies.map(frame => [frame.id, frame.result]), [['worker-question', { answers: { target: { answers: ['UI'] } } }]])
  })
}

it('keeps the worker question answerable after local parent failure', async (t) => {
  const { session, ask, answer, questions, replayPending, resolutions, replies } = await setup(t)
  ask('worker-question', WORKER_PARAMS)
  const [{ toolUseId }] = questions()
  session._failTurn('Local result watchdog timed out')
  assert.equal(session._activeTurn, null)
  assert.deepEqual(replayPending().map(frame => frame.toolUseId), [toolUseId])
  assert.deepEqual(resolutions(), [])
  answer({ toolUseId, answer: 'Core' })
  assert.deepEqual(replies.map(frame => [frame.id, frame.result]), [['worker-question', { answers: { target: { answers: ['Core'] } } }]])
})

it('cleans pending questions on correlated turn completion, client loss, and teardown without a native result', async (t) => {
  const { session, child, ask, receive, replies, replayPending, resolutions } = await setup(t)
  ask(11)
  await session.interrupt()
  assert.equal(replayPending().length, 1, 'the parent request stays bound until Codex confirms its turn ended')
  receive({ method: 'turn/completed', params: { threadId: 'parent', turn: { id: 'parent-turn', status: 'interrupted' } } })
  assert.deepEqual(replayPending(), [])
  receive({ method: 'turn/started', params: { threadId: 'parent', turn: { id: 'next-turn' } } })
  ask(12, { turnId: 'next-turn' })
  ask(13, WORKER_PARAMS)
  child.emit('exit', 1, null)
  assert.deepEqual(replayPending(), [])
  assert.equal(resolutions().length, 3)
  assert.deepEqual(replies, [])

  const idle = await setup(t, { active: false })
  idle.ask(14)
  idle.ask(15, WORKER_PARAMS)
  await idle.session.destroy()
  assert.deepEqual(idle.replayPending(), [])
  assert.equal(idle.resolutions().length, 2)
  assert.deepEqual(idle.replies, [])
})

it('a failed native writer closes the prompt without recording an explicit answer', async (t) => {
  const { child, ask, answer, replies, questions, resolutions, replayPending, senderFrames } = await setup(t)
  ask(5)
  child.stdin.writable = false
  const [{ toolUseId }] = questions()
  answer({ toolUseId, answer: 'Core' })
  assert.deepEqual(replies, [])
  assert.deepEqual(replayPending(), [])
  assert.equal(resolutions()[0]?.decision, 'deny')
  assert.equal(senderFrames.at(-1).code, 'QUESTION_NOT_DELIVERED')
})
