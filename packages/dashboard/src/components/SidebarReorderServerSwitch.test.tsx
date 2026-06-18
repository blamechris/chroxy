/**
 * Sidebar reorder server-switch refresh test (#4940)
 *
 * Follow-up to #4832. The persistence layer (`persistSidebarRepoOrder` /
 * `loadPersistedSidebarRepoOrder`) is server-scoped via `setServerScope`,
 * but the App-level `sidebarRepoOrder` / `sidebarSessionOrder` state is
 * initialised once with `useState(() => loadPersisted...())` and never
 * re-read on server switch. That meant server A's order silently leaked
 * into server B's session list until a full page reload.
 *
 * The fix mirrors the SessionBar pattern (#4831): subscribe to
 * `activeServerId` and re-load the persisted order whenever it changes.
 * This test pins that behaviour with a harness that exercises the same
 * wiring the App uses (production helpers + an effect keyed on the
 * mocked `activeServerId`).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useState, useEffect } from 'react'
import {
  persistSidebarRepoOrder,
  loadPersistedSidebarRepoOrder,
  persistSidebarSessionOrder,
  loadPersistedSidebarSessionOrder,
  setServerScope,
  _resetForTesting,
} from '../store/persistence'

// --- Minimal mock for the connection store ----------------------------------
// The fix reads `activeServerId` via `useConnectionStore(s => s.activeServerId)`.
// Tests drive the value via this module-level setter; the selector mock
// reads from the same closure so a `setActiveServerId` call triggers a
// re-render in any component using `useState` + the mock-backed selector.
let _activeServerId: string | null = null
const _listeners = new Set<() => void>()

function setActiveServerId(next: string | null): void {
  _activeServerId = next
  for (const listener of _listeners) listener()
}

vi.mock('../store/connection', () => ({
  useConnectionStore: <T,>(selector: (s: { activeServerId: string | null }) => T): T => {
    // Subscribe the calling component to changes via a forced re-render.
    // We mimic Zustand's hook contract just well enough for this test —
    // `useState` + a side-effect-free `useEffect` to register/unregister.
    const [, force] = useState(0)
    useEffect(() => {
      const listener = () => force(n => n + 1)
      _listeners.add(listener)
      return () => { _listeners.delete(listener) }
    }, [])
    return selector({ activeServerId: _activeServerId })
  },
}))

// Import AFTER the mock so the test harness gets the mocked module.
// eslint-disable-next-line import/first
import { useConnectionStore } from '../store/connection'

beforeEach(() => {
  localStorage.clear()
  _resetForTesting()
  setServerScope(null)
  _activeServerId = null
  _listeners.clear()
})
afterEach(cleanup)

// Harness mirrors the App.tsx wiring at packages/dashboard/src/App.tsx:566-567:
// it lazily initialises from persistence on mount AND re-reads whenever the
// active server changes (the fix for #4940).
function Harness({ onRender }: { onRender: (snap: {
  repoOrder: string[]
  sessionOrder: Record<string, string[]>
}) => void }) {
  const [sidebarRepoOrder, setSidebarRepoOrder] = useState<string[]>(
    () => loadPersistedSidebarRepoOrder(),
  )
  const [sidebarSessionOrder, setSidebarSessionOrder] = useState<Record<string, string[]>>(
    () => loadPersistedSidebarSessionOrder(),
  )
  // #4940 — re-read persisted orders when the active server changes so the
  // new server's scope replaces the stale state inherited from server A.
  const activeServerId = useConnectionStore(s => s.activeServerId)
  useEffect(() => {
    setSidebarRepoOrder(loadPersistedSidebarRepoOrder())
    setSidebarSessionOrder(loadPersistedSidebarSessionOrder())
  }, [activeServerId])

  onRender({ repoOrder: sidebarRepoOrder, sessionOrder: sidebarSessionOrder })
  return null
}

describe('#4940 sidebar reorder refresh on server switch', () => {
  it('reloads the sidebar repo order when activeServerId changes', () => {
    // Server A has a saved order.
    setServerScope('srv_A')
    persistSidebarRepoOrder(['/repo/cli', '/repo/api', '/repo/web'])

    // Server B has a different saved order.
    setServerScope('srv_B')
    persistSidebarRepoOrder(['/repo/web', '/repo/cli'])

    // Mount under server A's scope — App.tsx's `useState` initialiser
    // would read the persisted A order.
    setServerScope('srv_A')
    _activeServerId = 'srv_A'
    let snapshot: { repoOrder: string[]; sessionOrder: Record<string, string[]> } = {
      repoOrder: [],
      sessionOrder: {},
    }
    const handleRender = (s: typeof snapshot) => { snapshot = s }
    render(<Harness onRender={handleRender} />)
    expect(snapshot.repoOrder).toEqual(['/repo/cli', '/repo/api', '/repo/web'])

    // Now flip to server B (this is the path through `switchServer` →
    // `setServerScope` → `activeServerId` update). The harness's effect
    // must re-load from the new scope.
    act(() => {
      setServerScope('srv_B')
      setActiveServerId('srv_B')
    })
    expect(snapshot.repoOrder).toEqual(['/repo/web', '/repo/cli'])

    // And flipping back to A restores A's order, proving the effect is
    // not just one-shot on first mount.
    act(() => {
      setServerScope('srv_A')
      setActiveServerId('srv_A')
    })
    expect(snapshot.repoOrder).toEqual(['/repo/cli', '/repo/api', '/repo/web'])
  })

  it('reloads the sidebar session order when activeServerId changes', () => {
    setServerScope('srv_A')
    persistSidebarSessionOrder({ '/repo/api': ['s3', 's1', 's2'] })

    setServerScope('srv_B')
    persistSidebarSessionOrder({ '/repo/web': ['w2', 'w1'] })

    setServerScope('srv_A')
    _activeServerId = 'srv_A'
    let snapshot: { repoOrder: string[]; sessionOrder: Record<string, string[]> } = {
      repoOrder: [],
      sessionOrder: {},
    }
    const handleRender = (s: typeof snapshot) => { snapshot = s }
    render(<Harness onRender={handleRender} />)
    expect(snapshot.sessionOrder).toEqual({ '/repo/api': ['s3', 's1', 's2'] })

    act(() => {
      setServerScope('srv_B')
      setActiveServerId('srv_B')
    })
    expect(snapshot.sessionOrder).toEqual({ '/repo/web': ['w2', 'w1'] })
  })

  it('clears the order when switching to a server with no saved order', () => {
    setServerScope('srv_A')
    persistSidebarRepoOrder(['/repo/cli', '/repo/api'])
    persistSidebarSessionOrder({ '/repo/api': ['s3', 's1', 's2'] })

    _activeServerId = 'srv_A'
    let snapshot: { repoOrder: string[]; sessionOrder: Record<string, string[]> } = {
      repoOrder: [],
      sessionOrder: {},
    }
    const handleRender = (s: typeof snapshot) => { snapshot = s }
    render(<Harness onRender={handleRender} />)
    expect(snapshot.repoOrder).toEqual(['/repo/cli', '/repo/api'])
    expect(snapshot.sessionOrder).toEqual({ '/repo/api': ['s3', 's1', 's2'] })

    // srv_B has no saved order — switching must reset the App-level state
    // back to defaults so server A's order doesn't bleed through.
    act(() => {
      setServerScope('srv_B')
      setActiveServerId('srv_B')
    })
    expect(snapshot.repoOrder).toEqual([])
    expect(snapshot.sessionOrder).toEqual({})
  })
})
