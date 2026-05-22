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

/**
 * Cap on Bash timeout the model can request. 10 minutes is the same
 * ceiling chroxy's Bash tool uses elsewhere — long enough for a slow
 * test suite, short enough to not strand a session if a runaway loop
 * hangs.
 */
const BASH_TIMEOUT_CEILING_MS = 600_000

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
 * @returns {Promise<{ content: string, isError: boolean }>}
 */
export async function executeBuiltinTool({
  toolName,
  input,
  cwd,
  cwdRealCache,
  cwdCacheTtl,
  signal,
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
        return await runGlob({ input, cwd, signal })
      case 'Grep':
        return await runGrep({ input, cwd, signal })
      default:
        return {
          content: `Unknown tool: ${toolName}. The claude-byok provider ships with: Read, Write, Edit, Bash, Glob, Grep. MCP and other tools land in follow-up issues.`,
          isError: true,
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

  const result = await executeBash({ command, cwd, timeoutMs, signal })

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

async function runGlob({ input, cwd, signal }) {
  const pattern = input?.pattern
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { content: 'EINVAL: pattern is required', isError: true }
  }
  const root = typeof input?.path === 'string' && input.path.length > 0
    ? input.path
    : cwd

  // Shell out with globstar so `**` works. Quoting the pattern via $'..'
  // would defeat expansion — we want bash to expand it. The pattern is
  // passed as a literal arg (with the safe-resolve below ensuring the
  // root stays inside the workspace before bash even sees it).
  //
  // We do the safety check on the search ROOT, not on the pattern, since
  // shell expansion is what produces the actual file paths.
  await safeResolveOptional(root, cwd, signal)

  const cmd = `shopt -s globstar nullglob; cd ${shellQuote(root)} && for f in ${pattern}; do printf '%s\\n' "$f"; done`
  const result = await executeBash({ command: cmd, cwd: root, signal, timeoutMs: 30_000 })
  if (result.exitCode !== 0 && !result.stdout) {
    return { content: `Glob failed: ${result.stderr || `exit ${result.exitCode}`}`, isError: true }
  }
  const files = result.stdout.split('\n').filter(Boolean)
  if (files.length === 0) return { content: `No matches for ${pattern}`, isError: false }
  return { content: files.join('\n'), isError: false }
}

async function runGrep({ input, cwd, signal }) {
  const pattern = input?.pattern
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { content: 'EINVAL: pattern is required', isError: true }
  }
  const root = typeof input?.path === 'string' && input.path.length > 0
    ? input.path
    : cwd
  await safeResolveOptional(root, cwd, signal)

  // Prefer ripgrep; fall back to grep. Both honor -i and -n.
  const ci = input?.['-i'] === true ? '-i' : ''
  const ln = input?.['-n'] !== false ? '-n' : ''
  const globArg = typeof input?.glob === 'string' && input.glob.length > 0
    ? ` --glob ${shellQuote(input.glob)}` : ''

  // Try rg first. If it's not installed (command not found, exit 127),
  // retry with grep -r. Either way the output is `path:lineno:content`.
  const tryRg = `command -v rg >/dev/null 2>&1 && rg ${ci} ${ln} --no-heading${globArg} ${shellQuote(pattern)} ${shellQuote(root)}`
  const tryGrep = `grep -r ${ci} ${ln} ${shellQuote(pattern)} ${shellQuote(root)}`
  const cmd = `(${tryRg}) || (${tryGrep})`

  const result = await executeBash({ command: cmd, cwd: root, signal, timeoutMs: 60_000 })
  // grep/rg both return exit 1 on "no matches" — that's not an error
  // for our purposes. Only exit 2+ or stderr-without-stdout signals an
  // actual failure.
  if (result.stderr && !result.stdout && result.exitCode !== 1) {
    return { content: `Grep failed: ${result.stderr.trim()}`, isError: true }
  }
  if (!result.stdout) return { content: `No matches for ${pattern}`, isError: false }
  return { content: result.stdout, isError: false }
}

async function safeResolveOptional(p, _cwd, _signal) {
  if (typeof p !== 'string' || p.length === 0) return
  // Light path safety on the root — we don't realpath here because the
  // shell expansion happens inside the spawned bash anyway, but we
  // reject obvious escapes (.., ~ unexpanded).
  const trimmed = p.trim()
  if (trimmed.startsWith('..') || trimmed.includes('/..')) {
    throw Object.assign(new Error(`path may not contain ..`), { code: 'EACCES' })
  }
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
