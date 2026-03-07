/**
 * Sidebar keyboard navigation tests (#1396)
 *
 * Tests WAI-ARIA TreeView keyboard navigation:
 * Arrow Up/Down, Arrow Right/Left, Enter/Space, Home/End, roving tabindex.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Sidebar, type SidebarProps, type RepoNode } from './Sidebar'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const store = {
      serverRegistry: [], activeServerId: null, connectionPhase: 'disconnected',
      addServer: vi.fn(), removeServer: vi.fn(), switchServer: vi.fn(),
    }
    return selector(store)
  },
}))

afterEach(cleanup)

const noop = vi.fn()

function makeRepos(): RepoNode[] {
  return [
    {
      path: '/home/user/projects/api',
      name: 'api',
      source: 'auto',
      exists: true,
      activeSessions: [
        { sessionId: 's1', name: 'Backend', isBusy: true },
        { sessionId: 's2', name: 'Tests', isBusy: false },
      ],
      resumableSessions: [
        { conversationId: 'c1', preview: 'Fix auth bug', modifiedAt: '2026-03-01' },
      ],
    },
    {
      path: '/home/user/projects/web',
      name: 'web',
      source: 'manual',
      exists: true,
      activeSessions: [
        { sessionId: 's3', name: 'Frontend', isBusy: false },
      ],
      resumableSessions: [],
    },
  ]
}

function renderSidebar(props: Partial<SidebarProps> = {}) {
  const defaultProps: SidebarProps = {
    repos: makeRepos(),
    activeSessionId: 's1',
    isOpen: true,
    width: 240,
    filter: '',
    serverStatus: 'connected',
    tunnelUrl: null,
    clientCount: 1,
    onFilterChange: noop,
    onSessionClick: noop,
    onResumeSession: noop,
    onNewSession: noop,
    onToggle: noop,
    onContextMenu: noop,
  }
  return render(<Sidebar {...defaultProps} {...props} />)
}

function getTreeItems() {
  return screen.getByRole('tree').querySelectorAll<HTMLElement>('[role="treeitem"]')
}

function getVisibleTreeItems() {
  // Only top-level treeitems and children of expanded groups
  const tree = screen.getByRole('tree')
  return Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(el => {
    // Check if it's visible (not inside a collapsed parent)
    const group = el.closest('[role="group"]')
    if (!group) return true // top-level repo
    const parent = group.closest('[role="treeitem"]')
    return !parent || parent.getAttribute('aria-expanded') !== 'false'
  })
}

describe('Sidebar keyboard navigation (#1396)', () => {
  it('uses roving tabindex — first treeitem has tabIndex=0, rest have -1', () => {
    renderSidebar()
    const items = getTreeItems()
    expect(items.length).toBeGreaterThan(1)
    // First focusable treeitem should have tabIndex 0
    const firstItem = items[0]!
    expect(firstItem.tabIndex).toBe(0)
    // Others should have -1
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.tabIndex).toBe(-1)
    }
  })

  it('ArrowDown moves focus to next visible treeitem', () => {
    renderSidebar()
    const tree = screen.getByRole('tree')
    const items = getVisibleTreeItems()
    // Focus first item
    items[0]!.focus()
    expect(document.activeElement).toBe(items[0])
    // Press ArrowDown
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    // Focus should move to next item
    expect(document.activeElement).toBe(items[1])
  })

  it('ArrowUp moves focus to previous visible treeitem', () => {
    renderSidebar()
    const tree = screen.getByRole('tree')
    const items = getVisibleTreeItems()
    // Focus second item
    items[1]!.focus()
    // Press ArrowUp
    fireEvent.keyDown(tree, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[0])
  })

  it('ArrowRight expands a collapsed repo treeitem', () => {
    renderSidebar()
    const tree = screen.getByRole('tree')
    const apiRepo = screen.getByTestId('repo-header-/home/user/projects/api').closest('[role="treeitem"]') as HTMLElement
    // Collapse it first
    fireEvent.click(screen.getByTestId('repo-header-/home/user/projects/api'))
    expect(apiRepo).toHaveAttribute('aria-expanded', 'false')
    // Focus the repo
    apiRepo.focus()
    // ArrowRight should expand
    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    expect(apiRepo).toHaveAttribute('aria-expanded', 'true')
  })

  it('ArrowLeft collapses an expanded repo treeitem', () => {
    renderSidebar()
    const tree = screen.getByRole('tree')
    const apiRepo = screen.getByTestId('repo-header-/home/user/projects/api').closest('[role="treeitem"]') as HTMLElement
    expect(apiRepo).toHaveAttribute('aria-expanded', 'true')
    apiRepo.focus()
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(apiRepo).toHaveAttribute('aria-expanded', 'false')
  })

  it('Enter activates the focused session treeitem', () => {
    const onSessionClick = vi.fn()
    renderSidebar({ onSessionClick })
    const tree = screen.getByRole('tree')
    const sessionItem = screen.getByTestId('session-item-s2')
    sessionItem.focus()
    fireEvent.keyDown(tree, { key: 'Enter' })
    expect(onSessionClick).toHaveBeenCalledWith('s2')
  })

  it('Space activates the focused session treeitem', () => {
    const onSessionClick = vi.fn()
    renderSidebar({ onSessionClick })
    const tree = screen.getByRole('tree')
    const sessionItem = screen.getByTestId('session-item-s2')
    sessionItem.focus()
    fireEvent.keyDown(tree, { key: ' ' })
    expect(onSessionClick).toHaveBeenCalledWith('s2')
  })

  it('Home moves focus to first visible treeitem', () => {
    renderSidebar()
    const tree = screen.getByRole('tree')
    const items = getVisibleTreeItems()
    // Focus a middle item
    items[2]!.focus()
    fireEvent.keyDown(tree, { key: 'Home' })
    expect(document.activeElement).toBe(items[0])
  })

  it('End moves focus to last visible treeitem', () => {
    renderSidebar()
    const tree = screen.getByRole('tree')
    const items = getVisibleTreeItems()
    // Focus first item
    items[0]!.focus()
    fireEvent.keyDown(tree, { key: 'End' })
    expect(document.activeElement).toBe(items[items.length - 1])
  })
})
