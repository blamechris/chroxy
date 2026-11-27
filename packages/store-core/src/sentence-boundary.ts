/**
 * Whether `text` ends at a sentence boundary: the one rule that decides if a tool
 * call interrupted a thought (the text before it was complete) or a sentence (the
 * text after the tool is the same sentence continuing).
 *
 * Shared by the live post-tool continuation split (#4889 / #4999 / #5014, in
 * `sharedStreamDelta`) and by the replay completion of a response the client held
 * only in part (#8444, `completeHeldResponseStream`), so a reply cut off by a
 * dropped connection is laid out the way a connected client lays it out.
 */
export function endsAtSentenceBoundary(text: string): boolean {
  // Trim trailing whitespace before inspecting the last char so e.g.
  // `"...sentence.   "` still reads as sentence-complete.
  const lastNonWs = text.replace(/\s+$/, '')
  // Strip trailing closing punctuation/quotes that commonly follow a
  // sentence terminator (`.")`, `."`, `!'`, `?)`, etc.) so the gate
  // looks at the terminator itself, not the wrapper. #5014 — also
  // strip CJK closing brackets (`」』）`) so a fullwidth-terminated
  // sentence wrapped in CJK quotes still reads as sentence-complete.
  const stripped = lastNonWs.replace(/[)\]}"'’”»›」』）]+$/, '')
  const lastChar = stripped.charAt(stripped.length - 1)
  // #5014 — recognize CJK fullwidth sentence terminators
  // (`．` U+FF0E, `！` U+FF01, `？` U+FF1F) and the ideographic
  // full stop (`。` U+3002) alongside ASCII.
  const endsSentence =
    lastChar === '.' ||
    lastChar === '!' ||
    lastChar === '?' ||
    lastChar === '．' ||
    lastChar === '！' ||
    lastChar === '？' ||
    lastChar === '。'
  const endsHardBreak = /\n\s*$/.test(text)
  return endsSentence || endsHardBreak
}

/**
 * What a tool call between two stretches of a reply's text does to the bubble layout:
 * the ONE rule for the live post-tool continuation split (#4889 / #4999 / #4975, in
 * `sharedStreamDelta`) and for laying a replayed reply out (#9024,
 * `layoutReplayedReplies`), so the two apply the same test. The replay applies it to
 * the text before the tool only: live re-checks it on every later delta while a tool
 * sits below the bubble, so a sentence that finishes AFTER the call splits live and not
 * in a replay.
 *
 * `prior` is the text of the bubble the call interrupted, `incoming` the text that
 * follows the call (only its first character is read).
 *
 *   - `split: false` when `prior` stops mid-sentence (#4999): the tool interrupted a
 *     sentence, the text after it is the same sentence continuing, and it joins the
 *     bubble above the tool card.
 *   - otherwise `split: true`, and `carry` is the trailing partial word that moves to
 *     the new bubble when the call cut a word in two (#4975): the last character of
 *     `prior` AND the first of `incoming` are both word characters. Since a split needs
 *     a sentence boundary, `prior` cannot end in a word character here, so `carry` is
 *     always '' when `split` is true: kept because the live code peels by it (dead since
 *     #4999 put the gate first), not because a replay can ever need it.
 */
export function postToolSplit(prior: string, incoming: string): { split: boolean; carry: string } {
  if (!endsAtSentenceBoundary(prior)) return { split: false, carry: '' }
  const startsMidWord = /^[A-Za-z0-9_]/.test(incoming)
  const tail = startsMidWord ? prior.match(/[A-Za-z0-9_]+$/) : null
  return { split: true, carry: tail ? tail[0] : '' }
}
