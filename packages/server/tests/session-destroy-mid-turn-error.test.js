import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { ClaudeByokSession } from '../src/byok-session.js'

/**
 * A session destroyed mid-turn: SessionManager.destroySession adds a no-op
 * 'error' listener, then the provider's destroy() ends in removeAllListeners().
 * The aborted turn emits 'error' afterwards; with no listener that throws
 * ERR_UNHANDLED_ERROR out of the turn.
 */

const tmp = mkdtempSync(join(tmpdir(), 'chroxy-destroy-mid-turn-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

describe('destroying a BYOK session mid-turn', () => {
  it('the aborted turn does not surface an unhandled error', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp', stateFilePath: join(tmp, 'state.json') })
    let started
    const streamStarted = new Promise((r) => { started = r })
    session._client = {
      messages: {
        stream: (_body, { signal }) => ({
          async *[Symbol.asyncIterator]() {
            started()
            // Rejects only after the abort, like the real SDK stream.
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
            throw new APIUserAbortError()
          },
          async finalMessage() { throw new APIUserAbortError() },
        }),
      },
    }
    await session.start()
    const turn = session.sendMessage('go')
    await streamStarted
    // What SessionManager.destroySession does before provider destroy().
    session.removeAllListeners()
    session.on('error', () => {})
    await session.destroy()
    await assert.doesNotReject(turn)
    assert.equal(session.listenerCount('error') > 0, true, 'an error listener survives teardown')
  })
})
