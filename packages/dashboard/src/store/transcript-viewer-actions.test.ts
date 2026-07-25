/**
 * requestConversationTranscript / closeTranscriptViewer store actions
 * (#6863, epic #6765).
 *
 * Covers the send-side of the read-only transcript viewer: the wire payload
 * sent for `request_conversation_transcript` (#6860), the loading/error/timeout
 * transitions, and the end-to-end flow through `handleMessage` (connection.ts
 * wires message-handler.ts's module store to this same real Zustand store —
 * see the `setStore(...)` call near the bottom of connection.ts — so driving
 * `handleMessage` here exercises the exact same interception path production
 * traffic takes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

function createMockSocket() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

describe('requestConversationTranscript / closeTranscriptViewer (#6863)', () => {
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: undefined, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends request_conversation_transcript with the conversationId and opens the viewer in loading state', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = createMockSocket()
    useConnectionStore.setState({
      socket,
      transcriptViewer: { conversationId: null, status: 'idle', messages: [], error: null },
    })

    useConnectionStore.getState().requestConversationTranscript('conv-1')

    expect(socket.send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse((socket.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string)
    expect(payload.type).toBe('request_conversation_transcript')
    expect(payload.conversationId).toBe('conv-1')
    expect(payload.cwd).toBeUndefined()

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBe('conv-1')
    expect(viewer.status).toBe('loading')
    expect(viewer.messages).toEqual([])
    expect(viewer.error).toBeNull()
  })

  it('includes cwd on the wire payload when provided', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-2', '/home/user/project')

    const payload = JSON.parse((socket.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string)
    expect(payload.cwd).toBe('/home/user/project')
  })

  it('surfaces an immediate error (no crash) when the socket is not open — #6308/#6309 wsSend return-value check', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({ socket: null })

    expect(() => useConnectionStore.getState().requestConversationTranscript('conv-3')).not.toThrow()

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBe('conv-3')
    expect(viewer.status).toBe('error')
    expect(viewer.error).toBeTruthy()
  })

  it('closeTranscriptViewer resets to idle', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })
    useConnectionStore.getState().requestConversationTranscript('conv-4')
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('loading')

    useConnectionStore.getState().closeTranscriptViewer()

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBeNull()
    expect(viewer.status).toBe('idle')
    expect(viewer.messages).toEqual([])
    expect(viewer.error).toBeNull()
  })

  it('a fetch still loading after the watchdog window surfaces a timeout error instead of spinning forever', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await import('./connection')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-5')
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('loading')

    vi.advanceTimersByTime(15_000)

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.status).toBe('error')
    expect(viewer.error).toMatch(/timed out/i)
    vi.useRealTimers()
  })

  it('a completed fetch before the watchdog window does NOT get overwritten by the timeout', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-6')
    handleMessage({ type: 'history_replay_start', sessionId: 'conv-6', conversationId: 'conv-6' }, ctx() as never)
    handleMessage({ type: 'history_replay_end', sessionId: 'conv-6' }, ctx() as never)
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('ready')

    vi.advanceTimersByTime(15_000)

    // Still ready — the (cleared) watchdog must not clobber a completed fetch.
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('ready')
    vi.useRealTimers()
  })

  it('end-to-end: request -> replay frames -> ready, with messages accumulated in order', async () => {
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-7', '/home/user/proj')
    handleMessage({ type: 'history_replay_start', sessionId: 'conv-7', conversationId: 'conv-7' }, ctx() as never)
    handleMessage(
      { type: 'message', messageType: 'user_input', content: 'hello', sessionId: 'conv-7', timestamp: 1 },
      ctx() as never,
    )
    handleMessage(
      { type: 'message', messageType: 'response', content: 'hi there', sessionId: 'conv-7', timestamp: 2 },
      ctx() as never,
    )
    handleMessage({ type: 'history_replay_end', sessionId: 'conv-7' }, ctx() as never)

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.status).toBe('ready')
    expect(viewer.messages.map(m => m.content)).toEqual(['hello', 'hi there'])
  })

  it('a subsequent View request for a DIFFERENT conversation resets messages (no bleed-through)', async () => {
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-8')
    handleMessage({ type: 'history_replay_start', sessionId: 'conv-8', conversationId: 'conv-8' }, ctx() as never)
    handleMessage(
      { type: 'message', messageType: 'response', content: 'first conversation', sessionId: 'conv-8', timestamp: 1 },
      ctx() as never,
    )
    handleMessage({ type: 'history_replay_end', sessionId: 'conv-8' }, ctx() as never)
    expect(useConnectionStore.getState().transcriptViewer.messages).toHaveLength(1)

    useConnectionStore.getState().requestConversationTranscript('conv-9')
    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBe('conv-9')
    expect(viewer.status).toBe('loading')
    expect(viewer.messages).toEqual([])
  })
})

/**
 * #7000 CRITICAL 1 — the interception guard's LIFETIME.
 *
 * Frames arriving for a conversationId that is no longer armed are NOT inert:
 * a `message` falls through to the switch's flat `addMessage` fallback
 * (transcript text rendered as live chat) and a late `history_replay_start`
 * reaches `updateActiveSession`, which wipes the live session's `activeAgents`
 * and cancels `isPlanPending` / `planAllowedPrompts` — so a mid-stream disarm
 * could silently DROP A PENDING PLAN APPROVAL. Closing the viewer, the
 * watchdog firing, and Retry each used to disarm mid-stream; each of those
 * three sequences is pinned below.
 */
describe('transcript frames stay intercepted until their own history_replay_end (#7000 C1)', () => {
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: undefined, isReconnect: false, silent: false })
  const LIVE_ID = 'live-1'
  const CONV_ID = 'conv-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  beforeEach(async () => {
    vi.useRealTimers()
    const { resetTranscriptFetchTracking } = await import('./message-handler')
    resetTranscriptFetchTracking()
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { resetTranscriptFetchTracking } = await import('./message-handler')
    resetTranscriptFetchTracking()
  })

  /**
   * A live session mid-turn with a sub-agent running AND a plan approval
   * awaiting the user — i.e. exactly the state a leaked frame destroys.
   */
  async function seedLiveSessionWithPendingPlan() {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    const socket = createMockSocket()
    useConnectionStore.setState({
      socket,
      activeSessionId: LIVE_ID,
      sessions: [{ sessionId: LIVE_ID, name: 'Live' }],
      sessionStates: {
        [LIVE_ID]: {
          ...createEmptySessionState(),
          activeAgents: [{ toolUseId: 'agent-1', description: 'sub-agent', startedAt: 1 }],
          isPlanPending: true,
          planAllowedPrompts: [{ tool: 'ExitPlanMode', prompt: 'ship it' }],
        },
      },
      messages: [],
      transcriptViewer: { conversationId: null, status: 'idle', messages: [], error: null },
    } as never)
    return { useConnectionStore, handleMessage }
  }

  /** The two frame kinds that can do damage, delivered AFTER the trigger. */
  function deliverLateFrames(handleMessage: (raw: unknown, ctxOverride?: never) => void) {
    handleMessage(
      { type: 'message', messageType: 'response', content: 'late transcript line', sessionId: CONV_ID, timestamp: 99 },
      ctx() as never,
    )
    handleMessage({ type: 'history_replay_start', sessionId: CONV_ID, conversationId: CONV_ID }, ctx() as never)
  }

  function expectLiveStateUntouched(store: { getState: () => Record<string, never> }) {
    const state = store.getState() as unknown as {
      messages: unknown[]
      sessionStates: Record<string, { messages: unknown[]; activeAgents: unknown[]; isPlanPending: boolean; planAllowedPrompts: unknown[] }>
    }
    // Flat fallback (`addMessage`) never fired...
    expect(state.messages).toHaveLength(0)
    const ss = state.sessionStates[LIVE_ID]!
    expect(ss.messages).toHaveLength(0)
    // ...and the live session's transient state survived intact. The plan
    // fields are the user-visible harm: a dropped approval leaves the user
    // with no way to answer a plan the agent is still blocked on.
    expect(ss.activeAgents).toHaveLength(1)
    expect(ss.isPlanPending).toBe(true)
    expect(ss.planAllowedPrompts).toHaveLength(1)
  }

  it('close mid-stream: late frames are still intercepted, live session + pending plan untouched', async () => {
    const { useConnectionStore, handleMessage } = await seedLiveSessionWithPendingPlan()

    useConnectionStore.getState().requestConversationTranscript(CONV_ID)
    handleMessage({ type: 'history_replay_start', sessionId: CONV_ID, conversationId: CONV_ID }, ctx() as never)
    handleMessage(
      { type: 'message', messageType: 'response', content: 'first line', sessionId: CONV_ID, timestamp: 1 },
      ctx() as never,
    )

    // User closes the viewer while the server is still streaming.
    useConnectionStore.getState().closeTranscriptViewer()
    deliverLateFrames(handleMessage)

    expectLiveStateUntouched(useConnectionStore as never)
    // Closing stops RENDERING: the closed viewer is not re-populated either.
    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBeNull()
    expect(viewer.status).toBe('idle')
    expect(viewer.messages).toEqual([])
  })

  it('opening and closing the viewer can no longer drop a pending plan approval', async () => {
    // The narrowest statement of the user-visible harm, asserted on its own
    // (the broader sequences above trip on the flat-message leak first): a
    // single late history_replay_start reaches updateActiveSession, which
    // cancels isPlanPending / planAllowedPrompts for the ACTIVE session —
    // leaving the user unable to answer a plan the agent is still blocked on.
    const { useConnectionStore, handleMessage } = await seedLiveSessionWithPendingPlan()

    useConnectionStore.getState().requestConversationTranscript(CONV_ID)
    useConnectionStore.getState().closeTranscriptViewer()
    handleMessage({ type: 'history_replay_start', sessionId: CONV_ID, conversationId: CONV_ID }, ctx() as never)

    const ss = useConnectionStore.getState().sessionStates[LIVE_ID]!
    expect(ss.isPlanPending).toBe(true)
    expect(ss.planAllowedPrompts).toHaveLength(1)
    expect(ss.activeAgents).toHaveLength(1)
  })

  it('watchdog fires mid-stream: late frames are still intercepted, live session + pending plan untouched', async () => {
    vi.useFakeTimers()
    const { useConnectionStore, handleMessage } = await seedLiveSessionWithPendingPlan()

    useConnectionStore.getState().requestConversationTranscript(CONV_ID)
    handleMessage({ type: 'history_replay_start', sessionId: CONV_ID, conversationId: CONV_ID }, ctx() as never)

    // Stream stalls long enough for the watchdog to surface an error...
    vi.advanceTimersByTime(15_000)
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('error')

    // ...then the server's frames finally show up.
    deliverLateFrames(handleMessage)

    expectLiveStateUntouched(useConnectionStore as never)
    vi.useRealTimers()
  })

  it('retry mid-stream: the first stream\'s end frame does not disarm the retry, live session + pending plan untouched', async () => {
    const { useConnectionStore, handleMessage } = await seedLiveSessionWithPendingPlan()

    useConnectionStore.getState().requestConversationTranscript(CONV_ID)
    handleMessage({ type: 'history_replay_start', sessionId: CONV_ID, conversationId: CONV_ID }, ctx() as never)

    // Retry re-requests the SAME id while stream 1 is still on the wire.
    useConnectionStore.getState().requestConversationTranscript(CONV_ID)
    // Stream 1's end frame arrives — it must settle only ITS request, leaving
    // the retry's request armed (refcounted arming).
    handleMessage({ type: 'history_replay_end', sessionId: CONV_ID }, ctx() as never)

    // Stream 2's frames, still owed. Delivered one at a time so both the
    // "still intercepted" and "live state untouched" halves are visible: the
    // message lands in the VIEWER (not the flat list), and the late
    // history_replay_start restarts the viewer instead of wiping the live
    // session's transient state.
    handleMessage(
      { type: 'message', messageType: 'response', content: 'late transcript line', sessionId: CONV_ID, timestamp: 99 },
      ctx() as never,
    )
    expect(useConnectionStore.getState().transcriptViewer.messages.map(m => m.content)).toEqual([
      'late transcript line',
    ])
    expectLiveStateUntouched(useConnectionStore as never)

    handleMessage({ type: 'history_replay_start', sessionId: CONV_ID, conversationId: CONV_ID }, ctx() as never)

    expectLiveStateUntouched(useConnectionStore as never)
    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBe(CONV_ID)
    expect(viewer.status).toBe('loading')
    expect(viewer.messages).toEqual([])
  })

  it('a live session id is never treated as a transcript id, even if armed (namespace fail-safe)', async () => {
    const { useConnectionStore, handleMessage } = await seedLiveSessionWithPendingPlan()
    const { beginTranscriptFetch } = await import('./message-handler')

    // Pathological: the live session's id somehow lands in the pending set.
    beginTranscriptFetch(LIVE_ID)
    useConnectionStore.setState({
      transcriptViewer: { conversationId: LIVE_ID, status: 'loading', messages: [], error: null },
    } as never)

    handleMessage(
      { type: 'message', messageType: 'response', content: 'live reply', sessionId: LIVE_ID, timestamp: 5 },
      ctx() as never,
    )

    // The live session — not the viewer — received it.
    const state = useConnectionStore.getState()
    expect(state.sessionStates[LIVE_ID]!.messages).toHaveLength(1)
    expect(state.transcriptViewer.messages).toHaveLength(0)
  })
})

/**
 * #7000 CRITICAL 3 — the watchdog is an INACTIVITY timer, not a deadline.
 * The server streams a large transcript in one unchunked loop, so a fixed
 * deadline mislabels a perfectly healthy large-transcript stream an error.
 * (A per-request correlation id / dedicated failure echo would remove the
 * need for a watchdog entirely — that needs a protocol change, tracked in
 * #7007.)
 */
describe('transcript watchdog is inactivity-based (#7000 C3)', () => {
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: undefined, isReconnect: false, silent: false })
  const CONV_ID = 'conv-77777777-8888-9999-aaaa-bbbbbbbbbbbb'

  beforeEach(async () => {
    vi.useRealTimers()
    const { resetTranscriptFetchTracking } = await import('./message-handler')
    resetTranscriptFetchTracking()
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { resetTranscriptFetchTracking } = await import('./message-handler')
    resetTranscriptFetchTracking()
  })

  async function startFetch() {
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    useConnectionStore.setState({
      socket: createMockSocket(),
      transcriptViewer: { conversationId: null, status: 'idle', messages: [], error: null },
    } as never)
    useConnectionStore.getState().requestConversationTranscript(CONV_ID)
    return { useConnectionStore, handleMessage }
  }

  it('a big transcript streaming steadily past the window is NOT mislabeled an error', async () => {
    vi.useFakeTimers()
    const { useConnectionStore, handleMessage } = await startFetch()
    handleMessage({ type: 'history_replay_start', sessionId: CONV_ID, conversationId: CONV_ID }, ctx() as never)

    // 5 × 12s of steady progress = 60s total, well past the 15s window.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(12_000)
      handleMessage(
        { type: 'message', messageType: 'response', content: `line ${i}`, sessionId: CONV_ID, timestamp: i },
        ctx() as never,
      )
      expect(useConnectionStore.getState().transcriptViewer.status).toBe('loading')
      expect(useConnectionStore.getState().transcriptViewer.error).toBeNull()
    }

    handleMessage({ type: 'history_replay_end', sessionId: CONV_ID }, ctx() as never)
    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.status).toBe('ready')
    expect(viewer.messages).toHaveLength(5)
    vi.useRealTimers()
  })

  it('genuine silence past the window DOES surface the timeout', async () => {
    vi.useFakeTimers()
    const { useConnectionStore, handleMessage } = await startFetch()
    handleMessage({ type: 'history_replay_start', sessionId: CONV_ID, conversationId: CONV_ID }, ctx() as never)

    vi.advanceTimersByTime(14_999)
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('loading')
    vi.advanceTimersByTime(1)
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('error')
    expect(useConnectionStore.getState().transcriptViewer.error).toMatch(/timed out/i)
    vi.useRealTimers()
  })

  it('history_replay_end clears the timer — no late error can fire after success', async () => {
    vi.useFakeTimers()
    const { useConnectionStore, handleMessage } = await startFetch()
    handleMessage({ type: 'history_replay_start', sessionId: CONV_ID, conversationId: CONV_ID }, ctx() as never)
    handleMessage({ type: 'history_replay_end', sessionId: CONV_ID }, ctx() as never)
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('ready')

    vi.advanceTimersByTime(120_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('ready')
    vi.useRealTimers()
  })

  it('closing the viewer clears the timer — no error fires for a viewer the user already closed', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await startFetch()

    useConnectionStore.getState().closeTranscriptViewer()
    vi.advanceTimersByTime(120_000)

    // No leaked timer (#6933) and no error state resurrected behind the user.
    expect(vi.getTimerCount()).toBe(0)
    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.status).toBe('idle')
    expect(viewer.error).toBeNull()
    vi.useRealTimers()
  })

  it('a failed send leaves no armed timer', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      socket: null,
      transcriptViewer: { conversationId: null, status: 'idle', messages: [], error: null },
    } as never)

    useConnectionStore.getState().requestConversationTranscript(CONV_ID)
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
