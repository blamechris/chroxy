/**
 * #8302 — sending input starts a turn, so the session reads "Working" at once.
 *
 * A session held busy only by a background shell carries `busyReason:
 * 'background-shells'`, which the activity chip renders as "Waiting on N
 * background shells". When the user then sends a message the model starts working;
 * left alone that label would stay until the server's next `session_list`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const lsStore: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: vi.fn((k: string) => lsStore[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { lsStore[k] = v }),
    removeItem: vi.fn((k: string) => { delete lsStore[k] }),
    clear: vi.fn(() => { for (const k of Object.keys(lsStore)) delete lsStore[k] }),
    get length() { return Object.keys(lsStore).length },
    key: vi.fn((i: number) => Object.keys(lsStore)[i] ?? null),
  },
  writable: true,
})
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

const { useConnectionStore } = await import('./connection')
const { createEmptySessionState } = await import('./utils')

const seed = (extra: Record<string, unknown>) => {
  useConnectionStore.setState({
    activeSessionId: 's1',
    sessionStates: { s1: { ...createEmptySessionState(), ...extra } },
  } as never)
}
const ss = () => (useConnectionStore.getState().sessionStates.s1 as unknown as Record<string, unknown>)

describe('sending input resets a shell-held busyReason (#8302)', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('background-shells becomes turn when a message is sent', () => {
    seed({ busyReason: 'background-shells', backgroundShellCount: 2 })
    useConnectionStore.getState().addUserMessage('carry on', undefined, undefined)
    expect(ss().busyReason).toBe('turn')
  })

  it('a positive null (idle snapshot) becomes turn too', () => {
    seed({ busyReason: null })
    useConnectionStore.getState().addUserMessage('carry on', undefined, undefined)
    expect(ss().busyReason).toBe('turn')
  })

  it('an unknown reason (an older server) is left unknown, not invented', () => {
    seed({})
    useConnectionStore.getState().addUserMessage('carry on', undefined, undefined)
    expect(ss().busyReason).toBeUndefined()
  })

  it('a send marked queued while the model only holds a shell is dispatched by the server, so it also reads turn', () => {
    // The dashboard marks a send "queued" whenever the session reads busy, and an
    // idle model held busy by a shell reads busy. The server has nothing to queue
    // behind and starts the turn.
    seed({ busyReason: 'background-shells', backgroundShellCount: 1 })
    useConnectionStore.getState().addUserMessage('later', undefined, { queued: true } as never)
    expect(ss().busyReason).toBe('turn')
  })

  it('a genuinely queued send behind a running turn leaves the reason alone', () => {
    seed({ busyReason: 'turn' })
    useConnectionStore.getState().addUserMessage('later', undefined, { queued: true } as never)
    expect(ss().busyReason).toBe('turn')
  })

  it('a queued send with an unknown reason leaves it unknown', () => {
    seed({})
    useConnectionStore.getState().addUserMessage('later', undefined, { queued: true } as never)
    expect(ss().busyReason).toBeUndefined()
  })
})
