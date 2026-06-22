import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

// Controlled store state + a spy invoke, both swappable per test.
let storeState: Record<string, unknown> = {}
const invokeSpy = vi.fn(async () => undefined)
let invokeImpl: typeof invokeSpy | null = invokeSpy

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}))
vi.mock('../utils/tauri-bridge', () => ({
  getTauriInvoke: () => invokeImpl,
}))

import { useTrayBadgeSync } from './useTrayBadgeSync'

function Harness() {
  useTrayBadgeSync()
  return null
}

// Build an ActivityState where each sessionId maps to a single entry of the
// given status (enough for deriveSessionStatus → the rollup). FAILED sessions
// here drive the badge's `failed` slice (best-effort activity rollup).
function activityOf(map: Record<string, 'running' | 'blocked' | 'failed'>) {
  const bySession: Record<string, { byId: Record<string, unknown>; order: string[] }> = {}
  for (const [sid, status] of Object.entries(map)) {
    const id = `e-${sid}`
    bySession[sid] = {
      byId: { [id]: { id, kind: 'tool', label: id, status, startedAt: 1, endedAt: status === 'failed' ? 2 : undefined } },
      order: [id],
    }
  }
  return { bySession }
}

// Build sessionStates carrying N live (unanswered, future-expiry) permission
// prompts per session. This is what now drives the badge's `blocked` slice —
// the SAME pending-permission derivation that powers the header "N pending"
// indicator (#6184 fix), not the activity-tree `blocked` status.
function sessionStatesWith(map: Record<string, number>) {
  const out: Record<string, { messages: unknown[] }> = {}
  for (const [sid, n] of Object.entries(map)) {
    const messages: unknown[] = []
    for (let i = 0; i < n; i++) {
      messages.push({
        id: `${sid}-p${i}`,
        type: 'prompt',
        content: 'Allow?',
        timestamp: 1,
        requestId: `${sid}-r${i}`,
        expiresAt: Date.now() + 5 * 60_000,
      })
    }
    out[sid] = { messages }
  }
  return out
}

function setStore(opts: {
  pending?: Record<string, number>
  activity?: ReturnType<typeof activityOf>
  sessions?: Array<{ sessionId: string; cwd?: string | null; name?: string }>
}) {
  storeState = {
    sessionStates: sessionStatesWith(opts.pending ?? {}),
    activity: opts.activity ?? { bySession: {} },
    sessions: opts.sessions ?? [],
  }
}

describe('useTrayBadgeSync (#6184)', () => {
  beforeEach(() => {
    invokeSpy.mockClear()
    invokeImpl = invokeSpy
  })
  afterEach(() => cleanup())

  it('invokes update_tray_badge with blocked (pending permissions) + failed counts', () => {
    setStore({
      pending: { s1: 1 },
      activity: activityOf({ s2: 'failed', s3: 'running' }),
      sessions: [{ sessionId: 's2', cwd: '/r' }, { sessionId: 's3', cwd: '/r' }],
    })
    render(<Harness />)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    expect(invokeSpy).toHaveBeenCalledWith('update_tray_badge', { blocked: 1, failed: 1 })
  })

  it('counts every pending permission across sessions for blocked', () => {
    setStore({ pending: { s1: 2, s2: 1 } })
    render(<Harness />)
    expect(invokeSpy).toHaveBeenCalledWith('update_tray_badge', { blocked: 3, failed: 0 })
  })

  it('is a no-op outside Tauri (getTauriInvoke null)', () => {
    invokeImpl = null
    setStore({ pending: { s1: 1 } })
    render(<Harness />)
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('reports zero counts when nothing is pending/failed', () => {
    setStore({ activity: activityOf({ s1: 'running' }), sessions: [{ sessionId: 's1', cwd: '/r' }] })
    render(<Harness />)
    expect(invokeSpy).toHaveBeenCalledWith('update_tray_badge', { blocked: 0, failed: 0 })
  })

  it('does not re-invoke when the count is unchanged across re-renders (deduped)', () => {
    setStore({ pending: { s1: 1 } })
    const { rerender } = render(<Harness />)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    // Re-render with NEW object refs but the SAME blocked/failed totals.
    setStore({ pending: { s1: 1 } })
    rerender(<Harness />)
    expect(invokeSpy).toHaveBeenCalledTimes(1) // deduped — count didn't change
  })

  it('re-invokes when the count changes (e.g. a permission is answered)', () => {
    setStore({ pending: { s1: 1 } })
    const { rerender } = render(<Harness />)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 1, failed: 0 })
    // The prompt is answered → no live pending permission remains → badge clears.
    setStore({ pending: {} })
    rerender(<Harness />)
    expect(invokeSpy).toHaveBeenCalledTimes(2)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 0, failed: 0 })
  })
})
