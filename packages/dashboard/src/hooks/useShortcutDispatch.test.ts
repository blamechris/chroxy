/**
 * Tests for the global keyboard-shortcut dispatch hook (#4770).
 *
 * Boundary contract:
 *   - The hook keeps at most one `keydown` listener on window while
 *     mounted. The underlying effect cycles the listener (remove + re-add)
 *     whenever its captured props change (sessions, activeSessionId,
 *     viewMode, setters) — net count stays at 1, and unmount tears it
 *     down. The first test below pins both the mount + unmount counts.
 *   - Backspace outside text inputs is preventDefault'd (browser-back
 *     suppression).
 *   - The registry's `matchEvent` is the sole router for every
 *     dispatched id — no raw combo matching here.
 *   - `session.switch.N` indexes into `sessions[N-1]` and is a no-op
 *     when the slot is empty (lets the OS shortcut bubble).
 *   - `session.close` no-ops when there's only one session open so the
 *     desktop window-close shortcut keeps working.
 *   - `session.prev` / `session.next` wraps around with modular arithmetic.
 *   - `session.togglePlanMode` flips between `plan` and the previously
 *     stored mode (defaulting to `approve` when none was stored).
 *
 * We don't re-test every registry id — that would be coupling-tests.
 * The switch dispatch is exercised through a handful of representative
 * ids that prove the wiring is correct.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { createShortcutRegistry, type ShortcutDef } from '../shortcuts/registry'
import { useShortcutDispatch, type ShortcutDispatchProps } from './useShortcutDispatch'
import { useConnectionStore } from '../store/connection'

// A minimal registry covering only the ids this test asserts on. This
// keeps the test independent of the production DEFAULT_SHORTCUTS table
// — adding a new shortcut shouldn't force a test update.
const TEST_DEFS: ShortcutDef[] = [
  { id: 'palette.toggle', defaultBinding: 'cmd+k', description: 'Palette', category: 'navigation', scope: 'global' },
  { id: 'sidebar.toggle', defaultBinding: 'cmd+b', description: 'Sidebar', category: 'view', scope: 'global' },
  { id: 'settings.open', defaultBinding: 'cmd+,', description: 'Settings', category: 'navigation', scope: 'global' },
  { id: 'session.new', defaultBinding: 'cmd+n', description: 'New session', category: 'session', scope: 'global' },
  { id: 'session.switch.1', defaultBinding: 'cmd+1', description: 'Switch tab 1', category: 'session', scope: 'global' },
  { id: 'session.switch.2', defaultBinding: 'cmd+2', description: 'Switch tab 2', category: 'session', scope: 'global' },
  { id: 'session.close', defaultBinding: 'cmd+w', description: 'Close session', category: 'session', scope: 'global' },
  { id: 'session.prev', defaultBinding: 'cmd+shift+[', description: 'Prev tab', category: 'session', scope: 'global' },
  { id: 'session.next', defaultBinding: 'cmd+shift+]', description: 'Next tab', category: 'session', scope: 'global' },
  { id: 'session.copyTranscript', defaultBinding: 'cmd+shift+c', description: 'Copy', category: 'session', scope: 'global' },
  { id: 'session.interrupt', defaultBinding: 'cmd+.', description: 'Interrupt', category: 'session', scope: 'global' },
  { id: 'session.togglePlanMode', defaultBinding: 'shift+tab', description: 'Plan mode', category: 'session', scope: 'global' },
  { id: 'view.toggleChatTerminal', defaultBinding: 'cmd+t', description: 'Toggle view', category: 'view', scope: 'global' },
  { id: 'view.cycleSplit', defaultBinding: 'cmd+\\', description: 'Cycle split', category: 'view', scope: 'global' },
  { id: 'help.toggle', defaultBinding: '?', description: 'Help', category: 'other', scope: 'global' },
  { id: 'palette.toggle.vscode', defaultBinding: 'cmd+shift+p', description: 'Palette (VS Code)', category: 'navigation', scope: 'global' },
  { id: 'device.pairQr', defaultBinding: 'cmd+shift+l', description: 'Pair a device', category: 'navigation', scope: 'global' },
  { id: 'transcript.search', defaultBinding: 'cmd+f', description: 'Find in conversation', category: 'navigation', scope: 'global', disabledInTextInput: true },
]

function fireKey(opts: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...opts,
  })
  window.dispatchEvent(event)
  return event
}

function makeProps(overrides: Partial<ShortcutDispatchProps> = {}): ShortcutDispatchProps {
  const registry = createShortcutRegistry(TEST_DEFS)
  return {
    shortcutRegistry: registry,
    sessions: [],
    activeSessionId: null,
    viewMode: 'chat',
    setViewMode: vi.fn(),
    setSplitMode: vi.fn(),
    setPaletteOpen: vi.fn(),
    setSidebarOpen: vi.fn(),
    setSettingsOpen: vi.fn(),
    setShowCreateSession: vi.fn(),
    setShortcutHelpOpen: vi.fn(),
    handleSwitchSession: vi.fn(),
    handleCloseSession: vi.fn(),
    handleCopyTranscript: vi.fn(),
    sendInterrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    appendImageAttachments: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  // Reset registry overrides between tests so localStorage doesn't leak.
  window.localStorage.clear()
})

afterEach(() => {
  // Force-unmount any hooks rendered during the test so their window
  // keydown listeners are torn down before the next test runs — Vitest
  // does NOT auto-cleanup in this project (no globals config) and a
  // leaked listener from a prior test with different `sessions` props
  // would still fire on subsequent dispatches.
  cleanup()
  vi.restoreAllMocks()
})

describe('useShortcutDispatch', () => {
  it('registers a keydown listener on mount and removes it on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const props = makeProps()
    const { unmount } = renderHook(() => useShortcutDispatch(props))
    const adds = addSpy.mock.calls.filter(c => c[0] === 'keydown')
    expect(adds.length).toBe(1)
    unmount()
    const removes = removeSpy.mock.calls.filter(c => c[0] === 'keydown')
    expect(removes.length).toBe(1)
  })

  it('preventDefaults Backspace outside text inputs', () => {
    const props = makeProps()
    renderHook(() => useShortcutDispatch(props))
    const event = fireKey({ key: 'Backspace' })
    expect(event.defaultPrevented).toBe(true)
  })

  it('does NOT preventDefault Backspace inside a text input', () => {
    const props = makeProps()
    renderHook(() => useShortcutDispatch(props))
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const event = new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    document.body.removeChild(input)
  })

  it('dispatches palette.toggle on Cmd+K', () => {
    const props = makeProps()
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'k', metaKey: true })
    expect(props.setPaletteOpen).toHaveBeenCalledOnce()
  })

  it('dispatches sidebar.toggle on Cmd+B', () => {
    const props = makeProps()
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'b', metaKey: true })
    expect(props.setSidebarOpen).toHaveBeenCalledOnce()
  })

  it('dispatches settings.open on Cmd+,', () => {
    const props = makeProps()
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: ',', metaKey: true })
    expect(props.setSettingsOpen).toHaveBeenCalledOnce()
  })

  it('dispatches device.pairQr → showQr on Cmd+Shift+L', () => {
    const showQr = vi.fn()
    const props = makeProps({ showQr })
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'l', metaKey: true, shiftKey: true })
    expect(showQr).toHaveBeenCalledOnce()
  })

  it('device.pairQr no-ops when showQr is undefined (disconnected — no throw)', () => {
    const props = makeProps({ showQr: undefined })
    renderHook(() => useShortcutDispatch(props))
    expect(() => fireKey({ key: 'l', metaKey: true, shiftKey: true })).not.toThrow()
  })

  it('dispatches session.new on Cmd+N', () => {
    const props = makeProps()
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'n', metaKey: true })
    expect(props.setShowCreateSession).toHaveBeenCalledWith(true)
  })

  it('session.switch.N calls handleSwitchSession with the indexed session', () => {
    const props = makeProps({
      sessions: [
        { sessionId: 's1' } as never,
        { sessionId: 's2' } as never,
      ],
    })
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: '2', metaKey: true })
    expect(props.handleSwitchSession).toHaveBeenCalledWith('s2')
  })

  it('session.switch.N is a no-op (and does not preventDefault) when slot is empty', () => {
    const props = makeProps({ sessions: [{ sessionId: 's1' } as never] })
    renderHook(() => useShortcutDispatch(props))
    const event = fireKey({ key: '2', metaKey: true })
    expect(props.handleSwitchSession).not.toHaveBeenCalled()
    // Empty slot must NOT swallow the OS-level Cmd+digit shortcut.
    expect(event.defaultPrevented).toBe(false)
  })

  it('session.close is a no-op when only one session is open', () => {
    const props = makeProps({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1' } as never],
    })
    renderHook(() => useShortcutDispatch(props))
    const event = fireKey({ key: 'w', metaKey: true })
    expect(props.handleCloseSession).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('session.close fires when 2+ sessions are open', () => {
    const props = makeProps({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1' } as never, { sessionId: 's2' } as never],
    })
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'w', metaKey: true })
    expect(props.handleCloseSession).toHaveBeenCalledWith('s1')
  })

  it('session.prev wraps around the sessions list', () => {
    const props = makeProps({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1' } as never,
        { sessionId: 's2' } as never,
        { sessionId: 's3' } as never,
      ],
    })
    renderHook(() => useShortcutDispatch(props))
    // Cmd+Shift+[ on s1 should wrap to s3.
    fireKey({ key: '[', metaKey: true, shiftKey: true })
    expect(props.handleSwitchSession).toHaveBeenCalledWith('s3')
  })

  it('session.next wraps around the sessions list', () => {
    const props = makeProps({
      activeSessionId: 's3',
      sessions: [
        { sessionId: 's1' } as never,
        { sessionId: 's2' } as never,
        { sessionId: 's3' } as never,
      ],
    })
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: ']', metaKey: true, shiftKey: true })
    expect(props.handleSwitchSession).toHaveBeenCalledWith('s1')
  })

  it('view.toggleChatTerminal switches chat <-> terminal based on current mode', () => {
    const props = makeProps({ viewMode: 'chat' })
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 't', metaKey: true })
    expect(props.setViewMode).toHaveBeenCalledWith('terminal')
  })

  it('view.toggleChatTerminal is a no-op for a terminal-only provider (#5997)', () => {
    const props = makeProps({ viewMode: 'terminal', terminalOnly: true })
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 't', metaKey: true })
    expect(props.setViewMode).not.toHaveBeenCalled()
  })

  it('view.cycleSplit is a no-op for a terminal-only provider (#5997)', () => {
    const props = makeProps({ terminalOnly: true })
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: '\\', metaKey: true })
    expect(props.setSplitMode).not.toHaveBeenCalled()
  })

  it('session.copyTranscript calls handleCopyTranscript', () => {
    const props = makeProps()
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'c', metaKey: true, shiftKey: true })
    expect(props.handleCopyTranscript).toHaveBeenCalledOnce()
  })

  it('session.interrupt calls sendInterrupt', () => {
    const props = makeProps()
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: '.', metaKey: true })
    expect(props.sendInterrupt).toHaveBeenCalledOnce()
  })

  it('session.togglePlanMode toggles between plan and previous mode', () => {
    const props = makeProps()
    // Stub store state for togglePlanMode (reads permissionMode + previousPermissionMode)
    const getStateSpy = vi.spyOn(useConnectionStore, 'getState').mockReturnValue({
      permissionMode: 'approve',
      previousPermissionMode: null,
    } as never)
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'Tab', shiftKey: true })
    expect(props.setPermissionMode).toHaveBeenCalledWith('plan')
    getStateSpy.mockRestore()
  })

  it('session.togglePlanMode switches back to previousPermissionMode when currently in plan', () => {
    const props = makeProps()
    const getStateSpy = vi.spyOn(useConnectionStore, 'getState').mockReturnValue({
      permissionMode: 'plan',
      previousPermissionMode: 'autoEdit',
    } as never)
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'Tab', shiftKey: true })
    expect(props.setPermissionMode).toHaveBeenCalledWith('autoEdit')
    getStateSpy.mockRestore()
  })

  it('session.togglePlanMode defaults to "approve" when no previous mode was stored', () => {
    const props = makeProps()
    const getStateSpy = vi.spyOn(useConnectionStore, 'getState').mockReturnValue({
      permissionMode: 'plan',
      previousPermissionMode: null,
    } as never)
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'Tab', shiftKey: true })
    expect(props.setPermissionMode).toHaveBeenCalledWith('approve')
    getStateSpy.mockRestore()
  })

  it('palette.toggle.vscode (Cmd+Shift+P) also dispatches setPaletteOpen', () => {
    const props = makeProps()
    renderHook(() => useShortcutDispatch(props))
    fireKey({ key: 'p', metaKey: true, shiftKey: true })
    expect(props.setPaletteOpen).toHaveBeenCalledOnce()
  })

  it('transcript.search (Cmd+F) opens the find bar + preventDefaults when a chat transcript is visible', () => {
    const openTranscriptSearch = vi.fn()
    const props = makeProps({ chatTranscriptVisible: true, openTranscriptSearch })
    renderHook(() => useShortcutDispatch(props))
    const event = fireKey({ key: 'f', metaKey: true })
    expect(openTranscriptSearch).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  it('transcript.search (Cmd+F) falls through to native find when no chat transcript is visible', () => {
    const openTranscriptSearch = vi.fn()
    // e.g. the Files / System / Control Room tab — no transcript to search.
    const props = makeProps({ chatTranscriptVisible: false, openTranscriptSearch })
    renderHook(() => useShortcutDispatch(props))
    const event = fireKey({ key: 'f', metaKey: true })
    expect(openTranscriptSearch).not.toHaveBeenCalled()
    // Not swallowed — the browser's native Cmd+F still runs on non-chat surfaces.
    expect(event.defaultPrevented).toBe(false)
  })

  it('transcript.search (Cmd+F) does NOT fire inside a text input (native find keeps working)', () => {
    const openTranscriptSearch = vi.fn()
    const props = makeProps({ chatTranscriptVisible: true, openTranscriptSearch })
    renderHook(() => useShortcutDispatch(props))
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    expect(openTranscriptSearch).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    document.body.removeChild(input)
  })
})
