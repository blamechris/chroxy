/**
 * ActivityIndicator pending-background-shell surfacing (#4418).
 *
 * PR #4416 landed the server-side tracking + protocol surface for backgrounded
 * Bash shells. The dashboard store populates `sessionStates[id]
 * .pendingBackgroundShells` via `handleBackgroundWorkChanged` and the
 * `session_list` seed. This test locks in the ActivityIndicator's renderer
 * half: when an idle session is still waiting on background work, the chip
 * surfaces "Waiting on background work" with the command text, rather than
 * disappearing entirely. During an active turn the existing "Running <tool>"
 * label dominates — pending shells are SECONDARY.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ActivityIndicator } from './ActivityIndicator'

let storeState: Record<string, unknown> = {}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => {
    const sessionStates: Record<string, unknown> = (storeState.sessionStates as Record<string, unknown>) ?? {}
    const store = {
      activeSessionId: storeState.activeSessionId ?? 'sess-1',
      sessionStates,
      serverResultTimeoutMs: storeState.serverResultTimeoutMs ?? 30 * 60 * 1000,
    }
    return selector(store)
  },
}))

// Same useShallow pass-through pattern the inflight tests use — the mocked
// store selector returns the projection object directly.
vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}))

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ActivityIndicator — pending background shells (#4418)', () => {
  it('renders "Waiting on background work" with the command text when idle and one shell is pending', () => {
    const now = Date.now()
    storeState = {
      activeSessionId: 'sess-1',
      serverResultTimeoutMs: 30 * 60 * 1000,
      sessionStates: {
        'sess-1': {
          isIdle: true,
          lastClientActivityAt: now - 2_000,
          messages: [],
          activeTools: [],
          activeAgents: [],
          pendingBackgroundShells: [
            { shellId: 'brk57kt6pm', command: 'npm run build', startedAt: now - 10_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/Waiting on background work/)
    expect(label.textContent).toMatch(/npm run build/)
  })

  it('uses the most-recently-started shell when multiple are pending', () => {
    const now = Date.now()
    storeState = {
      activeSessionId: 'sess-1',
      serverResultTimeoutMs: 30 * 60 * 1000,
      sessionStates: {
        'sess-1': {
          isIdle: true,
          lastClientActivityAt: now - 2_000,
          messages: [],
          activeTools: [],
          activeAgents: [],
          pendingBackgroundShells: [
            { shellId: 'oldid01', command: 'sleep 60', startedAt: now - 30_000 },
            { shellId: 'newid02', command: 'npm test', startedAt: now - 5_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/Waiting on background work/)
    expect(label.textContent).toMatch(/npm test/)
    expect(label.textContent).not.toMatch(/sleep 60/)
  })

  it('falls back to the shellId when the command text is empty', () => {
    const now = Date.now()
    storeState = {
      activeSessionId: 'sess-1',
      serverResultTimeoutMs: 30 * 60 * 1000,
      sessionStates: {
        'sess-1': {
          isIdle: true,
          lastClientActivityAt: now - 2_000,
          messages: [],
          activeTools: [],
          activeAgents: [],
          pendingBackgroundShells: [
            { shellId: 'brk57kt6pm', command: '', startedAt: now - 4_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/Waiting on background work/)
    expect(label.textContent).toMatch(/brk57kt6pm/)
  })

  it('does not shadow the "Running <tool>" label during an active turn', () => {
    // _isBusy=true (isIdle=false) with both an in-flight tool AND a pending
    // background shell: the existing tool label must win. Pending shells are
    // SECONDARY during a live turn — they only surface when the turn ends.
    const now = Date.now()
    storeState = {
      activeSessionId: 'sess-1',
      serverResultTimeoutMs: 30 * 60 * 1000,
      sessionStates: {
        'sess-1': {
          isIdle: false,
          lastClientActivityAt: now - 2_000,
          messages: [],
          activeTools: [
            { toolUseId: 'tu-1', tool: 'WebFetch', startedAt: now - 3_000 },
          ],
          activeAgents: [],
          pendingBackgroundShells: [
            { shellId: 'brk57kt6pm', command: 'npm run build', startedAt: now - 10_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/Running\s+WebFetch/)
    expect(label.textContent).not.toMatch(/Waiting on background work/)
  })

  it('renders nothing when idle with no pending background shells (regression)', () => {
    // Pre-#4418 behaviour: idle session renders nothing. Pin this so the new
    // surface only activates when shells are actually pending.
    storeState = {
      activeSessionId: 'sess-1',
      serverResultTimeoutMs: 30 * 60 * 1000,
      sessionStates: {
        'sess-1': {
          isIdle: true,
          lastClientActivityAt: Date.now() - 1_000,
          messages: [],
          activeTools: [],
          activeAgents: [],
          pendingBackgroundShells: [],
          inactivityWarning: null,
        },
      },
    }
    const { container } = render(<ActivityIndicator />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when idle with pendingBackgroundShells undefined (pre-#4307 server)', () => {
    // Older servers omit the field entirely — consumers must treat undefined
    // as "no pending work" rather than crashing or rendering a chip.
    storeState = {
      activeSessionId: 'sess-1',
      serverResultTimeoutMs: 30 * 60 * 1000,
      sessionStates: {
        'sess-1': {
          isIdle: true,
          lastClientActivityAt: Date.now() - 1_000,
          messages: [],
          activeTools: [],
          activeAgents: [],
          inactivityWarning: null,
        },
      },
    }
    const { container } = render(<ActivityIndicator />)
    expect(container.firstChild).toBeNull()
  })
})
