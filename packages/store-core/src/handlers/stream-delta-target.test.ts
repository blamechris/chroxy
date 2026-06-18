/**
 * Tests for `resolveStreamDeltaTarget` (#6036) — the pure target/reuse decision
 * extracted from `sharedStreamDelta`. Each case asserts the verdict equals
 * exactly what the previous inline branch computed for the same inputs.
 */
import { describe, it, expect } from 'vitest'
import { resolveStreamDeltaTarget } from './stream'
import type { ChatMessage } from '../types'

const NOW = 1_700_000_000_000

function resolverState(opts: {
  postPermissionSplits?: string[]
  deltaIdRemaps?: [string, string][]
  resolvedMessages?: ChatMessage[]
  targetForSuffix?: string | null
}) {
  return {
    postPermissionSplits: new Set(opts.postPermissionSplits ?? []),
    deltaIdRemaps: new Map(opts.deltaIdRemaps ?? []),
    resolveMessages: () => ({
      resolvedMessages: opts.resolvedMessages ?? [],
      targetForSuffix: opts.targetForSuffix ?? null,
    }),
  }
}

function msg(id: string, type: ChatMessage['type']): ChatMessage {
  return { id, type, content: '', timestamp: 0 }
}

describe('resolveStreamDeltaTarget', () => {
  it('passes through when the id is unknown to every collection', () => {
    const target = resolveStreamDeltaTarget('msg-1', resolverState({}), NOW)
    expect(target).toEqual({ kind: 'passthrough', deltaId: 'msg-1' })
  })

  it('passes through when the id already points at a response slot', () => {
    const target = resolveStreamDeltaTarget(
      'msg-2',
      resolverState({ resolvedMessages: [msg('msg-2', 'response')] }),
      NOW,
    )
    expect(target).toEqual({ kind: 'passthrough', deltaId: 'msg-2' })
  })

  it('creates a post-permission split bubble (new id = <id>-post-<now>)', () => {
    const target = resolveStreamDeltaTarget(
      'msg-3',
      resolverState({ postPermissionSplits: ['msg-3'] }),
      NOW,
    )
    expect(target).toEqual({
      kind: 'permission-split',
      deltaId: 'msg-3',
      newId: `msg-3-post-${NOW}`,
    })
  })

  it('prefers the permission split over an existing remap for the same id', () => {
    const target = resolveStreamDeltaTarget(
      'msg-4',
      resolverState({
        postPermissionSplits: ['msg-4'],
        deltaIdRemaps: [['msg-4', 'msg-4-other']],
      }),
      NOW,
    )
    expect(target).toEqual({
      kind: 'permission-split',
      deltaId: 'msg-4',
      newId: `msg-4-post-${NOW}`,
    })
  })

  it('follows a single-hop remap when one exists', () => {
    const target = resolveStreamDeltaTarget(
      'msg-5',
      resolverState({ deltaIdRemaps: [['msg-5', 'msg-5-cont-999']] }),
      NOW,
    )
    expect(target).toEqual({ kind: 'remap', deltaId: 'msg-5-cont-999' })
  })

  it('suffixes onto a fresh -response bubble when the id is a tool_use slot', () => {
    const target = resolveStreamDeltaTarget(
      'msg-6',
      resolverState({
        resolvedMessages: [msg('msg-6', 'tool_use')],
        targetForSuffix: 'sess-1',
      }),
      NOW,
    )
    expect(target).toEqual({
      kind: 'suffix',
      deltaId: 'msg-6-response',
      remapKey: 'msg-6',
      suffixedId: 'msg-6-response',
      targetForSuffix: 'sess-1',
      needsAppend: true,
    })
  })

  it('suffix verdict sets needsAppend=false when the -response bubble already exists', () => {
    const target = resolveStreamDeltaTarget(
      'msg-7',
      resolverState({
        resolvedMessages: [msg('msg-7', 'tool_use'), msg('msg-7-response', 'response')],
        targetForSuffix: null,
      }),
      NOW,
    )
    expect(target).toEqual({
      kind: 'suffix',
      deltaId: 'msg-7-response',
      remapKey: 'msg-7',
      suffixedId: 'msg-7-response',
      targetForSuffix: null,
      needsAppend: false,
    })
  })

  it('does NOT suffix a thinking/error slot away from response — only non-response slots route', () => {
    // Mirrors the inline guard `existing && existing.type !== 'response'`: a
    // tool_use is the reused-id case, but a non-response slot of any other type
    // also suffixes. A response slot passes through (covered above); an absent
    // slot passes through too.
    const thinking = resolveStreamDeltaTarget(
      'msg-8',
      resolverState({ resolvedMessages: [msg('msg-8', 'thinking')] }),
      NOW,
    )
    expect(thinking.kind).toBe('suffix')
  })
})
