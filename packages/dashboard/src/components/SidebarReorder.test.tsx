/**
 * Drag-to-reorder tests for the left sidebar (#4832).
 *
 * Covers:
 *   - HTML5 drag-and-drop emits onReorderRepos with the post-move
 *     ordering for top-level repo groups
 *   - HTML5 drag-and-drop emits onReorderSessions with the post-move
 *     ordering for sessions within a repo
 *   - Sessions cannot be dragged across repo groups (out-of-scope per
 *     the issue)
 *   - Keyboard reorder shortcut (Alt+ArrowUp/Down) emits the same
 *     callbacks without requiring the mouse
 *   - Drag is disabled while a filter is active (the on-screen list is
 *     a subset, so reordering it would persist a confusing partial
 *     order)
 *   - Persistence round-trip — repo order survives `window.location.reload()`
 *     by reading from localStorage on remount
 *   - Drop-position visual indicator class is applied based on the
 *     cursor's vertical midpoint
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useState } from 'react'
import { Sidebar, type SidebarProps, type RepoNode } from './Sidebar'
import {
  persistSidebarRepoOrder,
  loadPersistedSidebarRepoOrder,
  persistSidebarSessionOrder,
  loadPersistedSidebarSessionOrder,
} from '../store/persistence'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const store = {
      serverRegistry: [],
      activeServerId: null,
      connectionPhase: 'disconnected',
      addServer: vi.fn(),
      removeServer: vi.fn(),
      switchServer: vi.fn(),
    }
    return selector(store)
  },
}))

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const noop = vi.fn()

function makeRepos(): RepoNode[] {
  return [
    {
      path: '/home/user/projects/api',
      name: 'api',
      source: 'auto',
      exists: true,
      activeSessions: [
        { sessionId: 's1', name: 'Backend', isBusy: false },
        { sessionId: 's2', name: 'Tests', isBusy: false },
        { sessionId: 's3', name: 'Worker', isBusy: false },
      ],
      resumableSessions: [],
    },
    {
      path: '/home/user/projects/web',
      name: 'web',
      source: 'auto',
      exists: true,
      activeSessions: [
        { sessionId: 'w1', name: 'Frontend', isBusy: false },
      ],
      resumableSessions: [],
    },
    {
      path: '/home/user/projects/cli',
      name: 'cli',
      source: 'auto',
      exists: true,
      activeSessions: [
        { sessionId: 'c1', name: 'Daemon', isBusy: false },
      ],
      resumableSessions: [],
    },
  ]
}

function renderSidebar(props: Partial<SidebarProps> = {}) {
  const defaultProps: SidebarProps = {
    repos: makeRepos(),
    activeSessionId: null,
    isOpen: true,
    width: 240,
    filter: '',
    serverStatus: 'connected',
    tunnelUrl: null,
    clientCount: 0,
    onFilterChange: noop,
    onSessionClick: noop,
    onResumeSession: noop,
    onNewSession: noop,
    onToggle: noop,
    onContextMenu: noop,
  }
  return render(<Sidebar {...defaultProps} {...props} />)
}

/**
 * jsdom's getBoundingClientRect returns all-zeros. Stub it on a row so
 * the dropPosition() helper has a non-trivial midpoint to bisect against.
 */
function stubRect(el: Element, top: number, height: number) {
  ;(el as HTMLElement).getBoundingClientRect = () => ({
    top,
    bottom: top + height,
    left: 0,
    right: 240,
    width: 240,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  })
}

/**
 * Synthesize a DataTransfer-like object so jsdom drag events have a
 * usable dataTransfer (jsdom returns null otherwise).
 */
function mockDataTransfer(): DataTransfer {
  const store = new Map<string, string>()
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    setData: (key: string, value: string) => { store.set(key, value) },
    getData: (key: string) => store.get(key) ?? '',
    clearData: () => store.clear(),
    items: [] as unknown as DataTransferItemList,
    files: [] as unknown as FileList,
    types: [],
    setDragImage: () => undefined,
  } as unknown as DataTransfer
}

/**
 * Dispatch a drag event with both clientY (from MouseEvent) and a
 * DataTransfer payload. `fireEvent.dragOver(el, { clientY })` does NOT
 * carry clientY through to the handler in jsdom, so we construct the
 * event manually and assign dataTransfer + clientY before dispatch.
 */
function dispatchDrag(
  el: Element,
  type: 'dragstart' | 'dragover' | 'drop' | 'dragend' | 'dragleave',
  opts: { clientY?: number; dataTransfer: DataTransfer },
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: opts.dataTransfer, writable: false })
  if (opts.clientY !== undefined) {
    Object.defineProperty(event, 'clientY', { value: opts.clientY, writable: false })
  }
  act(() => {
    el.dispatchEvent(event)
  })
}

describe('Sidebar drag-to-reorder repos (#4832)', () => {
  it('emits onReorderRepos with the new order when a repo is dropped onto another', () => {
    const onReorderRepos = vi.fn()
    renderSidebar({ onReorderRepos })

    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    const cliRepo = screen.getByTestId('sidebar-repo-/home/user/projects/cli')
    stubRect(apiRepo, 0, 24)
    stubRect(cliRepo, 60, 24)

    const dt = mockDataTransfer()
    dispatchDrag(apiRepo, 'dragstart', { dataTransfer: dt })
    // Drop AFTER cli (cursor below midpoint of cli row)
    dispatchDrag(cliRepo, 'dragover', { dataTransfer: dt, clientY: 80 })
    dispatchDrag(cliRepo, 'drop', { dataTransfer: dt, clientY: 80 })

    expect(onReorderRepos).toHaveBeenCalledTimes(1)
    // api moved from position 0 to AFTER cli (last position) =>
    // ['web', 'cli', 'api']
    expect(onReorderRepos).toHaveBeenCalledWith([
      '/home/user/projects/web',
      '/home/user/projects/cli',
      '/home/user/projects/api',
    ])
  })

  it('emits onReorderRepos with target-before order when cursor is above midpoint', () => {
    const onReorderRepos = vi.fn()
    renderSidebar({ onReorderRepos })

    const cliRepo = screen.getByTestId('sidebar-repo-/home/user/projects/cli')
    const webRepo = screen.getByTestId('sidebar-repo-/home/user/projects/web')
    stubRect(webRepo, 30, 24)
    stubRect(cliRepo, 60, 24)

    const dt = mockDataTransfer()
    dispatchDrag(cliRepo, 'dragstart', { dataTransfer: dt })
    // Drop BEFORE web (cursor above midpoint of web row)
    dispatchDrag(webRepo, 'dragover', { dataTransfer: dt, clientY: 35 })
    dispatchDrag(webRepo, 'drop', { dataTransfer: dt, clientY: 35 })

    expect(onReorderRepos).toHaveBeenCalledWith([
      '/home/user/projects/api',
      '/home/user/projects/cli',
      '/home/user/projects/web',
    ])
  })

  it('does not fire onReorderRepos when dropped on the same repo', () => {
    const onReorderRepos = vi.fn()
    renderSidebar({ onReorderRepos })
    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    stubRect(apiRepo, 0, 24)
    const dt = mockDataTransfer()
    dispatchDrag(apiRepo, 'dragstart', { dataTransfer: dt })
    dispatchDrag(apiRepo, 'dragover', { dataTransfer: dt, clientY: 10 })
    dispatchDrag(apiRepo, 'drop', { dataTransfer: dt, clientY: 10 })
    expect(onReorderRepos).not.toHaveBeenCalled()
  })

  it('disables drag on repo rows when a filter is active', () => {
    renderSidebar({ filter: 'api', onReorderRepos: vi.fn() })
    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    expect(apiRepo.getAttribute('draggable')).toBe('false')
  })

  it('disables drag on repo rows when onReorderRepos is not provided', () => {
    renderSidebar() // no onReorderRepos
    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    expect(apiRepo.getAttribute('draggable')).toBe('false')
  })

  it('enables drag on repo rows when onReorderRepos is provided and no filter', () => {
    renderSidebar({ onReorderRepos: vi.fn() })
    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    expect(apiRepo.getAttribute('draggable')).toBe('true')
  })
})

describe('Sidebar drag-to-reorder sessions (#4832)', () => {
  it('emits onReorderSessions when a session is dropped on a sibling', () => {
    const onReorderSessions = vi.fn()
    renderSidebar({ onReorderSessions })

    const s1 = screen.getByTestId('session-item-s1')
    const s3 = screen.getByTestId('session-item-s3')
    stubRect(s1, 0, 20)
    stubRect(s3, 40, 20)

    const dt = mockDataTransfer()
    dispatchDrag(s1, 'dragstart', { dataTransfer: dt })
    // Drop AFTER s3 (cursor below midpoint => goes to the end)
    dispatchDrag(s3, 'dragover', { dataTransfer: dt, clientY: 55 })
    dispatchDrag(s3, 'drop', { dataTransfer: dt, clientY: 55 })

    expect(onReorderSessions).toHaveBeenCalledTimes(1)
    expect(onReorderSessions).toHaveBeenCalledWith(
      '/home/user/projects/api',
      ['s2', 's3', 's1'],
    )
  })

  it('does not allow cross-repo session drag (drop is ignored)', () => {
    const onReorderSessions = vi.fn()
    renderSidebar({ onReorderSessions })

    const apiSession = screen.getByTestId('session-item-s1')
    const webSession = screen.getByTestId('session-item-w1')
    stubRect(apiSession, 0, 20)
    stubRect(webSession, 100, 20)

    const dt = mockDataTransfer()
    dispatchDrag(apiSession, 'dragstart', { dataTransfer: dt })
    // Try to drop s1 (api repo) on w1 (web repo) — should be a no-op
    dispatchDrag(webSession, 'dragover', { dataTransfer: dt, clientY: 105 })
    dispatchDrag(webSession, 'drop', { dataTransfer: dt, clientY: 105 })

    expect(onReorderSessions).not.toHaveBeenCalled()
  })

  it('marks the dragged session row with the .dragging class', () => {
    renderSidebar({ onReorderSessions: vi.fn() })
    const s1 = screen.getByTestId('session-item-s1')
    const dt = mockDataTransfer()
    dispatchDrag(s1, 'dragstart', { dataTransfer: dt })
    expect(s1.className).toMatch(/\bdragging\b/)
    dispatchDrag(s1, 'dragend', { dataTransfer: dt })
    expect(s1.className).not.toMatch(/\bdragging\b/)
  })

  it('marks the drop target with drop-before / drop-after based on cursor Y', () => {
    renderSidebar({ onReorderSessions: vi.fn() })
    const s1 = screen.getByTestId('session-item-s1')
    const s3 = screen.getByTestId('session-item-s3')
    stubRect(s1, 0, 20)
    stubRect(s3, 40, 20)
    const dt = mockDataTransfer()
    dispatchDrag(s1, 'dragstart', { dataTransfer: dt })

    // Above midpoint (40 + 10 = 50) => drop-before
    dispatchDrag(s3, 'dragover', { dataTransfer: dt, clientY: 45 })
    expect(s3.className).toMatch(/\bdrop-before\b/)

    // Below midpoint => drop-after
    dispatchDrag(s3, 'dragover', { dataTransfer: dt, clientY: 55 })
    expect(s3.className).toMatch(/\bdrop-after\b/)
    expect(s3.className).not.toMatch(/\bdrop-before\b/)
  })
})

describe('Sidebar keyboard reorder (#4832)', () => {
  it('moves a session up with Alt+ArrowUp', () => {
    const onReorderSessions = vi.fn()
    renderSidebar({ onReorderSessions })
    const s2 = screen.getByTestId('session-item-s2')
    fireEvent.keyDown(s2, { key: 'ArrowUp', altKey: true })
    expect(onReorderSessions).toHaveBeenCalledWith(
      '/home/user/projects/api',
      ['s2', 's1', 's3'],
    )
  })

  it('moves a session down with Alt+ArrowDown', () => {
    const onReorderSessions = vi.fn()
    renderSidebar({ onReorderSessions })
    const s2 = screen.getByTestId('session-item-s2')
    fireEvent.keyDown(s2, { key: 'ArrowDown', altKey: true })
    expect(onReorderSessions).toHaveBeenCalledWith(
      '/home/user/projects/api',
      ['s1', 's3', 's2'],
    )
  })

  it('is a no-op (no callback) at the top edge with Alt+ArrowUp', () => {
    const onReorderSessions = vi.fn()
    renderSidebar({ onReorderSessions })
    const s1 = screen.getByTestId('session-item-s1')
    fireEvent.keyDown(s1, { key: 'ArrowUp', altKey: true })
    expect(onReorderSessions).not.toHaveBeenCalled()
  })

  it('moves a repo up with Alt+ArrowUp on the outer treeitem', () => {
    const onReorderRepos = vi.fn()
    renderSidebar({ onReorderRepos })
    const webRepo = screen.getByTestId('sidebar-repo-/home/user/projects/web')
    fireEvent.keyDown(webRepo, { key: 'ArrowUp', altKey: true })
    expect(onReorderRepos).toHaveBeenCalledWith([
      '/home/user/projects/web',
      '/home/user/projects/api',
      '/home/user/projects/cli',
    ])
  })

  it('does not move focus when reorder shortcut fires (stopPropagation)', () => {
    // Plain ArrowDown (no Alt) goes through handleTreeKeyDown and moves
    // focus; Alt+ArrowDown should be intercepted by the row handler
    // BEFORE the tree handler runs, so focus stays where it was.
    const onReorderSessions = vi.fn()
    renderSidebar({ onReorderSessions })
    const s1 = screen.getByTestId('session-item-s1')
    s1.focus()
    expect(document.activeElement).toBe(s1)
    fireEvent.keyDown(s1, { key: 'ArrowDown', altKey: true })
    // Focus stays on s1 (no traversal)
    expect(document.activeElement).toBe(s1)
    expect(onReorderSessions).toHaveBeenCalled()
  })

  it('does not respond to plain ArrowUp/ArrowDown (no Alt) for reordering', () => {
    const onReorderSessions = vi.fn()
    renderSidebar({ onReorderSessions })
    const s2 = screen.getByTestId('session-item-s2')
    fireEvent.keyDown(s2, { key: 'ArrowUp' })
    fireEvent.keyDown(s2, { key: 'ArrowDown' })
    expect(onReorderSessions).not.toHaveBeenCalled()
  })

  it('does not reorder sessions via Alt+Arrow while a filter is active', () => {
    // Mirrors the drag guard: reordering from a filtered subset would
    // persist a partial order. The keyboard shortcut must obey the same
    // rule the drag handler does.
    const onReorderSessions = vi.fn()
    renderSidebar({ filter: 'api', onReorderSessions })
    const s2 = screen.getByTestId('session-item-s2')
    fireEvent.keyDown(s2, { key: 'ArrowDown', altKey: true })
    expect(onReorderSessions).not.toHaveBeenCalled()
  })

  it('does not reorder repos via Alt+Arrow while a filter is active', () => {
    const onReorderRepos = vi.fn()
    renderSidebar({ filter: 'api', onReorderRepos })
    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    fireEvent.keyDown(apiRepo, { key: 'ArrowDown', altKey: true })
    expect(onReorderRepos).not.toHaveBeenCalled()
  })
})

// #4941 — discoverability follow-up: the Alt+ArrowUp/Down reorder
// shortcut is invisible without `aria-keyshortcuts`, so assistive tech
// can't announce it and sighted users have no surfacing either. The
// attribute must be set when (and ONLY when) reorder is functionally
// wired on a row, so the announced shortcut doesn't mislead users on
// rows where the keypress is a no-op.
describe('Sidebar aria-keyshortcuts (#4941)', () => {
  it('exposes Alt+ArrowUp Alt+ArrowDown on session rows when reorder is wired', () => {
    renderSidebar({ onReorderSessions: vi.fn() })
    const s1 = screen.getByTestId('session-item-s1')
    expect(s1.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
  })

  it('exposes Alt+ArrowUp Alt+ArrowDown on repo rows when reorder is wired', () => {
    renderSidebar({ onReorderRepos: vi.fn() })
    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    expect(apiRepo.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
  })

  it('omits aria-keyshortcuts on session rows when no reorder callback is wired', () => {
    renderSidebar({})
    const s1 = screen.getByTestId('session-item-s1')
    expect(s1.hasAttribute('aria-keyshortcuts')).toBe(false)
  })

  it('omits aria-keyshortcuts on repo rows when no reorder callback is wired', () => {
    renderSidebar({})
    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    expect(apiRepo.hasAttribute('aria-keyshortcuts')).toBe(false)
  })

  it('omits aria-keyshortcuts while a filter is active (matches functional gate)', () => {
    // Reorder is disabled while filtering (see handleSessionReorderKey /
    // handleRepoReorderKey guards). The aria attribute must agree so
    // screen readers don't announce a shortcut that the row will
    // refuse to act on.
    renderSidebar({ filter: 'api', onReorderSessions: vi.fn(), onReorderRepos: vi.fn() })
    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    const s1 = screen.getByTestId('session-item-s1')
    expect(apiRepo.hasAttribute('aria-keyshortcuts')).toBe(false)
    expect(s1.hasAttribute('aria-keyshortcuts')).toBe(false)
  })
})

describe('Sidebar reorder persistence (#4832)', () => {
  it('round-trips the repo order through localStorage', () => {
    const order = [
      '/home/user/projects/cli',
      '/home/user/projects/api',
      '/home/user/projects/web',
    ]
    persistSidebarRepoOrder(order)
    expect(loadPersistedSidebarRepoOrder()).toEqual(order)
  })

  it('round-trips the per-repo session order through localStorage', () => {
    const sessionOrder = {
      '/home/user/projects/api': ['s3', 's1', 's2'],
      '/home/user/projects/web': ['w1'],
    }
    persistSidebarSessionOrder(sessionOrder)
    expect(loadPersistedSidebarSessionOrder()).toEqual(sessionOrder)
  })

  it('clears the persisted repo order when an empty array is passed', () => {
    persistSidebarRepoOrder(['/foo'])
    expect(loadPersistedSidebarRepoOrder()).toEqual(['/foo'])
    persistSidebarRepoOrder([])
    expect(loadPersistedSidebarRepoOrder()).toEqual([])
  })

  it('returns empty defaults when nothing is persisted', () => {
    expect(loadPersistedSidebarRepoOrder()).toEqual([])
    expect(loadPersistedSidebarSessionOrder()).toEqual({})
  })

  it('survives a simulated reload — drop persists, sidebar reinitialises from storage', () => {
    // First render — perform a reorder via the App-level handler shape.
    function Harness() {
      const [, setOrder] = useState<string[]>(loadPersistedSidebarRepoOrder())
      return (
        <Sidebar
          repos={makeRepos()}
          activeSessionId={null}
          isOpen
          width={240}
          filter=""
          serverStatus="connected"
          tunnelUrl={null}
          clientCount={0}
          onFilterChange={noop}
          onSessionClick={noop}
          onResumeSession={noop}
          onNewSession={noop}
          onToggle={noop}
          onContextMenu={noop}
          onReorderRepos={(next) => {
            setOrder(next)
            persistSidebarRepoOrder(next)
          }}
        />
      )
    }

    const { unmount } = render(<Harness />)
    const apiRepo = screen.getByTestId('sidebar-repo-/home/user/projects/api')
    const cliRepo = screen.getByTestId('sidebar-repo-/home/user/projects/cli')
    stubRect(apiRepo, 0, 24)
    stubRect(cliRepo, 60, 24)
    const dt = mockDataTransfer()
    dispatchDrag(apiRepo, 'dragstart', { dataTransfer: dt })
    dispatchDrag(cliRepo, 'dragover', { dataTransfer: dt, clientY: 80 })
    dispatchDrag(cliRepo, 'drop', { dataTransfer: dt, clientY: 80 })

    expect(loadPersistedSidebarRepoOrder()).toEqual([
      '/home/user/projects/web',
      '/home/user/projects/cli',
      '/home/user/projects/api',
    ])

    // Simulate reload: unmount + remount, reads from storage.
    unmount()
    render(<Harness />)
    expect(loadPersistedSidebarRepoOrder()).toEqual([
      '/home/user/projects/web',
      '/home/user/projects/cli',
      '/home/user/projects/api',
    ])
  })
})
