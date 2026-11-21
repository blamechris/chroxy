/**
 * #9222 (F2) — a REFUSED send must release PermissionPrompt's submit latch.
 *
 * `respond` latches `submittingRef` / `submitting` before calling `onRespond` so a
 * double-click or held key cannot fire twice (#2852). The latch only ever reset
 * when the store's `answered` flipped, which happens only after a successful send.
 * `sendPermissionResponse` returns `false` when it REFUSES (socket flipping to
 * CLOSING, or a retired request), so a refused click left the prompt wedged:
 * buttons disabled, nothing answered, no way to retry short of a remount.
 *
 * Contract pinned here: `'sent'` / `'queued'` / `undefined` (a callback that
 * returns nothing) keep the latch and stop the countdown, exactly as before;
 * only an explicit `false` releases it, and the countdown keeps running.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { PermissionPrompt } from './PermissionPrompt'
import type { PermissionDecision } from '../store/types'

type MockStore = {
  resolvedPermissions: Record<string, PermissionDecision>
  activeSessionId: string | null
  sessions: { sessionId: string; provider?: string }[]
  availableProviders: { name: string; capabilities?: { sessionRules?: boolean; denyReason?: boolean } }[]
  connectionPhase: string
}
const mockStoreState: MockStore = {
  resolvedPermissions: {},
  activeSessionId: 's1',
  sessions: [{ sessionId: 's1', provider: 'claude-sdk' }],
  availableProviders: [{ name: 'claude-sdk', capabilities: { sessionRules: true, denyReason: true } }],
  connectionPhase: 'connected',
}
vi.mock('../store/connection', () => ({
  useConnectionStore: <T,>(selector: (s: MockStore) => T): T => selector(mockStoreState),
  isRuleEligibleTool: (tool: string) => new Set(['Read', 'Write', 'Edit']).has(tool),
  isRuleEligibleProvider: () => false,
  isDenyReasonHonoredProvider: () => false,
  DENY_REASON_MAX_LENGTH: 2000,
}))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function mount(onRespond: (...a: never[]) => unknown, remainingMs = 60000) {
  return render(
    <PermissionPrompt
      requestId="req-1"
      tool="Bash"
      description="run"
      remainingMs={remainingMs}
      onRespond={onRespond as never}
    />,
  )
}

describe('#9222 F2 — refused send releases the latch', () => {
  for (const [label, btn, decision] of [
    ['Allow', 'Allow', 'allow'],
    ['Deny', 'Deny', 'deny'],
  ] as const) {
    it(`${label}: a refused (false) send can be retried and the retry reaches onRespond`, () => {
      const onRespond = vi.fn().mockReturnValueOnce(false).mockReturnValue('sent')
      mount(onRespond)
      fireEvent.click(screen.getByText(btn))
      expect(onRespond).toHaveBeenCalledTimes(1)
      expect((screen.getByText(btn) as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(screen.getByText(btn))
      expect(onRespond).toHaveBeenCalledTimes(2)
      expect(onRespond.mock.calls[1]?.[1]).toBe(decision)
    })
  }

  it('a refused send leaves the countdown running', () => {
    mount(vi.fn().mockReturnValue(false), 5000)
    expect(screen.getByTestId('perm-countdown')).toHaveTextContent('0:05')
    fireEvent.click(screen.getByText('Allow'))
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByTestId('perm-countdown')).toHaveTextContent('0:03')
  })

  it('REPEATED-CLICK PROTECTION is unchanged while the call is in flight (a re-entrant click is ignored)', () => {
    // The latch is held for the whole synchronous onRespond call; a click that
    // arrives re-entrantly (double-click / key-repeat) must not fire a second send.
    let reentered = 0
    const onRespond = vi.fn(() => {
      fireEvent.click(screen.getByText('Allow'))
      reentered += 1
      return false as const
    })
    mount(onRespond)
    fireEvent.click(screen.getByText('Allow'))
    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(reentered).toBe(1)
  })

  for (const result of ['sent', 'queued', undefined] as const) {
    it(`SUCCESS (${String(result)}): the latch stays held — a second click is ignored — and the countdown stops`, () => {
      const onRespond = vi.fn().mockReturnValue(result)
      mount(onRespond, 5000)
      fireEvent.click(screen.getByText('Allow'))
      fireEvent.click(screen.getByText('Allow'))
      fireEvent.click(screen.getByText('Deny'))
      expect(onRespond).toHaveBeenCalledTimes(1)
      act(() => { vi.advanceTimersByTime(2000) })
      expect(screen.getByTestId('perm-countdown')).toHaveTextContent('0:05')
    })
  }
})
