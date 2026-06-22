/**
 * Tests for the OpenAI-compatible shim (#5420) — the network glue that exposes
 * an OpenAI chat-completions endpoint behind an `@anthropic-ai/sdk`-shaped
 * `messages.stream(...)` surface.
 *
 * The `openai` package is MOCKED via mock.module so NO live API is hit: a
 * recorded array of OpenAI SSE chunks is fed back, and we assert the shim yields
 * the Anthropic SDK event sequence + assembles finalMessage correctly. The pure
 * translation is covered separately (anthropic-openai-translate.test.js); this
 * proves the glue (request build, iteration, finish flush, finalMessage, abort).
 *
 * Requires: --experimental-test-module-mocks flag (set in package.json).
 */
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

// Skip the whole suite if mock.module is unavailable (no flag / old Node).
if (typeof mock.module !== 'function') {
  describe('#5420 OpenAI-compatible shim', () => {
    it('skipped: mock.module not available (needs --experimental-test-module-mocks)', (t) => {
      t.skip('mock.module requires --experimental-test-module-mocks')
    })
  })
} else {
  // Capture the args the shim passes the OpenAI client + the chunks to replay.
  let capturedCtorArgs = null
  let capturedCreateArgs = null
  let chunksToReplay = []
  let throwOnCreate = null

  // Minimal OpenAI client stub. `chat.completions.create(request, opts)` returns
  // an async-iterable over the recorded chunks (mirrors the streaming client).
  class FakeOpenAI {
    constructor(args) {
      capturedCtorArgs = args
      this.chat = {
        completions: {
          create: async (request, opts) => {
            capturedCreateArgs = { request, opts }
            if (throwOnCreate) throw throwOnCreate
            return (async function* () {
              for (const c of chunksToReplay) {
                if (opts?.signal?.aborted) {
                  const err = new Error('aborted')
                  err.name = 'AbortError'
                  throw err
                }
                yield c
              }
            })()
          },
        },
      }
    }
  }

  // Mock the `openai` package BEFORE importing the shim. The shim does
  // `import OpenAI from 'openai'`, so the mocked module must provide a default.
  mock.module('openai', { defaultExport: FakeOpenAI })

  const { createAnthropicShimClient } = await import('../src/anthropic-openai-shim.js')

  // Drive a stream end-to-end: collect every yielded Anthropic event + the
  // finalMessage. Resets the captured state for the case.
  async function runShim(chunks, { params, signal } = {}) {
    chunksToReplay = chunks
    capturedCtorArgs = null
    capturedCreateArgs = null
    const client = createAnthropicShimClient({ baseURL: 'http://local/v1', apiKey: 'k' })
    const stream = client.messages.stream(
      params || { model: 'gpt-x', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      signal ? { signal } : {},
    )
    const events = []
    for await (const ev of stream) events.push(ev)
    const finalMessage = await stream.finalMessage()
    return { events, finalMessage }
  }

  describe('#5420 OpenAI-compatible shim', () => {
    it('constructs the OpenAI client with baseURL + apiKey', async () => {
      await runShim([{ id: 'm1', model: 'gpt-x', choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }])
      assert.deepEqual(capturedCtorArgs, { baseURL: 'http://local/v1', apiKey: 'k' })
    })

    it('translates Anthropic params to a streaming chat-completions request', async () => {
      await runShim([{ id: 'm1', choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }], {
        params: { model: 'gpt-x', max_tokens: 50, system: 'be terse', messages: [{ role: 'user', content: 'hi' }] },
      })
      const { request } = capturedCreateArgs
      assert.equal(request.model, 'gpt-x')
      assert.equal(request.max_tokens, 50)
      assert.equal(request.stream, true)
      assert.deepEqual(request.stream_options, { include_usage: true })
      // System prompt lifted to a leading system message by the translator.
      assert.deepEqual(request.messages[0], { role: 'system', content: 'be terse' })
      assert.deepEqual(request.messages[1], { role: 'user', content: 'hi' })
    })

    it('yields the Anthropic SDK event sequence for a text turn', async () => {
      const { events, finalMessage } = await runShim([
        { id: 'm1', model: 'gpt-x', choices: [{ delta: { role: 'assistant', content: '' } }] },
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ])
      const types = events.map((e) => e.type)
      assert.deepEqual(types, [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ])
      assert.equal(finalMessage.content[0].type, 'text')
      assert.equal(finalMessage.content[0].text, 'Hello world')
      assert.equal(finalMessage.stop_reason, 'end_turn')
      assert.deepEqual(finalMessage.usage, {
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      })
    })

    it('assembles a tool_use finalMessage from streamed tool-call deltas', async () => {
      const { events, finalMessage } = await runShim([
        { id: 'm2', model: 'gpt-x', choices: [{ delta: { role: 'assistant' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'grep', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"auth"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8 } },
      ])
      const types = events.map((e) => e.type)
      assert.ok(types.includes('content_block_start'))
      assert.ok(types.includes('content_block_delta'))
      assert.ok(types.includes('message_stop'))
      assert.equal(finalMessage.stop_reason, 'tool_use')
      assert.equal(finalMessage.content[0].type, 'tool_use')
      assert.equal(finalMessage.content[0].id, 'call_9')
      assert.equal(finalMessage.content[0].name, 'grep')
      assert.deepEqual(finalMessage.content[0].input, { q: 'auth' })
    })

    it('finalMessage() resolves even when iteration drains it first', async () => {
      // The byok loop fully iterates, THEN awaits finalMessage — assert that
      // ordering works (the assembled message is captured during finish()).
      const { finalMessage } = await runShim([
        { id: 'm3', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ])
      assert.ok(finalMessage)
      assert.equal(finalMessage.role, 'assistant')
    })

    it('propagates an aborted signal', async () => {
      const ac = new AbortController()
      ac.abort()
      await assert.rejects(
        () => runShim([{ id: 'm4', choices: [{ delta: { content: 'x' } }] }], { signal: ac.signal }),
        (err) => err.name === 'AbortError',
      )
    })

    it('propagates a create() failure (e.g. connection refused)', async () => {
      throwOnCreate = new Error('ECONNREFUSED')
      try {
        await assert.rejects(() => runShim([]), /ECONNREFUSED/)
      } finally {
        throwOnCreate = null
      }
    })
  })
}
