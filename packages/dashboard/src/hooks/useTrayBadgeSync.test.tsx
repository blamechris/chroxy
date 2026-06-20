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
// given status (enough for deriveSessionStatus → the rollup).
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

function setStore(activity: unknown, sessions: Array<{ sessionId: string; cwd?: string | null; name?: string }>) {
  storeState = { activity, sessions }
}

describe('useTrayBadgeSync (#6184)', () => {
  beforeEach(() => {
    invokeSpy.mockClear()
    invokeImpl = invokeSpy
  })
  afterEach(() => cleanup())

  it('invokes update_tray_badge with blocked + failed counts', () => {
    setStore(
      activityOf({ s1: 'blocked', s2: 'failed', s3: 'running' }),
      [{ sessionId: 's1', cwd: '/r' }, { sessionId: 's2', cwd: '/r' }, { sessionId: 's3', cwd: '/r' }],
    )
    render(<Harness />)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    expect(invokeSpy).toHaveBeenCalledWith('update_tray_badge', { blocked: 1, failed: 1 })
  })

  it('is a no-op outside Tauri (getTauriInvoke null)', () => {
    invokeImpl = null
    setStore(activityOf({ s1: 'blocked' }), [{ sessionId: 's1', cwd: '/r' }])
    render(<Harness />)
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('reports zero counts when nothing is blocked/failed', () => {
    setStore(activityOf({ s1: 'running' }), [{ sessionId: 's1', cwd: '/r' }])
    render(<Harness />)
    expect(invokeSpy).toHaveBeenCalledWith('update_tray_badge', { blocked: 0, failed: 0 })
  })

  it('does not re-invoke when the count is unchanged across re-renders (deduped)', () => {
    setStore(activityOf({ s1: 'blocked' }), [{ sessionId: 's1', cwd: '/r' }])
    const { rerender } = render(<Harness />)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    // Re-render with a NEW activity object ref but the SAME blocked/failed totals.
    setStore(activityOf({ s1: 'blocked' }), [{ sessionId: 's1', cwd: '/r' }])
    rerender(<Harness />)
    expect(invokeSpy).toHaveBeenCalledTimes(1) // deduped — count didn't change
  })

  it('re-invokes when the count changes', () => {
    setStore(activityOf({ s1: 'running' }), [{ sessionId: 's1', cwd: '/r' }])
    const { rerender } = render(<Harness />)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 0, failed: 0 })
    setStore(activityOf({ s1: 'blocked' }), [{ sessionId: 's1', cwd: '/r' }])
    rerender(<Harness />)
    expect(invokeSpy).toHaveBeenCalledTimes(2)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 1, failed: 0 })
  })
})
