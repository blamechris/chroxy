import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { emitToolResults, MAX_TOOL_RESULT_SIZE, MAX_TOOL_IMAGE_SIZE } from '../src/tool-result.js'

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

  it('extracts image blocks from content array', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      {
        type: 'tool_result',
        tool_use_id: 'tu_img',
        content: [
          { type: 'text', text: 'screenshot taken' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
          },
        ],
      },
    ], emitter)

    assert.equal(results.length, 1)
    assert.equal(results[0].result, 'screenshot taken')
    assert.equal(results[0].images.length, 1)
    assert.equal(results[0].images[0].mediaType, 'image/png')
    assert.equal(results[0].images[0].data, 'iVBORw0KGgo=')
  })

  it('extracts multiple images from a single tool result', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      {
        type: 'tool_result',
        tool_use_id: 'tu_multi',
        content: [
          { type: 'image', source: { media_type: 'image/png', data: 'aaa=' } },
          { type: 'image', source: { media_type: 'image/jpeg', data: 'bbb=' } },
        ],
      },
    ], emitter)

    assert.equal(results.length, 1)
    assert.equal(results[0].images.length, 2)
    assert.equal(results[0].images[0].mediaType, 'image/png')
    assert.equal(results[0].images[1].mediaType, 'image/jpeg')
  })

  it('skips images with disallowed media types', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      {
        type: 'tool_result',
        tool_use_id: 'tu_bad',
        content: [
          { type: 'image', source: { media_type: 'image/svg+xml', data: '<svg/>' } },
          { type: 'image', source: { media_type: 'image/png', data: 'ok=' } },
        ],
      },
    ], emitter)

    assert.equal(results.length, 1)
    assert.equal(results[0].images.length, 1)
    assert.equal(results[0].images[0].mediaType, 'image/png')
  })

  it('skips images exceeding MAX_TOOL_IMAGE_SIZE', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    const bigData = 'x'.repeat(MAX_TOOL_IMAGE_SIZE + 1)
    emitToolResults([
      {
        type: 'tool_result',
        tool_use_id: 'tu_big',
        content: [
          { type: 'image', source: { media_type: 'image/png', data: bigData } },
          { type: 'image', source: { media_type: 'image/png', data: 'small=' } },
        ],
      },
    ], emitter)

    assert.equal(results.length, 1)
    assert.equal(results[0].images.length, 1)
    assert.equal(results[0].images[0].data, 'small=')
  })

  it('omits images field when no valid images found', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      {
        type: 'tool_result',
        tool_use_id: 'tu_noimg',
        content: [
          { type: 'text', text: 'just text' },
          { type: 'image', source: {} },
        ],
      },
    ], emitter)

    assert.equal(results.length, 1)
    assert.equal(results[0].result, 'just text')
    assert.equal(results[0].images, undefined)
  })

  it('handles mediaType field name (camelCase variant)', () => {
    const emitter = new EventEmitter()
    const results = []
    emitter.on('tool_result', r => results.push(r))

    emitToolResults([
      {
        type: 'tool_result',
        tool_use_id: 'tu_camel',
        content: [
          { type: 'image', source: { mediaType: 'image/webp', data: 'webp=' } },
        ],
      },
    ], emitter)

    assert.equal(results.length, 1)
    assert.equal(results[0].images.length, 1)
    assert.equal(results[0].images[0].mediaType, 'image/webp')
  })
})
