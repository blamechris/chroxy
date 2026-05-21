/**
 * Materialize chroxy attachments to disk for the TUI provider (#4012).
 *
 * Pre-#4012 the TUI provider silently dropped attachments — the PTY only
 * accepts keystrokes, there's no way to inline image/document base64 the
 * way SDK/CLI do via multimodal content blocks. Instead we write each
 * attachment to a per-turn directory under the session's sink dir and
 * append a structured suffix to the prompt that names each file, so the
 * spawned `claude` TUI can use its Read tool to open them.
 *
 * Attachment shapes by the time they reach this module:
 *   image    { type: 'image',    mediaType, data (base64), name }
 *   document { type: 'document', mediaType, data (base64), name }
 *   (file_ref is resolved upstream in handler-utils.resolveFileRefAttachments)
 *
 * @module claude-tui-attachments
 */

import { mkdirSync, writeFileSync } from 'fs'
import { extname, join } from 'path'

// Anything outside this allowlist falls back to .bin so an unexpected
// mediaType (or one introduced in a future validator pass) doesn't fail
// the materialize() call — the user still sees the file, claude can
// still inspect it, just without an extension hint.
const MEDIA_TYPE_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
}

// Only treat a name-derived extension as safe if it's a short run of
// ASCII alphanumerics after a single leading dot. validateAttachments()
// only requires `name` to be a string, so a malicious client could pack
// control chars, slashes, or megabytes of junk into the extension and
// have it land in our on-disk `att-N<ext>` filename. This regex is the
// allowlist gate — anything that doesn't match falls back to the
// mediaType map or `.bin`.
const SAFE_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/

/**
 * Choose a file extension for an attachment. Prefer the original name's
 * extension when it exists AND is safe — the user picked it for a
 * reason, and we don't want to rename `.tsx` to `.txt` just because the
 * mediaType says text/plain. Falls back to the mediaType map, then to
 * `.bin`. An unsafe extension (control chars, path separators, absurd
 * length) is treated the same as "no extension" and goes to the
 * fallback.
 *
 * @param {string} name
 * @param {string} mediaType
 * @returns {string} extension with leading dot; never empty (falls back to `.bin`)
 */
function pickExtension(name, mediaType) {
  if (typeof name === 'string' && name.length > 0) {
    const fromName = extname(name)
    if (fromName && SAFE_EXTENSION.test(fromName)) return fromName
  }
  return MEDIA_TYPE_EXTENSIONS[mediaType] || '.bin'
}

/**
 * Sanitize an attachment name for inclusion in a filesystem path. The
 * stored filename is always `att-N<ext>` for predictability and
 * collision safety; the original name only appears in the prompt
 * suffix where it can't be weaponised as a path component. This guard
 * is defense-in-depth — we trim the original `name` here so a malicious
 * value can't slip through if a future refactor passes it to writeFileSync.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeDisplayName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'attachment'
  // Strip path separators + control chars; cap length.
  return name.replace(/[/\\\x00-\x1f]/g, '_').slice(0, 200)
}

/**
 * Format an approximate file size for the prompt suffix. The TUI sees a
 * short hint so the agent (and the user reading the transcript) knows
 * roughly what they're dealing with. Exact-byte counts are noisy on
 * megabyte-sized images; we round to one decimal in KB/MB.
 */
function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Write attachments to disk under `<baseDir>/<turnSlug>/` and return
 * metadata about each one. Caller is responsible for the baseDir (the
 * TUI session's sink dir) and the turnSlug (so each turn's attachments
 * live in their own subdir and we can drop them when the turn ends —
 * though for now they persist for the session's lifetime; sinkDir is
 * rmSync'd on destroy).
 *
 * @param {Array} attachments — already validated by validateAttachments
 *   AND resolved by resolveFileRefAttachments (so no file_ref entries)
 * @param {string} baseDir — typically <sinkDir>/attachments
 * @param {string} turnSlug — per-turn subdir name (e.g. messageId)
 * @returns {Array<{ path: string, name: string, mediaType: string, size: number }>}
 *   Empty array if attachments is null/empty.
 */
export function materializeAttachments(attachments, baseDir, turnSlug) {
  if (!Array.isArray(attachments) || attachments.length === 0) return []
  const dir = join(baseDir, turnSlug)
  mkdirSync(dir, { recursive: true })
  const out = []
  // Use a separate counter for the on-disk filename so a skipped
  // attachment (missing data, unresolved file_ref) doesn't leave a
  // hole in the sequence. Without this you can end up with only
  // `att-2.png` on disk when the first attachment is malformed —
  // confusing both for the agent reading the suffix and for anyone
  // poking the sink dir by hand.
  let n = 0
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    // Defensive: we expect upstream validation to catch this, but if a
    // file_ref ever slips through unresolved we'd crash on the base64
    // decode below. Skip silently rather than crash the whole turn.
    if (!att || typeof att.data !== 'string') continue
    n++
    const ext = pickExtension(att.name, att.mediaType)
    // Predictable, collision-free filename: att-1.png, att-2.txt, ...
    // (NOT the user-supplied name — see sanitizeDisplayName comment.)
    // Numbered against the count of SUCCESSFULLY materialized files,
    // not the input index, so skips don't create gaps.
    const filename = `att-${n}${ext}`
    const fullPath = join(dir, filename)
    const buf = Buffer.from(att.data, 'base64')
    writeFileSync(fullPath, buf)
    out.push({
      path: fullPath,
      name: sanitizeDisplayName(att.name),
      mediaType: typeof att.mediaType === 'string' ? att.mediaType : 'application/octet-stream',
      size: buf.length,
    })
  }
  return out
}

/**
 * Build the prompt suffix that names each materialized attachment so the
 * TUI agent knows where to find them.
 *
 * IMPORTANT (#4012 review follow-up): the suffix MUST be a SINGLE LINE
 * with no embedded `\n`. The TUI's PTY input box treats every newline
 * as Enter, so a multi-line suffix would prematurely submit on the
 * first line and the remaining lines would either drop or fire as
 * separate (malformed) turns. The same constraint is documented at
 * claude-tui-session.js where the skills-prefix code routes around it
 * via `--append-system-prompt` — we can't do that here because the
 * attachment list is per-turn user content, not session-level system
 * prompt. So: keep it one line, semicolon-separated.
 *
 * Empty input → empty string (caller appends, so an empty suffix
 * produces the original prompt unchanged).
 *
 * @param {Array<{path: string, name: string, mediaType: string, size: number}>} files
 * @returns {string}
 */
export function buildAttachmentsPromptSuffix(files) {
  if (!Array.isArray(files) || files.length === 0) return ''
  const items = files.map((f) => {
    const meta = [f.name, f.mediaType, formatBytes(f.size)].filter(Boolean).join(', ')
    return meta ? `${f.path} (${meta})` : f.path
  })
  // Single leading space so the suffix appends to whatever the user
  // typed without a hard newline. The square-bracketed prefix and
  // semicolon list keep the structure machine-recognisable for claude's
  // tool-selection heuristics without leaning on linebreaks.
  return ` [I attached the following file(s) for you to read: ${items.join('; ')}]`
}
