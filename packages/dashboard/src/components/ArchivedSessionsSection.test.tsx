/**
 * ArchivedSessionsSection — renderer tests (mocked store, like
 * FailedRestoresSection.test.tsx). The empties are three different claims:
 *   null → not asked yet · [] → asked, nothing archived · refused → may not see.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerArchivedSessionsListMessage } from '@chroxy/protocol'
import type { HistoryPageView } from '../store/types'

const state = {
  archivedSessions: null as ServerArchivedSessionsListMessage | null,
  archivedSessionsLoading: false,
  connectionPhase: 'connected' as string,
  archivedSessionHistories: {} as Record<string, HistoryPageView>,
  deletingArchiveIds: new Set<string>(),
  deletingAllArchives: false,
  archiveDeleteError: null as { archiveId?: string; code?: string; message?: string; refused?: boolean } | null,
  requestArchivedSessions: vi.fn(() => true),
  requestArchivedSessionHistory: vi.fn(() => true),
  closeArchivedSessionHistory: vi.fn(),
  deleteArchivedSession: vi.fn(() => true),
  deleteAllArchivedSessions: vi.fn(() => true),
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => selector(state),
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }))

import { ArchivedSessionsSection } from './ArchivedSessionsSection'

// This repo's RTL has no auto-cleanup — a leaked tree fails the NEXT file.
afterEach(() => {
  cleanup()
  state.archivedSessions = null
  state.archivedSessionsLoading = false
  state.connectionPhase = 'connected'
  state.archivedSessionHistories = {}
  state.deletingArchiveIds = new Set<string>()
  state.deletingAllArchives = false
  state.archiveDeleteError = null
  vi.clearAllMocks()
})

const A = 'arch-aaaa'
const B = 'arch-bbbb'
const policy = { enabled: true, maxEntries: 200, maxAgeDays: 30, maxMegabytes: 256 }

function row(archiveId: string, over: Record<string, unknown> = {}) {
  return {
    archiveId, sessionId: `sid-${archiveId}`, name: 'Nightly agent', provider: 'claude', cwd: '/srv/work/chroxy',
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

describe('ArchivedSessionsSection — states', () => {
  it('does NOT claim the archive is empty before it has been asked for', () => {
    render(<ArchivedSessionsSection />)
    expect(screen.queryByTestId('archived-sessions-empty')).toBeNull()
  })

  it('says so for a genuinely empty archive', () => {
    state.archivedSessions = snapshot({ sessions: [] })
    render(<ArchivedSessionsSection />)
    expect(screen.getByTestId('archived-sessions-empty')).toBeTruthy()
    expect(screen.queryByTestId('archived-sessions-delete-all')).toBeNull()
  })

  it('explains a refusal instead of claiming the archive is empty', () => {
    state.archivedSessions = snapshot({ sessions: [], refused: true })
    render(<ArchivedSessionsSection />)
    expect(screen.getByTestId('archived-sessions-refused')).toBeTruthy()
    expect(screen.queryByTestId('archived-sessions-empty')).toBeNull()
    expect(screen.queryByTestId('archived-sessions-policy')).toBeNull()
  })

  it('renders the enabled policy line', () => {
    state.archivedSessions = snapshot()
    render(<ArchivedSessionsSection />)
    const text = screen.getByTestId('archived-sessions-policy').textContent ?? ''
    expect(text.includes('Ended sessions are kept here for up to 30 days (200 sessions, 256 MB).')).toBe(true)
    expect(text.includes('sessionArchive')).toBe(true)
  })

  it('renders the disabled policy line', () => {
    state.archivedSessions = snapshot({ policy: { ...policy, enabled: false } })
    render(<ArchivedSessionsSection />)
    const text = screen.getByTestId('archived-sessions-policy').textContent ?? ''
    expect(text.includes('Archiving is off — ended sessions are not kept. Existing archives stay until deleted or aged out.')).toBe(true)
    expect(text.includes('up to 30 days')).toBe(false)
  })

  it('renders a row: name, provider, reason label, time, count, cwd with title', () => {
    state.archivedSessions = snapshot()
    render(<ArchivedSessionsSection />)
    expect(screen.getByTestId(`archived-session-${A}`)).toBeTruthy()
    expect(screen.getByText('Nightly agent')).toBeTruthy()
    expect(screen.getByText('claude')).toBeTruthy()
    expect(screen.getByText('Idle timeout')).toBeTruthy()
    expect(screen.getByText('4 messages')).toBeTruthy()
    expect(screen.getByText('/srv/work/chroxy').getAttribute('title')).toBe('/srv/work/chroxy')
    expect(screen.getByText(new Date(Date.UTC(2026, 9, 1, 12, 0, 0)).toLocaleString())).toBeTruthy()
  })

  it('falls back to the sessionId for an unnamed session and shows an unknown reason as-is', () => {
    state.archivedSessions = snapshot({ sessions: [row(A, { name: null, provider: null, cwd: null, reason: 'brand_new', archivedAt: null, historyLength: 1 })] })
    render(<ArchivedSessionsSection />)
    expect(screen.getByText(`sid-${A}`)).toBeTruthy()
    expect(screen.getByText('brand_new')).toBeTruthy()
    expect(screen.getByText('Unknown time')).toBeTruthy()
    expect(screen.getByText('1 message')).toBeTruthy()
  })

  it.each([
    ['closed', 'Closed'],
    ['idle_timeout', 'Idle timeout'],
    ['respawn_exhausted', 'Stopped after repeated crashes'],
    ['stale', 'Inactive for 24h at restart'],
    ['failed_restore_expired', 'Failed restore expired'],
    ['failed_restore_dismissed', 'Failed restore dismissed'],
  ])('labels reason %s as %s', (reason, label) => {
    state.archivedSessions = snapshot({ sessions: [row(A, { reason })] })
    render(<ArchivedSessionsSection />)
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('renders hostile text as text, never markup', () => {
    state.archivedSessions = snapshot({ sessions: [row(A, { name: '<img src=x onerror=alert(1)>' })] })
    const { container } = render(<ArchivedSessionsSection />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  })

  it('every button is type=button and Refresh is disabled while loading / disconnected', () => {
    state.archivedSessions = snapshot()
    state.archivedSessionsLoading = true
    render(<ArchivedSessionsSection />)
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every((b) => b.type === 'button')).toBe(true)
    expect((screen.getByTestId('archived-sessions-refresh') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    state.archivedSessionsLoading = false
    state.connectionPhase = 'disconnected'
    render(<ArchivedSessionsSection />)
    expect((screen.getByTestId('archived-sessions-refresh') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Refresh requests the list', () => {
    state.archivedSessions = snapshot()
    render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId('archived-sessions-refresh'))
    expect(state.requestArchivedSessions).toHaveBeenCalledTimes(1)
  })
})

describe('ArchivedSessionsSection — View history', () => {
  const toggle = () => screen.getByTestId(`archived-session-history-toggle-${A}`) as HTMLButtonElement

  it('opening requests page one; the closed toggle has no aria-controls', () => {
    state.archivedSessions = snapshot()
    render(<ArchivedSessionsSection />)
    expect(toggle().textContent).toBe('View history')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().hasAttribute('aria-controls')).toBe(false)
    fireEvent.click(toggle())
    expect(state.requestArchivedSessionHistory).toHaveBeenCalledWith(A)
    expect(state.closeArchivedSessionHistory).not.toHaveBeenCalled()
  })

  it('an open view shows the panel, points aria-controls at it, and the toggle closes it', () => {
    state.archivedSessions = snapshot()
    state.archivedSessionHistories = { [A]: view({ loading: true, pendingOffset: 0, total: null }) }
    render(<ArchivedSessionsSection />)
    const panel = screen.getByTestId(`archived-session-history-${A}`)
    expect(screen.getByTestId(`archived-session-history-loading-${A}`)).toBeTruthy()
    expect(toggle().textContent).toBe('Hide history')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(toggle().getAttribute('aria-controls') as string)).toBe(panel)
    fireEvent.click(toggle())
    expect(state.closeArchivedSessionHistory).toHaveBeenCalledWith(A)
  })

  it('opening is disabled while disconnected, closing is not', () => {
    state.archivedSessions = snapshot()
    state.connectionPhase = 'disconnected'
    render(<ArchivedSessionsSection />)
    expect(toggle().disabled).toBe(true)
    cleanup()
    state.archivedSessionHistories = { [A]: view() }
    render(<ArchivedSessionsSection />)
    expect(toggle().disabled).toBe(false)
  })

  it('Load more asks for the next page; NOT_FOUND reads as a deleted archive', () => {
    state.archivedSessions = snapshot()
    state.archivedSessionHistories = {
      [A]: view({ entries: [{ type: 'message', messageType: 'response', content: 'hi' }] as never, total: 120 }),
    }
    render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId(`archived-session-history-more-${A}`))
    expect(state.requestArchivedSessionHistory).toHaveBeenCalledWith(A, true)
    cleanup()

    state.archivedSessionHistories = { [A]: view({ total: null, error: { code: 'ARCHIVED_SESSION_NOT_FOUND', refused: false } }) }
    render(<ArchivedSessionsSection />)
    expect((screen.getByTestId(`archived-session-history-error-${A}`).textContent ?? '').includes('no longer exists')).toBe(true)
    // not-found is terminal: no "Try again" for a record that is gone
    expect(screen.queryByTestId(`archived-session-history-reload-${A}`)).toBeNull()
  })

  it('a generic error offers Try again, which restarts from the first page', () => {
    state.archivedSessions = snapshot()
    state.archivedSessionHistories = { [A]: view({ total: null, error: { code: 'X', message: 'boom', refused: false } }) }
    render(<ArchivedSessionsSection />)
    expect((screen.getByTestId(`archived-session-history-error-${A}`).textContent ?? '')).toBe('boom')
    fireEvent.click(screen.getByTestId(`archived-session-history-reload-${A}`))
    expect(state.requestArchivedSessionHistory).toHaveBeenCalledWith(A, false)
  })
})

describe('ArchivedSessionsSection — delete (two-step)', () => {
  it('the first click only arms the confirmation and sends nothing', () => {
    state.archivedSessions = snapshot()
    render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId(`archived-session-delete-${A}`))
    expect(state.deleteArchivedSession).not.toHaveBeenCalled()
    expect(screen.getByTestId(`archived-session-delete-confirm-${A}`).textContent).toBe('Confirm delete')
    expect(screen.queryByTestId(`archived-session-delete-${A}`)).toBeNull()
  })

  it('Confirm delete sends for that row only and disarms', () => {
    state.archivedSessions = snapshot({ sessions: [row(A), row(B)] })
    render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId(`archived-session-delete-${A}`))
    // the other row is still unarmed
    expect(screen.getByTestId(`archived-session-delete-${B}`)).toBeTruthy()
    fireEvent.click(screen.getByTestId(`archived-session-delete-confirm-${A}`))
    expect(state.deleteArchivedSession).toHaveBeenCalledTimes(1)
    expect(state.deleteArchivedSession).toHaveBeenCalledWith(A)
    expect(screen.queryByTestId(`archived-session-delete-confirm-${A}`)).toBeNull()
  })

  it('Cancel disarms without sending', () => {
    state.archivedSessions = snapshot()
    render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId(`archived-session-delete-${A}`))
    fireEvent.click(screen.getByTestId(`archived-session-delete-cancel-${A}`))
    expect(state.deleteArchivedSession).not.toHaveBeenCalled()
    expect(screen.getByTestId(`archived-session-delete-${A}`)).toBeTruthy()
  })

  it('is disabled while that delete is pending (and shows progress) or disconnected', () => {
    state.archivedSessions = snapshot()
    state.deletingArchiveIds = new Set([A])
    render(<ArchivedSessionsSection />)
    const btn = screen.getByTestId(`archived-session-delete-${A}`) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toBe('Deleting…')
    cleanup()
    state.deletingArchiveIds = new Set()
    state.connectionPhase = 'disconnected'
    render(<ArchivedSessionsSection />)
    expect((screen.getByTestId(`archived-session-delete-${A}`) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says how many earliest messages were too large to keep, only when some were', () => {
    state.archivedSessions = snapshot({ sessions: [row(A, { omittedOldest: 3 }), row(B, { omittedOldest: 1 })] })
    render(<ArchivedSessionsSection />)
    expect((screen.getByTestId(`archived-session-omitted-${A}`).textContent ?? '').includes('3 earliest messages were too large to keep')).toBe(true)
    expect((screen.getByTestId(`archived-session-omitted-${B}`).textContent ?? '').includes('1 earliest message was too large to keep')).toBe(true)
    cleanup()
    state.archivedSessions = snapshot({ sessions: [row(A, { omittedOldest: 0 }), row(B)] })
    render(<ArchivedSessionsSection />)
    expect(screen.queryByTestId(`archived-session-omitted-${A}`)).toBeNull()
    expect(screen.queryByTestId(`archived-session-omitted-${B}`)).toBeNull()
  })

  it('renders a per-row delete error and a not-found as a stale row', () => {
    state.archivedSessions = snapshot()
    state.archiveDeleteError = { archiveId: A, code: 'BOOM', message: 'disk full' }
    render(<ArchivedSessionsSection />)
    expect(screen.getByTestId(`archived-session-delete-error-${A}`).textContent).toBe('disk full')
    cleanup()
    state.archiveDeleteError = { archiveId: A, code: 'ARCHIVED_SESSION_NOT_FOUND' }
    render(<ArchivedSessionsSection />)
    expect((screen.getByTestId(`archived-session-delete-error-${A}`).textContent ?? '').includes('no longer exists')).toBe(true)
  })
})

describe('ArchivedSessionsSection — delete all (two-step)', () => {
  it('the first click only arms; Confirm sends once; Cancel sends nothing', () => {
    state.archivedSessions = snapshot()
    render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId('archived-sessions-delete-all'))
    expect(state.deleteAllArchivedSessions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('archived-sessions-delete-all-cancel'))
    expect(state.deleteAllArchivedSessions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('archived-sessions-delete-all'))
    fireEvent.click(screen.getByTestId('archived-sessions-delete-all-confirm'))
    expect(state.deleteAllArchivedSessions).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('archived-sessions-delete-all-confirm')).toBeNull()
  })

  it('is disabled while a delete-all is pending, and a section-level error is shown', () => {
    state.archivedSessions = snapshot()
    state.deletingAllArchives = true
    state.archiveDeleteError = { code: 'X', message: 'nope' }
    render(<ArchivedSessionsSection />)
    expect((screen.getByTestId('archived-sessions-delete-all') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('archived-sessions-delete-error').textContent).toBe('nope')
  })
})

describe('ArchivedSessionsSection — armed confirmations are bound to the list they were armed against', () => {
  it('the confirm label carries the count of rows it will delete', () => {
    state.archivedSessions = snapshot({ sessions: [row(A), row(B)] })
    render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId('archived-sessions-delete-all'))
    expect((screen.getByTestId('archived-sessions-delete-all-confirm').textContent ?? '').includes('Confirm delete all (2)')).toBe(true)
  })

  it('a truncated list does not claim a count, since delete-all removes unlisted records too', () => {
    state.archivedSessions = snapshot({ sessions: [row(A), row(B)], truncated: true })
    render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId('archived-sessions-delete-all'))
    const label = screen.getByTestId('archived-sessions-delete-all-confirm').textContent ?? ''
    expect(label.includes('(2)')).toBe(false)
    expect(label.includes('more than listed')).toBe(true)
  })

  it('a refreshed list (new generatedAt) DISARMS "Confirm delete all" and any armed row', () => {
    state.archivedSessions = snapshot({ sessions: [row(A), row(B)] })
    const { rerender } = render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId('archived-sessions-delete-all'))
    fireEvent.click(screen.getByTestId(`archived-session-delete-${A}`))
    expect(screen.getByTestId('archived-sessions-delete-all-confirm')).toBeTruthy()
    expect(screen.getByTestId(`archived-session-delete-confirm-${A}`)).toBeTruthy()

    state.archivedSessions = snapshot({ generatedAt: '2026-10-01T00:05:00.000Z', sessions: [row(A), row(B), row('arch-cccc')] })
    rerender(<ArchivedSessionsSection />)

    expect(screen.queryByTestId('archived-sessions-delete-all-confirm')).toBeNull()
    expect(screen.queryByTestId(`archived-session-delete-confirm-${A}`)).toBeNull()
    expect(screen.getByTestId('archived-sessions-delete-all')).toBeTruthy()
    expect(state.deleteAllArchivedSessions).not.toHaveBeenCalled()
  })

  it('a list that goes to zero rows disarms it', () => {
    state.archivedSessions = snapshot({ sessions: [row(A)] })
    const { rerender } = render(<ArchivedSessionsSection />)
    fireEvent.click(screen.getByTestId('archived-sessions-delete-all'))
    expect(screen.getByTestId('archived-sessions-delete-all-confirm')).toBeTruthy()
    state.archivedSessions = snapshot({ sessions: [] }) // same generatedAt: only the row count changed
    rerender(<ArchivedSessionsSection />)
    state.archivedSessions = snapshot({ sessions: [row(A)] })
    rerender(<ArchivedSessionsSection />)
    expect(screen.queryByTestId('archived-sessions-delete-all-confirm')).toBeNull()
  })
})

describe('ArchivedSessionsSection — delete-all pending, labels and truncation', () => {
  it('per-row Delete is disabled while a delete-all is pending', () => {
    state.archivedSessions = snapshot({ sessions: [row(A), row(B)] })
    state.deletingAllArchives = true
    render(<ArchivedSessionsSection />)
    expect((screen.getByTestId(`archived-session-delete-${A}`) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId(`archived-session-delete-${B}`) as HTMLButtonElement).disabled).toBe(true)
  })

  it('row buttons are labelled with the session name', () => {
    state.archivedSessions = snapshot({ sessions: [row(A, { name: 'Nightly agent' })] })
    render(<ArchivedSessionsSection />)
    expect(screen.getByTestId(`archived-session-history-toggle-${A}`).getAttribute('aria-label')).toBe('View history for Nightly agent')
    expect(screen.getByTestId(`archived-session-delete-${A}`).getAttribute('aria-label')).toBe('Delete archived session Nightly agent')
    fireEvent.click(screen.getByTestId(`archived-session-delete-${A}`))
    expect(screen.getByTestId(`archived-session-delete-confirm-${A}`).getAttribute('aria-label')).toBe('Confirm delete archived session Nightly agent')
    state.archivedSessionHistories = { [A]: view() }
    cleanup()
    render(<ArchivedSessionsSection />)
    expect(screen.getByTestId(`archived-session-history-toggle-${A}`).getAttribute('aria-label')).toBe('Hide history for Nightly agent')
  })

  it('says the list is cut when the daemon truncated it, and not otherwise', () => {
    state.archivedSessions = snapshot({ sessions: [row(A), row(B)], truncated: true })
    render(<ArchivedSessionsSection />)
    expect((screen.getByTestId('archived-sessions-truncated').textContent ?? '').includes('Showing the newest 2 archived sessions')).toBe(true)
    cleanup()
    state.archivedSessions = snapshot({ sessions: [row(A), row(B)] })
    render(<ArchivedSessionsSection />)
    expect(screen.queryByTestId('archived-sessions-truncated')).toBeNull()
  })
})
