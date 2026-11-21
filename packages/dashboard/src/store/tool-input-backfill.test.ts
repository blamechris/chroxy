/**
 * #8415 -- a `tool_input_backfill` frame through the REAL dashboard message handler.
 *
 * The frame gives a tool card the client already holds the input it lacks. It is
 * reconcile-only: it must never add a card, start a tool (no `activeTools` entry, so
 * no running pill) or write a terminal line -- the `tool_start` case does all three,
 * and routing the frame there is the regression this file guards.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useConnectionStore } from './connection'
import {
  _testMessageHandler,
  clearDeltaBuffers,
  clearPermissionSplits,
  resetReplayFlags,
} from './message-handler'
import { createEmptySessionState } from './utils'

const SID = 's1'
const INPUT = { command: 'ls -la' }

function boot(messages: Array<Record<string, unknown>>) {
  clearDeltaBuffers()
  clearPermissionSplits()
  resetReplayFlags()
  const appendTerminalData = vi.fn()
  useConnectionStore.setState({
    activeSessionId: SID,
    sessionStates: {
      [SID]: { ...createEmptySessionState(), messages: messages as never, activeTools: [] },
    },
    socket: null,
    appendTerminalData,
  })
  _testMessageHandler.setContext({
    url: 'ws://x', token: 't', isReconnect: false, silent: false,
    socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
  })
  const session = () => useConnectionStore.getState().sessionStates[SID]!
  const send = (m: Record<string, unknown>) => _testMessageHandler.handle({ ...m })
  return { session, send, appendTerminalData }
}

const bare = { id: 'tool-1', type: 'tool_use', tool: 'Bash', content: 'Bash', timestamp: 1 }
const frame = { type: 'tool_input_backfill', sessionId: SID, messageId: 'tool-1', input: INPUT }

describe('tool_input_backfill through the dashboard handler (#8415)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fills the held card once, and a repeated frame changes nothing', () => {
    const { session, send, appendTerminalData } = boot([bare])
    const activeBefore = session().activeTools

    send(frame)
    const filled = session().messages
    expect(filled).toHaveLength(1)
    expect(filled[0]).toMatchObject({ id: 'tool-1', toolInput: INPUT, content: JSON.stringify(INPUT) })

    for (let i = 0; i < 3; i++) send(frame)
    expect(session().messages, 'a repeat must not rewrite the transcript').toBe(filled)
    expect(session().messages).toHaveLength(1)
    expect(session().activeTools, 'no running tool is started').toBe(activeBefore)
    expect(session().activeTools).toEqual([])
    expect(appendTerminalData, 'no terminal line is written').not.toHaveBeenCalled()
  })

  it('adds nothing for a card the client does not hold', () => {
    const { session, send, appendTerminalData } = boot([bare])
    const before = session().messages
    send({ ...frame, messageId: 'tool-gone' })
    expect(session().messages).toEqual(before)
    expect(session().activeTools).toEqual([])
    expect(appendTerminalData).not.toHaveBeenCalled()
  })

  it('leaves a card that already has an input alone', () => {
    const held = { ...bare, content: '{"command":"pwd"}', toolInput: { command: 'pwd' } }
    const { session, send, appendTerminalData } = boot([held])
    send(frame)
    expect(session().messages).toHaveLength(1)
    expect(session().messages[0]).toMatchObject({ toolInput: { command: 'pwd' }, content: '{"command":"pwd"}' })
    expect(appendTerminalData).not.toHaveBeenCalled()
  })

  it('positive control: a real tool_start for a new card DOES write a terminal line (the spy can fire)', () => {
    const { session, send, appendTerminalData } = boot([bare])
    send({ type: 'tool_start', sessionId: SID, messageId: 'tool-new', toolUseId: 'tool-new', tool: 'Bash', input: INPUT })
    expect(session().messages.some((m) => m.id === 'tool-new')).toBe(true)
    expect(appendTerminalData).toHaveBeenCalled()
  })
})
