/**
 * MarkdownBody (#6754) — the response/tool_use message body.
 *
 * Previously ChatView rendered the body as a single
 * `<div onClick={handleMarkdownBodyClick} dangerouslySetInnerHTML={renderMarkdown(content)} />`.
 * That is preserved verbatim for the common case (no mermaid fence): same DOM,
 * same delegated copy/link click handler, so nothing changes for existing
 * messages.
 *
 * When the message contains a ```mermaid fence, the content is split into
 * ordered segments (`splitMermaidSegments`): markdown segments keep the
 * untouched string pipeline, mermaid segments render via `MermaidDiagram`. The
 * delegated `onClick` moves to the outer wrapper — it uses `closest()`, so
 * copy-button / link clicks inside any inner segment (including a mermaid
 * block's code-block fallback) still resolve correctly.
 */
import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { splitMermaidSegments } from '../lib/mermaid'
import { handleMarkdownBodyClick } from '../lib/codeCopy'
import { MermaidDiagram } from './MermaidDiagram'

export function MarkdownBody({ content }: { content: string }) {
  // Cheap early-out BEFORE the full fence-scanning split: a real ```mermaid
  // fence always contains the literal substring "mermaid", so this plain
  // `includes` can never false-negative a real fence. It CAN false-positive
  // (prose that merely mentions "mermaid" without a fence) — that case just
  // falls through to `splitMermaidSegments`, which correctly finds no fence
  // and this component takes the identical fast-path render below. This
  // keeps the overwhelmingly common no-mermaid message from paying for a
  // full regex scan on every render, on top of `renderMarkdown`'s own scan.
  const mightHaveMermaid = content.includes('mermaid')

  const segments = useMemo(
    () => (mightHaveMermaid ? splitMermaidSegments(content) : null),
    [content, mightHaveMermaid],
  )
  const hasMermaid = segments !== null && segments.some((s) => s.type === 'mermaid')

  // Fast path: no mermaid → byte-for-byte the pre-#6754 render.
  if (!hasMermaid) {
    return <div onClick={handleMarkdownBodyClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
  }

  return (
    <div onClick={handleMarkdownBodyClick} className="markdown-body-mixed">
      {segments!.map((seg, i) =>
        seg.type === 'mermaid' ? (
          <MermaidDiagram key={i} source={seg.content} />
        ) : (
          <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }} />
        ),
      )}
    </div>
  )
}
