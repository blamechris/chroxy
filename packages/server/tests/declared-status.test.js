import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractDeclaredStatus, MAX_DECLARATION_MESSAGE_CHARS } from '../src/declared-status.js'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { GeminiSession } from '../src/gemini-session.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { SdkSession } from '../src/sdk-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { sendSessionInfo } from '../src/ws-history.js'
import { DeclaredStatusInputSchema, ServerSessionStatusSchema } from '@chroxy/protocol'

function complete(session, content) { session.emit('message', { type: 'response', content }); session.emit('result', {}) }

const footer = (decision = 'Choose the target', token = '🔴 BLOCKED') => `**Status:**\n- ✅ Tests passed\n- 🔄 none\n- ⛔ Waiting on owner\n- 🔶 **DECISION:** ${decision}\n\n**Next:** ${token} — Choose a target OWNER: Chris`
function harness(Session = BaseSession) {
  const dir = mkdtempSync(join(tmpdir(), 'declared-status-'))
  const session = new Session({ cwd: dir, skillsDir: dir, repoSkillsDir: null })
  if (Session === BaseSession) session.destroy = () => { session._destroyPendingBackgroundShells(); session.removeAllListeners() }
  const manager = new SessionManager({ skipPreflight: true, stateFilePath: join(dir, 'state.json') })
  manager._sessions.set('s1', { session, name: 'Status test', cwd: dir, provider: 'claude-sdk', createdAt: Date.now() })
  manager._wireSessionEvents('s1', session)
  const statuses = []
  const normalizer = new EventNormalizer()
  manager.on('session_event', (frame) => {
    if (frame.event !== 'session_status') return
    const messages = normalizer.normalize(frame.event, frame.data, { sessionId: 's1' }).messages
    assert.equal(messages.length, 1, 'one session_status wire broadcast per completed declaration')
    assert.equal(messages[0].msg.type, 'session_status')
    statuses.push(messages[0].msg.declaredStatus)
  })
  return { dir, session, manager, statuses, close() { manager.destroyAll(); rmSync(dir, { recursive: true, force: true }) } }
}
describe('declared status grammar', () => {
  it('extracts bold Markdown, CRLF, whitespace, enumeration and Next tokens', () => {
    const text = footer().replace('- 🔄 none', '- 🔄 1 in flight:\n  - task — running (tests)').replace(/\n/g, '\r\n')
    assert.deepEqual(extractDeclaredStatus(text), { state: 'blocked', summary: 'Tests passed', next: 'Choose a target OWNER: Chris', blockedOn: 'Waiting on owner', decision: 'Choose the target' })
    for (const [token, state] of [['🟢RUNNING', 'running'], ['⚪ IDLE', 'idle'], ['🟠 FAILED', 'stalled'], ['🟣 PAUSED', 'unknown']]) assert.equal(extractDeclaredStatus(footer('none', token)).state, state)
  })
  it('uses newest complete tail declaration and preserves explicit none', () => {
    assert.equal(extractDeclaredStatus(`${footer('old')}\n\n${footer('NoNe')}`).decision, 'NoNe')
    assert.equal(extractDeclaredStatus('[chroxy-status] running: Running tests').summary, 'Running tests')
    assert.equal(extractDeclaredStatus('Next: 🟢 RUNNING — Run tests (session)').state, 'running')
  })
  it('rejects quoted, fenced, indented, narrative, example and incomplete output', () => {
    const cases = [footer().split('\n').map((line) => `> ${line}`).join('\n'), `\`\`\`md\n${footer()}\n\`\`\``, footer().split('\n').map((line) => `    ${line}`).join('\n'), `Example:\n${footer()}`, `${footer()}\nThis was the old status.`, footer().replace('- ⛔ Waiting on owner\n', ''), 'Everything is done', 'The status is [chroxy-status] running: tests', '[chroxy-status] invalid: tests', '[chroxy-status] running:', 'x'.repeat(MAX_DECLARATION_MESSAGE_CHARS + 1)]
    for (const text of cases) assert.equal(extractDeclaredStatus(text), null, text.slice(0, 100))
  })
  it('enforces bounded status input', () => {
    assert.equal(DeclaredStatusInputSchema.safeParse({ state: 'invalid', summary: 'x' }).success, false)
    assert.equal(DeclaredStatusInputSchema.safeParse({ state: 'done', summary: 'x'.repeat(281) }).success, false)
    assert.equal(DeclaredStatusInputSchema.safeParse({ state: 'done', summary: 'ok', etaMinutes: -1 }).success, false)
    assert.equal(extractDeclaredStatus(`[chroxy-status] idle: ${'x'.repeat(500)}`).summary.length, 280)
  })
})
describe('completed assistant declarations', () => {
  it('does not parse partial chunks, thinking, nonassistant or duplicate end', () => {
    const h = harness()
    try {
      h.session.emit('stream_start', { messageId: 'm' })
      for (const delta of footer().split('')) h.session.emit('stream_delta', { messageId: 'm', delta })
      assert.equal(h.statuses.length, 0)
      h.session.emit('stream_end', { messageId: 'm' })
      h.session.emit('stream_end', { messageId: 'm' })
      assert.equal(h.statuses.length, 0, 'stream closure is not a successful turn')
      h.session.emit('result', {})
      h.session.emit('message', { type: 'user_input', content: footer('evil') })
      h.session.emit('stream_start', { messageId: 'thought', thinking: true })
      h.session.emit('stream_delta', { messageId: 'thought', delta: footer('evil') })
      h.session.emit('stream_end', { messageId: 'thought', thinking: true })
      assert.equal(h.statuses.length, 1)
      assert.equal(h.manager.listSessions()[0].isBusy, false)
      assert.ok(ServerSessionStatusSchema.safeParse({ type: 'session_status', sessionId: 's1', declaredStatus: h.statuses[0] }).success)
    } finally { h.close() }
  })
  it('keeps one durable decision through reset, replay and recovery; clear is separate from permissions/questions', () => {
    const h = harness()
    try {
      complete(h.session, footer())
      complete(h.session, footer())
      h.session._activity.reset()
      complete(h.session, 'No status this time')
      complete(h.session, footer().replace('DECISION:', 'Invalid:'))
      complete(h.session, '[chroxy-status] running: Checking')
      assert.equal(h.session.getActivitySnapshot().entries.filter((entry) => entry.kind === 'decision').length, 1)
      const saved = h.manager.serializeState().sessions[0]
      assert.equal(saved.declaredStatus.decision, 'Choose the target')
      const replay = []
      sendSessionInfo({ sessionManager: h.manager, send: (_ws, msg) => replay.push(msg), clients: new Map() }, {}, 's1', { skipModels: true })
      assert.equal(replay.filter((msg) => msg.type === 'session_status').length, 1)
      assert.equal(replay.find((msg) => msg.type === 'activity_snapshot').entries[0].id, 'decision:session')
      const restored = harness()
      try {
        restored.manager.createSession = () => 's1'
        restored.manager._attemptRestoreOne(saved, true)
        assert.equal(restored.session.getActivitySnapshot().entries[0].kind, 'decision')
        assert.equal(restored.manager.listSessions()[0].declaredStatus.decision, 'Choose the target')
      } finally { restored.close() }
      h.session._activity.onPermissionRequest({ requestId: 'p', tool: 'Bash' })
      h.session._activity.onUserQuestion({ toolUseId: 'q' })
      complete(h.session, footer('none', '⚪ IDLE'))
      assert.deepEqual(h.session.getActivitySnapshot().entries.map((entry) => entry.id).sort(), ['blocked:p', 'blocked:q'])
      complete(h.session, footer('Another decision'))
      assert.equal(h.session.getActivitySnapshot().entries.filter((entry) => entry.kind === 'decision').length, 1)
    } finally { h.close() }
  })
  it('refuses truncated response buffer', () => {
    const history = new SessionMessageHistory({ maxPendingStreamSize: 100 })
    history.recordHistory('s', 'stream_start', { messageId: 'm' })
    history.recordHistory('s', 'stream_delta', { messageId: 'm', delta: '[chroxy-status] done: tests' })
    history.recordHistory('s', 'stream_delta', { messageId: 'm', delta: 'x'.repeat(200) })
    assert.equal(history.recordHistory('s', 'stream_end', { messageId: 'm' }).completedAssistant, undefined)
  })
  it('extracts SDK completed assistant through real sendMessage mapping', async () => {
    const h = harness(SdkSession)
    try {
      h.session._processReady = true
      h.session._fetchSupportedModels = () => {}
      h.session._callQuery = () => (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '[chroxy-status] running: Running SDK tests' }] } }
        yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, duration_ms: 1, usage: {} }
      })()
      await h.session.sendMessage('test status')
      assert.equal(h.statuses.length, 1)
      assert.equal(h.manager.listSessions()[0].declaredStatus.summary, 'Running SDK tests')
    } finally { h.close() }
  })
  it('extracts Codex only at completion and retains decision after turn reset', () => {
    const h = harness(CodexAppServerSession)
    try {
      h.session._activeTurn = { messageId: 'm', turnId: 't', didStreamStart: false }
      h.session._isBusy = true
      for (const delta of [footer().slice(0, 10), footer().slice(10)]) h.session._onNotification({ method: 'item/agentMessage/delta', params: { delta } })
      assert.equal(h.statuses.length, 0)
      h.session._onNotification({ method: 'item/completed', params: { item: { id: 'response', type: 'agentMessage', text: footer() } } })
      h.session._onNotification({ method: 'turn/completed', params: { turn: { status: 'completed', durationMs: 1 } } })
      assert.equal(h.statuses.length, 1)
      assert.equal(h.session.getActivitySnapshot().entries[0].status, 'blocked')
    } finally { h.close() }
  })
})


it('current Gemini JSONL messages share the canonical assistant completion seam', () => {
  const h = harness(GeminiSession)
  try {
    const ctx = { messageId: 'gemini-response', didStreamStart: false }
    h.session._processJsonlLine({ type: 'message', role: 'assistant', content: '[chroxy-status] done: Gemini tests passed', delta: true }, ctx)
    assert.equal(h.statuses.length, 0)
    h.session._processJsonlLine({ type: 'result', status: 'success', stats: {} }, ctx)
    assert.equal(h.statuses.length, 1)
    assert.equal(h.statuses[0].state, 'done')
  } finally { h.close() }
})

it('decision lifetimes advance after clear even within one clock tick', () => {
  const h = harness()
  const originalNow = Date.now
  try {
    Date.now = () => 100
    h.manager.setDeclaredStatus('s1', { state: 'blocked', summary: 'First', decision: 'First' })
    const first = h.session.getActivitySnapshot().entries[0]
    h.manager.setDeclaredStatus('s1', { state: 'idle', summary: 'Clear', decision: 'none' })
    h.manager.setDeclaredStatus('s1', { state: 'blocked', summary: 'Second', decision: 'Second' })
    const second = h.session.getActivitySnapshot().entries[0]
    assert.equal(first.id, second.id)
    assert.ok(second.startedAt > first.startedAt)
  } finally { Date.now = originalNow; h.close() }
})


it('streamed explicit none cannot clear a pending decision when output is stopped, failed or interrupted', () => {
  const h = harness()
  try {
    h.manager.setDeclaredStatus('s1', { state: 'blocked', summary: 'Choose', decision: 'Choose' })
    for (const event of ['stopped', 'error', 'result']) {
      h.session.emit('stream_start', { messageId: event })
      h.session.emit('stream_delta', { messageId: event, delta: footer('none') })
      h.session.emit('stream_end', { messageId: event })
      h.session.emit(event, event === 'result' ? { interrupted: true } : { message: 'Stopped' })
      assert.equal(h.manager.getSession('s1').declaredStatus.decision, 'Choose')
    }
    h.session.emit('stream_start', { messageId: 'truncated' })
    h.session.emit('stream_delta', { messageId: 'truncated', delta: footer('none') })
    h.session.emit('stream_end', { messageId: 'truncated' })
    h.session.emit('result', { turnOutcome: 'truncated' })
    assert.equal(h.manager.getSession('s1').declaredStatus.decision, 'Choose')
  } finally { h.close() }
})


it('a later complete assistant response without a valid declaration supersedes an intermediate declaration', () => {
  const h = harness()
  try {
    h.manager.setDeclaredStatus('s1', { state: 'blocked', summary: 'Keep', decision: 'Keep' })
    h.session.emit('message', { type: 'response', content: footer('none') })
    h.session.emit('message', { type: 'response', content: 'Final answer has no declaration' })
    h.session.emit('result', {})
    assert.equal(h.manager.getSession('s1').declaredStatus.decision, 'Keep')
  } finally { h.close() }
})


it('SDK streamed marker and full-message fallback produce one final broadcast', async () => {
  const h = harness(SdkSession)
  try {
    h.session._processReady = true
    h.session._fetchSupportedModels = () => {}
    const text = '[chroxy-status] running: Streaming SDK checks'
    h.session._callQuery = () => (async function* () {
      yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } }
      assert.equal(h.statuses.length, 0)
      yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, duration_ms: 1, usage: {} }
    })()
    await h.session.sendMessage('test streamed status')
    assert.equal(h.statuses.length, 1)
    assert.equal(h.statuses[0].summary, 'Streaming SDK checks')
  } finally { h.close() }
})

it('SDK query failure and Codex failed/interrupted completion do not clear a pending decision', async () => {
  const sdk = harness(SdkSession)
  try {
    sdk.manager.setDeclaredStatus('s1', { state: 'blocked', summary: 'Keep', decision: 'Keep' })
    sdk.session._processReady = true
    sdk.session._fetchSupportedModels = () => {}
    sdk.session._callQuery = () => (async function* () {
      yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: footer('none') } } }
      throw new Error('Query ended before completion')
    })()
    await sdk.session.sendMessage('test failed status')
    assert.equal(sdk.manager.getSession('s1').declaredStatus.decision, 'Keep')
  } finally { sdk.close() }
  for (const status of ['failed', 'interrupted']) {
    const codex = harness(CodexAppServerSession)
    try {
      codex.manager.setDeclaredStatus('s1', { state: 'blocked', summary: 'Keep', decision: 'Keep' })
      codex.session._activeTurn = { messageId: status, turnId: status, didStreamStart: false }
      codex.session._onNotification({ method: 'item/agentMessage/delta', params: { delta: footer('none') } })
      codex.session._onNotification({ method: 'turn/completed', params: { turn: { status, durationMs: 1, error: { message: 'Not completed' } } } })
      assert.equal(codex.manager.getSession('s1').declaredStatus.decision, 'Keep')
    } finally { codex.close() }
  }
})
