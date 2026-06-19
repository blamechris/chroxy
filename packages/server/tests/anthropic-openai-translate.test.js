import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicRequestToOpenAi,
  createStreamTranslator,
  mapFinishReason,
  mapUsage,
} from '../src/anthropic-openai-translate.js'
import { translateSdkEvent } from '../src/byok-event-translator.js'

// Drive a chunk sequence through the translator; return ALL emitted Anthropic
// SDK events (push events + finish events) and the final Message.
function run(chunks) {
  const tr = createStreamTranslator()
  const events = []
  for (const c of chunks) events.push(...tr.push(c))
  const { events: tail, finalMessage } = tr.finish()
  events.push(...tail)
  return { events, finalMessage }
}

// Map emitted events through the REAL byok translator → the kinds the session
// consumes. This proves the shim's output satisfies byok-event-translator's
// contract end-to-end.
function kinds(events) {
  return events.map(translateSdkEvent).filter(Boolean).map((e) => e.kind)
}

describe('#5420 anthropicRequestToOpenAi', () => {
  it('lifts the system prompt to a leading system message', () => {
    const out = anthropicRequestToOpenAi({ model: 'gpt-x', max_tokens: 100, system: 'be terse', messages: [] })
    assert.deepEqual(out.messages[0], { role: 'system', content: 'be terse' })
    assert.equal(out.model, 'gpt-x')
    assert.equal(out.max_tokens, 100)
  })

  it('passes through a plain string user message', () => {
    const out = anthropicRequestToOpenAi({ messages: [{ role: 'user', content: 'hi' }] })
    assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }])
  })

  it('translates a tool_result block to an OpenAI tool message', () => {
    const out = anthropicRequestToOpenAi({
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result text' }] }],
    })
    assert.deepEqual(out.messages, [{ role: 'tool', tool_call_id: 'call_1', content: 'result text' }])
  })

  it('keeps sibling text alongside tool_result as a following user message (#6128)', () => {
    const out = anthropicRequestToOpenAi({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'done' },
            { type: 'text', text: 'Now summarise. Do not call tools.' },
          ],
        },
      ],
    })
    assert.deepEqual(out.messages, [
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      { role: 'user', content: 'Now summarise. Do not call tools.' },
    ])
  })

  it('translates an assistant tool_use block to OpenAI tool_calls', () => {
    const out = anthropicRequestToOpenAi({
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'grep', input: { q: 'x' } }] }],
    })
    assert.equal(out.messages[0].role, 'assistant')
    assert.deepEqual(out.messages[0].tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"q":"x"}' } },
    ])
  })

  it('maps tools (input_schema → parameters) and tool_choice', () => {
    const out = anthropicRequestToOpenAi({
      messages: [],
      tools: [{ name: 'grep', description: 'search', input_schema: { type: 'object', properties: { q: {} } } }],
      tool_choice: { type: 'any' },
    })
    assert.deepEqual(out.tools[0], {
      type: 'function',
      function: { name: 'grep', description: 'search', parameters: { type: 'object', properties: { q: {} } } },
    })
    assert.equal(out.tool_choice, 'required')
  })

  it('maps tool_choice {type:tool,name} to a function choice', () => {
    const out = anthropicRequestToOpenAi({ messages: [], tool_choice: { type: 'tool', name: 'grep' } })
    assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'grep' } })
  })
})

describe('#5420 createStreamTranslator — text stream', () => {
  it('emits the Anthropic event sequence + final message for a text turn', () => {
    const { events, finalMessage } = run([
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
    // Through the real byok translator:
    assert.deepEqual(kinds(events), ['stream_start', 'stream_delta', 'stream_delta', 'content_block_stop', 'message_delta', 'result'])
    assert.deepEqual(finalMessage.content, [{ type: 'text', text: 'Hello world' }])
    assert.equal(finalMessage.stop_reason, 'end_turn')
    assert.deepEqual(finalMessage.usage, {
      input_tokens: 12,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })
})

describe('#5420 createStreamTranslator — tool call stream', () => {
  it('accumulates a tool_call into a tool_use block with parsed input', () => {
    const { events, finalMessage } = run([
      { id: 'm2', model: 'gpt-x', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'grep', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"auth"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8 } },
    ])
    // The tool block opens, streams JSON fragments, closes.
    assert.deepEqual(kinds(events), [
      'stream_start',
      'tool_start',
      'tool_input_delta',
      'tool_input_delta',
      'content_block_stop',
      'message_delta',
      'result',
    ])
    const toolStart = events.map(translateSdkEvent).find((e) => e?.kind === 'tool_start')
    assert.equal(toolStart.toolName, 'grep')
    assert.equal(toolStart.toolUseId, 'call_9')
    // Final message carries the parsed tool_use block + tool_use stop reason.
    assert.deepEqual(finalMessage.content, [{ type: 'tool_use', id: 'call_9', name: 'grep', input: { q: 'auth' } }])
    assert.equal(finalMessage.stop_reason, 'tool_use')
  })

  it('handles two parallel tool calls as two tool_use blocks', () => {
    const { finalMessage } = run([
      { id: 'm3', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f1', arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'f2', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    assert.equal(finalMessage.content.length, 2)
    assert.deepEqual(finalMessage.content.map((b) => b.name), ['f1', 'f2'])
  })
})

describe('#5420 createStreamTranslator — mixed text then tool', () => {
  it('closes the text block before opening the tool block', () => {
    const { events, finalMessage } = run([
      { id: 'm4', choices: [{ delta: { content: 'let me check' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'grep', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const types = events.map((e) => e.type)
    // text block_start+delta, then its block_stop BEFORE the tool block_start.
    const textStop = types.indexOf('content_block_stop')
    const toolStart = types.findIndex(
      (t, i) => t === 'content_block_start' && events[i].content_block?.type === 'tool_use',
    )
    assert.ok(textStop > -1 && toolStart > -1 && textStop < toolStart, 'text block closes before tool opens')
    assert.deepEqual(finalMessage.content.map((b) => b.type), ['text', 'tool_use'])
  })
})

describe('#5420 mapFinishReason / mapUsage', () => {
  it('maps finish reasons', () => {
    assert.equal(mapFinishReason('stop'), 'end_turn')
    assert.equal(mapFinishReason('tool_calls'), 'tool_use')
    assert.equal(mapFinishReason('length'), 'max_tokens')
    assert.equal(mapFinishReason(null), null)
  })

  it('maps usage incl. cached prompt tokens, defaulting missing fields', () => {
    assert.deepEqual(mapUsage({ prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } }), {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 0,
    })
    assert.deepEqual(mapUsage(undefined), {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })
})
