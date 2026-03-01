/**
 * Markdown to HTML renderer.
 *
 * Ported from dashboard-app.js renderMarkdown(). Handles code blocks,
 * inline code, headers, bold, italic, links (with URL sanitization),
 * blockquotes, lists, and paragraphs.
 */
import { highlightCode } from './syntax'

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
  let raw = text.replace(/```(\w*)?\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const placeholder = '\x00CB' + codeBlocks.length + '\x00'
    const cls = lang ? ` class="language-${lang}"` : ''
    const highlighted = lang ? highlightCode(code, lang) : escapeHtml(code)
    codeBlocks.push(`<pre><code${cls}>${highlighted}</code></pre>`)
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

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')

  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>')
  html = html.replace(/\n/g, '<br>')

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace('\x00CB' + i + '\x00', codeBlocks[i])
  }

  return html
}
