import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildContentBlocks } from '../src/content-blocks.js'

describe('buildContentBlocks', () => {
  it('returns single text block for text-only prompt', () => {
    const result = buildContentBlocks('hello world')
    assert.deepEqual(result, [{ type: 'text', text: 'hello world' }])
  })

  it('returns fallback empty text block for empty prompt and no attachments', () => {
    const result = buildContentBlocks('')
    assert.deepEqual(result, [{ type: 'text', text: '' }])
  })

  it('returns fallback empty text block for undefined prompt and no attachments', () => {
    const result = buildContentBlocks(undefined)
    assert.deepEqual(result, [{ type: 'text', text: '' }])
  })

  it('builds image content block from image attachment', () => {
    const attachments = [{
      type: 'image',
      mediaType: 'image/jpeg',
      data: 'abc123',
      name: 'photo.jpg',
    }]
    const result = buildContentBlocks('', attachments)
    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'image')
    assert.deepEqual(result[0].source, {
      type: 'base64',
      media_type: 'image/jpeg',
      data: 'abc123',
    })
  })

  it('builds document content block from PDF attachment', () => {
    const attachments = [{
      type: 'document',
      mediaType: 'application/pdf',
      data: 'pdfdata',
      name: 'report.pdf',
    }]
    const result = buildContentBlocks('', attachments)
    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'document')
    assert.deepEqual(result[0].source, {
      type: 'base64',
      media_type: 'application/pdf',
      data: 'pdfdata',
    })
  })

  it('inlines text file as decoded text with filename header', () => {
    const fileContent = 'hello from file'
    const b64 = Buffer.from(fileContent).toString('base64')
    const attachments = [{
      type: 'document',
      mediaType: 'text/plain',
      data: b64,
      name: 'notes.txt',
    }]
    const result = buildContentBlocks('', attachments)
    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'text')
    assert.equal(result[0].text, '--- notes.txt ---\nhello from file')
  })

  it('places text block first then attachment blocks in order', () => {
    const attachments = [
      { type: 'image', mediaType: 'image/png', data: 'img1', name: 'a.png' },
      { type: 'document', mediaType: 'application/pdf', data: 'pdf1', name: 'b.pdf' },
    ]
    const result = buildContentBlocks('describe these', attachments)
    assert.equal(result.length, 3)
    assert.equal(result[0].type, 'text')
    assert.equal(result[0].text, 'describe these')
    assert.equal(result[1].type, 'image')
    assert.equal(result[2].type, 'document')
  })

  it('omits text block when prompt is empty but attachments present', () => {
    const attachments = [
      { type: 'image', mediaType: 'image/jpeg', data: 'img', name: 'pic.jpg' },
    ]
    const result = buildContentBlocks('', attachments)
    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'image')
  })
})
