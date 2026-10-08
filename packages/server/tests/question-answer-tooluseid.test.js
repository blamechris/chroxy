import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager } from '../src/permission-manager.js'
import { SdkSession } from '../src/sdk-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { inputHandlers } from '../src/handlers/input-handlers.js'

/**
 * #8460 -- an answer for an earlier question must not resolve a different
 * question that happens to be pending. The SDK, BYOK and codex providers hold ONE
 * pending question in `PermissionManager._pendingUserAnswer` and used to resolve
 * it whatever `toolUseId` the answer carried.
 */

const Q1 = { questions: [{ question: 'First?', options: [{ label: 'A1' }, { label: 'B1' }] }] }
const Q2 = { questions: [{ question: 'Second?', options: [{ label: 'A2' }, { label: 'B2' }] }] }

const silentLog = { info() {}, warn() {} }
const settled = (p) => Promise.race([p.then(() => true), new Promise((r) => setImmediate(() => r(false)))])

/** Ask Q1, answer it, then ask Q2: Q1's answer is now "late". */
function twoQuestionsInSequence(pm) {
  const ids = []
  pm.on('user_question', (d) => ids.push(d.toolUseId))
  const p1 = pm._handleAskUserQuestion(Q1, null)
  pm.respondToQuestion('A1', undefined, ids[0])
  const p2 = pm._handleAskUserQuestion(Q2, null)
  return { ids, p1, p2 }
}

describe('a late question answer is not delivered to the pending question (#8460)', () => {
  const live = []
  afterEach(() => { for (const x of live.splice(0)) (x._permissions || x).clearAll() })
  const manager = () => { const pm = new PermissionManager({ log: silentLog }); live.push(pm); return pm }

  it('PermissionManager: question 1 answer arriving while question 2 is pending is dropped', async () => {
    const pm = manager()
    const { ids, p1, p2 } = twoQuestionsInSequence(pm)
    assert.equal((await p1).behavior, 'allow', 'premise: question 1 was answered')
    assert.notEqual(ids[0], ids[1])

    const resolved = []
    pm.on('permission_resolved', (d) => resolved.push(d))
    const result = pm.respondToQuestion('LATE-A1', undefined, ids[0])

    assert.equal(result, false, 'the refusal is reported to the caller')
    assert.equal(await settled(p2), false, 'question 2 is still blocked')
    assert.deepEqual(pm.getPendingQuestions().map((q) => q.toolUseId), [ids[1]], 'question 2 is still pending')
    assert.equal(pm._waitingForAnswer, true)
    assert.ok(pm._questionTimer !== null, 'question 2 keeps its timeout')
    assert.equal(resolved.length, 0, 'no permission_resolved for a refused answer')

    pm.respondToQuestion('A2', undefined, ids[1])
    const r2 = await p2
    assert.equal(r2.behavior, 'allow')
    assert.deepEqual(r2.updatedInput.answers, { 'Second?': 'A2' }, 'question 2 got its own answer, never the late one')
  })

  it('an answer with no toolUseId still goes to the pending question', async () => {
    const pm = manager()
    const { p2 } = twoQuestionsInSequence(pm)
    assert.equal(pm.respondToQuestion('A2'), undefined)
    assert.deepEqual((await p2).updatedInput.answers, { 'Second?': 'A2' })
  })

  it('an answer carrying the pending id is delivered', async () => {
    const pm = manager()
    const { ids, p2 } = twoQuestionsInSequence(pm)
    pm.respondToQuestion('B2', undefined, ids[1])
    assert.deepEqual((await p2).updatedInput.answers, { 'Second?': 'B2' })
  })

  it('an empty-string toolUseId is an id, and is not the pending question\'s', async () => {
    const pm = manager()
    const { ids, p2 } = twoQuestionsInSequence(pm)
    assert.equal(pm.respondToQuestion('X', undefined, ''), false)
    assert.equal(await settled(p2), false)
    pm.respondToQuestion('A2', undefined, ids[1])
    await p2
  })

  it('a refused answer with an unknown id never cancels the timer or the question', async () => {
    const pm = manager()
    const ids = []
    pm.on('user_question', (d) => ids.push(d.toolUseId))
    const p = pm._handleAskUserQuestion(Q1, null)
    assert.equal(pm.respondToQuestion('x', undefined, 'ask-other-9-9'), false)
    assert.equal(await settled(p), false)
    assert.ok(pm._questionTimer !== null)
    pm.respondToQuestion('A1', undefined, ids[0])
    assert.equal((await p).behavior, 'allow')
  })

  for (const [name, make] of [
    ['SdkSession', () => new SdkSession({ cwd: '/tmp', permissionMode: 'approve' })],
    ['ClaudeByokSession', () => new ClaudeByokSession({ cwd: '/tmp' })],
  ]) {
    it(`${name} forwards the id: the late answer is dropped, the pending one delivered`, async () => {
      const s = make()
      live.push(s)
      const ids = []
      s._permissions.on('user_question', (d) => ids.push(d.toolUseId))
      const p1 = s._permissions.handlePermission('AskUserQuestion', Q1, null, 'approve', undefined, 'toolu_1')
      assert.equal(s.respondToQuestion('A1', undefined, ids[0]), undefined)
      await p1
      const p2 = s._permissions.handlePermission('AskUserQuestion', Q2, null, 'approve', undefined, 'toolu_2')

      assert.equal(s.respondToQuestion('LATE', undefined, ids[0]), false)
      assert.equal(await settled(p2), false, 'question 2 is still blocked')
      s.respondToQuestion('A2', undefined, ids[1])
      assert.deepEqual((await p2).updatedInput.answers, { 'Second?': 'A2' })
    })
  }

  it('CodexAppServerSession forwards the id to the shared manager', async () => {
    // Called off the prototype: the constructor spawns nothing we need here, the
    // method is a one-line delegator to `_permissions`.
    const pm = manager()
    const ids = []
    pm.on('user_question', (d) => ids.push(d.toolUseId))
    const p = pm._handleAskUserQuestion(Q2, null)
    const host = { _permissions: pm }
    assert.equal(CodexAppServerSession.prototype.respondToQuestion.call(host, 'LATE', undefined, 'ask-old-1-1'), false)
    assert.equal(await settled(p), false)
    CodexAppServerSession.prototype.respondToQuestion.call(host, 'A2', undefined, ids[0])
    assert.equal((await p).behavior, 'allow')
  })
})

describe('the WS handler does not record a refused answer as answered (#8460)', () => {
  const live = []
  afterEach(() => { for (const pm of live.splice(0)) pm.clearAll() })

  /**
   * The route map still names question 1 (so the handler's own stale-route drop
   * does not catch it): the manager is the only thing left that can tell.
   */
  function setup() {
    const pm = new PermissionManager({ log: silentLog })
    live.push(pm)
    const history = new SessionMessageHistory({ maxHistory: 50 })
    const sid = 's1'
    const ids = []
    pm.on('user_question', (d) => { ids.push(d.toolUseId); history.recordHistory(sid, 'user_question', d) })
    const p1 = pm._handleAskUserQuestion(Q1, null)
    pm.respondToQuestion('A1', undefined, ids[0])
    const p2 = pm._handleAskUserQuestion(Q2, null)
    const marked = []
    const sessionManager = {
      getSession: () => ({ session: { respondToQuestion: (...a) => pm.respondToQuestion(...a) } }),
      recordQuestionAnswered: (s, id) => { marked.push(id); history.markQuestionAnswered(s, id) },
    }
    const questionSessionMap = new Map([[ids[0], sid]])
    const ctx = { permissions: { questionSessionMap }, sessions: { sessionManager } }
    const client = { id: 'c1', boundSessionId: sid, activeSessionId: sid }
    const answered = () => history.getHistory(sid).filter((e) => e.answered === true).map((e) => e.toolUseId)
    return { pm, ids, p1, p2, marked, ctx, client, answered }
  }

  it('the late answer reaches nothing and marks neither question answered', async () => {
    const { ids, p2, marked, ctx, client, answered } = setup()
    inputHandlers.user_question_response(null, client, { type: 'user_question_response', toolUseId: ids[0], answer: 'LATE-A1' }, ctx)
    assert.equal(await settled(p2), false, 'question 2 not resolved')
    assert.deepEqual(marked, [], 'nothing recorded as answered')
    assert.deepEqual(answered(), [])
  })

  it('control: the matching answer is delivered and recorded', async () => {
    const { ids, p2, marked, ctx, client } = setup()
    ctx.permissions.questionSessionMap.set(ids[1], 's1')
    inputHandlers.user_question_response(null, client, { type: 'user_question_response', toolUseId: ids[1], answer: 'A2' }, ctx)
    assert.equal((await p2).behavior, 'allow')
    assert.deepEqual(marked, [ids[1]])
  })

  it('control: an answer with no toolUseId is delivered and recorded as before', async () => {
    const { ids, p2, marked, ctx, client } = setup()
    inputHandlers.user_question_response(null, client, { type: 'user_question_response', answer: 'A2' }, ctx)
    assert.deepEqual((await p2).updatedInput.answers, { 'Second?': 'A2' })
    assert.deepEqual(marked, [undefined])
    assert.equal(ids.length, 2)
  })
})
