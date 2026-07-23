import { describe, it, expect, vi } from 'vitest'
import { runQueuedEdit, EDIT_QUEUED_BUSY_NOTICE, type EditQueuedEffects } from './edit-queued'

// Handler-level coverage for the #6628 "Edit a queued follow-up" decision logic
// (the review blocker: the naive handler clobbered a non-empty draft and could
// strand a queued entry). Each effect is a spy so we assert exactly which
// side-effects fire on each branch.
function makeEffects(overrides: Partial<EditQueuedEffects> = {}) {
  const fx = {
    getDraft: vi.fn(() => ''),
    cancelQueued: vi.fn(() => true),
    reopenComposer: vi.fn(),
    notify: vi.fn(),
    focusComposer: vi.fn(),
    ...overrides,
  }
  return fx
}

describe('runQueuedEdit (#6628)', () => {
  it('empty draft (happy path): cancels the queued entry and reopens its text', () => {
    const fx = makeEffects({ getDraft: vi.fn(() => '') })
    runQueuedEdit('cmid-1', 'draft body', fx)

    expect(fx.cancelQueued).toHaveBeenCalledWith('cmid-1')
    expect(fx.reopenComposer).toHaveBeenCalledWith('draft body')
    expect(fx.focusComposer).toHaveBeenCalledTimes(1)
    expect(fx.notify).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only draft as empty (still reopens)', () => {
    const fx = makeEffects({ getDraft: vi.fn(() => '   \n  ') })
    runQueuedEdit('cmid-1', 'draft body', fx)

    expect(fx.cancelQueued).toHaveBeenCalledTimes(1)
    expect(fx.reopenComposer).toHaveBeenCalledWith('draft body')
    expect(fx.notify).not.toHaveBeenCalled()
  })

  it('non-empty-draft guard: notifies and preserves BOTH the draft and the queued entry', () => {
    const fx = makeEffects({ getDraft: vi.fn(() => 'a second follow-up mid-type') })
    runQueuedEdit('cmid-1', 'draft body', fx)

    // Notice surfaced...
    expect(fx.notify).toHaveBeenCalledWith(EDIT_QUEUED_BUSY_NOTICE)
    // ...and nothing destructive happened: the queued entry is NOT cancelled
    // (not stranded) and the composer draft is NOT overwritten (not clobbered).
    expect(fx.cancelQueued).not.toHaveBeenCalled()
    expect(fx.reopenComposer).not.toHaveBeenCalled()
    expect(fx.focusComposer).not.toHaveBeenCalled()
  })

  it('fail-closed bail: cancelQueued() === false leaves the composer untouched and no notice', () => {
    const fx = makeEffects({
      getDraft: vi.fn(() => ''),
      cancelQueued: vi.fn(() => false),
    })
    runQueuedEdit('cmid-1', 'draft body', fx)

    expect(fx.cancelQueued).toHaveBeenCalledWith('cmid-1')
    // Closed socket: entry is NOT dropped by sendCancelQueued (retryable), and
    // the handler must not touch the composer.
    expect(fx.reopenComposer).not.toHaveBeenCalled()
    expect(fx.focusComposer).not.toHaveBeenCalled()
    expect(fx.notify).not.toHaveBeenCalled()
  })
})
