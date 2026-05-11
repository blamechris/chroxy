/**
 * Tests for the large-paste collapse helpers (#3797).
 *
 * Both clients (mobile + dashboard) call into these functions to keep the
 * paste-collapse threshold, marker shape, and expansion regex aligned —
 * the tests double as the contract that locks that alignment in place.
 */
import { describe, it, expect } from 'vitest'
import {
  PASTE_COLLAPSE_CHAR_THRESHOLD,
  PASTE_COLLAPSE_LINE_THRESHOLD,
  PASTE_MARKER_REGEX,
  shouldCollapsePaste,
  formatPasteMarker,
  expandPasteMarkers,
  findActiveMarkerIds,
  detectPasteFromDiff,
} from './paste-text'

describe('shouldCollapsePaste', () => {
  it('returns false for empty text', () => {
    expect(shouldCollapsePaste('')).toBe(false)
  })

  it('returns false for short text below both thresholds', () => {
    expect(shouldCollapsePaste('hello world')).toBe(false)
  })

  it('triggers on char count at the threshold', () => {
    expect(shouldCollapsePaste('a'.repeat(PASTE_COLLAPSE_CHAR_THRESHOLD))).toBe(true)
  })

  it('does not trigger one char below the char threshold', () => {
    expect(shouldCollapsePaste('a'.repeat(PASTE_COLLAPSE_CHAR_THRESHOLD - 1))).toBe(false)
  })

  it('triggers on line count at the threshold', () => {
    const text = Array(PASTE_COLLAPSE_LINE_THRESHOLD).fill('x').join('\n')
    expect(shouldCollapsePaste(text)).toBe(true)
  })

  it('does not trigger one line below the line threshold', () => {
    const text = Array(PASTE_COLLAPSE_LINE_THRESHOLD - 1).fill('x').join('\n')
    expect(shouldCollapsePaste(text)).toBe(false)
  })

  it('triggers when either threshold is hit independently', () => {
    // Long single line — char trigger only
    expect(shouldCollapsePaste('a'.repeat(PASTE_COLLAPSE_CHAR_THRESHOLD + 1))).toBe(true)
    // Many short lines — line trigger only
    expect(shouldCollapsePaste('x\n'.repeat(PASTE_COLLAPSE_LINE_THRESHOLD + 1))).toBe(true)
  })
})

describe('formatPasteMarker', () => {
  it('reports line count for multi-line pastes', () => {
    const text = 'a\nb\nc\nd'
    expect(formatPasteMarker(1, text)).toBe('[Pasted text #1 +4 lines]')
  })

  it('reports char count for single-line pastes', () => {
    const text = 'a'.repeat(2000)
    expect(formatPasteMarker(3, text)).toBe('[Pasted text #3 +2000 chars]')
  })

  it('uses bracket syntax with no unicode', () => {
    // Plain ASCII so iOS autocorrect / Android autocomplete cannot
    // mangle the marker.
    const marker = formatPasteMarker(1, 'a\nb')
    for (let i = 0; i < marker.length; i++) {
      expect(marker.charCodeAt(i)).toBeLessThan(128)
    }
  })

  it('handles ids > 9 without padding', () => {
    expect(formatPasteMarker(99, 'a\nb')).toBe('[Pasted text #99 +2 lines]')
    expect(formatPasteMarker(1234, 'a\nb')).toBe('[Pasted text #1234 +2 lines]')
  })
})

describe('PASTE_MARKER_REGEX', () => {
  it('matches every marker shape formatPasteMarker emits', () => {
    const lineMarker = formatPasteMarker(1, 'a\nb')
    const charMarker = formatPasteMarker(2, 'a'.repeat(2000))
    expect(lineMarker.match(new RegExp(PASTE_MARKER_REGEX.source))).not.toBeNull()
    expect(charMarker.match(new RegExp(PASTE_MARKER_REGEX.source))).not.toBeNull()
  })

  it('captures the id', () => {
    const re = new RegExp(PASTE_MARKER_REGEX.source)
    const match = re.exec('[Pasted text #42 +5 lines]')
    expect(match?.[1]).toBe('42')
  })

  it('captures the size and unit', () => {
    const re = new RegExp(PASTE_MARKER_REGEX.source)
    const match = re.exec('[Pasted text #1 +1234 chars]')
    expect(match?.[2]).toBe('1234')
    expect(match?.[3]).toBe('chars')
  })
})

describe('expandPasteMarkers', () => {
  it('replaces a single marker with its content (Map)', () => {
    const blocks = new Map<number, string>([[1, 'hello world']])
    expect(expandPasteMarkers('before [Pasted text #1 +1 lines] after', blocks)).toBe('before hello world after')
  })

  it('replaces a single marker with its content (Record)', () => {
    const blocks = { 1: 'hello world' }
    expect(expandPasteMarkers('before [Pasted text #1 +1 lines] after', blocks)).toBe('before hello world after')
  })

  it('replaces multiple markers in one pass', () => {
    const blocks = new Map<number, string>([
      [1, 'AAA'],
      [2, 'BBB'],
    ])
    const text = 'x [Pasted text #1 +1 lines] y [Pasted text #2 +1 lines] z'
    expect(expandPasteMarkers(text, blocks)).toBe('x AAA y BBB z')
  })

  it('leaves markers with no matching block untouched (preserves user-typed text)', () => {
    const blocks = new Map<number, string>([[1, 'kept']])
    const text = '[Pasted text #1 +1 lines] and [Pasted text #999 +99 lines]'
    expect(expandPasteMarkers(text, blocks)).toBe('kept and [Pasted text #999 +99 lines]')
  })

  it('returns plain strings unchanged when no markers are present', () => {
    expect(expandPasteMarkers('just a normal message', new Map())).toBe('just a normal message')
  })

  it('does not double-expand if the stored content itself contains a marker shape', () => {
    // The marker syntax is deliberately rare enough that we accept this
    // edge case as no-op-safe: the replace pass is single-pass, so an
    // inner marker stays literal.
    const blocks = new Map<number, string>([[1, '[Pasted text #2 +5 lines]']])
    expect(expandPasteMarkers('[Pasted text #1 +1 lines]', blocks)).toBe('[Pasted text #2 +5 lines]')
  })

  it('resets regex lastIndex between calls (no global-flag carry-over bug)', () => {
    const blocks = new Map<number, string>([[1, 'X']])
    const text = '[Pasted text #1 +1 lines]'
    // Call twice with the same input — both calls must succeed identically.
    expect(expandPasteMarkers(text, blocks)).toBe('X')
    expect(expandPasteMarkers(text, blocks)).toBe('X')
  })
})

describe('detectPasteFromDiff', () => {
  it('returns null when text shrank (deletion)', () => {
    expect(detectPasteFromDiff('hello world', 'hello')).toBeNull()
  })

  it('returns null when text stayed the same length', () => {
    expect(detectPasteFromDiff('abc', 'xyz')).toBeNull()
  })

  it('captures an append at end of input', () => {
    const result = detectPasteFromDiff('hi ', 'hi there')
    expect(result?.inserted).toBe('there')
    expect(result?.prefix).toBe('hi ')
    expect(result?.suffix).toBe('')
  })

  it('captures a prepend at start of input', () => {
    const result = detectPasteFromDiff('world', 'hello world')
    expect(result?.inserted).toBe('hello ')
    expect(result?.prefix).toBe('')
    expect(result?.suffix).toBe('world')
  })

  it('captures an insert in the middle of the input', () => {
    const result = detectPasteFromDiff('aabb', 'aaXXbb')
    expect(result?.inserted).toBe('XX')
    expect(result?.prefix).toBe('aa')
    expect(result?.suffix).toBe('bb')
  })

  it('captures a replace-selection (longer replacement)', () => {
    // User selected "OLD" and pasted "BRAND_NEW_TEXT"
    const result = detectPasteFromDiff('pre OLD post', 'pre BRAND_NEW_TEXT post')
    expect(result?.inserted).toBe('BRAND_NEW_TEXT')
    expect(result?.prefix).toBe('pre ')
    expect(result?.suffix).toBe(' post')
  })

  it('captures the full new text when prev was empty', () => {
    const result = detectPasteFromDiff('', 'a brand new paste')
    expect(result?.inserted).toBe('a brand new paste')
    expect(result?.prefix).toBe('')
    expect(result?.suffix).toBe('')
  })

  it('survives multiline inserts (LF in payload)', () => {
    // prev: "start " then "end" — common prefix "start " (6), common
    // suffix capped at "end" (3, limited by prev.length-prefix). The
    // inserted span therefore includes the trailing space before "end".
    const result = detectPasteFromDiff('start end', 'start \nline1\nline2\n end')
    expect(result?.inserted).toBe('\nline1\nline2\n ')
    // The reconstruction invariant still holds.
    expect((result?.prefix ?? '') + (result?.inserted ?? '') + (result?.suffix ?? ''))
      .toBe('start \nline1\nline2\n end')
  })

  it('reconstructs the next text from prefix + inserted + suffix', () => {
    // Invariant the mobile composer relies on when splicing in the
    // marker: prefix + marker + suffix === new value.
    const prev = 'aa  bb'
    const next = 'aa XXXXXXXX bb'
    const r = detectPasteFromDiff(prev, next)!
    expect(r.prefix + r.inserted + r.suffix).toBe(next)
  })
})

describe('findActiveMarkerIds', () => {
  it('returns the set of marker ids referenced by the text', () => {
    const text = '[Pasted text #1 +5 lines] hi [Pasted text #7 +99 chars]'
    expect(findActiveMarkerIds(text)).toEqual(new Set([1, 7]))
  })

  it('returns empty set when no markers present', () => {
    expect(findActiveMarkerIds('plain text only')).toEqual(new Set())
  })

  it('deduplicates repeated markers', () => {
    const text = '[Pasted text #1 +5 lines] / [Pasted text #1 +5 lines]'
    expect(findActiveMarkerIds(text)).toEqual(new Set([1]))
  })

  it('does not share lastIndex state across calls', () => {
    // Same call twice — second call must find the same id, not skip past
    // it because of stale regex state.
    const text = '[Pasted text #5 +5 lines]'
    expect(findActiveMarkerIds(text)).toEqual(new Set([5]))
    expect(findActiveMarkerIds(text)).toEqual(new Set([5]))
  })
})
