import { describe, expect, it, vi } from 'vitest'
import { recoverRejectedComposer, ComposerRecoveryQueue } from './composer-recovery'
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

it('retains an offer when the committed-render restore callback refuses', () => {
  const restore = vi.fn(() => false)
  expect(recoverRejectedComposer(delivery({ status: 'rejected', delivery: 'not_dispatched', retrySafe: true }), 'draft', {
    originalSessionActive: true, composerUnchanged: true, restore,
  })).toBe('offer')
  expect(restore).toHaveBeenCalledOnce()
})

describe('ComposerRecoveryQueue lifecycle', () => {
  const a = { clientMessageId: 'a', sessionId: 'origin', draft: 'draft A' }
  const b = { clientMessageId: 'b', sessionId: 'other', draft: 'draft B' }
  it('retains edited auto-restoration through pruning without duplicating an offer', () => {
    const queue = new ComposerRecoveryQueue<typeof a>()
    queue.retain(a, true)
    expect(queue.offer).toBeNull()
    expect(queue.hasWork).toBe(true)
    queue.updateRestored('origin', snapshot => ({ ...snapshot, draft: 'edited A' }))
    queue.prune(new Set(['other']))
    expect(queue.offer?.draft).toBe('edited A')
    queue.prune(new Set(['other']))
    queue.dismiss('a')
    expect(queue.offer).toBeNull()
    expect(queue.hasWork).toBe(false)
  })
  it('keeps multiple rejected drafts in FIFO order through restores and dismissals', () => {
    const queue = new ComposerRecoveryQueue<typeof a>()
    queue.retain(a)
    queue.retain(b)
    expect(queue.offer).toEqual(a)
    queue.retain(a, true)
    expect(queue.offer).toEqual(b)
    queue.releaseRestored('origin')
    expect(queue.offer).toEqual(b)
    queue.dismiss('b')
    expect(queue.hasWork).toBe(false)
  })
  it('releases an intentional clear without removing another outstanding offer', () => {
    const queue = new ComposerRecoveryQueue<typeof a>()
    queue.retain(a, true)
    queue.retain(b)
    queue.updateRestored('origin', () => null)
    queue.prune(new Set())
    expect(queue.offer).toEqual(b)
  })
})
