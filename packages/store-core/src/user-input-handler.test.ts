/**
 * Tests for shared user_input WS message handler (#1708)
 */
import { describe, it, expect } from 'vitest'
import { parseUserInputMessage } from './user-input-handler'

describe('parseUserInputMessage', () => {
  it('returns null when sender is self', () => {
    const result = parseUserInputMessage(
      { clientId: 'me', sessionId: 's1', text: 'hello', timestamp: 1000 },
      'me',
      's1',
    )
    expect(result).toBeNull()
  })

  it('returns null when no target session', () => {
    const result = parseUserInputMessage(
      { clientId: 'other', text: 'hello', timestamp: 1000 },
      'me',
      null,
    )
    expect(result).toBeNull()
  })

  it('returns parsed message for message from another client', () => {
    const result = parseUserInputMessage(
      { clientId: 'other', sessionId: 's1', text: 'hello from phone', timestamp: 9999 },
      'me',
      's1',
    )
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('s1')
    expect(result!.type).toBe('user_input')
    expect(result!.content).toBe('hello from phone')
    expect(result!.timestamp).toBe(9999)
  })

  it('uses activeSessionId when message has no sessionId', () => {
    const result = parseUserInputMessage(
      { clientId: 'other', text: 'hi' },
      'me',
      'active-session',
    )
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('active-session')
  })

  it('falls back to Date.now() when no timestamp', () => {
    const before = Date.now()
    const result = parseUserInputMessage(
      { clientId: 'other', sessionId: 's1', text: 'hi' },
      'me',
      's1',
    )
    const after = Date.now()
    expect(result).not.toBeNull()
    expect(result!.timestamp).toBeGreaterThanOrEqual(before)
    expect(result!.timestamp).toBeLessThanOrEqual(after)
  })

  it('handles missing clientId (no sender filter)', () => {
    const result = parseUserInputMessage(
      { sessionId: 's1', text: 'broadcast msg', timestamp: 100 },
      'me',
      's1',
    )
    expect(result).not.toBeNull()
    expect(result!.content).toBe('broadcast msg')
  })

  it('returns empty string content when text is missing', () => {
    const result = parseUserInputMessage(
      { clientId: 'other', sessionId: 's1', timestamp: 1 },
      'me',
      's1',
    )
    expect(result).not.toBeNull()
    expect(result!.content).toBe('')
  })
})
