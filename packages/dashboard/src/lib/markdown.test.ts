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

  // Bare-URL autolinking (#3849) — bare http(s) URLs in prose render as
  // clickable anchors, not plain text. Without this, build artefact URLs
  // (e.g. expo.dev links) emitted by the agent show up unclickable.
  describe('bare URL autolinking (#3849)', () => {
    it('autolinks bare https URLs in prose', () => {
      const html = renderMarkdown('see https://example.com for more')
      expect(html).toContain('<a href="https://example.com"')
      expect(html).toContain('target="_blank"')
      expect(html).toContain('rel="noopener"')
      expect(html).toContain('>https://example.com</a>')
    })

    it('autolinks bare http URLs in prose', () => {
      const html = renderMarkdown('see http://example.com please')
      expect(html).toContain('<a href="http://example.com"')
    })

    it('does not autolink scheme-less or non-http URLs', () => {
      const html = renderMarkdown('contact me at example.com or ftp://files.example.com')
      expect(html).not.toContain('<a href="example.com"')
      expect(html).not.toContain('<a href="ftp://')
    })

    it('does not double-wrap URLs already in markdown anchors', () => {
      const html = renderMarkdown('[here](https://example.com/page)')
      // Exactly one anchor, with `here` as the text, not the URL
      expect((html.match(/<a /g) || []).length).toBe(1)
      expect(html).toContain('>here</a>')
    })

    it('does not double-wrap when link text is itself a URL', () => {
      // `[https://x](https://x)` is a common Slack-style paste — the renderer
      // makes the URL the link text. Autolinker must not re-wrap that text.
      const html = renderMarkdown('[https://example.com](https://example.com)')
      expect((html.match(/<a /g) || []).length).toBe(1)
    })

    it('excludes trailing punctuation from the href', () => {
      const html = renderMarkdown('go to https://example.com.')
      // The period must NOT be part of the link
      expect(html).toContain('<a href="https://example.com"')
      expect(html).not.toContain('href="https://example.com."')
    })

    it('handles URLs with query strings and fragments', () => {
      const html = renderMarkdown('see https://example.com/path?q=1&y=2#frag here')
      expect(html).toContain('<a href="https://example.com/path?q=1&amp;y=2#frag"')
    })

    // Copilot review of #3849: autolink runs after HTML-escape, so `<URL>`
    // becomes `&lt;URL&gt;`. A naive `[^\s<]+` body would eat `&gt`/`&lt`
    // into the URL match. The fix: terminate at `&`, but allow `&amp;`
    // (the round-trip of `&` in query strings).
    it('terminates at HTML-escaped angle-bracket delimiters', () => {
      const html = renderMarkdown('see <https://example.com> next')
      // The href must be the bare URL — not include the encoded `>`
      expect(html).toContain('<a href="https://example.com"')
      expect(html).not.toContain('href="https://example.com&gt"')
      expect(html).not.toContain('href="https://example.com&gt;"')
    })

    it('still matches full URL when query string contains multiple `&` (escaped to `&amp;`)', () => {
      const html = renderMarkdown('https://example.com/?a=1&b=2&c=3 done')
      // The whole query string must round-trip
      expect(html).toContain('<a href="https://example.com/?a=1&amp;b=2&amp;c=3"')
    })

    it('does not autolink URLs inside fenced code blocks', () => {
      const html = renderMarkdown('```\nhttps://example.com\n```')
      // URL appears inside <code>, not wrapped in an anchor
      expect((html.match(/<a /g) || []).length).toBe(0)
      expect(html).toContain('https://example.com')
    })

    it('does not autolink URLs inside inline code', () => {
      const html = renderMarkdown('use `https://example.com` here')
      expect((html.match(/<a /g) || []).length).toBe(0)
    })
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

  it('wraps paragraphs starting with inline code in <p> tags (#1244)', () => {
    const html = renderMarkdown('`x` is a variable\n\nother text')
    // Inline code at start of paragraph must still get <p> wrapping
    expect(html).toMatch(/<p>.*<code>x<\/code> is a variable.*<\/p>/)
    expect(html).toContain('<p>other text</p>')
  })

  it('wraps standalone inline code paragraph in <p> tags (#1272)', () => {
    // When inline code is the sole content of a paragraph segment,
    // it should still get <p> wrapping (not treated as a block element)
    const html = renderMarkdown('before\n\n`foo`\n\nafter')
    // The <code> must be directly inside a <p>, not bare between separate <p> tags
    expect(html).toContain('<p><code>foo</code></p>')
    expect(html).toContain('<p>before</p>')
    expect(html).toContain('<p>after</p>')
  })

  // GFM tables (#3689)
  describe('tables', () => {
    it('renders a basic GFM table', () => {
      const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |'
      const html = renderMarkdown(md)
      expect(html).toContain('<table>')
      expect(html).toContain('<thead><tr><th>Name</th><th>Age</th></tr></thead>')
      expect(html).toContain('<tbody><tr><td>Alice</td><td>30</td></tr><tr><td>Bob</td><td>25</td></tr></tbody>')
    })

    it('renders a table that is the only content in the message', () => {
      const md = '| col |\n|-----|\n| val |'
      const html = renderMarkdown(md)
      expect(html).toContain('<table>')
      expect(html).toContain('<th>col</th>')
      expect(html).toContain('<td>val</td>')
    })

    it('renders inline formatting inside cells', () => {
      const md = '| Header | Value |\n|--------|-------|\n| **bold** | `code` |'
      const html = renderMarkdown(md)
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('<code>code</code>')
    })

    it('parses alignment markers from the separator row', () => {
      const md = '| L | C | R |\n|:---|:---:|---:|\n| a | b | c |'
      const html = renderMarkdown(md)
      expect(html).toContain('text-align:left')
      expect(html).toContain('text-align:center')
      expect(html).toContain('text-align:right')
    })

    it('does not wrap a table in <p> tags', () => {
      const md = 'before\n\n| x |\n|---|\n| y |\n\nafter'
      const html = renderMarkdown(md)
      expect(html).not.toMatch(/<p>\s*<table>/)
      expect(html).toContain('<p>before</p>')
      expect(html).toContain('<p>after</p>')
    })

    it('does not insert <br> inside the table', () => {
      const md = '| a | b |\n|---|---|\n| 1 | 2 |'
      const html = renderMarkdown(md)
      expect(html).toContain('<table>')
      // The transitions between thead/tbody/tr are emitted without literal
      // newlines, so the later `\n` → `<br>` pass leaves them alone.
      expect(html).not.toMatch(/<table>[^<]*<br>/)
      expect(html).not.toMatch(/<\/tr>\s*<br>/)
    })

    it('does not match prose lines that happen to contain pipes', () => {
      const md = 'shell command: foo | bar | baz\n\nnext paragraph'
      const html = renderMarkdown(md)
      expect(html).not.toContain('<table>')
    })
  })

  // Per-code-block copy button (#6793)
  describe('per-code-block copy button (#6793)', () => {
    it('wraps a fenced code block in a .code-block container with a .code-copy-btn', () => {
      const html = renderMarkdown('```js\nconst x = 5\n```')
      expect(html).toContain('class="code-block"')
      expect(html).toMatch(/<div class="code-block"><button[^>]*class="code-copy-btn"[^>]*>.*?<\/button><pre>/)
    })

    it('gives the button an accessible label and testid, distinct from the whole-message copy button', () => {
      const html = renderMarkdown('```\nx\n```')
      expect(html).toContain('aria-label="Copy code"')
      expect(html).toContain('data-testid="code-copy-button"')
    })

    it('renders one .code-block per fenced block, each scoped to its own snippet', () => {
      const html = renderMarkdown('```js\nfirst\n```\n\ntext between\n\n```py\nsecond\n```')
      expect((html.match(/class="code-block"/g) || []).length).toBe(2)
      expect((html.match(/class="code-copy-btn"/g) || []).length).toBe(2)
      // Each block's own <pre><code> immediately follows its own button — not
      // one giant wrapper around both snippets.
      const div = document.createElement('div')
      div.innerHTML = html
      const blocks = div.querySelectorAll('.code-block')
      expect(blocks).toHaveLength(2)
      expect(blocks[0]!.querySelector('pre code')!.textContent).toBe('first\n')
      expect(blocks[1]!.querySelector('pre code')!.textContent).toBe('second\n')
    })

    it('does NOT add a copy button to inline code spans', () => {
      const html = renderMarkdown('use `npm install` here')
      expect(html).not.toContain('code-copy-btn')
      expect(html).not.toContain('code-block')
    })

    it('the rendered <code> textContent reconstructs the exact original block, even with characters DOMPurify treats specially in attributes', () => {
      // A `data-*`-attribute-based copy affordance would lose this content —
      // DOMPurify's SAFE_FOR_XML guard strips an entire attribute whose value
      // contains a `</script>`-shaped substring or a `-->`/`]>` closer. The
      // textContent-based approach has no such failure mode.
      const tricky = 'const s = "</script>"\n// comment --> end\nconst arr = []> // typo'
      const html = renderMarkdown('```\n' + tricky + '\n```')
      const div = document.createElement('div')
      div.innerHTML = html
      expect(div.querySelector('pre code')!.textContent).toBe(tricky + '\n')
    })

    it('reconstructs the exact block through the syntax-highlighted (language) path too', () => {
      const code = 'const x = "<b>&amp;</b>" // & < >'
      const html = renderMarkdown('```js\n' + code + '\n```')
      const div = document.createElement('div')
      div.innerHTML = html
      expect(div.querySelector('pre code')!.textContent).toBe(code + '\n')
    })
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
