/**
 * Tests for stream ID collision resolution utility (#2546)
 */
import { describe, it, expect } from 'vitest'
import { resolveStreamId } from './stream-id'

describe('resolveStreamId', () => {
  it('returns original ID when no existing message', () => {
    const result = resolveStreamId(undefined, 'msg-1')
    expect(result.resolvedId).toBe('msg-1')
    expect(result.remap).toBeUndefined()
  })

  it('returns original ID when existing message is response type', () => {
    const result = resolveStreamId({ type: 'response' }, 'msg-2')
    expect(result.resolvedId).toBe('msg-2')
    expect(result.remap).toBeUndefined()
  })

  it('returns suffixed ID and remap when existing message is tool_use', () => {
    const result = resolveStreamId({ type: 'tool_use' }, 'msg-3')
    expect(result.resolvedId).toBe('msg-3-response')
    expect(result.remap).toEqual({ from: 'msg-3', to: 'msg-3-response' })
  })

  it('returns suffixed ID and remap when existing message is thinking', () => {
    const result = resolveStreamId({ type: 'thinking' }, 'msg-4')
    expect(result.resolvedId).toBe('msg-4-response')
    expect(result.remap).toEqual({ from: 'msg-4', to: 'msg-4-response' })
  })

  it('returns suffixed ID and remap when existing message is error', () => {
    const result = resolveStreamId({ type: 'error' }, 'msg-5')
    expect(result.resolvedId).toBe('msg-5-response')
    expect(result.remap).toEqual({ from: 'msg-5', to: 'msg-5-response' })
  })

  it('returns suffixed ID and remap for arbitrary non-response type', () => {
    const result = resolveStreamId({ type: 'system' }, 'msg-6')
    expect(result.resolvedId).toBe('msg-6-response')
    expect(result.remap).toEqual({ from: 'msg-6', to: 'msg-6-response' })
  })

  it('handles message with undefined type as non-response', () => {
    const result = resolveStreamId({}, 'msg-7')
    expect(result.resolvedId).toBe('msg-7-response')
    expect(result.remap).toEqual({ from: 'msg-7', to: 'msg-7-response' })
  })
})
