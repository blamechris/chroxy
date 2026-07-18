/**
 * Markdown to HTML renderer.
 *
 * Ported from dashboard-app.js renderMarkdown(). Handles code blocks,
 * inline code, headers, bold, italic, links (with URL sanitization),
 * blockquotes, lists, and paragraphs.
 */
import DOMPurify from 'dompurify'
import { highlightCode } from '@chroxy/store-core'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function renderMarkdown(text: string): string {
  if (!text) return ''

  // Extract fenced code blocks BEFORE HTML-escaping
  const codeBlocks: string[] = []
  let raw = text.replace(/```([^\n]*)?\n([\s\S]*?)```/g, (_m, rawLang: string, code: string) => {
    const placeholder = '\x00FB' + codeBlocks.length + '\x00'
    const lang = rawLang ? rawLang.trim().split(/\s+/)[0] : ''
    const cls = lang ? ` class="language-${lang}"` : ''
    const highlighted = lang ? highlightCode(code, lang) : escapeHtml(code)
    // #6793 — wrap each fenced block in a `.code-block` container carrying a
    // hover-revealed copy button. The button does NOT carry the block's raw
    // text as a `data-*` attribute: DOMPurify's SAFE_FOR_XML guard strips any
    // attribute whose value contains a comment/CDATA closer or a
    // `</script|style|title|...>` substring (verified against this repo's
    // DOMPurify version — it silently drops the whole attribute, not just the
    // dangerous part), which real code snippets can easily contain (e.g. a
    // block demonstrating `</script>` or a `-->` comment). Instead, the copy
    // handler reads the rendered block's `textContent` at click time —
    // `highlightCode`/`escapeHtml` above only wrap each character in
    // `<span>`/entity-escape it, never drop or reorder text, so `<code>`'s
    // `textContent` reconstructs the exact original block. This string
    // pipeline is rendered via `dangerouslySetInnerHTML` (CSP `script-src
    // 'self'`, no inline handlers), so the click is wired up via event
    // delegation in the consuming component (ChatView.tsx), NOT an inline
    // `onclick="…"` attribute.
    codeBlocks.push(
      `<div class="code-block"><button type="button" class="code-copy-btn" data-testid="code-copy-button" aria-label="Copy code" title="Copy code">⧉</button><pre><code${cls}>${highlighted}</code></pre></div>`,
    )
    return placeholder
  })

  // Extract inline code before escaping
  raw = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const placeholder = '\x00CB' + codeBlocks.length + '\x00'
    codeBlocks.push(`<code>${escapeHtml(code)}</code>`)
    return placeholder
  })

  // HTML-escape remaining text
  let html = escapeHtml(raw)

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Links — sanitize URL scheme
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText: string, url: string) => {
    if (/^\s*(javascript|data|vbscript)\s*:/i.test(url)) {
      return linkText
    }
    const safeUrl = url.replace(/"/g, '&quot;')
    return `<a href="${safeUrl}" target="_blank" rel="noopener">${linkText}</a>`
  })

  // Autolink bare http(s) URLs (#3849) — run AFTER the markdown-link replace
  // so `[text](url)` anchors above aren't touched. To avoid double-wrapping
  // URLs that appear inside an existing <a>…</a> from the line above (e.g.
  // `[https://x](https://x)` whose link text is itself a URL), stash any
  // existing anchors behind placeholders, autolink the remaining text, then
  // restore. Trailing punctuation (. , ; : ! ? ) ]) is excluded from the
  // match so a sentence-ending URL doesn't drag the period into the href.
  //
  // Entity awareness (#3849 review): this pass runs AFTER HTML-escape, so
  // `<` is already `&lt;`, `>` is `&gt;`, and `&` in query strings is
  // `&amp;`. A naive `[^\s<]+` body would happily eat `&gt`/`&lt` into the
  // URL match. Treat `&` as a terminator BUT special-case `&amp;` (the
  // round-trip of literal `&` in query strings) so URLs like
  // `?q=1&amp;y=2` still match in full.
  const anchorPlaceholders: string[] = []
  html = html.replace(/<a [^>]*>[\s\S]*?<\/a>/g, (m) => {
    const ph = '\x00AN' + anchorPlaceholders.length + '\x00'
    anchorPlaceholders.push(m)
    return ph
  })
  html = html.replace(/\bhttps?:\/\/(?:[^\s<&]+|&amp;)*[^\s<&.,;:!?)\]]/g, (url: string) => {
    const safeUrl = url.replace(/"/g, '&quot;')
    return `<a href="${safeUrl}" target="_blank" rel="noopener">${url}</a>`
  })
  html = html.replace(/\x00AN(\d+)\x00/g, (_m, idx: string) => anchorPlaceholders[Number(idx)]!)

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li class="md-ul">$1</li>')
  html = html.replace(/(<li class="md-ul">.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="md-ol">$1</li>')
  html = html.replace(/(<li class="md-ol">.*<\/li>\n?)+/g, (m) => `<ol>${m}</ol>`)

  // Tables (GFM) — header row + separator row of `|---|:--:|...|` + zero or
  // more body rows. Inline formatting in cells (bold, italic, code, links)
  // has already been applied above, so cells render rich content. Emitted
  // without internal newlines so the later `\n` → `<br>` pass can't
  // corrupt the table structure. Outer pipes required (matches what
  // LLMs typically emit and avoids false-positives on prose with `|`).
  const tableRe = /^\|(.+)\|[ \t]*\n\|([-:|\s]+)\|[ \t]*\n((?:\|.*\|[ \t]*\n?)*)/gm
  html = html.replace(tableRe, (_m, headerLine: string, sepLine: string, bodyBlock: string) => {
    const headerCells = headerLine.split('|').map(c => c.trim())
    const aligns = sepLine.split('|').map(s => s.trim()).filter(s => /^:?-+:?$/.test(s)).map(s => {
      if (s.startsWith(':') && s.endsWith(':')) return 'center'
      if (s.endsWith(':')) return 'right'
      if (s.startsWith(':')) return 'left'
      return ''
    })
    const align = (i: number) => aligns[i] ? ` style="text-align:${aligns[i]}"` : ''
    const headerHtml = headerCells.map((c, i) => `<th${align(i)}>${c}</th>`).join('')
    const bodyRows = bodyBlock.trim().split('\n').map(row => {
      const cells = row.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim())
      return `<tr>${cells.map((c, i) => `<td${align(i)}>${c}</td>`).join('')}</tr>`
    }).filter(r => r !== '<tr></tr>').join('')
    // Append `\n\n` so the table is its own paragraph segment after the
    // split below — without it, the regex's trailing-newline consumption
    // collapses the `\n\n` boundary between the table and following text.
    return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyRows}</tbody></table>\n\n`
  })

  // Paragraphs — split on double newlines, wrap non-block segments in <p> (#1169)
  const blockRe = /^(<(h[1-6]|pre|ul|ol|blockquote|table)|\x00FB\d+\x00$)/
  html = html.split('\n\n').map(seg => {
    const trimmed = seg.trim()
    if (!trimmed) return ''
    if (blockRe.test(trimmed)) return trimmed
    return `<p>${trimmed}</p>`
  }).filter(Boolean).join('')
  html = html.replace(/\n/g, '<br>')

  // Restore code blocks (fenced use \x00FB, inline use \x00CB) in a single pass
  html = html.replace(/\x00(?:FB|CB)(\d+)\x00/g, (_m, idx: string) => codeBlocks[Number(idx)]!)

  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
  })
}
