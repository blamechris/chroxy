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
