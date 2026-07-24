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
  const segments = useMemo(() => splitMermaidSegments(content), [content])
  const hasMermaid = useMemo(() => segments.some((s) => s.type === 'mermaid'), [segments])

  // Fast path: no mermaid → byte-for-byte the pre-#6754 render.
  if (!hasMermaid) {
    return <div onClick={handleMarkdownBodyClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
  }

  return (
    <div onClick={handleMarkdownBodyClick} className="markdown-body-mixed">
      {segments.map((seg, i) =>
        seg.type === 'mermaid' ? (
          <MermaidDiagram key={i} source={seg.content} />
        ) : (
          <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }} />
        ),
      )}
    </div>
  )
}
