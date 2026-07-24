import { stat, open } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { resolve, dirname, normalize, sep } from 'path'
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
 * Read+validate a single memory file that MUST resolve within one of the
 * given allowed roots — the read-only path-confinement guard for #6864.
 *
 * Symlink-safe: resolves the deepest existing real ancestor before the
 * containment check (same helper reader.js uses), so a symlinked parent
 * directory can't smuggle the target outside the allowed roots. The
 * containment check runs BEFORE any `stat`/`open` — a path outside the
 * allowed roots is never even stat'd, so its existence can't be inferred
 * from the response (mirrors the "don't leak existence as an oracle"
 * reasoning in readFileContent). The final open uses O_NOFOLLOW to close
 * the post-validation TOCTOU window (a symlink swapped in at the target
 * between validation and open is rejected, not followed).
 *
 * Never throws — every failure mode folds into `error`/`skipped` so a caller
 * can push the result straight onto the response array.
 *
 * @returns {Promise<{path: string|null, exists: boolean, content: string|null, truncated: boolean, skipped: boolean, error: string|null}>}
 */
async function readConfinedMemoryFile(lexicalAbsPath, allowedRoots) {
  const base = { path: lexicalAbsPath, exists: false, content: null, truncated: false, skipped: false, error: null }

  let resolvedPath
  try {
    resolvedPath = await realpathOfDeepestAncestor(lexicalAbsPath)
  } catch (err) {
    return { ...base, error: err.message || 'Failed to resolve path' }
  }

  const withinRoot = allowedRoots.some((root) => resolvedPath === root || resolvedPath.startsWith(root + sep))
  if (!withinRoot) {
    // Outside every allowed root — reject WITHOUT stat'ing (no existence oracle).
    return { ...base, path: resolvedPath, skipped: true, error: 'Outside allowed memory roots — read skipped' }
  }

  let fileStat
  try {
    fileStat = await stat(resolvedPath)
  } catch (err) {
    if (err.code === 'ENOENT') return { ...base, path: resolvedPath, exists: false }
    return { ...base, path: resolvedPath, error: err.code === 'EACCES' ? 'Permission denied' : (err.message || 'Unknown error') }
  }

  if (!fileStat.isFile()) {
    return { ...base, path: resolvedPath, exists: true, error: 'Not a regular file' }
  }
  if (fileStat.size > MAX_FILE_SIZE) {
    return { ...base, path: resolvedPath, exists: true, error: 'File too large (max 512KB)' }
  }

  let buf
  let fh
  try {
    fh = await open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    buf = await fh.readFile()
  } catch (err) {
    if (err.code === 'ELOOP') {
      // Symlink appeared at the canonical path after validation — reject.
      return { ...base, path: resolvedPath, exists: true, skipped: true, error: 'Access denied: possible symlink race — read skipped' }
    }
    return { ...base, path: resolvedPath, exists: true, error: err.message || 'Unknown error' }
  } finally {
    await fh?.close()
  }

  let content = buf.toString('utf-8')
  let truncated = false
  if (content.length > MAX_CONTENT_SIZE) {
    content = content.slice(0, MAX_CONTENT_SIZE)
    truncated = true
  }

  return { ...base, path: resolvedPath, exists: true, content, truncated }
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
    const entry = await readConfinedMemoryFile(lexicalTarget, allowedRoots)
    const key = entry.path || lexicalTarget
    if (visited.has(key)) continue // cycle guard
    visited.add(key)
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
   * (session cwd, user's ~/.claude) via `readConfinedMemoryFile` — an import
   * resolving outside both is reported (for provenance/transparency) with
   * `skipped: true` and is never opened.
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
