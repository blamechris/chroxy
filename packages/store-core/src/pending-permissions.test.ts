import { describe, it, expect } from 'vitest'
import type { ChatMessage } from './types'
import {
  isLivePermissionPrompt,
  firstLivePermissionPrompt,
  livePermissionPrompts,
  countLivePermissionPrompts,
  derivePendingPermissionSessions,
  derivePendingPermissionCounts,
  totalPendingPermissions,
  selectNextPendingSession,
} from './pending-permissions'

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

describe('isLivePermissionPrompt', () => {
  it('is true only for a live, unanswered permission prompt', () => {
    expect(isLivePermissionPrompt(prompt(), NOW)).toBe(true)
    expect(isLivePermissionPrompt(prompt({ answered: 'allow' }), NOW)).toBe(false)
    expect(isLivePermissionPrompt(prompt({ expiresAt: NOW - 1 }), NOW)).toBe(false)
    expect(isLivePermissionPrompt(prompt({ requestId: undefined }), NOW)).toBe(false)
    expect(isLivePermissionPrompt(prompt({ expiresAt: undefined }), NOW)).toBe(false)
    expect(isLivePermissionPrompt({ id: 't', type: 'response', content: '', timestamp: NOW }, NOW)).toBe(false)
  })
})

describe('firstLivePermissionPrompt / livePermissionPrompts / countLivePermissionPrompts', () => {
  const msgs = [
    prompt({ id: 'answered', requestId: 'r-ans', answered: 'allow' }),
    { id: 'sys', type: 'system' as const, content: 'note', timestamp: NOW },
    prompt({ id: 'live-1', requestId: 'r1' }),
    prompt({ id: 'live-2', requestId: 'r2' }),
    prompt({ id: 'expired', requestId: 'r-exp', expiresAt: NOW - 1 }),
  ]
  it('first returns the earliest live prompt', () => {
    expect(firstLivePermissionPrompt(msgs, NOW)?.requestId).toBe('r1')
    expect(firstLivePermissionPrompt([prompt({ answered: 'deny' })], NOW)).toBeNull()
  })
  it('live returns all live prompts in order', () => {
    expect(livePermissionPrompts(msgs, NOW).map((m) => m.requestId)).toEqual(['r1', 'r2'])
  })
  it('count returns the number of live prompts', () => {
    expect(countLivePermissionPrompts(msgs, NOW)).toBe(2)
    expect(countLivePermissionPrompts([], NOW)).toBe(0)
  })
})

describe('derivePendingPermissionSessions (#5667)', () => {
  it('flags a session with a live unanswered permission prompt', () => {
    expect(derivePendingPermissionSessions(states({ s1: [prompt()] }), NOW)).toEqual({ s1: true })
  })
  it('does NOT flag answered / expired / AskUserQuestion', () => {
    expect(derivePendingPermissionSessions(states({ s1: [prompt({ answered: 'allow' })] }), NOW)).toEqual({})
    expect(derivePendingPermissionSessions(states({ s1: [prompt({ expiresAt: NOW - 1 })] }), NOW)).toEqual({})
    const aukq = prompt({ requestId: undefined, expiresAt: undefined, options: [{ label: 'A', value: 'a' }] })
    expect(derivePendingPermissionSessions(states({ s1: [aukq] }), NOW)).toEqual({})
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
})

describe('derivePendingPermissionCounts (#5693)', () => {
  it('counts multiple live prompts in one session and omits zero-pending sessions', () => {
    const counts = derivePendingPermissionCounts(
      states({
        s1: [prompt({ id: 'a', requestId: 'r-a' }), prompt({ id: 'b', requestId: 'r-b' })],
        s2: [prompt({ id: 'c', requestId: 'r-c' })],
        s3: [prompt({ id: 'd', requestId: 'r-d', answered: 'allow' })],
        s4: [],
      }),
      NOW,
    )
    expect(counts).toEqual({ s1: 2, s2: 1 })
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
    expect(selectNextPendingSession(order, { b: 1, d: 2 }, 'a')).toBe('b')
    expect(selectNextPendingSession(order, { b: 1, d: 2 }, 'b')).toBe('d')
  })
  it('wraps around cyclically', () => {
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
