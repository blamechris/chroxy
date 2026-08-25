/**
 * useTurnCompleteNotification tests (#7347).
 *
 * ## What "prove it red" means for this suite
 *
 * On main the hook does not exist, so the headline case is red by absence —
 * which proves nothing about the GUARDS, and the guards are where this feature
 * either works or becomes noise nobody keeps switched on. Every negative
 * assertion below is therefore paired with a positive control that fires under
 * the same harness, one field apart, so a fixture that silently failed to take
 * effect cannot pass as a suppression. Each guard was additionally verified by
 * deleting it from the hook and confirming the matching test goes red:
 *
 *   - `if (document.hasFocus()) return`   → does not notify while the window is focused
 *   - `if (!enabled) return`              → does not notify while muted
 *   - `if (session.awaitingPermission)`   → does not double-notify a session that stopped on a permission prompt
 *   - `if (!connected) { clear; return }` → does not notify across a reconnect that re-seeds the session as idle
 *   - `observedBusy &&` (edge → state)    → does not notify for a session that was never busy
 *   - the stale-session prune             → forgets a session that disappears mid-turn
 *   - `clickRef` (captured closure)       → uses the latest click handler
 *
 * The harness asserted each replacement actually landed (one match, bytes
 * changed) before trusting a red, and that the NAMED test was among the
 * failures rather than just "something failed".
 *
 * ## Harness notes
 *
 * `document.hasFocus` is stubbed per-case and restored in an explicit
 * `afterEach`. `cleanup()` runs there too: this package registers no RTL
 * auto-cleanup (`globals: false`, and `src/test-setup.ts` never calls it), so
 * a hook left mounted stays mounted into the next file.
 *
 * Nothing here is async. The hook's whole effect body runs synchronously
 * inside `render`/`rerender`, so there is no settle to wait for and no
 * `waitFor` that could pass before the thing it guards had a chance to happen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { renderHook, cleanup } from '@testing-library/react'
import {
  useTurnCompleteNotification,
  type TurnCompleteSession,
  type UseTurnCompleteNotificationOptions,
} from './useTurnCompleteNotification'
import { sendNativeNotification } from '../utils/native-notifications'

vi.mock('../utils/native-notifications', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/native-notifications')>()
  return { ...actual, sendNativeNotification: vi.fn(() => true) }
})

const mockSend = vi.mocked(sendNativeNotification)
let originalHasFocus: typeof document.hasFocus

beforeEach(() => {
  originalHasFocus = document.hasFocus
  mockSend.mockClear()
  // Default: window NOT focused, i.e. the state in which the feature is
  // supposed to fire. Cases that test the focus gate opt in explicitly.
  document.hasFocus = () => false
})

afterEach(() => {
  document.hasFocus = originalHasFocus
  cleanup()
})

function session(overrides: Partial<TurnCompleteSession> = {}): TurnCompleteSession {
  return {
    sessionId: 's1',
    name: 'chroxy',
    busy: false,
    awaitingPermission: false,
    ...overrides,
  }
}

const DEFAULTS: UseTurnCompleteNotificationOptions = { enabled: true, connected: true }

/**
 * Mount the hook over a mutable (sessions, options) pair so a case can drive
 * the busy → idle transition the same way React does — one rerender per state
 * change, with the hook's own ref surviving between them.
 */
function mount(
  initialSessions: TurnCompleteSession[],
  initialOptions: UseTurnCompleteNotificationOptions = DEFAULTS,
) {
  return renderHook(
    ({ sessions, options }: { sessions: TurnCompleteSession[]; options: UseTurnCompleteNotificationOptions }) =>
      useTurnCompleteNotification(sessions, options),
    { initialProps: { sessions: initialSessions, options: initialOptions } },
  )
}

describe('useTurnCompleteNotification — the turn-complete edge', () => {
  it('notifies when a busy session goes idle while the window is unfocused', () => {
    const { rerender, unmount } = mount([session({ busy: true })])
    expect(mockSend).not.toHaveBeenCalled()

    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(mockSend).toHaveBeenCalledOnce()
    expect(mockSend).toHaveBeenCalledWith('Chroxy: chroxy', {
      body: 'Finished — awaiting your input.',
      tag: 'chroxy-turn-s1',
      onClick: expect.any(Function),
    })
    unmount()
  })

  it('does not notify for a session that was never busy — idle is not "awaiting you"', () => {
    // The positive control is the case above: identical harness, identical
    // final state, and it fires. The ONLY difference here is that the session
    // never passed through `busy: true`, so there is no edge to notify about.
    const { rerender, unmount } = mount([session({ busy: false })])
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('does not notify while a session is still busy', () => {
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({ sessions: [session({ busy: true, name: 'renamed' })], options: DEFAULTS })

    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('notifies once per completed turn, not once per render', () => {
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(mockSend).toHaveBeenCalledOnce()
    unmount()
  })

  it('notifies again for a second turn on the same session', () => {
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })
    rerender({ sessions: [session({ busy: true })], options: DEFAULTS })
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(mockSend).toHaveBeenCalledTimes(2)
    unmount()
  })
})

describe('useTurnCompleteNotification — gates', () => {
  it('does not notify while the window is focused', () => {
    document.hasFocus = () => true
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('consumes the edge while focused, so blurring later does not fire a stale alert', () => {
    // The bookkeeping has to run even when dispatch is suppressed. Otherwise
    // the session stays recorded as busy, and the next pass after the window
    // blurs re-detects a "completed turn" that finished while the user was
    // watching it.
    document.hasFocus = () => true
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    document.hasFocus = () => false
    rerender({ sessions: [session({ busy: false, name: 'nudge' })], options: DEFAULTS })

    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('does not notify while muted', () => {
    const muted = { ...DEFAULTS, enabled: false }
    const { rerender, unmount } = mount([session({ busy: true })], muted)
    rerender({ sessions: [session({ busy: false })], options: muted })

    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('consumes the edge while muted, so unmuting later does not fire a stale alert', () => {
    const muted = { ...DEFAULTS, enabled: false }
    const { rerender, unmount } = mount([session({ busy: true })], muted)
    rerender({ sessions: [session({ busy: false })], options: muted })
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('does not double-notify a session that stopped on a permission prompt', () => {
    // usePermissionNotification owns that moment and fires for the prompt
    // itself; two cards for one event is just duplication.
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({
      sessions: [session({ busy: false, awaitingPermission: true })],
      options: DEFAULTS,
    })

    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('notifies the same edge when no prompt is pending — control for the case above', () => {
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({
      sessions: [session({ busy: false, awaitingPermission: false })],
      options: DEFAULTS,
    })

    expect(mockSend).toHaveBeenCalledOnce()
    unmount()
  })
})

describe('useTurnCompleteNotification — connection lifecycle', () => {
  it('does not notify across a reconnect that re-seeds the session as idle', () => {
    // A dropped socket clears transient per-session state and a reconnect
    // re-seeds `isIdle` from the session_list snapshot. Neither is a completed
    // turn, and the turn may well still be running on the server.
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({ sessions: [session({ busy: true })], options: { ...DEFAULTS, connected: false } })
    // Reconnect: the snapshot says idle.
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('notifies the same busy → idle sequence when the socket never dropped — control', () => {
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({ sessions: [session({ busy: true })], options: DEFAULTS })
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(mockSend).toHaveBeenCalledOnce()
    unmount()
  })

  it('starts notifying again for turns that complete after the reconnect', () => {
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({ sessions: [session({ busy: true })], options: { ...DEFAULTS, connected: false } })
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })
    // A genuine new turn, fully observed on the live socket.
    rerender({ sessions: [session({ busy: true })], options: DEFAULTS })
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(mockSend).toHaveBeenCalledOnce()
    unmount()
  })
})

describe('useTurnCompleteNotification — multiple sessions', () => {
  it('notifies only the session that finished', () => {
    const busyPair = [
      session({ sessionId: 's1', name: 'api', busy: true }),
      session({ sessionId: 's2', name: 'web', busy: true }),
    ]
    const { rerender, unmount } = mount(busyPair)
    rerender({
      sessions: [
        session({ sessionId: 's1', name: 'api', busy: false }),
        session({ sessionId: 's2', name: 'web', busy: true }),
      ],
      options: DEFAULTS,
    })

    expect(mockSend).toHaveBeenCalledOnce()
    expect(mockSend).toHaveBeenCalledWith('Chroxy: api', expect.objectContaining({ tag: 'chroxy-turn-s1' }))
    unmount()
  })

  it('notifies a background session — the turn boundary is not the active tab', () => {
    // The whole point of #7347: `session_activity` carries every session's
    // busy/idle, so a session the user is not looking at still gets its
    // completion announced.
    const { rerender, unmount } = mount([
      session({ sessionId: 's1', name: 'api', busy: false }),
      session({ sessionId: 's2', name: 'web', busy: true }),
    ])
    rerender({
      sessions: [
        session({ sessionId: 's1', name: 'api', busy: false }),
        session({ sessionId: 's2', name: 'web', busy: false }),
      ],
      options: DEFAULTS,
    })

    expect(mockSend).toHaveBeenCalledOnce()
    expect(mockSend).toHaveBeenCalledWith('Chroxy: web', expect.objectContaining({ tag: 'chroxy-turn-s2' }))
    unmount()
  })

  it('forgets a session that disappears mid-turn, so a reused id does not inherit its edge', () => {
    const { rerender, unmount } = mount([session({ sessionId: 's1', busy: true })])
    // Server drops it while still busy (destroyed session).
    rerender({ sessions: [], options: DEFAULTS })
    // A new session lands on the same id, idle.
    rerender({ sessions: [session({ sessionId: 's1', busy: false })], options: DEFAULTS })

    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })
})

describe('useTurnCompleteNotification — under StrictMode', () => {
  // `src/main.tsx` renders the app inside <StrictMode>, which double-invokes
  // effects on mount. The hook keeps its busy set in a ref and has no cleanup
  // function, so the second invocation sees the bookkeeping the first one
  // already did. Verified rather than reasoned about: a hook that tracks an
  // edge in a ref is exactly the shape StrictMode catches out, and getting it
  // wrong is silent — either a duplicate alert or a swallowed one.
  const strict = { wrapper: StrictMode }

  function mountStrict(sessions: TurnCompleteSession[]) {
    return renderHook(
      ({ sessions: s }: { sessions: TurnCompleteSession[] }) =>
        useTurnCompleteNotification(s, DEFAULTS),
      { initialProps: { sessions }, ...strict },
    )
  }

  it('does not fire on the double-invoked mount of an already-busy session', () => {
    const { unmount } = mountStrict([session({ busy: true })])
    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('does not fire on the double-invoked mount of an already-idle session', () => {
    const { unmount } = mountStrict([session({ busy: false })])
    expect(mockSend).not.toHaveBeenCalled()
    unmount()
  })

  it('still fires exactly once for a turn that completes after mount', () => {
    const { rerender, unmount } = mountStrict([session({ busy: true })])
    rerender({ sessions: [session({ busy: false })] })

    expect(mockSend).toHaveBeenCalledOnce()
    unmount()
  })
})

describe('useTurnCompleteNotification — click-to-focus', () => {
  it('routes the click to the session that finished', () => {
    const onNotificationClick = vi.fn()
    const options = { ...DEFAULTS, onNotificationClick }
    const { rerender, unmount } = mount(
      [
        session({ sessionId: 's1', name: 'api', busy: true }),
        session({ sessionId: 's2', name: 'web', busy: true }),
      ],
      options,
    )
    rerender({
      sessions: [
        session({ sessionId: 's1', name: 'api', busy: true }),
        session({ sessionId: 's2', name: 'web', busy: false }),
      ],
      options,
    })

    expect(onNotificationClick).not.toHaveBeenCalled()
    const sent = mockSend.mock.calls[0]![1]!
    sent.onClick!()
    expect(onNotificationClick).toHaveBeenCalledWith('s2')
    unmount()
  })

  it('uses the latest click handler, not the one captured when the notification was sent', () => {
    // The handler is held in a ref precisely so a re-rendered parent callback
    // does not re-run the effect. That is only safe if the ref is what the
    // notification calls — a stale closure here would switch to a session the
    // user asked for several renders ago.
    const first = vi.fn()
    const second = vi.fn()
    const { rerender, unmount } = mount([session({ busy: true })], {
      ...DEFAULTS,
      onNotificationClick: first,
    })
    rerender({
      sessions: [session({ busy: false })],
      options: { ...DEFAULTS, onNotificationClick: first },
    })
    rerender({
      sessions: [session({ busy: false })],
      options: { ...DEFAULTS, onNotificationClick: second },
    })

    mockSend.mock.calls[0]![1]!.onClick!()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('s1')
    unmount()
  })

  it('does not throw when no click handler is wired', () => {
    const { rerender, unmount } = mount([session({ busy: true })])
    rerender({ sessions: [session({ busy: false })], options: DEFAULTS })

    expect(() => mockSend.mock.calls[0]![1]!.onClick!()).not.toThrow()
    unmount()
  })
})
