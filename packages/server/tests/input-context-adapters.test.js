import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { InputSchema } from '@chroxy/protocol/schemas'
import { buildInputMessage } from '@chroxy/protocol'
import { inputHandlers } from '../src/handlers/input-handlers.js'
import { createSpy, nsCtx } from './test-helpers.js'

const root = mkdtempSync(join(tmpdir(), 'chroxy-context-adapters-'))
after(() => rmSync(root, { recursive: true, force: true }))

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
})
