/**
 * Tests for the shared `#`-prefix composer quick-append logic (#6861).
 *
 * These pin the interception semantics (a leading `# ` routes to a memory
 * append, a bare `#` / `#tag` / mid-text `#` does not) and the confirmation
 * wording that BOTH clients render — the single source of truth so the two
 * composers can't drift.
 */
import { describe, it, expect } from 'vitest'
import {
  parseMemoryAppend,
  handleAppendMemoryResult,
  formatMemoryAppendNotice,
} from './memory'

describe('parseMemoryAppend (#6861)', () => {
  it('intercepts a leading `# ` with a non-empty note', () => {
    expect(parseMemoryAppend('# remember to rebase')).toEqual({
      isMemory: true,
      note: 'remember to rebase',
    })
  })

  it('trims surrounding whitespace and collapses multiple leading spaces', () => {
    expect(parseMemoryAppend('#   spaced note  ')).toEqual({
      isMemory: true,
      note: 'spaced note',
    })
    expect(parseMemoryAppend('#\tuse tabs')).toEqual({
      isMemory: true,
      note: 'use tabs',
    })
  })

  it('does NOT intercept a multi-line draft that opens with a Markdown H1', () => {
    // Pasting a spec/plan/doc that starts with `# Title` must reach Claude as a
    // normal chat turn, NOT be collapsed to one line and eaten as a memory note.
    expect(parseMemoryAppend('# Heading\nbody line one\nbody line two')).toEqual({
      isMemory: false,
      note: '',
    })
  })

  it('does NOT intercept a single `# ` line followed by a trailing newline', () => {
    expect(parseMemoryAppend('# just a heading\n')).toEqual({ isMemory: false, note: '' })
  })

  it('does NOT intercept when a later line carries the marker', () => {
    expect(parseMemoryAppend('first\n# not a note')).toEqual({ isMemory: false, note: '' })
  })

  it('does NOT intercept a bare `#`', () => {
    expect(parseMemoryAppend('#')).toEqual({ isMemory: false, note: '' })
  })

  it('does NOT intercept `#tag` (no space after the hash)', () => {
    expect(parseMemoryAppend('#tag')).toEqual({ isMemory: false, note: '' })
    expect(parseMemoryAppend('#123')).toEqual({ isMemory: false, note: '' })
  })

  it('does NOT intercept a `#` mid-text', () => {
    expect(parseMemoryAppend('see issue #123')).toEqual({ isMemory: false, note: '' })
    expect(parseMemoryAppend('done # note')).toEqual({ isMemory: false, note: '' })
  })

  it('does NOT intercept `# ` with an empty note', () => {
    expect(parseMemoryAppend('#   ')).toEqual({ isMemory: false, note: '' })
    expect(parseMemoryAppend('# ')).toEqual({ isMemory: false, note: '' })
  })

  it('does NOT intercept a leading space before the hash', () => {
    expect(parseMemoryAppend(' # note')).toEqual({ isMemory: false, note: '' })
  })

  it('is defensive against non-string input', () => {
    expect(parseMemoryAppend(undefined as unknown as string)).toEqual({ isMemory: false, note: '' })
    expect(parseMemoryAppend(null as unknown as string)).toEqual({ isMemory: false, note: '' })
  })
})

describe('handleAppendMemoryResult (#6861)', () => {
  it('normalises a success ack', () => {
    expect(
      handleAppendMemoryResult({ type: 'append_memory_result', path: '/repo/CLAUDE.md', created: false, error: null }),
    ).toEqual({ path: '/repo/CLAUDE.md', created: false, error: null })
  })

  it('normalises a created + error ack, defaulting missing fields', () => {
    expect(handleAppendMemoryResult({ type: 'append_memory_result', created: true })).toEqual({
      path: null,
      created: true,
      error: null,
    })
    expect(handleAppendMemoryResult({ type: 'append_memory_result', path: null, error: 'denied' })).toEqual({
      path: null,
      created: false,
      error: 'denied',
    })
  })
})

describe('formatMemoryAppendNotice (#6861)', () => {
  it('names the file on a plain append', () => {
    expect(formatMemoryAppendNotice({ path: '/repo/CLAUDE.md', created: false, error: null })).toBe(
      'Saved your note to CLAUDE.md.',
    )
  })

  it('reports creation when the file did not exist', () => {
    expect(formatMemoryAppendNotice({ path: '/repo/CLAUDE.md', created: true, error: null })).toBe(
      'Created CLAUDE.md and saved your note.',
    )
  })

  it('surfaces the error verbatim', () => {
    expect(formatMemoryAppendNotice({ path: null, created: false, error: 'Pairing-issued tokens cannot modify files' })).toBe(
      "Couldn't save to memory: Pairing-issued tokens cannot modify files",
    )
  })

  it('falls back to CLAUDE.md when no path is provided', () => {
    expect(formatMemoryAppendNotice({ path: null, created: false, error: null })).toBe(
      'Saved your note to CLAUDE.md.',
    )
  })
})
