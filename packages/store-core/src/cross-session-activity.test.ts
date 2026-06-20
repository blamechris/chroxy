import { describe, expect, it } from 'vitest'
import type { ActivityEntry, ServerActivitySnapshotMessage } from '@chroxy/protocol'
import {
  createEmptyActivityState,
  applyActivitySnapshot,
  deriveSessionStatus,
  selectCrossSessionActivity,
  type ActivityState,
  type CrossSessionMeta,
} from './activity-reducer'

const T0 = 1_800_000_000_000

function entry(over: Partial<ActivityEntry> & Pick<ActivityEntry, 'id'>): ActivityEntry {
  const status = over.status ?? 'running'
  const terminal = status === 'done' || status === 'failed'
  return {
    id: over.id,
    kind: over.kind ?? 'tool',
    label: over.label ?? `label-${over.id}`,
    status,
    startedAt: over.startedAt ?? T0,
    endedAt: over.endedAt ?? (terminal ? T0 + 1000 : undefined),
    parentId: over.parentId,
    outputRef: over.outputRef,
  }
}

function snapshot(sessionId: string, entries: ActivityEntry[]): ServerActivitySnapshotMessage {
  return { type: 'activity_snapshot', sessionId, schemaVersion: 1, entries }
}

/** Build an ActivityState from { sessionId: entries[] }. */
function stateOf(map: Record<string, ActivityEntry[]>): ActivityState {
  let s = createEmptyActivityState()
  for (const [sid, entries] of Object.entries(map)) {
    s = applyActivitySnapshot(s, snapshot(sid, entries))
  }
  return s
}

describe('deriveSessionStatus', () => {
  it('is idle with no entries or only done entries', () => {
    expect(deriveSessionStatus([])).toBe('idle')
    expect(deriveSessionStatus([entry({ id: 'a', status: 'done' })])).toBe('idle')
  })
  it('is running when any entry runs (and none blocked)', () => {
    expect(deriveSessionStatus([entry({ id: 'a', status: 'done' }), entry({ id: 'b', status: 'running' })])).toBe('running')
  })
  it('is failed when a terminal failure exists and nothing is live', () => {
    expect(deriveSessionStatus([entry({ id: 'a', status: 'failed' }), entry({ id: 'b', status: 'done' })])).toBe('failed')
  })
  it('blocked beats running and failed (highest attention)', () => {
    expect(deriveSessionStatus([
      entry({ id: 'a', status: 'running' }),
      entry({ id: 'b', status: 'failed' }),
      entry({ id: 'c', status: 'blocked' }),
    ])).toBe('blocked')
  })
  it('running beats failed when both present', () => {
    expect(deriveSessionStatus([entry({ id: 'a', status: 'failed' }), entry({ id: 'b', status: 'running' })])).toBe('running')
  })
})

describe('selectCrossSessionActivity', () => {
  // Two tabs on the same repo (both the main checkout — realistic) + a third on
  // another repo. The worktree flag is exercised separately with a realistically
  // distinct-cwd worktree session (a worktree never shares its origin's cwd).
  const sessions: CrossSessionMeta[] = [
    { sessionId: 's1', cwd: '/home/u/repo-a', name: 'A1' },
    { sessionId: 's2', cwd: '/home/u/repo-a', name: 'A2' },
    { sessionId: 's3', cwd: '/home/u/repo-b', name: 'B1' },
  ]

  it('groups sessions by cwd and labels by last path segment', () => {
    const state = stateOf({
      s1: [entry({ id: 'e1', status: 'running' })],
      s2: [entry({ id: 'e2', status: 'blocked' })],
      s3: [entry({ id: 'e3', status: 'failed' })],
    })
    const agg = selectCrossSessionActivity(state, sessions)
    expect(agg.groups.map((g) => g.key)).toEqual(['/home/u/repo-a', '/home/u/repo-b'])
    expect(agg.groups.map((g) => g.label)).toEqual(['repo-a', 'repo-b'])
    // repo-a has both tabs s1 (running) + s2 (blocked).
    const a = agg.groups[0]!
    expect(a.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2'])
    expect(a.worktree).toBe(false)
    expect(a.rollup).toEqual({ running: 1, blocked: 1, failed: 0, idle: 0 })
    const b = agg.groups[1]!
    expect(b.worktree).toBe(false)
    expect(b.rollup).toEqual({ running: 0, blocked: 0, failed: 1, idle: 0 })
  })

  it('flags a group as worktree from a realistically distinct-cwd worktree session', () => {
    // A worktree session has its OWN cwd (never the origin checkout's), so it
    // forms its own group; that group is flagged worktree.
    const agg = selectCrossSessionActivity(createEmptyActivityState(), [
      { sessionId: 'main', cwd: '/home/u/repo-a', name: 'main' },
      { sessionId: 'wt', cwd: '/home/u/.chroxy/worktrees/repo-a-feat', name: 'feat', worktree: true },
    ])
    const main = agg.groups.find((g) => g.key === '/home/u/repo-a')!
    const wt = agg.groups.find((g) => g.key === '/home/u/.chroxy/worktrees/repo-a-feat')!
    expect(main.worktree).toBe(false)
    expect(wt.worktree).toBe(true)
    expect(wt.label).toBe('repo-a-feat')
  })

  it('computes the top-level total across all sessions', () => {
    const state = stateOf({
      s1: [entry({ id: 'e1', status: 'running' })],
      s2: [entry({ id: 'e2', status: 'blocked' })],
      s3: [entry({ id: 'e3', status: 'failed' })],
    })
    const agg = selectCrossSessionActivity(state, sessions)
    expect(agg.total).toEqual({ running: 1, blocked: 1, failed: 1, idle: 0 })
  })

  it('a session with no activity is idle and still appears in its group', () => {
    const state = stateOf({ s1: [entry({ id: 'e1', status: 'running' })] }) // s2/s3 have no activity
    const agg = selectCrossSessionActivity(state, sessions)
    expect(agg.total).toEqual({ running: 1, blocked: 0, failed: 0, idle: 2 })
    const a = agg.groups.find((g) => g.key === '/home/u/repo-a')!
    expect(a.sessions.find((s) => s.sessionId === 's2')!.status).toBe('idle')
  })

  it('puts sessions with no cwd into an Ungrouped bucket that sorts last', () => {
    const state = stateOf({ x: [entry({ id: 'e', status: 'running' })] })
    const agg = selectCrossSessionActivity(state, [
      { sessionId: 'x', cwd: '/home/u/repo-z', name: 'Z' },
      { sessionId: 'y', cwd: null, name: 'Y' },
      { sessionId: 'w', name: 'W' }, // cwd omitted entirely
      { sessionId: 'v', cwd: '   ', name: 'V' }, // whitespace-only → ungrouped
    ])
    const last = agg.groups[agg.groups.length - 1]!
    expect(last.key).toBe('')
    expect(last.label).toBe('Ungrouped')
    expect(last.sessions.map((s) => s.sessionId)).toEqual(['y', 'w', 'v'])
  })

  it('falls back the session name to the sessionId when name is omitted', () => {
    const agg = selectCrossSessionActivity(createEmptyActivityState(), [{ sessionId: 'sONLY', cwd: '/r' }])
    expect(agg.groups[0]!.sessions[0]!.name).toBe('sONLY')
  })

  it('is empty (no groups, zero total) for an empty session list', () => {
    const agg = selectCrossSessionActivity(stateOf({ s1: [entry({ id: 'e', status: 'running' })] }), [])
    expect(agg.groups).toEqual([])
    expect(agg.total).toEqual({ running: 0, blocked: 0, failed: 0, idle: 0 })
  })

  it('handles Windows-style cwd separators in the label', () => {
    const agg = selectCrossSessionActivity(createEmptyActivityState(), [
      { sessionId: 's', cwd: 'C:\\Users\\u\\repo-win', name: 'W' },
    ])
    expect(agg.groups[0]!.label).toBe('repo-win')
  })

  it('preserves caller (tab) order for sessions within a group', () => {
    const metas: CrossSessionMeta[] = [
      { sessionId: 'b', cwd: '/r', name: 'B' },
      { sessionId: 'a', cwd: '/r', name: 'A' },
      { sessionId: 'c', cwd: '/r', name: 'C' },
    ]
    const agg = selectCrossSessionActivity(createEmptyActivityState(), metas)
    expect(agg.groups[0]!.sessions.map((s) => s.sessionId)).toEqual(['b', 'a', 'c'])
  })

  it('counts a duplicate sessionId once (first occurrence wins)', () => {
    const state = stateOf({ dup: [entry({ id: 'e', status: 'blocked' })] })
    const agg = selectCrossSessionActivity(state, [
      { sessionId: 'dup', cwd: '/r', name: 'first' },
      { sessionId: 'dup', cwd: '/r', name: 'second' },
    ])
    expect(agg.groups[0]!.sessions.map((s) => s.name)).toEqual(['first'])
    expect(agg.groups[0]!.rollup).toEqual({ running: 0, blocked: 1, failed: 0, idle: 0 })
    expect(agg.total).toEqual({ running: 0, blocked: 1, failed: 0, idle: 0 })
  })

  it('labels a separators-only cwd as the raw cwd (a distinct real group, not Ungrouped)', () => {
    const agg = selectCrossSessionActivity(createEmptyActivityState(), [{ sessionId: 's', cwd: '/', name: 'root' }])
    expect(agg.groups[0]!.key).toBe('/')
    expect(agg.groups[0]!.label).toBe('/')
  })
})
