/**
 * #5557 — Control Room tab registry derivation.
 *
 * Adding a Control Room tab used to cost ~7 coordinated edits with nothing tying
 * them together, so a `VALID_TABS`/`TABS` drift could ship a tab you could
 * deep-link to but not render. The view now DERIVES the valid-tab set, the
 * survey-tab set, and the rendered strip from one `CONTROL_ROOM_TABS` descriptor
 * array. This suite is the drift guard: it asserts the derived sets stay
 * consistent with the descriptors, so the class of bug the refactor kills can't
 * silently reappear.
 *
 * (The strip's actual render — labels, default tab, persistence, auto-fetch — is
 * covered by ControlRoomView.test.tsx; this file asserts only the derivation
 * invariants that hold without a DOM.)
 */
import { describe, it, expect } from 'vitest'
import { CONTROL_ROOM_TABS, SURVEY_TABS } from './ControlRoomView'

describe('#5557 — Control Room tab registry derivation', () => {
  it('has at least one tab and every descriptor carries a key + label', () => {
    expect(CONTROL_ROOM_TABS.length).toBeGreaterThan(0)
    for (const t of CONTROL_ROOM_TABS) {
      expect(typeof t.key).toBe('string')
      expect(t.key.length).toBeGreaterThan(0)
      expect(typeof t.label).toBe('string')
      expect(t.label.length).toBeGreaterThan(0)
    }
  })

  it('has unique tab keys (no duplicate descriptor would shadow the strip / deep-link set)', () => {
    const keys = CONTROL_ROOM_TABS.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('derives SURVEY_TABS to be exactly the survey:true descriptor keys', () => {
    const expected = new Set(CONTROL_ROOM_TABS.filter((t) => t.survey).map((t) => t.key))
    expect(SURVEY_TABS).toEqual(expected)
  })

  it('keeps SURVEY_TABS a subset of the full tab set (no orphan survey tab)', () => {
    const allKeys = new Set<string>(CONTROL_ROOM_TABS.map((t) => t.key))
    for (const key of SURVEY_TABS) {
      expect(allKeys.has(key)).toBe(true)
    }
  })

  it('gives every survey:true descriptor the store-key triple + a wire request type', () => {
    for (const t of CONTROL_ROOM_TABS) {
      if (!t.survey) continue
      // The discriminated descriptor narrows to the surveyed shape here.
      expect(typeof t.requestType).toBe('string')
      expect(t.requestType.length).toBeGreaterThan(0)
      expect(typeof t.snapshotKey).toBe('string')
      expect(typeof t.loadingKey).toBe('string')
      expect(typeof t.requestKey).toBe('string')
    }
  })

  it('keeps the Settings tab (survey:false) out of the auto-fetch set', () => {
    // The static tab must never appear in SURVEY_TABS or it would fetch on
    // activation (#5544 regression guard).
    const staticTabs = CONTROL_ROOM_TABS.filter((t) => !t.survey).map((t) => t.key)
    expect(staticTabs).toContain('settings')
    for (const key of staticTabs) {
      expect(SURVEY_TABS.has(key as never)).toBe(false)
    }
  })

  it('maps each surveyed tab to a distinct store snapshot/loading/request triple', () => {
    const snapshotKeys = new Set<string>()
    const loadingKeys = new Set<string>()
    const requestKeys = new Set<string>()
    for (const t of CONTROL_ROOM_TABS) {
      if (!t.survey) continue
      snapshotKeys.add(t.snapshotKey)
      loadingKeys.add(t.loadingKey)
      requestKeys.add(t.requestKey)
    }
    const surveyCount = CONTROL_ROOM_TABS.filter((t) => t.survey).length
    expect(snapshotKeys.size).toBe(surveyCount)
    expect(loadingKeys.size).toBe(surveyCount)
    expect(requestKeys.size).toBe(surveyCount)
  })
})
