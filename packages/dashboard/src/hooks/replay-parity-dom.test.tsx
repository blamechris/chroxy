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
import { render, renderHook, cleanup } from '@testing-library/react'
import {
  buildChatViewMessages,
  REPLAY_PARITY_FIXTURES,
  REPLAY_PARITY_DIVERGENCES,
  REPLAY_PARITY_SESSION_ID as SID,
  type ChatMessage,
  type ReplayParityFrame,
} from '@chroxy/store-core'
import { useMessageRenderer, type UseMessageRendererArgs } from './useMessageRenderer'
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
})
