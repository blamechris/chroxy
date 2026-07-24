import { stat, open } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { resolve, dirname, normalize, sep, extname } from 'path'
import { homedir } from 'os'
import { realpathOfDeepestAncestor } from './common.js'
import { encodeProjectPath } from '../jsonl-reader.js'

/** stat-size ceiling before attempting a read (matches readFileContent) */
const MAX_FILE_SIZE = 512 * 1024
/** returned content is truncated past this (matches readFileContent) */
const MAX_CONTENT_SIZE = 100 * 1024
/** max recursive @import hops — matches Claude Code's own import recursion cap */
const MAX_IMPORT_DEPTH = 4
/** hard ceiling on total import entries per read — defence against import fan-out */
const MAX_IMPORT_ENTRIES = 50
/**
 * Extensions an `@import` target may resolve to. Memory `@import`s are meant to
 * pull in MARKDOWN memory files, not arbitrary files — restricting the resolved
 * target to this allowlist blocks the sensitive-file class under an allowed root
 * (`~/.claude/.credentials.json`, `~/.claude/settings.json`, identity keys,
 * other projects' `~/.claude/projects/**` `.jsonl` transcripts, extensionless
 * files) that would otherwise resolve IN-BOUNDS and be surfaced to the client.
 * More robust than a filename blocklist — it closes the whole class. (#6971)
 */
const IMPORT_ALLOWED_EXTS = ['.md', '.markdown']
/**
 * Single "not readable — skipped" reason string shared by EVERY skip branch
 * (out-of-bounds, non-markdown `@import`, resolution failure). Reusing ONE
 * message keeps the skip entries byte-identical so a client cannot distinguish
 * "outside allowed roots" from "not a markdown file" from "couldn't resolve" —
 * no error-string oracle. (#6971)
 */
const MEMORY_SKIP_ERROR = 'Outside allowed memory roots — read skipped'

// Matches an `@path` memory-import reference (Claude Code's CLAUDE.md import
// syntax — see docs.claude.com "Manage Claude's memory" / "Import additional
// files"). Requires a non-word/non-@ character (or start-of-string) before the
// `@` so `user@example.com` / `foo@bar` prose is never mistaken for an import.
const IMPORT_RE = /(^|[^\w@])@([\w./~-][\w./~-]*)/g

/**
 * Strip fenced code blocks and inline code spans before import scanning — the
 * real @import syntax explicitly does NOT resolve inside code spans/blocks (a
 * backtick-wrapped `@README` stays literal). We only need the SET of import
 * paths, not their offsets, so stripped content is simply discarded.
 */
function stripCodeForImportScan(content) {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
}

function extractImportPaths(content) {
  const stripped = stripCodeForImportScan(content)
  const paths = []
  for (const m of stripped.matchAll(IMPORT_RE)) {
    // Trim common trailing sentence punctuation a markdown author would have
    // typed right after the path (period, comma, colon, closing paren).
    const p = m[2].replace(/[.,:;)]+$/, '')
    if (p) paths.push(p)
  }
  return paths
}

/**
 * Resolve an @import target to an absolute LEXICAL path.
 *   - `~/...` / `~`  -> resolved against the user's home directory
 *   - `/...`         -> already absolute
 *   - anything else  -> resolved relative to the DIRECTORY of the file that
 *     contained the @import (matches real Claude Code semantics: imports
 *     resolve relative to the importing file, not the session cwd).
 */
function resolveImportTarget(rawPath, importingFileAbsPath) {
  if (rawPath === '~' || rawPath.startsWith('~/')) {
    return normalize(resolve(homedir(), rawPath.slice(1).replace(/^\//, '')))
  }
  if (rawPath.startsWith('/')) {
    return normalize(rawPath)
  }
  return normalize(resolve(dirname(importingFileAbsPath), rawPath))
}

/**
 * True iff `p`'s extension is in the `@import` markdown allowlist
 * (case-insensitive) — see IMPORT_ALLOWED_EXTS. An extensionless path
 * (`extname` → '') is NOT markdown and is rejected.
 */
function hasMarkdownExt(p) {
  return IMPORT_ALLOWED_EXTS.includes(extname(p).toLowerCase())
}

/**
 * Phase 1 of the confined-memory-file read: resolve + validate a LEXICAL
 * target path within one of the given allowed roots WITHOUT touching file
 * content — no `stat`/`open`/read, just the markdown-extension gate,
 * symlink-safe realpath resolution, and the containment check. Split out
 * from `readConfinedMemoryFile` so a caller (namely `collectImports`) can
 * compute a target's cycle-guard identity — the resolved real path — and
 * consult the `visited` set BEFORE paying for the actual read, so a
 * duplicate/cyclical `@import` short-circuits before any I/O beyond this
 * lightweight resolution (#6971 perf follow-up).
 *
 * Symlink-safe: resolves the deepest existing real ancestor before the
 * containment check (same helper reader.js uses), so a symlinked parent
 * directory can't smuggle the target outside the allowed roots.
 *
 * With `{ requireMarkdownExt: true }` (the `@import` path passes this; the fixed
 * root files do NOT), a resolved target whose extension is not in
 * IMPORT_ALLOWED_EXTS is rejected up front — same skip shape as out-of-bounds —
 * closing the "@import a non-markdown sensitive file under ~/.claude" class (#6971).
 *
 * Never throws — every failure mode folds into a ready-to-push `skipEntry`
 * (byte-identical MEMORY_SKIP_ERROR shape, echoing the LEXICAL request path —
 * no distinguishing oracle) instead of a resolved path.
 *
 * @param {string} lexicalAbsPath - Absolute LEXICAL (pre-realpath) target path
 * @param {string[]} allowedRoots - Real-path roots the target must resolve within
 * @param {{requireMarkdownExt?: boolean}} [opts] - `@import`-only markdown-extension gate
 * @returns {Promise<{resolvedPath: string|null, skipEntry: object|null}>}
 */
async function resolveConfinedMemoryPath(lexicalAbsPath, allowedRoots, { requireMarkdownExt = false } = {}) {
  const base = { path: lexicalAbsPath, exists: false, content: null, truncated: false, skipped: false, error: null }

  // `@import` markdown allowlist (import path ONLY; the fixed root files are
  // exempt). A non-markdown target — `~/.claude/.credentials.json`,
  // `~/.claude/settings.json`, an identity key, a `.jsonl` transcript, an
  // extensionless file — is rejected with the SAME shape an out-of-bounds path
  // gets, so there's no distinguishing oracle between "out of bounds", "not
  // markdown", and "doesn't exist". Purely LEXICAL and BEFORE any realpath/stat,
  // so a non-markdown import never even touches the filesystem. (#6971)
  if (requireMarkdownExt && !hasMarkdownExt(lexicalAbsPath)) {
    return { resolvedPath: null, skipEntry: { ...base, skipped: true, error: MEMORY_SKIP_ERROR } }
  }

  let resolvedPath
  try {
    resolvedPath = await realpathOfDeepestAncestor(lexicalAbsPath)
  } catch {
    // Resolution failed (EACCES on an ancestor dir, symlink-depth ceiling, …).
    // Normalize to the identical clean-skip shape rather than echoing the raw
    // error message — no error-string oracle, no content leak. (#6971)
    return { resolvedPath: null, skipEntry: { ...base, skipped: true, error: MEMORY_SKIP_ERROR } }
  }

  const withinRoot = allowedRoots.some((root) => resolvedPath === root || resolvedPath.startsWith(root + sep))
  if (!withinRoot) {
    // Outside every allowed root — reject WITHOUT stat'ing (no existence oracle).
    // Echo the LEXICAL request path (base.path), NOT the realpath-resolved path,
    // so a skipped entry can't be used as a symlink-target oracle. (#6971)
    return { resolvedPath: null, skipEntry: { ...base, skipped: true, error: MEMORY_SKIP_ERROR } }
  }

  return { resolvedPath, skipEntry: null }
}

/**
 * Phase 2 of the confined-memory-file read: `stat`/`open`/read an ALREADY
 * resolved+validated real path (see `resolveConfinedMemoryPath`). The final
 * open uses O_NOFOLLOW to close the post-validation TOCTOU window (a symlink
 * swapped in at the target between validation and open is rejected, not
 * followed).
 *
 * @param {string} resolvedPath - Real (post-realpath, already containment-checked) path
 * @returns {Promise<{path: string, exists: boolean, content: string|null, truncated: boolean, skipped: boolean, error: string|null}>}
 */
async function readResolvedMemoryFile(resolvedPath) {
  const base = { path: resolvedPath, exists: false, content: null, truncated: false, skipped: false, error: null }

  let fileStat
  try {
    fileStat = await stat(resolvedPath)
  } catch (err) {
    if (err.code === 'ENOENT') return { ...base, exists: false }
    return { ...base, error: err.code === 'EACCES' ? 'Permission denied' : (err.message || 'Unknown error') }
  }

  if (!fileStat.isFile()) {
    return { ...base, exists: true, error: 'Not a regular file' }
  }
  if (fileStat.size > MAX_FILE_SIZE) {
    return { ...base, exists: true, error: 'File too large (max 512KB)' }
  }

  let buf
  let fh
  try {
    fh = await open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    buf = await fh.readFile()
  } catch (err) {
    if (err.code === 'ELOOP') {
      // Symlink appeared at the canonical path after validation — reject.
      return { ...base, exists: true, skipped: true, error: 'Access denied: possible symlink race — read skipped' }
    }
    return { ...base, exists: true, error: err.message || 'Unknown error' }
  } finally {
    await fh?.close()
  }

  let content = buf.toString('utf-8')
  let truncated = false
  if (content.length > MAX_CONTENT_SIZE) {
    content = content.slice(0, MAX_CONTENT_SIZE)
    truncated = true
  }

  return { ...base, exists: true, content, truncated }
}

/**
 * Read+validate a single memory file that MUST resolve within one of the
 * given allowed roots — the read-only path-confinement guard for #6864.
 * Thin composition of `resolveConfinedMemoryPath` (validate, no I/O beyond
 * resolution) + `readResolvedMemoryFile` (stat/open/read) — kept as a single
 * entry point for callers (the three fixed root files, the MEMORY.md
 * descriptor) that don't need to consult a cycle guard before reading.
 *
 * @param {string} lexicalAbsPath - Absolute LEXICAL (pre-realpath) target path
 * @param {string[]} allowedRoots - Real-path roots the target must resolve within
 * @param {{requireMarkdownExt?: boolean}} [opts] - `@import`-only markdown-extension gate
 * @returns {Promise<{path: string|null, exists: boolean, content: string|null, truncated: boolean, skipped: boolean, error: string|null}>}
 */
async function readConfinedMemoryFile(lexicalAbsPath, allowedRoots, opts = {}) {
  const { resolvedPath, skipEntry } = await resolveConfinedMemoryPath(lexicalAbsPath, allowedRoots, opts)
  if (skipEntry) return skipEntry
  return readResolvedMemoryFile(resolvedPath)
}

/**
 * Recursively resolve @imports referenced FROM `content`, appending entries
 * (depth-first, matching the order Claude Code itself would inline them) to
 * `outEntries`. `visited` is the whole-read cycle guard (keyed by resolved
 * real path, falling back to the lexical target for a skipped/unresolvable
 * one); `depth` enforces the same import-recursion ceiling Claude Code uses.
 */
async function collectImports(content, importingFileAbsPath, allowedRoots, visited, depth, outEntries) {
  if (depth > MAX_IMPORT_DEPTH) return
  for (const rawPath of extractImportPaths(content)) {
    if (outEntries.length >= MAX_IMPORT_ENTRIES) return
    const lexicalTarget = resolveImportTarget(rawPath, importingFileAbsPath)
    // Import targets are confined to the same roots AND restricted to markdown
    // memory files (the root files themselves are not) — see #6971. Resolve
    // the target's identity FIRST (no stat/open/read yet) so a duplicate
    // `@import` of an already-visited file — or a cycle back to one — hits
    // the `visited` check and short-circuits BEFORE the read, instead of
    // paying for a redundant stat/open/read only to discard it.
    const { resolvedPath, skipEntry } = await resolveConfinedMemoryPath(lexicalTarget, allowedRoots, { requireMarkdownExt: true })
    const key = resolvedPath || lexicalTarget
    if (visited.has(key)) continue // cycle/dup guard — before any read
    visited.add(key)
    const entry = skipEntry ?? await readResolvedMemoryFile(resolvedPath)
    outEntries.push({ ...entry, scope: 'import', importedFrom: importingFileAbsPath })
    if (entry.exists && entry.content && !entry.skipped && !entry.error) {
      await collectImports(entry.content, entry.path, allowedRoots, visited, depth + 1, outEntries)
    }
  }
}

/**
 * File reading operations for the effective merged CLAUDE.md memory stack.
 *
 * @param {Function} sendFn - (ws, message) => void
 * @param {Function} resolveSessionCwd - shared, cached CWD resolver (same one createReaderOps uses)
 * @returns {Object} memory operation methods
 */
export function createMemoryOps(sendFn, resolveSessionCwd) {
  /**
   * Resolve the effective merged CLAUDE.md memory stack for a session
   * (#6864, epic #6760) — the SERVER-side read counterpart to `appendMemory`
   * (#6861).
   *
   * Scopes, in Claude Code's own load/precedence order — see
   * https://code.claude.com/docs/en/memory ("content is ordered from the
   * filesystem root down to your working directory"; within one directory,
   * CLAUDE.local.md is read right after that directory's CLAUDE.md):
   *   1. global  — ~/.claude/CLAUDE.md          (loaded first, lowest precedence)
   *   2. project — <sessionCwd>/CLAUDE.md
   *   3. local   — <sessionCwd>/CLAUDE.local.md  (loaded last, highest precedence)
   * Managed/enterprise policy memory is out of scope — chroxy has no managed-
   * policy surface today. Chroxy also does not walk from the session cwd UP to
   * the filesystem root the way the real CLI does (every intermediate
   * directory's CLAUDE.md) — only the session cwd's own root files are read,
   * matching this slice's explicit path-confinement requirement.
   *
   * Every path here is SERVER-chosen — the request carries no client-supplied
   * path at all (mirrors `appendMemory`'s "target is chosen server-side"
   * design), so there is no client-controlled traversal surface for the three
   * root files. The ONLY variable input is @import references found INSIDE
   * those files' own content, which are confined to the same two roots
   * (session cwd, user's ~/.claude) via `readConfinedMemoryFile` AND restricted
   * to markdown targets (`.md`/`.markdown`) — an import resolving outside both
   * roots, or to a non-markdown file (e.g. `~/.claude/.credentials.json`), is
   * reported (for provenance/transparency) with `skipped: true` and is never
   * opened. #6971 added the markdown restriction so a malicious project
   * CLAUDE.md can't `@import` a sensitive non-memory file that happens to sit
   * under the ~/.claude allowed root.
   *
   * Also resolves the project's auto-generated MEMORY.md descriptor, keyed by
   * the SAME per-cwd path encoding `resolveJsonlPath` uses for transcript
   * storage (`encodeProjectPath` in jsonl-reader.js) — confirmed empirically
   * against a live `~/.claude/projects/` tree to be keyed by the literal
   * session cwd, not the git repository root (each worktree gets its own,
   * separate memory directory).
   */
  async function readMemoryStack(ws, sessionCwd, requestId) {
    const send = (payload) => sendFn(ws, requestId === undefined ? payload : { ...payload, requestId })

    if (!sessionCwd) {
      send({ type: 'memory_stack_result', entries: [], memoryFile: null, error: 'Memory is not available in this mode' })
      return
    }

    let cwdReal
    try {
      cwdReal = await resolveSessionCwd(sessionCwd)
    } catch (err) {
      send({ type: 'memory_stack_result', entries: [], memoryFile: null, error: err.message || 'Failed to resolve session directory' })
      return
    }

    let claudeHomeReal
    try {
      claudeHomeReal = await realpathOfDeepestAncestor(resolve(homedir(), '.claude'))
    } catch {
      claudeHomeReal = normalize(resolve(homedir(), '.claude'))
    }

    const allowedRoots = [cwdReal, claudeHomeReal]
    const visited = new Set()
    const entries = []

    const roots = [
      { scope: 'global', lexicalPath: resolve(claudeHomeReal, 'CLAUDE.md') },
      { scope: 'project', lexicalPath: resolve(cwdReal, 'CLAUDE.md') },
      { scope: 'local', lexicalPath: resolve(cwdReal, 'CLAUDE.local.md') },
    ]

    for (const { scope, lexicalPath } of roots) {
      const entry = await readConfinedMemoryFile(lexicalPath, allowedRoots)
      visited.add(entry.path || lexicalPath)
      entries.push({ ...entry, scope, importedFrom: null })
      if (entry.exists && entry.content && !entry.skipped && !entry.error) {
        await collectImports(entry.content, entry.path, allowedRoots, visited, 1, entries)
      }
    }

    // Auto-generated project memory (MEMORY.md) — restricted to the
    // ~/.claude root only (it never lives under the session cwd).
    const encoded = encodeProjectPath(cwdReal)
    const memoryFilePath = resolve(claudeHomeReal, 'projects', encoded, 'memory', 'MEMORY.md')
    const memoryFile = await readConfinedMemoryFile(memoryFilePath, [claudeHomeReal])

    send({ type: 'memory_stack_result', entries, memoryFile, error: null })
  }

  return {
    readMemory: readMemoryStack,
  }
}
