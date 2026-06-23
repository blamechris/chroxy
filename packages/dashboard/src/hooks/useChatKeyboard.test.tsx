/**
 * useChatKeyboard tests — #6287
 *
 * The permission keyboard shortcuts (Cmd/Ctrl+Y, Cmd/Ctrl+Shift+Y, Escape) used
 * to be registered per-PermissionPrompt instance, so with multiple live prompts a
 * single keystroke fired on EVERY mounted prompt at once — answering all pending
 * requests (a security hazard). These tests assert the hoisted single listener
 * targets only the FIRST unanswered prompt in the active session, advances to the
 * next as prompts are answered, and preserves the input-focus / modal-overlay /
 * disconnected guards.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import type { ChatMessage } from '@chroxy/store-core'

// Keep the heavy store module out of the test — the hook only needs these two
// pure predicates from it.
vi.mock('../store/connection', () => ({
  isRuleEligibleTool: (tool: string) => tool === 'Read' || tool === 'Edit',
  isRuleEligibleProvider: () => true,
}))

import { useChatKeyboard, type UseChatKeyboardArgs } from './useChatKeyboard'

afterEach(cleanup)

function promptMsg(id: string, requestId: string, tool: string, answered?: string): ChatMessage {
  return {
    id,
    type: 'prompt',
    content: `${tool} permission`,
    timestamp: 0,
    requestId,
    tool,
    expiresAt: Date.now() + 60_000,
    answered,
  } as ChatMessage
}

function baseArgs(over: Partial<UseChatKeyboardArgs> = {}): UseChatKeyboardArgs {
  return {
    storeMessages: [],
    resolvedPermissions: {},
    sendPermissionResponse: vi.fn(),
    activeSessionProvider: 'claude-sdk',
    availableProviders: [],
    connected: true,
    ...over,
  }
}

function fireKey(init: KeyboardEventInit & { key: string }, target?: EventTarget) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (target) Object.defineProperty(ev, 'target', { value: target })
  document.dispatchEvent(ev)
  return ev
}

describe('useChatKeyboard (#6287)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Cmd+Y answers only the FIRST unanswered prompt, not all live prompts', () => {
    const send = vi.fn()
    renderHook(() =>
      useChatKeyboard(
        baseArgs({
          sendPermissionResponse: send,
          storeMessages: [
            promptMsg('m1', 'req-1', 'Bash'),
            promptMsg('m2', 'req-2', 'Bash'),
          ],
        }),
      ),
    )

    fireKey({ key: 'y', metaKey: true })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('req-1', 'allow')
  })

  it('skips already-answered / cross-client-resolved prompts when picking the primary', () => {
    const send = vi.fn()
    renderHook(() =>
      useChatKeyboard(
        baseArgs({
          sendPermissionResponse: send,
          resolvedPermissions: { 'req-1': 'allow' },
          storeMessages: [
            promptMsg('m1', 'req-1', 'Bash'), // resolved cross-client
            promptMsg('m2', 'req-2', 'Bash', 'deny'), // answered locally
            promptMsg('m3', 'req-3', 'Bash'), // <- primary
          ],
        }),
      ),
    )

    fireKey({ key: 'y', metaKey: true })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('req-3', 'allow')
  })

  it('Escape denies the primary prompt; Cmd+Shift+Y allows-for-session on rule-eligible tools', () => {
    const send = vi.fn()
    const { rerender } = renderHook((args: UseChatKeyboardArgs) => useChatKeyboard(args), {
      initialProps: baseArgs({
        sendPermissionResponse: send,
        storeMessages: [promptMsg('m1', 'req-1', 'Read')],
      }),
    })

    fireKey({ key: 'y', metaKey: true, shiftKey: true })
    expect(send).toHaveBeenLastCalledWith('req-1', 'allowSession')

    // Advance to a fresh primary and deny via Escape.
    send.mockClear()
    rerender(
      baseArgs({
        sendPermissionResponse: send,
        storeMessages: [promptMsg('m2', 'req-2', 'Bash')],
      }),
    )
    fireKey({ key: 'Escape' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('req-2', 'deny')
  })

  it('coerces Cmd+Shift+Y to plain allow when the tool is not rule-eligible', () => {
    const send = vi.fn()
    renderHook(() =>
      useChatKeyboard(
        baseArgs({
          sendPermissionResponse: send,
          // Bash is not rule-eligible, so allowSession must not fire at all on
          // the shift path (matching the button's gating).
          storeMessages: [promptMsg('m1', 'req-1', 'Bash')],
        }),
      ),
    )
    fireKey({ key: 'y', metaKey: true, shiftKey: true })
    expect(send).not.toHaveBeenCalled()
  })

  it('does nothing while disconnected', () => {
    const send = vi.fn()
    renderHook(() =>
      useChatKeyboard(
        baseArgs({
          connected: false,
          sendPermissionResponse: send,
          storeMessages: [promptMsg('m1', 'req-1', 'Bash')],
        }),
      ),
    )
    fireKey({ key: 'y', metaKey: true })
    fireKey({ key: 'Escape' })
    expect(send).not.toHaveBeenCalled()
  })

  it('skips when focus is in an input/textarea/select', () => {
    const send = vi.fn()
    renderHook(() =>
      useChatKeyboard(
        baseArgs({
          sendPermissionResponse: send,
          storeMessages: [promptMsg('m1', 'req-1', 'Bash')],
        }),
      ),
    )
    const input = document.createElement('input')
    fireKey({ key: 'y', metaKey: true }, input)
    fireKey({ key: 'Escape' }, document.createElement('textarea'))
    expect(send).not.toHaveBeenCalled()
  })

  it('Escape is a no-op when a modal overlay is open', () => {
    const send = vi.fn()
    const overlay = document.createElement('div')
    overlay.setAttribute('data-modal-overlay', '')
    document.body.appendChild(overlay)
    try {
      renderHook(() =>
        useChatKeyboard(
          baseArgs({
            sendPermissionResponse: send,
            storeMessages: [promptMsg('m1', 'req-1', 'Bash')],
          }),
        ),
      )
      fireKey({ key: 'Escape' })
      expect(send).not.toHaveBeenCalled()
    } finally {
      overlay.remove()
    }
  })

  it('does not double-fire on key auto-repeat for the same primary', () => {
    const send = vi.fn()
    renderHook(() =>
      useChatKeyboard(
        baseArgs({
          sendPermissionResponse: send,
          storeMessages: [promptMsg('m1', 'req-1', 'Bash')],
        }),
      ),
    )
    fireKey({ key: 'y', metaKey: true })
    fireKey({ key: 'y', metaKey: true })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('allows with Ctrl+Y (non-Mac modifier)', () => {
    const send = vi.fn()
    renderHook(() =>
      useChatKeyboard(
        baseArgs({
          sendPermissionResponse: send,
          storeMessages: [promptMsg('m1', 'req-1', 'Bash')],
        }),
      ),
    )
    fireKey({ key: 'y', ctrlKey: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('req-1', 'allow')
  })

  it('still allows Cmd+Y when a modal overlay is open (the overlay guard is Escape-only, #1230)', () => {
    const send = vi.fn()
    const overlay = document.createElement('div')
    overlay.setAttribute('data-modal-overlay', '')
    document.body.appendChild(overlay)
    try {
      renderHook(() =>
        useChatKeyboard(
          baseArgs({
            sendPermissionResponse: send,
            storeMessages: [promptMsg('m1', 'req-1', 'Bash')],
          }),
        ),
      )
      fireKey({ key: 'y', metaKey: true })
      expect(send).toHaveBeenCalledWith('req-1', 'allow')
    } finally {
      overlay.remove()
    }
  })
})
