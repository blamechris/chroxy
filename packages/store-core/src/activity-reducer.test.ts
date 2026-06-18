import { describe, expect, it } from 'vitest'
import type {
  ActivityEntry,
  ServerActivitySnapshotMessage,
  ServerActivityDeltaMessage,
} from '@chroxy/protocol'
import {
  MAX_TERMINAL_ENTRIES_PER_SESSION,
  createEmptyActivityState,
  applyActivitySnapshot,
  applyActivityDelta,
  clearSessionActivity,
  selectSessionEntries,
  selectActivityTree,
  type ActivityState,
  type ActivityTreeNode,
} from './activity-reducer'

const T0 = 1_800_000_000_000

function entry(over: Partial<ActivityEntry> & Pick<ActivityEntry, 'id'>): ActivityEntry {
  return {
    id: over.id,
    kind: over.kind ?? 'tool',
    label: over.label ?? `label-${over.id}`,
    status: over.status ?? 'running',
    startedAt: over.startedAt ?? T0,
    endedAt: over.endedAt,
    parentId: over.parentId,
    outputRef: over.outputRef,
  }
}

function terminal(id: string, over: Partial<ActivityEntry> = {}): ActivityEntry {
  return entry({ id, status: 'done', endedAt: T0 + 1000, ...over })
}

function snapshot(sessionId: string, entries: ActivityEntry[]): ServerActivitySnapshotMessage {
  return { type: 'activity_snapshot', sessionId, schemaVersion: 1, entries }
}

function delta(
  sessionId: string,
  op: ServerActivityDeltaMessage['op'],
  e: ActivityEntry,
): ServerActivityDeltaMessage {
  return { type: 'activity_delta', sessionId, schemaVersion: 1, op, entry: e }
}

function ids(state: ActivityState, sessionId: string): string[] {
  return selectSessionEntries(state, sessionId).map((e) => e.id)
}

describe('createEmptyActivityState', () => {
  it('returns an empty bySession map', () => {
    expect(createEmptyActivityState()).toEqual({ bySession: {} })
  })
})

describe('applyActivitySnapshot', () => {
  it('replaces the session state with normalized entries in wire order', () => {
    const s = applyActivitySnapshot(createEmptyActivityState(), snapshot('s1', [
      entry({ id: 'a' }),
      entry({ id: 'b' }),
    ]))
    expect(ids(s, 's1')).toEqual(['a', 'b'])
    expect(s.bySession.s1!.byId.a!.label).toBe('label-a')
  })

  it('REPLACES (not merges) prior state for that session', () => {
    let s = applyActivitySnapshot(createEmptyActivityState(), snapshot('s1', [entry({ id: 'a' })]))
    s = applyActivitySnapshot(s, snapshot('s1', [entry({ id: 'b' })]))
    expect(ids(s, 's1')).toEqual(['b'])
  })

  it('leaves other sessions untouched', () => {
    let s = applyActivitySnapshot(createEmptyActivityState(), snapshot('s1', [entry({ id: 'a' })]))
    s = applyActivitySnapshot(s, snapshot('s2', [entry({ id: 'x' })]))
    expect(ids(s, 's1')).toEqual(['a'])
    expect(ids(s, 's2')).toEqual(['x'])
  })

  it('handles an empty snapshot as the valid "no activity" state', () => {
    let s = applyActivitySnapshot(createEmptyActivityState(), snapshot('s1', [entry({ id: 'a' })]))
    s = applyActivitySnapshot(s, snapshot('s1', []))
    expect(ids(s, 's1')).toEqual([])
  })

  it('resolves duplicate ids in one snapshot last-writer-wins', () => {
    const s = applyActivitySnapshot(createEmptyActivityState(), snapshot('s1', [
      entry({ id: 'a', label: 'first' }),
      entry({ id: 'a', label: 'second' }),
    ]))
    expect(ids(s, 's1')).toEqual(['a'])
    expect(s.bySession.s1!.byId.a!.label).toBe('second')
  })
})

describe('applyActivityDelta — upsert by id', () => {
  it('started adds a new entry', () => {
    const s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: 'a' })))
    expect(ids(s, 's1')).toEqual(['a'])
    expect(s.bySession.s1!.byId.a!.status).toBe('running')
  })

  it('updated upserts an existing entry (full replace)', () => {
    let s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: 'a', label: 'old' })))
    s = applyActivityDelta(s, delta('s1', 'updated', entry({ id: 'a', status: 'blocked', label: 'new' })))
    expect(s.bySession.s1!.byId.a!.status).toBe('blocked')
    expect(s.bySession.s1!.byId.a!.label).toBe('new')
  })

  it('updated for an unknown id creates the entry (self-healing dropped started)', () => {
    const s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'updated', entry({ id: 'a', label: 'recovered' })))
    expect(ids(s, 's1')).toEqual(['a'])
    expect(s.bySession.s1!.byId.a!.label).toBe('recovered')
  })

  it('ended upserts the terminal entry and keeps it', () => {
    let s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: 'a' })))
    s = applyActivityDelta(s, delta('s1', 'ended', terminal('a', { status: 'failed' })))
    expect(s.bySession.s1!.byId.a!.status).toBe('failed')
    expect(s.bySession.s1!.byId.a!.endedAt).toBe(T0 + 1000)
    expect(ids(s, 's1')).toEqual(['a'])
  })

  it('started for a known id replaces it (op is advisory)', () => {
    let s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: 'a', label: 'v1' })))
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'a', label: 'v2' })))
    expect(ids(s, 's1')).toEqual(['a'])
    expect(s.bySession.s1!.byId.a!.label).toBe('v2')
  })

  it('seeds a session that had no prior state', () => {
    const s = applyActivityDelta(createEmptyActivityState(), delta('newsession', 'started', entry({ id: 'a' })))
    expect(ids(s, 'newsession')).toEqual(['a'])
  })
})

describe('idempotency / out-of-order / duplicates', () => {
  it('a stale non-terminal updated after ended does NOT un-terminate', () => {
    let s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'ended', terminal('a', { status: 'done' })))
    s = applyActivityDelta(s, delta('s1', 'updated', entry({ id: 'a', status: 'running' })))
    expect(s.bySession.s1!.byId.a!.status).toBe('done')
    expect(s.bySession.s1!.byId.a!.endedAt).toBe(T0 + 1000)
  })

  it('a duplicate ended is idempotent (value-stable)', () => {
    const d = delta('s1', 'ended', terminal('a', { status: 'done' }))
    const s = applyActivityDelta(createEmptyActivityState(), d)
    const after = applyActivityDelta(s, d)
    // Equal endedAt is a last-writer-wins restate (may be a new ref) but the
    // observable state is unchanged: still one terminal entry, same fields.
    expect(ids(after, 's1')).toEqual(['a'])
    expect(after.bySession.s1!.byId.a).toEqual(s.bySession.s1!.byId.a)
  })

  it('a strictly-older duplicate ended is a true no-op (same ref)', () => {
    const s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'ended', terminal('a', { status: 'done', endedAt: T0 + 2000 })))
    const after = applyActivityDelta(s, delta('s1', 'ended', terminal('a', { status: 'done', endedAt: T0 + 1000 })))
    expect(after).toBe(s)
  })

  it('an out-of-order older terminal does not overwrite a newer terminal', () => {
    let s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'ended', terminal('a', { status: 'failed', endedAt: T0 + 5000 })))
    s = applyActivityDelta(s, delta('s1', 'ended', terminal('a', { status: 'done', endedAt: T0 + 1000 })))
    expect(s.bySession.s1!.byId.a!.status).toBe('failed')
    expect(s.bySession.s1!.byId.a!.endedAt).toBe(T0 + 5000)
  })

  it('a newer terminal does overwrite an older terminal', () => {
    let s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'ended', terminal('a', { status: 'done', endedAt: T0 + 1000 })))
    s = applyActivityDelta(s, delta('s1', 'ended', terminal('a', { status: 'failed', endedAt: T0 + 5000 })))
    expect(s.bySession.s1!.byId.a!.status).toBe('failed')
  })

  it('a no-op upsert returns the same top-level state reference', () => {
    let s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'ended', terminal('a')))
    const next = applyActivityDelta(s, delta('s1', 'updated', entry({ id: 'a', status: 'running' })))
    expect(next).toBe(s)
  })

  it('does not mutate the input state (immutability)', () => {
    const s0 = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: 'a' })))
    const before = JSON.stringify(s0)
    applyActivityDelta(s0, delta('s1', 'started', entry({ id: 'b' })))
    expect(JSON.stringify(s0)).toBe(before)
  })
})

describe('terminal-retention prune', () => {
  it('keeps at most N most-recently-ended terminal entries, evicting oldest', () => {
    let s = createEmptyActivityState()
    for (let i = 0; i < 5; i++) {
      s = applyActivityDelta(s, delta('s1', 'ended', terminal(`t${i}`, { endedAt: T0 + i * 100 })), 3)
    }
    // 5 terminal entries, cap 3 → oldest two (t0, t1) evicted.
    expect(ids(s, 's1')).toEqual(['t2', 't3', 't4'])
  })

  it('never prunes running / blocked entries', () => {
    let s = createEmptyActivityState()
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'live1', status: 'running' })), 1)
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'live2', status: 'blocked' })), 1)
    s = applyActivityDelta(s, delta('s1', 'ended', terminal('done1', { endedAt: T0 + 100 })), 1)
    s = applyActivityDelta(s, delta('s1', 'ended', terminal('done2', { endedAt: T0 + 200 })), 1)
    const remaining = ids(s, 's1')
    expect(remaining).toContain('live1')
    expect(remaining).toContain('live2')
    expect(remaining).toContain('done2') // newest terminal kept
    expect(remaining).not.toContain('done1') // oldest terminal pruned (cap 1)
  })

  it('prune also applies on snapshot', () => {
    const entries: ActivityEntry[] = []
    for (let i = 0; i < 5; i++) entries.push(terminal(`t${i}`, { endedAt: T0 + i * 100 }))
    const s = applyActivitySnapshot(createEmptyActivityState(), snapshot('s1', entries), 2)
    expect(ids(s, 's1')).toEqual(['t3', 't4'])
  })

  it('disables pruning for a negative cap', () => {
    let s = createEmptyActivityState()
    for (let i = 0; i < 5; i++) {
      s = applyActivityDelta(s, delta('s1', 'ended', terminal(`t${i}`, { endedAt: T0 + i })), -1)
    }
    expect(ids(s, 's1')).toHaveLength(5)
  })

  it('uses the documented default cap when none is passed', () => {
    expect(MAX_TERMINAL_ENTRIES_PER_SESSION).toBeGreaterThan(0)
    let s = createEmptyActivityState()
    for (let i = 0; i < MAX_TERMINAL_ENTRIES_PER_SESSION + 5; i++) {
      s = applyActivityDelta(s, delta('s1', 'ended', terminal(`t${i}`, { endedAt: T0 + i })))
    }
    expect(ids(s, 's1')).toHaveLength(MAX_TERMINAL_ENTRIES_PER_SESSION)
  })
})

describe('multi-session isolation', () => {
  it('deltas and snapshots only affect their own session', () => {
    let s = createEmptyActivityState()
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'a' })))
    s = applyActivityDelta(s, delta('s2', 'started', entry({ id: 'a' }))) // same id, different session
    s = applyActivityDelta(s, delta('s1', 'ended', terminal('a')))
    expect(s.bySession.s1!.byId.a!.status).toBe('done')
    expect(s.bySession.s2!.byId.a!.status).toBe('running')
  })

  it('clearSessionActivity drops only the target session', () => {
    let s = createEmptyActivityState()
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'a' })))
    s = applyActivityDelta(s, delta('s2', 'started', entry({ id: 'b' })))
    s = clearSessionActivity(s, 's1')
    expect(s.bySession.s1).toBeUndefined()
    expect(ids(s, 's2')).toEqual(['b'])
  })

  it('clearSessionActivity is a no-op (same ref) for an unknown session', () => {
    const s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: 'a' })))
    expect(clearSessionActivity(s, 'nope')).toBe(s)
  })
})

describe('selectActivityTree — hierarchy build', () => {
  it('returns empty for an unknown session', () => {
    expect(selectActivityTree(createEmptyActivityState(), 'nope')).toEqual([])
  })

  it('builds parent → child hierarchy from parentId', () => {
    let s = createEmptyActivityState()
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'root', kind: 'agent' })))
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'child1', parentId: 'root' })))
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'child2', parentId: 'root' })))
    const tree = selectActivityTree(s, 's1')
    expect(tree).toHaveLength(1)
    expect(tree[0]!.entry.id).toBe('root')
    expect(tree[0]!.children.map((c) => c.entry.id)).toEqual(['child1', 'child2'])
  })

  it('builds nested grandchildren', () => {
    let s = createEmptyActivityState()
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'a' })))
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'b', parentId: 'a' })))
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'c', parentId: 'b' })))
    const tree = selectActivityTree(s, 's1')
    expect(tree[0]!.children[0]!.children[0]!.entry.id).toBe('c')
  })

  it('treats an unknown parentId as a root (never drops the node)', () => {
    const s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: 'orphan', parentId: 'ghost' })))
    const tree = selectActivityTree(s, 's1')
    expect(tree).toHaveLength(1)
    expect(tree[0]!.entry.id).toBe('orphan')
  })

  it('treats a self-parenting entry as a root', () => {
    const s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: 'self', parentId: 'self' })))
    const tree = selectActivityTree(s, 's1')
    expect(tree).toHaveLength(1)
    expect(tree[0]!.entry.id).toBe('self')
    expect(tree[0]!.children).toEqual([])
  })

  it('does not infinite-loop on a parent cycle (a→b→a)', () => {
    let s = createEmptyActivityState()
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'a', parentId: 'b' })))
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'b', parentId: 'a' })))
    const tree = selectActivityTree(s, 's1')
    // Every entry reachable exactly once; no throw / hang.
    const flat: string[] = []
    const walk = (nodes: readonly ActivityTreeNode[]): void => {
      for (const n of nodes) {
        flat.push(n.entry.id)
        walk(n.children)
      }
    }
    walk(tree)
    expect(flat.sort()).toEqual(['a', 'b'])
  })

  it('orders roots and children by first-seen insertion order regardless of arrival', () => {
    // Child arrives before parent; snapshot order is authoritative.
    const s = applyActivitySnapshot(createEmptyActivityState(), snapshot('s1', [
      entry({ id: 'p' }),
      entry({ id: 'c2', parentId: 'p' }),
      entry({ id: 'c1', parentId: 'p' }),
    ]))
    const tree = selectActivityTree(s, 's1')
    expect(tree[0]!.children.map((c) => c.entry.id)).toEqual(['c2', 'c1'])
  })

  it('a child whose parent was pruned re-roots', () => {
    let s = createEmptyActivityState()
    // parent ends and gets pruned (cap 0 terminal kept), child stays running.
    s = applyActivityDelta(s, delta('s1', 'ended', terminal('parent', { endedAt: T0 + 100 })), 0)
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'kid', parentId: 'parent', status: 'running' })), 0)
    expect(s.bySession.s1!.byId.parent).toBeUndefined()
    const tree = selectActivityTree(s, 's1')
    expect(tree.map((n) => n.entry.id)).toEqual(['kid'])
  })

  it('#5248: does not overflow the stack on a deep parentId chain', () => {
    // A fully wire-controlled deep chain n0 ← n1 ← … would overflow a recursive
    // descent (RangeError, ~5k deep) inside the Control Room render. The iterative
    // build must handle it without throwing and still produce the full-depth tree.
    const N = 20000
    const entries = Array.from({ length: N }, (_, i) =>
      entry({ id: `n${i}`, parentId: i === 0 ? undefined : `n${i - 1}` }),
    )
    const s = applyActivitySnapshot(createEmptyActivityState(), snapshot('s1', entries))

    let tree: readonly ActivityTreeNode[] = []
    expect(() => { tree = selectActivityTree(s, 's1') }).not.toThrow()

    // One root, descending the full depth, each entry exactly once and in order.
    expect(tree).toHaveLength(1)
    let node: ActivityTreeNode | undefined = tree[0]
    let depth = 0
    while (node) {
      expect(node.entry.id).toBe(`n${depth}`)
      expect(node.children.length).toBeLessThanOrEqual(1)
      depth += 1
      node = node.children[0]
    }
    expect(depth).toBe(N)
  })
})

describe('selectSessionEntries', () => {
  it('returns the flat insertion-ordered list', () => {
    let s = createEmptyActivityState()
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'b' })))
    s = applyActivityDelta(s, delta('s1', 'started', entry({ id: 'a' })))
    expect(selectSessionEntries(s, 's1').map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('returns empty for an unknown session', () => {
    expect(selectSessionEntries(createEmptyActivityState(), 'nope')).toEqual([])
  })
})

describe('prototype-key safety (wire-controlled ids/sessionIds)', () => {
  // `byId` / `bySession` are keyed off wire strings. Plain `{}` + `in` would
  // misdetect inherited Object.prototype members as present and let
  // `obj["__proto__"] = entry` mutate the prototype. These lock in the
  // null-prototype hardening.
  const PROTO_KEYS = ['__proto__', 'toString', 'constructor', 'hasOwnProperty']

  for (const key of PROTO_KEYS) {
    it(`delta appends an id of "${key}" to order and upserts it`, () => {
      let s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: key, label: 'v1' })))
      expect(selectSessionEntries(s, 's1').map((e) => e.id)).toEqual([key])
      // a second started for the same proto-key id replaces in place (no dupe in order)
      s = applyActivityDelta(s, delta('s1', 'started', entry({ id: key, label: 'v2' })))
      expect(selectSessionEntries(s, 's1').map((e) => e.id)).toEqual([key])
      expect(selectSessionEntries(s, 's1')[0]!.label).toBe('v2')
    })

    it(`snapshot dedupes a proto-key id "${key}" via own-property check`, () => {
      const s = applyActivitySnapshot(createEmptyActivityState(), snapshot('s1', [
        entry({ id: key, label: 'first' }),
        entry({ id: key, label: 'second' }),
        entry({ id: 'normal' }),
      ]))
      expect(selectSessionEntries(s, 's1').map((e) => e.id)).toEqual([key, 'normal'])
      expect(selectSessionEntries(s, 's1')[0]!.label).toBe('second')
    })

    it(`a parentId of "${key}" that is not a real entry re-roots the child`, () => {
      const s = applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: 'child', parentId: key })))
      const tree = selectActivityTree(s, 's1')
      expect(tree.map((n) => n.entry.id)).toEqual(['child'])
    })

    it(`a sessionId of "${key}" is isolated and clearable`, () => {
      let s = applyActivityDelta(createEmptyActivityState(), delta(key, 'started', entry({ id: 'a' })))
      expect(selectSessionEntries(s, key).map((e) => e.id)).toEqual(['a'])
      s = clearSessionActivity(s, key)
      expect(selectSessionEntries(s, key)).toEqual([])
    })
  }

  it('does not pollute Object.prototype when an id is "__proto__"', () => {
    applyActivityDelta(createEmptyActivityState(), delta('s1', 'started', entry({ id: '__proto__', label: 'x' })))
    // If the prototype were mutated, {}.label would be 'x'.
    expect(({} as Record<string, unknown>).label).toBeUndefined()
  })
})
