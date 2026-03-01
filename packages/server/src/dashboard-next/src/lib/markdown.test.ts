/**
 * Markdown renderer tests (#1155)
 */
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(undefined as unknown as string)).toBe('')
  })

  it('renders headers', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>')
    expect(renderMarkdown('## Subtitle')).toContain('<h2>Subtitle</h2>')
    expect(renderMarkdown('### Section')).toContain('<h3>Section</h3>')
  })

  it('renders bold text', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>')
  })

  it('renders italic text', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>')
  })

  it('renders inline code', () => {
    const html = renderMarkdown('use `npm install`')
    expect(html).toContain('<code>')
    expect(html).toContain('npm install')
  })

  it('renders fenced code blocks with syntax highlighting', () => {
    const md = '```javascript\nconst x = 5\n```'
    const html = renderMarkdown(md)
    expect(html).toContain('<pre>')
    expect(html).toContain('<code')
    expect(html).toContain('language-javascript')
  })

  it('renders fenced code blocks without language', () => {
    const md = '```\nsome code\n```'
    const html = renderMarkdown(md)
    expect(html).toContain('<pre>')
    expect(html).toContain('<code>')
    expect(html).toContain('some code')
  })

  it('renders links with safe URLs', () => {
    const html = renderMarkdown('[Google](https://google.com)')
    expect(html).toContain('<a href="https://google.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
    expect(html).toContain('Google</a>')
  })

  it('sanitizes javascript: URLs', () => {
    const html = renderMarkdown('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<a')
    expect(html).toContain('click')
  })

  it('sanitizes data: URLs', () => {
    const html = renderMarkdown('[click](data:text/html,<h1>xss</h1>)')
    expect(html).not.toContain('data:')
    expect(html).not.toContain('<a')
  })

  it('renders blockquotes', () => {
    const html = renderMarkdown('> quoted text')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('quoted text')
  })

  it('renders unordered lists', () => {
    const html = renderMarkdown('- item 1\n- item 2')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li')
    expect(html).toContain('item 1')
    expect(html).toContain('item 2')
  })

  it('renders ordered lists', () => {
    const html = renderMarkdown('1. first\n2. second')
    expect(html).toContain('<ol>')
    expect(html).toContain('<li')
    expect(html).toContain('first')
    expect(html).toContain('second')
    expect(html).toMatch(/<ol>[\s\S]*first[\s\S]*<\/ol>/)
  })

  it('wraps paragraphs in proper <p> tags (#1169)', () => {
    const html = renderMarkdown('para 1\n\npara 2')
    expect(html).toContain('<p>para 1</p>')
    expect(html).toContain('<p>para 2</p>')
  })

  it('does not wrap block elements in <p> tags (#1169)', () => {
    const html = renderMarkdown('# Title\n\nSome text')
    expect(html).not.toMatch(/<p>\s*<h1>/)
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<p>Some text</p>')
  })

  it('converts single newlines to br', () => {
    const html = renderMarkdown('line 1\nline 2')
    expect(html).toContain('<br>')
  })

  it('escapes HTML in text', () => {
    const html = renderMarkdown('<script>alert("xss")</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('preserves code block content through markdown processing', () => {
    const md = 'text before\n```\n<div>html in code</div>\n```\ntext after'
    const html = renderMarkdown(md)
    expect(html).toContain('&lt;div&gt;')
    expect(html).toContain('text before')
    expect(html).toContain('text after')
  })

  it('does not wrap code blocks in <p> tags (#1244)', () => {
    const html = renderMarkdown('text\n\n```js\nconst x = 1\n```\n\nmore text')
    // Code block should not be nested inside <p> — verify <pre> is a direct top-level block
    expect(html).not.toMatch(/<p>[^<]*<pre>/)
    expect(html).toContain('<pre>')
    expect(html).toContain('<p>text</p>')
    expect(html).toContain('<p>more text</p>')
  })

  it('sanitizes XSS payloads via DOMPurify defense-in-depth', () => {
    // Verify no raw <script> or event handler attributes survive in output.
    // Input is escaped by escapeHtml first; DOMPurify catches anything that
    // bypasses the regex-based pipeline in the future.
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    // Event handlers only dangerous as HTML attributes — verify no unescaped tags
    const div = document.createElement('div')
    div.innerHTML = html
    const allEls = div.querySelectorAll('*')
    for (const el of allEls) {
      for (const attr of el.attributes) {
        expect(attr.name).not.toMatch(/^on/i)
      }
    }
  })
})
