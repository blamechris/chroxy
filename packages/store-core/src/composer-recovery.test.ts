import { describe, expect, it, vi } from 'vitest'
import { recoverRejectedComposer } from './composer-recovery'
import type { InputDeliveryRecord } from './input-delivery'

function delivery(overrides: Partial<InputDeliveryRecord>): InputDeliveryRecord {
  return {
    clientMessageId: 'm1', sessionId: 's1', status: 'uncertain', delivery: 'unknown',
    retrySafe: false, pendingContextItemIds: [], updatedAt: 1, ...overrides,
  }
}

describe('recoverRejectedComposer', () => {
  it('restores only definitive retry-safe non-dispatch to the unchanged origin', () => {
    const restore = vi.fn()
    const snapshot = { text: 'first prompt' }
    expect(recoverRejectedComposer(delivery({
      status: 'rejected', delivery: 'not_dispatched', retrySafe: true,
    }), snapshot, {
      originalSessionActive: true, composerUnchanged: true, restore,
    })).toBe('restored')
    expect(restore).toHaveBeenCalledWith(snapshot)
  })

  it('offers recovery instead of overwriting a newer draft or another tab', () => {
    const rejected = delivery({ status: 'rejected', delivery: 'not_dispatched', retrySafe: true })
    const restore = vi.fn()
    expect(recoverRejectedComposer(rejected, 'draft', {
      originalSessionActive: true, composerUnchanged: false, restore,
    })).toBe('offer')
    expect(recoverRejectedComposer(rejected, 'draft', {
      originalSessionActive: false, composerUnchanged: true, restore,
    })).toBe('offer')
    expect(restore).not.toHaveBeenCalled()
  })

  it('never restores accepted, uncertain, or unsafe acknowledgements', () => {
    const restore = vi.fn()
    for (const record of [
      delivery({ status: 'accepted', delivery: 'dispatch_started' }),
      delivery({ status: 'uncertain', delivery: 'unknown' }),
      delivery({ status: 'rejected', delivery: 'not_dispatched', retrySafe: false }),
    ]) {
      expect(recoverRejectedComposer(record, 'draft', {
        originalSessionActive: true, composerUnchanged: true, restore,
      })).toBe('ignored')
    }
    expect(restore).not.toHaveBeenCalled()
  })
})
