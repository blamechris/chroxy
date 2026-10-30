/**
 * FailedRestoresSection (#7625) — renderer tests.
 *
 * The states that matter here are the three empties, which look identical in a
 * naive implementation and mean different things:
 *   - `null`      → not asked yet
 *   - `[]`        → asked, nothing failed
 *   - `refused`   → asked, and this token may not see it
 * Rendering "Every saved session was restored" for the first or third would be
 * an authoritative claim the dashboard has no basis for.
 *
 * Also covers: Retry dispatches for the right row, pending disables only that
 * row, a failed result renders inline, and Refresh is disabled while loading.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerFailedRestoresListMessage } from '@chroxy/protocol'
import type { FailedRestoreHistoryView } from '../store/types'

const state = {
  failedRestores: null as ServerFailedRestoresListMessage | null,
  failedRestoresLoading: false,
  connectionPhase: 'connected' as string,
  retryingRestoreIds: new Set<string>(),
  retryRestoreResults: {} as Record<string, { ok: boolean; code?: string; message?: string }>,
  requestFailedRestores: vi.fn(() => true),
  sendRetryFailedRestore: vi.fn(() => true),
  failedRestoreHistories: {} as Record<string, FailedRestoreHistoryView>,
  requestFailedRestoreHistory: vi.fn(() => true),
  closeFailedRestoreHistory: vi.fn(),
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => selector(state),
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }))

import { FailedRestoresSection } from './FailedRestoresSection'

// This repo's RTL has no auto-cleanup — a leaked tree fails the NEXT file.
afterEach(() => {
  cleanup()
  state.failedRestores = null
  state.failedRestoresLoading = false
  state.connectionPhase = 'connected'
  state.retryingRestoreIds = new Set<string>()
  state.retryRestoreResults = {}
  state.failedRestoreHistories = {}
  vi.clearAllMocks()
})

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function snapshot(over: Partial<ServerFailedRestoresListMessage> = {}): ServerFailedRestoresListMessage {
  return {
    type: 'failed_restores_list',
    generatedAt: '2026-09-04T00:00:00.000Z',
    restores: [
      {
        sessionId: A,
        name: 'Nightly agent',
        provider: 'claude',
        cwd: '/srv/work/chroxy',
        errorCode: 'ENVIRONMENT_STOPPED',
        errorMessage: 'environment is not running',
        needsAttention: true,
        historyLength: 4,
      },
    ],
    ...over,
  } as ServerFailedRestoresListMessage
}

describe('FailedRestoresSection (#7625)', () => {
  it('does NOT claim everything restored before the roster has been asked for', () => {
    render(<FailedRestoresSection />)
    expect(screen.queryByTestId('failed-restores-empty')).toBeNull()
  })

  it('says everything restored only for a genuinely empty roster', () => {
    state.failedRestores = snapshot({ restores: [] })
    render(<FailedRestoresSection />)
    expect(screen.getByTestId('failed-restores-empty')).toBeTruthy()
  })

  it('explains a refusal instead of claiming nothing failed', () => {
    state.failedRestores = snapshot({ restores: [], refused: true })
    render(<FailedRestoresSection />)
    expect(screen.getByTestId('failed-restores-refused')).toBeTruthy()
    expect(screen.queryByTestId('failed-restores-empty')).toBeNull()
  })

  it('renders a parked row with its error and preserved-history count', () => {
    state.failedRestores = snapshot()
    render(<FailedRestoresSection />)
    expect(screen.getByTestId(`failed-restore-${A}`)).toBeTruthy()
    expect(screen.getByText('Nightly agent')).toBeTruthy()
    expect(screen.getByText('ENVIRONMENT_STOPPED')).toBeTruthy()
    expect(screen.getByText('4 messages preserved')).toBeTruthy()
  })

  it('Retry dispatches for that row', () => {
    state.failedRestores = snapshot()
    render(<FailedRestoresSection />)
    fireEvent.click(screen.getByTestId(`failed-restore-retry-${A}`))
    expect(state.sendRetryFailedRestore).toHaveBeenCalledWith(A)
  })

  it('a pending retry disables that row and shows progress', () => {
    state.failedRestores = snapshot()
    state.retryingRestoreIds = new Set([A])
    render(<FailedRestoresSection />)
    const btn = screen.getByTestId(`failed-restore-retry-${A}`) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toContain('Retrying')
  })

  it('renders a failed retry inline, and reads NOT_FOUND as a stale button', () => {
    state.failedRestores = snapshot()
    state.retryRestoreResults = { [A]: { ok: false, code: 'FAILED_RESTORE_NOT_FOUND' } }
    render(<FailedRestoresSection />)
    expect(screen.getByTestId(`failed-restore-result-${A}`).textContent).toContain('no longer parked')
  })

  it('both buttons are type=button, so a surrounding form cannot submit', () => {
    // Copilot, #7631 review — the dashboard convention (ControlRoomView,
    // ByokPoolSection). An implicit type="submit" would post the enclosing form
    // if this section is ever rendered inside one.
    state.failedRestores = snapshot()
    render(<FailedRestoresSection />)
    expect((screen.getByTestId('failed-restores-refresh') as HTMLButtonElement).type).toBe('button')
    expect((screen.getByTestId(`failed-restore-retry-${A}`) as HTMLButtonElement).type).toBe('button')
  })

  it('Refresh is disabled while loading and while disconnected', () => {
    state.failedRestores = snapshot()
    state.failedRestoresLoading = true
    render(<FailedRestoresSection />)
    expect((screen.getByTestId('failed-restores-refresh') as HTMLButtonElement).disabled).toBe(true)
    cleanup()

    state.failedRestoresLoading = false
    state.connectionPhase = 'disconnected'
    render(<FailedRestoresSection />)
    expect((screen.getByTestId('failed-restores-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('FailedRestoresSection — View history (#8860)', () => {
  const toggle = () => screen.getByTestId(`failed-restore-history-toggle-${A}`) as HTMLButtonElement
  const view = (over: Partial<FailedRestoreHistoryView> = {}): FailedRestoreHistoryView => ({
    entries: [], total: 0, loading: false, pendingOffset: null, ...over,
  })

  it('offers a type=button View history toggle per row, opening requests page one', () => {
    state.failedRestores = snapshot()
    render(<FailedRestoresSection />)
    expect(toggle().type).toBe('button')
    expect(toggle().textContent).toBe('View history')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId(`failed-restore-history-${A}`)).toBeNull()

    fireEvent.click(toggle())
    expect(state.requestFailedRestoreHistory).toHaveBeenCalledWith(A)
    expect(state.closeFailedRestoreHistory).not.toHaveBeenCalled()
  })

  it('an open view shows the panel and the toggle closes it', () => {
    state.failedRestores = snapshot()
    state.failedRestoreHistories = { [A]: view({ loading: true, pendingOffset: 0, total: null }) }
    render(<FailedRestoresSection />)
    expect(screen.getByTestId(`failed-restore-history-${A}`)).toBeTruthy()
    expect(screen.getByTestId(`failed-restore-history-loading-${A}`)).toBeTruthy()
    expect(toggle().textContent).toBe('Hide history')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle())
    expect(state.closeFailedRestoreHistory).toHaveBeenCalledWith(A)
    expect(state.requestFailedRestoreHistory).not.toHaveBeenCalled()
  })

  it('opening is disabled while disconnected, closing is not', () => {
    state.failedRestores = snapshot()
    state.connectionPhase = 'disconnected'
    render(<FailedRestoresSection />)
    expect(toggle().disabled).toBe(true)
    cleanup()

    state.failedRestoreHistories = { [A]: view() }
    render(<FailedRestoresSection />)
    expect(toggle().disabled).toBe(false)
  })

  it('renders each entry kind as plain text, never as markup', () => {
    state.failedRestores = snapshot()
    state.failedRestoreHistories = {
      [A]: view({
        total: 5,
        entries: [
          { type: 'message', messageType: 'user_input', content: 'run the <b>tests</b>' },
          { type: 'message', messageType: 'response', content: 'done <img src=x onerror=alert(1)>' },
          { type: 'tool_start', tool: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_result', result: 'all green\nsecond line' },
          { type: 'result', duration: 2500, cost: 0.0123 },
        ],
      }),
    }
    render(<FailedRestoresSection />)
    const panel = screen.getByTestId(`failed-restore-history-${A}`)

    expect(screen.getByText('You')).toBeTruthy()
    expect(screen.getByText('Assistant')).toBeTruthy()
    // Markup in the transcript is TEXT: present verbatim, no element created.
    expect(panel.textContent).toContain('run the <b>tests</b>')
    expect(panel.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(panel.querySelector('b')).toBeNull()
    expect(panel.querySelector('img')).toBeNull()

    expect(screen.getByTestId('fr-hist-tool-start').textContent).toContain('Bash')
    expect(screen.getByTestId('fr-hist-tool-start').textContent).toContain('npm test')
    // tool_result is collapsed to a one-line summary inside <details>.
    const tr = screen.getByTestId('fr-hist-tool-result')
    expect(tr.querySelector('details')).toBeTruthy()
    expect(tr.querySelector('summary')!.textContent).toContain('all green second line')
    expect(screen.getByTestId('fr-hist-result').textContent).toBe('Turn finished · 2.5s · $0.0123')
    expect(screen.getByTestId(`failed-restore-history-count-${A}`).textContent).toBe('Showing 5 of 5')
  })

  it('shows an unknown entry type as a bare label rather than dropping it', () => {
    state.failedRestores = snapshot()
    state.failedRestoreHistories = { [A]: view({ total: 1, entries: [{ type: 'permission_outcome' }] }) }
    render(<FailedRestoresSection />)
    expect(screen.getByTestId('fr-hist-other').textContent).toBe('permission_outcome')
  })

  it('Load more appears only while entries < total, and requests the next page', () => {
    state.failedRestores = snapshot()
    state.failedRestoreHistories = {
      [A]: view({ total: 120, entries: Array.from({ length: 50 }, (_, i) => ({ type: 'message', messageType: 'response', content: `m${i}` })) }),
    }
    render(<FailedRestoresSection />)
    expect(screen.getByTestId(`failed-restore-history-count-${A}`).textContent).toBe('Showing 50 of 120')
    const more = screen.getByTestId(`failed-restore-history-more-${A}`) as HTMLButtonElement
    expect(more.type).toBe('button')
    fireEvent.click(more)
    expect(state.requestFailedRestoreHistory).toHaveBeenCalledWith(A, true)
    cleanup()

    state.failedRestoreHistories = {
      [A]: view({ total: 50, entries: Array.from({ length: 50 }, () => ({ type: 'message', content: 'x' })) }),
    }
    render(<FailedRestoresSection />)
    expect(screen.queryByTestId(`failed-restore-history-more-${A}`)).toBeNull()
  })

  it('Load more is disabled while a page is in flight', () => {
    state.failedRestores = snapshot()
    state.failedRestoreHistories = {
      [A]: view({ total: 120, loading: true, pendingOffset: 50, entries: [{ type: 'message', content: 'x' }] }),
    }
    render(<FailedRestoresSection />)
    expect((screen.getByTestId(`failed-restore-history-more-${A}`) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says nothing was preserved only for a loaded, empty history', () => {
    state.failedRestores = snapshot()
    state.failedRestoreHistories = { [A]: view({ total: 0, entries: [] }) }
    render(<FailedRestoresSection />)
    expect(screen.getByTestId(`failed-restore-history-empty-${A}`)).toBeTruthy()
  })

  it('explains a bound-client refusal and does not offer a retry of it', () => {
    state.failedRestores = snapshot()
    state.failedRestoreHistories = {
      [A]: view({ total: null, error: { code: 'FAILED_RESTORE_HISTORY_FORBIDDEN_BOUND_CLIENT', refused: true } }),
    }
    render(<FailedRestoresSection />)
    expect(screen.getByTestId(`failed-restore-history-error-${A}`).textContent).toContain('primary token')
    expect(screen.queryByTestId(`failed-restore-history-empty-${A}`)).toBeNull()
    expect(screen.queryByTestId(`failed-restore-history-reload-${A}`)).toBeNull()
  })

  it('reads NOT_FOUND as a stale entry, not as an empty history', () => {
    state.failedRestores = snapshot()
    state.failedRestoreHistories = { [A]: view({ total: null, error: { code: 'FAILED_RESTORE_NOT_FOUND' } }) }
    render(<FailedRestoresSection />)
    expect(screen.getByTestId(`failed-restore-history-error-${A}`).textContent).toContain('no longer parked')
    expect(screen.queryByTestId(`failed-restore-history-empty-${A}`)).toBeNull()
  })

  it('a failed later page keeps the entries and offers to retry loading more', () => {
    state.failedRestores = snapshot()
    state.failedRestoreHistories = {
      [A]: view({ total: 120, entries: [{ type: 'message', content: 'kept' }], error: { code: 'X', message: 'boom' } }),
    }
    render(<FailedRestoresSection />)
    expect(screen.getByText('kept')).toBeTruthy()
    expect(screen.getByTestId(`failed-restore-history-error-${A}`).textContent).toBe('boom')
    fireEvent.click(screen.getByTestId(`failed-restore-history-more-${A}`))
    expect(state.requestFailedRestoreHistory).toHaveBeenCalledWith(A, true)
  })
})
