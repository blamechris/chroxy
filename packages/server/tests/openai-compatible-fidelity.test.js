/**
 * Mock-endpoint fidelity suite for the OpenAI-compatible provider (#6251).
 *
 * The sibling tests (anthropic-openai-translate / -shim) exercise the translator
 * + shim with a MOCKED `openai` package — they never touch the real SDK's HTTP
 * + SSE-parsing path. This suite closes that gap WITHOUT a live endpoint: it
 * stands up a real in-process mock chat-completions server, points the shim's
 * actual `openai` client at it, and drives the full wire round-trip
 *   shim → real openai SDK → HTTP → SSE → translator → Anthropic events.
 *
 * It pins the fidelity dimensions a live-endpoint spike (LM Studio / OpenRouter /
 * vLLM, #6251) would check — streaming text, usage, finish_reason → stop_reason,
 * streamed tool_calls, the forwarded request shape, and AbortSignal cancellation
 * — so the manual spike only has to confirm a real server matches these shapes.
 *
 * No network beyond 127.0.0.1; no live endpoint required.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createAnthropicShimClient } from '../src/anthropic-openai-shim.js'

const ID = 'chatcmpl-mock'
const MODEL = 'mock-model'
const PARAMS = { model: 'ignored-by-mock', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }

// OpenAI chat-completion stream-chunk builders.
const text = (content) => ({ id: ID, model: MODEL, choices: [{ index: 0, delta: { content }, finish_reason: null }] })
const tool = (tool_calls) => ({ id: ID, model: MODEL, choices: [{ index: 0, delta: { tool_calls }, finish_reason: null }] })
const final = (finish_reason, usage = {}) => ({ id: ID, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason }], usage })

/**
 * Stand up a mock OpenAI-compatible endpoint. `respond({ body, write, done, res })`
 * shapes the SSE response: `write(obj)` emits one `data:` chunk, `done()` writes
 * `[DONE]` + ends. The last parsed request body is captured for assertions.
 */
async function startMock(respond) {
  let lastBody = null
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (d) => { buf += d })
    req.on('end', async () => {
      try { lastBody = buf ? JSON.parse(buf) : null } catch { lastBody = buf }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const write = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* connection gone */ } }
      const done = () => { try { res.write('data: [DONE]\n\n'); res.end() } catch { /* connection gone */ } }
      try {
        await respond({ body: lastBody, write, done, res })
      } catch {
        try { res.end() } catch { /* already ended */ }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    getLastBody: () => lastBody,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Drive the shim against a fixed chunk script; collect the translated events,
// the assembled final Message, and the request the endpoint received.
async function drive(scriptChunks, { params = PARAMS, opts = {} } = {}) {
  const mock = await startMock(async ({ write, done }) => {
    for (const c of scriptChunks) write(c)
    done()
  })
  try {
    const client = createAnthropicShimClient({ baseURL: mock.baseURL, apiKey: 'sk-mock' })
    const stream = client.messages.stream(params, opts)
    const events = []
    for await (const ev of stream) events.push(ev)
    const finalMessage = await stream.finalMessage()
    return { events, finalMessage, lastBody: mock.getLastBody() }
  } finally {
    await mock.close()
  }
}

describe('openai-compatible provider — mock-endpoint fidelity (#6251)', () => {
  it('streams text through the real openai SDK and translates to Anthropic events', async () => {
    const { events, finalMessage } = await drive([text('Hello'), text(' world'), final('stop', { prompt_tokens: 10, completion_tokens: 5 })])
    const types = events.map((e) => e.type)
    assert.equal(types[0], 'message_start', 'first event is message_start')
    assert.ok(types.includes('content_block_start'), 'opens a content block')
    assert.ok(types.includes('content_block_stop'), 'closes the content block')
    assert.equal(types.at(-1), 'message_stop', 'last event is message_stop')

    const streamedText = events
      .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta')
      .map((e) => e.delta.text)
      .join('')
    assert.equal(streamedText, 'Hello world', 'text deltas reassemble in order')

    assert.deepEqual(finalMessage.content, [{ type: 'text', text: 'Hello world' }])
    assert.equal(finalMessage.stop_reason, 'end_turn')
    assert.equal(finalMessage.model, MODEL, 'model echoed from the chunk')
    assert.equal(finalMessage.id, ID, 'id echoed from the chunk')
    assert.equal(finalMessage.role, 'assistant')
  })

  it('maps OpenAI usage to Anthropic usage (cached_tokens -> cache_read_input_tokens)', async () => {
    const { finalMessage } = await drive([
      text('x'),
      final('stop', { prompt_tokens: 100, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 30 } }),
    ])
    assert.deepEqual(finalMessage.usage, {
      input_tokens: 100,
      output_tokens: 42,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    })
  })

  for (const [finishReason, stopReason] of [['stop', 'end_turn'], ['length', 'max_tokens'], ['tool_calls', 'tool_use']]) {
    it(`maps finish_reason "${finishReason}" -> stop_reason "${stopReason}"`, async () => {
      const { finalMessage } = await drive([text('hi'), final(finishReason)])
      assert.equal(finalMessage.stop_reason, stopReason)
    })
  }

  it('infers tool_use stop_reason when the server omits finish_reason but emits tool_calls', async () => {
    const { finalMessage } = await drive([
      tool([{ index: 0, id: 'call_x', function: { name: 'noop', arguments: '{}' } }]),
      final(null),
    ])
    assert.equal(finalMessage.stop_reason, 'tool_use')
  })

  it('translates streamed tool_calls (id/name/args split across chunks) into a tool_use block', async () => {
    const { events, finalMessage } = await drive([
      tool([{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }]),
      tool([{ index: 0, function: { arguments: '"SF"}' } }]),
      final('tool_calls'),
    ])
    const start = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
    assert.ok(start, 'emits a tool_use content_block_start')
    assert.equal(start.content_block.id, 'call_1')
    assert.equal(start.content_block.name, 'get_weather')

    const argDeltas = events
      .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
      .map((e) => e.delta.partial_json)
      .join('')
    assert.equal(argDeltas, '{"city":"SF"}', 'tool-arg JSON streams as input_json_delta')

    const toolUse = finalMessage.content.find((b) => b.type === 'tool_use')
    assert.ok(toolUse, 'final message carries a tool_use block')
    assert.equal(toolUse.id, 'call_1')
    assert.equal(toolUse.name, 'get_weather')
    assert.deepEqual(toolUse.input, { city: 'SF' }, 'tool args parse to the input object')
    assert.equal(finalMessage.stop_reason, 'tool_use')
  })

  it('forwards a correctly-translated streaming request to the endpoint', async () => {
    const { lastBody } = await drive([text('x'), final('stop')])
    assert.equal(lastBody.stream, true, 'streaming requested')
    assert.deepEqual(lastBody.stream_options, { include_usage: true }, 'usage requested on the final chunk')
    assert.equal(lastBody.max_tokens, 64, 'max_tokens forwarded')
    assert.ok(Array.isArray(lastBody.messages) && lastBody.messages.length >= 1, 'messages forwarded')
  })

  it('cancels the in-flight request cleanly via AbortSignal (closes the upstream connection)', async () => {
    let serverSawClose = false
    let chunksWritten = 0
    const TOTAL = 30
    const mock = await startMock(async ({ write, res }) => {
      res.on('close', () => { serverSawClose = true })
      write(text('Hello')); chunksWritten++
      // Drip slowly so the client is mid-stream when the abort fires; stop the
      // moment the client closes the connection so the server doesn't dangle.
      for (let i = 0; i < TOTAL && !serverSawClose; i++) {
        await new Promise((r) => setTimeout(r, 50))
        if (!serverSawClose) { write(text('.')); chunksWritten++ }
      }
    })
    try {
      const ac = new AbortController()
      const client = createAnthropicShimClient({ baseURL: mock.baseURL, apiKey: 'sk-mock' })
      const stream = client.messages.stream(PARAMS, { signal: ac.signal })
      let threw = null
      try {
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta') ac.abort()
        }
      } catch (err) {
        threw = err
      }
      // Let the connection-close propagate to the server side.
      await new Promise((r) => setTimeout(r, 150))
      // The contract for a clean cancel: it reaches the network — the upstream
      // sees the connection close and the stream stops well before the script
      // finishes (vs. silently draining all TOTAL chunks). The SDK may surface
      // the abort as a rejection OR end the iterator early; both are fine, so
      // the error check is lenient.
      assert.ok(serverSawClose, 'abort should close the upstream connection')
      assert.ok(chunksWritten < TOTAL, `abort should stop the stream early (wrote ${chunksWritten}/${TOTAL})`)
      if (threw) {
        assert.match(`${threw.name} ${threw.message}`, /[Aa]bort/, 'any rejection should be an abort error')
      }
    } finally {
      await mock.close()
    }
  })
})
