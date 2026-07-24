/**
 * Structured WebSearch/WebFetch tool-result renderers (#6757).
 *
 * `ToolBubble` special-cased TodoWrite (#4139) and Task (#5016) results
 * with a dedicated structured render, parse-with-fallback-to-`<pre>`.
 * This extends the same pattern to WebSearch (a list of clickable source
 * cards) and WebFetch (the fetched page run through the existing
 * markdown pipeline). The parse logic (`parseWebSearchResults` /
 * `parseWebFetchResult`) lives in `@chroxy/store-core` so mobile can
 * reuse it; these components are the dashboard-side render only.
 *
 * Security: `url` in both shapes is model/web-controlled content — the
 * parser already filters to http(s)-only via `isSafeWebUrl`, but every
 * `<a href>` here re-checks it before rendering as a link (defense in
 * depth, matching `lib/markdown.ts` + `lib/links.ts`'s parse-time +
 * click-time double gate). All text is rendered as plain React children
 * (auto-escaped) — WebFetch's body is the one exception, which reuses
 * `renderMarkdown` (the same DOMPurify-sanitized pipeline `ChatMessage`
 * uses for assistant prose) rather than a bespoke unescaped path.
 */
import { useMemo } from 'react'
import type { ParsedWebSearchResults, ParsedWebFetchResult } from '@chroxy/store-core'
import { isSafeWebUrl } from '@chroxy/store-core'
import { renderMarkdown } from '../lib/markdown'
import { handleMarkdownLinkClick } from '../lib/links'
import './WebToolResult.css'

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export interface WebSearchResultListProps {
  parsed: ParsedWebSearchResults
}

/** WebSearch: a compact list of source cards (title, domain, snippet) —
 *  the desktop-app-parity treatment cited in #6757, replacing the raw
 *  joined-text dump. */
export function WebSearchResultList({ parsed }: WebSearchResultListProps) {
  return (
    <div className="web-search-results" data-testid="web-search-results">
      {parsed.query && (
        <div className="web-search-query" data-testid="web-search-query">
          Results for &ldquo;{parsed.query}&rdquo;
        </div>
      )}
      <ul className="web-search-result-list">
        {parsed.results.map((r, i) => {
          const safe = isSafeWebUrl(r.url)
          return (
            <li key={`${r.url}-${i}`} className="web-search-result-item" data-testid={`web-search-result-${i}`}>
              {safe ? (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="web-search-result-title"
                  data-testid={`web-search-result-link-${i}`}
                >
                  {r.title}
                </a>
              ) : (
                // Defense in depth — the parser already drops unsafe schemes,
                // so this branch should be unreachable in practice, but never
                // render an <a href> for anything that fails the check twice.
                <span className="web-search-result-title">{r.title}</span>
              )}
              <span className="web-search-result-domain">{domainFromUrl(r.url)}</span>
              {r.snippet && <p className="web-search-result-snippet">{r.snippet}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export interface WebFetchResultProps {
  parsed: ParsedWebFetchResult
}

/** WebFetch: the fetched page content run through the same markdown
 *  pipeline chat messages use (autolinks embedded URLs, sanitized via
 *  DOMPurify) instead of a raw `<pre>` dump. The source URL, when
 *  present, renders as a small linked header above the content. */
export function WebFetchResult({ parsed }: WebFetchResultProps) {
  const html = useMemo(() => renderMarkdown(parsed.content), [parsed.content])
  const safeUrl = parsed.url && isSafeWebUrl(parsed.url) ? parsed.url : undefined
  return (
    <div className="web-fetch-result" data-testid="web-fetch-result">
      {safeUrl && (
        <div className="web-fetch-source" data-testid="web-fetch-source">
          <a href={safeUrl} target="_blank" rel="noopener noreferrer">{safeUrl}</a>
        </div>
      )}
      <div
        className="web-fetch-content"
        data-testid="web-fetch-content"
        onClick={handleMarkdownLinkClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
