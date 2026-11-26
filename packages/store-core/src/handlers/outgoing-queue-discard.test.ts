import { describe, it, expect } from 'vitest'
import { previewQueuedText, stashClearedQueue, isDiscardNotice } from './outgoing-queue'
import { isSystemTabMessage } from '../turn-outcome-marker'
import { buildChatViewMessages } from '../buildChatViewMessages'
import type { ChatMessage } from '../types'

const notice = (): ChatMessage => ({
  id: 'queue-discarded-1', type: 'system', timestamp: 1,
  content: 'Not sent — Stop discarded 1 queued message: “x”',
  discardedFollowUps: [{ id: 'a', preview: 'x' }],
})

describe('previewQueuedText (#9069)', () => {
  it('never splits a surrogate pair at the cut', () => {
    const out = previewQueuedText('a'.repeat(58) + '\u{1F600}' + 'b'.repeat(20))
    expect(out).toBe('a'.repeat(58) + '\u{1F600}…')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false)
  })
  it('leaves a short message whole and marks an attachment-only one', () => {
    expect(previewQueuedText('  hi\n there ')).toBe('hi there')
    expect(previewQueuedText('')).toBe('(attachment)')
  })
})

describe('stashClearedQueue (#9069)', () => {
  it('a fresh Stop replaces the stash instead of appending', () => {
    const old = [{ clientMessageId: 'old', text: 'o', queuedAt: 1, status: 'confirmed' as const }]
    const fresh = [{ clientMessageId: 'new', text: 'n', queuedAt: 2, status: 'confirmed' as const }]
    expect(stashClearedQueue(old, fresh)).toEqual(fresh)
  })
})

describe('the notice is positional, not a System-tab row (#9069)', () => {
  it('isDiscardNotice recognises it and a plain system row is not one', () => {
    expect(isDiscardNotice(notice())).toBe(true)
    expect(isDiscardNotice({ id: 's', type: 'system', content: 'x', timestamp: 1 })).toBe(false)
  })
  it('buildChatViewMessages lets it into the chat flow', () => {
    const msgs: ChatMessage[] = [
      { id: 'u1', type: 'user_input', content: 'hi', timestamp: 0 },
      notice(),
      { id: 'sys', type: 'system', content: 'connected', timestamp: 2 },
    ]
    const ids = buildChatViewMessages(msgs, null).chatMessages.map((m) => m.id)
    expect(ids).toEqual(['u1', 'queue-discarded-1'])
  })
  it('is NOT counted on the System tab', () => {
    expect(isSystemTabMessage(notice())).toBe(false)
    expect(isSystemTabMessage({ id: 's', type: 'system', content: 'x', timestamp: 1 })).toBe(true)
  })
})
