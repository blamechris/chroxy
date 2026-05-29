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
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

describe('ActivityIndicator — pending-shell command truncation (#4420)', () => {
  it('renders the full command when it fits inside the cap', () => {
    const now = Date.now()
    const cmd = 'npm test'
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
            { shellId: 'brk57kt6pm', command: cmd, startedAt: now - 10_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toContain(cmd)
    expect(label.textContent).not.toMatch(/…/)
  })

  it('truncates long commands with a tail-ellipsis and exposes the full command via title', () => {
    const now = Date.now()
    const longCmd =
      'npm test -- --coverage --reporter=json --bail --testPathPattern=foo --runInBand --silent'
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
            { shellId: 'brk57kt6pm', command: longCmd, startedAt: now - 10_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    // Truncated form: ends with the ellipsis marker, does NOT contain the full command.
    expect(label.textContent).toMatch(/…/)
    expect(label.textContent).not.toContain(longCmd)
    // Start of the command (the binary name) is preserved.
    expect(label.textContent).toContain('npm test')
    // The full command is still reachable via the `title` attribute on the chip
    // so the truncation isn't lossy.
    const chip = screen.getByLabelText('Waiting on background work')
    expect(chip.getAttribute('title')).toBe(longCmd)
  })
})

describe('ActivityIndicator — pending-shell disclosure for multiple shells (#4421)', () => {
  it('renders a "+N more" badge when multiple shells are pending', () => {
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
            { shellId: 'old01', command: 'sleep 60', startedAt: now - 30_000 },
            { shellId: 'mid02', command: 'tail -f /var/log/system.log', startedAt: now - 20_000 },
            { shellId: 'new03', command: 'npm test', startedAt: now - 5_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const more = screen.getByTestId('activity-indicator-more-badge')
    // 3 total - 1 already in the headline label = +2 more.
    expect(more.textContent).toContain('+2')
  })

  it('omits the "+N more" badge when only one shell is pending', () => {
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
            { shellId: 'only01', command: 'npm test', startedAt: now - 5_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    expect(screen.queryByTestId('activity-indicator-more-badge')).toBeNull()
  })

  it('toggles a popover listing every pending shell when the disclosure button is clicked', () => {
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
            { shellId: 'old01', command: 'sleep 60', startedAt: now - 30_000 },
            { shellId: 'new02', command: 'npm test', startedAt: now - 5_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    // Popover is closed by default.
    expect(screen.queryByTestId('activity-indicator-popover')).toBeNull()
    // Click the disclosure button to open it.
    const toggle = screen.getByTestId('activity-indicator-disclosure')
    fireEvent.click(toggle)
    const popover = screen.getByTestId('activity-indicator-popover')
    // Every pending shell is listed (by command).
    expect(popover.textContent).toContain('sleep 60')
    expect(popover.textContent).toContain('npm test')
    // Clicking again closes the popover.
    fireEvent.click(toggle)
    expect(screen.queryByTestId('activity-indicator-popover')).toBeNull()
  })

  it('announces the total shell count and wires aria-controls when the popover is open (#4428)', () => {
    // The disclosure button's aria-label previously said "Show N additional
    // pending background shells" where N = overflowShells.length. But when
    // opened, the popover lists the headline shell + every overflow shell,
    // so the announcement understated the dialog by one. Pin the new wording
    // (total count) and the aria-controls relationship to the popover id.
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
            { shellId: 'old01', command: 'sleep 60', startedAt: now - 30_000 },
            { shellId: 'mid02', command: 'tail -f /var/log/system.log', startedAt: now - 20_000 },
            { shellId: 'new03', command: 'npm test', startedAt: now - 5_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const toggle = screen.getByTestId('activity-indicator-disclosure')
    // Closed state: aria-label uses total count (headline + overflow), and
    // aria-controls is absent because nothing is exposed yet.
    expect(toggle.getAttribute('aria-label')).toBe('Show all 3 pending background shells')
    expect(toggle.getAttribute('aria-controls')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    const popover = screen.getByTestId('activity-indicator-popover')
    // aria-controls now points at the popover's id so AT can follow the link.
    const popoverId = popover.getAttribute('id')
    expect(popoverId).toBeTruthy()
    expect(toggle.getAttribute('aria-controls')).toBe(popoverId)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    // Announcement count must match the number of <li> entries the dialog
    // actually renders — this is the core "off-by-one" guard.
    const items = popover.querySelectorAll('li')
    const announced = toggle.getAttribute('aria-label') ?? ''
    const match = /Show all (\d+) pending background shells/.exec(announced)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBe(items.length)
  })

  it('does not render the disclosure button when only one shell is pending', () => {
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
            { shellId: 'only01', command: 'npm test', startedAt: now - 5_000 },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    expect(screen.queryByTestId('activity-indicator-disclosure')).toBeNull()
  })
})
