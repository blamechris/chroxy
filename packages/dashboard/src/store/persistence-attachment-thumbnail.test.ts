/**
 * #6729 — a bounded image thumbnail `data:` URI must survive persist + reload
 * so a resumed session renders the preview instead of a filename chip, while
 * oversized `data:` blobs are still stripped to keep localStorage bounded.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  setServerScope,
  persistSessionMessages,
  loadSessionMessages,
  flushPendingWrites,
  _resetForTesting,
} from './persistence'
import { THUMBNAIL_MAX_BYTES } from '../utils/image-utils'
import type { ChatMessage } from './types'

beforeEach(() => {
  localStorage.clear()
  _resetForTesting()
  setServerScope(null)
})

function userMessageWithAttachments(attachments: ChatMessage['attachments']): ChatMessage {
  return {
    id: 'msg-1',
    type: 'user_input',
    content: 'here is a screenshot',
    timestamp: Date.now(),
    attachments,
  }
}

describe('stripLargeData attachment thumbnails (#6729)', () => {
  const smallThumb = 'data:image/jpeg;base64,SHORTTHUMB'
  const oversized = 'data:image/png;base64,' + 'A'.repeat(THUMBNAIL_MAX_BYTES)

  it('preserves a bounded thumbnail data URI across persist + reload', () => {
    persistSessionMessages('s1', [userMessageWithAttachments([
      { id: 'img-0', type: 'image', uri: smallThumb, name: 'shot.png', mediaType: 'image/png', size: 1234 },
    ])])
    flushPendingWrites()

    const [msg] = loadSessionMessages('s1')
    expect(msg!.attachments![0]!.uri).toBe(smallThumb)
  })

  it('strips an oversized data URI to the sentinel', () => {
    expect(oversized.length).toBeGreaterThan(THUMBNAIL_MAX_BYTES)
    persistSessionMessages('s1', [userMessageWithAttachments([
      { id: 'img-0', type: 'image', uri: oversized, name: 'big.png', mediaType: 'image/png', size: 999999 },
    ])])
    flushPendingWrites()

    const [msg] = loadSessionMessages('s1')
    expect(msg!.attachments![0]!.uri).toBe('[data stripped]')
  })

  it('leaves a non-data document path URI untouched', () => {
    persistSessionMessages('s1', [userMessageWithAttachments([
      { id: 'doc-0', type: 'document', uri: '/tmp/notes.pdf', name: 'notes.pdf', mediaType: '', size: 0 },
    ])])
    flushPendingWrites()

    const [msg] = loadSessionMessages('s1')
    expect(msg!.attachments![0]!.uri).toBe('/tmp/notes.pdf')
  })

  it('mixed: keeps the small thumbnail, strips the oversized blob, keeps the doc', () => {
    persistSessionMessages('s1', [userMessageWithAttachments([
      { id: 'img-0', type: 'image', uri: smallThumb, name: 'a.png', mediaType: 'image/png', size: 1 },
      { id: 'img-1', type: 'image', uri: oversized, name: 'b.png', mediaType: 'image/png', size: 1 },
      { id: 'doc-0', type: 'document', uri: '/tmp/c.pdf', name: 'c.pdf', mediaType: '', size: 0 },
    ])])
    flushPendingWrites()

    const [msg] = loadSessionMessages('s1')
    const uris = msg!.attachments!.map((a) => a.uri)
    expect(uris).toEqual([smallThumb, '[data stripped]', '/tmp/c.pdf'])
  })
})
