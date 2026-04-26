import { describe, it, expect } from 'vitest'
import { formatTranscript } from './transcript'
import type { ChatMessage } from '../store/types'

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm',
    type: 'response',
    content: '',
    timestamp: 0,
    ...partial,
  } as ChatMessage
}

describe('formatTranscript (#3073)', () => {
  it('renders user / assistant turns with [You] / [Claude] markers', () => {
    const out = formatTranscript([
      msg({ id: '1', type: 'user_input', content: 'hello' }),
      msg({ id: '2', type: 'response', content: 'hi there' }),
    ])
    expect(out).toBe('[You] hello\n\n[Claude] hi there')
  })

  it('skips system and thinking events', () => {
    const out = formatTranscript([
      msg({ id: '1', type: 'system', content: 'connected' }),
      msg({ id: '2', type: 'user_input', content: 'q' }),
      msg({ id: '3', type: 'thinking', content: 'thinking…' }),
      msg({ id: '4', type: 'response', content: 'a' }),
    ])
    expect(out).toBe('[You] q\n\n[Claude] a')
  })

  it('summarizes tool_use with input and previewed result', () => {
    const out = formatTranscript([
      msg({
        id: '1',
        type: 'tool_use',
        tool: 'Bash',
        toolInput: { command: 'ls -la' },
        toolResult: 'total 0\n.\n..',
      }),
    ])
    expect(out).toContain('[Tool: Bash] {"command":"ls -la"}')
    expect(out).toContain('[Tool result] total 0\n.\n..')
  })

  it('truncates long tool results and marks them', () => {
    const long = 'x'.repeat(500)
    const out = formatTranscript(
      [msg({ id: '1', type: 'tool_use', tool: 'Read', toolResult: long })],
      { toolResultPreviewChars: 100 },
    )
    expect(out).toMatch(/\(truncated\)/)
    // The preview itself fits in 100 chars + ellipsis
    const previewLine = out.split('\n').find((l) => l.startsWith('[Tool result]'))!
    expect(previewLine.length).toBeLessThan(140)
  })

  it('honors the toolResultTruncated flag from the server even when content fits', () => {
    const out = formatTranscript([
      msg({
        id: '1',
        type: 'tool_use',
        tool: 'Read',
        toolResult: 'short',
        toolResultTruncated: true,
      }),
    ])
    expect(out).toMatch(/\(truncated\)/)
  })

  it('renders permission prompts with the answered decision', () => {
    const out = formatTranscript([
      msg({ id: '1', type: 'prompt', tool: 'Edit', answered: 'allow', requestId: 'r1' }),
      msg({ id: '2', type: 'prompt', tool: 'Bash', requestId: 'r2' }), // no decision
    ])
    expect(out).toContain('[Permission: Edit] → allow')
    expect(out).toContain('[Permission: Bash] (no response)')
  })

  it('drops empty assistant responses (e.g., a stream that ended before any text)', () => {
    const out = formatTranscript([
      msg({ id: '1', type: 'user_input', content: 'q' }),
      msg({ id: '2', type: 'response', content: '   ' }),
      msg({ id: '3', type: 'response', content: 'real reply' }),
    ])
    expect(out).toBe('[You] q\n\n[Claude] real reply')
  })

  it('markdown variant code-fences tool inputs and results', () => {
    const out = formatTranscript(
      [msg({
        id: '1',
        type: 'tool_use',
        tool: 'Bash',
        toolInput: { command: 'ls' },
        toolResult: 'a\nb',
      })],
      { markdown: true },
    )
    expect(out).toContain('```json\n{"command":"ls"}\n```')
    expect(out).toContain('[Tool result]\n```\na\nb\n```')
  })

  it('renders error messages with [Error] marker', () => {
    const out = formatTranscript([msg({ id: '1', type: 'error', content: 'boom' })])
    expect(out).toBe('[Error] boom')
  })

  it('returns empty string for empty input or all-system input', () => {
    expect(formatTranscript([])).toBe('')
    expect(formatTranscript([msg({ id: '1', type: 'system', content: 'x' })])).toBe('')
  })
})
