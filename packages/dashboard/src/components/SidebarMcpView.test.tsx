/**
 * SidebarMcpView tests (#6820) — read-only MCP server list in the sidebar
 * panel slot, the desktop analogue of the mobile SettingsBar section.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import type { McpServer } from '@chroxy/store-core'
import { SidebarMcpView, mcpViewCollapsedMetric } from './SidebarMcpView'

// Mock the store so the fallback path (no `servers` prop) is deterministic.
// Tests that pass `servers` directly never touch it. The variable is prefixed
// `mock` so vitest allows it inside the hoisted factory. #6824 — the component
// also selects `setMcpServerEnabled`, so the state carries a spy. #6999 —
// `removeMcpServer` / `addMcpServer` / `mcpConfigForbiddenNonPrimary` back the
// remove action and the embedded AddMcpServerForm.
const mockSetMcpServerEnabled = vi.fn()
const mockSubmitMcpAuthCode = vi.fn()
const mockRemoveMcpServer = vi.fn()
const mockAddMcpServer = vi.fn()
const defaultMockState = (): Record<string, unknown> => ({
  activeSessionId: null,
  sessionStates: {},
  setMcpServerEnabled: mockSetMcpServerEnabled,
  submitMcpAuthCode: mockSubmitMcpAuthCode,
  removeMcpServer: mockRemoveMcpServer,
  addMcpServer: mockAddMcpServer,
  mcpConfigForbiddenNonPrimary: false,
})
let mockStoreState: Record<string, unknown> = defaultMockState()
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState),
}))

afterEach(() => {
  cleanup()
  mockSetMcpServerEnabled.mockClear()
  mockSubmitMcpAuthCode.mockClear()
  mockRemoveMcpServer.mockClear()
  mockAddMcpServer.mockClear()
  mockStoreState = defaultMockState()
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

describe('SidebarMcpView OAuth affordance (#6822)', () => {
  const oauthSrv: McpServer = { name: 'remote', status: 'oauth-required', enabled: true, canToggle: true, authUrl: 'https://as.example/authorize?x=1' }

  it('renders an Authorize link pointing at the authUrl for an oauth-required server', () => {
    render(<SidebarMcpView servers={[oauthSrv]} />)
    const link = screen.getByTestId('sidebar-mcp-view-authorize-remote') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://as.example/authorize?x=1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.getByTestId('sidebar-mcp-view-auth-input-remote')).toBeTruthy()
  })

  it('does NOT render the auth affordance for a connected server', () => {
    render(<SidebarMcpView servers={[{ name: 'fs', status: 'connected', canToggle: true }]} />)
    expect(screen.queryByTestId('sidebar-mcp-view-auth-fs')).toBeNull()
  })

  it('submits the pasted code via submitMcpAuthCode(name, code)', () => {
    render(<SidebarMcpView servers={[oauthSrv]} />)
    const input = screen.getByTestId('sidebar-mcp-view-auth-input-remote') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  auth-code-123  ' } })
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-auth-submit-remote'))
    expect(mockSubmitMcpAuthCode).toHaveBeenCalledTimes(1)
    expect(mockSubmitMcpAuthCode).toHaveBeenCalledWith('remote', 'auth-code-123')
    // The input clears after submit.
    expect(input.value).toBe('')
  })

  it('does not submit an empty/whitespace code', () => {
    render(<SidebarMcpView servers={[oauthSrv]} />)
    const submit = screen.getByTestId('sidebar-mcp-view-auth-submit-remote') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit)
    expect(mockSubmitMcpAuthCode).not.toHaveBeenCalled()
  })

  it('renders the paste input even when authUrl is absent (paste-only fallback)', () => {
    render(<SidebarMcpView servers={[{ name: 'remote', status: 'oauth-required', canToggle: true }]} />)
    expect(screen.queryByTestId('sidebar-mcp-view-authorize-remote')).toBeNull()
    expect(screen.getByTestId('sidebar-mcp-view-auth-input-remote')).toBeTruthy()
  })
})

describe('SidebarMcpView remove action (#6999)', () => {
  it('renders a Remove button per row and hides it while the confirm strip is open', () => {
    render(<SidebarMcpView servers={[srv('filesystem', 'connected')]} />)
    expect(screen.getByTestId('sidebar-mcp-view-remove-filesystem')).toBeTruthy()
    expect(screen.queryByTestId('sidebar-mcp-view-remove-confirm-filesystem')).toBeNull()
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-filesystem'))
    expect(screen.queryByTestId('sidebar-mcp-view-remove-filesystem')).toBeNull()
    expect(screen.getByTestId('sidebar-mcp-view-remove-confirm-filesystem')).toBeTruthy()
  })

  it('cancel returns to the idle Remove button without calling removeMcpServer', () => {
    render(<SidebarMcpView servers={[srv('filesystem', 'connected')]} />)
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-filesystem'))
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-cancel-filesystem'))
    expect(screen.getByTestId('sidebar-mcp-view-remove-filesystem')).toBeTruthy()
    expect(mockRemoveMcpServer).not.toHaveBeenCalled()
  })

  it('confirm calls removeMcpServer(name, scope, callback) with the default "user" scope', () => {
    render(<SidebarMcpView servers={[srv('filesystem', 'connected')]} />)
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-filesystem'))
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-confirm-btn-filesystem'))
    expect(mockRemoveMcpServer).toHaveBeenCalledTimes(1)
    const [name, scope, callback] = mockRemoveMcpServer.mock.calls[0]!
    expect(name).toBe('filesystem')
    expect(scope).toBe('user')
    expect(typeof callback).toBe('function')
  })

  it('honors a "project" scope selection before confirming', () => {
    render(<SidebarMcpView servers={[srv('filesystem', 'connected')]} />)
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-filesystem'))
    fireEvent.change(screen.getByTestId('sidebar-mcp-view-remove-scope-filesystem'), { target: { value: 'project' } })
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-confirm-btn-filesystem'))
    expect(mockRemoveMcpServer).toHaveBeenCalledWith('filesystem', 'project', expect.any(Function))
  })

  it('a failed removal (callback ok:false) surfaces the server message and returns to the confirm step', () => {
    render(<SidebarMcpView servers={[srv('filesystem', 'connected')]} />)
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-filesystem'))
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-confirm-btn-filesystem'))
    const callback = mockRemoveMcpServer.mock.calls[0]![2] as (r: { ok: boolean; code?: string; message?: string }) => void
    act(() => {
      callback({ ok: false, code: 'MCP_SERVER_NOT_FOUND', message: "No MCP server named 'filesystem' in project scope." })
    })
    expect(screen.getByTestId('sidebar-mcp-view-remove-error-filesystem').textContent).toBe(
      "No MCP server named 'filesystem' in project scope.",
    )
    // Still on the confirm step (not silently dropped back to idle) so the user can retry a different scope.
    expect(screen.getByTestId('sidebar-mcp-view-remove-confirm-filesystem')).toBeTruthy()
  })

  it('a successful removal (callback ok:true) does not synthesize any local success message — the row leaving the list on the next mcp_servers broadcast IS the confirmation', () => {
    render(<SidebarMcpView servers={[srv('filesystem', 'connected')]} />)
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-filesystem'))
    fireEvent.click(screen.getByTestId('sidebar-mcp-view-remove-confirm-btn-filesystem'))
    const callback = mockRemoveMcpServer.mock.calls[0]![2] as (r: { ok: boolean }) => void
    act(() => {
      callback({ ok: true })
    })
    expect(screen.queryByTestId('sidebar-mcp-view-remove-error-filesystem')).toBeNull()
  })

  it('disables the Remove button and explains why when mcpConfigForbiddenNonPrimary is true', () => {
    mockStoreState = { ...mockStoreState, mcpConfigForbiddenNonPrimary: true }
    render(<SidebarMcpView servers={[srv('filesystem', 'connected')]} />)
    const btn = screen.getByTestId('sidebar-mcp-view-remove-filesystem') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toMatch(/primary API token/)
  })
})

describe('SidebarMcpView embeds the add-server form (#6999)', () => {
  it('always renders the AddMcpServerForm entry point, even with zero servers', () => {
    render(<SidebarMcpView servers={[]} />)
    expect(screen.getByTestId('add-mcp-server-open')).toBeTruthy()
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
