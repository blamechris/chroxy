/**
 * #6630 -- the DOM a user sees, live vs rebuilt from history.
 *
 * `store/replay-parity.test.ts` proves the two transcripts hold the same MESSAGES.
 * This renders both through the real chat pipeline (buildChatViewMessages ->
 * ChatView + useMessageRenderer, the same wiring App.tsx uses) and compares the
 * HTML, because the model can match while the rendering does not: a live
 * permission prompt the user answered used to fall through the renderer's branch
 * ladder to the default row, an assistant-styled bubble reading "Bash: rm -rf
 * build", while the replayed record rendered as "Permission allowed -- Bash: ...".
 *
 * Scenarios the model-level suite pins as divergent are skipped here, except the
 * two answered-permission ones, where the model differs by design but the line
 * the user reads must not.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, renderHook, cleanup, fireEvent, within } from '@testing-library/react'
import {
  buildChatViewMessages,
  REPLAY_PARITY_FIXTURES,
  REPLAY_PARITY_DIVERGENCES,
  REPLAY_PARITY_SESSION_ID as SID,
  type ChatMessage,
  type ReplayParityFrame,
} from '@chroxy/store-core'
import { useMessageRenderer, type UseMessageRendererArgs } from './useMessageRenderer'
import { useChatMessages } from './useChatMessages'
import { ChatView, type ChatViewMessage } from '../components/ChatView'
import { useConnectionStore } from '../store/connection'
import { _testMessageHandler, clearDeltaBuffers, resetReplayFlags } from '../store/message-handler'
import { createEmptySessionState } from '../store/utils'

function reset() {
  clearDeltaBuffers()
  resetReplayFlags()
  useConnectionStore.setState({
    activeSessionId: SID,
    sessionStates: { [SID]: createEmptySessionState() },
    socket: null,
  })
  _testMessageHandler.setContext({
    url: 'ws://x', token: 't', isReconnect: false, silent: false,
    socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
  })
}

const send = (frame: ReplayParityFrame) => _testMessageHandler.handle({ ...frame })
const messages = () => useConnectionStore.getState().sessionStates[SID]!.messages

function live(frames: ReplayParityFrame[]): ChatMessage[] {
  reset()
  for (const f of frames) send(f)
  vi.runAllTimers()
  return messages()
}

function replayed(frames: ReplayParityFrame[]): ChatMessage[] {
  reset()
  const latestSeq = frames.reduce((max, f) => Math.max(max, typeof f.historySeq === 'number' ? f.historySeq : 0), 0)
  send({ type: 'history_replay_start', sessionId: SID, fullHistory: true, truncated: false, latestSeq })
  for (const f of frames) send(f)
  send({ type: 'history_replay_end', sessionId: SID, latestSeq })
  vi.runAllTimers()
  return messages()
}

/** Render a transcript the way App.tsx does and return comparable HTML. */
function dom(storeMessages: ChatMessage[]): string {
  const built = buildChatViewMessages(storeMessages, null)
  const args = {
    storeMsgMap: built.storeMsgMap,
    chatToolGroupPayloads: built.chatToolGroupPayloads,
    permissionExpiredSummaries: new Map(),
    chatTailMessageId: built.chatTailMessageId,
    sendPermissionResponse: vi.fn(),
    sendUserQuestionResponse: vi.fn(),
    markPromptAnswered: vi.fn(),
    storeMessages,
    sendInput: vi.fn(),
    streamStallTimeoutMs: null,
    allowMultiQuestionForm: false,
    activeSessionProvider: null,
    activeSessionCaps: null,
    setViewMode: vi.fn(),
    stalledPromptIds: built.stalledPromptIds,
    hasPendingAskUserQuestionPermission: false,
    sessions: [],
  } as unknown as UseMessageRendererArgs
  const { result } = renderHook(() => useMessageRenderer(args))
  const { container } = render(
    <ChatView messages={built.chatMessages as ChatViewMessage[]} isStreaming={false} renderMessage={result.current} />,
  )
  const html = container.innerHTML
  cleanup()
  return html
    // generated ids carry a counter and the wall clock
    .replace(/(data-testid="msg-|data-row-key=")[^"]*"/g, '$1#"')
    .replace(/perm-desc-[^"]*"/g, 'perm-desc-#"')
    // each side stamps its own clock on the row
    .replace(/<span class="msg-timestamp">[^<]*<\/span>/g, '')
    .replace(/\s+/g, ' ')
}

describe('live vs replayed transcript -- rendered DOM (dashboard, #6630)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  // `system` rows are filtered out of the chat view (they render on the System
  // tab), so a scenario made only of them has an empty chat DOM on both sides.
  // Its model parity is asserted in store/replay-parity.test.ts.
  const SYSTEM_TAB_ONLY = new Set(['system-markers'])

  const comparable = REPLAY_PARITY_FIXTURES.filter(
    (fx) =>
      !SYSTEM_TAB_ONLY.has(fx.name) &&
      (!REPLAY_PARITY_DIVERGENCES[fx.name] || fx.name === 'permission-allowed' || fx.name === 'permission-denied'),
  )

  it('compares a real set of scenarios', () => {
    expect(comparable.length).toBeGreaterThanOrEqual(7)
  })

  for (const fx of comparable) {
    it(`${fx.name}: the same HTML live and rebuilt`, () => {
      const liveHtml = dom(live(fx.live))
      const replayHtml = dom(replayed(fx.replay))
      // Two empty renders are equal for the wrong reason.
      expect(liveHtml, `${fx.name}: nothing rendered live`).toContain('chat-messages')
      expect(liveHtml.length, `${fx.name}: live DOM is just the empty chat frame`).toBeGreaterThan(400)
      expect(replayHtml).toBe(liveHtml)
    })
  }

  it('an answered permission prompt renders as the compact record, not an assistant bubble', () => {
    const fx = REPLAY_PARITY_FIXTURES.find((f) => f.name === 'permission-allowed')!
    const html = dom(live(fx.live))
    expect(html).toContain('data-testid="perm-outcome-record"')
    expect(html).toContain('Permission allowed')
    expect(html).not.toContain('class="msg assistant"')
  })

  it('a reasoning block with no text still shows its "thought for Xs" toggle after a rebuild', () => {
    const fx = REPLAY_PARITY_FIXTURES.find((f) => f.name === 'thinking-without-text')!
    for (const html of [dom(live(fx.live)), dom(replayed(fx.replay))]) {
      expect(html).toContain('data-testid="thinking-toggle"')
      expect(html).toContain('thought for 1.0s')
    }
  })

  it('the token count in the thinking footer survives a rebuild', () => {
    const fx = REPLAY_PARITY_FIXTURES.find((f) => f.name === 'thinking-then-reply')!
    for (const html of [dom(live(fx.live)), dom(replayed(fx.replay))]) {
      expect(html).toContain('thought for 1.2s · 128 tokens')
    }
  })

  // #7326 -- the point of the whole change: a turn that was cut off, refused or
  // stopped is VISIBLY not a finished one, live and after a rebuild from history.
  // Asserted on the rendered chip, not on a field, so removing the server-side
  // mapping (no `turnOutcome` on the frame) or the client-side marker turns this
  // red rather than leaving a green transcript that looks complete.
  it('a truncated, a refused and a stopped turn each render a labelled chip; a completed one renders none (#7326)', () => {
    const fx = REPLAY_PARITY_FIXTURES.find((f) => f.name === 'turn-outcomes')!
    for (const html of [dom(live(fx.live)), dom(replayed(fx.replay))]) {
      const chips = [...html.matchAll(/data-testid="turn-outcome-marker" data-outcome="(\w+)"/g)].map((m) => m[1])
      expect(chips).toEqual(['truncated', 'refused', 'stopped'])
      expect(html).toContain('Reply cut off')
      expect(html).toContain('The model declined')
      expect(html).toContain('>Stopped<')
      // The turn that finished normally is the last reply and has nothing after it.
      expect(html.indexOf('A normal, finished reply.')).toBeGreaterThan(html.lastIndexOf('data-outcome="stopped"'))
      expect(html.slice(html.indexOf('A normal, finished reply.'))).not.toContain('turn-outcome-marker')
    }
  })

  it('a refusal with no reply text still gets its chip (there is no bubble to hang it on) (#7326)', () => {
    const fx = REPLAY_PARITY_FIXTURES.find((f) => f.name === 'turn-outcomes')!
    const refusal = fx.live.find((f) => f.type === 'result' && f.turnOutcome === 'refused')!
    const html = dom(live([refusal]))
    expect(html).toContain('data-outcome="refused"')
  })
})

/**
 * #8503 -- a resolved permission GROUP, live vs rebuilt from history.
 *
 * `dom()` above renders through `buildChatViewMessages` and so never builds the
 * synthetic `permission-group` rows; this renders through `useChatMessages`, the
 * pipeline App.tsx uses, which does. Both sides drive the REAL message handler with
 * the frames the server sends: live, the `permission_request` / `permission_resolved`
 * pair beside the tool run it gated; rebuilt, the `permission_outcome` history entry
 * (carrying the journaled input) beside the replayed `tool_start`.
 *
 * What is compared is the HTML a user reads: the collapsed ×N line with its input
 * and safety-flag lines, the expanded group, and an expanded member's detail.
 */
describe('live vs replayed permission group -- rendered DOM incl. the input line and safety flags (#8503)', () => {
  const INPUT = {
    command: 'touch smoke-perm.txt',
    description: 'Touch smoke file',
    dangerouslyDisableSandbox: true,
    run_in_background: true,
  }
  const DESC = 'Touch smoke file'

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const liveFrames = (input: Record<string, unknown>): ReplayParityFrame[] =>
    [1, 2, 3].flatMap((n) => [
      { type: 'tool_start', messageId: `tu${n}`, toolUseId: `tu${n}`, tool: 'Bash', input: null, sessionId: SID },
      { type: 'tool_result', toolUseId: `tu${n}`, result: '', truncated: false, input, sessionId: SID },
      { type: 'permission_request', requestId: `req-${n}`, tool: 'Bash', description: DESC, input, remainingMs: 120000, sessionId: SID },
      { type: 'permission_resolved', requestId: `req-${n}`, decision: 'allow', sessionId: SID },
    ])
  /** `journaled`: whether the server's `permission_outcome` entries carry the input (false = an entry from before #8503). */
  const replayFrames = (input: Record<string, unknown>, journaled: boolean): ReplayParityFrame[] =>
    [1, 2, 3].flatMap((n) => [
      { type: 'tool_start', messageId: `tu${n}`, toolUseId: `tu${n}`, tool: 'Bash', input, timestamp: 1, sessionId: SID, historySeq: n * 3 - 2 },
      { type: 'tool_result', toolUseId: `tu${n}`, result: '', truncated: false, timestamp: 1, sessionId: SID, historySeq: n * 3 - 1 },
      {
        type: 'permission_outcome', requestId: `req-${n}`, tool: 'Bash', description: DESC, outcome: 'allowed',
        ...(journaled ? { input } : {}), timestamp: 1, sessionId: SID, historySeq: n * 3,
      },
    ])

  /** Render through the real App.tsx pipeline, with groups; `steps` clicks through it and the HTML after each is returned. */
  function domSteps(storeMessages: ChatMessage[], steps: Array<(c: HTMLElement) => void>): string[] {
    const { result: chat } = renderHook(() => useChatMessages({ storeMessages, streamingMessageId: null }))
    const args = {
      storeMsgMap: chat.current.storeMsgMap,
      chatToolGroupPayloads: chat.current.chatToolGroupPayloads,
      permissionExpiredSummaries: chat.current.permissionExpiredSummaries,
      permissionPromptGroups: chat.current.permissionPromptGroups,
      chatTailMessageId: chat.current.chatTailMessageId,
      sendPermissionResponse: vi.fn(),
      sendUserQuestionResponse: vi.fn(),
      markPromptAnswered: vi.fn(),
      storeMessages,
      sendInput: vi.fn(),
      streamStallTimeoutMs: null,
      allowMultiQuestionForm: false,
      activeSessionProvider: null,
      activeSessionCaps: null,
      setViewMode: vi.fn(),
      stalledPromptIds: chat.current.stalledPromptIds,
      hasPendingAskUserQuestionPermission: false,
      sessions: [],
    } as unknown as UseMessageRendererArgs
    const { result: renderer } = renderHook(() => useMessageRenderer(args))
    const { container } = render(
      <ChatView messages={chat.current.chatMessages} isStreaming={false} renderMessage={renderer.current} />,
    )
    const norm = (html: string) =>
      html
        .replace(/(data-testid="msg-|data-row-key=")[^"]*"/g, '$1#"')
        // every id/aria id derived from a generated message id or group id
        .replace(/\b(id|aria-controls)="[^"]*(?:perm|group)[^"]*"/g, '$1="#"')
        .replace(/<span class="msg-timestamp">[^<]*<\/span>/g, '')
        .replace(/\s+/g, ' ')
    const out = [norm(container.innerHTML)]
    for (const step of steps) {
      step(container)
      out.push(norm(container.innerHTML))
    }
    cleanup()
    return out
  }

  const clickGroup = (c: HTMLElement) => fireEvent.click(within(c).getByTestId('perm-group-toggle'))
  const clickMember = (c: HTMLElement) => fireEvent.click(within(c).getAllByTestId('perm-record-toggle')[1]!)

  it('the collapsed ×3 line, the expanded group and an expanded member read the same live and rebuilt, flags and input included', () => {
    const liveHtml = domSteps(live(liveFrames(INPUT)), [clickGroup, clickMember])
    const replayHtml = domSteps(replayed(replayFrames(INPUT, true)), [clickGroup, clickMember])
    // The live side really is the group, with the input and BOTH safety flags (a
    // comparison of two empty renders would pass for the wrong reason).
    const collapsed = liveHtml[0]!
    expect(collapsed).toContain('data-testid="perm-group"')
    expect(collapsed).toContain('×3')
    expect(collapsed).toContain('data-testid="perm-group-input"')
    expect(collapsed).toContain('touch smoke-perm.txt')
    expect(collapsed.match(/data-testid="perm-input-flag"/g)).toHaveLength(2)
    expect(collapsed).toContain('dangerouslyDisableSandbox: true')
    expect(collapsed).toContain('run_in_background: true')
    expect(liveHtml[2]!).toContain('data-testid="perm-record-input"')
    for (let i = 0; i < liveHtml.length; i++) expect(replayHtml[i], `step ${i}`).toBe(liveHtml[i])
  })

  it('a single approval (no group) expands to the same input and flags live and rebuilt', () => {
    const one = (frames: ReplayParityFrame[], per: number) => frames.slice(0, per)
    const clickRecord = (c: HTMLElement) => fireEvent.click(within(c).getByTestId('perm-record-toggle'))
    const liveHtml = domSteps(live(one(liveFrames(INPUT), 4)), [clickRecord])
    const replayHtml = domSteps(replayed(one(replayFrames(INPUT, true), 3)), [clickRecord])
    expect(liveHtml[1]!).toContain('data-testid="perm-record-input"')
    expect(liveHtml[1]!.match(/data-testid="perm-input-flag"/g)).toHaveLength(2)
    expect(replayHtml).toEqual(liveHtml)
  })

  it('an entry journaled before the field renders with NO input line and never groups: three records, no ×3', () => {
    const [collapsed, expanded] = domSteps(replayed(replayFrames(INPUT, false)), [
      (c) => fireEvent.click(within(c).getAllByTestId('perm-record-toggle')[0]!),
    ])
    expect(collapsed!).not.toContain('data-testid="perm-group"')
    expect(collapsed!.match(/data-testid="perm-outcome-record"/g)).toHaveLength(3)
    expect(collapsed!).not.toContain('perm-group-input')
    expect(collapsed!).toContain('Permission allowed')
    expect(expanded!).toContain('data-testid="perm-record-detail"')
    expect(expanded!).not.toContain('data-testid="perm-record-input"')
    expect(expanded!).not.toContain('perm-input-flag')
  })

  it('journaled inputs that differ do not group on replay either (same description, different command)', () => {
    const frames = replayFrames(INPUT, true).map((f) =>
      f.type === 'permission_outcome' && f.requestId === 'req-2' ? { ...f, input: { ...INPUT, command: 'rm -rf ~' } } : f,
    )
    const [html] = domSteps(replayed(frames), [])
    expect(html!).not.toContain('data-testid="perm-group"')
    expect(html!.match(/data-testid="perm-outcome-record"/g)).toHaveLength(3)
  })
})
