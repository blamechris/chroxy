import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { GeminiSession } from '../src/gemini-session.js'
import { createAcpSessionClass } from '../src/acp-session.js'
import { OUTGOING_QUEUE_MAX } from '../src/base-session.js'
import { InputSchema } from '@chroxy/protocol/schemas'
import { buildInputMessage } from '@chroxy/protocol'
import { inputHandlers } from '../src/handlers/input-handlers.js'
import { createSpy, nsCtx } from './test-helpers.js'

const root = mkdtempSync(join(tmpdir(), 'chroxy-context-adapters-'))
after(() => rmSync(root, { recursive: true, force: true }))

function contextMessage(clientMessageId) {
  return InputSchema.parse(buildInputMessage({
    input: 'compare',
    clientMessageId,
    sessionId: 's1',
    context: {
      version: 1,
      items: [{
        id: 'context-1', kind: 'text', provenance: { source: 'clipboard' },
        mediaType: 'text/plain', sizeBytes: 8, lifetime: 'one_turn',
        content: { type: 'text', text: 'selected' },
      }],
    },
  }))
}

async function dispatchTo(session, msg, { primaryClientId = null } = {}) {
  const sent = []
  const recordUserInput = createSpy()
  const inputDedupRecords = new Map()
  const sessions = new Map([['s1', { session, cwd: root, name: 'S' }]])
  const ctx = nsCtx({
    send: createSpy((_ws, value) => sent.push(value)),
    broadcast: createSpy(), broadcastToSession: createSpy(), updatePrimary: createSpy(),
    getPrimary: () => primaryClientId,
    sessionManager: {
      getSession: (id) => sessions.get(id), isBudgetPaused: () => false,
      recordUserInput, touchActivity: () => {}, getHistoryCount: () => 0,
    },
    checkpointManager: { createCheckpoint: async () => {} },
    inputDedupRecords,
  })
  await inputHandlers.input({}, { id: 'client-1', activeSessionId: 's1' }, msg, ctx)
  return { sent, recordUserInput, inputDedupRecords }
}

describe('selected context reaches concrete Claude/Codex adapters (#7822)', () => {
  it('preserves identical text, provenance, media type, and image bytes', async () => {
    const bytes = Buffer.from('context-image-bytes')
    const context = {
      version: 1,
      items: [
        {
          id: 'ocr-1', kind: 'text', provenance: { source: 'ocr', label: 'Window selection' },
          mediaType: 'text/plain', sizeBytes: 8, lifetime: 'one_turn',
          content: { type: 'text', text: 'selected' },
        },
        {
          id: 'image-1', kind: 'image', provenance: { source: 'device', label: 'Screen region' },
          mediaType: 'image/png', sizeBytes: bytes.length, lifetime: 'one_turn',
          content: { type: 'base64', data: bytes.toString('base64') },
        },
      ],
    }
    function deliver(session, sessionId, clientMessageId) {
      const sessions = new Map([[sessionId, { session, cwd: root, name: sessionId }]])
      const ctx = nsCtx({
        send: createSpy(), broadcast: createSpy(), broadcastToSession: createSpy(),
        updatePrimary: createSpy(), getPrimary: () => null,
        sessionManager: {
          getSession: (id) => sessions.get(id), isBudgetPaused: () => false,
          recordUserInput: () => {}, touchActivity: () => {}, getHistoryCount: () => 0,
        },
        checkpointManager: { createCheckpoint: async () => {} },
        inputDedupRecords: new Map(),
      })
      const wire = InputSchema.parse(buildInputMessage({
        input: 'compare', clientMessageId, sessionId, context,
      }))
      return inputHandlers.input({}, { id: `client-${sessionId}`, activeSessionId: sessionId }, wire, ctx)
    }

    const claude = new SdkSession({ cwd: root, skillsDir: root, repoSkillsDir: null })
    claude._processReady = true
    let claudeArgs
    claude._callQuery = (args) => {
      claudeArgs = args
      return (async function* () {
        yield { type: 'result', session_id: 'claude-1', total_cost_usd: 0, duration_ms: 0, usage: {} }
      })()
    }
    await deliver(claude, 'claude-session', 'claude-request')

    const codex = new CodexAppServerSession({ cwd: root, skillsDir: root, repoSkillsDir: null })
    codex._processReady = true
    codex._threadId = 'thread-1'
    let codexParams
    codex._client = { request: async (_method, params) => { codexParams = params; return { turn: { id: 'turn-1' } } } }
    await deliver(codex, 'codex-session', 'codex-request')

    const claudeText = claudeArgs.prompt.find((item) => item.type === 'text').text
    const claudeImage = claudeArgs.prompt.find((item) => item.type === 'image')
    const codexText = codexParams.input.find((item) => item.type === 'text').text
    const codexImage = codexParams.input.find((item) => item.type === 'localImage')
    assert.equal(claudeText, codexText, 'both adapters receive one canonical provenance-bearing prompt')
    assert.ok(claudeText.includes('source="ocr"') && claudeText.includes('source="device"'))
    assert.equal(claudeImage.source.media_type, 'image/png')
    assert.deepEqual(Buffer.from(claudeImage.source.data, 'base64'), bytes)
    assert.deepEqual(readFileSync(codexImage.path), bytes)

    // The fixture's async generator does not implement the SDK query object's
    // optional interrupt method; clear it before exercising normal teardown.
    claude._query = null
    claude.destroy()
    await codex.destroy()
  })

  it('rejects context when a real SDK session queue is full instead of claiming queued admission', async () => {
    const session = new SdkSession({ cwd: root, skillsDir: root, repoSkillsDir: null })
    session._isBusy = true
    const errors = []
    session.on('error', (error) => errors.push(error))
    for (let i = 0; i < OUTGOING_QUEUE_MAX; i++) {
      assert.equal(session.enqueueOutgoingMessage({ prompt: `queued-${i}` }), true)
    }

    const { sent, recordUserInput, inputDedupRecords } = await dispatchTo(session, contextMessage('sdk-full-queue'), {
      primaryClientId: 'client-1',
    })
    const ack = sent.filter((value) => value.type === 'input_ack').at(-1)
    assert.equal(session.outgoingQueueLength, OUTGOING_QUEUE_MAX)
    assert.equal(errors.at(-1)?.code, 'queue_full')
    assert.equal(ack.status, 'rejected')
    assert.equal(ack.delivery, 'not_dispatched')
    assert.equal(ack.reason, 'queue_full')
    assert.equal(ack.retrySafe, true)
    assert.equal(ack.context, undefined, 'discarded context must not be described as accepted')
    assert.equal(recordUserInput.callCount, 0, 'discarded input must not create a history entry')
    assert.equal(inputDedupRecords.has('s1'), false, 'known rejection must not suppress a safe retry')
    session.destroy()
  })

  it('rejects context when a real TUI session is busy instead of inventing an outgoing queue', async () => {
    const session = new ClaudeTuiSession({ cwd: root, skillsDir: root, repoSkillsDir: null })
    session._processReady = true
    session._term = { write() {}, kill() {} }
    session._isBusy = true
    const errors = []
    session.on('error', (error) => errors.push(error))

    const { sent, recordUserInput, inputDedupRecords } = await dispatchTo(session, contextMessage('tui-busy'), {
      primaryClientId: 'client-1',
    })
    const ack = sent.filter((value) => value.type === 'input_ack').at(-1)
    assert.match(errors.at(-1)?.message, /Already processing/)
    assert.equal(session.outgoingQueueLength, 0)
    assert.equal(ack.status, 'rejected')
    assert.equal(ack.delivery, 'not_dispatched')
    assert.equal(ack.reason, 'busy')
    assert.equal(ack.retrySafe, true)
    assert.equal(ack.context, undefined, 'rejected context must remain pending on the client')
    assert.equal(recordUserInput.callCount, 0, 'rejected input must not create a history entry')
    assert.equal(inputDedupRecords.has('s1'), false, 'known rejection must remain retryable')
    await session.destroy()
  })

  it('rejects context when a real TUI session is not runnable without recording history', async () => {
    const session = new ClaudeTuiSession({ cwd: root, skillsDir: root, repoSkillsDir: null })
    const errors = []
    session.on('error', (error) => errors.push(error))

    const { sent, recordUserInput, inputDedupRecords } = await dispatchTo(session, contextMessage('tui-not-runnable'))
    const ack = sent.filter((value) => value.type === 'input_ack').at(-1)
    assert.match(errors.at(-1)?.message, /not started|no longer alive/i)
    assert.equal(ack.status, 'rejected')
    assert.equal(ack.delivery, 'not_dispatched')
    assert.equal(ack.reason, 'not_runnable')
    assert.equal(ack.context, undefined)
    assert.equal(recordUserInput.callCount, 0)
    assert.equal(inputDedupRecords.has('s1'), false)
    await session.destroy()
  })

  it('rejects image context on a real attachment-unsupported adapter without recording history', async () => {
    const session = new GeminiSession({ cwd: root, skillsDir: root, repoSkillsDir: null })
    session._processReady = true
    const errors = []
    session.on('error', (error) => errors.push(error))
    const msg = contextMessage('unsupported-attachment')
    msg.context.items = [{
      id: 'image-1', kind: 'image', provenance: { source: 'device' },
      mediaType: 'image/png', sizeBytes: 3, lifetime: 'one_turn',
      content: { type: 'base64', data: 'YWJj' },
    }]

    const { sent, recordUserInput, inputDedupRecords } = await dispatchTo(session, msg)
    const ack = sent.filter((value) => value.type === 'input_ack').at(-1)
    assert.match(errors.at(-1)?.message, /does not support attachments/i)
    assert.equal(ack.status, 'rejected')
    assert.equal(ack.delivery, 'not_dispatched')
    assert.equal(ack.reason, 'unsupported_attachments')
    assert.equal(ack.context, undefined)
    assert.equal(recordUserInput.callCount, 0)
    assert.equal(inputDedupRecords.has('s1'), false)
    session.destroy()
  })

  it('rejects image context on a persistent attachment-unsupported adapter without recording history', async () => {
    const AcpSession = createAcpSessionClass({
      id: 'context-acp-fixture', label: 'Context fixture', command: process.execPath, args: [], env: {},
    })
    const session = new AcpSession({ cwd: root, skillsDir: root, repoSkillsDir: null })
    session._processReady = true
    session._connection = {}
    const errors = []
    session.on('error', (error) => errors.push(error))
    const msg = contextMessage('unsupported-acp-attachment')
    msg.context.items = [{
      id: 'image-1', kind: 'image', provenance: { source: 'device' },
      mediaType: 'image/png', sizeBytes: 3, lifetime: 'one_turn',
      content: { type: 'base64', data: 'YWJj' },
    }]

    const { sent, recordUserInput, inputDedupRecords } = await dispatchTo(session, msg)
    const ack = sent.filter((value) => value.type === 'input_ack').at(-1)
    assert.match(errors.at(-1)?.message, /does not support attachments/i)
    assert.equal(ack.status, 'rejected')
    assert.equal(ack.delivery, 'not_dispatched')
    assert.equal(ack.reason, 'unsupported_attachments')
    assert.equal(ack.context, undefined)
    assert.equal(recordUserInput.callCount, 0)
    assert.equal(inputDedupRecords.has('s1'), false)
    await session.destroy()
  })
})
