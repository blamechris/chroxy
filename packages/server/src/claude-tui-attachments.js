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

// #4023: extname() returns only the final extension, so `archive.tar.gz`
// becomes `.gz` — claude's Read-tool hint loses the "this is a tarball"
// signal. Explicit allowlist of common compound suffixes we care about
// preserving. Each entry MUST also pass SAFE_EXTENSION when split on `.`
// (no control chars / slashes / oversized parts), so the safety guarantee
// for individual extension components is unchanged.
const SAFE_COMPOUND_EXTENSIONS = new Set([
  '.tar.gz',
  '.tar.bz2',
  '.tar.xz',
  '.tar.zst',
])

// Module-load validation: every compound entry must start with a dot and
// every dot-separated component (after the leading dot) must independently
// pass SAFE_EXTENSION. This is the fail-fast guard for future additions —
// if someone adds `.tar.x/y` or `.tar.${huge}` to the set above, the
// module throws on import rather than silently letting an unsafe extension
// reach the on-disk filename. pickExtension() re-checks at use time too
// (defense in depth), but the use-time check returns the fallback
// silently; this one crashes loud at load.
for (const compound of SAFE_COMPOUND_EXTENSIONS) {
  if (typeof compound !== 'string' || !compound.startsWith('.')) {
    throw new Error(`SAFE_COMPOUND_EXTENSIONS entry must start with a dot: ${JSON.stringify(compound)}`)
  }
  const parts = compound.split('.').slice(1)
  if (parts.length < 2) {
    throw new Error(`SAFE_COMPOUND_EXTENSIONS entry must have at least two components: ${compound}`)
  }
  for (const part of parts) {
    if (!SAFE_EXTENSION.test('.' + part)) {
      throw new Error(`SAFE_COMPOUND_EXTENSIONS component fails SAFE_EXTENSION: .${part} (in ${compound})`)
    }
  }
}

// #4024: sanity cap on the prompt suffix written to PTY. Path lengths
// under /tmp/chroxy-claude-tui/s-<uuid>/attachments/<msgId>/att-N.<ext>
// are typically ~150-200 bytes; 5 attachments * (~200 bytes path + ~100
// bytes metadata) ≈ 1.5KB, so today's typical case sits well under the
// cap. The cap exists as a guardrail against future regressions
// (deterministic content-hashed names, deeper base dirs, runaway
// attachment counts) producing a suffix large enough to stress PTY
// line-discipline buffers or the TUI's input box. It is NOT scoped to
// any specific kernel limit — canonical-mode truncation points vary by
// tty driver and the user's prompt text also counts toward whatever
// line buffer is in play, so a hard byte-equivalence to a real boundary
// isn't possible here. The value is set generously above realistic
// usage and conservatively below the smallest plausible limit; truncate
// explicitly rather than risk a silent chop that splits the user's
// prompt mid-suffix.
const MAX_ATTACHMENT_SUFFIX_BYTES = 8 * 1024

/**
 * Choose a file extension for an attachment. Prefer the original name's
 * extension when it exists AND is safe — the user picked it for a
 * reason, and we don't want to rename `.tsx` to `.txt` just because the
 * mediaType says text/plain. Falls back to the mediaType map, then to
 * `.bin`. An unsafe extension (control chars, path separators, absurd
 * length) is treated the same as "no extension" and goes to the
 * fallback.
 *
 * #4023: also detects common compound extensions (`.tar.gz`, `.tar.bz2`,
 * etc.) and preserves them so the on-disk filename keeps the "this is
 * a tarball" signal that bare `.gz` would lose. Lookup is case-
 * insensitive to match real-world `.TAR.GZ` filenames.
 *
 * @param {string} name
 * @param {string} mediaType
 * @returns {string} extension with leading dot; never empty (falls back to `.bin`)
 */
function pickExtension(name, mediaType) {
  if (typeof name === 'string' && name.length > 0) {
    // Compound-extension probe first — if `archive.tar.gz` matches we
    // want `.tar.gz`, not the `.gz` that extname() returns. Lowercase
    // the candidate for set lookup; preserve original case in the
    // returned value so the on-disk filename matches what the user sent.
    const lower = name.toLowerCase()
    for (const compound of SAFE_COMPOUND_EXTENSIONS) {
      if (lower.endsWith(compound)) {
        // Snap the original-case suffix off the source name to preserve
        // the user's capitalisation (e.g. .TAR.GZ stays .TAR.GZ).
        const ext = name.slice(name.length - compound.length)
        // Compound entries are validated at module load (see the
        // assertion loop after SAFE_COMPOUND_EXTENSIONS), so this
        // re-check is belt-and-suspenders against any future code path
        // that mutates the set at runtime. Fail-quiet here: drop through
        // to the extname fallback so a runtime-corrupted set degrades to
        // the single-extension behaviour rather than crashing the turn.
        if (ext.split('.').slice(1).every((part) => SAFE_EXTENSION.test('.' + part))) {
          return ext
        }
      }
    }
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
 * Empty input → empty-suffix result (caller appends, so an empty
 * suffix produces the original prompt unchanged).
 *
 * #4026: returns an AttachmentSuffixResult shape (not a string) so the
 * caller can log a warn when the cap fires. Pre-#4026 this returned
 * just the string and the truncation was silent.
 *
 * @typedef {Object} AttachmentSuffixResult
 * @property {string}  suffix         The prompt suffix to append (empty for no files).
 * @property {boolean} truncated      True when at least one file was dropped from the list.
 * @property {number}  omitted        Number of files dropped from the list (0 when not truncated).
 * @property {boolean} bareFallback   True when even the single-entry suffix didn't fit and we
 *                                    fell back to the size-cap marker (the worst, most-lossy path).
 * @property {number}  byteLength     Final UTF-8 byte length of the suffix string.
 * @property {number}  cap            The byte cap (MAX_ATTACHMENT_SUFFIX_BYTES) that triggered truncation.
 *
 * @param {Array<{path: string, name: string, mediaType: string, size: number}>} files
 * @returns {AttachmentSuffixResult}
 */

export function buildAttachmentsPromptSuffix(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { suffix: '', truncated: false, omitted: 0, bareFallback: false, byteLength: 0, cap: MAX_ATTACHMENT_SUFFIX_BYTES }
  }
  const items = files.map((f) => {
    const meta = [f.name, f.mediaType, formatBytes(f.size)].filter(Boolean).join(', ')
    return meta ? `${f.path} (${meta})` : f.path
  })
  // Single leading space so the suffix appends to whatever the user
  // typed without a hard newline. The square-bracketed prefix and
  // semicolon list keep the structure machine-recognisable for claude's
  // tool-selection heuristics without leaning on linebreaks.
  const fullSuffix = ` [I attached the following file(s) for you to read: ${items.join('; ')}]`
  // #4024: cap the suffix so an unusually long path list (deterministic
  // hash names, deeply-nested base dirs, future regressions) can't push
  // the PTY input over canonical-mode's silent ~4KB truncation point.
  // We drop trailing entries until the suffix fits, then mark the
  // truncation so the agent (and a human reading the transcript)
  // knows files were omitted.
  // Compute once: the cap-check below and the return-shape's byteLength
  // both consume this. Pre-#4215 nit: it was computed twice on the
  // happy path.
  const fullSuffixBytes = Buffer.byteLength(fullSuffix, 'utf8')
  if (fullSuffixBytes <= MAX_ATTACHMENT_SUFFIX_BYTES) {
    return {
      suffix: fullSuffix,
      truncated: false,
      omitted: 0,
      bareFallback: false,
      byteLength: fullSuffixBytes,
      cap: MAX_ATTACHMENT_SUFFIX_BYTES,
    }
  }
  // Drop one entry at a time from the end, re-checking the rebuilt
  // suffix each iteration. A more efficient binary search isn't worth
  // the complexity for N≤5 in normal usage; even at N=20 this is fine.
  const truncatedItems = items.slice()
  while (truncatedItems.length > 0) {
    const omitted = files.length - truncatedItems.length
    const candidate = ` [I attached the following file(s) for you to read: ${truncatedItems.join('; ')}; ...and ${omitted} more file(s) omitted from this list due to size]`
    if (Buffer.byteLength(candidate, 'utf8') <= MAX_ATTACHMENT_SUFFIX_BYTES) {
      return {
        suffix: candidate,
        truncated: true,
        omitted,
        bareFallback: false,
        byteLength: Buffer.byteLength(candidate, 'utf8'),
        cap: MAX_ATTACHMENT_SUFFIX_BYTES,
      }
    }
    truncatedItems.pop()
  }
  // Even the single-entry fallback didn't fit (one path > 8KB —
  // pathological). Return the bare marker; the files are still on disk
  // and the agent will at least know attachments were intended.
  const bare = ` [Attachment list omitted: ${files.length} file(s) exceeded the suffix size cap of ${MAX_ATTACHMENT_SUFFIX_BYTES}B]`
  return {
    suffix: bare,
    truncated: true,
    omitted: files.length,
    bareFallback: true,
    byteLength: Buffer.byteLength(bare, 'utf8'),
    cap: MAX_ATTACHMENT_SUFFIX_BYTES,
  }
}
