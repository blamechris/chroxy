/**
 * ActivityIndicator transcript-derived background work + scheduled wakeup
 * (#5431).
 *
 * The PTY-side shell tracker (#4418) only covers Bash shells and reaps via
 * an mtime-quiescence sweep, which falsely drops silent watcher loops that
 * write no output until they finish. #5431 adds transcript-derived tasks
 * (exact task-notification pairing) carried on enriched `claude_ready`
 * messages into `sessionStates[id].transcriptBackgroundTasks`, plus a
 * pending `scheduledWakeup`. These tests lock in the renderer half: the
 * idle chip falls back to transcript tasks when no PTY shell is pending,
 * shows the wakeup chip when only a wakeup is armed, and stays empty when
 * nothing is outstanding.
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

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}))

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
})

function idleSessionState(overrides: Record<string, unknown>): void {
  storeState = {
    activeSessionId: 'sess-1',
    serverResultTimeoutMs: 30 * 60 * 1000,
    sessionStates: {
      'sess-1': {
        isIdle: true,
        lastClientActivityAt: Date.now() - 2_000,
        messages: [],
        activeTools: [],
        activeAgents: [],
        pendingBackgroundShells: [],
        transcriptBackgroundTasks: [],
        scheduledWakeup: null,
        inactivityWarning: null,
        ...overrides,
      },
    },
  }
}

describe('ActivityIndicator — transcript background tasks (#5431)', () => {
  it('renders the transcript-task chip when idle with no PTY shells pending', () => {
    const now = Date.now()
    idleSessionState({
      transcriptBackgroundTasks: [
        { toolUseId: 'toolu_01', kind: 'bash', description: 'Wait for CI checks on PR #164', startedAt: now - 30_000 },
      ],
    })
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/Waiting on background work/)
    expect(label.textContent).toMatch(/Wait for CI checks on PR #164/)
    expect(screen.getByTestId('activity-indicator-transcript-tasks')).toBeTruthy()
  })

  it('headline is the most-recently-started task, with a +N more suffix', () => {
    const now = Date.now()
    idleSessionState({
      transcriptBackgroundTasks: [
        { toolUseId: 'toolu_01', kind: 'bash', description: 'old watcher', startedAt: now - 60_000 },
        { toolUseId: 'toolu_02', kind: 'agent', description: 'newest agent task', startedAt: now - 5_000 },
        { toolUseId: 'toolu_03', kind: 'monitor', description: 'mid monitor', startedAt: now - 30_000 },
      ],
    })
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/newest agent task/)
    expect(label.textContent).toMatch(/\+2 more/)
  })

  it('prefers the PTY pending-shell headline when both sources are present', () => {
    const now = Date.now()
    idleSessionState({
      pendingBackgroundShells: [
        { shellId: 'brk57kt6pm', command: 'npm run build', startedAt: now - 10_000 },
      ],
      transcriptBackgroundTasks: [
        { toolUseId: 'toolu_01', kind: 'bash', description: 'transcript watcher', startedAt: now - 5_000 },
      ],
    })
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    // The richer PTY command text wins the chip; transcript chip is the fallback.
    expect(label.textContent).toMatch(/npm run build/)
    expect(screen.queryByTestId('activity-indicator-transcript-tasks')).toBeNull()
  })

  it('renders the scheduled-wakeup chip when only a wakeup is armed', () => {
    const at = Date.now() + 20 * 60 * 1000
    idleSessionState({
      scheduledWakeup: { at, reason: 'watching CI run' },
    })
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    const d = new Date(at)
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(label.textContent).toMatch(new RegExp(`Resumes at ${hhmm}`))
    expect(label.textContent).toMatch(/watching CI run/)
    expect(screen.getByTestId('activity-indicator-scheduled-wakeup')).toBeTruthy()
  })

  it('renders nothing when idle with no outstanding work (no regression)', () => {
    idleSessionState({})
    const { container } = render(<ActivityIndicator />)
    expect(container.firstChild).toBeNull()
  })
})
