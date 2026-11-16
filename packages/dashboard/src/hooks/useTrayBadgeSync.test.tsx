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

// Run the real selector but record its result: totals alone cannot expose a
// dropped repoCwd because regrouping deliberately leaves totals unchanged.
vi.mock('@chroxy/store-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chroxy/store-core')>()
  return { ...actual, selectCrossSessionActivity: vi.fn(actual.selectCrossSessionActivity) }
})
import { selectCrossSessionActivity } from '@chroxy/store-core'
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
  sessions?: Array<{ sessionId: string; cwd?: string | null; name?: string; repoCwd?: string | null; worktree?: boolean }>
}) {
  storeState = {
    activity: opts.activity ?? { bySession: {} },
    sessions: opts.sessions ?? [],
  }
}

describe('useTrayBadgeSync (#6184)', () => {
  beforeEach(() => {
    vi.mocked(selectCrossSessionActivity).mockClear()
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

  it('does not re-invoke when blocked + failed are unchanged across re-renders', () => {
    setStore({})
    const { rerender } = render(<Harness blocked={1} />)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    setStore({})
    rerender(<Harness blocked={1} />)
    // No second invoke: the effect's [blocked, failed] deps are unchanged so the
    // effect doesn't re-run (and the lastSentRef key-guard would suppress a
    // duplicate anyway if it did, e.g. under StrictMode's double-invoke).
    expect(invokeSpy).toHaveBeenCalledTimes(1)
  })

  it('re-invokes when the blocked count changes (e.g. a permission is answered)', () => {
    setStore({})
    const { rerender } = render(<Harness blocked={1} />)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 1, failed: 0 })
    rerender(<Harness blocked={0} />)
    expect(invokeSpy).toHaveBeenCalledTimes(2)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 0, failed: 0 })
  })

  // #6227 — the dedup key is `${blocked}:${failed}`, so a change to the FAILED
  // slice alone (blocked held constant) must also re-invoke. The other re-invoke
  // test only varies `blocked`; this covers the failed-only edge.
  it('re-invokes when only the failed count changes (blocked constant)', () => {
    setStore({ activity: activityOf({ s1: 'running' }), sessions: [{ sessionId: 's1', cwd: '/r' }] })
    const { rerender } = render(<Harness blocked={1} />)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 1, failed: 0 })
    // Flip the session running -> failed; blocked stays 1 so only `failed` moves.
    setStore({ activity: activityOf({ s1: 'failed' }), sessions: [{ sessionId: 's1', cwd: '/r' }] })
    rerender(<Harness blocked={1} />)
    expect(invokeSpy).toHaveBeenCalledTimes(2)
    expect(invokeSpy).toHaveBeenLastCalledWith('update_tray_badge', { blocked: 1, failed: 1 })
  })
})

describe('repository metadata through the tray adapter (#8199)', () => {
  afterEach(cleanup)
  it('retains repoCwd for the shared selector while keeping bridge totals and deduplication unchanged', () => {
    invokeSpy.mockClear()
    invokeImpl = invokeSpy
    vi.mocked(selectCrossSessionActivity).mockClear()
    const repo = '/srv/projects/chroxy'
    setStore({
      sessions: [
        { sessionId: 'wt-b', cwd: '/worktrees/22222222222222222222222222222222', repoCwd: repo, worktree: true },
        { sessionId: 'main', cwd: repo },
        { sessionId: 'wt-a', cwd: '/worktrees/11111111111111111111111111111111', repoCwd: repo, worktree: true },
      ],
      activity: activityOf({ 'wt-b': 'failed', main: 'running', 'wt-a': 'failed' }),
    })
    const { rerender } = render(<Harness blocked={3} />)
    const result = vi.mocked(selectCrossSessionActivity).mock.results[0]!.value as ReturnType<typeof selectCrossSessionActivity>
    expect(result.groups.map((g) => [g.key, g.label])).toEqual([[repo, 'chroxy']])
    expect(result.groups[0]!.sessions.map((s) => s.sessionId)).toEqual(['wt-b', 'main', 'wt-a'])
    expect(result.total).toEqual({ running: 1, blocked: 0, failed: 2, idle: 0 })
    expect(invokeSpy).toHaveBeenCalledWith('update_tray_badge', { blocked: 3, failed: 2 })
    storeState = { ...storeState, sessions: (storeState.sessions as Array<{ sessionId: string }>).map((s) => ({ ...s, cwd: '/moved/' + s.sessionId })) }
    rerender(<Harness blocked={3} />)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
  })
})
