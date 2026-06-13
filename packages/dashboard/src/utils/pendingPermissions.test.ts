import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@chroxy/store-core'
import {
  derivePendingPermissionSessions,
  derivePendingPermissionCounts,
  totalPendingPermissions,
  selectNextPendingSession,
} from './pendingPermissions'

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

describe('derivePendingPermissionCounts (#5693)', () => {
  it('counts multiple live prompts in one session and omits zero-pending sessions', () => {
    const counts = derivePendingPermissionCounts(
      states({
        s1: [prompt({ id: 'a', requestId: 'r-a' }), prompt({ id: 'b', requestId: 'r-b' })],
        s2: [prompt({ id: 'c', requestId: 'r-c' })],
        s3: [prompt({ id: 'd', requestId: 'r-d', answered: 'allow' })], // resolved → omitted
        s4: [], // empty → omitted
      }),
      NOW,
    )
    expect(counts).toEqual({ s1: 2, s2: 1 })
  })

  it('excludes answered / expired / AskUserQuestion prompts from the count', () => {
    const counts = derivePendingPermissionCounts(
      states({
        s1: [
          prompt({ id: 'live', requestId: 'r1' }),
          prompt({ id: 'answered', requestId: 'r2', answered: 'deny' }),
          prompt({ id: 'expired', requestId: 'r3', expiresAt: NOW - 1 }),
          prompt({ id: 'aukq', requestId: undefined, expiresAt: undefined }),
        ],
      }),
      NOW,
    )
    expect(counts).toEqual({ s1: 1 })
  })

  it('stays consistent with the boolean derive', () => {
    const s = states({ s1: [prompt({ id: 'a' })], s2: [prompt({ id: 'b', answered: 'allow' })] })
    expect(derivePendingPermissionSessions(s, NOW)).toEqual({ s1: true })
    expect(Object.keys(derivePendingPermissionCounts(s, NOW))).toEqual(['s1'])
  })
})

describe('totalPendingPermissions (#5693)', () => {
  it('sums counts across sessions', () => {
    expect(totalPendingPermissions({ s1: 2, s2: 1 })).toBe(3)
    expect(totalPendingPermissions({})).toBe(0)
  })
})

describe('selectNextPendingSession (#5693)', () => {
  const order = ['a', 'b', 'c', 'd']

  it('returns null when nothing is pending', () => {
    expect(selectNextPendingSession(order, {}, 'a')).toBeNull()
    expect(selectNextPendingSession([], { a: 1 }, 'a')).toBeNull()
  })

  it('jumps to the next pending session AFTER the active tab, in tab order', () => {
    // active = 'a'; pending b and d → next after a is b.
    expect(selectNextPendingSession(order, { b: 1, d: 2 }, 'a')).toBe('b')
    // active = 'b'; next pending after b is d.
    expect(selectNextPendingSession(order, { b: 1, d: 2 }, 'b')).toBe('d')
  })

  it('wraps around cyclically', () => {
    // active = 'd' (last); pending a → wrap to a.
    expect(selectNextPendingSession(order, { a: 1 }, 'd')).toBe('a')
  })

  it('returns the active tab when it is the only pending one (no-op focus)', () => {
    expect(selectNextPendingSession(order, { b: 3 }, 'b')).toBe('b')
  })

  it('scans from the start when the active id is not in the list', () => {
    expect(selectNextPendingSession(order, { c: 1 }, 'unknown')).toBe('c')
    expect(selectNextPendingSession(order, { c: 1 }, null)).toBe('c')
  })
})
