/**
 * useInterventionPing tests (#4891)
 *
 * Verifies the dashboard audio ping:
 *   - fires once when a new intervention (permission prompt / question) arrives
 *   - respects the mute toggle (`enabled: false` => silent)
 *   - dedupes by requestId (no repeat ping for the same intervention)
 *   - throttles a burst of simultaneous interventions into a single chirp
 *   - skips answered / expired prompts
 *   - re-pings a re-requested id after it's pruned
 *   - fails soft when Web Audio is unavailable (no throw)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  useInterventionPing,
  THROTTLE_MS,
  __resetInterventionPingAudioContextForTests,
} from './useInterventionPing'

// --- AudioContext mock --------------------------------------------------
// jsdom has no Web Audio API. We install a minimal mock that records every
// oscillator start() so a single chirp (two notes) is observable as "two
// oscillators started", and a fresh chirp increments the count.

let oscillatorStarts = 0
let createdContexts = 0

function makeMockAudioContext() {
  return class MockAudioContext {
    state: 'suspended' | 'running' = 'running'
    currentTime = 0
    destination = {}
    constructor() {
      createdContexts++
    }
    resume() {
      this.state = 'running'
      return Promise.resolve()
    }
    createGain() {
      return {
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      }
    }
    createOscillator() {
      return {
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: () => { oscillatorStarts++ },
        stop: vi.fn(),
      }
    }
  }
}

/** A chirp plays two notes => two oscillator starts. */
function chirpCount() {
  return oscillatorStarts / 2
}

function makePrompt(
  overrides: Partial<{
    id: string
    requestId: string
    tool: string
    description: string
    expiresAt: number
    answered: string | undefined
  }> = {},
) {
  return {
    id: 'perm-1',
    requestId: 'req-1',
    tool: 'Bash',
    description: 'Run: npm install',
    expiresAt: Date.now() + 60000,
    answered: undefined,
    ...overrides,
  }
}

beforeEach(() => {
  oscillatorStarts = 0
  createdContexts = 0
  __resetInterventionPingAudioContextForTests()
  // @ts-expect-error — install mock
  globalThis.window.AudioContext = makeMockAudioContext()
  // @ts-expect-error — ensure prefixed fallback is absent
  delete globalThis.window.webkitAudioContext
})

afterEach(() => {
  __resetInterventionPingAudioContextForTests()
  vi.restoreAllMocks()
})

describe('useInterventionPing', () => {
  it('fires a single chirp when a new intervention arrives', () => {
    renderHook(() => useInterventionPing([makePrompt()], { enabled: true }))
    expect(chirpCount()).toBe(1)
  })

  it('does not ping when muted (enabled: false)', () => {
    renderHook(() => useInterventionPing([makePrompt()], { enabled: false }))
    expect(chirpCount()).toBe(0)
    // No AudioContext should even be constructed while muted.
    expect(createdContexts).toBe(0)
  })

  it('does not ping for already-answered prompts', () => {
    renderHook(() =>
      useInterventionPing([makePrompt({ answered: 'allow' })], { enabled: true }),
    )
    expect(chirpCount()).toBe(0)
  })

  it('does not ping for expired prompts', () => {
    renderHook(() =>
      useInterventionPing([makePrompt({ expiresAt: Date.now() - 1000 })], { enabled: true }),
    )
    expect(chirpCount()).toBe(0)
  })

  it('dedupes — same requestId does not re-ping on re-render', () => {
    const { rerender } = renderHook(
      ({ p }) => useInterventionPing(p, { enabled: true }),
      { initialProps: { p: [makePrompt()] } },
    )
    expect(chirpCount()).toBe(1)
    // New array instance, same requestId — effect reruns but must not re-ping.
    rerender({ p: [makePrompt()] })
    expect(chirpCount()).toBe(1)
  })

  it('throttles a burst of simultaneous interventions into one chirp', () => {
    renderHook(() =>
      useInterventionPing(
        [
          makePrompt({ id: 'a', requestId: 'req-a' }),
          makePrompt({ id: 'b', requestId: 'req-b' }),
          makePrompt({ id: 'c', requestId: 'req-c' }),
        ],
        { enabled: true },
      ),
    )
    // Three new interventions in one tick collapse to a single chirp.
    expect(chirpCount()).toBe(1)
  })

  it('does not re-ping a throttled id once the cooldown lifts', () => {
    vi.useFakeTimers()
    const base = Date.now()
    vi.setSystemTime(base)
    const { rerender } = renderHook(
      ({ p }) => useInterventionPing(p, { enabled: true }),
      {
        initialProps: {
          p: [
            makePrompt({ id: 'a', requestId: 'req-a', expiresAt: base + 60000 }),
            makePrompt({ id: 'b', requestId: 'req-b', expiresAt: base + 60000 }),
          ],
        },
      },
    )
    expect(chirpCount()).toBe(1)
    // Advance past the throttle window; the same ids are still present but
    // were already recorded as pinged, so no new chirp fires.
    vi.setSystemTime(base + 5000)
    rerender({
      p: [
        makePrompt({ id: 'a', requestId: 'req-a', expiresAt: base + 60000 }),
        makePrompt({ id: 'b', requestId: 'req-b', expiresAt: base + 60000 }),
      ],
    })
    expect(chirpCount()).toBe(1)
    vi.useRealTimers()
  })

  it('re-pings a re-requested id after it is pruned (past the throttle window)', () => {
    vi.useFakeTimers()
    const base = Date.now()
    vi.setSystemTime(base)
    const { rerender } = renderHook(
      ({ p }) => useInterventionPing(p, { enabled: true }),
      { initialProps: { p: [makePrompt({ requestId: 'req-1', expiresAt: base + 60000 })] } },
    )
    expect(chirpCount()).toBe(1)
    // Intervention answered/removed — id pruned.
    rerender({ p: [] })
    // Advance past the throttle cooldown so the re-request is audible
    // (a re-request inside the cooldown is intentionally throttled).
    vi.setSystemTime(base + THROTTLE_MS + 1)
    // Same requestId reappears (re-requested) — should ping again.
    rerender({ p: [makePrompt({ requestId: 'req-1', expiresAt: base + 60000 + THROTTLE_MS })] })
    expect(chirpCount()).toBe(2)
    vi.useRealTimers()
  })

  it('still prunes stale ids while muted so unmuting does not replay old ids', () => {
    const { rerender } = renderHook(
      ({ p, enabled }) => useInterventionPing(p, { enabled }),
      { initialProps: { p: [makePrompt({ requestId: 'req-1' })], enabled: false } },
    )
    expect(chirpCount()).toBe(0)
    // While still muted the prompt is answered/removed (id pruned).
    rerender({ p: [], enabled: false })
    // Unmute with a brand-new intervention — should ping (proves the set
    // didn't leak a stale id that would suppress later, and that unmuting
    // does not replay the already-gone req-1).
    rerender({ p: [makePrompt({ requestId: 'req-2' })], enabled: true })
    expect(chirpCount()).toBe(1)
  })

  it('fails soft when Web Audio is unavailable (no throw, no chirp)', () => {
    // @ts-expect-error — remove the constructor
    delete globalThis.window.AudioContext
    expect(() =>
      renderHook(() => useInterventionPing([makePrompt()], { enabled: true })),
    ).not.toThrow()
    expect(chirpCount()).toBe(0)
  })
})
