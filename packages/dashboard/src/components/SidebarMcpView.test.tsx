/**
 * SidebarMcpView tests (#6820) — read-only MCP server list in the sidebar
 * panel slot, the desktop analogue of the mobile SettingsBar section.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import type { McpServer } from '@chroxy/store-core'
import { SidebarMcpView, mcpViewCollapsedMetric } from './SidebarMcpView'

// Mock the store so the fallback path (no `servers` prop) is deterministic.
// Tests that pass `servers` directly never touch it. The variable is prefixed
// `mock` so vitest allows it inside the hoisted factory. #6824 — the component
// also selects `setMcpServerEnabled`, so the state carries a spy.
const mockSetMcpServerEnabled = vi.fn()
let mockStoreState: Record<string, unknown> = {
  activeSessionId: null,
  sessionStates: {},
  setMcpServerEnabled: mockSetMcpServerEnabled,
}
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState),
}))

afterEach(() => {
  cleanup()
  mockSetMcpServerEnabled.mockClear()
  mockStoreState = { activeSessionId: null, sessionStates: {}, setMcpServerEnabled: mockSetMcpServerEnabled }
})

function srv(name: string, status: string): McpServer {
  return { name, status }
}

function toggleSrv(name: string, status: string, enabled: boolean): McpServer {
  return { name, status, enabled, canToggle: true }
}

describe('SidebarMcpView (#6820)', () => {
  it('renders the empty state when there are no servers', () => {
    render(<SidebarMcpView servers={[]} />)
    expect(screen.getByTestId('sidebar-mcp-view-empty').textContent).toBe('No MCP servers')
    expect(screen.queryByTestId('sidebar-mcp-view-list')).toBeNull()
  })

  it('renders one row per server with name + status text', () => {
    render(<SidebarMcpView servers={[srv('filesystem', 'connected'), srv('github', 'configured')]} />)
    expect(screen.getByTestId('sidebar-mcp-view-name-filesystem').textContent).toBe('filesystem')
    expect(screen.getByTestId('sidebar-mcp-view-status-filesystem').textContent).toBe('connected')
    expect(screen.getByTestId('sidebar-mcp-view-name-github').textContent).toBe('github')
    expect(screen.getByTestId('sidebar-mcp-view-status-github').textContent).toBe('configured')
  })

  it('marks the status dot connected only for status "connected"', () => {
    render(<SidebarMcpView servers={[srv('live', 'connected'), srv('declared', 'configured')]} />)
    const liveDot = screen.getByTestId('sidebar-mcp-view-dot-live')
    const declaredDot = screen.getByTestId('sidebar-mcp-view-dot-declared')
    expect(liveDot.className).toContain('connected')
    expect(declaredDot.className).not.toContain('connected')
    // The raw status is exposed on the dot for styling/debugging.
    expect(declaredDot.getAttribute('data-status')).toBe('configured')
  })

  it('falls back to the active session store field when no prop is given', () => {
    mockStoreState = {
      activeSessionId: 's1',
      sessionStates: { s1: { mcpServers: [srv('storefs', 'connected')] } },
    }
    render(<SidebarMcpView />)
    expect(screen.getByTestId('sidebar-mcp-view-name-storefs').textContent).toBe('storefs')
  })

  it('renders empty when the store has no active session', () => {
    render(<SidebarMcpView />)
    expect(screen.getByTestId('sidebar-mcp-view-empty')).toBeTruthy()
  })
})

describe('SidebarMcpView enable/disable toggle (#6824)', () => {
  it('does NOT render a toggle for a read-only (non-canToggle) server', () => {
    render(<SidebarMcpView servers={[srv('filesystem', 'connected')]} />)
    expect(screen.queryByTestId('sidebar-mcp-view-toggle-filesystem')).toBeNull()
  })

  it('renders a toggle reflecting enabled state when the server reports canToggle', () => {
    render(<SidebarMcpView servers={[toggleSrv('fs', 'connected', true), toggleSrv('gh', 'disabled', false)]} />)
    const on = screen.getByTestId('sidebar-mcp-view-toggle-fs')
    const off = screen.getByTestId('sidebar-mcp-view-toggle-gh')
    expect(on.getAttribute('aria-checked')).toBe('true')
    expect(on.textContent).toBe('On')
    expect(off.getAttribute('aria-checked')).toBe('false')
    expect(off.textContent).toBe('Off')
  })

  it('clicking an enabled toggle calls setMcpServerEnabled(name, false)', () => {
    render(<SidebarMcpView servers={[toggleSrv('fs', 'connected', true)]} />)
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-toggle-fs'))
    expect(mockSetMcpServerEnabled).toHaveBeenCalledTimes(1)
    expect(mockSetMcpServerEnabled).toHaveBeenCalledWith('fs', false)
  })

  it('clicking a disabled toggle calls setMcpServerEnabled(name, true)', () => {
    render(<SidebarMcpView servers={[toggleSrv('gh', 'disabled', false)]} />)
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-toggle-gh'))
    expect(mockSetMcpServerEnabled).toHaveBeenCalledWith('gh', true)
  })

  it('falls back to status when `enabled` is absent (pre-#6824 payload with canToggle)', () => {
    // canToggle but no explicit `enabled` → derive from status.
    render(<SidebarMcpView servers={[{ name: 'legacy', status: 'disabled', canToggle: true }]} />)
    const t = screen.getByTestId('sidebar-mcp-view-toggle-legacy')
    expect(t.getAttribute('aria-checked')).toBe('false')
  })
})

describe('mcpViewCollapsedMetric (#6820)', () => {
  it('reports "No MCP" when empty', () => {
    expect(mcpViewCollapsedMetric([])).toBe('No MCP')
  })

  it('reports a singular server count', () => {
    expect(mcpViewCollapsedMetric([srv('a', 'connected')])).toBe('1 server')
  })

  it('reports a plural server count', () => {
    expect(mcpViewCollapsedMetric([srv('a', 'connected'), srv('b', 'configured')])).toBe('2 servers')
  })
})
