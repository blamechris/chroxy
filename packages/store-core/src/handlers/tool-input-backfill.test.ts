/**
 * #8415 -- `handleToolInputBackfill`: fills the input of a held tool card, and does
 * nothing else. It must never build a message, start a tool or overwrite an input.
 */
import { describe, it, expect } from 'vitest'
import { handleToolInputBackfill } from './stream'
import type { ChatMessage } from '../types'

const card = (over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: 'tool-1', type: 'tool_use', tool: 'Bash', content: 'Bash', timestamp: 1, ...over }) as ChatMessage
const frame = (over: Record<string, unknown> = {}) =>
  ({ type: 'tool_input_backfill', sessionId: 's1', messageId: 'tool-1', input: { command: 'ls' }, ...over })

describe('handleToolInputBackfill', () => {
  it('gives a held card without input its toolInput and content, and nothing else', () => {
    const other = card({ id: 'tool-2' })
    const out = handleToolInputBackfill(frame(), { messages: [card(), other], streamingMessageId: null })
    expect(Object.keys(out)).toEqual(['messages'])
    expect(out.messages).toHaveLength(2)
    expect(out.messages![0]).toMatchObject({ toolInput: { command: 'ls' }, content: '{"command":"ls"}' })
    expect(out.messages![1]).toBe(other)
  })

  it('keeps content that is not the placeholder', () => {
    const out = handleToolInputBackfill(frame(), { messages: [card({ content: 'custom' })] })
    expect(out.messages![0]).toMatchObject({ toolInput: { command: 'ls' }, content: 'custom' })
  })

  it('never overwrites an input the card already holds', () => {
    const held = card({ toolInput: { command: 'pwd' }, content: '{"command":"pwd"}' })
    expect(handleToolInputBackfill(frame(), { messages: [held] })).toEqual({})
  })

  it('builds no card for a message the client does not hold', () => {
    expect(handleToolInputBackfill(frame({ messageId: 'gone' }), { messages: [card()] })).toEqual({})
    expect(handleToolInputBackfill(frame(), { messages: [] })).toEqual({})
  })

  it('ignores a held message that is not a tool card', () => {
    expect(handleToolInputBackfill(frame(), { messages: [card({ type: 'response' })] })).toEqual({})
  })

  it('ignores a malformed frame', () => {
    const s = { messages: [card()] }
    for (const input of [null, [1], 'ls', undefined]) expect(handleToolInputBackfill(frame({ input }), s)).toEqual({})
    for (const messageId of ['', 5, undefined]) expect(handleToolInputBackfill(frame({ messageId }), s)).toEqual({})
  })
})
