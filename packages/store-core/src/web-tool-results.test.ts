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
  formatWebFetchStatus,
} from './web-tool-results'

// The server's per-result text cap (`MAX_TOOL_RESULT_SIZE` in
// packages/server/src/tool-result.js, mirrored in claude-tui-session.js).
const WIRE_CAP = 10240

/** A real `WebFetchOutput` (sdk-tools.d.ts), key order as Claude Code writes it. */
function sdkFetchOutput(over: Record<string, unknown> = {}) {
  return {
    bytes: 1497,
    code: 200,
    codeText: 'OK',
    result: 'The page says: "a job that is skipped reports Success".\n\n- point one\n- point two',
    durationMs: 2568,
    url: 'https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution',
    ...over,
  }
}

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

describe('parseWebFetchResult — Agent SDK WebFetchOutput (#6987)', () => {
  // claude-tui (the default provider) forwards the PostToolUse hook's raw
  // `tool_response`; normalizeClaudeTuiToolResponse has no WebFetch rule, so it
  // reaches the wire as JSON.stringify(WebFetchOutput).
  it('extracts url, body and status from a JSON-stringified WebFetchOutput', () => {
    const out = sdkFetchOutput()
    const parsed = parseWebFetchResult(JSON.stringify(out))
    expect(parsed).toEqual({
      url: out.url,
      content: out.result,
      code: 200,
      codeText: 'OK',
      bytes: 1497,
      durationMs: 2568,
    })
  })

  it('never leaks the JSON envelope into the rendered content', () => {
    const parsed = parseWebFetchResult(JSON.stringify(sdkFetchOutput()))
    expect(parsed?.content.includes('"bytes"')).toBe(false)
    expect(parsed?.content.includes('durationMs')).toBe(false)
  })

  it('carries a non-2xx status through with the body intact', () => {
    const parsed = parseWebFetchResult(JSON.stringify(sdkFetchOutput({
      code: 404, codeText: 'Not Found', result: 'No such page.', bytes: 13,
    })))
    expect(parsed?.code).toBe(404)
    expect(parsed?.codeText).toBe('Not Found')
    expect(parsed?.content).toBe('No such page.')
    expect(parsed?.url).toBe(sdkFetchOutput().url)
  })

  it('keeps an empty result as empty content, not null', () => {
    const parsed = parseWebFetchResult(JSON.stringify(sdkFetchOutput({ result: '', bytes: 0 })))
    expect(parsed).not.toBeNull()
    expect(parsed?.content).toBe('')
    expect(parsed?.url).toBe(sdkFetchOutput().url)
  })

  it('drops a hostile url scheme but keeps body and status', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', '//evil.example/x']) {
      const parsed = parseWebFetchResult(JSON.stringify(sdkFetchOutput({ url: bad })))
      expect(parsed?.url).toBeUndefined()
      expect(parsed?.content).toBe(sdkFetchOutput().result)
      expect(parsed?.code).toBe(200)
    }
  })

  it('round-trips escapes and unicode in the body', () => {
    const result = 'line1\nline2\t"quoted" \\ back \u00e9 \u{1F600}'
    expect(parseWebFetchResult(JSON.stringify(sdkFetchOutput({ result })))?.content).toBe(result)
  })

  it('recovers the body of an oversized result cut at the 10KB wire cap', () => {
    const big = sdkFetchOutput({ result: 'word '.repeat(5000), bytes: 25000 })
    const wire = JSON.stringify(big).slice(0, WIRE_CAP)
    expect(wire.length).toBe(WIRE_CAP)
    const parsed = parseWebFetchResult(wire)
    expect(parsed).not.toBeNull()
    // status fields precede the body, so they survive the cut ...
    expect(parsed?.code).toBe(200)
    expect(parsed?.bytes).toBe(25000)
    // ... the body is the readable prefix, never the JSON envelope ...
    expect(parsed?.content.startsWith('word word')).toBe(true)
    expect(parsed?.content.includes('"result"')).toBe(false)
    expect(big.result.startsWith(parsed?.content ?? '!')).toBe(true)
    // ... and `url` (written after the body) is gone rather than guessed.
    expect(parsed?.url).toBeUndefined()
  })

  it('does not split an escape sequence when the cap lands inside one', () => {
    // JSON.stringify writes \n, \" and \u0001 as multi-character escapes; a
    // cut can land between any two of those characters.
    const bodies = ['a\nb"c'.repeat(40), 'x\u0001y\u001fz'.repeat(40)]
    for (const result of bodies) {
      const full = JSON.stringify(sdkFetchOutput({ result }))
      const bodyStart = full.indexOf('"result":"') + '"result":"'.length
      for (let cut = bodyStart; cut < bodyStart + 100; cut++) {
        const parsed = parseWebFetchResult(full.slice(0, cut))
        expect(parsed, `cut=${cut}`).not.toBeNull()
        expect(result.startsWith(parsed?.content ?? '!'), `cut=${cut}`).toBe(true)
        expect(parsed?.content.includes('\\'), `cut=${cut}`).toBe(false)
      }
    }
  })

  it('never ends the body on half an emoji when the cap splits a surrogate pair', () => {
    const result = '\u{1F600}'.repeat(60)
    const full = JSON.stringify(sdkFetchOutput({ result }))
    const bodyStart = full.indexOf('"result":"') + '"result":"'.length
    for (let cut = bodyStart; cut < bodyStart + 8; cut++) {
      const content = parseWebFetchResult(full.slice(0, cut))?.content ?? '!'
      expect(/[\ud800-\udbff]$/.test(content), `cut=${cut}`).toBe(false)
      expect(result.startsWith(content), `cut=${cut}`).toBe(true)
    }
  })

  it('keeps the full body and drops only url when the cap lands after the body', () => {
    const full = JSON.stringify(sdkFetchOutput())
    const cut = full.indexOf('"url"') + 8 // inside the url value
    const parsed = parseWebFetchResult(full.slice(0, cut))
    expect(parsed?.content).toBe(sdkFetchOutput().result)
    expect(parsed?.code).toBe(200)
    expect(parsed?.url).toBeUndefined()
  })

  it('does not mistake arbitrary page JSON for a WebFetchOutput', () => {
    // A fetched JSON document that merely has url/result keys.
    for (const text of [
      JSON.stringify({ result: 'x', url: 'https://a.example/' }),
      JSON.stringify({ url: 'https://a.example/', code: 200 }),
      JSON.stringify({ code: 200, result: 'x' }),
      JSON.stringify({ code: '200', result: 'x', url: 'https://a.example/' }),
      JSON.stringify({ code: 200, result: 42, url: 'https://a.example/' }),
      '{"items":[1,2,3]}',
      '{not json',
    ]) {
      expect(parseWebFetchResult(text), text).toEqual({ content: text })
    }
  })

  it('does not treat a bare truncated "{" fragment as a fetch output', () => {
    expect(parseWebFetchResult('{"bytes":12,"code":2')).toEqual({ content: '{"bytes":12,"code":2' })
  })

  it('leaves the BYOK Prompt/URL header and plain SDK text shapes unchanged', () => {
    expect(parseWebFetchResult('Prompt: p\nURL: https://example.com/a\n\nBody')).toEqual({
      url: 'https://example.com/a', prompt: 'p', content: 'Body',
    })
    // The Agent SDK / CLI content block is just the processed result, no envelope.
    expect(parseWebFetchResult('According to the page, X.')).toEqual({ content: 'According to the page, X.' })
  })
})

describe('formatWebFetchStatus', () => {
  it('describes a 2xx fetch as ok, with a human size', () => {
    expect(formatWebFetchStatus({ content: '', code: 200, codeText: 'OK', bytes: 1497 }))
      .toEqual({ text: 'HTTP 200 OK \u00b7 1.5 KB', ok: true })
  })

  it('flags a non-2xx status', () => {
    expect(formatWebFetchStatus({ content: '', code: 404, codeText: 'Not Found' }))
      .toEqual({ text: 'HTTP 404 Not Found', ok: false })
    expect(formatWebFetchStatus({ content: '', code: 500 })).toEqual({ text: 'HTTP 500', ok: false })
    expect(formatWebFetchStatus({ content: '', code: 301, codeText: 'Moved Permanently' })?.ok).toBe(false)
  })

  it('formats byte sizes across magnitudes', () => {
    expect(formatWebFetchStatus({ content: '', code: 200, bytes: 0 })?.text).toBe('HTTP 200 \u00b7 0 B')
    expect(formatWebFetchStatus({ content: '', code: 200, bytes: 999 })?.text).toBe('HTTP 200 \u00b7 999 B')
    expect(formatWebFetchStatus({ content: '', code: 200, bytes: 30767 })?.text).toBe('HTTP 200 \u00b7 30.0 KB')
    expect(formatWebFetchStatus({ content: '', code: 200, bytes: 5 * 1024 * 1024 })?.text).toBe('HTTP 200 \u00b7 5.0 MB')
  })

  it('shows size alone when there is no status, and nothing when there is neither', () => {
    expect(formatWebFetchStatus({ content: '', bytes: 2048 })).toEqual({ text: '2.0 KB', ok: true })
    expect(formatWebFetchStatus({ content: 'x' })).toBeNull()
    expect(formatWebFetchStatus({ content: 'x', url: 'https://a.example/' })).toBeNull()
  })

  it('ignores non-finite or negative numbers', () => {
    expect(formatWebFetchStatus({ content: '', code: Number.NaN, bytes: -5 })).toBeNull()
  })
})

describe('parseWebSearchResults — Agent SDK / CLI flattened text (#6987)', () => {
  // What a real SDK/CLI session forwards (verified against a transcript's
  // tool_result block): a header, ONE `Links:` line of JSON, then commentary.
  const links = [
    { title: 'Conditional Jobs and matrix', url: 'https://github.com/orgs/community/discussions/607' },
    { title: 'Using conditions to control job execution', url: 'https://docs.github.com/en/actions/using-jobs' },
  ]
  const flat = (q = 'job skipped required check') =>
    `Web search results for query: "${q}"\n\nLinks: ${JSON.stringify(links)}\n\nA skipped job reports Success.\n\n` +
    'REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.'

  it('parses the Links: line and the query header', () => {
    const parsed = parseWebSearchResults(flat())
    expect(parsed?.query).toBe('job skipped required check')
    expect(parsed?.results).toEqual(links)
  })

  it('handles a query that itself contains quotes', () => {
    const parsed = parseWebSearchResults(flat('Xcode 27 "Can\'t determine id" error'))
    expect(parsed?.query).toBe('Xcode 27 "Can\'t determine id" error')
    expect(parsed?.results).toHaveLength(2)
  })

  it('merges several Links: lines (searchCount > 1)', () => {
    const text = flat('first') + '\n\nWeb search results for query: "second"\n\nLinks: ' +
      JSON.stringify([{ title: 'Third', url: 'https://third.example/' }])
    const parsed = parseWebSearchResults(text)
    expect(parsed?.query).toBe('first')
    expect(parsed?.results.map(r => r.title)).toEqual([links[0]!.title, links[1]!.title, 'Third'])
  })

  it('drops hostile urls and returns null when none survive', () => {
    const hostile = `Web search results for query: "q"\n\nLinks: ${JSON.stringify([
      { title: 'ok', url: 'https://ok.example/' },
      { title: 'bad', url: 'javascript:alert(1)' },
    ])}`
    expect(parseWebSearchResults(hostile)?.results).toEqual([{ title: 'ok', url: 'https://ok.example/' }])
    const allBad = `Links: ${JSON.stringify([{ title: 'bad', url: 'data:text/html,x' }])}`
    expect(parseWebSearchResults(allBad)).toBeNull()
  })

  it('salvages the complete leading hits from a Links: line cut at the wire cap', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ title: `Hit ${i}`, url: `https://h${i}.example/page` }))
    const wire = `Web search results for query: "q"\n\nLinks: ${JSON.stringify(many)}`.slice(0, WIRE_CAP)
    const parsed = parseWebSearchResults(wire)
    expect(parsed).not.toBeNull()
    expect(parsed!.results.length).toBeGreaterThan(50)
    expect(parsed!.results.length).toBeLessThan(400)
    expect(parsed!.results[0]).toEqual({ title: 'Hit 0', url: 'https://h0.example/page' })
    // never a half-parsed final hit
    const last = parsed!.results[parsed!.results.length - 1]!
    expect(last.url).toBe(`https://h${parsed!.results.length - 1}.example/page`)
  })

  it('salvages hits from a WebSearchOutput JSON cut inside the commentary (claude-tui, 10KB cap)', () => {
    const out = {
      query: 'anthropic',
      results: [
        { tool_use_id: 'srvtoolu_1', content: links },
        'Long commentary. '.repeat(900),
      ],
      durationSeconds: 7.07,
      searchCount: 1,
    }
    const wire = JSON.stringify(out).slice(0, WIRE_CAP)
    expect(() => JSON.parse(wire)).toThrow()
    const parsed = parseWebSearchResults(wire)
    expect(parsed?.query).toBe('anthropic')
    expect(parsed?.results).toEqual(links)
  })

  it('does not pull title/url lookalikes out of the commentary after the Links: line', () => {
    const text = `Links: ${JSON.stringify([{ title: 'Real', url: 'https://real.example/' }])}\n\n` +
      'Quoted: {"title":"Fake","url":"https://fake.example/"}'
    expect(parseWebSearchResults(text)?.results).toEqual([{ title: 'Real', url: 'https://real.example/' }])
  })

  it('returns null for prose that merely mentions Links:', () => {
    expect(parseWebSearchResults('Links: none found.')).toBeNull()
    expect(parseWebSearchResults('Links: [not json')).toBeNull()
  })

  it('still parses the full WebSearchOutput JSON including searchCount', () => {
    const out = { query: 'q', results: [{ tool_use_id: 't', content: links }, 'commentary'], durationSeconds: 1, searchCount: 1 }
    const parsed = parseWebSearchResults(JSON.stringify(out))
    expect(parsed?.query).toBe('q')
    expect(parsed?.results).toEqual(links)
  })
})
