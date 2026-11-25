/**
 * #9069 — when Stop discards queued follow-ups the dashboard says so: ONE
 * "Not sent" system notice naming every discarded message. Real store, real
 * `sendInterrupt`, real `handleMessage` (the shared store-core dispatch).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ChatMessage } from '@chroxy/store-core'
import { useConnectionStore, createEmptySessionState } from './connection'
import { handleMessage } from './message-handler'
import type { SessionState } from './types'

const LONG = 'refactor the authentication module so that it no longer reads the environment directly'

function seed(queued: Array<{ id: string; text: string }>, extra: Partial<SessionState> = {}) {
  useConnectionStore.setState({
    socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
    activeSessionId: 's1',
    sessionStates: {
      s1: {
        ...createEmptySessionState(),
        isIdle: false,
        streamingMessageId: 'r1',
        messages: [
          { id: 'r1', type: 'response', content: 'working', timestamp: 1 },
          ...queued.map((q, i) => ({ id: q.id, type: 'user_input', content: q.text, timestamp: 2 + i }) as ChatMessage),
        ],
        queuedMessages: queued.map((q, i) => ({
          clientMessageId: q.id, text: q.text, queuedAt: 2 + i, status: 'confirmed' as const,
        })),
        ...extra,
      } as SessionState,
    },
  } as never)
}

const dequeue = (id: string | undefined, reason: string, queueLength = 0) =>
  handleMessage({ type: 'message_dequeued', sessionId: 's1', clientMessageId: id, queueLength, reason }, { url: 'wss://t' } as never)

const notices = () =>
  useConnectionStore.getState().sessionStates.s1!.messages.filter((m) => m.id.startsWith('queue-discarded-'))

afterEach(() => {
  useConnectionStore.setState({ socket: null, sessionStates: {}, activeSessionId: null } as never)
})

describe('Stop discarding queued follow-ups (#9069)', () => {
  it('this client pressed Stop: two interrupted dequeues give exactly one notice naming both', () => {
    seed([{ id: 'q1', text: LONG }, { id: 'q2', text: 'and then add\n  tests' }])
    useConnectionStore.getState().sendInterrupt(undefined, { confirmed: true })
    expect(useConnectionStore.getState().sessionStates.s1!.queuedMessages).toHaveLength(0)
    expect(notices()).toHaveLength(0) // nothing claimed until the server confirms

    dequeue('q1', 'interrupted', 1)
    dequeue('q2', 'interrupted', 0)

    const n = notices()
    expect(n).toHaveLength(1)
    expect(n[0]!.type).toBe('system')
    expect(n[0]!.content).toBe(
      'Not sent — Stop discarded 2 queued messages: “refactor the authentication module so that it no longer rea…”, “and then add tests”',
    )
    expect(n[0]!.content).not.toContain('\n')
    // The stash is spent.
    expect(useConnectionStore.getState().sessionStates.s1!.interruptedQueued).toEqual([])
  })

  it('another client pressed Stop: dequeues for entries still shown give one notice', () => {
    seed([{ id: 'q1', text: 'first' }, { id: 'q2', text: 'second' }])
    dequeue('q1', 'interrupted', 1)
    dequeue('q2', 'interrupted', 0)
    const n = notices()
    expect(n).toHaveLength(1)
    expect(n[0]!.content).toBe('Not sent — Stop discarded 2 queued messages: “first”, “second”')
  })

  it('a single item reads in the singular', () => {
    seed([{ id: 'q1', text: 'only' }])
    dequeue('q1', 'interrupted')
    expect(notices()[0]!.content).toBe('Not sent — Stop discarded 1 queued message: “only”')
  })

  it('a repeated frame for the same id does not add a row', () => {
    seed([{ id: 'q1', text: 'only' }])
    dequeue('q1', 'interrupted')
    dequeue('q1', 'interrupted')
    expect(notices()[0]!.content).toContain('discarded 1 queued message:')
  })

  it('controls: cancelled and flush dequeues produce no notice', () => {
    seed([{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }])
    dequeue('q1', 'cancelled', 1)
    dequeue('q2', 'flush', 0)
    expect(notices()).toHaveLength(0)
  })

  it('control: Stop with an empty queue produces no notice', () => {
    seed([])
    useConnectionStore.getState().sendInterrupt(undefined, { confirmed: true })
    expect(notices()).toHaveLength(0)
    expect(useConnectionStore.getState().sessionStates.s1!.interruptedQueued ?? []).toEqual([])
  })
})
