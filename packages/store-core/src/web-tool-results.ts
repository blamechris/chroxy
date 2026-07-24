/**
 * Shared parse logic for WebSearch/WebFetch tool_result content (#6757).
 *
 * WebSearch and WebFetch results reach the client as a single flattened
 * text string (`packages/server/src/tool-result.js` `emitToolResults`
 * joins every text content block into one string before it ever reaches
 * a client — there is no structured title/url/snippet payload on the
 * wire). This module re-parses that text back into a structured shape so
 * both the dashboard and mobile `ToolBubble` can render a real result
 * list / formatted view instead of a raw `<pre>` dump, mirroring the
 * precedent `parseTodoList` set for TodoWrite (#4139).
 *
 * Known real-world shapes this module targets:
 *   - WebSearch: the Claude Agent SDK's `WebSearchOutput.results` shape
 *     (an array of `{ tool_use_id, content: { title, url }[] }` entries
 *     interleaved with plain-string commentary) and the raw Anthropic
 *     Messages API `web_search_tool_result` content shape (an array of
 *     `{ type: 'web_search_result', title, url, ... }`), both typically
 *     serialized to JSON text by the time they reach `emitToolResults`.
 *     A markdown-link-list fallback (`- [title](url)`) covers providers
 *     that pre-format the result text instead.
 *   - WebFetch: the BYOK executor (`packages/server/src/
 *     byok-tool-executor.js` `runWebFetch`) emits
 *     `Prompt: <prompt>\nURL: <url>\n\n<content>` — parsed into its
 *     three parts so the client can show the source URL as a link and
 *     the body as formatted text. Any other shape still renders — the
 *     whole string becomes `content` with no `url`/`prompt` extracted.
 *
 * Both parsers are defensive: malformed / unrecognized-shape input never
 * throws. `parseWebSearchResults` returns `null` (caller falls back to
 * the raw `<pre>` render) when it can't find at least one safe result.
 * `parseWebFetchResult` only returns `null` for empty input — any other
 * text still renders as formatted content, since arbitrary text is
 * always safe to run through the markdown pipeline.
 *
 * Security: a search/fetch result's `url` is fully model/web-controlled
 * (it's exactly the content an attacker-influenced page or search index
 * can inject). `isSafeWebUrl` is the single scheme allowlist (http/https
 * only) both parsers filter through — rendering layers MUST NOT
 * second-guess a URL this module already dropped, but SHOULD still
 * re-check with `isSafeWebUrl` before emitting an `<a href>` (defense in
 * depth, matching the existing `lib/markdown.ts` + `lib/links.ts`
 * pattern of gating scheme at both parse time and click time).
 */

/** One search hit. `snippet` is optional — most real payloads are
 *  title+url only; a snippet/description field is included when present
 *  so a richer source is not truncated to just a link. */
export interface WebSearchResultItem {
  title: string
  url: string
  snippet?: string
}

export interface ParsedWebSearchResults {
  /** The search query, when the payload carries one. */
  query?: string
  results: WebSearchResultItem[]
}

export interface ParsedWebFetchResult {
  /** The fetched URL, when the result text carries a recognizable header. */
  url?: string
  /** The prompt the fetch was run with, when present (BYOK executor shape). */
  prompt?: string
  /** The fetched page content (or the entire input, if no header matched). */
  content: string
}

const OPENABLE_SCHEME = /^https?:\/\//i

/**
 * The only URL schemes this module (and its renderers) treat as safe to
 * link to. `javascript:` / `data:` / `vbscript:` / bare `//host` and
 * anything else is rejected outright — mirrors `lib/links.ts`'s
 * `OPENABLE_SCHEME` gate so search/fetch results can't smuggle a
 * dangerous scheme past the chat-message autolinker's equivalent check.
 */
export function isSafeWebUrl(url: unknown): url is string {
  return typeof url === 'string' && OPENABLE_SCHEME.test(url.trim())
}

function normalizeToolName(name: string | undefined | null): string {
  if (!name) return ''
  return name.toLowerCase().replace(/[_-]/g, '')
}

/** True for `WebSearch` / `web_search` / `web-search` (case/separator
 *  insensitive) — the exact tool name the dashboard/mobile ToolBubble
 *  should route through {@link parseWebSearchResults}. */
export function isWebSearchToolName(name: string | undefined | null): boolean {
  return normalizeToolName(name) === 'websearch'
}

/** True for `WebFetch` / `web_fetch` / `web-fetch` — routes through
 *  {@link parseWebFetchResult}. Deliberately does NOT match the generic
 *  `fetch` alias some providers use for unrelated tools (#6757 scopes
 *  structured rendering to WebSearch/WebFetch specifically). */
export function isWebFetchToolName(name: string | undefined | null): boolean {
  return normalizeToolName(name) === 'webfetch'
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function coerceString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Pull `{ title, url, snippet }` candidates out of one already-parsed
 * JSON value, recursing into common wrapper shapes:
 *   - a bare array of result-like objects
 *   - `{ results: [...] }` / `{ content: [...] }`
 *   - the SDK's `WebSearchOutput.results` shape: an array mixing
 *     `{ tool_use_id, content: [{ title, url }] }` entries with plain
 *     commentary strings (the strings are skipped — no link to extract)
 * Returns raw candidates (not yet URL/scheme-filtered) — filtering
 * happens once at the end of {@link parseWebSearchResults} so every
 * branch shares the same safety gate.
 */
function collectResultCandidates(value: unknown, depth = 0): Array<{ title?: string; url?: string; snippet?: string }> {
  if (depth > 4 || value == null) return []
  if (Array.isArray(value)) {
    return value.flatMap((v) => collectResultCandidates(v, depth + 1))
  }
  if (typeof value !== 'object') return []
  const obj = value as Record<string, unknown>
  // A direct result-shaped object: has a url. Anthropic's raw
  // `web_search_result` block and the SDK's `{title,url}` hits both
  // match this.
  if (typeof obj.url === 'string') {
    return [{
      title: coerceString(obj.title),
      url: obj.url,
      snippet: coerceString(obj.snippet) ?? coerceString(obj.description) ?? coerceString(obj.text),
    }]
  }
  // Wrapper shapes: recurse into known array-valued fields.
  const out: Array<{ title?: string; url?: string; snippet?: string }> = []
  if (Array.isArray(obj.results)) out.push(...collectResultCandidates(obj.results, depth + 1))
  if (Array.isArray(obj.content)) out.push(...collectResultCandidates(obj.content, depth + 1))
  return out
}

// Markdown-style link-list fallback: `- [title](url)` / `1. [title](url)`,
// optionally with a snippet on the following indented line. Matches the
// same `[text](url)` shape `lib/markdown.ts` autolinks, so a provider that
// pre-formats WebSearch results as markdown still parses.
const MD_LINK_LINE_RE = /^\s*(?:[-*]|\d+[.)])\s*\[([^\]]+)\]\(([^)]+)\)\s*$/
const SNIPPET_LINE_RE = /^\s{2,}(\S.*)$/

function parseMarkdownLinkList(text: string): WebSearchResultItem[] {
  const lines = text.split('\n')
  const results: WebSearchResultItem[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = line.match(MD_LINK_LINE_RE)
    if (!m) continue
    const title = (m[1] ?? '').trim()
    const url = (m[2] ?? '').trim()
    if (!title || !url) continue
    let snippet: string | undefined
    const next = lines[i + 1]
    if (next && !MD_LINK_LINE_RE.test(next)) {
      const sm = next.match(SNIPPET_LINE_RE)
      if (sm) snippet = sm[1]!.trim()
    }
    results.push({ title, url, snippet })
  }
  return results
}

/**
 * Parse a WebSearch tool_result string into a structured result list.
 * Returns `null` when nothing safely link-shaped can be recovered — the
 * caller (ToolBubble) falls back to the raw `<pre>` render in that case,
 * matching `parseTodoList`'s failure contract.
 *
 * A result whose `url` fails {@link isSafeWebUrl} (e.g. `javascript:` /
 * `data:`) is dropped, not merely neutralized — there's no safe partial
 * form of a non-http(s) "link". If every candidate is unsafe/malformed
 * the return is `null` (empty list is never useful to render as a
 * "structured" result — the raw text carries more information at that
 * point).
 */
export function parseWebSearchResults(text: string): ParsedWebSearchResults | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  const trimmed = text.trim()

  let query: string | undefined
  let candidates: Array<{ title?: string; url?: string; snippet?: string }> = []

  if (trimmed[0] === '[' || trimmed[0] === '{') {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        query = coerceString((parsed as Record<string, unknown>).query)
      }
      candidates = collectResultCandidates(parsed)
    } catch {
      // Not JSON (or truncated JSON) — fall through to the markdown-link
      // fallback below.
    }
  }

  if (candidates.length === 0) {
    candidates = parseMarkdownLinkList(text)
  }

  const results: WebSearchResultItem[] = []
  for (const c of candidates) {
    if (!isSafeWebUrl(c.url)) continue
    const url = c.url.trim()
    const title = c.title?.trim() || titleFromUrl(url)
    results.push(c.snippet ? { title, url, snippet: c.snippet } : { title, url })
  }

  if (results.length === 0) return null
  return query ? { query, results } : { results }
}

// BYOK `runWebFetch`'s success shape: `Prompt: <p>\nURL: <u>[marker]\n\n<body>`.
// The optional bracketed marker is the `[userinfo stripped ...]` suffix
// `byok-tool-executor.js` appends to the URL line.
const WEBFETCH_HEADER_RE = /^Prompt:[ \t]*(.*)\r?\nURL:[ \t]*(\S+)(?:[ \t]*\[[^\]]*\])?\r?\n\r?\n([\s\S]*)$/
// A lighter header some providers may emit: just the URL, no prompt echo.
const WEBFETCH_URL_ONLY_RE = /^URL:[ \t]*(\S+)\r?\n\r?\n([\s\S]*)$/

/**
 * Parse a WebFetch tool_result string. Always succeeds for non-empty
 * input — WebFetch's body is free-form fetched text, which is always
 * safe to hand to the markdown renderer, so there's no "unparseable"
 * shape to reject. Only the empty-string case returns `null` (nothing to
 * show; caller's existing `hasTextResult` gate already treats an empty
 * result as "no panel").
 *
 * When the text carries a `url` header, it's still passed through
 * {@link isSafeWebUrl} before being returned — the header's value is
 * take-what-the-tool-said, not attacker-input-checked at the transport
 * layer, and the caller renders `url` as a clickable link.
 */
export function parseWebFetchResult(text: string): ParsedWebFetchResult | null {
  if (typeof text !== 'string' || text.length === 0) return null

  const full = text.match(WEBFETCH_HEADER_RE)
  if (full) {
    const prompt = (full[1] ?? '').trim()
    const rawUrl = (full[2] ?? '').trim()
    const content = full[3] ?? ''
    return {
      ...(isSafeWebUrl(rawUrl) ? { url: rawUrl } : {}),
      ...(prompt ? { prompt } : {}),
      content,
    }
  }

  const urlOnly = text.match(WEBFETCH_URL_ONLY_RE)
  if (urlOnly) {
    const rawUrl = (urlOnly[1] ?? '').trim()
    const content = urlOnly[2] ?? ''
    return {
      ...(isSafeWebUrl(rawUrl) ? { url: rawUrl } : {}),
      content,
    }
  }

  return { content: text }
}
