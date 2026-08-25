/**
 * #7335 / #2853 — `permission_expired` must actually RETIRE the prompt card.
 *
 * The store previously answered this by clearing `options`, which looks right
 * and does nothing: #2853 records that the dashboard's PermissionPrompt
 * hardcodes its own buttons and never reads that array. The interactive gate is
 * `requestId && expiresAt && !answered` (useMessageRenderer.tsx) and the
 * countdown is seeded from `Math.max(0, expiresAt - Date.now())`, so an expired
 * prompt kept offering a working Allow for the rest of its five minutes with
 * "(Expired …)" printed beside it.
 *
 * These assert the STORE fields the renderer actually consults, so they would
 * have failed on the old build. `store.test.ts` only asserted that `content`
 * matched /Expired/ — a field nothing gates on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createEmptySessionState } from './utils'
import { isLivePermissionPrompt } from '@chroxy/store-core'
import type { ChatMessage } from '@chroxy/store-core'

const SESSION_ID = 'sess-exp'
const REQ = 'req-exp'

function promptMsg(now: number): ChatMessage {
  return {
    id: 'perm-1',
    type: 'prompt',
    content: 'Bash: rm -rf build',
    timestamp: now,
    requestId: REQ,
    expiresAt: now + 300_000,
    options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
  } as unknown as ChatMessage
}

async function expirePrompt(seed?: (ss: ReturnType<typeof createEmptySessionState>) => void) {
  const { useConnectionStore } = await import('./connection')
  const { _testMessageHandler } = await import('./message-handler')
  const now = Date.now()
  const ss = createEmptySessionState()
  ss.messages = [promptMsg(now)]
  seed?.(ss)
  useConnectionStore.setState({
    activeSessionId: SESSION_ID,
    sessionStates: { [SESSION_ID]: ss },
    socket: null,
  })
  _testMessageHandler.setContext({
    url: 'ws://x', token: 't', isReconnect: false, silent: false,
    socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
  })
  _testMessageHandler.handle({
    type: 'permission_expired',
    requestId: REQ,
    sessionId: SESSION_ID,
    message: 'Permission request expired',
  })
  return useConnectionStore.getState().sessionStates[SESSION_ID]!.messages[0]!
}

describe('#7335 — permission_expired retires the prompt card', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('THE BUG: moves expiresAt into the past so the renderer stops offering Allow', async () => {
    const m = await expirePrompt()
    // useMessageRenderer seeds the countdown with max(0, expiresAt - now);
    // <= now means remaining 0 => PermissionPrompt's isExpired => no buttons.
    expect(m.expiresAt).toBeDefined()
    expect(m.expiresAt!).toBeLessThanOrEqual(Date.now())
  })

  it('keeps expiresAt TRUTHY so the card is not erased entirely (#7353)', async () => {
    // The renderer's gate is `requestId && expiresAt && !answered`. A falsy
    // expiresAt drops the card, destroying the only record of a tool call
    // nobody answered — the failure #7353 is about.
    const m = await expirePrompt()
    expect(m.expiresAt).toBeTruthy()
    expect(m.requestId).toBe(REQ)
  })

  it('does NOT set `answered` — that field is a decision token and no decision was made', async () => {
    const m = await expirePrompt()
    expect(m.answered).toBeUndefined()
  })

  it('still appends the expiry note to the card content', async () => {
    const m = await expirePrompt()
    expect(m.content).toMatch(/Expired/)
  })

  it('stops counting as a live permission, so the tab badge clears', async () => {
    const m = await expirePrompt()
    expect(isLivePermissionPrompt(m, Date.now())).toBe(false)
  })

  it('POSITIVE CONTROL: an untouched prompt still counts as live and keeps its future expiry', async () => {
    // Guards against a "fix" that expires every prompt in the session.
    const { useConnectionStore } = await import('./connection')
    const { _testMessageHandler } = await import('./message-handler')
    const now = Date.now()
    const ss = createEmptySessionState()
    const other = { ...promptMsg(now), id: 'perm-2', requestId: 'req-other' } as ChatMessage
    ss.messages = [promptMsg(now), other]
    useConnectionStore.setState({
      activeSessionId: SESSION_ID,
      sessionStates: { [SESSION_ID]: ss },
      socket: null,
    })
    _testMessageHandler.setContext({
      url: 'ws://x', token: 't', isReconnect: false, silent: false,
      socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
    })
    _testMessageHandler.handle({
      type: 'permission_expired', requestId: REQ, sessionId: SESSION_ID, message: 'x',
    })
    const msgs = useConnectionStore.getState().sessionStates[SESSION_ID]!.messages
    expect(isLivePermissionPrompt(msgs[0]!, Date.now())).toBe(false)
    expect(isLivePermissionPrompt(msgs[1]!, Date.now())).toBe(true)
    expect(msgs[1]!.expiresAt!).toBeGreaterThan(Date.now())
  })
})
