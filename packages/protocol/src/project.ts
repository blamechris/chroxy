/**
 * Shared project-name derivation (audit P2-2, closes #5850).
 *
 * Single source of truth for turning a working directory into a project name,
 * consumed by BOTH:
 *   - the claude-hooks emitter (`packages/claude-hooks/src/project.js`), which
 *     walks the tree right where the session runs and sends `project` explicitly;
 *   - the server's `POST /api/events` fallback (`event-ingest.js`), used when an
 *     event arrives without `project`.
 *
 * Previously these were two byte-divergent copies; the hook half accreted the
 * worktree fixes (#5439/#5464/#5483) the server half lacked, so every fix had to
 * be re-derived. This module unifies them.
 *
 * **Zod-free by design.** This file imports ONLY node builtins so the
 * `@chroxy/protocol/project` subpath stays free of the Zod barrel — the hook
 * runs on every Claude Code event inside a <100ms budget and must not pull Zod.
 *
 * Path handling is cross-platform (`isAbsolute`/`relative`/`sep`); the two
 * test-surface env overrides from each former copy are both honored so neither
 * package's fixtures change (`CHROXY_WORKTREES_ROOT` /
 * `CHROXY_HOOKS_CHROXY_WORKTREES_ROOT`, and `CHROXY_HOOKS_TMP_PREFIXES`).
 */

import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

type ProjectEnv = Record<string, string | undefined>

/** Default to process.env without depending on the `process` global type (tsconfig `types: []`). */
function defaultEnv(): ProjectEnv {
  const g = globalThis as { process?: { env?: ProjectEnv } }
  return g.process?.env ?? {}
}

/**
 * Agent worktree checkouts live under <parent>/.claude/worktrees/<name>. The
 * marker is matched separator-agnostically (`/` or `\`) so a Windows path
 * (realpathSync returns backslashes) still folds into the parent project rather
 * than mis-attributing to the `agent-*` basename (#5886). On POSIX paths the
 * regex matches at the exact same index as the old `/.claude/worktrees/` literal.
 */
const WORKTREE_MARKER_RE = /[/\\]\.claude[/\\]worktrees[/\\]/

/** Index of the agent-worktree marker in `dir`, or -1. Exported for cross-platform tests. */
export function _worktreeMarkerIndex(dir: string): number {
  return dir.search(WORKTREE_MARKER_RE)
}

/** POSIX temp roots (plus their macOS /private realpaths) — never project sessions. */
const POSIX_TMP_PREFIXES = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']

/**
 * Built-in temp roots for the RUNNING platform. The POSIX literals never match
 * a Windows path, so on win32 use the real temp dir (`os.tmpdir()`),
 * realpath-resolved. Platform-conditional so POSIX behavior is unchanged (#5886).
 */
function defaultTmpPrefixes(): string[] {
  if (platform() === 'win32') {
    const t = realResolve(tmpdir())
    return t ? [t] : []
  }
  return POSIX_TMP_PREFIXES
}

/**
 * True if `dir` equals `prefix` or is nested directly under it. Separator-
 * agnostic (normalizes `\`→`/` for the boundary check) and trailing-separator
 * tolerant, so a Windows path matches a Windows prefix. On POSIX forward-slash
 * paths this is a no-op normalization → identical to the old
 * `dir === prefix || dir.startsWith(prefix + '/')`. Exported for cross-platform tests.
 */
export function _pathWithinPrefix(prefix: string, dir: string): boolean {
  const np = prefix.replace(/[/\\]+$/, '').replace(/\\/g, '/')
  const nd = dir.replace(/\\/g, '/')
  return nd === np || nd.startsWith(np + '/')
}

/** resolve() then realpath (macOS: /tmp → /private/tmp); best-effort, never throws. */
function realResolve(p: string): string | null {
  let dir: string
  try {
    dir = resolve(p)
  } catch {
    return null
  }
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/**
 * Test-surface override (split on `path.delimiter`) for the tmp classification.
 * On Linux os.tmpdir() IS /tmp, so test fixtures built under the OS temp dir
 * would classify as 'tmp' and legit-repo tests fail on CI but pass on macOS.
 * Tests point this at a path that doesn't exist so their fixtures classify by
 * the real rules. Never set in production. An unusable override (no absolute
 * prefixes) falls back to the built-in list rather than silently disabling
 * suppression.
 */
function tmpPrefixes(env: ProjectEnv): string[] {
  const raw = env?.CHROXY_HOOKS_TMP_PREFIXES
  if (typeof raw !== 'string' || raw.length === 0) return defaultTmpPrefixes()
  const prefixes = raw
    // `path.delimiter` is `:` on POSIX (unchanged) and `;` on Windows, so a
    // drive-letter override like `C:\Temp;D:\Tmp` splits correctly (#5886).
    .split(delimiter)
    .map((p) => p.trim().replace(/[/\\]+$/, ''))
    .filter((p) => isAbsolute(p))
  return prefixes.length > 0 ? prefixes : defaultTmpPrefixes()
}

/**
 * chroxy's SECOND worktree source — session worktrees the daemon creates at
 * `~/.chroxy/worktrees/<sessionId>` (`git worktree add --detach`). The basename
 * is an OPAQUE hex session id, so the parent project is NOT in the path — it has
 * to be recovered from the worktree's `.git` file (see
 * chroxyWorktreeParentProject).
 *
 * Test-surface override: both former copies' names are honored
 * (`CHROXY_WORKTREES_ROOT` from the server side, `CHROXY_HOOKS_CHROXY_WORKTREES_ROOT`
 * from the hook side) so neither test suite's fixtures change. `isAbsolute`
 * covers POSIX (`/…`) and Windows (`C:\…`, `\\…`) roots. An unusable override
 * falls back to the real default rather than silently disabling classification.
 */
function chroxyWorktreesRoot(env: ProjectEnv = defaultEnv()): string | null {
  const rawOverride = env?.CHROXY_WORKTREES_ROOT ?? env?.CHROXY_HOOKS_CHROXY_WORKTREES_ROOT
  // Strip trailing separators BEFORE the absolute check so a bare-root override
  // like '/' collapses to '' and falls through to the $HOME default rather than
  // resolving against cwd (matches the hook's original behavior).
  const override = (typeof rawOverride === 'string' ? rawOverride.trim() : '').replace(/[/\\]+$/, '')
  if (override.length > 0 && isAbsolute(override)) {
    return realResolve(override)
  }
  // #7052 — the daemon creates worktrees at `configPath('worktrees')`, which
  // follows CHROXY_CONFIG_DIR. Resolving `$HOME/.chroxy/worktrees` here instead
  // would put this module and session-manager.js on different roots the moment
  // the var is set, and `classifyNonProjectCwd` would stop recognising a chroxy
  // worktree — restoring the #5464 regression, where a session in one mints a
  // Discord status embed named after its opaque hex id instead of being
  // suppressed. Read off `env` rather than `process.env` so the hook side
  // (claude-hooks, which injects its own env) stays hermetic.
  const rawConfigDir = typeof env?.CHROXY_CONFIG_DIR === 'string' ? env.CHROXY_CONFIG_DIR.trim() : ''
  const configDir = rawConfigDir.replace(/[/\\]+$/, '')
  if (configDir.length > 0 && isAbsolute(configDir)) {
    return realResolve(join(configDir, 'worktrees'))
  }
  const home = typeof env?.HOME === 'string' && env.HOME.length > 0 ? env.HOME : homedir()
  if (!home) return null
  return realResolve(join(home, '.chroxy', 'worktrees'))
}

/**
 * If `dir` (already real-resolved) is inside a chroxy session worktree, return
 * that worktree's top dir (`<root>/<id>`); else null. The root itself is not one.
 */
function chroxyWorktreeTopDir(dir: string, env: ProjectEnv = defaultEnv()): string | null {
  const root = chroxyWorktreesRoot(env)
  if (!root) return null
  // relative()/sep are separator-agnostic (POSIX `/` and Windows `\`). `dir`
  // must be strictly inside root — a '..'/absolute relative means it escaped.
  const rel = relative(root, dir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const id = rel.split(sep)[0]
  return id.length > 0 ? join(root, id) : null
}

/**
 * Recover the owning repo PATH of a chroxy session worktree from its `.git` FILE:
 * `git worktree add` writes `gitdir: <repo>/.git/worktrees/<id>`, so the repo root
 * is three segments up. Returns null on any read/shape surprise — a tampered
 * `.git` file then can't point a caller (project attribution here, or the server's
 * `git worktree remove` GC) at an arbitrary path.
 *
 * Single source of truth for the chroxy-worktree `.git` parser (#5850 / #5869):
 * the server's worktree GC (`worktree-gc.js`) imports this instead of keeping its
 * own copy; `chroxyWorktreeParentProject` derives the project name from it.
 */
export function chroxyWorktreeRepoPath(worktreeDir: string): string | null {
  let raw: string
  try {
    raw = readFileSync(join(worktreeDir, '.git'), 'utf8')
  } catch {
    return null
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw)
  if (!match) return null
  let linkedGitDir: string
  try {
    // gitdir is absolute in practice; resolve() also covers relative ones.
    linkedGitDir = resolve(worktreeDir, match[1])
  } catch {
    return null
  }
  const worktreesDir = dirname(linkedGitDir) // <repo>/.git/worktrees
  if (basename(worktreesDir) !== 'worktrees') return null
  const gitDir = dirname(worktreesDir) // <repo>/.git
  // Strict shape: the linked gitdir must be <repo>/.git/worktrees/<id> — the
  // only shape `git worktree add` writes for the daemon's checkouts. Anything
  // else is a shape surprise → null, so a tampered .git file can't misattribute
  // the project (or target an arbitrary removal path).
  if (basename(gitDir) !== '.git') return null
  const repo = dirname(gitDir)
  return repo.length > 0 ? repo : null
}

/**
 * Parent project NAME for a chroxy session worktree: the basename of its owning
 * repo path (see chroxyWorktreeRepoPath). Returns null on any read/shape surprise.
 */
function chroxyWorktreeParentProject(worktreeDir: string): string | null {
  const repo = chroxyWorktreeRepoPath(worktreeDir)
  if (repo === null) return null
  const name = basename(repo)
  return name.length > 0 ? name : null
}

/**
 * #5439 GAP B: a cwd inside a worktree checkout belongs to the PARENT project —
 * the segment before /.claude/worktrees/ — not the agent-* checkout. #5464
 * extends this to chroxy session worktrees (~/.chroxy/worktrees/<id>): their
 * basename is an opaque session id, so the parent is parsed from the worktree
 * `.git` file's gitdir instead. The chroxy check runs FIRST — an agent worktree
 * nested INSIDE a chroxy worktree should still resolve to the real repo.
 */
export function worktreeParent(cwd: string, env: ProjectEnv = defaultEnv()): string | null {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const dir = realResolve(cwd)
  if (!dir) return null
  const chroxyTop = chroxyWorktreeTopDir(dir, env)
  if (chroxyTop) return chroxyWorktreeParentProject(chroxyTop)
  const idx = _worktreeMarkerIndex(dir)
  if (idx <= 0) return null
  const name = basename(dir.slice(0, idx))
  return name.length > 0 ? name : null
}

/**
 * Classify cwds that should not mint their own status embeds (#5439 GAP B):
 *
 *   'tmp'      — /tmp, /var/tmp (and their /private macOS realpaths)
 *   'home'     — the home directory ROOT itself (basename = username, not a
 *                project); projects under home are fine
 *   'worktree' — .claude/worktrees agent checkouts AND chroxy session worktrees
 *                under ~/.chroxy/worktrees/<id> (#5464)
 *
 * Returns null for normal project cwds or when no cwd is available.
 */
export function classifyNonProjectCwd(cwd: string, env: ProjectEnv = defaultEnv()): 'tmp' | 'home' | 'worktree' | null {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const dir = realResolve(cwd)
  if (!dir) return null
  for (const prefix of tmpPrefixes(env)) {
    if (_pathWithinPrefix(prefix, dir)) return 'tmp'
  }
  // Path-shape only — never gated on the .git gitdir parse succeeding: a session
  // in a chroxy worktree must stay suppressed even when the parent can't be
  // recovered (it would otherwise mint an opaque-id embed).
  if (WORKTREE_MARKER_RE.test(dir) || chroxyWorktreeTopDir(dir, env)) return 'worktree'
  const homeRaw = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : homedir()
  if (homeRaw) {
    let homeResolved: string | null
    try {
      homeResolved = resolve(homeRaw)
    } catch {
      homeResolved = null
    }
    if (dir === homeResolved || dir === realResolve(homeRaw)) return 'home'
  }
  return null
}

/** Walk up to the nearest `.git`, returning that dir's basename (or basename fallback). */
function gitRootName(cwd: string): string | null {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  let dir: string
  try {
    dir = resolve(cwd)
  } catch {
    return null
  }
  let current = dir
  // Bounded walk — terminates at the fs root anyway; the cap is paranoia.
  for (let i = 0; i < 256; i++) {
    try {
      if (existsSync(join(current, '.git'))) {
        const name = basename(current)
        return name.length > 0 ? name : null
      }
    } catch {
      return null
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const fallback = basename(dir)
  return fallback.length > 0 ? fallback : null
}

/**
 * HOOK entry point. Resolve the project name for the envelope: worktree-parent
 * remap first (#5439 GAP B — a worktree's own `.git` FILE would otherwise win
 * the walk and name the checkout), then the git root of the payload's cwd, then
 * $CLAUDE_PROJECT_DIR (Claude Code exports the project root there for hook
 * processes), then null (server-side derivation remains the last-resort fallback).
 */
export function deriveProject(cwd: string, env: ProjectEnv = defaultEnv()): string | null {
  const fromWorktree = worktreeParent(cwd, env)
  if (fromWorktree) return fromWorktree
  // #5483: inside a chroxy worktree (~/.chroxy/worktrees/<id>) the git walk can't
  // name the right project. We only reach here when `worktreeParent` already
  // returned null — the parent `.git` parse failed — so `gitRootName` would fall
  // back to the opaque session id. Skip it and defer to CLAUDE_PROJECT_DIR /
  // server-side derivation.
  const resolved = realResolve(cwd)
  if (resolved && chroxyWorktreeTopDir(resolved, env)) {
    const projectDir = env.CLAUDE_PROJECT_DIR
    if (typeof projectDir === 'string' && projectDir.length > 0) {
      const name = basename(resolve(projectDir))
      if (name.length > 0) return name
    }
    return null
  }
  const fromCwd = gitRootName(cwd)
  if (fromCwd) return fromCwd
  const projectDir = env.CLAUDE_PROJECT_DIR
  if (typeof projectDir === 'string' && projectDir.length > 0) {
    const name = basename(resolve(projectDir))
    if (name.length > 0) return name
  }
  return null
}

/**
 * SERVER entry point. Derive a project name from a working directory by walking
 * up to the nearest `.git` (directory OR file — worktrees use a `.git` file) and
 * taking that directory's basename. Falls back to `basename(cwd)` when no git
 * root is found, and `null` for unusable input. Pure fs probing.
 *
 * #5483/#5850: a cwd inside a chroxy session worktree (`~/.chroxy/worktrees/<id>`)
 * is handled FIRST — the git walk there would name the project after the opaque
 * session id (the worktree's `.git` is a file pointing back at the real repo), so
 * recover the parent repo from that file, or return null rather than mint the id.
 */
export function deriveProjectFromCwd(cwd: string, env: ProjectEnv = defaultEnv()): string | null {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  let dir: string
  try {
    dir = resolve(cwd)
  } catch {
    return null
  }
  // chroxy session worktree → parent repo (or null), never the opaque id.
  // Reuse the already-resolved `dir`; realpath best-effort (macOS /tmp → /private/tmp).
  let resolved: string
  try {
    resolved = realpathSync(dir)
  } catch {
    resolved = dir
  }
  const chroxyTop = chroxyWorktreeTopDir(resolved, env)
  if (chroxyTop) return chroxyWorktreeParentProject(chroxyTop)
  let current = dir
  // Bounded walk — terminates at the fs root anyway; the cap is paranoia against
  // pathological/cyclic resolutions.
  for (let i = 0; i < 256; i++) {
    try {
      if (existsSync(join(current, '.git'))) {
        const name = basename(current)
        return name.length > 0 ? name : null
      }
    } catch {
      return null
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const fallback = basename(dir)
  return fallback.length > 0 ? fallback : null
}

/** A project's canonical identity: a display label and the root it is rooted at. */
export interface CanonicalProject {
  label: string
  root: string
}

/** Pointer files (`.git`, `commondir`) are a line or two; anything bigger is hostile or corrupt. */
const GIT_POINTER_MAX_BYTES = 4096
/** A repo `config` is bigger, but still bounded: past this we refuse to guess. */
const GIT_CONFIG_MAX_BYTES = 64 * 1024

/**
 * Read a small REGULAR file without ever blocking. Opened O_RDONLY|O_NONBLOCK
 * (a FIFO then opens instantly instead of waiting for a writer) and fstat'd
 * before a byte is read: anything that is not a regular file, or is over
 * `maxBytes`, is refused. `{ absent: true }` when it does not exist; `null`
 * for everything else that is not usable so the caller fails closed.
 */
function readSmallFile(path: string, maxBytes: number = GIT_POINTER_MAX_BYTES): { text: string } | { absent: true } | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (err) {
    const code = (err as { code?: string }).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { absent: true } : null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) return null
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off)
      if (n <= 0) break
      off += n
    }
    return { text: buf.subarray(0, off).toString('utf8') }
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* best effort */
    }
  }
}

/** A real git dir: a directory holding a regular HEAD file. */
function isGitDirectory(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
    return statSync(join(dir, 'HEAD')).isFile()
  } catch {
    return false
  }
}

type CoreConfig = { bare: boolean; worktree: string | null }

/** Parse a git config value per git's rules; null = outside the supported subset (refuse). */
function parseConfigValue(raw: string): string | null {
  let out = ''
  let inQuote = false
  let keep = 0 // length of `out` that is not trailing unquoted whitespace
  let i = 0
  // leading whitespace is dropped
  while (i < raw.length && /[ \t]/.test(raw[i])) i++
  for (; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\') {
      const n = raw[++i]
      const esc = n === 'n' ? '\n' : n === 't' ? '\t' : n === 'b' ? '\b' : n === '"' ? '"' : n === '\\' ? '\\' : null
      if (esc === null) return null
      out += esc
      keep = out.length
      continue
    }
    if (c === '"') {
      inQuote = !inQuote
      keep = out.length
      continue
    }
    if (!inQuote && (c === '#' || c === ';')) break
    out += c
    if (inQuote || !/[ \t]/.test(c)) keep = out.length
  }
  if (inQuote) return null
  return out.slice(0, keep)
}

/** git_parse_maybe_bool + decimal integers; null = unsupported. */
function parseConfigBool(value: string | null): boolean | null {
  if (value === null) return true // `key` with no `=`
  const v = value.toLowerCase()
  if (v === '' || v === 'false' || v === 'no' || v === 'off') return false
  if (v === 'true' || v === 'yes' || v === 'on') return true
  if (/^[+-]?\d{1,15}$/.test(v)) return Number(v) !== 0
  return null
}

/**
 * Strict, git-compatible subset of config syntax, enough to read `core.bare` and
 * `core.worktree` exactly as git does. Anything outside it returns null so the
 * caller REFUSES (legacy name) instead of guessing:
 *  - only `[core]` counts (section names and keys are case-insensitive; `[core "x"]`
 *    and `[core.x]` are other sections); `[include]`/`[includeIf ...]` are refused;
 *  - `[section] key = value` on one line, `"` quoting, `\" \\ \n \t \b`, inline
 *    `#`/`;` comments outside quotes, trailing-backslash continuation;
 *  - booleans: true/yes/on/non-zero decimal and a bare key are true,
 *    false/no/off/0/empty are false, anything else refuses.
 * Exported (underscore) so tests can compare it with `git config` itself.
 */
export function _parseCoreConfig(text: string): CoreConfig | null {
  const joined = text.replace(/\r\n/g, '\n').replace(/\\\n/g, '')
  let inCore = false
  let bare = false
  let worktree: string | null = null
  for (const rawLine of joined.split('\n')) {
    let line = rawLine.replace(/^[ \t]+/, '')
    if (line === '' || line[0] === '#' || line[0] === ';') continue
    if (line[0] === '[') {
      const m = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line)
      if (!m) return null
      const name = m[1].toLowerCase()
      if (name === 'include' || name === 'includeif') return null
      inCore = name === 'core' && m[2] === undefined
      line = line.slice(m[0].length).replace(/^[ \t]+/, '')
      if (line === '' || line[0] === '#' || line[0] === ';') continue
    }
    if (!inCore) continue
    const kv = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=(.*))?$/.exec(line)
    if (!kv) return null
    const key = kv[1].toLowerCase()
    if (key === 'bare') {
      const value = kv[2] === undefined ? null : parseConfigValue(kv[2])
      if (kv[2] !== undefined && value === null) return null
      const b = parseConfigBool(value)
      if (b === null) return null
      bare = b
    } else if (key === 'worktree') {
      if (kv[2] === undefined) return null
      const value = parseConfigValue(kv[2])
      if (value === null) return null
      worktree = value.length > 0 ? value : null
    }
  }
  return { bare, worktree }
}

/** The repo's own config, or null when it is unreadable / outside the supported subset. */
function readCoreConfig(gitDir: string): CoreConfig | null {
  const config = readSmallFile(join(gitDir, 'config'), GIT_CONFIG_MAX_BYTES)
  if (config === null) return null
  return 'absent' in config ? { bare: false, worktree: null } : _parseCoreConfig(config.text)
}

/** Separate-git-dir / linked identity: a `.git` dir's parent, else the git dir itself minus `.git`. */
function identityOfCommonDir(commonDir: string): { root: string; label?: string } {
  if (basename(commonDir) === '.git') return { root: dirname(commonDir) }
  const stripped = basename(commonDir).replace(/\.git$/i, '')
  return { root: commonDir, label: stripped.length > 0 ? stripped : undefined }
}

/**
 * Identity of the repo a `.git` FILE (linked worktree, submodule, separate git
 * dir) belongs to, decided from git METADATA, never from directory names:
 *
 *  - the gitdir the file points at must be a real git dir (directory + regular HEAD);
 *  - `commondir` (linked worktree) names the common git dir, validated the same way;
 *  - the common dir's `config` `[core]` decides: `bare = true` -> null;
 *    `worktree = <p>` -> that path (relative to the common dir; submodules);
 *  - otherwise the identity is the common dir: its parent when it is named `.git`,
 *    else the common dir itself labelled without a trailing `.git` (a separate git
 *    dir: git records the MAIN working tree nowhere readable, so a main checkout
 *    and its linked worktrees deliberately agree on this answer).
 * Null on any malformed/oversized/unreadable/non-regular/unsupported input.
 */
function rootFromGitFile(holderDir: string): { root: string; label?: string } | null {
  const pointer = readSmallFile(join(holderDir, '.git'))
  if (!pointer || 'absent' in pointer) return null
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer.text)
  if (!match) return null
  const gitDir = resolve(holderDir, match[1])
  if (!isGitDirectory(gitDir)) return null
  const commondir = readSmallFile(join(gitDir, 'commondir'))
  if (commondir === null) return null
  let commonDir = gitDir
  if (!('absent' in commondir)) {
    const rel = commondir.text.trim()
    if (rel.length === 0) return null
    commonDir = resolve(gitDir, rel)
    if (!isGitDirectory(commonDir)) return null
  }
  const core = readCoreConfig(commonDir)
  if (core === null || core.bare) return null
  if (core.worktree) return { root: resolve(commonDir, core.worktree) }
  return identityOfCommonDir(commonDir)
}

/**
 * Canonical project identity for a working directory — the one answer a
 * linked worktree, an agent checkout and the main repo all agree on.
 *
 *  1. chroxy session worktree → its parent repo.
 *  2. nearest `.git` going up: a directory is the root; a FILE is resolved via
 *     `commondir` to the MAIN repo (never the linked folder's own name).
 *  3. no git root: tmp (incl. the realpath of os.tmpdir()) / home → null; anything else → the directory itself.
 *
 * Deliberately separate from `deriveProjectFromCwd`, whose historical outputs
 * (notifications, ingest) must not change. `root` is a realpath, best effort.
 */
export function canonicalProjectForCwd(cwd: string, env: ProjectEnv = defaultEnv()): CanonicalProject | null {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const dir = realResolve(cwd)
  if (!dir) return null
  const finish = (root: string, labelOverride?: string): CanonicalProject | null => {
    const real = realResolve(root)
    if (!real) return null
    const label = labelOverride ?? basename(real)
    return label.length > 0 ? { label, root: real } : null
  }
  const chroxyTop = chroxyWorktreeTopDir(dir, env)
  if (chroxyTop) {
    // Same bounded, validated metadata resolver as any linked worktree (not the legacy
    // chroxyWorktreeRepoPath reader, which blocks on a FIFO and trusts the pointer).
    const found = rootFromGitFile(chroxyTop)
    return found ? finish(found.root, found.label) : null
  }
  let current = dir
  for (let i = 0; i < 256; i++) {
    let kind: 'dir' | 'file' | null = null
    let exists = false
    try {
      const st = statSync(join(current, '.git'))
      exists = true
      kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
    }
    if (kind === 'dir') {
      const core = readCoreConfig(join(current, '.git'))
      if (core === null || core.bare) return null
      return finish(current)
    }
    if (kind === 'file') {
      const found = rootFromGitFile(current)
      return found ? finish(found.root, found.label) : null
    }
    if (exists) return null // a .git that is neither a directory nor a regular file (FIFO, socket): refuse
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const cls = classifyNonProjectCwd(dir, env)
  if (cls === 'tmp' || cls === 'home') return null
  // The OS temp dir is scratch space wherever it lives (macOS /var/folders, a $TMPDIR override).
  const osTmp = realResolve(tmpdir())
  if (osTmp && _pathWithinPrefix(osTmp, dir)) return null
  return finish(dir)
}
