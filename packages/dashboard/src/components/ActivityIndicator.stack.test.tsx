/**
 * ActivityIndicator + CheckInChip stacked-layout snapshot (#3912).
 *
 * App.tsx:1703-1711 mounts these two chips as consecutive siblings
 * immediately above the InputBar. Both are inline-flex chips that are
 * expected to stack vertically — there is no dedicated wrapper div, so
 * the "stack" is load-bearing on:
 *   1. DOM order (ActivityIndicator BEFORE CheckInChip)
 *   2. Each chip being a separate block-in-flow boundary (block-level
 *      sibling node, not a fragment that would let them flow inline)
 *   3. The `inline-flex` + `align-self: flex-start` chip CSS, which
 *      keeps each chip a fixed-shape pill that does not collapse into
 *      its neighbour even on narrow viewports
 *
 * This file locks in those three guarantees so a future CSS or markup
 * refactor (margin collapse, flex-wrap change, swapping the order, or
 * removing align-self) is caught.
 *
 * Mocks the connection store the same way CheckInChip.test.tsx does —
 * both chips read from `useConnectionStore` so a single shared mock
 * drives both renderers consistently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { ActivityIndicator } from './ActivityIndicator'
import { CheckInChip } from './CheckInChip'

const sendInputMock = vi.fn()
let storeState: Record<string, unknown> = {}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: any) => {
    const sessionStates: Record<string, any> = (storeState.sessionStates as any) ?? {}
    const store = {
      activeSessionId: storeState.activeSessionId ?? 'sess-1',
      sessionStates,
      sendInput: sendInputMock,
      connectionPhase: storeState.connectionPhase ?? 'connected',
      serverResultTimeoutMs: storeState.serverResultTimeoutMs ?? 30 * 60 * 1000,
    }
    return selector(store)
  },
}))

const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf-8')

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  storeState = {
    activeSessionId: 'sess-1',
    connectionPhase: 'connected',
    serverResultTimeoutMs: 30 * 60 * 1000,
    sessionStates: {
      'sess-1': {
        isIdle: false,
        lastClientActivityAt: Date.now() - 5_000, // 5s ago → green
        inactivityWarning: null,
      },
    },
  }
})

/**
 * Mimic App.tsx's mount order: ActivityIndicator then CheckInChip,
 * both as direct siblings under a single parent (no wrapper div).
 * The wrapper here exists only so testing-library has a container to
 * return; it does not add layout the App relies on.
 */
function StackedChips() {
  return (
    <>
      <ActivityIndicator />
      <CheckInChip />
    </>
  )
}

describe('ActivityIndicator + CheckInChip stacked layout (#3912)', () => {
  describe('CSS contract — both chips are independent inline-flex pills', () => {
    it('.activity-indicator is inline-flex (does not collapse with neighbours)', () => {
      const block = css.match(/\n\.activity-indicator\s*\{[^}]*\}/s)
      expect(block).toBeTruthy()
      expect(block![0]).toMatch(/display:\s*inline-flex/)
    })

    it('.check-in-chip is inline-flex with align-self: flex-start (chip never stretches across the row)', () => {
      const block = css.match(/\n\.check-in-chip\s*\{[^}]*\}/s)
      expect(block).toBeTruthy()
      expect(block![0]).toMatch(/display:\s*inline-flex/)
      // align-self: flex-start is what prevents the second chip from
      // growing to fill the row when its parent is a flex column — the
      // review comment that prompted #3912 called this out explicitly.
      expect(block![0]).toMatch(/align-self:\s*flex-start/)
    })

    it('.check-in-chip has top/bottom margin so it does not visually butt against the activity indicator', () => {
      const block = css.match(/\n\.check-in-chip\s*\{[^}]*\}/s)
      expect(block).toBeTruthy()
      // `margin: 4px 0` separates the two stacked chips. Locking this
      // catches a future "margin: 0" regression that would let the two
      // amber pills look like one merged chip.
      expect(block![0]).toMatch(/margin:\s*4px\s+0/)
    })
  })

  describe('DOM structure — order and separation are deterministic', () => {
    it('renders ActivityIndicator BEFORE CheckInChip when both are visible', () => {
      ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
        idleMs: 1_800_000,
        prefab: 'Status update?',
        receivedAt: Date.now(),
      }

      const { container } = render(<StackedChips />)
      const activity = container.querySelector('.activity-indicator')
      const checkIn = container.querySelector('.check-in-chip')
      expect(activity).not.toBeNull()
      expect(checkIn).not.toBeNull()

      // compareDocumentPosition returns a bitmask; bit 4 (= 0x04 =
      // DOCUMENT_POSITION_FOLLOWING) means `checkIn` follows `activity`.
      const relation = activity!.compareDocumentPosition(checkIn!)
      expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('the two chips are SEPARATE sibling nodes (not nested, not merged)', () => {
      ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
        idleMs: 1_800_000,
        prefab: 'Status update?',
        receivedAt: Date.now(),
      }

      const { container } = render(<StackedChips />)
      const activity = container.querySelector('.activity-indicator')!
      const checkIn = container.querySelector('.check-in-chip')!
      // Same parent → true siblings. If a future refactor wraps either
      // in an extra div, this assertion fails loudly.
      expect(activity.parentElement).toBe(checkIn.parentElement)
      expect(activity.contains(checkIn)).toBe(false)
      expect(checkIn.contains(activity)).toBe(false)
    })

    it('snapshot — stacked layout with default-state (green) indicator + active warning', () => {
      ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
        idleMs: 1_800_000,
        prefab: 'Status update?',
        receivedAt: 1_700_000_000_000, // fixed epoch so the snapshot is stable
      }

      // Pin lastClientActivityAt so the indicator's class is deterministic.
      ;(storeState.sessionStates as any)['sess-1'].lastClientActivityAt = Date.now() - 5_000

      const { container } = render(<StackedChips />)
      // Strip the elapsed-time text nodes that tick per second so the
      // snapshot is robust across runs. Class names, aria attrs, button
      // labels, and overall structure are what the snapshot is locking.
      const stripDynamicText = (html: string) =>
        html
          .replace(/last activity [^<]+/g, 'last activity TIME')
          .replace(/Agent quiet for [^<]+/g, 'Agent quiet for TIME')

      expect(stripDynamicText(container.innerHTML)).toMatchInlineSnapshot(
        `"<div class="activity-indicator activity-indicator--green" aria-label="Agent is working"><span class="activity-indicator__dot" aria-hidden="true"></span><span class="activity-indicator__label">Working… last activity TIME</span></div><div class="check-in-chip"><span class="check-in-chip__sr" role="status" aria-live="polite">Agent has gone quiet. Status update?</span><span class="check-in-chip__dot" aria-hidden="true"></span><span class="check-in-chip__label" aria-hidden="true">Agent quiet for TIME</span><button type="button" class="check-in-chip__action" aria-label="Send check-in: Status update?">Status update?</button></div>"`,
      )
    })
  })

  describe('Combined state — warning fires while indicator is in red/orange', () => {
    it('renders BOTH chips when the indicator is orange (>60s of silence) AND a warning has fired', () => {
      const referenceTimeoutMs = 30 * 60 * 1000
      // 5 minutes since last activity → orange (≥60s, well under threshold-60s)
      ;(storeState.sessionStates as any)['sess-1'].lastClientActivityAt = Date.now() - 5 * 60 * 1000
      ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
        idleMs: 5 * 60 * 1000,
        prefab: 'Status update?',
        receivedAt: Date.now(),
      }
      storeState.serverResultTimeoutMs = referenceTimeoutMs

      const { container } = render(<StackedChips />)
      const activity = container.querySelector('.activity-indicator')
      const checkIn = container.querySelector('.check-in-chip')
      expect(activity).not.toBeNull()
      expect(checkIn).not.toBeNull()
      expect(activity!.className).toContain('activity-indicator--orange')
      // Both chips coexist — the warning does not hide the indicator and
      // vice versa. This is the explicit acceptance-criterion case from
      // the issue ("warning fires while activity-indicator is showing
      // red/orange").
    })

    it('renders BOTH chips when the indicator is red (final-minute warning) AND a check-in is outstanding', () => {
      const referenceTimeoutMs = 30 * 60 * 1000
      // 29m30s since last activity → red (within threshold - 60s window)
      ;(storeState.sessionStates as any)['sess-1'].lastClientActivityAt =
        Date.now() - (referenceTimeoutMs - 30_000)
      ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
        idleMs: referenceTimeoutMs - 30_000,
        prefab: 'Status update?',
        receivedAt: Date.now(),
      }
      storeState.serverResultTimeoutMs = referenceTimeoutMs

      const { container } = render(<StackedChips />)
      const activity = container.querySelector('.activity-indicator')!
      const checkIn = container.querySelector('.check-in-chip')!
      expect(activity.className).toContain('activity-indicator--red')
      // Order is still ActivityIndicator → CheckInChip even in this
      // combined-stress state.
      const relation = activity.compareDocumentPosition(checkIn)
      expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  describe('Single-chip cases — the other slot collapses cleanly', () => {
    it('only ActivityIndicator renders when there is no inactivity warning', () => {
      // Default beforeEach: busy session, no warning.
      const { container } = render(<StackedChips />)
      expect(container.querySelector('.activity-indicator')).not.toBeNull()
      expect(container.querySelector('.check-in-chip')).toBeNull()
    })

    it('only CheckInChip renders when the session is idle but a warning is outstanding', () => {
      ;(storeState.sessionStates as any)['sess-1'].isIdle = true
      ;(storeState.sessionStates as any)['sess-1'].inactivityWarning = {
        idleMs: 1_800_000,
        prefab: 'Status update?',
        receivedAt: Date.now(),
      }
      const { container } = render(<StackedChips />)
      expect(container.querySelector('.activity-indicator')).toBeNull()
      expect(container.querySelector('.check-in-chip')).not.toBeNull()
    })

    it('renders nothing when the session is idle AND there is no warning', () => {
      ;(storeState.sessionStates as any)['sess-1'].isIdle = true
      const { container } = render(<StackedChips />)
      expect(container.querySelector('.activity-indicator')).toBeNull()
      expect(container.querySelector('.check-in-chip')).toBeNull()
    })
  })
})
