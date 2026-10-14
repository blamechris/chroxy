import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '../src/session-manager.js'
import { SdkSession } from '../src/sdk-session.js'
import { CliSession, buildClaudeCliArgs } from '../src/cli-session.js'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { checkpointHandlers } from '../src/handlers/checkpoint-handlers.js'
import { nsCtx, makeSessionIndexCtx } from './test-helpers.js'
import { updateModels, resetModels } from '../src/models.js'
const SONNET = 'claude-sonnet-5-5'
const RESUME = '11111111-2222-3333-4444-555555555555'
const dirs = [], managers = []
mock.method(SdkSession.prototype, 'start', () => {})
mock.method(CliSession.prototype, 'start', () => {})
function manager(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-continuation-'))
  dirs.push(dir)
  const m = new SessionManager({ skipPreflight: true, maxSessions: 20, defaultCwd: dir, stateFilePath: join(dir, 'state.json'), ...options })
  managers.push(m)
  return m
}
function context(m, checkpoint = {}) {
  const sent = []
  return nsCtx({
    ...makeSessionIndexCtx(), sessionManager: m,
    send: (_ws, msg) => sent.push(msg), broadcast: () => {},
    broadcastSessionList: () => {}, sendSessionInfo: () => {}, replayHistory: () => {},
    config: {}, checkpointManager: checkpoint, _sent: sent,
  })
}
function client(sid) { return { id: 'review-client', activeSessionId: sid, subscribedSessionIds: new Set() } }
after(() => {
  for (const m of managers) m.destroyAll()
  mock.restoreAll()
  resetModels()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
for (const provider of ['claude-sdk', 'claude-cli']) {
  test(`actual resume_conversation handler preserves upstream policy for omitted ${provider} model`, async () => {
    const m = manager({ providerType: provider })
    const originalId = m.createSession({ model: null })
    const original = m.getSession(originalId).session
    const ctx = context(m), c = client(originalId)
    await conversationHandlers.resume_conversation({}, c, { conversationId: RESUME }, ctx)
    assert.equal(ctx._sent.some(msg => msg.type === 'session_error'), false)
    assert.notEqual(c.activeSessionId, originalId)
    const resumed = m.getSession(c.activeSessionId).session
    assert.equal(original.model, null)
    assert.equal(resumed.resumeSessionId, RESUME)
    assert.equal(resumed.model, null)
    const argv = buildClaudeCliArgs({ model: resumed.model, resumeSessionId: resumed.resumeSessionId })
    assert.equal(argv.includes('--model'), false, 'resume must not force a new model')
    assert.equal(argv[argv.indexOf('--resume') + 1], RESUME)
  })
}
for (const mode of ['conversation', 'both']) {
  for (const fork of mode === 'conversation' ? [true] : [true, false]) {
    test(`actual checkpoint ${mode} fork=${fork} handler preserves upstream policy for forked conversation`, async () => {
      const m = manager()
      const originalId = m.createSession({ model: 'claude-haiku-5-5' })
      const original = m.getSession(originalId).session
      mock.method(original, 'forkConversation', async () => fork ? RESUME : null)
      const cp = { id: 'review-cp', cwd: original.cwd, name: 'Review', resumeSessionId: RESUME, boundaryMessageId: 'boundary' }
      const ctx = context(m, { getCheckpoint: () => cp, restoreCheckpoint: async () => cp })
      const c = client(originalId)
      await checkpointHandlers.restore_checkpoint({}, c, { checkpointId: cp.id, mode }, ctx)
      assert.equal(ctx._sent.some(msg => msg.type === 'session_error'), false)
      const result = ctx._sent.find(msg => msg.type === 'checkpoint_restored')
      assert.equal(result.filesOnly, !fork)
      const rewound = m.getSession(result.newSessionId).session
      assert.equal(original.model, 'claude-haiku-5-5')
      assert.equal(rewound.resumeSessionId, RESUME)
      assert.equal(rewound.model, null)
    })
  }
}
test('ordinary creation and explicit null/model/restore controls use intended current behavior', () => {
  updateModels([{ value: 'default', displayName: 'Default (Fable 5.1)' }])
  const m = manager()
  assert.equal(m.getSession(m.createSession()).session.model, SONNET)
  assert.equal(m.getSession(m.createSession({ model: null })).session.model, null)
  assert.equal(m.getSession(m.createSession({ model: 'default' })).session.model, 'default')
  assert.equal(m.getSession(m.createSession({ model: 'claude-fable-5-1' })).session.model, 'claude-fable-5-1')
  assert.equal(m.getSession(m.createSession({ isRestore: true, resumeSessionId: RESUME })).session.model, null)
  const restored = m.getSession(m.createSession({ isRestore: true, model: null, bootedModel: 'claude-fable-5-1', resumeSessionId: RESUME })).session
  assert.equal(restored.model, null)
  assert.equal(restored.bootedModel, 'claude-fable-5-1')
  const configured = manager({ defaultModel: 'claude-haiku-5-5' })
  assert.equal(configured.getSession(configured.createSession()).session.model, 'claude-haiku-5-5')
})
test('effective preserve identity excludes fresh pin; invalid/colliding identity stays fresh', () => {
  const m = manager()
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const preserved = m.getSession(m.createSession({ preserveId: id })).session
  assert.equal(preserved.model, null)
  assert.equal(m.getSession(m.createSession({ preserveId: 'bad' })).session.model, SONNET)
  assert.equal(m.getSession(m.createSession({ preserveId: id })).session.model, SONNET)
  assert.equal(m.getSession(m.createSession({ resumeSessionId: '' })).session.model, SONNET)
  assert.equal(m.getSession(m.createSession({ resumeSessionId: RESUME, model: 'claude-fable-5-1' })).session.model, 'claude-fable-5-1')
  const configured = manager({ defaultModel: 'claude-haiku-5-5' })
  assert.equal(configured.getSession(configured.createSession({ resumeSessionId: RESUME })).session.model, 'claude-haiku-5-5')
})
