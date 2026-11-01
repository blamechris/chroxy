/**
 * ArchivedSessionRestoreActions (#8866) — mocked store, like the other archive
 * renderers. Claims: nothing is offered without the daemon's hint; Resume and
 * Continue as new thread are separate explicit buttons; a greyed one says why;
 * the outcome line states WHICH thing happened (a new thread is never described
 * as the original conversation).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerArchivedSessionMeta } from '@chroxy/protocol'

const state = {
  connectionPhase: 'connected' as string,
  restoringArchiveIds: new Set<string>(),
  archiveRestoreResults: {} as Record<string, unknown>,
  restoreArchivedSession: vi.fn(() => true),
}
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => selector(state),
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }))

import { ArchivedSessionRestoreActions, ArchivedRestoreStatus } from './ArchivedSessionRestoreActions'

afterEach(() => {
  cleanup()
  state.connectionPhase = 'connected'
  state.restoringArchiveIds = new Set()
  state.archiveRestoreResults = {}
  vi.clearAllMocks()
})

const A = 'arch-aaaa'
const row = (restore?: ServerArchivedSessionMeta['restore']): ServerArchivedSessionMeta => ({
  archiveId: A, sessionId: 'sid', name: 'Flag work', provider: 'claude-tui', cwd: '/w', model: null,
  reason: 'closed', archivedAt: 1, lastActivityAt: 1, createdAt: 1, historyLength: 3, bytes: 10,
  ...(restore ? { restore } : {}),
})
const native = () => screen.getByTestId(`archived-restore-native-${A}`) as HTMLButtonElement
const newThread = () => screen.getByTestId(`archived-restore-new-thread-${A}`) as HTMLButtonElement

describe('ArchivedSessionRestoreActions', () => {
  it('renders nothing for a daemon that sends no restore hint', () => {
    const { container } = render(<ArchivedSessionRestoreActions row={row()} />)
    expect(container.firstChild).toBeNull()
  })

  it('offers both actions and sends nothing until one is clicked, with the matching mode', () => {
    render(<ArchivedSessionRestoreActions row={row({ native: true, newThread: true })} />)
    expect(state.restoreArchivedSession).not.toHaveBeenCalled()
    fireEvent.click(native())
    expect(state.restoreArchivedSession).toHaveBeenLastCalledWith(A, 'native')
    fireEvent.click(newThread())
    expect(state.restoreArchivedSession).toHaveBeenLastCalledWith(A, 'new_thread')
  })

  it('greys Resume with the daemon\'s reason but leaves Continue as new thread usable', () => {
    render(<ArchivedSessionRestoreActions row={row({ native: false, nativeReason: 'This session recorded no provider conversation to resume.', newThread: true })} />)
    expect(native().disabled).toBe(true)
    expect(newThread().disabled).toBe(false)
    expect(screen.getByTestId(`archived-restore-native-reason-${A}`).textContent).toContain('recorded no provider conversation')
  })

  it('disables both while a restore is pending and when the socket is down', () => {
    state.restoringArchiveIds = new Set([A])
    const { unmount } = render(<ArchivedSessionRestoreActions row={row({ native: true, newThread: true })} />)
    expect(native().disabled).toBe(true)
    expect(newThread().disabled).toBe(true)
    unmount()
    state.restoringArchiveIds = new Set()
    state.connectionPhase = 'reconnecting'
    render(<ArchivedSessionRestoreActions row={row({ native: true, newThread: true })} />)
    expect(native().disabled).toBe(true)
  })

  it('states that a new thread is NOT the original conversation, with how much transcript rides along', () => {
    state.archiveRestoreResults = { [A]: { ok: true, mode: 'new_thread', sessionId: 'n1', seed: { messagesIncluded: 4, messagesTotal: 9, bytes: 10 } } }
    render(<ArchivedSessionRestoreActions row={row({ native: true, newThread: true })} />)
    const text = screen.getByTestId(`archived-restore-result-${A}`).textContent ?? ''
    expect(text).toContain('NEW thread')
    expect(text).toContain('not the original conversation')
    expect(text).toContain('4 of 9')
  })

  it('states that a native restore is the original conversation', () => {
    state.archiveRestoreResults = { [A]: { ok: true, mode: 'native', sessionId: 'n1' } }
    render(<ArchivedSessionRestoreActions row={row({ native: true, newThread: true })} />)
    expect(screen.getByTestId(`archived-restore-result-${A}`).textContent).toContain('Resumed the original conversation')
  })

  it('shows the reason a click was refused, and points a refused Resume at the new thread', () => {
    state.archiveRestoreResults = { [A]: { ok: false, mode: 'native', code: 'ARCHIVE_RESTORE_LOCATOR_MISSING', message: 'The provider transcript is gone.' } }
    render(<ArchivedSessionRestoreActions row={row({ native: true, newThread: true })} />)
    const text = screen.getByTestId(`archived-restore-result-${A}`).textContent ?? ''
    expect(text).toContain('The provider transcript is gone.')
    expect(text).toContain('new thread instead')
  })

  it('uses the sidebar test-id prefix on the sidebar surface', () => {
    render(<ArchivedSessionRestoreActions row={row({ native: true, newThread: true })} surface="sidebar" />)
    expect(screen.getByTestId(`sidebar-archived-restore-native-${A}`)).toBeTruthy()
  })

  it('only the CLICKED button reads Working… while pending', () => {
    const { rerender } = render(<ArchivedSessionRestoreActions row={row({ native: true, newThread: true })} />)
    fireEvent.click(newThread())
    state.restoringArchiveIds = new Set([A])
    rerender(<ArchivedSessionRestoreActions row={row({ native: true, newThread: true })} />)
    expect(newThread().textContent).toBe('Working…')
    expect(native().textContent).toBe('Resume')
  })
})

describe('ArchivedRestoreStatus (outcomes whose row has left the list)', () => {
  it('shows the outcome of a restore whose row is gone, naming it', () => {
    state.archiveRestoreResults = { [A]: { ok: true, mode: 'native', sessionId: 'n1', name: 'Flag work' } }
    render(<ArchivedRestoreStatus listedIds={[]} />)
    expect(screen.getByTestId('archived-restore-status').textContent).toContain('Resumed the original conversation of "Flag work"')
  })

  it('says a native restore that failed to START moved to Failed restores, and to use Retry there', () => {
    state.archiveRestoreResults = { [A]: { ok: false, mode: 'native', sessionId: 'parked-1', code: 'START_FAILED', message: 'pty died', name: 'Flag work' } }
    render(<ArchivedRestoreStatus listedIds={[]} />)
    const text = screen.getByTestId('archived-restore-status').textContent ?? ''
    expect(text).toContain('Failed restores')
    expect(text).toContain('Retry')
    expect(text).not.toContain('new thread instead')
  })

  it('does not duplicate an outcome that its listed row already shows', () => {
    state.archiveRestoreResults = { [A]: { ok: true, mode: 'new_thread', sessionId: 'n1' } }
    const { container } = render(<ArchivedRestoreStatus listedIds={[A]} />)
    expect(container.firstChild).toBeNull()
  })

  it('relays the server message for an already-live refusal', () => {
    state.archiveRestoreResults = { [A]: { ok: false, mode: 'native', code: 'ARCHIVE_RESTORE_ALREADY_LIVE', message: 'This conversation is already live as "X".', sessionId: 'x1' } }
    render(<ArchivedRestoreStatus listedIds={[]} />)
    expect(screen.getByTestId('archived-restore-status').textContent).toContain('already live as "X"')
  })
})
