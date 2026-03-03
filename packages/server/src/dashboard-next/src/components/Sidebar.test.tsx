/**
 * Sidebar component tests (#1102)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Sidebar, type SidebarProps, type RepoNode } from './Sidebar'

afterEach(cleanup)

const noop = vi.fn()

function makeRepos(overrides?: Partial<RepoNode>[]): RepoNode[] {
  const defaults: RepoNode[] = [
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
      activeSessions: [],
      resumableSessions: [],
    },
  ]
  if (!overrides) return defaults
  return defaults.map((r, i) => ({ ...r, ...overrides[i] }))
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
    onWidthChange: noop,
    onContextMenu: noop,
  }
  return render(<Sidebar {...defaultProps} {...props} />)
}

describe('Sidebar', () => {
  it('renders repo names', () => {
    renderSidebar()
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText('web')).toBeInTheDocument()
  })

  it('shows active sessions under repo', () => {
    renderSidebar()
    expect(screen.getByText('Backend')).toBeInTheDocument()
    expect(screen.getByText('Tests')).toBeInTheDocument()
  })

  it('marks busy sessions with indicator', () => {
    renderSidebar()
    const busyItem = screen.getByTestId('session-item-s1')
    expect(busyItem.querySelector('.sidebar-busy-dot')).toBeInTheDocument()
  })

  it('marks active session with highlight', () => {
    renderSidebar()
    const activeItem = screen.getByTestId('session-item-s1')
    expect(activeItem).toHaveClass('active')
  })

  it('shows resumable sessions', () => {
    renderSidebar()
    expect(screen.getByText('Fix auth bug')).toBeInTheDocument()
  })

  it('calls onSessionClick when active session clicked', () => {
    const onSessionClick = vi.fn()
    renderSidebar({ onSessionClick })
    fireEvent.click(screen.getByTestId('session-item-s2'))
    expect(onSessionClick).toHaveBeenCalledWith('s2')
  })

  it('calls onResumeSession when resumable session clicked', () => {
    const onResumeSession = vi.fn()
    renderSidebar({ onResumeSession })
    fireEvent.click(screen.getByTestId('resumable-item-c1'))
    expect(onResumeSession).toHaveBeenCalledWith('c1')
  })

  it('calls onNewSession when new session button clicked', () => {
    const onNewSession = vi.fn()
    renderSidebar({ onNewSession })
    const buttons = screen.getAllByTestId('sidebar-new-session')
    fireEvent.click(buttons[0]!)
    expect(onNewSession).toHaveBeenCalledWith('/home/user/projects/api')
  })

  it('renders filter input', () => {
    renderSidebar({ filter: 'api' })
    const input = screen.getByPlaceholderText('Filter...')
    expect(input).toHaveValue('api')
  })

  it('calls onFilterChange on input', () => {
    const onFilterChange = vi.fn()
    renderSidebar({ onFilterChange })
    const input = screen.getByPlaceholderText('Filter...')
    fireEvent.change(input, { target: { value: 'web' } })
    expect(onFilterChange).toHaveBeenCalledWith('web')
  })

  it('hides repos that do not match filter', () => {
    renderSidebar({ filter: 'web' })
    expect(screen.queryByText('api')).not.toBeInTheDocument()
    expect(screen.getByText('web')).toBeInTheDocument()
  })

  it('shows server status in footer', () => {
    renderSidebar({ serverStatus: 'connected' })
    expect(screen.getByTestId('sidebar-footer')).toHaveTextContent('Running')
  })

  it('shows tunnel URL in footer when available', () => {
    renderSidebar({ tunnelUrl: 'https://my-tunnel.trycloudflare.com' })
    expect(screen.getByTestId('sidebar-footer')).toHaveTextContent('my-tunnel.trycloudflare.com')
  })

  it('shows client count in footer', () => {
    renderSidebar({ clientCount: 3 })
    expect(screen.getByTestId('sidebar-footer')).toHaveTextContent('3')
  })

  it('renders collapsed state when isOpen is false', () => {
    renderSidebar({ isOpen: false })
    const sidebar = screen.getByTestId('sidebar')
    expect(sidebar).toHaveClass('collapsed')
  })

  it('calls onToggle when toggle button clicked', () => {
    const onToggle = vi.fn()
    renderSidebar({ onToggle })
    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(onToggle).toHaveBeenCalled()
  })

  it('collapses repo when header clicked', () => {
    renderSidebar()
    // Click the api repo header to collapse
    fireEvent.click(screen.getByTestId('repo-header-/home/user/projects/api'))
    // Sessions should be hidden
    expect(screen.queryByText('Backend')).not.toBeInTheDocument()
  })

  it('expands collapsed repo when header clicked again', () => {
    renderSidebar()
    const header = screen.getByTestId('repo-header-/home/user/projects/api')
    // Collapse
    fireEvent.click(header)
    expect(screen.queryByText('Backend')).not.toBeInTheDocument()
    // Expand
    fireEvent.click(header)
    expect(screen.getByText('Backend')).toBeInTheDocument()
  })

  it('fires onContextMenu on repo header right-click', () => {
    const onContextMenu = vi.fn()
    renderSidebar({ onContextMenu })
    const header = screen.getByTestId('repo-header-/home/user/projects/api')
    fireEvent.contextMenu(header)
    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'repo' }),
      expect.anything(),
    )
  })

  it('fires onContextMenu on session right-click', () => {
    const onContextMenu = vi.fn()
    renderSidebar({ onContextMenu })
    fireEvent.contextMenu(screen.getByTestId('session-item-s1'))
    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session' }),
      expect.anything(),
    )
  })
})
