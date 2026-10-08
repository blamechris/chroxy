import { describe, it, expect, beforeEach } from 'vitest'
import { createDispatchTable, runDispatch, type ClientStoreAdapter } from './dispatch-table'
import type { ChatMessage } from './types'
import {
  resetReplayReconcile,
  reconcileReplayStart,
  reconcileReplayEnd,
  sweepUnansweredPromptsAtReplayEnd,
} from './replay-reconcile'
import {
  handlePermissionOutcome,
  buildPermissionOutcomeMessage,
  handlePermissionResolved,
  applyPermissionResolved,
} from './handlers/permission'
import {
  derivePendingPermissionCounts,
  isLivePermissionPrompt,
  isExpiredUnansweredPermissionPrompt,
  isPermissionRequestAnswered,
} from './pending-permissions'

/**
 * #8348 -- a permission prompt's outcome is part of the session's durable
 * transcript. `permission_request` / `permission_resolved` / `permission_expired`
 * are transient on the server, so a full-rebuild replay (session switch, reload)
 * rebuilt the transcript without any prompt that had already ended. The server
 * now records a `permission_outcome` history entry and the replay delivers it;
 * these drive the shared dispatch handler through the REAL replay-reconcile
 * window (the one both clients use) to pin what the transcript ends up holding.
 */

interface Sess {
  sessionId: string
  messages: ChatMessage[]
}

function makeEnv(messages: ChatMessage[], opts: { activeSessionId?: string | null } = {}) {
  const sessions: Record<string, Sess> = { s1: { sessionId: 's1', messages } }
  const added: ChatMessage[] = []
  const notifications: unknown[] = []
  const adapter = {
    getActiveSessionId: () => opts.activeSessionId ?? 's1',
    hasSession: (id: string) => id in sessions,
    updateSession: (id: string, updater: (s: Sess) => Partial<Sess>) => {
      const cur = sessions[id]
      if (cur) sessions[id] = { ...cur, ...updater(cur) }
    },
    addMessage: (m: ChatMessage) => added.push(m),
    pushSessionNotification: (...args: unknown[]) => notifications.push(args),
  } as unknown as ClientStoreAdapter<Sess>
  return { sessions, added, notifications, adapter }
}

const table = createDispatchTable<Sess>()

function outcome(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'permission_outcome',
    sessionId: 's1',
    requestId: 'perm-1',
    tool: 'Bash',
    description: 'ls -la',
    outcome: 'expired',
    historySeq: 7,
    ...over,
  }
}

function dispatch(env: ReturnType<typeof makeEnv>, msg: Record<string, unknown>): boolean {
  return runDispatch(table, msg, env.adapter)
}

const NOW = Date.now()
const user = (id: string, content: string): ChatMessage => ({ id, type: 'user_input', content, timestamp: 1 })
const livePending = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'live-perm', type: 'prompt', content: 'Bash: ls -la', tool: 'Bash', requestId: 'perm-1',
  options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
  expiresAt: NOW + 60_000, timestamp: 2, ...over,
})
const prompts = (messages: ChatMessage[]) => messages.filter((m) => m.type === 'prompt')

beforeEach(() => resetReplayReconcile({ clearCursors: true }))

describe('handlePermissionOutcome / buildPermissionOutcomeMessage (#8348)', () => {
  it('parses the wire shape', () => {
    expect(handlePermissionOutcome(outcome({ timestamp: 99 }))).toEqual({
      requestId: 'perm-1', tool: 'Bash', description: 'ls -la', outcome: 'expired',
      sessionId: 's1', timestamp: 99,
    })
  })

  it('drops a payload with no requestId or an outcome no renderer can label', () => {
    expect(handlePermissionOutcome(outcome({ requestId: undefined }))).toBeNull()
    expect(handlePermissionOutcome(outcome({ requestId: '' }))).toBeNull()
    expect(handlePermissionOutcome(outcome({ outcome: 'maybe' }))).toBeNull()
    expect(handlePermissionOutcome(outcome({ outcome: undefined }))).toBeNull()
  })

  it('builds a record that can never be a pending card', () => {
    for (const kind of ['allowed', 'denied', 'expired'] as const) {
      const msg = buildPermissionOutcomeMessage(handlePermissionOutcome(outcome({ outcome: kind }))!)
      expect(msg.type).toBe('prompt')
      expect(msg.permissionOutcome).toBe(kind)
      expect(msg.options).toBeUndefined()
      expect(msg.expiresAt).toBeUndefined()
      expect(isLivePermissionPrompt(msg, NOW)).toBe(false)
    }
  })

  it('stamps the decision token on allowed / denied only', () => {
    const build = (kind: string) => buildPermissionOutcomeMessage(handlePermissionOutcome(outcome({ outcome: kind }))!)
    expect(build('allowed').answered).toBe('allow')
    expect(build('denied').answered).toBe('deny')
    expect(build('expired').answered).toBeUndefined()
  })

  it('composes content like the live card: "<tool>: <description>", the bare tool, or a fallback', () => {
    const content = (o: Record<string, unknown>) => buildPermissionOutcomeMessage(handlePermissionOutcome(outcome(o))!).content
    expect(content({})).toBe('Bash: ls -la')
    expect(content({ description: '' })).toBe('Bash')
    expect(content({ tool: '', description: '' })).toBe('Permission required')
  })
})

describe('permission_outcome through a FULL-REBUILD replay (session switch / reload) (#8348)', () => {
  it('gives exactly one compact record for an expired prompt that has no live card', () => {
    // The state after the switch: the client holds what it had; the replay rebuilds.
    const env = makeEnv([user('old', 'earlier')])
    reconcileReplayStart('s1', true, env.sessions.s1!.messages)
    env.adapter.updateSession('s1', (s) => ({ messages: [...s.messages, user('h1', 'run it')] }))
    expect(dispatch(env, outcome())).toBe(true)
    const swapped = reconcileReplayEnd('s1', env.sessions.s1!.messages, 7).swappedMessages as ChatMessage[]
    expect(swapped.map((m) => m.id)).not.toContain('old')
    const records = prompts(swapped)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ requestId: 'perm-1', tool: 'Bash', content: 'Bash: ls -la', permissionOutcome: 'expired' })
    expect(derivePendingPermissionCounts({ s1: { messages: swapped } }, NOW)).toEqual({})
    expect(env.notifications).toEqual([])
  })

  it('survives the replay-end sweep untouched (it keys on requestId)', () => {
    const env = makeEnv([])
    reconcileReplayStart('s1', true, [])
    dispatch(env, outcome())
    const swapped = reconcileReplayEnd('s1', env.sessions.s1!.messages, 7).swappedMessages as ChatMessage[]
    expect(sweepUnansweredPromptsAtReplayEnd('s1', swapped)).toBeNull()
  })

  it('does not double up with the live card that sat in the discarded prefix', () => {
    // The live resolved card the client watched is in the PRE-replay prefix; the swap drops it.
    const liveResolved = livePending({ options: undefined, answered: 'allow', answeredAt: NOW })
    const env = makeEnv([user('old', 'earlier'), liveResolved])
    reconcileReplayStart('s1', true, env.sessions.s1!.messages)
    dispatch(env, outcome({ outcome: 'allowed' }))
    const swapped = reconcileReplayEnd('s1', env.sessions.s1!.messages, 7).swappedMessages as ChatMessage[]
    const records = prompts(swapped)
    expect(records).toHaveLength(1)
    expect(records[0]!.id).not.toBe('live-perm')
    expect(records[0]).toMatchObject({ permissionOutcome: 'allowed', answered: 'allow' })
  })

  it('does not resurrect a pending card the client held for the prompt', () => {
    const env = makeEnv([user('old', 'earlier'), livePending()])
    reconcileReplayStart('s1', true, env.sessions.s1!.messages)
    dispatch(env, outcome())
    const swapped = reconcileReplayEnd('s1', env.sessions.s1!.messages, 7).swappedMessages as ChatMessage[]
    expect(prompts(swapped)).toHaveLength(1)
    expect(prompts(swapped)[0]!.permissionOutcome).toBe('expired')
    expect(derivePendingPermissionCounts({ s1: { messages: swapped } }, NOW)).toEqual({})
  })

  it('keeps the live resolved card that raced into the rebuilt tail, stamped with the outcome and with no second record', () => {
    const env = makeEnv([])
    reconcileReplayStart('s1', true, [])
    // A LIVE frame landed mid-replay (so it is in the tail the swap keeps)...
    const raced = livePending({ options: undefined, answered: 'deny', answeredAt: NOW })
    env.adapter.updateSession('s1', (s) => ({ messages: [...s.messages, raced] }))
    // ...and then the replayed entry for the same prompt arrives.
    dispatch(env, outcome({ outcome: 'denied' }))
    const swapped = reconcileReplayEnd('s1', env.sessions.s1!.messages, 7).swappedMessages as ChatMessage[]
    expect(prompts(swapped)).toHaveLength(1)
    expect(prompts(swapped)[0]).toMatchObject({ id: 'live-perm', answered: 'deny', answeredAt: NOW, permissionOutcome: 'denied' })
  })

  it('reconciles the card in the REBUILT TAIL when the pre-replay prefix is non-empty (the index maps back past the prefix)', () => {
    const old1 = user('old1', 'earlier')
    const old2 = user('old2', 'earlier still')
    const env = makeEnv([old1, old2])
    reconcileReplayStart('s1', true, env.sessions.s1!.messages)
    // The rebuilt tail: a replayed message, then a live card that raced in.
    const raced = livePending({ options: undefined, answered: 'deny', answeredAt: NOW })
    env.adapter.updateSession('s1', (sess) => ({ messages: [...sess.messages, user('h1', 'run it'), raced] }))
    dispatch(env, outcome({ outcome: 'expired' }))
    const during = env.sessions.s1!.messages
    // The prefix is untouched: the reconcile must land on the tail card, not on
    // whatever sits at the tail-relative index inside the prefix.
    expect(during[0]).toBe(old1)
    expect(during[1]).toBe(old2)
    expect(during[3]).toMatchObject({ id: 'live-perm', permissionOutcome: 'expired' })
    const swapped = reconcileReplayEnd('s1', during, 7).swappedMessages as ChatMessage[]
    expect(swapped.map((m) => m.id)).toEqual(['h1', 'live-perm'])
    expect(prompts(swapped)).toHaveLength(1)
    expect(prompts(swapped)[0]!.permissionOutcome).toBe('expired')
    expect(prompts(swapped)[0]!.answered).toBeUndefined()
  })

  it('is idempotent: the same entry replayed twice leaves one record, untouched by the second', () => {
    const env = makeEnv([])
    reconcileReplayStart('s1', true, [])
    dispatch(env, outcome())
    const first = env.sessions.s1!.messages[0]!
    dispatch(env, outcome())
    // The second delivery must not rewrite the record (a re-armed expiresAt would
    // make a transcript line look like a card that just timed out).
    expect(env.sessions.s1!.messages[0]).toBe(first)
    expect(first.expiresAt).toBeUndefined()
    const swapped = reconcileReplayEnd('s1', env.sessions.s1!.messages, 7).swappedMessages as ChatMessage[]
    expect(prompts(swapped)).toHaveLength(1)
  })

  it('keeps two prompts apart: one record per requestId, in order', () => {
    const env = makeEnv([])
    reconcileReplayStart('s1', true, [])
    dispatch(env, outcome({ requestId: 'perm-a', description: 'first', outcome: 'allowed' }))
    dispatch(env, outcome({ requestId: 'perm-b', description: 'second', outcome: 'expired' }))
    const swapped = reconcileReplayEnd('s1', env.sessions.s1!.messages, 7).swappedMessages as ChatMessage[]
    expect(prompts(swapped).map((m) => [m.requestId, m.permissionOutcome])).toEqual([
      ['perm-a', 'allowed'],
      ['perm-b', 'expired'],
    ])
  })
})

describe('permission_outcome through a DELTA replay (reconnect with a cursor) (#8348)', () => {
  it('collapses onto the card the client already holds, resolved: one card, stamped with the outcome', () => {
    const resolved = livePending({ options: undefined, answered: 'allow', answeredAt: NOW })
    const env = makeEnv([user('h1', 'run it'), resolved])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome({ outcome: 'allowed' }))
    const after = env.sessions.s1!.messages
    expect(after).toHaveLength(2)
    expect(after[1]).toMatchObject({ id: 'live-perm', answered: 'allow', answeredAt: NOW, permissionOutcome: 'allowed', content: 'Bash: ls -la' })
  })

  it('keeps the more specific allow the user chose (allowSession)', () => {
    const env = makeEnv([livePending({ options: undefined, answered: 'allowSession', answeredAt: NOW })])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome({ outcome: 'allowed' }))
    expect(env.sessions.s1!.messages[0]).toMatchObject({ answered: 'allowSession', permissionOutcome: 'allowed' })
  })

  it('RELABELS a card an in-process timeout stamped denied when the server recorded it expired', () => {
    // permission_resolved{decision:'deny', reason:'timeout'} -> the client stored answered:'deny'.
    const timedOut = livePending({ options: undefined, answered: 'deny', answeredAt: NOW, expiresAt: NOW - 1 })
    const env = makeEnv([timedOut])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome({ outcome: 'expired' }))
    const [card] = env.sessions.s1!.messages
    expect(env.sessions.s1!.messages).toHaveLength(1)
    expect(card!.permissionOutcome).toBe('expired')
    expect(card!.answered).toBeUndefined()
    expect(card!.answeredAt).toBeUndefined()
    expect(isPermissionRequestAnswered({ s1: env.sessions.s1! }, 'perm-1')).toBe(false)
  })

  it('a card that ran out its own countdown accepts an authoritative allowed', () => {
    const locallyExpired = livePending({ options: undefined, expiresAt: NOW - 1 })
    const env = makeEnv([locallyExpired])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome({ outcome: 'allowed' }))
    const [card] = env.sessions.s1!.messages
    expect(card).toMatchObject({ id: 'live-perm', permissionOutcome: 'allowed', answered: 'allow' })
    expect(card!.options).toBeUndefined()
  })

  it('a card marked allowed locally is corrected to denied when the server says denied', () => {
    const env = makeEnv([livePending({ options: undefined, answered: 'allow', answeredAt: NOW })])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome({ outcome: 'denied' }))
    expect(env.sessions.s1!.messages[0]).toMatchObject({ answered: 'deny', permissionOutcome: 'denied' })
  })

  it('drops the "(Expired ...)" note a live expiry appended: the content is the clean record text', () => {
    const noted = livePending({ options: undefined, expiresAt: NOW - 1, content: 'Bash: ls -la\n(Expired \u2014 this permission was already handled or timed out)' })
    const env = makeEnv([noted])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome())
    expect(env.sessions.s1!.messages[0]!.content).toBe('Bash: ls -la')
  })

  it('collapses onto an expired card the client holds: it keeps its time and gains the stamp', () => {
    const expired = livePending({ options: undefined, expiresAt: NOW - 1 })
    const env = makeEnv([expired])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome())
    expect(env.sessions.s1!.messages).toHaveLength(1)
    expect(env.sessions.s1!.messages[0]).toMatchObject({ id: 'live-perm', permissionOutcome: 'expired', expiresAt: NOW - 1 })
  })

  it('a repeat delivery after the merge leaves the merged card untouched', () => {
    const env = makeEnv([livePending()])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome())
    const merged = env.sessions.s1!.messages[0]!
    dispatch(env, outcome())
    expect(env.sessions.s1!.messages[0]).toBe(merged)
  })

  it('retires a still-pending card for a prompt the server says is over (a missed permission_resolved)', () => {
    const env = makeEnv([livePending()])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome({ outcome: 'allowed' }))
    const [card] = env.sessions.s1!.messages
    expect(env.sessions.s1!.messages).toHaveLength(1)
    expect(card!.answered).toBe('allow')
    expect(card!.permissionOutcome).toBe('allowed')
    expect(card!.options).toBeUndefined()
    expect(isLivePermissionPrompt(card!, NOW)).toBe(false)
    expect(isPermissionRequestAnswered({ s1: env.sessions.s1! }, 'perm-1')).toBe(true)
  })

  it('retires a still-pending card as expired when the outcome is expired', () => {
    const env = makeEnv([livePending()])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome())
    const [card] = env.sessions.s1!.messages
    expect(card!.options).toBeUndefined()
    expect(card!.answered).toBeUndefined()
    expect(card!.permissionOutcome).toBe('expired')
    expect(isLivePermissionPrompt(card!, Date.now() + 1)).toBe(false)
    expect(derivePendingPermissionCounts({ s1: env.sessions.s1! }, Date.now() + 1)).toEqual({})
  })

  it('appends a record when the client never held the prompt', () => {
    const env = makeEnv([user('h1', 'run it')])
    reconcileReplayStart('s1', false, env.sessions.s1!.messages)
    dispatch(env, outcome())
    expect(prompts(env.sessions.s1!.messages)).toHaveLength(1)
  })
})

describe('permission_outcome outside any replay window (#8348)', () => {
  it('still never doubles up with a held card', () => {
    const env = makeEnv([livePending({ options: undefined, answered: 'allow', answeredAt: NOW })])
    dispatch(env, outcome({ outcome: 'allowed' }))
    expect(env.sessions.s1!.messages).toHaveLength(1)
    expect(env.sessions.s1!.messages[0]!.permissionOutcome).toBe('allowed')
  })

  it('addMessage fallback when the session is unknown', () => {
    const env = makeEnv([])
    dispatch(env, outcome({ sessionId: 'nope' }))
    expect(env.added).toHaveLength(1)
    expect(env.added[0]!.permissionOutcome).toBe('expired')
  })
})

// ---------------------------------------------------------------------------
// #8374 -- a prompt the Stop button cancelled reads "stopped", not "Denied"
// ---------------------------------------------------------------------------

describe('a Stop-cancelled prompt is its own outcome (#8374)', () => {
  const resolved = (over: Record<string, unknown> = {}) =>
    handlePermissionResolved({ type: 'permission_resolved', requestId: 'perm-1', decision: 'deny', ...over })

  it('permission_outcome accepts "stopped" and stamps no decision token on it', () => {
    const payload = handlePermissionOutcome(outcome({ outcome: 'stopped' }))
    expect(payload).not.toBeNull()
    const msg = buildPermissionOutcomeMessage(payload!)
    expect(msg.permissionOutcome).toBe('stopped')
    expect(msg.answered).toBeUndefined()
    expect(msg.options).toBeUndefined()
    expect(isLivePermissionPrompt(msg, NOW)).toBe(false)
  })

  it('handlePermissionResolved hands the wire reason on', () => {
    expect(resolved({ reason: 'stopped' })).toEqual({ requestId: 'perm-1', decision: 'deny', reason: 'stopped' })
    expect(resolved({ reason: 'user' }).reason).toBe('user')
    expect(resolved().reason).toBeNull()
    expect(resolved({ reason: 7 }).reason).toBeNull()
  })

  it('a live deny that Stop caused becomes a stopped record: no decision, no options, closed countdown', () => {
    const live = livePending()
    const next = applyPermissionResolved(live, resolved({ reason: 'stopped' }), NOW)
    expect(next.permissionOutcome).toBe('stopped')
    expect(next.answered).toBeUndefined()
    expect(next.options).toBeUndefined()
    expect(next.expiresAt).toBe(NOW)
    expect(next.id).toBe(live.id)
    expect(next.content).toBe(live.content)
    expect(isLivePermissionPrompt(next, NOW + 1)).toBe(false)
    // Stopped is not "dropped by the clock": the end-of-turn expired summary
    // must not count it.
    expect(isExpiredUnansweredPermissionPrompt(next, NOW + 1)).toBe(false)
  })

  it('CONTROL: a user Deny is still a deny, and an allow is still an allow', () => {
    const denied = applyPermissionResolved(livePending(), resolved({ reason: 'user' }), NOW)
    expect(denied.answered).toBe('deny')
    expect(denied.permissionOutcome).toBeUndefined()
    expect(denied.options).toBeUndefined()
    const noReason = applyPermissionResolved(livePending(), resolved(), NOW)
    expect(noReason.answered).toBe('deny')
    expect(noReason.permissionOutcome).toBeUndefined()
    const allowed = applyPermissionResolved(livePending(), resolved({ decision: 'allow', reason: 'user' }), NOW)
    expect(allowed.answered).toBe('allow')
    expect(allowed.permissionOutcome).toBeUndefined()
  })

  it('a non-user abort (reason "aborted": a stalled stream, a dead provider) is NOT labelled a Stop', () => {
    const next = applyPermissionResolved(livePending(), resolved({ reason: 'aborted' }), NOW)
    expect(next.permissionOutcome).toBeUndefined()
    expect(next.answered).toBe('deny')
  })

  it('keeps an already-past expiry rather than moving it forward', () => {
    const next = applyPermissionResolved(livePending({ expiresAt: NOW - 5000 }), resolved({ reason: 'stopped' }), NOW)
    expect(next.expiresAt).toBe(NOW - 5000)
  })

  it('a replayed "stopped" outcome relabels a card an older client stamped denied, with no duplicate', () => {
    const held = livePending({ answered: 'deny', answeredAt: 5, options: undefined, expiresAt: 1 })
    const env = makeEnv([user('u', 'go'), held])
    expect(dispatch(env, outcome({ outcome: 'stopped' }))).toBe(true)
    const records = prompts(env.sessions.s1!.messages)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: 'live-perm', permissionOutcome: 'stopped' })
    expect(records[0]!.answered).toBeUndefined()
    expect(isPermissionRequestAnswered({ s1: env.sessions.s1! }, 'perm-1')).toBe(false)
  })

  it('a replayed "stopped" outcome collapses onto the card the live frame already stopped', () => {
    const stopped = applyPermissionResolved(livePending(), resolved({ reason: 'stopped' }), NOW)
    const env = makeEnv([stopped])
    dispatch(env, outcome({ outcome: 'stopped' }))
    expect(env.sessions.s1!.messages).toHaveLength(1)
    expect(env.sessions.s1!.messages[0]).toBe(stopped)
  })

  it('a stopped record built from history alone survives a full-rebuild replay as one record', () => {
    const env = makeEnv([user('old', 'earlier')])
    reconcileReplayStart('s1', true, env.sessions.s1!.messages)
    env.adapter.updateSession('s1', (sess) => ({ messages: [...sess.messages, user('h1', 'run it')] }))
    dispatch(env, outcome({ outcome: 'stopped' }))
    const swapped = reconcileReplayEnd('s1', env.sessions.s1!.messages, 7).swappedMessages as ChatMessage[]
    const records = prompts(swapped)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ requestId: 'perm-1', permissionOutcome: 'stopped' })
    expect(records[0]!.answered).toBeUndefined()
  })
})
