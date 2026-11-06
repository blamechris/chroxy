import { describe, it, expect } from 'vitest'
import { buildSessionListPatches } from './handlers/session-list'
import { applyActivityDelta, applyActivitySnapshot, createEmptyActivityState, reconcileSessionDecision } from './activity-state'
import type { ActivityEntry, DeclaredStatus } from '@chroxy/protocol'
const status: DeclaredStatus = { state: 'blocked', summary: 'Review', decision: 'Choose target', source: 'marker', updatedAt: 50 }
const first: ActivityEntry = { id: 'decision:session', kind: 'decision', status: 'blocked', label: 'Choose target', startedAt: 100 }
const delta = (entry: ActivityEntry) => ({ type: 'activity_delta' as const, sessionId: 'b', schemaVersion: 1, op: (entry.endedAt === undefined ? 'updated' : 'ended') as 'updated' | 'ended', entry })
describe('visible-session decision lifetime reconciliation', () => {
  it('seeds original timestamps while preserving unrelated work and stable identity', () => {
    let s = applyActivityDelta(createEmptyActivityState(), delta({ id: 'tool', kind: 'tool', status: 'blocked', label: 'Allow?', startedAt: 10 }))
    s = reconcileSessionDecision(s, 'b', { startedAt: 100, endedAt: 0 }, status)
    expect(s.bySession.b!.byId['decision:session']).toEqual(first)
    expect(s.bySession.b!.byId.tool).toBeDefined()
    s = applyActivityDelta(s, delta(first))
    s = reconcileSessionDecision(s, 'b', { startedAt: 100, endedAt: 0 }, { ...status, updatedAt: 1000 })
    expect(s.bySession.b!.order.filter((id) => id === 'decision:session')).toHaveLength(1)
    s = reconcileSessionDecision(s, 'b', { endedAt: 100 }, { ...status, decision: 'none' })
    expect(s.bySession.b!.byId.tool).toBeDefined()
  })
  it('replays clear without invented entries; ties, rollback and delayed old events stay ordered', () => {
    let s = reconcileSessionDecision(createEmptyActivityState(), 'b', { startedAt: 100, endedAt: 0 }, status)
    s = reconcileSessionDecision(s, 'b', { endedAt: 100 }, { ...status, decision: 'none' })
    expect(s.bySession.b!.byId['decision:session']).toBeUndefined()
    expect(s.bySession.b!.decisionEndedAt).toBe(100)
    s = applyActivitySnapshot(s, { type: 'activity_snapshot', sessionId: 'b', schemaVersion: 1, entries: [] })
    s = applyActivityDelta(s, delta(first))
    expect(s.bySession.b!.byId['decision:session']).toBeUndefined()
    s = reconcileSessionDecision(s, 'b', { startedAt: 101, endedAt: 100 }, { ...status, updatedAt: 1, decision: 'New target' })
    s = applyActivityDelta(s, delta({ ...first, status: 'done', endedAt: 100 }))
    s = reconcileSessionDecision(s, 'b', { endedAt: 100 }, { ...status, decision: 'none' })
    expect(s.bySession.b!.byId['decision:session']!.label).toBe('New target')
    expect(s.bySession.b!.byId['decision:session']!.startedAt).toBe(101)
  })
  it('clear fence survives terminal pruning and rejects stale full snapshots', () => {
    let s = applyActivityDelta(createEmptyActivityState(), delta({ ...first, status: 'done', endedAt: 100 }), 0)
    expect(s.bySession.b!.byId['decision:session']).toBeUndefined()
    s = applyActivitySnapshot(s, { type: 'activity_snapshot', sessionId: 'b', schemaVersion: 1, entries: [first] })
    expect(s.bySession.b!.byId['decision:session']).toBeUndefined()
    expect(s.bySession.b!.decisionEndedAt).toBe(100)
  })
  it('treats omitted or malformed old-server metadata as no opinion', () => {
    const patches = buildSessionListPatches({ sessions: [
      { sessionId: 'a', name: 'a' },
      { sessionId: 'b', name: 'b', declaredStatus: { ...status, summary: 'x'.repeat(281) }, decisionActivity: { startedAt: 100, endedAt: 100 } },
      { sessionId: 'c', name: 'c', decisionActivity: { endedAt: 100, extra: 1 } },
    ] }, [], 'a')!;
    expect(patches.declaredStatusPatches.size).toBe(0);
    expect(patches.decisionActivityPatches.size).toBe(0);
  });

})
