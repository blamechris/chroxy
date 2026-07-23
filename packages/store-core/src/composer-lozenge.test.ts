import { describe, it, expect } from 'vitest'
import { formatComposerLozenge } from './composer-lozenge'

describe('formatComposerLozenge', () => {
  it('hides the lozenge at idle regardless of queued count', () => {
    expect(formatComposerLozenge('idle', 0)).toBeNull()
    expect(formatComposerLozenge('idle', 3)).toBeNull()
  })

  it('hides the lozenge for an undefined/unrecognized state', () => {
    expect(formatComposerLozenge(undefined, 2)).toBeNull()
    expect(formatComposerLozenge('some-future-state', 2)).toBeNull()
  })

  it('shows "streaming" with no queued suffix when thinking and nothing queued', () => {
    expect(formatComposerLozenge('thinking', 0)).toBe('◐ streaming')
  })

  it('shows "streaming · +N queued" when thinking with a queued follow-up', () => {
    expect(formatComposerLozenge('thinking', 2)).toBe('◐ streaming · +2 queued')
    expect(formatComposerLozenge('thinking', 1)).toBe('◐ streaming · +1 queued')
  })

  it('labels the busy state (turn active, not text-streaming)', () => {
    expect(formatComposerLozenge('busy', 0)).toBe('◐ busy')
    expect(formatComposerLozenge('busy', 4)).toBe('◐ busy · +4 queued')
  })

  it('labels the waiting state', () => {
    expect(formatComposerLozenge('waiting', 0)).toBe('◐ waiting')
    expect(formatComposerLozenge('waiting', 1)).toBe('◐ waiting · +1 queued')
  })

  it('labels the error state', () => {
    expect(formatComposerLozenge('error', 0)).toBe('◐ error')
  })

  it('defensively floors a negative queued count to 0 (no suffix)', () => {
    expect(formatComposerLozenge('thinking', -1)).toBe('◐ streaming')
  })

  it('defensively treats a non-finite queued count as 0 (no suffix)', () => {
    expect(formatComposerLozenge('thinking', NaN)).toBe('◐ streaming')
    expect(formatComposerLozenge('thinking', Infinity)).toBe('◐ streaming')
  })

  it('truncates a fractional queued count toward zero', () => {
    expect(formatComposerLozenge('thinking', 2.9)).toBe('◐ streaming · +2 queued')
  })
})
