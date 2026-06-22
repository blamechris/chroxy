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

// BLOCKED is passed in by the caller (#6225 — App reuses its header pending
// derivation); FAILED is read from the store's activity rollup inside the hook.
function Harness({ blocked }: { blocked: number }) {
  useTrayBadgeSync(blocked)
  return null
}

// Build an ActivityState where each sessionId maps to a single entry of the
// given status (enough for deriveSessionStatus → the rollup). FAILED sessions
// here drive the badge's `failed` slice.
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

function setStore(opts: {
  activity?: ReturnType<typeof activityOf>
  sessions?: Array<{ sessionId: string; cwd?: string | null; name?: string }>
}) {
  storeState = {
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

  it('invokes update_tray_badge with the passed-in blocked + derived failed counts', () => {
    setStore({
      activity: activityOf({ s2: 'failed', s3: 'running' }),
      sessions: [{ sessionId: 's2', cwd: '/r' }, { sessionId: 's3', cwd: '/r' }],
    })
    render(<Harness blocked={1} />)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    expect(invokeSpy).toHaveBeenCalledWith('update_tray_badge', { blocked: 1, failed: 1 })
  })

  it('passes the blocked count through verbatim', () => {
    setStore({})
    render(<Harness blocked={3} />)
    expect(invokeSpy).toHaveBeenCalledWith('update_tray_badge', { blocked: 3, failed: 0 })
  })

  it('is a no-op outside Tauri (getTauriInvoke null)', () => {
    invokeImpl = null
    setStore({})
    render(<Harness blocked={1} />)
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('reports zero counts when nothing is pending/failed', () => {
    setStore({ activity: activityOf({ s1: 'running' }), sessions: [{ sessionId: 's1', cwd: '/r' }] })
    render(<Harness blocked={0} />)
    expect(invokeSpy).toHaveBeenCalledWith('update_tray_badge', { blocked: 0, failed: 0 })
  })

  it('does not re-invoke when the count is unchanged across re-renders (deduped)', () => {
    setStore({})
    const { rerender } = render(<Harness blocked={1} />)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    setStore({})
    rerender(<Harness blocked={1} />)
    expect(invokeSpy).toHaveBeenCalledTimes(1) // deduped — count didn't change
  })

  it('re-invokes when the blocked count changes (e.g. a permission is answered)', () => {
    setStore({})
    const { rerender } = render(<Harness blocked={1} />)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 1, failed: 0 })
    rerender(<Harness blocked={0} />)
    expect(invokeSpy).toHaveBeenCalledTimes(2)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 0, failed: 0 })
  })
})
