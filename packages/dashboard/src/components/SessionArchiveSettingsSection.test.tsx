/**
 * SessionArchiveSettingsSection (#8869) — mocked store, like
 * ArchivedSessionsSection.test.tsx. Three different empties: snapshot null =
 * not asked yet, refused = may not change it, otherwise the editable form.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerArchivedSessionsListMessage } from '@chroxy/protocol'

const state = {
  archivedSessions: null as ServerArchivedSessionsListMessage | null,
  connectionPhase: 'connected' as string,
  sessionArchivePolicySaving: false,
  sessionArchivePolicyError: null as { code?: string; message?: string; refused?: boolean } | null,
  requestArchivedSessions: vi.fn(() => true),
  setSessionArchivePolicy: vi.fn((): string | null => 'r'),
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => selector(state),
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }))

import { SessionArchiveSettingsSection, validateArchivePolicyDraft } from './SessionArchiveSettingsSection'
import { ARCHIVE_REFUSED_TEXT } from './ArchivedSessionsSection'

afterEach(() => {
  cleanup()
  state.archivedSessions = null
  state.connectionPhase = 'connected'
  state.sessionArchivePolicySaving = false
  state.sessionArchivePolicyError = null
  vi.clearAllMocks()
})

const policy = { enabled: true, maxEntries: 200, maxAgeDays: 30, maxMegabytes: 256 }
const row = (id: string) => ({
  archiveId: id, sessionId: id, name: 'n', provider: 'claude', cwd: '/w', model: null, reason: 'closed',
  archivedAt: 1, lastActivityAt: 1, createdAt: 1, historyLength: 1, bytes: 1,
})
function snap(over: Partial<ServerArchivedSessionsListMessage> = {}, n = 3): ServerArchivedSessionsListMessage {
  return {
    type: 'archived_sessions_list', generatedAt: 'x', policy,
    sessions: Array.from({ length: n }, (_, i) => row(`a${i}`)), ...over,
  } as ServerArchivedSessionsListMessage
}
const input = (id: string) => screen.getByTestId(id) as HTMLInputElement
const save = () => screen.getByTestId('session-archive-save') as HTMLButtonElement
const type = (id: string, v: string) => fireEvent.change(input(id), { target: { value: v } })

describe('SessionArchiveSettingsSection', () => {
  it('asks for the archive list on mount when nothing is known, and shows Loading', () => {
    render(<SessionArchiveSettingsSection />)
    expect(state.requestArchivedSessions).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('session-archive-loading')).toBeTruthy()
  })

  it('asks once the connection lands when Settings opened before it, and again after a reset', () => {
    state.connectionPhase = 'connecting'
    const { rerender } = render(<SessionArchiveSettingsSection />)
    expect(state.requestArchivedSessions).not.toHaveBeenCalled()
    state.connectionPhase = 'connected'
    rerender(<SessionArchiveSettingsSection />)
    expect(state.requestArchivedSessions).toHaveBeenCalledTimes(1)
    state.archivedSessions = snap()
    rerender(<SessionArchiveSettingsSection />)
    state.archivedSessions = null
    rerender(<SessionArchiveSettingsSection />)
    expect(state.requestArchivedSessions).toHaveBeenCalledTimes(2)
  })

  it('does NOT re-ask when a snapshot is already there', () => {
    state.archivedSessions = snap()
    render(<SessionArchiveSettingsSection />)
    expect(state.requestArchivedSessions).not.toHaveBeenCalled()
  })

  it('renders the current policy values from the snapshot, Save disabled while unchanged', () => {
    state.archivedSessions = snap()
    render(<SessionArchiveSettingsSection />)
    expect(input('session-archive-enabled').checked).toBe(true)
    expect(input('session-archive-max-entries').value).toBe('200')
    expect(input('session-archive-max-age').value).toBe('30')
    expect(input('session-archive-max-size').value).toBe('256')
    expect(save().disabled).toBe(true)
    expect(screen.queryByTestId('session-archive-purge')).toBeNull()
  })

  it('a bound client sees the refusal text and NO controls', () => {
    state.archivedSessions = snap({ refused: true, code: 'X', sessions: [] })
    render(<SessionArchiveSettingsSection />)
    expect(screen.getByTestId('session-archive-refused').textContent).toBe(ARCHIVE_REFUSED_TEXT)
    expect(screen.queryByTestId('session-archive-save')).toBeNull()
    expect(screen.queryByTestId('session-archive-max-entries')).toBeNull()
  })

  it('inline validation matches the daemon: each bad value shows an error and disables Save', () => {
    state.archivedSessions = snap()
    render(<SessionArchiveSettingsSection />)
    for (const [id, bad] of [
      ['session-archive-max-entries', '0'], ['session-archive-max-entries', '1.5'], ['session-archive-max-entries', '1001'],
      ['session-archive-max-entries', ''], ['session-archive-max-age', '0'], ['session-archive-max-age', '-1'],
      ['session-archive-max-size', '0'], ['session-archive-max-size', ''],
    ] as const) {
      type(id, bad)
      expect(screen.getByTestId(`${id}-error`), `${id}=${bad}`).toBeTruthy()
      expect(save().disabled, `${id}=${bad}`).toBe(true)
      type(id, id.endsWith('entries') ? '200' : id.endsWith('age') ? '30' : '256')
      expect(screen.queryByTestId(`${id}-error`)).toBeNull()
    }
    type('session-archive-max-entries', '1000')
    type('session-archive-max-age', '0.5')
    expect(save().disabled, 'the max and a fractional age are valid').toBe(false)
  })

  it('Save sends the whole numeric policy without purge', () => {
    state.archivedSessions = snap()
    render(<SessionArchiveSettingsSection />)
    type('session-archive-max-entries', '50')
    type('session-archive-max-age', '7')
    type('session-archive-max-size', '64')
    fireEvent.click(save())
    expect(state.setSessionArchivePolicy).toHaveBeenCalledWith(
      { enabled: true, maxEntries: 50, maxAgeDays: 7, maxMegabytes: 64 }, { purge: false },
    )
  })

  it('turning it off offers the permanent delete (with the count); Save sends purge only when checked', () => {
    state.archivedSessions = snap({}, 3)
    render(<SessionArchiveSettingsSection />)
    fireEvent.click(input('session-archive-enabled'))
    const purge = screen.getByTestId('session-archive-purge')
    expect((purge.parentElement?.textContent ?? '').includes('Also delete existing archives (3)')).toBe(true)
    expect((purge.parentElement?.textContent ?? '').includes('permanent')).toBe(true)
    expect(input('session-archive-purge').checked).toBe(false)

    fireEvent.click(save())
    expect(state.setSessionArchivePolicy).toHaveBeenLastCalledWith({ ...policy, enabled: false }, { purge: false })

    fireEvent.click(input('session-archive-purge'))
    expect(save().textContent).toBe('Save and delete archives')
    fireEvent.click(save())
    expect(state.setSessionArchivePolicy).toHaveBeenLastCalledWith({ ...policy, enabled: false }, { purge: true })
  })

  it('turning it back on hides the delete choice and forgets a ticked box', () => {
    state.archivedSessions = snap()
    render(<SessionArchiveSettingsSection />)
    fireEvent.click(input('session-archive-enabled'))
    fireEvent.click(input('session-archive-purge'))
    fireEvent.click(input('session-archive-enabled'))
    expect(screen.queryByTestId('session-archive-purge')).toBeNull()
    expect(save().disabled, 'back to the saved policy: nothing to save').toBe(true)
    fireEvent.click(input('session-archive-enabled'))
    expect(input('session-archive-purge').checked, 'the earlier tick does not come back').toBe(false)
  })

  it('shows the server error in an alert, and uses the refusal text for a refused save', () => {
    state.archivedSessions = snap()
    state.sessionArchivePolicyError = { code: 'SESSION_ARCHIVE_POLICY_PERSIST_FAILED', message: 'Could not save: disk full' }
    const { rerender } = render(<SessionArchiveSettingsSection />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('Could not save: disk full')
    state.sessionArchivePolicyError = { refused: true, code: 'SESSION_ARCHIVE_POLICY_FORBIDDEN_BOUND_CLIENT', message: 'raw' }
    rerender(<SessionArchiveSettingsSection />)
    expect(screen.getByRole('alert').textContent).toBe(ARCHIVE_REFUSED_TEXT)
  })

  it('disables Save while saving (label "Saving…") and while disconnected', () => {
    state.archivedSessions = snap()
    state.sessionArchivePolicySaving = true
    const { rerender } = render(<SessionArchiveSettingsSection />)
    type('session-archive-max-entries', '50')
    expect(save().disabled).toBe(true)
    expect(save().textContent).toBe('Saving…')
    state.sessionArchivePolicySaving = false
    state.connectionPhase = 'disconnected'
    rerender(<SessionArchiveSettingsSection />)
    expect(save().disabled).toBe(true)
  })

  it('restarts the form from the daemon policy after it changes (a saved value becomes the baseline)', () => {
    state.archivedSessions = snap()
    const { rerender } = render(<SessionArchiveSettingsSection />)
    type('session-archive-max-entries', '50')
    state.archivedSessions = snap({ policy: { ...policy, maxEntries: 50 } })
    rerender(<SessionArchiveSettingsSection />)
    expect(input('session-archive-max-entries').value).toBe('50')
    expect(save().disabled).toBe(true)
  })

  it('a pure validator: mirrors the daemon bounds', () => {
    const ok = { enabled: true, maxEntries: '1000', maxAgeDays: '0.5', maxMegabytes: '1' }
    expect(validateArchivePolicyDraft(ok)).toEqual({})
    expect(Object.keys(validateArchivePolicyDraft({ ...ok, maxEntries: '1001', maxAgeDays: 'abc', maxMegabytes: '0' })).sort())
      .toEqual(['maxAgeDays', 'maxEntries', 'maxMegabytes'])
  })
})
