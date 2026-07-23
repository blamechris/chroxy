import { describe, it, expect } from 'vitest'
import { toMessageAttachments, isRenderableImageUri } from './attachment-preview'

describe('toMessageAttachments (#6632)', () => {
  it('builds a data: URI image attachment from a composer image', () => {
    const out = toMessageAttachments([{ data: 'AAAA', mediaType: 'image/png', name: 'shot.png' }], undefined)
    expect(out).toEqual([
      { id: 'img-0', type: 'image', uri: 'data:image/png;base64,AAAA', name: 'shot.png', mediaType: 'image/png', size: 4 },
    ])
  })

  it('builds a document attachment from a composer file (path → uri, no data)', () => {
    const out = toMessageAttachments(undefined, [{ path: '/tmp/notes.pdf', name: 'notes.pdf' }])
    expect(out).toEqual([{ id: 'doc-0', type: 'document', uri: '/tmp/notes.pdf', name: 'notes.pdf', mediaType: '', size: 0 }])
  })

  it('combines images then files with unique ids', () => {
    const out = toMessageAttachments(
      [{ data: 'x', mediaType: 'image/jpeg', name: 'a.jpg' }],
      [{ path: '/p/b.txt', name: 'b.txt' }],
    )
    expect(out.map((a) => [a.id, a.type])).toEqual([['img-0', 'image'], ['doc-0', 'document']])
  })

  it('returns [] for no attachments', () => {
    expect(toMessageAttachments()).toEqual([])
    expect(toMessageAttachments([], [])).toEqual([])
  })

  it('prefers the composer thumbnail data URI as the preview uri (#6729)', () => {
    const out = toMessageAttachments(
      [{ data: 'AAAA', mediaType: 'image/png', name: 'shot.png', thumbnailDataUri: 'data:image/jpeg;base64,THUMB' }],
      undefined,
    )
    expect(out[0]!.uri).toBe('data:image/jpeg;base64,THUMB')
    // `size` still reflects the original payload, not the thumbnail.
    expect(out[0]!.size).toBe(4)
  })

  it('falls back to the full data URI when no thumbnail was generated (#6729)', () => {
    const out = toMessageAttachments([{ data: 'AAAA', mediaType: 'image/png', name: 'shot.png' }], undefined)
    expect(out[0]!.uri).toBe('data:image/png;base64,AAAA')
  })
})

describe('isRenderableImageUri (#6632)', () => {
  it('accepts renderable image schemes', () => {
    expect(isRenderableImageUri('data:image/png;base64,x')).toBe(true)
    expect(isRenderableImageUri('blob:https://app/abc')).toBe(true)
    expect(isRenderableImageUri('https://cdn/x.png')).toBe(true)
  })

  it('rejects the persistence "[data stripped]" sentinel (resumed session)', () => {
    expect(isRenderableImageUri('[data stripped]')).toBe(false)
  })

  it('rejects non-image / unsafe / relative schemes', () => {
    expect(isRenderableImageUri('http://cdn/x.png')).toBe(false) // no plaintext peer fetch
    expect(isRenderableImageUri('javascript:alert(1)')).toBe(false)
    expect(isRenderableImageUri('data:text/html,x')).toBe(false)
    expect(isRenderableImageUri('/local/path')).toBe(false)
    expect(isRenderableImageUri(null)).toBe(false)
    expect(isRenderableImageUri(undefined)).toBe(false)
  })
})
