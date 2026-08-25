/**
 * #7335 — the Auto-mode confirm dialog must name the destructive consequence
 * whenever a turn-interrupting provider has work to lose, INCLUDING the state
 * the guard was previously blind to: a session paused on a permission prompt.
 *
 * These are CALL-SITE tests on purpose. `buildAutoModeConfirmMessage` was never
 * wrong — fed `isBusy: true` it has always returned the destructive copy. The
 * defect was `setPermissionMode` computing that boolean from
 * `streamingMessageId` alone, which the #554 stream-split clears the moment a
 * `permission_request` arrives. A unit test of the pure helper cannot witness
 * that, so it would have passed on the broken build and proved nothing.
 *
 * Controls, per docs/false-safety-guards.md:
 *  - NEGATIVE (the bug): paused on a prompt + interrupting provider ⇒ DESTRUCTIVE.
 *    Fails on the pre-fix build; that was verified before the fix landed.
 *  - POSITIVE: genuinely idle + interrupting provider ⇒ BASE copy. Keeps a fix
 *    that just returns DESTRUCTIVE unconditionally from passing.
 *  - PROVIDER: paused on a prompt on a NON-interrupting provider ⇒ BASE copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createEmptySessionState } from './utils'
import type { ChatMessage, SessionInfo } from '@chroxy/store-core'
import type { ProviderInfo } from './types'

const SESSION_ID = 'sess-7335'

/** A live, unanswered permission prompt — `isLivePermissionPrompt` shape. */
function livePrompt(now: number): ChatMessage {
  return {
    id: 'perm-1',
    type: 'prompt',
    content: 'Bash: rm -rf build',
    timestamp: now,
    requestId: 'req-1',
    expiresAt: now + 300_000,
    options: ['allow', 'deny'],
  } as unknown as ChatMessage
}

/**
 * Seed the store in the state under test and return what `window.confirm` was
 * shown when flipping to Auto.
 *
 * `isIdle: false` is not a contrivance: it is what the server reports while the
 * CLI child sits blocked on its PreToolUse hook, and `streamingMessageId: null`
 * is what the #554 split leaves behind. Together they ARE "paused on a prompt".
 */
async function confirmCopyFor(opts: {
  streamingMessageId: string | null
  isIdle: boolean
  messages: ChatMessage[]
  interruptsTurnOnAutoSwitch: boolean
}): Promise<string> {
  const { useConnectionStore } = await import('./connection')
  const ss = createEmptySessionState()
  ss.permissionMode = 'approve'
  ss.streamingMessageId = opts.streamingMessageId
  ss.isIdle = opts.isIdle
  ss.messages = opts.messages
  useConnectionStore.setState({
    activeSessionId: SESSION_ID,
    sessionStates: { [SESSION_ID]: ss },
    sessions: [{ sessionId: SESSION_ID, provider: 'claude-cli' } as unknown as SessionInfo],
    availableProviders: [
      {
        name: 'claude-cli',
        capabilities: { interruptsTurnOnAutoSwitch: opts.interruptsTurnOnAutoSwitch },
      } as unknown as ProviderInfo,
    ],
    socket: null,
  })

  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
  useConnectionStore.getState().setPermissionMode('auto')
  expect(confirmSpy).toHaveBeenCalledOnce()
  return String(confirmSpy.mock.calls[0]![0])
}

describe('#7335 — Auto-mode confirm copy vs the session busy predicate', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  // Restore in afterEach, not at the end of each case body: an assertion that
  // throws first would otherwise leak the window.confirm stub into every
  // following case and bury the real failure.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('NEGATIVE CONTROL: warns when paused on a permission prompt (not streaming, not idle)', async () => {
    const now = Date.now()
    const copy = await confirmCopyFor({
      streamingMessageId: null,
      isIdle: false,
      messages: [livePrompt(now)],
      interruptsTurnOnAutoSwitch: true,
    })
    expect(copy).toMatch(/INTERRUPT/)
    expect(copy).toMatch(/restart the session/)
  })

  it('warns when paused on a prompt even if isIdle is (wrongly) true — the prompt alone is enough', async () => {
    const now = Date.now()
    const copy = await confirmCopyFor({
      streamingMessageId: null,
      isIdle: true,
      messages: [livePrompt(now)],
      interruptsTurnOnAutoSwitch: true,
    })
    expect(copy).toMatch(/INTERRUPT/)
  })

  it('still warns mid-stream (the case that already worked — no regression)', async () => {
    const copy = await confirmCopyFor({
      streamingMessageId: 'msg-1',
      isIdle: false,
      messages: [],
      interruptsTurnOnAutoSwitch: true,
    })
    expect(copy).toMatch(/INTERRUPT/)
  })

  it('POSITIVE CONTROL: plain copy on a genuinely idle session — the warning is not unconditional', async () => {
    const copy = await confirmCopyFor({
      streamingMessageId: null,
      isIdle: true,
      messages: [],
      interruptsTurnOnAutoSwitch: true,
    })
    expect(copy).not.toMatch(/INTERRUPT/)
    expect(copy).toMatch(/Tools will run without asking for permission/)
  })

  it('POSITIVE CONTROL: a CLOCK-expired prompt is not work at risk — plain copy', async () => {
    const now = Date.now()
    const stale = { ...livePrompt(now), expiresAt: now - 1 } as ChatMessage
    const copy = await confirmCopyFor({
      streamingMessageId: null,
      isIdle: true,
      messages: [stale],
      interruptsTurnOnAutoSwitch: true,
    })
    expect(copy).not.toMatch(/INTERRUPT/)
  })

  it('POSITIVE CONTROL: a SERVER-retired prompt is not work at risk — plain copy', async () => {
    // The case this PR's own server half makes routine: _killAndRespawn emits
    // permission_expired, whose handler clears `options` but leaves `answered`
    // unset and `expiresAt` in the future. Flipping to Auto again a minute later
    // must not claim there is a turn to interrupt. Distinct from the clock case
    // above — that one was never reachable this way.
    const now = Date.now()
    const retired = { ...livePrompt(now), options: undefined } as ChatMessage
    const copy = await confirmCopyFor({
      streamingMessageId: null,
      isIdle: true,
      messages: [retired],
      interruptsTurnOnAutoSwitch: true,
    })
    expect(copy).not.toMatch(/INTERRUPT/)
    expect(copy).toMatch(/Tools will run without asking for permission/)
  })

  it('POSITIVE CONTROL: an ANSWERED prompt is not work at risk — plain copy', async () => {
    const now = Date.now()
    const answered = { ...livePrompt(now), answered: 'allow' } as ChatMessage
    const copy = await confirmCopyFor({
      streamingMessageId: null,
      isIdle: true,
      messages: [answered],
      interruptsTurnOnAutoSwitch: true,
    })
    expect(copy).not.toMatch(/INTERRUPT/)
  })

  it('PROVIDER CONTROL: plain copy when paused on a prompt on a NON-interrupting provider', async () => {
    const now = Date.now()
    const copy = await confirmCopyFor({
      streamingMessageId: null,
      isIdle: false,
      messages: [livePrompt(now)],
      interruptsTurnOnAutoSwitch: false,
    })
    expect(copy).not.toMatch(/INTERRUPT/)
    expect(copy).toMatch(/Tools will run without asking for permission/)
  })
})
