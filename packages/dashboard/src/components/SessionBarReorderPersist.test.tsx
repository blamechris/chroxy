/**
 * SessionBar drag-reorder + persistence integration test (#4831)
 *
 * Acceptance criterion from #4831: "Regression test: tab order survives a
 * `window.location.reload()` in a vitest jsdom test." This test pairs the
 * SessionBar drop handler with the persistence helper and `unmount` →
 * remount to simulate a reload, asserting the dragged order is reapplied.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'
import { useState, useMemo } from 'react'
import { SessionBar, type SessionTabData } from './SessionBar'
import {
  loadPersistedSessionTabOrder,
  persistSessionTabOrder,
  setServerScope,
  _resetForTesting,
} from '../store/persistence'

beforeEach(() => {
  localStorage.clear()
  _resetForTesting()
  setServerScope(null)
})
afterEach(cleanup)

// Minimal harness that mirrors the App.tsx wiring: load persisted order on
// mount, apply it as an overlay on the server-supplied `sessions`, and
// persist on every reorder. Lives inline so the test exercises the actual
// production helpers (no double of `persistSessionTabOrder` / loader).
function Harness({ sessions: rawSessions }: { sessions: SessionTabData[] }) {
  const [tabOrder, setTabOrder] = useState<string[]>(() => loadPersistedSessionTabOrder())
  const ordered = useMemo(() => {
    const byId = new Map(rawSessions.map(s => [s.sessionId, s]))
    const out: SessionTabData[] = []
    const seen = new Set<string>()
    for (const id of tabOrder) {
      const s = byId.get(id)
      if (s && !seen.has(id)) { out.push(s); seen.add(id) }
    }
    for (const s of rawSessions) {
      if (!seen.has(s.sessionId)) out.push(s)
    }
    return out
  }, [rawSessions, tabOrder])
  return (
    <SessionBar
      sessions={ordered}
      onSwitch={vi.fn()}
      onClose={vi.fn()}
      onRename={vi.fn()}
      onNewSession={vi.fn()}
      onReorder={next => {
        setTabOrder(next)
        persistSessionTabOrder(next)
      }}
    />
  )
}

function makeDataTransfer() {
  return {
    data: {} as Record<string, string>,
    setData(format: string, val: string) { this.data[format] = val },
    getData(format: string) { return this.data[format] ?? '' },
    effectAllowed: 'all',
    dropEffect: 'none',
    types: [] as string[],
  }
}

describe('#4831 drag-reorder + persistence integration', () => {
  it('persists the new order to localStorage on drop', () => {
    const sessions: SessionTabData[] = [
      { sessionId: 'a', name: 'Alpha', isBusy: false, isActive: true },
      { sessionId: 'b', name: 'Beta', isBusy: false, isActive: false },
      { sessionId: 'c', name: 'Charlie', isBusy: false, isActive: false },
    ]
    render(<Harness sessions={sessions} />)
    const dt = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('session-tab-a'), { dataTransfer: dt })
    fireEvent.dragOver(screen.getByTestId('session-tab-c'), { dataTransfer: dt })
    fireEvent.drop(screen.getByTestId('session-tab-c'), { dataTransfer: dt })
    // Persisted order matches the in-memory reorder
    expect(loadPersistedSessionTabOrder()).toEqual(['b', 'a', 'c'])
  })

  it('tab order survives a simulated window.location.reload()', () => {
    const sessions: SessionTabData[] = [
      { sessionId: 'a', name: 'Alpha', isBusy: false, isActive: true },
      { sessionId: 'b', name: 'Beta', isBusy: false, isActive: false },
      { sessionId: 'c', name: 'Charlie', isBusy: false, isActive: false },
    ]
    const first = render(<Harness sessions={sessions} />)
    // Drag "c" onto "a" — expected order: ["c", "a", "b"]
    const dt = makeDataTransfer()
    fireEvent.dragStart(screen.getByTestId('session-tab-c'), { dataTransfer: dt })
    fireEvent.dragOver(screen.getByTestId('session-tab-a'), { dataTransfer: dt })
    fireEvent.drop(screen.getByTestId('session-tab-a'), { dataTransfer: dt })
    // Sanity: the in-memory render reflects the new order
    let tabs = document.querySelectorAll<HTMLElement>('[role="tab"]')
    expect(Array.from(tabs).map(t => t.dataset.testid)).toEqual([
      'session-tab-c', 'session-tab-a', 'session-tab-b',
    ])
    first.unmount()
    // "Reload": React tree goes away, localStorage survives. New tree
    // reads the persisted order on mount and applies it.
    render(<Harness sessions={sessions} />)
    tabs = document.querySelectorAll<HTMLElement>('[role="tab"]')
    expect(Array.from(tabs).map(t => t.dataset.testid)).toEqual([
      'session-tab-c', 'session-tab-a', 'session-tab-b',
    ])
  })

  it('new server-supplied sessions append at the end of the persisted order', () => {
    // Persist an existing order, then introduce a brand-new session id —
    // the new one should land at the end, not break the persisted order.
    persistSessionTabOrder(['c', 'a', 'b'])
    const sessions: SessionTabData[] = [
      { sessionId: 'a', name: 'Alpha', isBusy: false, isActive: true },
      { sessionId: 'b', name: 'Beta', isBusy: false, isActive: false },
      { sessionId: 'c', name: 'Charlie', isBusy: false, isActive: false },
      { sessionId: 'd', name: 'Delta', isBusy: false, isActive: false },
    ]
    render(<Harness sessions={sessions} />)
    const tabs = document.querySelectorAll<HTMLElement>('[role="tab"]')
    expect(Array.from(tabs).map(t => t.dataset.testid)).toEqual([
      'session-tab-c', 'session-tab-a', 'session-tab-b', 'session-tab-d',
    ])
  })

  it('removed sessions are silently dropped from the visible order', () => {
    persistSessionTabOrder(['a', 'gone', 'b'])
    const sessions: SessionTabData[] = [
      { sessionId: 'a', name: 'Alpha', isBusy: false, isActive: true },
      { sessionId: 'b', name: 'Beta', isBusy: false, isActive: false },
    ]
    render(<Harness sessions={sessions} />)
    const tabs = document.querySelectorAll<HTMLElement>('[role="tab"]')
    expect(Array.from(tabs).map(t => t.dataset.testid)).toEqual([
      'session-tab-a', 'session-tab-b',
    ])
  })
})
