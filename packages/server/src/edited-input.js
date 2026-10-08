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
 *     rendered). The server computes the diff itself over the same redacted copy,
 *     with the same differ (`computeHunks`, shared through @chroxy/protocol), and
 *     requires the client's ranges to be exactly that list of hunks. It then
 *     rebuilds the result from the RAW input it holds, so the written text is made
 *     only of lines the agent proposed, and only ever the proposal with whole real
 *     hunks reverted.
 *  2. TEXT IS NEVER A BASE. Text a client sends (an older client, or the Bash
 *     command editor) was edited from the copy it was shown. Where redaction
 *     changed that copy the text cannot be trusted to be the original with an
 *     edit, whatever it contains: counting placeholders cannot say where one came
 *     from, so such text is refused outright and only `droppedHunks` may narrow
 *     the field. Where redaction changed nothing, the text is just text.
 *
 * A refusal throws {@link EditedInputRefusedError}; nothing is written.
 */
import { computeHunks, splitContentLines } from '@chroxy/protocol'
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
 * Required whenever `droppedHunks` is not empty, because the server needs the whole
 * partition to compare with its own hunk list.
 */
export const KEPT_HUNKS_KEY = 'keptHunks'

/**
 * @typedef {object} HunkRange
 * @property {number} oldStart  `@@ -oldStart,oldCount` of the hunk
 * @property {number} oldCount
 * @property {number} newStart  `@@ +newStart,newCount`
 * @property {number} newCount
 * Git's convention, as the differ emits it: a side with a non-zero count starts at a
 * 1-based line, a side with a zero count starts AFTER the 0-based line.
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

/**
 * The 0-based first line of a side of a hunk, from its header number — the inverse
 * of the differ's header math (a zero-count side's start is already 0-based).
 */
function lineIndex(start, count) {
  return count === 0 ? start : start - 1
}

/** `@@ -a,b +c,d @@` from a client range, refusing anything that is not four whole counts. */
function headerOf(h) {
  if (!h || typeof h !== 'object') return null
  const { oldStart, oldCount, newStart, newCount } = h
  for (const n of [oldStart, oldCount, newStart, newCount]) {
    if (!Number.isSafeInteger(n) || n < 0) return null
  }
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
}

/** Append `lines[from, to)` to `out`. A loop, not a spread: a hunk may be 100K+ lines. */
function pushRange(out, lines, from, to) {
  for (let i = from; i < to; i++) out.push(lines[i])
}

const NOT_A_DIFF = 'The hunks you named are not the hunks of the change that was proposed, so the edit was not applied.'
const HIDDEN_DIFFERENCE = 'This change contains differences that redaction hid from the review, so it can only be approved or denied as a whole. The request was denied; the agent can propose it again, and it can be approved whole.'

/**
 * The server's own hunks over the shown copy, parsed into line positions in the
 * texts, in order. Each entry carries the hunk's lines so a walk can tell its
 * context from its changes.
 */
function ownHunks(shownBase, shownProposed) {
  return computeHunks(shownBase, shownProposed).map((hunk) => {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(hunk.header)
    if (!m) throw new EditedInputRefusedError(NOT_A_DIFF)
    const oldCount = Number(m[2])
    const newCount = Number(m[4])
    return {
      header: hunk.header,
      lines: hunk.lines,
      oldIdx: lineIndex(Number(m[1]), oldCount),
      oldCount,
      newIdx: lineIndex(Number(m[3]), newCount),
      newCount,
    }
  })
}

/**
 * Whether the raw texts differ at a line the shown copy reads as unchanged: outside
 * every hunk, or as a hunk's context line. That is a change redaction hid (two
 * different keys both read `[REDACTED]`).
 */
function hasHiddenDifference(hunks, baseLines, proposedLines) {
  let oldAt = 0
  let newAt = 0
  const sameAt = (o, n) => baseLines[o] !== proposedLines[n]
  for (const h of hunks) {
    for (; oldAt < h.oldIdx; oldAt++, newAt++) if (sameAt(oldAt, newAt)) return true
    for (const line of h.lines) {
      if (line.type === 'context') {
        if (sameAt(oldAt, newAt)) return true
        oldAt++
        newAt++
      } else if (line.type === 'deletion') {
        oldAt++
      } else {
        newAt++
      }
    }
  }
  for (; oldAt < baseLines.length; oldAt++, newAt++) if (sameAt(oldAt, newAt)) return true
  return false
}

/**
 * Build a Write/Edit's narrowed content from the RAW input and the client's hunk
 * decisions: the proposed text with each dropped hunk's lines replaced by the original
 * text's lines, every line taken from the raw input.
 *
 * The client lists EVERY hunk it was shown, dropped or kept. The server diffs the same
 * redacted copy itself (same differ, same context) and requires the client's ranges to
 * be exactly its hunks: the same headers, each once, none missing and none extra. A
 * range that lands off its hunk, a zero-count side that invents an insertion or a
 * deletion, or a partition that deletes a line both sides share, is not that list and is
 * refused. The lines outside the hunks are then unchanged lines by construction.
 *
 * Two things are refused rather than guessed at. The client's line numbers only mean the
 * same lines in the raw text when redaction kept the line count (it never adds a line
 * break; a pattern that spanned one removes it). And when the raw texts differ at a line
 * the shown copy reads as unchanged (a rotated key), dropping any hunk would write that
 * hidden change unseen, so only a whole approve or deny is left.
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
  if (!Array.isArray(dropped)) {
    throw new EditedInputRefusedError('The dropped hunks were not a list the server can read, so the edit was not applied.')
  }
  // Nothing dropped: the proposal as it stands.
  if (dropped.length === 0) return rawProposed
  if (!Array.isArray(kept)) {
    throw new EditedInputRefusedError('The kept hunks were not a list the server can read, so the edit was not applied.')
  }

  // The copy the client was shown: the same call `get_permission_input` makes.
  const shown = sanitizeToolInput(rawInput, { maxChars: PULL_MAX_INPUT_CHARS })
  const shownProposed = shown?.[review.field]
  const shownBase = review.base(shown ?? {})
  if (typeof shownProposed !== 'string' || typeof shownBase !== 'string') {
    throw new EditedInputRefusedError('This change is too large to narrow hunk by hunk, so the edit was not applied.')
  }

  const baseLines = splitContentLines(rawBase)
  const proposedLines = splitContentLines(rawProposed)
  if (baseLines.length !== splitContentLines(shownBase).length
    || proposedLines.length !== splitContentLines(shownProposed).length) {
    throw new EditedInputRefusedError(
      'Redacting this content changed its line structure, so the hunks you dropped cannot be mapped back to the original text and the edit was not applied.',
    )
  }

  // The client's partition must be exactly the server's own hunk list.
  const hunks = ownHunks(shownBase, shownProposed)
  if (dropped.length + kept.length !== hunks.length) throw new EditedInputRefusedError(NOT_A_DIFF)
  const decision = new Map() // header -> true when dropped
  for (const [list, isDropped] of [[dropped, true], [kept, false]]) {
    for (const range of list) {
      const header = headerOf(range)
      if (header === null) throw new EditedInputRefusedError(NOT_A_DIFF)
      decision.set(header, isDropped)
    }
  }
  // Same count, and every real hunk named: so nothing is repeated or extra either.
  if (hunks.some((h) => !decision.has(h.header))) throw new EditedInputRefusedError(NOT_A_DIFF)

  if (hasHiddenDifference(hunks, baseLines, proposedLines)) throw new EditedInputRefusedError(HIDDEN_DIFFERENCE)

  const out = []
  let newAt = 0
  for (const h of hunks) {
    pushRange(out, proposedLines, newAt, h.newIdx)
    if (decision.get(h.header)) pushRange(out, baseLines, h.oldIdx, h.oldIdx + h.oldCount)
    else pushRange(out, proposedLines, h.newIdx, h.newIdx + h.newCount)
    newAt = h.newIdx + h.newCount
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
        'Part of this request was redacted before you saw it, so text edited from that copy cannot be applied. The request was denied; the agent can propose it again, and it can be approved whole.',
      )
    }
  }
}
