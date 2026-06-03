/**
 * SessionBar tab-order persistence tests (#4831)
 *
 * The persisted order must:
 *   - Round-trip through localStorage (survive `window.location.reload()`)
 *   - Be server-scoped so different chroxy servers have independent tab orders
 *   - Reject malformed payloads gracefully (no throws, return [])
 *   - Drop the localStorage entry when persisted as the empty array (so a
 *     "reset" state is genuinely empty, not a literal "[]" string we'd then
 *     read back as a no-op overlay)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  persistSessionTabOrder,
  loadPersistedSessionTabOrder,
  setServerScope,
  _resetForTesting,
} from './persistence'

beforeEach(() => {
  localStorage.clear()
  _resetForTesting()
  setServerScope(null)
})

describe('SessionBar tab-order persistence (#4831)', () => {
  it('round-trips a custom order through localStorage', () => {
    persistSessionTabOrder(['s3', 's1', 's2'])
    // Simulating a `window.location.reload()` is equivalent to calling
    // the loader fresh — module state is irrelevant for plain localStorage
    // helpers (no debounce, no in-memory cache).
    expect(loadPersistedSessionTabOrder()).toEqual(['s3', 's1', 's2'])
  })

  it('returns [] when no order has been persisted', () => {
    expect(loadPersistedSessionTabOrder()).toEqual([])
  })

  it('isolates tab order by server scope', () => {
    setServerScope('srv_A')
    persistSessionTabOrder(['a1', 'a2'])

    setServerScope('srv_B')
    persistSessionTabOrder(['b1', 'b2', 'b3'])

    setServerScope('srv_A')
    expect(loadPersistedSessionTabOrder()).toEqual(['a1', 'a2'])
    setServerScope('srv_B')
    expect(loadPersistedSessionTabOrder()).toEqual(['b1', 'b2', 'b3'])
  })

  it('removes the persisted entry when saving an empty order', () => {
    persistSessionTabOrder(['s1', 's2'])
    expect(loadPersistedSessionTabOrder()).toEqual(['s1', 's2'])
    persistSessionTabOrder([])
    // A "reset" state should not leave behind a literal `"[]"` blob — the
    // loader treating an empty stored value as null is the contract here,
    // so removing the key matters.
    expect(loadPersistedSessionTabOrder()).toEqual([])
  })

  it('returns [] when the stored value is invalid JSON', () => {
    localStorage.setItem('chroxy_persist_session_tab_order', '{not json')
    expect(loadPersistedSessionTabOrder()).toEqual([])
  })

  it('returns [] when the stored value is JSON but not an array', () => {
    localStorage.setItem('chroxy_persist_session_tab_order', '{"x":1}')
    expect(loadPersistedSessionTabOrder()).toEqual([])
  })

  it('filters non-string entries from a malformed array', () => {
    localStorage.setItem(
      'chroxy_persist_session_tab_order',
      JSON.stringify(['ok1', 42, null, 'ok2']),
    )
    expect(loadPersistedSessionTabOrder()).toEqual(['ok1', 'ok2'])
  })
})
