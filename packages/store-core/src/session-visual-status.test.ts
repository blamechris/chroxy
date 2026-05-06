import { describe, expect, it } from 'vitest'
import { deriveSessionVisualStatus, SESSION_STALE_AFTER_MS } from './session-visual-status'

const NOW = 1_800_000_000_000

describe('deriveSessionVisualStatus', () => {
  it('returns working when the session is busy', () => {
    expect(deriveSessionVisualStatus({ isBusy: true, now: NOW, lastActivityAt: NOW - SESSION_STALE_AFTER_MS * 2 })).toBe('working')
  })

  it('returns working while streaming', () => {
    expect(deriveSessionVisualStatus({ streamingMessageId: 'msg-1', now: NOW })).toBe('working')
  })

  it('returns working when agent state is non-idle', () => {
    expect(deriveSessionVisualStatus({ isIdle: false, now: NOW })).toBe('working')
  })

  it('returns working while sub-agents are active', () => {
    expect(deriveSessionVisualStatus({ activeAgentCount: 1, now: NOW })).toBe('working')
  })

  it('returns stale after one hour of idle time', () => {
    expect(deriveSessionVisualStatus({ isBusy: false, isIdle: true, now: NOW, lastActivityAt: NOW - SESSION_STALE_AFTER_MS })).toBe('stale')
  })

  it('returns idle before the stale threshold', () => {
    expect(deriveSessionVisualStatus({ isBusy: false, isIdle: true, now: NOW, lastActivityAt: NOW - SESSION_STALE_AFTER_MS + 1 })).toBe('idle')
  })

  it('returns idle when no activity timestamp is available', () => {
    expect(deriveSessionVisualStatus({ isBusy: false, isIdle: true, now: NOW })).toBe('idle')
  })
})
