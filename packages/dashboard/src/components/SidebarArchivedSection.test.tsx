/**
 * SidebarArchivedSection — renderer tests (mocked store, like
 * ArchivedSessionsSection.test.tsx). null → not asked yet · [] → nothing
 * archived · refused → may not see: three different claims.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import * as fs from 'fs'
import * as path from 'path'
import type { ServerArchivedSessionsListMessage } from '@chroxy/protocol'
import type { HistoryPageView } from '../store/types'

const state = {
  archivedSessions: null as ServerArchivedSessionsListMessage | null,
  archivedSessionsLoading: false,
  connectionPhase: 'connected' as string,
  archivedSessionHistories: {} as Record<string, HistoryPageView>,
  requestArchivedSessions: vi.fn(() => true),
  requestArchivedSessionHistory: vi.fn(() => true),
  closeArchivedSessionHistory: vi.fn(),
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => selector(state),
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }))

import { SidebarArchivedSection } from './SidebarArchivedSection'

// This repo's RTL has no auto-cleanup — a leaked tree fails the NEXT file.
afterEach(() => {
  cleanup()
  state.archivedSessions = null
  state.archivedSessionsLoading = false
  state.connectionPhase = 'connected'
  state.archivedSessionHistories = {}
  vi.clearAllMocks()
})

const A = 'arch-aaaa'
const B = 'arch-bbbb'
const policy = { enabled: true, maxEntries: 200, maxAgeDays: 30, maxMegabytes: 256 }

function row(archiveId: string, over: Record<string, unknown> = {}) {
  return {
    archiveId, sessionId: `sid-${archiveId}`, name: `Name ${archiveId}`, provider: 'claude', cwd: '/srv/work/chroxy',
    model: null, reason: 'idle_timeout', archivedAt: Date.UTC(2026, 9, 1, 12, 0, 0), lastActivityAt: null,
    createdAt: null, historyLength: 4, bytes: 100, ...over,
  }
}
function snapshot(over: Partial<ServerArchivedSessionsListMessage> = {}): ServerArchivedSessionsListMessage {
  return {
    type: 'archived_sessions_list', generatedAt: '2026-10-01T00:00:00.000Z', policy, sessions: [row(A)], ...over,
  } as ServerArchivedSessionsListMessage
}
const view = (over: Partial<HistoryPageView> = {}): HistoryPageView => ({
  entries: [], total: 0, loading: false, pendingOffset: null, ...over,
})
const expand = () => fireEvent.click(screen.getByTestId('sidebar-archived-toggle'))

describe('SidebarArchivedSection — collapse + fetch', () => {
  it('is collapsed by default and sends nothing', () => {
    render(<SidebarArchivedSection />)
    expect(screen.getByTestId('sidebar-archived-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('sidebar-archived-section')).toBeNull()
    expect(state.requestArchivedSessions).not.toHaveBeenCalled()
  })

  it('expanding while connected with no snapshot requests exactly once', () => {
    render(<SidebarArchivedSection />)
    expand()
    expect(screen.getByTestId('sidebar-archived-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(state.requestArchivedSessions).toHaveBeenCalledTimes(1)
  })

  it('does not request when a snapshot is already loaded', () => {
    state.archivedSessions = snapshot()
    render(<SidebarArchivedSection />)
    expand()
    expect(state.requestArchivedSessions).not.toHaveBeenCalled()
  })

  it('does not request while disconnected, and does when the connection returns', () => {
    state.connectionPhase = 'disconnected'
    const { rerender } = render(<SidebarArchivedSection />)
    expand()
    expect(state.requestArchivedSessions).not.toHaveBeenCalled()
    state.connectionPhase = 'connected'
    rerender(<SidebarArchivedSection />)
    expect(state.requestArchivedSessions).toHaveBeenCalledTimes(1)
  })

  it('re-requests after the store resets the snapshot to null', () => {
    state.archivedSessions = snapshot()
    const { rerender } = render(<SidebarArchivedSection />)
    expand()
    expect(state.requestArchivedSessions).not.toHaveBeenCalled()
    state.archivedSessions = null
    state.connectionPhase = 'disconnected'
    rerender(<SidebarArchivedSection />)
    expect(state.requestArchivedSessions).not.toHaveBeenCalled()
    state.connectionPhase = 'connected'
    rerender(<SidebarArchivedSection />)
    expect(state.requestArchivedSessions).toHaveBeenCalledTimes(1)
  })

  it('does not request while a request is already in flight', () => {
    state.archivedSessionsLoading = true
    render(<SidebarArchivedSection />)
    expand()
    expect(state.requestArchivedSessions).not.toHaveBeenCalled()
  })
})

describe('SidebarArchivedSection — states', () => {
  it('shows Loading, never empty, before the first reply', () => {
    render(<SidebarArchivedSection />)
    expand()
    expect(screen.getByTestId('sidebar-archived-loading')).toBeTruthy()
    expect(screen.queryByTestId('sidebar-archived-empty')).toBeNull()
    expect(screen.getByTestId('sidebar-archived-toggle').textContent).toBe('▾Archived')
  })

  it('says so for a genuinely empty archive', () => {
    state.archivedSessions = snapshot({ sessions: [] })
    render(<SidebarArchivedSection />)
    expand()
    expect(screen.getByTestId('sidebar-archived-empty')).toBeTruthy()
    expect(screen.queryByTestId('sidebar-archived-loading')).toBeNull()
    expect(screen.getByTestId('sidebar-archived-toggle').textContent).toContain('Archived (0)')
  })

  it('explains a refusal: no list, no policy, no count, not "empty"', () => {
    state.archivedSessions = snapshot({ sessions: [row(A)], refused: true })
    render(<SidebarArchivedSection />)
    expand()
    expect(screen.getByTestId('sidebar-archived-refused')).toBeTruthy()
    expect(screen.queryByTestId('sidebar-archived-empty')).toBeNull()
    expect(screen.queryByTestId('sidebar-archived-loading')).toBeNull()
    expect(screen.queryByTestId('sidebar-archived-policy')).toBeNull()
    expect(screen.queryByTestId(`sidebar-archived-row-${A}`)).toBeNull()
    expect(screen.getByTestId('sidebar-archived-toggle').textContent).toBe('▾Archived')
  })

  it('renders the shared policy line (enabled and off)', () => {
    state.archivedSessions = snapshot()
    const { unmount } = render(<SidebarArchivedSection />)
    expand()
    const text = screen.getByTestId('sidebar-archived-policy').textContent ?? ''
    expect(text.includes('Ended sessions are kept here for up to 30 days (200 sessions, 256 MB).')).toBe(true)
    unmount()
    state.archivedSessions = snapshot({ policy: { ...policy, enabled: false } })
    render(<SidebarArchivedSection />)
    expand()
    expect((screen.getByTestId('sidebar-archived-policy').textContent ?? '').includes('Archiving is off')).toBe(true)
  })

  it('notes a truncated list', () => {
    state.archivedSessions = snapshot({ truncated: true })
    render(<SidebarArchivedSection />)
    expand()
    expect(screen.getByTestId('sidebar-archived-truncated')).toBeTruthy()
  })
})

describe('SidebarArchivedSection — rows', () => {
  it('renders rows in server order with name, project, reason and time', () => {
    state.archivedSessions = snapshot({ sessions: [row(B, { name: null }), row(A)] })
    render(<SidebarArchivedSection />)
    expand()
    const ids = screen.getAllByTestId(/^sidebar-archived-row-/).map((e) => e.getAttribute('data-testid'))
    expect(ids).toEqual([`sidebar-archived-row-${B}`, `sidebar-archived-row-${A}`])
    expect(screen.getByText(`sid-${B}`)).toBeTruthy()
    expect(screen.getAllByText('chroxy')[0]?.getAttribute('title')).toBe('/srv/work/chroxy')
    expect(screen.getAllByText(/Idle timeout/).length).toBe(2)
    expect(screen.getAllByText(new RegExp(new Date(Date.UTC(2026, 9, 1, 12, 0, 0)).toLocaleString().replace(/[()]/g, '\\$&'))).length).toBe(2)
    expect(screen.getByTestId('sidebar-archived-toggle').textContent).toContain('Archived (2)')
  })

  it('has no delete controls', () => {
    state.archivedSessions = snapshot()
    render(<SidebarArchivedSection />)
    expand()
    expect(screen.queryByText(/delete/i)).toBeNull()
  })

  it('clicking a closed row requests its history; no panel yet', () => {
    state.archivedSessions = snapshot()
    render(<SidebarArchivedSection />)
    expand()
    const btn = screen.getByTestId(`sidebar-archived-row-${A}`)
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.getAttribute('aria-controls')).toBeNull()
    fireEvent.click(btn)
    expect(state.requestArchivedSessionHistory).toHaveBeenCalledWith(A)
    expect(state.closeArchivedSessionHistory).not.toHaveBeenCalled()
  })

  it('with a history view it renders the shared panel and clicking again closes', () => {
    state.archivedSessions = snapshot()
    state.archivedSessionHistories = { [A]: view() }
    render(<SidebarArchivedSection />)
    expand()
    const btn = screen.getByTestId(`sidebar-archived-row-${A}`)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(btn.getAttribute('aria-controls')).toBe(`archived-session-history-panel-${A}`)
    expect(document.getElementById(`archived-session-history-panel-${A}`)).not.toBeNull()
    fireEvent.click(btn)
    expect(state.closeArchivedSessionHistory).toHaveBeenCalledWith(A)
    expect(state.requestArchivedSessionHistory).not.toHaveBeenCalled()
  })

  it('disconnected: refresh and opening are disabled, closing is not', () => {
    state.connectionPhase = 'disconnected'
    state.archivedSessions = snapshot({ sessions: [row(A), row(B)] })
    state.archivedSessionHistories = { [B]: view() }
    render(<SidebarArchivedSection />)
    expand()
    expect((screen.getByTestId('sidebar-archived-refresh') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId(`sidebar-archived-row-${A}`) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId(`sidebar-archived-row-${B}`) as HTMLButtonElement).disabled).toBe(false)
  })

  it('refresh requests the list and is disabled while loading', () => {
    state.archivedSessions = snapshot()
    const { rerender } = render(<SidebarArchivedSection />)
    expand()
    fireEvent.click(screen.getByTestId('sidebar-archived-refresh'))
    expect(state.requestArchivedSessions).toHaveBeenCalledTimes(1)
    state.archivedSessionsLoading = true
    rerender(<SidebarArchivedSection />)
    expect((screen.getByTestId('sidebar-archived-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('SidebarArchivedSection — CSS tap targets (#8867)', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
  it('toggle, refresh and row share a 44px min-height rule', () => {
    const m = css.match(/\.sidebar-archived-toggle,\s*\.sidebar-archived-refresh,\s*\.sidebar-archived-row\s*\{([^}]*)\}/)
    expect(m !== null).toBe(true)
    expect(/min-height:\s*44px/.test(m?.[1] ?? '')).toBe(true)
  })
})
