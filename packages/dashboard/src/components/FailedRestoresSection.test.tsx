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

const state = {
  failedRestores: null as ServerFailedRestoresListMessage | null,
  failedRestoresLoading: false,
  connectionPhase: 'connected' as string,
  retryingRestoreIds: new Set<string>(),
  retryRestoreResults: {} as Record<string, { ok: boolean; code?: string; message?: string }>,
  requestFailedRestores: vi.fn(() => true),
  sendRetryFailedRestore: vi.fn(() => true),
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
