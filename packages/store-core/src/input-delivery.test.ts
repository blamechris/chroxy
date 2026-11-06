import { describe, expect, it, vi } from 'vitest'
import { InputSchema } from '@chroxy/protocol/schemas'
import {
  applyInputAcknowledgement,
  beginInputDelivery,
  cancelInputDelivery,
  isRetrySafeNotDispatched,
  rejectInputDeliveryForConflict,
} from './input-delivery'
import { recoverRejectedComposer } from './composer-recovery'
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
  it('tracks ordinary sends and retains retry safety only from the correlated ack', () => {
    const started = beginInputDelivery({}, 'user-plain', undefined, 10, 's1')
    expect(started['user-plain']).toMatchObject({
      status: 'uncertain', retrySafe: false, pendingContextItemIds: [],
    })

    const rejected = applyInputAcknowledgement(started, {
      type: 'input_ack', sessionId: 's1', clientMessageId: 'user-plain',
      status: 'rejected', delivery: 'not_dispatched', retrySafe: true,
      dedupScope: 'process', reason: 'not_runnable',
    })
    expect(rejected['user-plain']).toMatchObject({
      status: 'rejected', delivery: 'not_dispatched', retrySafe: true,
    })
    expect(isRetrySafeNotDispatched(rejected['user-plain'])).toBe(true)
    expect(isRetrySafeNotDispatched(started['user-plain'])).toBe(false)
  })

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

describe('rejectInputDeliveryForConflict (#9035)', () => {
  const sent = () => beginInputDelivery({}, 'user-1', undefined, 10, 's1')

  it('resolves an unresolved send to a retry-safe not-dispatched rejection', () => {
    const next = rejectInputDeliveryForConflict(sent(), 'user-1', 'busy', 20)
    expect(isRetrySafeNotDispatched(next['user-1'])).toBe(true)
    expect(next['user-1']).toMatchObject({ reason: 'input_conflict', message: 'busy', sessionId: 's1', updatedAt: 20 })
  })

  it('does nothing without a matching record or id', () => {
    const before = sent()
    expect(rejectInputDeliveryForConflict(before, 'user-other')).toBe(before)
    expect(rejectInputDeliveryForConflict(before, null)).toBe(before)
    expect(rejectInputDeliveryForConflict(undefined, 'user-1')).toEqual({})
  })

  it('never downgrades an input the server already resolved', () => {
    const accepted = applyInputAcknowledgement(sent(), {
      type: 'input_ack', sessionId: 's1', clientMessageId: 'user-1',
      status: 'accepted', delivery: 'dispatch_started', retrySafe: false, dedupScope: 'process',
    })
    expect(rejectInputDeliveryForConflict(accepted, 'user-1')).toBe(accepted)
  })

  it('feeds composer recovery: restores into an empty composer, offers when text was typed since', () => {
    const delivery = rejectInputDeliveryForConflict(sent(), 'user-1')['user-1']
    const restore = vi.fn(() => true)
    expect(recoverRejectedComposer(delivery, 'refused text', {
      originalSessionActive: true, composerUnchanged: true, restore,
    })).toBe('restored')
    expect(restore).toHaveBeenCalledWith('refused text')

    const noOverwrite = vi.fn(() => true)
    expect(recoverRejectedComposer(delivery, 'refused text', {
      originalSessionActive: true, composerUnchanged: false, restore: noOverwrite,
    })).toBe('offer')
    expect(recoverRejectedComposer(delivery, 'refused text', {
      originalSessionActive: false, composerUnchanged: true, restore: noOverwrite,
    })).toBe('offer')
    expect(noOverwrite).not.toHaveBeenCalled()
  })

  it('an unmatched refusal leaves nothing to recover', () => {
    const record = rejectInputDeliveryForConflict(sent(), 'user-other')['user-1']
    const restore = vi.fn(() => true)
    expect(recoverRejectedComposer(record, 'x', { originalSessionActive: true, composerUnchanged: true, restore })).toBe('ignored')
    expect(restore).not.toHaveBeenCalled()
  })
})
