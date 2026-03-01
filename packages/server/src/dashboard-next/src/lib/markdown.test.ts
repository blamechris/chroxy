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
    expect(html).toContain('<li>item 1</li>')
    expect(html).toContain('<li>item 2</li>')
  })

  it('renders ordered lists', () => {
    const html = renderMarkdown('1. first\n2. second')
    expect(html).toContain('<li>first</li>')
    expect(html).toContain('<li>second</li>')
  })

  it('converts double newlines to paragraphs', () => {
    const html = renderMarkdown('para 1\n\npara 2')
    expect(html).toContain('</p><p>')
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
})
