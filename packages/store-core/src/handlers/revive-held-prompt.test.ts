import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../types'
import { reviveHeldPrompt } from './permission'

/**
 * #7509 F5 -- the ONE merge rule behind both prompt re-delivery paths (a
 * re-sent `permission_request`, a re-delivered `user_question`). Pinned here so
 * the next field added to a prompt ChatMessage is kept (or refreshed) on both,
 * not on whichever path happened to spell it out.
 */
describe('reviveHeldPrompt (#7509 F5)', () => {
  const held = {
    id: 'perm-1',
    type: 'prompt',
    content: 'Bash: ls',
    timestamp: 111,
    requestId: 'req-1',
    answered: '(resolved)',
    answeredAt: 5,
    // A field neither re-delivery path names: it must survive both.
    originSessionId: 'origin-1',
  } as ChatMessage

  it('keeps every field the incoming copy does not name', () => {
    const out = reviveHeldPrompt(held, { content: 'Bash: ls -la' })
    expect(out).toMatchObject({ content: 'Bash: ls -la', originSessionId: 'origin-1', requestId: 'req-1' })
  })

  it('never takes id or timestamp from the incoming copy', () => {
    const out = reviveHeldPrompt(held, { id: 'perm-NEW', timestamp: 999 })
    expect(out.id).toBe('perm-1')
    expect(out.timestamp).toBe(111)
  })

  it('refreshes the fields the incoming copy names, undefined included', () => {
    const out = reviveHeldPrompt(
      { ...held, expiresAt: 50 } as ChatMessage,
      { options: [{ label: 'Allow', value: 'allow' }], expiresAt: undefined },
    )
    expect(out.options).toEqual([{ label: 'Allow', value: 'allow' }])
    expect(out.expiresAt).toBeUndefined()
  })

  it('takes `answered` from the incoming copy by default (clears the placeholder)', () => {
    expect(reviveHeldPrompt(held, { answered: undefined }).answered).toBeUndefined()
    // Absent counts as cleared: the placeholder never rides a re-delivery.
    expect(reviveHeldPrompt(held, {}).answered).toBeUndefined()
    expect(reviveHeldPrompt(held, { answered: '(interrupted)' }).answered).toBe('(interrupted)')
  })

  it('keepAnswered carries the held decision across an incoming `answered`', () => {
    const decided = { ...held, answered: 'Round' } as ChatMessage
    expect(reviveHeldPrompt(decided, { answered: undefined }, { keepAnswered: true }).answered).toBe('Round')
  })

  it('does not mutate the held message', () => {
    const copy = { ...held }
    reviveHeldPrompt(held, { content: 'x', answered: undefined })
    expect(held).toEqual(copy)
  })
})
