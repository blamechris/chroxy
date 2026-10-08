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
 *  1. HUNK DECISIONS, NOT CONTENT. The client says which hunks it dropped (their
 *     line ranges, the `@@` header numbers of the diff it rendered). The server
 *     rebuilds the result from the RAW input it holds, so the written text is made
 *     only of lines the agent proposed.
 *  2. A PLACEHOLDER IS NEVER NEW. Content a client sends as text (an older client,
 *     or the Bash command editor) is refused when it carries more redaction
 *     placeholders than the raw input did.
 *
 * A refusal throws {@link EditedInputRefusedError}; nothing is written.
 */
import { sanitizeToolInput, PULL_MAX_INPUT_CHARS, countRedactionMarkers } from './redaction.js'

/**
 * The reserved key of `permission_response.editedInput` that carries the hunk
 * decisions: an array of {@link DroppedHunkRange}. It is not a content field, so
 * the content whitelist never reads it as one.
 */
export const DROPPED_HUNKS_KEY = 'droppedHunks'

/** A permission response naming more dropped hunks than this is not a real diff. */
export const MAX_DROPPED_HUNKS = 1000

/**
 * @typedef {object} DroppedHunkRange
 * @property {number} oldStart  `@@ -oldStart,oldCount` of the dropped hunk
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
 * Read and order the client's dropped hunks, refusing anything that is not a set of
 * disjoint, in-range line regions of the two texts.
 *
 * @returns {Array<{ oldIdx: number, oldCount: number, newIdx: number, newCount: number }>}
 */
function readDroppedHunks(dropped, baseLen, proposedLen) {
  if (!Array.isArray(dropped) || dropped.length > MAX_DROPPED_HUNKS) {
    throw new EditedInputRefusedError('The dropped hunks were not a list the server can read, so the edit was not applied.')
  }
  const regions = dropped.map((h) => {
    if (!h || typeof h !== 'object'
      || !isCount(h.oldStart) || !isCount(h.oldCount) || !isCount(h.newStart) || !isCount(h.newCount)) {
      throw new EditedInputRefusedError('A dropped hunk was malformed, so the edit was not applied.')
    }
    return {
      oldIdx: lineIndex(h.oldStart, h.oldCount),
      oldCount: h.oldCount,
      newIdx: lineIndex(h.newStart, h.newCount),
      newCount: h.newCount,
    }
  })
  regions.sort((a, b) => a.newIdx - b.newIdx)
  let prevOldEnd = 0
  let prevNewEnd = 0
  for (const r of regions) {
    const inRange = r.oldIdx >= 0 && r.newIdx >= 0
      && r.oldIdx + r.oldCount <= baseLen && r.newIdx + r.newCount <= proposedLen
    // Disjoint and in the same order on both sides: a diff's hunks are.
    if (!inRange || r.oldIdx < prevOldEnd || r.newIdx < prevNewEnd) {
      throw new EditedInputRefusedError('A dropped hunk lay outside the content, so the edit was not applied.')
    }
    prevOldEnd = r.oldIdx + r.oldCount
    prevNewEnd = r.newIdx + r.newCount
  }
  return regions
}

/**
 * Build a Write/Edit's narrowed content from the RAW input and the client's dropped
 * hunks: the proposed text with each dropped hunk's lines replaced by the base
 * text's lines, every line taken from the raw input.
 *
 * The client drew its hunks over the redacted copy, so its line numbers only mean
 * the same lines in the raw text when redaction kept the line count (it never adds a
 * newline; a pattern that spanned one removes it). When the counts differ the
 * numbers cannot be mapped back and the edit is refused rather than guessed at.
 *
 * @param {object} rawInput   the agent's proposed tool input, as held server-side
 * @param {string} toolName   'Write' | 'Edit'
 * @param {unknown} dropped   the client's `editedInput.droppedHunks`
 * @returns {string} the narrowed content for the tool's content field
 */
export function narrowByDroppedHunks(rawInput, toolName, dropped) {
  const review = HUNK_REVIEW[toolName]
  const rawProposed = rawInput[review.field]
  const rawBase = review.base(rawInput)
  if (typeof rawProposed !== 'string' || typeof rawBase !== 'string') {
    throw new EditedInputRefusedError(`This ${toolName} has no text content to narrow, so the edit was not applied.`)
  }

  // The copy the client was shown: the same call `get_permission_input` makes.
  const shown = sanitizeToolInput(rawInput, { maxChars: PULL_MAX_INPUT_CHARS })
  const shownProposed = shown?.[review.field]
  const shownBase = review.base(shown ?? {})
  if (typeof shownProposed !== 'string' || typeof shownBase !== 'string') {
    throw new EditedInputRefusedError('This change is too large to narrow hunk by hunk, so the edit was not applied.')
  }

  const baseLines = toLines(rawBase)
  const proposedLines = toLines(rawProposed)
  if (baseLines.length !== toLines(shownBase).length || proposedLines.length !== toLines(shownProposed).length) {
    throw new EditedInputRefusedError(
      'Redacting this content changed its line structure, so the hunks you dropped cannot be mapped back to the original text and the edit was not applied.',
    )
  }

  const regions = readDroppedHunks(dropped, baseLines.length, proposedLines.length)
  // Last region first, so earlier line numbers stay valid while the tail changes.
  const out = [...proposedLines]
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]
    out.splice(r.newIdx, r.newCount, ...baseLines.slice(r.oldIdx, r.oldIdx + r.oldCount))
  }
  return out.join('\n')
}

/**
 * Refuse text content a client sent when it carries redaction placeholders the raw
 * input did not. `allowed` is the raw text(s) the content may legitimately be made
 * of; a file that really contains `[REDACTED]` keeps the occurrences it had.
 *
 * @param {string} candidate  the client-supplied text
 * @param {Array<unknown>} allowed  raw strings the candidate may draw from
 */
export function assertNoNewRedactionMarkers(candidate, allowed) {
  const allowance = allowed.reduce((n, text) => n + countRedactionMarkers(text), 0)
  if (countRedactionMarkers(candidate) > allowance) {
    throw new EditedInputRefusedError(
      'The edited content contains a redaction placeholder that was not in the original, so it was not applied. Approve the unedited request, or deny it.',
    )
  }
}
