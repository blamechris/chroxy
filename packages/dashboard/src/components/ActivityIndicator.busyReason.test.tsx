/**
 * ActivityIndicator — "Waiting on N background shell(s)" vs "Working" (#8302).
 *
 * `isBusy` merges "the model is mid-turn" with "the model is idle and only a
 * tracked background shell keeps the session busy", so an idle session whose
 * shell had died read "Working… last activity 45s ago". The server now publishes
 * `busyReason` beside it; this pins the renderer half, including the two cases
 * that must NOT change: a session mid-turn, and a session from an older server
 * that sends no reason at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ActivityIndicator } from './ActivityIndicator'

let storeState: Record<string, unknown> = {}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => {
    const store = {
      activeSessionId: storeState.activeSessionId ?? 'sess-1',
      sessionStates: (storeState.sessionStates as Record<string, unknown>) ?? {},
      serverResultTimeoutMs: 30 * 60 * 1000,
    }
    return selector(store)
  },
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }))

afterEach(() => cleanup())

const session = (over: Record<string, unknown> = {}) => ({
  // Busy, with a recent activity event: exactly the state that read "Working…".
  isIdle: false,
  lastClientActivityAt: Date.now() - 45_000,
  messages: [],
  activeTools: [],
  activeAgents: [],
  pendingBackgroundShells: [],
  inactivityWarning: null,
  ...over,
})
const mount = (over: Record<string, unknown>) => {
  storeState = { activeSessionId: 'sess-1', sessionStates: { 'sess-1': session(over) } }
  return render(<ActivityIndicator />)
}
const label = () => screen.getByTestId('activity-indicator-label').textContent ?? ''

describe('ActivityIndicator — busyReason (#8302)', () => {
  it('shows "Waiting on N background shells" instead of "Working" when only shells hold the session busy', () => {
    mount({ busyReason: 'background-shells', backgroundShellCount: 2 })
    expect(label()).toBe('Waiting on 2 background shells')
    expect(label()).not.toMatch(/Working/)
    expect(screen.getByTestId('activity-indicator-shell-held')).toBeTruthy()
  })

  it('uses the singular for one shell', () => {
    mount({ busyReason: 'background-shells', backgroundShellCount: 1 })
    expect(label()).toBe('Waiting on 1 background shell')
  })

  it('counts the tracker size, not the visible list: a quiesced shell is hidden from pendingBackgroundShells', () => {
    mount({ busyReason: 'background-shells', backgroundShellCount: 1, pendingBackgroundShells: [] })
    expect(label()).toBe('Waiting on 1 background shell')
  })

  it('names the most recent visible shell when the list has one', () => {
    const now = Date.now()
    mount({
      busyReason: 'background-shells',
      backgroundShellCount: 2,
      pendingBackgroundShells: [
        { shellId: 'old1', command: 'sleep 60', startedAt: now - 30_000 },
        { shellId: 'new2', command: 'npm test', startedAt: now - 5_000 },
      ],
    })
    expect(label()).toBe('Waiting on 2 background shells · npm test')
  })

  it('falls back to the list length, then to a count-less sentence, never inventing a number', () => {
    mount({
      busyReason: 'background-shells',
      pendingBackgroundShells: [{ shellId: 'a', command: 'x', startedAt: 1 }],
    })
    expect(label()).toMatch(/^Waiting on 1 background shell/)
    cleanup()
    mount({ busyReason: 'background-shells' })
    expect(label()).toBe('Waiting on background shells')
  })

  it('still says "Working" while the model is mid-turn, even with shells tracked', () => {
    mount({ busyReason: 'turn', backgroundShellCount: 2 })
    expect(label()).toMatch(/^Working… last activity/)
    expect(screen.queryByTestId('activity-indicator-shell-held')).toBeNull()
  })

  it('keeps the pre-#8302 chip when the server sends no reason (an older server)', () => {
    mount({ busyReason: undefined, backgroundShellCount: undefined })
    expect(label()).toMatch(/^Working… last activity/)
    expect(screen.queryByTestId('activity-indicator-shell-held')).toBeNull()
  })

  it('treats the positive null ("not busy") as no shell chip', () => {
    mount({ busyReason: null })
    expect(label()).toMatch(/^Working… last activity/)
  })

  it('does not trust a stale "background-shells" while a tool or sub-agent is visibly running', () => {
    mount({
      busyReason: 'background-shells',
      backgroundShellCount: 1,
      activeTools: [{ toolUseId: 't1', tool: 'Bash', startedAt: Date.now() - 2_000 }],
    })
    expect(label()).toMatch(/^Running Bash/)
    cleanup()
    mount({
      busyReason: 'background-shells',
      backgroundShellCount: 1,
      activeAgents: [{ toolUseId: 'a1', description: 'explore', startedAt: Date.now() - 2_000 }],
    })
    expect(label()).toMatch(/^Running explore/)
  })

  it('renders the idle chip unchanged when the session is idle (isBusy false)', () => {
    mount({
      isIdle: true,
      busyReason: null,
      pendingBackgroundShells: [{ shellId: 'a', command: 'npm run build', startedAt: Date.now() - 1000 }],
    })
    expect(label()).toMatch(/^Waiting on background work · npm run build/)
  })

  it('renders nothing for an idle session with no work', () => {
    mount({ isIdle: true, busyReason: null })
    expect(screen.queryByTestId('activity-indicator-label')).toBeNull()
  })
})
