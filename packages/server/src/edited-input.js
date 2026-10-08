/**
 * Narrowing an approved Write/Edit (#8446): how the content that reaches the
 * agent's tool executor is built when the operator drops hunks in the pre-write
 * review (#6543).
 *
 * The client reviews the REDACTED copy of the tool input (`get_permission_input`
 * runs `sanitizeToolInput` over it). Content a client builds from that copy
 * carries `[REDACTED]` wherever a secret-shaped span was, so trusting it writes the
 * placeholder into the user's file in place of the original characters. Two rules
 * keep that from happening, and both live here so the permission manager has one
 * place to call:
 *
 *  1. HUNK DECISIONS, NOT CONTENT. The client says which hunks it dropped and
 *     which it kept (their line ranges, the `@@` header numbers of the diff it
 *     rendered). The server rebuilds the result from the RAW input it holds, so the
 *     written text is made only of lines the agent proposed.
 *  2. TEXT IS NEVER A BASE. Text a client sends (an older client, or the Bash
 *     command editor) was edited from the copy it was shown. Where redaction
 *     changed that copy the text cannot be trusted to be the original with an
 *     edit, whatever it contains: counting placeholders cannot say where one came
 *     from, so such text is refused outright and only `droppedHunks` may narrow
 *     the field. Where redaction changed nothing, the text is just text.
 *
 * A refusal throws {@link EditedInputRefusedError}; nothing is written.
 */
import { sanitizeToolInput, PULL_MAX_INPUT_CHARS } from './redaction.js'

/**
 * The reserved key of `permission_response.editedInput` that carries the hunk
 * decisions: an array of {@link HunkRange}, the hunks the operator dropped. Its
 * presence puts the field in hunk mode. It is not a content field, so the content
 * whitelist never reads it as one.
 */
export const DROPPED_HUNKS_KEY = 'droppedHunks'

/**
 * The hunks the operator kept: with `droppedHunks`, every hunk of the diff it was shown.
 * Needed so the lines OUTSIDE all hunks can be checked to be unchanged lines (see
 * {@link narrowByDroppedHunks}). Required whenever `droppedHunks` is not empty.
 */
export const KEPT_HUNKS_KEY = 'keptHunks'

/** A permission response naming more hunks than this, in either list, is not a real diff. */
export const MAX_HUNKS_PER_LIST = 1000

/**
 * @typedef {object} HunkRange
 * @property {number} oldStart  `@@ -oldStart,oldCount` of the hunk
 * @property {number} oldCount
 * @property {number} newStart  `@@ +newStart,newCount`
 * @property {number} newCount
 * Git's convention, as the client's differ emits it: a side with a non-zero count
 * starts at a 1-based line, a side with a zero count starts AFTER the 0-based line.
 */

/**
 * Per tool: the content field a hunk review narrows and the text the diff was drawn
 * against. Write is drawn against the empty file; Edit against the text it replaces.
 * Must match the client's `TOOL_DIFF` (dashboard + app `PreWriteDiffReview`).
 */
const HUNK_REVIEW = {
  Write: { field: 'content', base: () => '' },
  Edit: { field: 'new_string', base: (input) => input.old_string },
}

/** Whether a tool's content is narrowed by hunk decisions rather than sent as text. */
export function isHunkReviewedTool(toolName) {
  return Object.prototype.hasOwnProperty.call(HUNK_REVIEW, toolName)
}

export class EditedInputRefusedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EditedInputRefusedError'
    this.code = 'EDITED_INPUT_REFUSED'
  }
}

/** Same split the client differ makes: `''` is no lines, anything else splits on `\n`. */
function toLines(text) {
  return text === '' ? [] : text.split('\n')
}

function isCount(n) {
  return Number.isSafeInteger(n) && n >= 0
}

/**
 * The 0-based first line of a side of a hunk, from its header number — the inverse
 * of the differ's header math (a zero-count side's start is already 0-based).
 */
function lineIndex(start, count) {
  return count === 0 ? start : start - 1
}

/**
 * Read one list of hunk ranges, refusing anything malformed.
 *
 * @returns {Array<{ oldIdx: number, oldCount: number, newIdx: number, newCount: number, dropped: boolean }>}
 */
function readRanges(list, dropped) {
  if (!Array.isArray(list) || list.length > MAX_HUNKS_PER_LIST) {
    throw new EditedInputRefusedError('The hunks were not a list the server can read, so the edit was not applied.')
  }
  return list.map((h) => {
    if (!h || typeof h !== 'object'
      || !isCount(h.oldStart) || !isCount(h.oldCount) || !isCount(h.newStart) || !isCount(h.newCount)) {
      throw new EditedInputRefusedError('A hunk was malformed, so the edit was not applied.')
    }
    return {
      oldIdx: lineIndex(h.oldStart, h.oldCount),
      oldCount: h.oldCount,
      newIdx: lineIndex(h.newStart, h.newCount),
      newCount: h.newCount,
      dropped,
    }
  })
}

/**
 * Every hunk of the reviewed diff, dropped and kept, in order, refusing anything that
 * is not a set of disjoint, in-range line regions of the two texts.
 */
function readHunks(dropped, kept, baseLen, proposedLen) {
  const cells = [...readRanges(dropped, true), ...readRanges(kept, false)]
  cells.sort((a, b) => a.newIdx - b.newIdx || a.oldIdx - b.oldIdx)
  let prevOldEnd = 0
  let prevNewEnd = 0
  for (const r of cells) {
    const inRange = r.oldIdx >= 0 && r.newIdx >= 0
      && r.oldIdx + r.oldCount <= baseLen && r.newIdx + r.newCount <= proposedLen
    // Disjoint and in the same order on both sides: a diff's hunks are.
    if (!inRange || r.oldIdx < prevOldEnd || r.newIdx < prevNewEnd) {
      throw new EditedInputRefusedError('A hunk lay outside the content, so the edit was not applied.')
    }
    prevOldEnd = r.oldIdx + r.oldCount
    prevNewEnd = r.newIdx + r.newCount
  }
  return cells
}

/** Append `lines[from, to)` to `out`. A loop, not a spread: a hunk may be 100K+ lines. */
function pushRange(out, lines, from, to) {
  for (let i = from; i < to; i++) out.push(lines[i])
}

/** Whether `a[aFrom, aTo)` and `b[bFrom, bTo)` are the same lines, in count and content. */
function sameLines(a, aFrom, aTo, b, bFrom, bTo) {
  if (aTo - aFrom !== bTo - bFrom) return false
  for (let i = 0; i < aTo - aFrom; i++) {
    if (a[aFrom + i] !== b[bFrom + i]) return false
  }
  return true
}

const NOT_A_DIFF = 'The dropped hunks do not match the change that was proposed, so the edit was not applied.'

/**
 * Build a Write/Edit's narrowed content from the RAW input and the client's hunk
 * decisions: the proposed text with each dropped hunk's lines replaced by the original
 * text's lines, every line taken from the raw input.
 *
 * The client lists EVERY hunk it was shown, dropped or kept, and the lines OUTSIDE all
 * of them (before the first, between two, after the last) must be the same lines on
 * both sides, in count and content. Those are a diff's unchanged lines, and checking
 * them is what makes each range a region of a real diff: a range cannot land off its
 * hunk, and a zero-count side cannot invent an insertion or a deletion, because the
 * unchanged lines on either side would then not line up. The comparison is over the
 * copy the client was shown (where the diff was drawn), so two keys that differ only
 * inside a redacted span still read as unchanged lines, and the lines kept there are
 * the proposal's.
 *
 * The client's line numbers only mean the same lines in the raw text when redaction
 * kept the line count (it never adds a line break; a pattern that spanned one removes
 * it). When the counts differ the edit is refused rather than guessed at.
 *
 * @param {object} rawInput   the agent's proposed tool input, as held server-side
 * @param {string} toolName   'Write' | 'Edit'
 * @param {unknown} dropped   the client's `editedInput.droppedHunks`
 * @param {unknown} kept      the client's `editedInput.keptHunks`
 * @returns {string} the narrowed content for the tool's content field
 */
export function narrowByDroppedHunks(rawInput, toolName, dropped, kept) {
  const review = HUNK_REVIEW[toolName]
  const rawProposed = rawInput[review.field]
  const rawBase = review.base(rawInput)
  if (typeof rawProposed !== 'string' || typeof rawBase !== 'string') {
    throw new EditedInputRefusedError(`This ${toolName} has no text content to narrow, so the edit was not applied.`)
  }
  // Nothing dropped: the proposal as it stands.
  if (Array.isArray(dropped) && dropped.length === 0) return rawProposed

  // The copy the client was shown: the same call `get_permission_input` makes.
  const shown = sanitizeToolInput(rawInput, { maxChars: PULL_MAX_INPUT_CHARS })
  const shownProposed = shown?.[review.field]
  const shownBase = review.base(shown ?? {})
  if (typeof shownProposed !== 'string' || typeof shownBase !== 'string') {
    throw new EditedInputRefusedError('This change is too large to narrow hunk by hunk, so the edit was not applied.')
  }

  const baseLines = toLines(rawBase)
  const proposedLines = toLines(rawProposed)
  const shownBaseLines = toLines(shownBase)
  const shownProposedLines = toLines(shownProposed)
  if (baseLines.length !== shownBaseLines.length || proposedLines.length !== shownProposedLines.length) {
    throw new EditedInputRefusedError(
      'Redacting this content changed its line structure, so the hunks you dropped cannot be mapped back to the original text and the edit was not applied.',
    )
  }

  const cells = readHunks(dropped, kept, baseLines.length, proposedLines.length)
  const out = []
  let oldAt = 0
  let newAt = 0
  for (const r of cells) {
    if (!sameLines(shownBaseLines, oldAt, r.oldIdx, shownProposedLines, newAt, r.newIdx)) {
      throw new EditedInputRefusedError(NOT_A_DIFF)
    }
    pushRange(out, proposedLines, newAt, r.newIdx)
    if (r.dropped) pushRange(out, baseLines, r.oldIdx, r.oldIdx + r.oldCount)
    else pushRange(out, proposedLines, r.newIdx, r.newIdx + r.newCount)
    oldAt = r.oldIdx + r.oldCount
    newAt = r.newIdx + r.newCount
  }
  if (!sameLines(shownBaseLines, oldAt, baseLines.length, shownProposedLines, newAt, proposedLines.length)) {
    throw new EditedInputRefusedError(NOT_A_DIFF)
  }
  pushRange(out, proposedLines, newAt, proposedLines.length)
  return out.join('\n')
}

/**
 * Refuse text a client sent for `field` when redaction changed any of the text it was
 * drawn from. `field` is a whitelisted content field; for a hunk-reviewed tool the text
 * an older client narrowed from is the field AND the text it replaces.
 *
 * Fails closed: an input too large to have been shown whole reads as changed.
 *
 * @param {object} rawInput
 * @param {string} toolName
 * @param {string} field
 */
export function assertClientTextAllowed(rawInput, toolName, field) {
  const shown = sanitizeToolInput(rawInput, { maxChars: PULL_MAX_INPUT_CHARS })
  const names = isHunkReviewedTool(toolName) ? [field, 'old_string'] : [field]
  for (const name of names) {
    const raw = rawInput?.[name]
    if (typeof raw !== 'string') continue
    if (shown?.[name] !== raw) {
      throw new EditedInputRefusedError(
        'Part of this request was redacted before you saw it, so text edited from that copy cannot be applied. Narrow it with the hunk review, or approve or deny it as it is.',
      )
    }
  }
}
