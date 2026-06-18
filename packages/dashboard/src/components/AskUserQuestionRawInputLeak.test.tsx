/**
 * #5770 — AskUserQuestion raw tool_input must never leak into the chat.
 *
 * Per #4667 the only render path for an AskUserQuestion is the structured
 * QuestionPrompt card (driven by the parallel `user_question` event). The raw
 * `tool_input` JSON — which on the claude-tui provider arrives as a stream of
 * `tool_input_delta` chunks accumulating into `toolInputPartial` — must NOT be
 * surfaced as a chat bubble.
 *
 * `ToolBubble` already suppresses this (its `SUPPRESS_RAW_INPUT_TOOLS` gate),
 * but the SECOND render path — `ToolGroup`, used whenever a contiguous run of
 * 2+ tools is collapsed — rendered the partial accumulator verbatim in its
 * expanded detail panel with no suppression check. On claude-tui an
 * AskUserQuestion call sitting alongside another tool in the same turn took the
 * ToolGroup path, so the raw `{"questions":[...` JSON leaked next to the proper
 * card.
 *
 * These tests drive the PRODUCTION wire path: `handleToolStart` +
 * `handleToolInputDelta` build the store messages, `buildChatViewMessages`
 * groups them, and the renderer is exercised exactly as the dashboard does.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ChatMessage } from '@chroxy/store-core'
import {
  handleToolStart,
  handleToolInputDelta,
  buildChatViewMessages,
} from '@chroxy/store-core'
import { ToolGroup } from './ToolGroup'

afterEach(cleanup)

const SESSION = 'sess-1'

// Build the store messages exactly as the dashboard would after receiving a
// claude-tui-style tool_start + a stream of tool_input_delta chunks for an
// AskUserQuestion, plus a sibling tool so the run collapses into a ToolGroup.
function buildLeakScenario(): ChatMessage[] {
  // A preceding completed tool so the contiguous run is 2+ (forces ToolGroup,
  // not the singleton ToolBubble path).
  const sibling = handleToolStart(
    { sessionId: SESSION, tool: 'Read', toolUseId: 'tu-read', messageId: 'm-read', input: { file_path: '/etc/hosts' } },
    SESSION,
    false,
    [],
  )
  // The AskUserQuestion tool_start — claude-tui streams the input rather than
  // delivering it inline, so there is no `input` field on the start frame.
  const ask = handleToolStart(
    { sessionId: SESSION, tool: 'AskUserQuestion', toolUseId: 'tu-ask', messageId: 'm-ask' },
    SESSION,
    false,
    [],
  )

  let messages: ChatMessage[] = []
  // handleToolStart carries the tool name on the ChatMessage but populates
  // `toolInput` later (via tool_result / final input); attach the sibling's
  // structured input so the regression test can assert it still renders.
  if (sibling.chatMessage) messages.push({ ...sibling.chatMessage, toolInput: { file_path: '/etc/hosts' } })
  if (ask.chatMessage) messages.push(ask.chatMessage)

  // Stream the raw tool_input JSON in chunks, exactly like the wire deltas.
  const chunks = [
    '{"questions":[{"question":"Pick a deploy target",',
    '"header":"Deploy","options":[{"label":"staging"},',
    '{"label":"production"}]}]}',
  ]
  for (const partialJson of chunks) {
    const delta = handleToolInputDelta(
      { sessionId: SESSION, toolUseId: 'tu-ask', partialJson },
      SESSION,
    )
    if (delta) messages = delta.applyTo(messages)
  }
  return messages
}

describe('#5770 AskUserQuestion raw tool_input leak', () => {
  it('the wire path accumulates the raw JSON into toolInputPartial (sanity)', () => {
    const messages = buildLeakScenario()
    const ask = messages.find((m) => m.toolUseId === 'tu-ask')!
    expect(ask.tool).toBe('AskUserQuestion')
    // The accumulator holds the full raw JSON — this is what must NOT reach the UI.
    expect(ask.toolInputPartial).toContain('"questions"')
    expect(ask.toolInputPartial).toContain('Pick a deploy target')
  })

  it('groups the AskUserQuestion + sibling into a tool_group (the leaking path)', () => {
    const messages = buildLeakScenario()
    const { chatMessages, chatToolGroupPayloads } = buildChatViewMessages(messages, null)
    const group = chatMessages.find((m) => m.type === 'tool_group')
    expect(group).toBeDefined()
    const payload = chatToolGroupPayloads.get(group!.id)!
    expect(payload.messages.some((m) => m.tool === 'AskUserQuestion')).toBe(true)
  })

  it('does NOT render the raw AskUserQuestion tool_input JSON in the expanded ToolGroup', () => {
    const messages = buildLeakScenario()
    const { chatToolGroupPayloads, chatMessages } = buildChatViewMessages(messages, null)
    const group = chatMessages.find((m) => m.type === 'tool_group')!
    const payload = chatToolGroupPayloads.get(group.id)!

    render(<ToolGroup messages={payload.messages} isActive={true} />)
    // Active groups start expanded — the AskUserQuestion entry's detail panel
    // is visible. Expand the entry too (its detail panel is per-entry).
    fireEvent.click(screen.getByTestId('tool-group-entry-row-m-ask'))

    // The raw question JSON must NOT appear anywhere in the rendered group.
    expect(screen.queryByText(/Pick a deploy target/)).not.toBeInTheDocument()
    expect(screen.queryByText(/"questions"/)).not.toBeInTheDocument()
    // The sibling tool's real input is unaffected.
    expect(screen.getByTestId('tool-group-entry-m-read')).toHaveTextContent('/etc/hosts')
  })
})
