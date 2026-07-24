/**
 * Mermaid fence detection (#6754).
 *
 * `renderMarkdown` (lib/markdown.ts) treats every fenced code block the same:
 * run it through the shared syntax tokenizer and wrap it in `<pre><code>`.
 * To render a ```mermaid fence as an actual diagram, the dashboard splits a
 * message into ordered segments BEFORE it hits `renderMarkdown` — mermaid
 * fences become their own `MermaidDiagram` component, everything else stays on
 * the untouched string pipeline.
 *
 * The fence grammar here MUST match `renderMarkdown`'s exactly (same regex,
 * same "first whitespace-delimited token is the language" rule) so a fence the
 * markdown renderer would highlight as `mermaid` is the same one this splits
 * out — no drift between "what renders as a diagram" and "what would have been
 * highlighted". Only mermaid fences are cut; every other fence (js, python,
 * bare) is left INSIDE the surrounding markdown segment and rendered by the
 * normal pipeline, so this split is transparent for the 99% case with no
 * mermaid.
 *
 * Pure + string-only so it is unit-testable without a DOM.
 */

export type MessageSegmentType = 'markdown' | 'mermaid'

export interface MessageSegment {
  type: MessageSegmentType
  /**
   * For a `markdown` segment: the raw markdown slice (fed to `renderMarkdown`).
   * For a `mermaid` segment: the inner diagram source (the fence body, without
   * the ```mermaid opener / closing ```).
   */
  content: string
}

/**
 * The fence grammar, kept identical to `renderMarkdown`'s inline regex:
 * an opening ``` with an optional info string on the same line, a newline, a
 * lazily-matched body, then a closing ```. A fresh RegExp is created per call
 * (not a shared module-level literal) so the stateful `g`-flag `lastIndex`
 * can never leak across invocations.
 */
function fenceRegex(): RegExp {
  return /```([^\n]*)?\n([\s\S]*?)```/g
}

/** The language token = first whitespace-delimited word of the info string. */
function fenceLang(rawLang: string | undefined): string {
  return rawLang ? rawLang.trim().split(/\s+/)[0]!.toLowerCase() : ''
}

/** True when `text` contains at least one complete (closed) ```mermaid fence. */
export function hasMermaidBlock(text: string): boolean {
  if (!text) return false
  const re = fenceRegex()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (fenceLang(m[1]) === 'mermaid') return true
  }
  return false
}

/**
 * Split a message into ordered segments, cutting ONLY at complete ```mermaid
 * fences. Returns a single `markdown` segment when there is no mermaid fence
 * (including for a message that is entirely other-language code), and `[]` for
 * empty input. An incomplete/streaming mermaid fence (opener typed, closer not
 * yet arrived) does not match the grammar, so it stays inside a `markdown`
 * segment and renders as text until it closes — then the next parse splits it
 * out as a diagram.
 */
export function splitMermaidSegments(text: string): MessageSegment[] {
  if (!text) return []
  const segments: MessageSegment[] = []
  const re = fenceRegex()
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (fenceLang(m[1]) !== 'mermaid') continue // leave non-mermaid fences in the markdown text
    const before = text.slice(lastIndex, m.index)
    if (before) segments.push({ type: 'markdown', content: before })
    segments.push({ type: 'mermaid', content: m[2]! })
    lastIndex = m.index + m[0].length
  }
  const after = text.slice(lastIndex)
  if (after) segments.push({ type: 'markdown', content: after })
  // No mermaid fence at all → the whole message is one markdown segment. (The
  // loop's `after` slice already produces this, but guard the theoretical
  // all-consumed case so callers always get at least one segment.)
  if (segments.length === 0) segments.push({ type: 'markdown', content: text })
  return segments
}
