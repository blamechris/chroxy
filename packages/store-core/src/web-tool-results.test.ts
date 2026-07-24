/**
 * Tests for the WebSearch/WebFetch tool_result parsers (#6757).
 *
 * Mirrors TodoList's parser test shape: well-formed input parses to a
 * structured shape, malformed input falls back to null (WebSearch) or a
 * content-only shape (WebFetch), and an unsafe URL scheme never survives
 * into the parsed output.
 */
import { describe, it, expect } from 'vitest'
import {
  isSafeWebUrl,
  isWebSearchToolName,
  isWebFetchToolName,
  parseWebSearchResults,
  parseWebFetchResult,
} from './web-tool-results'

describe('isSafeWebUrl', () => {
  it('allows http(s) URLs', () => {
    expect(isSafeWebUrl('https://example.com/page')).toBe(true)
    expect(isSafeWebUrl('http://example.com')).toBe(true)
  })

  it('rejects non-http(s) schemes', () => {
    expect(isSafeWebUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeWebUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeWebUrl('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeWebUrl('//evil.com/x')).toBe(false)
    expect(isSafeWebUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects non-string input without throwing', () => {
    expect(isSafeWebUrl(undefined)).toBe(false)
    expect(isSafeWebUrl(null)).toBe(false)
    expect(isSafeWebUrl(42)).toBe(false)
    expect(isSafeWebUrl({ url: 'https://example.com' })).toBe(false)
  })
})

describe('isWebSearchToolName / isWebFetchToolName', () => {
  it('matches WebSearch case/separator-insensitively', () => {
    expect(isWebSearchToolName('WebSearch')).toBe(true)
    expect(isWebSearchToolName('web_search')).toBe(true)
    expect(isWebSearchToolName('web-search')).toBe(true)
    expect(isWebSearchToolName('websearch')).toBe(true)
  })

  it('matches WebFetch case/separator-insensitively', () => {
    expect(isWebFetchToolName('WebFetch')).toBe(true)
    expect(isWebFetchToolName('web_fetch')).toBe(true)
    expect(isWebFetchToolName('web-fetch')).toBe(true)
  })

  it('does not cross-match or match unrelated/similar names', () => {
    expect(isWebSearchToolName('WebFetch')).toBe(false)
    expect(isWebFetchToolName('WebSearch')).toBe(false)
    // Regression guard: an existing ToolBubble test uses this tool name
    // to exercise generic title-casing — it must NOT route into the
    // WebSearch structured renderer.
    expect(isWebSearchToolName('web_search_results')).toBe(false)
    // The generic `fetch` alias (mapped to the `web` ToolKind for icon
    // purposes elsewhere) is deliberately NOT treated as WebFetch here.
    expect(isWebFetchToolName('fetch')).toBe(false)
    expect(isWebSearchToolName(undefined)).toBe(false)
    expect(isWebFetchToolName(null)).toBe(false)
  })
})

describe('parseWebSearchResults', () => {
  it('parses a bare JSON array of {title,url,snippet}', () => {
    const text = JSON.stringify([
      { title: 'Example Domain', url: 'https://example.com/', snippet: 'An example.' },
      { title: 'Second Result', url: 'https://example.org/page' },
    ])
    const parsed = parseWebSearchResults(text)
    expect(parsed).not.toBeNull()
    expect(parsed?.results).toHaveLength(2)
    expect(parsed?.results[0]).toEqual({
      title: 'Example Domain',
      url: 'https://example.com/',
      snippet: 'An example.',
    })
    expect(parsed?.results[1]).toEqual({ title: 'Second Result', url: 'https://example.org/page' })
  })

  it('parses a {query, results:[...]} wrapper and surfaces the query', () => {
    const text = JSON.stringify({
      query: 'chroxy github',
      results: [{ title: 'chroxy', url: 'https://github.com/blamechris/chroxy' }],
    })
    const parsed = parseWebSearchResults(text)
    expect(parsed?.query).toBe('chroxy github')
    expect(parsed?.results).toHaveLength(1)
  })

  it('parses the Agent SDK WebSearchOutput shape (results[].content[] mixed with commentary strings)', () => {
    const text = JSON.stringify({
      query: 'anthropic',
      results: [
        {
          tool_use_id: 'srvtoolu_1',
          content: [
            { title: 'Anthropic', url: 'https://www.anthropic.com/' },
            { title: 'Claude', url: 'https://claude.ai/' },
          ],
        },
        'Some commentary text with no link.',
      ],
      durationSeconds: 1.2,
    })
    const parsed = parseWebSearchResults(text)
    expect(parsed?.results).toHaveLength(2)
    expect(parsed?.results.map(r => r.url)).toEqual(['https://www.anthropic.com/', 'https://claude.ai/'])
  })

  it('parses the raw Anthropic web_search_result block array shape', () => {
    const text = JSON.stringify([
      {
        type: 'web_search_result',
        title: 'Result A',
        url: 'https://a.example.com/',
        encrypted_content: 'opaque',
        page_age: '2 days ago',
      },
    ])
    const parsed = parseWebSearchResults(text)
    expect(parsed?.results).toEqual([{ title: 'Result A', url: 'https://a.example.com/' }])
  })

  it('falls back to a title from the URL hostname when title is missing', () => {
    const text = JSON.stringify([{ url: 'https://no-title.example.com/path' }])
    const parsed = parseWebSearchResults(text)
    expect(parsed?.results[0]).toEqual({ title: 'no-title.example.com', url: 'https://no-title.example.com/path' })
  })

  it('parses a markdown-style link list fallback', () => {
    const text = [
      '1. [First Result](https://example.com/1)',
      '   A short snippet describing the first result.',
      '2. [Second Result](https://example.com/2)',
    ].join('\n')
    const parsed = parseWebSearchResults(text)
    expect(parsed?.results).toHaveLength(2)
    expect(parsed?.results[0]).toEqual({
      title: 'First Result',
      url: 'https://example.com/1',
      snippet: 'A short snippet describing the first result.',
    })
    expect(parsed?.results[1]).toEqual({ title: 'Second Result', url: 'https://example.com/2' })
  })

  it('drops entries with an unsafe URL scheme rather than rendering them', () => {
    const text = JSON.stringify([
      { title: 'Safe', url: 'https://safe.example.com/' },
      { title: 'Unsafe', url: 'javascript:alert(document.cookie)' },
    ])
    const parsed = parseWebSearchResults(text)
    expect(parsed?.results).toHaveLength(1)
    expect(parsed?.results[0]?.url).toBe('https://safe.example.com/')
  })

  it('returns null when every candidate has an unsafe URL scheme', () => {
    const text = JSON.stringify([{ title: 'Unsafe', url: 'javascript:alert(1)' }])
    expect(parseWebSearchResults(text)).toBeNull()
  })

  it('returns null for unrecognized / malformed input (fallback to raw text)', () => {
    expect(parseWebSearchResults('this is just plain prose with no links')).toBeNull()
    expect(parseWebSearchResults('')).toBeNull()
    expect(parseWebSearchResults('   ')).toBeNull()
    expect(parseWebSearchResults('{not valid json')).toBeNull()
  })

  it('never throws on garbage input', () => {
    expect(() => parseWebSearchResults('[{"url": 42}]')).not.toThrow()
    expect(() => parseWebSearchResults('null')).not.toThrow()
    expect(() => parseWebSearchResults('"just a string"')).not.toThrow()
  })
})

describe('parseWebFetchResult', () => {
  it('parses the BYOK executor Prompt/URL/body shape', () => {
    const text = 'Prompt: Summarize this page\nURL: https://example.com/article\n\nThe article body goes here.\nMore text.'
    const parsed = parseWebFetchResult(text)
    expect(parsed).toEqual({
      url: 'https://example.com/article',
      prompt: 'Summarize this page',
      content: 'The article body goes here.\nMore text.',
    })
  })

  it('parses the userinfo-stripped marker suffix on the URL line', () => {
    const text = 'Prompt: p\nURL: https://example.com/page [userinfo stripped from input URL]\n\nBody text.'
    const parsed = parseWebFetchResult(text)
    expect(parsed?.url).toBe('https://example.com/page')
    expect(parsed?.content).toBe('Body text.')
  })

  it('parses a URL-only header with no prompt line', () => {
    const text = 'URL: https://example.com/\n\nFetched content.'
    const parsed = parseWebFetchResult(text)
    expect(parsed).toEqual({ url: 'https://example.com/', content: 'Fetched content.' })
  })

  it('treats the whole string as content when no recognizable header is present', () => {
    const text = '# Example Page\n\nSome fetched markdown content with a https://example.com link in it.'
    const parsed = parseWebFetchResult(text)
    expect(parsed).toEqual({ content: text })
  })

  it('drops an unsafe URL scheme from the header but keeps the content', () => {
    const text = 'Prompt: p\nURL: javascript:alert(1)\n\nBody text.'
    const parsed = parseWebFetchResult(text)
    expect(parsed?.url).toBeUndefined()
    expect(parsed?.content).toBe('Body text.')
  })

  it('returns null only for empty input', () => {
    expect(parseWebFetchResult('')).toBeNull()
  })

  it('never throws on garbage input', () => {
    expect(() => parseWebFetchResult('Prompt: \nURL: \n\n')).not.toThrow()
    expect(() => parseWebFetchResult('URL:\n\n')).not.toThrow()
  })
})
