/**
 * #8703 — every dashboard Stop path goes through the store's `sendInterrupt`,
 * which asks first when the turn has produced no output yet.
 *
 * REAL store, fake socket: the assertions are on what reached the wire (no
 * `interrupt` frame while gated, exactly one after Confirm), not on component
 * state. Each path is driven through the real component / hook / command that
 * owns it; `App.handleInterrupt` is the one-liner `() => sendInterrupt()`, which
 * the Escape / Stop-button cases reproduce as the InputBar's `onInterrupt`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, renderHook } from '@testing-library/react'
import type { ChatMessage } from '@chroxy/store-core'
import { useConnectionStore, createEmptySessionState } from './connection'
import { InputBar } from '../components/InputBar'
import { useShortcutDispatch, type ShortcutDispatchProps } from '../hooks/useShortcutDispatch'
import { createShortcutRegistry } from '../shortcuts/registry'
import { useCommands } from './commands'
import type { SessionState } from './types'
import { handleMessage, setStore } from './message-handler'

type Frame = { type: string; sessionId?: string }
let sent: Frame[]

function liveSocket(): WebSocket {
  return {
    send: vi.fn((raw: string) => { try { sent.push(JSON.parse(raw)) } catch { /* noop */ } }),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

const interrupts = () => sent.filter((f) => f.type === 'interrupt')
const msg = (id: string, type: ChatMessage['type']): ChatMessage =>
  ({ id, type, content: 'x', timestamp: 1 }) as ChatMessage

/** Busy session, user message sent, nothing back yet (the post-stall-clear shape). */
const awaiting = (): SessionState => ({
  ...createEmptySessionState(),
  isIdle: false,
  streamingMessageId: null,
  messages: [msg('u1', 'user_input'), msg('thinking', 'thinking')],
} as unknown as SessionState)

/** Same turn once the model has started streaming. */
const streaming = (): SessionState => ({
  ...createEmptySessionState(),
  isIdle: false,
  streamingMessageId: 'r1',
  messages: [msg('u1', 'user_input'), msg('r1', 'response')],
} as unknown as SessionState)

function seed(state: SessionState, sid = 's1') {
  useConnectionStore.setState({
    socket: liveSocket(),
    activeSessionId: sid,
    sessionStates: { [sid]: state },
    pendingInterruptConfirm: null,
  } as never)
}

beforeEach(() => { sent = [] })
afterEach(() => {
  cleanup()
  useConnectionStore.setState({ pendingInterruptConfirm: null, socket: null, sessionStates: {}, activeSessionId: null } as never)
})

describe('sendInterrupt gate (#8703)', () => {
  it('parks a confirm and sends NOTHING while the turn has no output yet', () => {
    seed(awaiting())
    expect(useConnectionStore.getState().sendInterrupt()).toBe('confirm')
    expect(interrupts()).toHaveLength(0)
    expect(useConnectionStore.getState().pendingInterruptConfirm).toEqual({ sessionId: 's1' })
  })

  it('does not touch the outgoing queue while gated', () => {
    seed({ ...awaiting(), queuedMessages: [{ clientMessageId: 'q1', text: 'later', queuedAt: 1, status: 'pending' }] } as SessionState)
    useConnectionStore.getState().sendInterrupt()
    expect(useConnectionStore.getState().sessionStates.s1?.queuedMessages).toHaveLength(1)
  })

  it('sends immediately once output has arrived', () => {
    seed(streaming())
    expect(useConnectionStore.getState().sendInterrupt()).toBe('sent')
    expect(interrupts()).toHaveLength(1)
    expect(useConnectionStore.getState().pendingInterruptConfirm).toBeNull()
  })

  it('Confirm sends exactly one frame, for the parked session, and clears the dialog', () => {
    seed(awaiting())
    useConnectionStore.getState().sendInterrupt()
    const target = useConnectionStore.getState().pendingInterruptConfirm!
    expect(useConnectionStore.getState().sendInterrupt(target.sessionId, { confirmed: true })).toBe('sent')
    expect(interrupts()).toEqual([{ type: 'interrupt', sessionId: 's1' }])
    expect(useConnectionStore.getState().pendingInterruptConfirm).toBeNull()
  })

  it('dismiss (Cancel) sends nothing and clears the dialog', () => {
    seed(awaiting())
    useConnectionStore.getState().sendInterrupt()
    useConnectionStore.getState().dismissInterruptConfirm()
    expect(interrupts()).toHaveLength(0)
    expect(useConnectionStore.getState().pendingInterruptConfirm).toBeNull()
  })

  it('an explicit non-active sessionId (Control Room) is gated on THAT session', () => {
    seed(streaming(), 's-active')
    useConnectionStore.setState({
      sessionStates: { 's-active': streaming(), 's-other': awaiting() },
    } as never)
    expect(useConnectionStore.getState().sendInterrupt('s-other')).toBe('confirm')
    expect(useConnectionStore.getState().pendingInterruptConfirm).toEqual({ sessionId: 's-other' })
    expect(interrupts()).toHaveLength(0)
    // ...and the active session's own output does not open a gate on it.
    useConnectionStore.getState().dismissInterruptConfirm()
    expect(useConnectionStore.getState().sendInterrupt('s-active')).toBe('sent')
  })

  it('clears when the target session leaves the roster, and survives a different one leaving', () => {
    setStore(useConnectionStore as never)
    const ctx = { url: 'wss://t', token: 'tok', socket: liveSocket(), isReconnect: false, silent: false }
    const list = (ids: string[]) => ({ type: 'session_list', sessions: ids.map((id) => ({ sessionId: id, name: id, isBusy: false })) })
    seed(awaiting(), 's-dead')
    useConnectionStore.setState({ sessionStates: { 's-dead': awaiting(), 's-live': awaiting() } } as never)
    useConnectionStore.getState().sendInterrupt('s-live')
    handleMessage(list(['s-live']), ctx as never)
    expect(useConnectionStore.getState().pendingInterruptConfirm).toEqual({ sessionId: 's-live' })
    useConnectionStore.getState().dismissInterruptConfirm()
    useConnectionStore.setState({ sessionStates: { 's-dead': awaiting(), 's-live': awaiting() } } as never)
    useConnectionStore.getState().sendInterrupt('s-dead')
    expect(useConnectionStore.getState().pendingInterruptConfirm).toEqual({ sessionId: 's-dead' })
    handleMessage(list(['s-live']), ctx as never)
    expect(useConnectionStore.getState().pendingInterruptConfirm).toBeNull()
  })

  it('clears when the session disconnects', () => {
    seed(awaiting())
    useConnectionStore.getState().sendInterrupt()
    useConnectionStore.getState().disconnect()
    expect(useConnectionStore.getState().pendingInterruptConfirm).toBeNull()
  })
})

function composer() {
  // App.handleInterrupt is `() => sendInterrupt()`.
  return render(
    <InputBar onSend={vi.fn()} onInterrupt={() => { useConnectionStore.getState().sendInterrupt() }} isBusy isStreaming={false} />,
  )
}

function shortcut() {
  const props: ShortcutDispatchProps = {
    shortcutRegistry: createShortcutRegistry([
      { id: 'session.interrupt', defaultBinding: 'cmd+.', description: 'Interrupt', category: 'session', scope: 'global' },
    ]),
    sessions: [], activeSessionId: 's1', viewMode: 'chat',
    setViewMode: vi.fn(), setSplitMode: vi.fn(), setPaletteOpen: vi.fn(), setSidebarOpen: vi.fn(),
    setSettingsOpen: vi.fn(), setShowCreateSession: vi.fn(), setShortcutHelpOpen: vi.fn(),
    handleSwitchSession: vi.fn(), handleCloseSession: vi.fn(), handleCopyTranscript: vi.fn(),
    sendInterrupt: () => { useConnectionStore.getState().sendInterrupt() },
    setPermissionMode: vi.fn(), appendImageAttachments: vi.fn(),
  }
  renderHook(() => useShortcutDispatch(props))
}
const cmdDot = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true, cancelable: true }))

describe('every Stop path inherits the gate (#8703)', () => {
  it('Escape in the composer', () => {
    seed(awaiting())
    composer()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(interrupts()).toHaveLength(0)
    expect(useConnectionStore.getState().pendingInterruptConfirm).toEqual({ sessionId: 's1' })
  })

  it('Escape in the composer sends once output has arrived', () => {
    seed(streaming())
    composer()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(interrupts()).toHaveLength(1)
  })

  it('the Stop button', () => {
    seed(awaiting())
    render(<InputBar onSend={vi.fn()} onInterrupt={() => { useConnectionStore.getState().sendInterrupt() }} isStreaming />)
    fireEvent.click(screen.getByTestId('interrupt-button'))
    expect(interrupts()).toHaveLength(0)
    expect(useConnectionStore.getState().pendingInterruptConfirm).toEqual({ sessionId: 's1' })
  })

  it('the Stop button sends once output has arrived', () => {
    seed(streaming())
    render(<InputBar onSend={vi.fn()} onInterrupt={() => { useConnectionStore.getState().sendInterrupt() }} isStreaming />)
    fireEvent.click(screen.getByTestId('interrupt-button'))
    expect(interrupts()).toHaveLength(1)
  })

  it('Cmd+.', () => {
    seed(awaiting())
    shortcut()
    cmdDot()
    expect(interrupts()).toHaveLength(0)
    expect(useConnectionStore.getState().pendingInterruptConfirm).toEqual({ sessionId: 's1' })
  })

  it('Cmd+. sends once output has arrived', () => {
    seed(streaming())
    shortcut()
    cmdDot()
    expect(interrupts()).toHaveLength(1)
  })

  it('the command palette action', () => {
    seed(awaiting())
    const { result } = renderHook(() => useCommands())
    result.current.find((c) => c.id === 'interrupt')!.action()
    expect(interrupts()).toHaveLength(0)
    expect(useConnectionStore.getState().pendingInterruptConfirm).toEqual({ sessionId: 's1' })
  })

  it('the command palette action sends once output has arrived', () => {
    seed(streaming())
    const { result } = renderHook(() => useCommands())
    result.current.find((c) => c.id === 'interrupt')!.action()
    expect(interrupts()).toHaveLength(1)
  })
})

describe('a held Stop key acts once (#9243)', () => {
  const textbox = () => screen.getByRole('textbox')
  const cmdDotRepeat = () => {
    const ev = new KeyboardEvent('keydown', { key: '.', metaKey: true, repeat: true, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    return ev
  }

  it('a held Escape in the composer sends one frame', () => {
    seed(streaming())
    composer()
    fireEvent.keyDown(textbox(), { key: 'Escape' })
    fireEvent.keyDown(textbox(), { key: 'Escape', repeat: true })
    fireEvent.keyDown(textbox(), { key: 'Escape', repeat: true })
    expect(interrupts()).toHaveLength(1)
  })

  it('a repeat Escape in the composer is still preventDefaulted', () => {
    seed(streaming())
    composer()
    fireEvent.keyDown(textbox(), { key: 'Escape' })
    expect(fireEvent.keyDown(textbox(), { key: 'Escape', repeat: true })).toBe(false)
  })

  it('a held Cmd+. sends one frame and the repeats are preventDefaulted', () => {
    seed(streaming())
    shortcut()
    cmdDot()
    const r1 = cmdDotRepeat()
    const r2 = cmdDotRepeat()
    expect(interrupts()).toHaveLength(1)
    expect(r1.defaultPrevented).toBe(true)
    expect(r2.defaultPrevented).toBe(true)
  })

  it('two separate Escape presses send two frames', () => {
    seed(streaming())
    composer()
    fireEvent.keyDown(textbox(), { key: 'Escape' })
    fireEvent.keyDown(textbox(), { key: 'Escape' })
    expect(interrupts()).toHaveLength(2)
  })

  it('two separate Cmd+. presses send two frames', () => {
    seed(streaming())
    shortcut()
    cmdDot()
    cmdDot()
    expect(interrupts()).toHaveLength(2)
  })
})
