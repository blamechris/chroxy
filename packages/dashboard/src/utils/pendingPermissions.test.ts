import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@chroxy/store-core'
import { derivePendingPermissionSessions } from './pendingPermissions'

const NOW = 1_000_000

function prompt(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    type: 'prompt',
    content: 'Bash: ls',
    tool: 'Bash',
    requestId: 'req-1',
    expiresAt: NOW + 60_000,
    timestamp: NOW,
    ...over,
  }
}

function states(map: Record<string, ChatMessage[]>): Record<string, { messages: ChatMessage[] }> {
  const out: Record<string, { messages: ChatMessage[] }> = {}
  for (const id in map) out[id] = { messages: map[id]! }
  return out
}

describe('derivePendingPermissionSessions (#5667)', () => {
  it('flags a session with a live unanswered permission prompt', () => {
    const result = derivePendingPermissionSessions(states({ s1: [prompt()] }), NOW)
    expect(result).toEqual({ s1: true })
  })

  it('does NOT flag an answered prompt', () => {
    const result = derivePendingPermissionSessions(
      states({ s1: [prompt({ answered: 'allow' })] }),
      NOW,
    )
    expect(result).toEqual({})
  })

  it('does NOT flag an expired/timed-out prompt (expiresAt in the past)', () => {
    // Regression: permission_expired / permission_timeout clear `options` but
    // not `answered`, so without the expiry check the indicator stuck on.
    const result = derivePendingPermissionSessions(
      states({ s1: [prompt({ expiresAt: NOW - 1 })] }),
      NOW,
    )
    expect(result).toEqual({})
  })

  it('does NOT flag an AskUserQuestion prompt (no requestId / expiresAt)', () => {
    const aukq = prompt({ requestId: undefined, expiresAt: undefined, options: [{ label: 'A', value: 'a' }] })
    const result = derivePendingPermissionSessions(states({ s1: [aukq] }), NOW)
    expect(result).toEqual({})
  })

  it('flags only the sessions that actually have a live prompt', () => {
    const result = derivePendingPermissionSessions(
      states({
        active: [prompt({ id: 'a', answered: 'allow' })],
        bg1: [{ ...prompt({ id: 'b' }), type: 'response', content: 'hi' }, prompt({ id: 'c' })],
        bg2: [prompt({ id: 'd', expiresAt: NOW - 5 })],
      }),
      NOW,
    )
    expect(result).toEqual({ bg1: true })
  })

  it('finds a live prompt even when a later non-prompt message follows it', () => {
    const result = derivePendingPermissionSessions(
      states({ s1: [prompt({ id: 'p' }), { id: 'sys', type: 'system', content: 'note', timestamp: NOW }] }),
      NOW,
    )
    expect(result).toEqual({ s1: true })
  })
})
