/**
 * #8348 -- a permission prompt's outcome survives a session switch / reload.
 *
 * `permission_request` / `_resolved` / `_expired` are transient on the server, so
 * a full-rebuild replay (`switch_session`, a reload) swapped in a transcript with
 * no trace of a prompt that had already expired or been answered. The server now
 * records a `permission_outcome` history entry and the replay delivers it. These
 * drive the REAL dashboard store through the wire frames a switch produces and
 * assert what the transcript ends up holding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createEmptySessionState } from './utils'
import { derivePendingPermissionCounts } from '@chroxy/store-core'
import type { ChatMessage } from '@chroxy/store-core'

const SID = 'sess-1'
const REQ = 'req-1'

function livePrompt(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'perm-live', type: 'prompt', content: 'Bash: rm -rf build', tool: 'Bash', requestId: REQ,
    expiresAt: Date.now() + 300_000, timestamp: 1,
    options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
    ...over,
  } as ChatMessage
}

const outcomeFrame = (over: Record<string, unknown> = {}) => ({
  type: 'permission_outcome', sessionId: SID, requestId: REQ, tool: 'Bash',
  description: 'rm -rf build', outcome: 'expired', historySeq: 3, ...over,
})

async function boot(messages: ChatMessage[]) {
  const { useConnectionStore } = await import('./connection')
  const { _testMessageHandler } = await import('./message-handler')
  const ss = createEmptySessionState()
  ss.messages = messages
  useConnectionStore.setState({ activeSessionId: SID, sessionStates: { [SID]: ss }, socket: null })
  _testMessageHandler.setContext({
    url: 'ws://x', token: 't', isReconnect: false, silent: false,
    socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
  })
  const read = () => useConnectionStore.getState().sessionStates[SID]!.messages
  const send = (m: Record<string, unknown>) => _testMessageHandler.handle(m)
  return { read, send, store: useConnectionStore }
}

/** The frames a `switch_session` full-rebuild replay sends for a transcript with one ended prompt. */
function fullRebuild(send: (m: Record<string, unknown>) => void, entries: Array<Record<string, unknown>>) {
  send({ type: 'history_replay_start', sessionId: SID, fullHistory: true, truncated: false, latestSeq: 9 })
  for (const e of entries) send(e)
  send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 })
}

const userEntry = { type: 'message', messageType: 'user_input', content: 'run the cleanup', timestamp: 1, sessionId: SID, historySeq: 1 }

describe('permission_outcome through the real dashboard store (#8348)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('THE BUG: an expired prompt is still in the transcript after a session switch', async () => {
    // Before the switch the client held the (expired, un-dismissed) card; the rebuild replaces it.
    const { read, send } = await boot([livePrompt({ options: undefined, expiresAt: Date.now() - 1000 })])
    fullRebuild(send, [userEntry, outcomeFrame()])
    const prompts = read().filter((m) => m.type === 'prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      requestId: REQ, tool: 'Bash', content: 'Bash: rm -rf build', permissionOutcome: 'expired',
    })
    expect(read().some((m) => m.type === 'user_input')).toBe(true)
  })

  it('an answered prompt is still in the transcript, labelled with its decision', async () => {
    const { read, send } = await boot([livePrompt({ options: undefined, answered: 'allow', answeredAt: 5 })])
    fullRebuild(send, [userEntry, outcomeFrame({ outcome: 'allowed' })])
    const prompts = read().filter((m) => m.type === 'prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ permissionOutcome: 'allowed', answered: 'allow' })
  })

  it('a reload (no prior state) rebuilds the same one record', async () => {
    const { read, send } = await boot([])
    fullRebuild(send, [userEntry, outcomeFrame({ outcome: 'denied' })])
    expect(read().filter((m) => m.type === 'prompt').map((m) => m.permissionOutcome)).toEqual(['denied'])
  })

  it('never resurrects a pending card: nothing counts as a live permission afterwards', async () => {
    const { read, send, store } = await boot([livePrompt()])
    fullRebuild(send, [userEntry, outcomeFrame()])
    const state = store.getState()
    expect(derivePendingPermissionCounts(state.sessionStates, Date.now())).toEqual({})
    expect(read().every((m) => !m.expiresAt)).toBe(true)
  })

  it('a delta replay collapses onto the live card the client held (no duplicate)', async () => {
    const held = livePrompt({ options: undefined, answered: 'deny', answeredAt: 5 })
    const { read, send } = await boot([held])
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 9 })
    send(outcomeFrame({ outcome: 'denied' }))
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 })
    const prompts = read().filter((m) => m.type === 'prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ id: held.id, answered: 'deny', permissionOutcome: 'denied' })
  })

  it('a stale permission_request for a recorded outcome does not turn the record back into a pending card', async () => {
    const { read, send, store } = await boot([])
    fullRebuild(send, [outcomeFrame()])
    const before = read()
    send({
      type: 'permission_request', sessionId: SID, requestId: REQ, tool: 'Bash',
      description: 'rm -rf build', remainingMs: 120_000,
    })
    expect(read()).toBe(before)
    expect(derivePendingPermissionCounts(store.getState().sessionStates, Date.now())).toEqual({})
    expect(read().filter((m) => m.type === 'prompt')).toHaveLength(1)
  })

  it('a stale permission_request after an outcome merged into a LIVE card does not make it actionable or notify', async () => {
    const { read, send, store } = await boot([livePrompt()])
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 9 })
    send(outcomeFrame())
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 })
    const merged = read().filter((m) => m.type === 'prompt')
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'perm-live', permissionOutcome: 'expired' })
    expect(merged[0]!.options).toBeUndefined()
    const notificationsBefore = store.getState().sessionNotifications?.length ?? 0

    send({
      type: 'permission_request', sessionId: SID, requestId: REQ, tool: 'Bash',
      description: 'rm -rf build', remainingMs: 120_000,
    })

    expect(read().filter((m) => m.type === 'prompt')[0]).toBe(merged[0])
    expect(derivePendingPermissionCounts(store.getState().sessionStates, Date.now())).toEqual({})
    expect(store.getState().sessionNotifications?.length ?? 0).toBe(notificationsBefore)
  })

  it('relabels a card an SDK timeout stamped denied when the replay says the prompt expired', async () => {
    const { read, send } = await boot([livePrompt({ options: undefined, answered: 'deny', answeredAt: 5, expiresAt: Date.now() - 1000 })])
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 9 })
    send(outcomeFrame())
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 })
    const [card] = read().filter((m) => m.type === 'prompt')
    expect(card).toMatchObject({ permissionOutcome: 'expired' })
    expect(card!.answered).toBeUndefined()
  })

  it('a locally expired card accepts an authoritative allowed', async () => {
    const { read, send } = await boot([livePrompt({ options: undefined, expiresAt: Date.now() - 1000 })])
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 9 })
    send(outcomeFrame({ outcome: 'allowed' }))
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 })
    expect(read().filter((m) => m.type === 'prompt')[0]).toMatchObject({ permissionOutcome: 'allowed', answered: 'allow' })
  })

  it('POSITIVE CONTROL: a permission_request for a prompt with no recorded outcome still raises a pending card', async () => {
    const { read, send, store } = await boot([])
    send({
      type: 'permission_request', sessionId: SID, requestId: 'req-fresh', tool: 'Bash',
      description: 'ls', remainingMs: 120_000,
    })
    expect(read().filter((m) => m.type === 'prompt')).toHaveLength(1)
    expect(derivePendingPermissionCounts(store.getState().sessionStates, Date.now())).toEqual({ [SID]: 1 })
  })
})

describe('permission_outcome carries the approved tool input through the real dashboard store (#8503)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('a full rebuild holds the journaled input on the record, as the live card held it', async () => {
    const { read, send } = await boot([])
    const input = { command: 'touch smoke-perm.txt', dangerouslyDisableSandbox: true }
    fullRebuild(send, [userEntry, outcomeFrame({ outcome: 'allowed', input, description: 'Touch smoke file' })])
    const records = read().filter((m) => m.type === 'prompt')
    expect(records).toHaveLength(1)
    expect(records[0]!.toolInput).toEqual(input)
    expect(records[0]!.permissionOutcome).toBe('allowed')
  })

  it('an entry journaled before the field (no input) rebuilds a record with no toolInput', async () => {
    const { read, send } = await boot([])
    fullRebuild(send, [userEntry, outcomeFrame({ outcome: 'allowed' })])
    const [record] = read().filter((m) => m.type === 'prompt')
    expect(record).toBeDefined()
    expect('toolInput' in record!).toBe(false)
  })

  it('a malformed input (not an object) is dropped: the record is built without it', async () => {
    const { read, send } = await boot([])
    fullRebuild(send, [userEntry, outcomeFrame({ outcome: 'allowed', input: 'rm -rf /' })])
    const [record] = read().filter((m) => m.type === 'prompt')
    expect(record).toBeDefined()
    expect('toolInput' in record!).toBe(false)
  })

  it('a live card the client already holds keeps ITS tool input; the record does not replace it', async () => {
    const live = livePrompt({ toolInput: { command: 'the live one' } })
    const { read, send } = await boot([live])
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 3 })
    send(outcomeFrame({ outcome: 'allowed', input: { command: 'the journaled one' } }))
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 3 })
    const prompts = read().filter((m) => m.type === 'prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.toolInput).toEqual({ command: 'the live one' })
  })
})
