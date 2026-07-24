/**
 * WebSearchResultList / WebFetchResult tests (#6757).
 *
 * The parser (`@chroxy/store-core`) is tested independently — these
 * tests cover the render layer: safe links only (http/https, target,
 * rel), escaped text (no raw HTML injection from title/snippet/query),
 * and that the WebFetch markdown pipeline renders through the same
 * sanitized path as chat messages.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import type { ParsedWebSearchResults, ParsedWebFetchResult } from '@chroxy/store-core'
import { WebSearchResultList, WebFetchResult } from './WebToolResult'

afterEach(cleanup)

describe('WebSearchResultList', () => {
  it('renders each result as a safe clickable link with domain + snippet', () => {
    const parsed: ParsedWebSearchResults = {
      query: 'chroxy',
      results: [
        { title: 'Chroxy on GitHub', url: 'https://github.com/blamechris/chroxy', snippet: 'Remote terminal app.' },
        { title: 'Second Result', url: 'http://example.com/page' },
      ],
    }
    render(<WebSearchResultList parsed={parsed} />)

    expect(screen.getByTestId('web-search-query')).toHaveTextContent('chroxy')

    const link0 = screen.getByTestId('web-search-result-link-0')
    expect(link0).toHaveAttribute('href', 'https://github.com/blamechris/chroxy')
    expect(link0).toHaveAttribute('target', '_blank')
    expect(link0).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(link0).toHaveTextContent('Chroxy on GitHub')

    const item0 = screen.getByTestId('web-search-result-0')
    expect(item0).toHaveTextContent('github.com')
    expect(item0).toHaveTextContent('Remote terminal app.')

    const link1 = screen.getByTestId('web-search-result-link-1')
    expect(link1).toHaveAttribute('href', 'http://example.com/page')
  })

  it('renders without a query header when query is absent', () => {
    render(<WebSearchResultList parsed={{ results: [{ title: 'A', url: 'https://a.example.com/' }] }} />)
    expect(screen.queryByTestId('web-search-query')).not.toBeInTheDocument()
  })

  it('escapes result text instead of interpreting it as HTML (XSS guard)', () => {
    const parsed: ParsedWebSearchResults = {
      results: [
        {
          title: '<img src=x onerror=alert(1)>',
          url: 'https://example.com/',
          snippet: '<script>alert(2)</script>',
        },
      ],
    }
    render(<WebSearchResultList parsed={parsed} />)
    // React renders these as literal text nodes, not markup — no <img>/<script>
    // element should be created from result content.
    expect(document.querySelector('img[src="x"]')).not.toBeInTheDocument()
    expect(document.querySelector('script')).not.toBeInTheDocument()
    expect(screen.getByTestId('web-search-result-0').textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('never renders an <a href> for a URL that fails the safety check (defense in depth)', () => {
    // The parser is expected to have already filtered unsafe schemes, but the
    // render layer must not trust that blindly — simulate a value that
    // slipped through (e.g. a future parser regression) and confirm no <a>
    // is emitted for it.
    const parsed: ParsedWebSearchResults = {
      results: [{ title: 'Should not link', url: 'javascript:alert(1)' }],
    }
    render(<WebSearchResultList parsed={parsed} />)
    expect(screen.queryByTestId('web-search-result-link-0')).not.toBeInTheDocument()
    expect(screen.getByTestId('web-search-result-0')).toHaveTextContent('Should not link')
    expect(document.querySelector('a[href^="javascript:"]')).not.toBeInTheDocument()
  })
})

describe('WebFetchResult', () => {
  it('renders the source URL as a safe link and the content via markdown', () => {
    const parsed: ParsedWebFetchResult = {
      url: 'https://example.com/article',
      prompt: 'Summarize',
      content: 'The **article** body with a https://example.com/other link.',
    }
    render(<WebFetchResult parsed={parsed} />)

    const source = screen.getByTestId('web-fetch-source')
    const link = source.querySelector('a')
    expect(link).not.toBeNull()
    expect(link).toHaveAttribute('href', 'https://example.com/article')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))

    const content = screen.getByTestId('web-fetch-content')
    expect(content.querySelector('strong')).toHaveTextContent('article')
    // Embedded bare URL autolinked by the shared markdown pipeline.
    const contentLink = content.querySelector('a[href="https://example.com/other"]')
    expect(contentLink).not.toBeNull()
    expect(contentLink).toHaveAttribute('target', '_blank')
  })

  it('omits the source header when no url was parsed', () => {
    render(<WebFetchResult parsed={{ content: 'Just body text.' }} />)
    expect(screen.queryByTestId('web-fetch-source')).not.toBeInTheDocument()
    expect(screen.getByTestId('web-fetch-content')).toHaveTextContent('Just body text.')
  })

  it('never renders a javascript: url as the source link', () => {
    render(<WebFetchResult parsed={{ url: 'javascript:alert(1)', content: 'Body.' }} />)
    expect(screen.queryByTestId('web-fetch-source')).not.toBeInTheDocument()
    expect(document.querySelector('a[href^="javascript:"]')).not.toBeInTheDocument()
  })

  it('does not use dangerouslySetInnerHTML for raw content — the markdown pipeline HTML-escapes non-markup text', () => {
    render(<WebFetchResult parsed={{ content: '<img src=x onerror=alert(1)>' }} />)
    expect(document.querySelector('img[src="x"]')).not.toBeInTheDocument()
  })

  it('neutralizes a protocol-relative //host link embedded in fetched content (#6986)', () => {
    // The exact link-injection vector: a WebFetch of an attacker-controlled
    // page whose (model/web-controlled) content embeds a markdown link to an
    // external origin via `//host`. The shared allowlist markdown gate must
    // NOT emit a functional anchor for it — otherwise it is openable via
    // middle-click / right-click "Open Link in New Tab" despite the click gate.
    render(<WebFetchResult parsed={{ content: 'Read more: [click here](//evil.example/steal)' }} />)
    const content = screen.getByTestId('web-fetch-content')
    expect(content.querySelector('a')).toBeNull()
    expect(document.querySelector('a[href^="//evil"]')).not.toBeInTheDocument()
    // The link text survives as plain text.
    expect(content).toHaveTextContent('click here')
  })

  it('still renders a legitimate https markdown link in fetched content', () => {
    render(<WebFetchResult parsed={{ content: 'See [the docs](https://example.com/docs).' }} />)
    const content = screen.getByTestId('web-fetch-content')
    const link = content.querySelector('a[href="https://example.com/docs"]')
    expect(link).not.toBeNull()
    expect(link).toHaveAttribute('target', '_blank')
  })
})
