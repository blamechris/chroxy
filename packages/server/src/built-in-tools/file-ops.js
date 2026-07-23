/**
 * Local file operations used by the claude-byok provider's Read, Write,
 * and Edit tools. Mirrors Claude Code's documented semantics:
 *
 *   Read   — line-numbered output with optional offset/limit + byte cap
 *   Write  — full-file write, truncate, mode 0644 by default
 *   Edit   — string-replace with strict-uniqueness check unless `replaceAll`
 *
 * Path-safety is the caller's responsibility — by the time we reach here
 * the BYOK tool executor has already run validateRawPathWithinCwd() from
 * ws-file-ops/common.js to defeat symlink escape attempts (including a `..`
 * after a symlinked component, #6923). These helpers receive realpaths that
 * are known to be inside the session cwd.
 *
 * Each function returns `{ ok: true, ... }` on success or
 * `{ ok: false, code, message }` on a recoverable error (file not found,
 * uniqueness violation, etc.). Unexpected errors throw — the executor
 * catches and surfaces them as tool errors to the model.
 */

import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyEdit, formatNumberedLines } from './tool-transforms.js'

export const DEFAULT_READ_MAX_BYTES = 256_000
// Single-sourced in tool-transforms.js (shared with the container Read); kept
// as a re-export for back-compat.
export { DEFAULT_READ_LINE_LIMIT } from './tool-transforms.js'

/**
 * Read a file, optionally with a line range. Lines are 1-indexed in
 * Claude Code's Read semantics, so `offset=1, limit=100` means "lines
 * 1..100". The output is line-numbered (`<5-digit>→<content>`) matching
 * what Claude Code's Read tool produces, so the model sees a consistent
 * shape across providers.
 *
 * On a binary file (NUL byte detected in the first 8KB) we refuse and
 * return ok:false with a clear code — the model should use a different
 * tool for binary inspection.
 */
export async function readFileTool({
  filePath,
  offset,
  limit,
  maxBytes = DEFAULT_READ_MAX_BYTES,
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, code: 'EINVAL', message: 'filePath is required' }
  }

  let st
  try {
    st = await stat(filePath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, code: 'ENOENT', message: `file not found: ${filePath}` }
    }
    throw err
  }
  if (!st.isFile()) {
    return { ok: false, code: 'ENOTFILE', message: `not a regular file: ${filePath}` }
  }
  // Always enforce the byte cap, even when a `limit` is provided.
  // Pre-fix, the cap was skipped when limit was set, so a multi-GB file
  // could still get fully read into memory if the caller passed a limit
  // (Copilot review on #4060). The slice-by-line approach below still
  // reads the whole file via readFile(), so the cap is the only thing
  // keeping us from OOMing on a giant input. If the file is too big,
  // refuse — model can re-request with offset to walk it in chunks.
  if (st.size > maxBytes) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: `file is ${st.size} bytes (cap ${maxBytes}); read a slice with an explicit offset against a smaller file or split it first`,
    }
  }

  const raw = await readFile(filePath)
  // Binary sniff on the first 8KB. NUL bytes are the cheapest reliable
  // signal; UTF-8 valid text rarely contains them.
  const sniff = raw.subarray(0, 8192)
  if (sniff.includes(0)) {
    return { ok: false, code: 'BINARY', message: `binary content in ${filePath}; Read is text-only` }
  }

  // Slice + line-number via the shared transform (same shape the container
  // produces via its in-container awk). Match Claude Code's tabular format:
  // 5-space-padded 1-indexed line number, then arrow, then the line.
  const text = raw.toString('utf8')
  const { content, totalLines, linesReturned, truncatedByLimit } = formatNumberedLines(text, { offset, limit })
  return { ok: true, content, totalLines, linesReturned, truncatedByLimit }
}

/**
 * Write a file, truncating any existing content. Creates the file and
 * any missing parent directories. Returns `created: true` when the
 * path did not exist before.
 *
 * The mkdir-recursive call is necessary because Node's writeFile does
 * NOT create parent dirs on its own — pre-fix, the doc comment claimed
 * the behavior but the code would ENOENT on a missing parent (Copilot
 * review on #4060).
 */
export async function writeFileTool({ filePath, content, mode = 0o644 } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, code: 'EINVAL', message: 'filePath is required' }
  }
  if (typeof content !== 'string') {
    return { ok: false, code: 'EINVAL', message: 'content must be a string' }
  }

  let existedBefore = true
  try {
    await stat(filePath)
  } catch (err) {
    if (err.code === 'ENOENT') existedBefore = false
    else throw err
  }

  // Ensure parent directory exists. recursive:true is a no-op when the
  // directory already exists, so this is safe to call unconditionally.
  // Path safety was already enforced by the caller (validateRawPathWithinCwd
  // in byok-tool-executor.js), so the dirname is guaranteed to be
  // inside the workspace cwd.
  if (!existedBefore) {
    await mkdir(dirname(filePath), { recursive: true })
  }

  await writeFile(filePath, content, { mode })
  return {
    ok: true,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
    created: !existedBefore,
  }
}

/**
 * String-replace edit matching Claude Code's semantics:
 *   - Without `replaceAll`: refuses if `oldString` appears more than
 *     once. This avoids the very common LLM mistake of asking for an
 *     "edit" that accidentally touches more than one site.
 *   - Without `replaceAll`: refuses if `oldString` is not found at all.
 *   - With `replaceAll: true`: replaces every occurrence; the count is
 *     reported back so the model can sanity-check.
 *
 * Errors are returned as ok:false so the model gets a clear feedback
 * loop instead of an exception bubbling up as "internal error".
 */
export async function editFileTool({
  filePath,
  oldString,
  newString,
  replaceAll = false,
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, code: 'EINVAL', message: 'filePath is required' }
  }
  if (typeof oldString !== 'string' || oldString.length === 0) {
    return { ok: false, code: 'EINVAL', message: 'oldString is required and must be non-empty' }
  }
  if (typeof newString !== 'string') {
    return { ok: false, code: 'EINVAL', message: 'newString must be a string' }
  }
  if (oldString === newString) {
    return { ok: false, code: 'NO_CHANGE', message: 'oldString and newString are identical' }
  }

  let content
  try {
    content = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, code: 'ENOENT', message: `file not found: ${filePath}` }
    }
    throw err
  }

  // Count + strict-uniqueness + LITERAL replacement via the shared transform
  // (also drives the docker-byok container Edit, so the semantics can't drift).
  // Type + NO_CHANGE were already handled above; map the remaining codes to the
  // path-ful messages this tool has always returned.
  const result = applyEdit(content, { oldString, newString, replaceAll })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') {
      return { ok: false, code: 'NOT_FOUND', message: `oldString not found in ${filePath}` }
    }
    if (result.code === 'NOT_UNIQUE') {
      return {
        ok: false,
        code: 'NOT_UNIQUE',
        message: `oldString matched ${result.matchCount} sites in ${filePath}; pass replaceAll=true or add surrounding context to make it unique`,
      }
    }
    return { ok: false, code: result.code, message: result.message }
  }

  await writeFile(filePath, result.next)
  return { ok: true, replacements: result.replacements, bytesWritten: Buffer.byteLength(result.next, 'utf8') }
}
