/**
 * Per-device notification preferences (#7347, #7351).
 *
 * Two things are covered here, and the second is the interesting one:
 *
 * 1. The turn-complete mute toggle defaults ON, mutes only on an explicit
 *    `'false'`, and survives the storage being unavailable.
 * 2. Both notification keys survive an **unscoped** `clearPersistedState()` —
 *    the server-switch path. `KEY_NOTIFICATION_PERMISSION_ASKED` shipped in
 *    #7351 without being added to `isGlobalKey`, so switching servers deleted
 *    the "we already asked" flag and re-armed the automatic OS-permission
 *    prompt for someone who had dismissed one. That is the exact re-prompt
 *    loop the flag exists to stop; it was simply hidden behind an action
 *    nobody performs in a unit test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setServerScope,
  clearPersistedState,
  persistActiveSession,
  persistTurnCompleteNotification,
  loadPersistedTurnCompleteNotification,
  persistNotificationPermissionAsked,
  loadNotificationPermissionAsked,
  persistInterventionPing,
  loadPersistedInterventionPing,
  _resetForTesting,
} from './persistence'

beforeEach(() => {
  localStorage.clear()
  _resetForTesting()
  setServerScope(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('turn-complete notification preference (#7347)', () => {
  it('defaults to ON when nothing is stored', () => {
    expect(loadPersistedTurnCompleteNotification()).toBe(true)
  })

  it('round-trips an explicit mute and un-mute', () => {
    persistTurnCompleteNotification(false)
    expect(loadPersistedTurnCompleteNotification()).toBe(false)

    persistTurnCompleteNotification(true)
    expect(loadPersistedTurnCompleteNotification()).toBe(true)
  })

  it('treats any non-"false" stored value as ON', () => {
    localStorage.setItem('chroxy_persist_turn_complete_notification', 'garbage')
    expect(loadPersistedTurnCompleteNotification()).toBe(true)
  })

  it('falls back to ON when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(loadPersistedTurnCompleteNotification()).toBe(true)
  })

  it('does not throw when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => persistTurnCompleteNotification(false)).not.toThrow()
  })

  it('is independent of the intervention-ping mute', () => {
    // The two alerts fire on different events and must be mutable separately —
    // muting "the session finished" cannot silence "the session needs you".
    persistTurnCompleteNotification(false)
    expect(loadPersistedInterventionPing()).toBe(true)

    persistInterventionPing(false)
    persistTurnCompleteNotification(true)
    expect(loadPersistedInterventionPing()).toBe(false)
    expect(loadPersistedTurnCompleteNotification()).toBe(true)
  })
})

describe('notification prefs survive an unscoped clear (server switch)', () => {
  it('keeps the turn-complete mute', () => {
    persistTurnCompleteNotification(false)
    persistActiveSession('session-1')

    clearPersistedState()

    // Control: genuinely server-scoped state IS cleared, so this test is not
    // passing because clearPersistedState quietly did nothing.
    expect(localStorage.getItem('chroxy_persist_active_session_id')).toBeNull()
    expect(loadPersistedTurnCompleteNotification()).toBe(false)
  })

  it('keeps the "already asked for OS permission" flag (#7351 regression)', () => {
    persistNotificationPermissionAsked()
    persistActiveSession('session-1')
    expect(loadNotificationPermissionAsked()).toBe(true)

    clearPersistedState()

    expect(localStorage.getItem('chroxy_persist_active_session_id')).toBeNull()
    // Before this was added to isGlobalKey the flag was wiped here, and the
    // next page load re-prompted a user who had already said "not now".
    expect(loadNotificationPermissionAsked()).toBe(true)
  })
})
