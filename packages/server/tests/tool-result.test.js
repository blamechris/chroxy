import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { emitToolResults, MAX_TOOL_RESULT_SIZE } from '../src/tool-result.js'

describe('emitToolResults', () => {
  it('emits tool_result for string content', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file created' },
    ], emitter)

    assert.equal(results.length, 1)
    assert.equal(results[0].toolUseId, 'tu_1')
    assert.equal(results[0].result, 'file created')
    assert.equal(results[0].truncated, false)
  })

  it('emits tool_result for array content with text blocks', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      {
        type: 'tool_result',
        tool_use_id: 'tu_2',
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'image', source: {} },
          { type: 'text', text: 'line 2' },
        ],
      },
    ], emitter)

    assert.equal(results.length, 1)
    assert.equal(results[0].result, 'line 1\nline 2')
    assert.equal(results[0].truncated, false)
  })

  it('truncates results exceeding maxSize', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    const longContent = 'x'.repeat(200)
    emitToolResults([
      { type: 'tool_result', tool_use_id: 'tu_3', content: longContent },
    ], emitter, 100)

    assert.equal(results.length, 1)
    assert.equal(results[0].result.length, 100)
    assert.equal(results[0].truncated, true)
  })

  it('uses default MAX_TOOL_RESULT_SIZE when no maxSize provided', () => {
    assert.equal(typeof MAX_TOOL_RESULT_SIZE, 'number')
    assert.equal(MAX_TOOL_RESULT_SIZE, 10240)

    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    // Content just under the default limit — should not truncate
    const content = 'x'.repeat(MAX_TOOL_RESULT_SIZE)
    emitToolResults([
      { type: 'tool_result', tool_use_id: 'tu_def', content },
    ], emitter)

    assert.equal(results[0].truncated, false)
    assert.equal(results[0].result.length, MAX_TOOL_RESULT_SIZE)
  })

  it('skips blocks without tool_use_id', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      { type: 'tool_result', content: 'no id' },
    ], emitter)

    assert.equal(results.length, 0)
  })

  it('skips non-tool_result blocks', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tu_4', name: 'Bash' },
    ], emitter)

    assert.equal(results.length, 0)
  })

  it('handles non-array input gracefully', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults(null, emitter)
    emitToolResults(undefined, emitter)
    emitToolResults('string', emitter)

    assert.equal(results.length, 0)
  })

  it('processes multiple tool_result blocks', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      { type: 'tool_result', tool_use_id: 'tu_a', content: 'result a' },
      { type: 'text', text: 'interleaved' },
      { type: 'tool_result', tool_use_id: 'tu_b', content: 'result b' },
    ], emitter)

    assert.equal(results.length, 2)
    assert.equal(results[0].toolUseId, 'tu_a')
    assert.equal(results[1].toolUseId, 'tu_b')
  })
})
