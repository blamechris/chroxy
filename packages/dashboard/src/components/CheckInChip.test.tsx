/**
 * CheckInChip — soft inactivity prompt (#3899) tests.
 *
 * Covers: hidden when no warning, renders elapsed + prefab when set,
 * button click invokes sendInput with the server-supplied prefab,
 * button is disabled while disconnected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { CheckInChip } from './CheckInChip'

const sendInputMock = vi.fn()
let storeState: Record<string, unknown> = {}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: any) => {
    const sessionStates: Record<string, any> = (storeState.sessionStates as any) ?? {}
    const store = {
      activeSessionId: storeState.activeSessionId ?? 'sess-1',
      sessionStates,
      sendInput: sendInputMock,
      connectionPhase: storeState.connectionPhase ?? 'connected',
    }
    return selector(store)
  },
}))

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  storeState = {
    activeSessionId: 'sess-1',
    connectionPhase: 'connected',
    sessionStates: {
      'sess-1': { inactivityWarning: null },
    },
  }
})

describe('CheckInChip', () => {
  it('renders nothing when no inactivity warning is set', () => {
    const { container } = render(<CheckInChip />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when no active session', () => {
    storeState.activeSessionId = null
    const { container } = render(<CheckInChip />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the prefab as the button label when a warning is active', () => {
    ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
      idleMs: 1_800_000,
      prefab: 'Status update?',
      receivedAt: Date.now(),
    }

    render(<CheckInChip />)
    const btn = screen.getByRole('button', { name: /Send check-in: Status update\?/i })
    expect(btn).toBeInTheDocument()
    expect(btn.textContent).toBe('Status update?')
  })

  it('shows elapsed silence in the label', () => {
    ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
      idleMs: 1_800_000,
      prefab: 'Status update?',
      receivedAt: Date.now(),
    }

    render(<CheckInChip />)
    // 1_800_000 ms = 30m — label format is "Agent quiet for 30m" with
    // possible "ms" client-held tail (≤ 1s when fresh). Match the prefix.
    expect(screen.getByText(/Agent quiet for 30m/)).toBeInTheDocument()
  })

  it('calls sendInput with the prefab when the button is clicked', () => {
    ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
      idleMs: 1_800_000,
      prefab: 'Status update?',
      receivedAt: Date.now(),
    }

    render(<CheckInChip />)
    fireEvent.click(screen.getByRole('button', { name: /Send check-in/i }))
    expect(sendInputMock).toHaveBeenCalledTimes(1)
    expect(sendInputMock).toHaveBeenCalledWith('Status update?')
  })

  it('disables the button when not connected and does not fire sendInput', () => {
    storeState.connectionPhase = 'reconnecting'
    ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
      idleMs: 1_800_000,
      prefab: 'Status update?',
      receivedAt: Date.now(),
    }

    render(<CheckInChip />)
    const btn = screen.getByRole('button', { name: /Send check-in/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(sendInputMock).not.toHaveBeenCalled()
  })

  it('exposes a fixed-text polite live region that excludes the ticking elapsed counter', () => {
    ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
      idleMs: 30_000,
      prefab: 'Status update?',
      receivedAt: Date.now(),
    }
    const { container } = render(<CheckInChip />)
    const region = container.querySelector('[role="status"]')
    expect(region).not.toBeNull()
    expect(region?.getAttribute('aria-live')).toBe('polite')
    // The live text is stable per-warning ("Agent has gone quiet. <prefab>")
    // — NOT the per-second ticking "Agent quiet for Ns" label, which would
    // otherwise spam the polite queue once per render tick.
    expect(region?.textContent).toBe('Agent has gone quiet. Status update?')
    // Ticking elapsed counter is marked aria-hidden so SRs ignore it.
    const elapsed = container.querySelector('.check-in-chip__label')
    expect(elapsed?.getAttribute('aria-hidden')).toBe('true')
  })
})
