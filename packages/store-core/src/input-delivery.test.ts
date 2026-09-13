import { describe, expect, it } from 'vitest'
import { InputSchema } from '@chroxy/protocol/schemas'
import {
  applyInputAcknowledgement,
  beginInputDelivery,
  cancelInputDelivery,
} from './input-delivery'
import { buildInputMessage } from '@chroxy/protocol'

const context = {
  version: 1 as const,
  items: [{
    id: 'ocr-1',
    kind: 'text' as const,
    provenance: { source: 'ocr' as const, label: 'Selection' },
    mediaType: 'text/plain',
    sizeBytes: 5,
    lifetime: 'one_turn' as const,
    content: { type: 'text' as const, text: 'hello' },
  }],
}

describe('input delivery contract (#7822)', () => {
  it('serializes selected context through the protocol shape without inventing another id', () => {
    const message = buildInputMessage({
      input: 'compare',
      clientMessageId: 'user-1',
      sessionId: 's1',
      context,
    })
    expect(InputSchema.parse(message)).toEqual(message)
    expect(message.clientMessageId).toBe('user-1')
    expect(message.context).toBe(context)
  })

  it('keeps a sent context uncertain until the matching ack and clears one-turn ids on acceptance', () => {
    const started = beginInputDelivery({}, 'user-1', context, 10)
    expect(started['user-1']).toMatchObject({ status: 'uncertain', pendingContextItemIds: ['ocr-1'] })

    const late = applyInputAcknowledgement(started, {
      type: 'input_ack', sessionId: 's1', clientMessageId: 'user-1',
      status: 'accepted', delivery: 'dispatch_started', retrySafe: false,
      acceptedAt: 20, retentionExpiresAt: 620_000, dedupScope: 'process',
      context: { version: 1, acceptedItemIds: ['ocr-1'], supportedKinds: ['text', 'image'], supportedLifetimes: ['one_turn'] },
    })
    expect(late['user-1']).toMatchObject({ status: 'accepted', pendingContextItemIds: [] })
  })

  it('resolves replayed duplicate acks by request id and preserves unrelated pending context', () => {
    let state = beginInputDelivery({}, 'user-1', context, 10)
    state = beginInputDelivery(state, 'user-2', { ...context, items: [{ ...context.items[0], id: 'ocr-2' }] }, 11)
    const next = applyInputAcknowledgement(state, {
      type: 'input_ack', sessionId: 's1', clientMessageId: 'user-1',
      status: 'duplicate', delivery: 'dispatch_started', retrySafe: false,
      acceptedAt: 10, retentionExpiresAt: 620_000, dedupScope: 'process',
      context: { version: 1, acceptedItemIds: ['ocr-1'], supportedKinds: ['text', 'image'], supportedLifetimes: ['one_turn'] },
    })
    expect(next['user-1'].status).toBe('duplicate')
    expect(next['user-1'].pendingContextItemIds).toEqual([])
    expect(next['user-2'].pendingContextItemIds).toEqual(['ocr-2'])
    expect(cancelInputDelivery(next, 'user-2')['user-2']).toMatchObject({ status: 'cancelled', pendingContextItemIds: [] })
  })

  it('retains one-turn context when a replay is still uncertain', () => {
    const started = beginInputDelivery({}, 'user-1', context, 10)
    const next = applyInputAcknowledgement(started, {
      type: 'input_ack', sessionId: 's1', clientMessageId: 'user-1',
      status: 'uncertain', delivery: 'unknown', retrySafe: false,
      retentionExpiresAt: 620_000, dedupScope: 'process',
      reason: 'delivery_uncertain',
    })
    expect(next['user-1']).toMatchObject({
      status: 'uncertain', delivery: 'unknown', pendingContextItemIds: ['ocr-1'],
    })
  })

  it('retains context when the evaluator holds only the draft', () => {
    const started = beginInputDelivery({}, 'user-1', context, 10)
    const next = applyInputAcknowledgement(started, {
      type: 'input_ack', sessionId: 's1', clientMessageId: 'user-1',
      status: 'accepted', delivery: 'evaluation_held', retrySafe: false,
      acceptedAt: 20, retentionExpiresAt: 620_000, dedupScope: 'process',
      context: { version: 1, acceptedItemIds: ['ocr-1'], supportedKinds: ['text', 'image'], supportedLifetimes: ['one_turn'] },
    })
    expect(next['user-1']).toMatchObject({
      status: 'accepted', delivery: 'evaluation_held', pendingContextItemIds: ['ocr-1'],
    })
  })

  it('retains context through uncertain then rejected acknowledgements and clears only accepted ids', () => {
    const twoItems = {
      ...context,
      items: [context.items[0], { ...context.items[0], id: 'ocr-2' }],
    }
    let state = beginInputDelivery({}, 'user-1', twoItems, 10)
    state = applyInputAcknowledgement(state, {
      type: 'input_ack', sessionId: 's1', clientMessageId: 'user-1',
      status: 'uncertain', delivery: 'unknown', retrySafe: false,
      dedupScope: 'process', reason: 'admission_pending',
    })
    state = applyInputAcknowledgement(state, {
      type: 'input_ack', sessionId: 's1', clientMessageId: 'user-1',
      status: 'rejected', delivery: 'not_dispatched', retrySafe: true,
      dedupScope: 'process', reason: 'busy',
    })
    expect(state['user-1'].pendingContextItemIds).toEqual(['ocr-1', 'ocr-2'])

    const partial = applyInputAcknowledgement(state, {
      type: 'input_ack', sessionId: 's1', clientMessageId: 'user-1',
      status: 'accepted', delivery: 'dispatch_started', retrySafe: false,
      dedupScope: 'process',
      context: { version: 1, acceptedItemIds: ['ocr-1'], supportedKinds: ['text', 'image'], supportedLifetimes: ['one_turn'] },
    })
    expect(partial['user-1'].pendingContextItemIds).toEqual(['ocr-2'])
  })
})
