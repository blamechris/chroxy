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
 *     Two more WebSearch shapes (#6987, verified against a real session
 *     transcript): the flattened text a Claude Agent SDK / CLI session
 *     forwards (`Web search results for query: "<q>"\n\nLinks: [{title,
 *     url}, ...]\n\n<commentary>`), and either JSON form cut at the
 *     server's 10KB per-result cap (`MAX_TOOL_RESULT_SIZE`), which no
 *     longer parses as JSON — the complete `{title,url}` hits that
 *     survive the cut are recovered instead of dropping to raw text.
 *   - WebFetch: the BYOK executor (`packages/server/src/
 *     byok-tool-executor.js` `runWebFetch`) emits
 *     `Prompt: <prompt>\nURL: <url>\n\n<content>` — parsed into its
 *     three parts so the client can show the source URL as a link and
 *     the body as formatted text. The claude-tui provider (the default)
 *     forwards the Agent SDK's `WebFetchOutput` as
 *     `JSON.stringify({ bytes, code, codeText, result, durationMs, url })`
 *     (`claude-tui-tool-response.js` has no WebFetch rule, so the hook's
 *     `tool_response` hits its JSON.stringify floor) — parsed into
 *     `url` / `content` / status (#6987), including the cut-at-10KB form,
 *     where `url` (written last) is lost but the status and the readable
 *     body prefix are kept. A Claude Agent SDK / CLI session instead
 *     forwards just the processed `result` text, which carries no URL.
 *     Any other shape still renders — the whole string becomes
 *     `content` with no `url`/`prompt` extracted.
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
  /** HTTP status of the fetch, when the result is a `WebFetchOutput` (#6987). */
  code?: number
  /** HTTP status text (`OK`, `Not Found`, ...), alongside `code`. */
  codeText?: string
  /** Size of the fetched content in bytes, when reported. */
  bytes?: number
  /** Time the fetch + processing took, when reported. */
  durationMs?: number
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

/** Decode the body of a JSON string literal (the text between its quotes). */
function decodeJsonStringBody(raw: string): string | undefined {
  try {
    const v: unknown = JSON.parse(`"${raw}"`)
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

// One complete `{"title":"...","url":"..."}` hit, as Claude Code writes it.
// Used to recover hits from text that is no longer valid JSON because the
// server cut it at its per-result size cap (#6987): every hit that is whole
// is kept, the half-written final one never matches.
const TITLE_URL_PAIR_RE = /\{"title":"((?:[^"\\]|\\.)*)","url":"((?:[^"\\]|\\.)*)"\}/g

function salvageTitleUrlPairs(text: string): Array<{ title?: string; url?: string }> {
  const out: Array<{ title?: string; url?: string }> = []
  for (const m of text.matchAll(TITLE_URL_PAIR_RE)) {
    const url = decodeJsonStringBody(m[2] ?? '')
    if (url === undefined) continue
    out.push({ title: coerceString(decodeJsonStringBody(m[1] ?? '')), url })
  }
  return out
}

const JSON_QUERY_HEAD_RE = /^\s*\{\s*"query"\s*:\s*"((?:[^"\\]|\\.)*)"/
// The text a Claude Agent SDK / CLI session forwards for WebSearch (#6987):
// `Web search results for query: "<q>"` header line(s), `Links:` line(s) of
// JSON (JSON.stringify never emits a raw newline), then the model's free-form
// commentary. Only the leading block of header / `Links:` / blank lines is
// read; the first line of anything else starts the commentary, and from there
// on nothing is scanned -- a `Links: [...]` line the model (or a fetched page
// it quotes) wrote in its commentary must not become a result row.
const FLAT_QUERY_RE = /^Web search results for query: "(.*)"[ \t]*$/
const FLAT_LINKS_RE = /^Links:[ \t]*(\[.*)$/

function parseFlatSearchText(text: string): { query?: string; candidates: Array<{ title?: string; url?: string; snippet?: string }> } {
  const candidates: Array<{ title?: string; url?: string; snippet?: string }> = []
  let query: string | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '') continue
    const header = line.match(FLAT_QUERY_RE)
    if (header) {
      query ??= coerceString(header[1]?.trim())
      continue
    }
    const links = line.match(FLAT_LINKS_RE)
    if (!links) break // first commentary line
    const json = (links[1] ?? '').trimEnd()
    try {
      candidates.push(...collectResultCandidates(JSON.parse(json)))
    } catch {
      candidates.push(...salvageTitleUrlPairs(json))
    }
  }
  return query ? { query, candidates } : { candidates }
}

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
      // Truncated at the server's per-result cap (#6987): keep the complete
      // hits and the query written ahead of them. Anything else falls
      // through to the fallbacks below.
      candidates = salvageTitleUrlPairs(trimmed)
      if (candidates.length > 0) {
        query = coerceString(decodeJsonStringBody(trimmed.match(JSON_QUERY_HEAD_RE)?.[1] ?? ''))
      }
    }
  }

  if (candidates.length === 0) {
    const flat = parseFlatSearchText(text)
    if (flat.candidates.length > 0) {
      candidates = flat.candidates
      query = flat.query
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

// The head of a `JSON.stringify(WebFetchOutput)` cut at the wire cap, in the
// key order Claude Code writes (`bytes, code, codeText, result, durationMs,
// url` — sdk-tools.d.ts declares them in that order and a real transcript's
// `toolUseResult` has it). A different order simply doesn't match and the
// text renders as plain content, exactly as it did before #6987.
const SDK_FETCH_HEAD_RE = /^\s*\{\s*"bytes"\s*:\s*(\d+)\s*,\s*"code"\s*:\s*(\d{3})\s*,\s*"codeText"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"result"\s*:\s*"/
const SDK_FETCH_DURATION_RE = /"durationMs"\s*:\s*(\d+)/
const SDK_FETCH_URL_RE = /"url"\s*:\s*"((?:[^"\\]|\\.)*)"/
const MAX_CODE_TEXT = 80

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function buildSdkFetchResult(f: {
  url?: string; content: string; code: number; codeText?: string; bytes?: number; durationMs?: number
}): ParsedWebFetchResult {
  const codeText = f.codeText?.trim().slice(0, MAX_CODE_TEXT)
  return {
    ...(isSafeWebUrl(f.url) ? { url: f.url.trim() } : {}),
    content: f.content,
    code: f.code,
    ...(codeText ? { codeText } : {}),
    ...(isFiniteNumber(f.bytes) ? { bytes: f.bytes } : {}),
    ...(isFiniteNumber(f.durationMs) ? { durationMs: f.durationMs } : {}),
  }
}

/** Decode a JSON string body that may have been cut anywhere, including in
 *  the middle of an escape sequence (`\`, `\u00e`) or a surrogate pair. */
function decodeCutJsonString(raw: string): string | undefined {
  for (let trim = 0; trim <= 12 && trim <= raw.length; trim++) {
    const decoded = decodeJsonStringBody(raw.slice(0, raw.length - trim))
    if (decoded === undefined) continue
    // A cut between the halves of a surrogate pair leaves a lone high surrogate.
    return decoded.replace(/[\ud800-\udbff]$/, '')
  }
  return undefined
}

/**
 * Recognize the Agent SDK's `WebFetchOutput` as the claude-tui provider
 * forwards it: `JSON.stringify({ bytes, code, codeText, result, durationMs,
 * url })` (#6987). Strict on purpose — `code` (number), `result` (string)
 * and `url` (string) must all be present, so an arbitrary fetched JSON
 * document that merely has a `url` or `result` key is left as plain content.
 */
function parseSdkWebFetchOutput(text: string): ParsedWebFetchResult | null {
  try {
    const o: unknown = JSON.parse(text)
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const r = o as Record<string, unknown>
      if (isFiniteNumber(r.code) && typeof r.result === 'string' && typeof r.url === 'string') {
        return buildSdkFetchResult({
          url: r.url,
          content: r.result,
          code: r.code,
          codeText: coerceString(r.codeText),
          bytes: isFiniteNumber(r.bytes) ? r.bytes : undefined,
          durationMs: isFiniteNumber(r.durationMs) ? r.durationMs : undefined,
        })
      }
    }
    return null
  } catch {
    // Cut at the server's per-result cap: recover from the head below.
  }

  const head = text.match(SDK_FETCH_HEAD_RE)
  if (!head) return null
  const body = text.slice(head[0].length)
  let end = -1
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\') i++
    else if (c === '"') { end = i; break }
  }
  const content = decodeCutJsonString(end === -1 ? body : body.slice(0, end))
  if (content === undefined) return null
  // The body closed inside the cut, so `durationMs` / `url` (written after it)
  // may have survived. Only whole values count; a url cut mid-string does not.
  const tail = end === -1 ? '' : body.slice(end + 1)
  const url = decodeJsonStringBody(tail.match(SDK_FETCH_URL_RE)?.[1] ?? '')
  return buildSdkFetchResult({
    url,
    content,
    code: Number(head[2]),
    codeText: decodeJsonStringBody(head[3] ?? ''),
    bytes: Number(head[1]),
    durationMs: Number(tail.match(SDK_FETCH_DURATION_RE)?.[1] ?? Number.NaN),
  })
}

function formatByteSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * One-line fetch status for a header above the body (#6987), shared by both
 * clients: `HTTP 200 OK · 1.5 KB`. `ok` is false for any non-2xx code so a
 * renderer can flag it. Returns `null` when the result carries neither a
 * status code nor a size (every non-SDK shape), so no line is drawn.
 */
export function formatWebFetchStatus(parsed: ParsedWebFetchResult): { text: string; ok: boolean } | null {
  const hasCode = isFiniteNumber(parsed.code) && parsed.code > 0
  const hasBytes = isFiniteNumber(parsed.bytes) && parsed.bytes >= 0
  if (!hasCode && !hasBytes) return null
  const parts: string[] = []
  if (hasCode) parts.push(`HTTP ${parsed.code}${parsed.codeText ? ` ${parsed.codeText}` : ''}`)
  if (hasBytes) parts.push(formatByteSize(parsed.bytes!))
  const ok = !hasCode || (parsed.code! >= 200 && parsed.code! < 300)
  return { text: parts.join(' \u00b7 '), ok }
}

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

  if (text.trimStart()[0] === '{') {
    const sdk = parseSdkWebFetchOutput(text)
    if (sdk) return sdk
  }

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
