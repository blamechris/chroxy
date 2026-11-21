/**
 * #8703 — the REAL App on the REAL store: the Stop button / Escape reach the
 * store's gate through App's own wiring (App.test.tsx mocks the store, and
 * store/interrupt-confirm.test.tsx supplies its own `onInterrupt`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import type { ChatMessage } from '@chroxy/store-core'
import { App } from './App'
import { useConnectionStore, createEmptySessionState } from './store/connection'
import { handleMessage, setStore } from './store/message-handler'
import type { SessionState } from './store/types'

vi.mock('./hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ isRecording: false, transcript: '', error: null, isAvailable: false, engine: 'none' as const, start: vi.fn(), stop: vi.fn() }),
}))

// xterm's Terminal.open() needs matchMedia, which jsdom lacks (same stub as App.test.tsx).
vi.mock('./components/MultiTerminalView', () => ({
  MultiTerminalView: () => <div data-testid="multi-terminal-view-mock" />,
}))

let sent: { type: string; sessionId?: string }[]
const msg = (id: string, type: ChatMessage['type'], content = 'x'): ChatMessage =>
  ({ id, type, content, timestamp: 1 }) as ChatMessage

function seed(messages: ChatMessage[], streamingMessageId: string | null = null) {
  const socket = {
    send: vi.fn((raw: string) => { try { sent.push(JSON.parse(raw)) } catch { /* noop */ } }),
    close: vi.fn(), readyState: WebSocket.OPEN, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as WebSocket
  useConnectionStore.setState({
    connectionPhase: 'connected',
    socket,
    activeSessionId: 's1',
    sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli', hasTerminal: false, model: null, permissionMode: null, isBusy: true, createdAt: 1, conversationId: null }],
    sessionStates: { s1: { ...createEmptySessionState(), isIdle: false, streamingMessageId, messages } as unknown as SessionState },
    pendingInterruptConfirm: null,
  } as never)
}
const composer = () => screen.getByTestId('input-bar').querySelector('textarea') as HTMLTextAreaElement
const interrupts = () => sent.filter((f) => f.type === 'interrupt')

beforeEach(() => { sent = []; setStore(useConnectionStore as never) })
afterEach(() => {
  cleanup()
  useConnectionStore.setState({ pendingInterruptConfirm: null, socket: null, sessionStates: {}, sessions: [], activeSessionId: null, connectionPhase: 'disconnected' } as never)
})

describe('App wiring of the early-interrupt gate (#8703)', () => {
  it('the real Stop button opens the dialog and sends no interrupt frame', () => {
    seed([msg('u1', 'user_input'), msg('thinking', 'thinking', '')])
    render(<App />)
    fireEvent.click(screen.getByTestId('interrupt-button'))
    expect(screen.getByText('Stop this turn?')).toBeInTheDocument()
    expect(interrupts()).toHaveLength(0)
  })

  it('Stop sends straight away once output has arrived (no dialog)', () => {
    seed([msg('u1', 'user_input'), msg('r1', 'response', 'hello')], 'r1')
    render(<App />)
    fireEvent.click(screen.getByTestId('interrupt-button'))
    expect(screen.queryByText('Stop this turn?')).toBeNull()
    expect(interrupts()).toHaveLength(1)
  })

  it('the first Escape opens the dialog (jsdom, synchronous dispatch; does NOT model browser ordering, see Modal.test.tsx)', () => {
    seed([msg('u1', 'user_input'), msg('thinking', 'thinking', '')])
    render(<App />)
    fireEvent.keyDown(composer(), { key: 'Escape' })
    expect(screen.getByText('Stop this turn?')).toBeInTheDocument()
    expect(interrupts()).toHaveLength(0)
  })

  it('the first Escape dispatched outside act opens the dialog (jsdom only; the in-flight-event race is guarded in Modal.test.tsx)', async () => {
    seed([msg('u1', 'user_input'), msg('thinking', 'thinking', '')])
    render(<App />)
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const prev = g.IS_REACT_ACT_ENVIRONMENT
    g.IS_REACT_ACT_ENVIRONMENT = false
    try {
      composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = prev
    }
    expect(screen.queryByText('Stop this turn?')).not.toBeNull()
    expect(interrupts()).toHaveLength(0)
  })

  it('a second Escape cancels the dialog and still sends nothing', () => {
    seed([msg('u1', 'user_input'), msg('thinking', 'thinking', '')])
    render(<App />)
    fireEvent.keyDown(composer(), { key: 'Escape' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByText('Stop this turn?')).toBeNull()
    expect(interrupts()).toHaveLength(0)
  })

  it('claude-tui: a real stream_start frame (empty response slot) still gates Stop', () => {
    seed([msg('u1', 'user_input'), msg('thinking', 'thinking', '')], 'pending')
    render(<App />)
    act(() => {
      handleMessage({ type: 'stream_start', messageId: 'r1', sessionId: 's1' }, { url: 'wss://t', token: 'tok', socket: useConnectionStore.getState().socket, isReconnect: false, silent: false } as never)
    })
    const ss = useConnectionStore.getState().sessionStates.s1
    expect(ss?.messages.some((m) => m.type === 'response' && m.content === '')).toBe(true)
    fireEvent.click(screen.getByTestId('interrupt-button'))
    expect(screen.getByText('Stop this turn?')).toBeInTheDocument()
    expect(interrupts()).toHaveLength(0)
  })
})
