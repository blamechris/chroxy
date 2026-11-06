/**
 * #7801 — one implementation of "live cumulativeUsage overlays the
 * session_list snapshot". Runs against the REAL store: mocked stores skip
 * useSyncExternalStore, which is where the unstable-selector loop lives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHook, act, cleanup } from '@testing-library/react'
import type { CumulativeUsage, SessionInfo } from '@chroxy/store-core'
import { useConnectionStore } from './connection'
import { createEmptySessionState } from './utils'
import {
  useLiveCumulativeUsage,
  overlayLiveUsage,
  resolveSessionUsage,
} from './live-usage'

const usage = (costUsd: number): CumulativeUsage => ({
  inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd, turnsBilled: 1,
})
const info = (sessionId: string, cumulativeUsage?: CumulativeUsage | null): SessionInfo =>
  ({ sessionId, name: sessionId, cwd: '/x', type: 'cli', hasTerminal: false, model: null, permissionMode: null, isBusy: false, createdAt: 0, conversationId: null, cumulativeUsage }) as SessionInfo

describe('live-usage (#7801)', () => {
  beforeEach(() => { useConnectionStore.setState({ sessionStates: {} }) })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('mounts against the real store with empty sessionStates (no render loop)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useLiveCumulativeUsage())
    expect(result.current).toEqual({})
    expect(err.mock.calls.length).toBe(0)
  })

  it('keeps the same reference when an unrelated field changes, and updates when a usage value changes', () => {
    const a = { ...createEmptySessionState(), cumulativeUsage: usage(1) }
    useConnectionStore.setState({ sessionStates: { s1: a } })
    const { result } = renderHook(() => useLiveCumulativeUsage())
    const first = result.current
    expect(first.s1).toBe(a.cumulativeUsage)
    act(() => {
      useConnectionStore.setState({ sessionStates: { s1: { ...a, messages: [] } } })
    })
    expect(result.current).toBe(first)
    const next = usage(2)
    act(() => {
      useConnectionStore.setState({ sessionStates: { s1: { ...a, cumulativeUsage: next } } })
    })
    expect(result.current.s1).toBe(next)
  })

  it('live wins, null/undefined falls back to snapshot, absent is null', () => {
    const snap = usage(1)
    const live = usage(5)
    expect(resolveSessionUsage({ s1: live }, info('s1', snap))).toBe(live)
    expect(resolveSessionUsage({ s1: null }, info('s1', snap))).toBe(snap)
    expect(resolveSessionUsage({}, info('s1', snap))).toBe(snap)
    expect(resolveSessionUsage({}, info('s1'))).toBeNull()
  })

  it('overlay agrees with resolveSessionUsage for every session', () => {
    const sessions = [info('s1', usage(1)), info('s2', usage(2)), info('s3')]
    const liveMap = { s1: usage(9), s2: null, other: usage(3) }
    const out = overlayLiveUsage(sessions, liveMap)
    out.forEach((s, i) => {
      expect(s.cumulativeUsage ?? null).toBe(resolveSessionUsage(liveMap, sessions[i]!))
    })
    expect(out[1]).toBe(sessions[1])
  })

  describe('consumers share the one implementation', () => {
    const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
    for (const file of ['../App.tsx', '../components/Sidebar.tsx']) {
      it(`${file} uses useLiveCumulativeUsage and has no private projection`, () => {
        const text = src(file)
        expect(/useLiveCumulativeUsage\(\)/.test(text), 'must call the shared hook').toBe(true)
        expect(/\]!?\.cumulativeUsage\b/.test(text), 'must not re-project cumulativeUsage from sessionStates').toBe(false)
      })
    }
    it('App resolves per-session usage through resolveSessionUsage', () => {
      expect(/resolveSessionUsage\(/.test(src('../App.tsx'))).toBe(true)
    })
  })
})
