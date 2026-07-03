/**
 * IDE symbol parser (#6471, epic #6469).
 *
 * A self-contained, dependency-free regex parser that extracts top-level symbol
 * declarations from workspace source files. The backbone for the symbol panel
 * (#6472), go-to-definition (#6475), and symbol search (#6476).
 *
 * WHY REGEX, NOT REPO-MEMORY / TREE-SITTER / LSP
 * ----------------------------------------------
 * The epic's original scoping pointed at the repo-memory AST index, but that is
 * an AGENT-facing MCP cache — the chroxy daemon has no verified runtime path to
 * it, and coupling the daemon to an MCP at request time is a heavy dependency.
 * So the daemon parses for itself: line-anchored regexes for the common
 * `export` / `function` / `class` / `const` / `interface` / `type` / `enum`
 * declaration forms. Deliberately ~80%-accurate and language-agnostic (a
 * data-driven rule table, easy to extend) — tree-sitter / LSP is the Phase-4
 * upgrade (#6479). No new binaries, no per-language servers, fully unit-testable.
 *
 * This module is PURE and side-effect-free except for reading files off disk in
 * `collectWorkspaceSymbols`. The opt-in `features.ide` gate lives at the handler
 * layer (handlers/ide-handlers.js); nothing here reads config or a socket.
 *
 * @typedef {Object} SymbolEntry
 * @property {string} name      Declared identifier.
 * @property {string} kind      One of: function, class, const, variable, interface, type, enum, method.
 * @property {string} file      Workspace-relative POSIX path of the declaring file.
 * @property {number} line      1-indexed line of the declaration.
 * @property {boolean} exported Whether the declaration is exported / public.
 */
import { readdir, readFile, stat, realpath, lstat } from 'fs/promises'
import { join, resolve, relative, extname, sep } from 'path'

// Directories never worth walking — build output, vendored deps, VCS metadata,
// language caches. Keeps the scan bounded and the symbol table signal-rich.
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.expo', '.turbo', '.cache', 'vendor', '__pycache__',
  '.venv', 'venv', '.tox', '.gradle', '.idea', '.vscode-test',
])

// Extension → language id. Only these files are parsed; everything else
// (binaries, assets, lockfiles) is skipped without a read.
const EXT_LANG = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.py': 'py', '.pyi': 'py',
}

// Per-language ordered rule tables. Each rule is applied in order to a line and
// the FIRST match wins (so `const enum X` resolves to `enum`, not `const`). The
// `name` group index is the capture holding the identifier; `exported` derives
// the visibility flag from the raw line + captured name.
//
// JS/TS notes: `const` whose right-hand side is an arrow or `function`
// expression is reported as a `function` (it is one, for navigation purposes);
// other `const`s are `const`, and `let`/`var` are `variable`. Only top-level-ish
// declarations are captured — the regexes are anchored at start-of-line allowing
// leading `export`/`default`/`async`/`abstract`, so indented class members are
// intentionally NOT matched (that is the ~80% line; #6479 raises it).
const JS_EXPORT = /^\s*export\b/
const RULES = {
  js: [
    {
      kind: 'function',
      re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
      name: 1,
    },
    {
      kind: 'class',
      re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      name: 1,
    },
    {
      kind: 'interface',
      re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      name: 1,
    },
    {
      kind: 'type',
      re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/,
      name: 1,
    },
    {
      kind: 'enum',
      re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
      name: 1,
    },
    {
      // const/let/var. Kind is refined below from the right-hand side.
      kind: 'const',
      re: /^\s*(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([^=].*)?$/,
      name: 2,
      refine: (m) => {
        const decl = m[1]
        const rhs = (m[3] || '').trim()
        // Arrow function or function-expression RHS ⇒ it's a function.
        if (/^(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/.test(rhs)) {
          return 'function'
        }
        return decl === 'const' ? 'const' : 'variable'
      },
    },
  ],
  py: [
    {
      kind: 'class',
      re: /^(\s*)class\s+([A-Za-z_]\w*)/,
      name: 2,
      indent: 1,
    },
    {
      // Top-level `def` ⇒ function; indented `def` ⇒ method.
      kind: 'function',
      re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/,
      name: 2,
      indent: 1,
      refine: (m) => (m[1].length > 0 ? 'method' : 'function'),
    },
  ],
}

/**
 * Parse a single source string into symbol entries. Pure — no I/O.
 *
 * @param {string} content  File contents.
 * @param {string} file     Workspace-relative POSIX path recorded on each entry.
 * @returns {SymbolEntry[]}
 */
export function parseSymbols(content, file) {
  if (typeof content !== 'string' || !content) return []
  const lang = EXT_LANG[extname(file).toLowerCase()]
  const rules = RULES[lang]
  if (!rules) return []

  const out = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Cheap skip for blank / comment-only lines (covers // # /* * leading forms).
    const trimmed = line.trimStart()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue
    }
    for (const rule of rules) {
      const m = line.match(rule.re)
      if (!m) continue
      const name = m[rule.name]
      if (!name) break
      const kind = rule.refine ? rule.refine(m) : rule.kind
      let exported
      if (lang === 'py') {
        // Top-level (indent 0) and not underscore-prefixed ⇒ public.
        exported = (rule.indent ? m[rule.indent].length === 0 : true) && !name.startsWith('_')
      } else {
        exported = JS_EXPORT.test(line)
      }
      out.push({ name, kind, file, line: i + 1, exported })
      break // first matching rule wins for a line
    }
  }
  return out
}

/**
 * Walk a workspace (or a sub-path of it) and collect symbols from every source
 * file, bounded so a huge tree can't exhaust memory or time. Returns the symbol
 * table plus a `truncated` flag set when any cap was hit.
 *
 * `path` (optional) scopes the scan to a single file or directory inside
 * `rootDir`; it is resolved to its REAL path and CONFINED to `rootDir` — a
 * `..`-escape, an absolute path, OR a symlink whose real target lands outside is
 * rejected, and scoping into ignored/dot dirs (node_modules, `.git`, …) is
 * refused for parity with the full scan. `rootDir` itself is trusted (the handler
 * passes the session's already home-validated cwd).
 *
 * @param {string} rootDir            Absolute workspace root (session cwd).
 * @param {object} [opts]
 * @param {string|null} [opts.path]   Workspace-relative file/dir to scope to.
 * @param {number} [opts.maxFiles]    Cap on files read (default 2000).
 * @param {number} [opts.maxSymbols]  Cap on symbols returned (default 5000).
 * @param {number} [opts.maxFileSize] Skip files larger than this (default 512KB).
 * @param {number} [opts.maxDepth]    Directory recursion depth (default 12).
 * @returns {Promise<{symbols: SymbolEntry[], truncated: boolean}>}
 */
export async function collectWorkspaceSymbols(rootDir, opts = {}) {
  const {
    path = null,
    maxFiles = 2000,
    maxSymbols = 5000,
    maxFileSize = 512 * 1024,
    maxDepth = 12,
  } = opts

  // Use the REAL (symlink-resolved) workspace root as the confinement base and
  // for displayed relative paths. A lexical resolve()/relative() alone is fooled
  // by a symlink INSIDE the workspace that points out — which, on this
  // attacker-reachable WS surface, would leak arbitrary host files.
  let root
  try {
    root = await realpath(resolve(rootDir))
  } catch {
    return { symbols: [], truncated: false }
  }

  // Resolve + confine the optional scope path against the REAL workspace root.
  let target = root
  if (path) {
    let realTarget
    try {
      realTarget = await realpath(resolve(root, path))
    } catch {
      // Absolute / `..` paths resolve outside root (rejected below); a missing or
      // broken-symlink path simply has nothing to enumerate. Either way, refuse.
      return { symbols: [], truncated: false }
    }
    const rel = relative(root, realTarget)
    if (rel === '..' || rel.startsWith('..' + sep) || resolve(root, rel) !== realTarget) {
      // The REAL path escapes the workspace (e.g. via a symlink) — refuse.
      return { symbols: [], truncated: false }
    }
    // Honour the same ignored-dir / dot-dir policy as the full-tree walk for the
    // scoped path, so scoping can't enumerate node_modules/.git/.venv symbols the
    // whole scan deliberately hides (e.g. `.git` hook scripts).
    if (rel.split(sep).some((s) => IGNORED_DIRS.has(s) || s.startsWith('.'))) {
      return { symbols: [], truncated: false }
    }
    target = realTarget
  }

  const symbols = []
  let filesRead = 0
  let truncated = false

  /** Parse one file into the accumulator, honouring the caps. */
  async function parseFile(absPath) {
    if (filesRead >= maxFiles) { truncated = true; return }
    let st
    try {
      // lstat (not stat) so a symlink is never followed here. The scoped target
      // is already realpath-confined and walk() skips symlink dirents, so this is
      // defence-in-depth that keeps parseFile symlink-blind for any future caller.
      st = await lstat(absPath)
    } catch { return }
    if (!st.isFile()) return
    if (st.size > maxFileSize) return
    if (!(extname(absPath).toLowerCase() in EXT_LANG)) return
    filesRead++
    let content
    try {
      content = await readFile(absPath, 'utf-8')
    } catch { return }
    const rel = relative(root, absPath).split(sep).join('/')
    for (const s of parseSymbols(content, rel)) {
      if (symbols.length >= maxSymbols) { truncated = true; return }
      symbols.push(s)
    }
  }

  /** Recursively walk a directory. */
  async function walk(dir, depth) {
    if (depth > maxDepth || filesRead >= maxFiles || symbols.length >= maxSymbols) {
      if (filesRead >= maxFiles || symbols.length >= maxSymbols) truncated = true
      return
    }
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch { return }
    // Stable ordering so output (and tests) are deterministic.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const ent of dirents) {
      if (filesRead >= maxFiles || symbols.length >= maxSymbols) { truncated = true; break }
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) {
        // Skip vendored/build/cache dirs and all dot-directories (config, VCS,
        // tool caches) — noisy and rarely source.
        if (IGNORED_DIRS.has(ent.name) || ent.name.startsWith('.')) continue
        await walk(abs, depth + 1)
      } else if (ent.isFile()) {
        await parseFile(abs)
      }
    }
  }

  let tstat
  try {
    tstat = await stat(target)
  } catch {
    return { symbols, truncated }
  }
  if (tstat.isFile()) {
    await parseFile(target)
  } else if (tstat.isDirectory()) {
    await walk(target, 0)
  }

  return { symbols, truncated }
}

// ---------------------------------------------------------------------------
// Workspace symbol-index cache (#6499)
// ---------------------------------------------------------------------------
//
// resolveSymbol and the whole-workspace list_symbols both do a FULL bounded walk
// on every call — a burst of cmd/ctrl+clicks over a tunnel re-parses the whole
// tree each time. This short-lived, invalidatable cache holds the full-walk
// result (`collectWorkspaceSymbols(rootDir)` with no `path`) keyed by the REAL
// (symlink-resolved) workspace root, so a second lookup within the TTL filters
// the cached table instead of re-walking. Scoped (`path`-bearing) scans are NOT
// cached — they are cheap and varied; only the expensive no-path full walk is.
//
// Invalidation is TTL-based (a newly-added declaration resolves once the entry
// expires); `invalidateWorkspaceSymbolIndex()` clears everything for a future
// file-change signal or test teardown. The cached object is treated as READ-ONLY
// by every consumer (resolveSymbol reads, the handler serializes) — do not mutate
// it, or you corrupt the shared entry.
const DEFAULT_INDEX_TTL_MS = 5000
const MAX_INDEX_CACHE_ENTRIES = 16
const _indexCache = new Map() // realpath(root) → { result, expires }
let _indexHits = 0
let _indexMisses = 0

/**
 * Full-workspace symbol index with a short TTL cache (#6499). Same return shape
 * as `collectWorkspaceSymbols(rootDir)` (no path). Keyed by the realpath of the
 * root so two workspaces never share an entry, and so an in-workspace symlink
 * can't poison another root's key.
 *
 * @param {string} rootDir          Absolute workspace root (session cwd).
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]     Entry lifetime (default 5000ms).
 * @param {number} [opts.now]       Injectable clock for deterministic tests.
 * @returns {Promise<{symbols: SymbolEntry[], truncated: boolean}>}
 */
export async function getWorkspaceSymbolIndex(rootDir, opts = {}) {
  const { ttlMs = DEFAULT_INDEX_TTL_MS, now = Date.now() } = opts
  // Key by the REAL root — same base collectWorkspaceSymbols confines against. An
  // unresolvable root can't be cached safely; fall back to the (also-guarded,
  // empty-on-error) uncached walk.
  let key
  try {
    key = await realpath(resolve(rootDir))
  } catch {
    return collectWorkspaceSymbols(rootDir)
  }

  const hit = _indexCache.get(key)
  if (hit && hit.expires > now) {
    _indexHits++
    return hit.result
  }

  _indexMisses++
  const result = await collectWorkspaceSymbols(rootDir)
  // Bounded FIFO eviction — the daemon usually has one workspace, but never let a
  // long-lived process accumulate unbounded entries.
  _indexCache.delete(key) // drop any stale entry so re-insert lands as newest
  if (_indexCache.size >= MAX_INDEX_CACHE_ENTRIES) {
    const oldest = _indexCache.keys().next().value
    if (oldest !== undefined) _indexCache.delete(oldest)
  }
  _indexCache.set(key, { result, expires: now + ttlMs })
  return result
}

/**
 * Clear the workspace symbol-index cache (#6499) — every entry and the hit/miss
 * counters. No-arg / coarse by design: a hook for a future file-change signal or
 * a test teardown. TTL expiry is the routine invalidation path.
 */
export function invalidateWorkspaceSymbolIndex() {
  _indexCache.clear()
  _indexHits = 0
  _indexMisses = 0
}

/** Cache hit/miss/size counters (#6499) — for tests and diagnostics. */
export function _symbolIndexCacheStats() {
  return { hits: _indexHits, misses: _indexMisses, size: _indexCache.size }
}

/**
 * Resolve a symbol NAME to a single declaration location — the backbone of
 * go-to-definition (#6475, epic #6469). Reuses collectWorkspaceSymbols so the
 * same realpath confinement + bounded walk apply, filters the table to
 * declarations whose name matches exactly, and ranks the candidates:
 *   - an exported declaration outranks a local one (+2), so a cmd/ctrl+click on
 *     an imported symbol lands on its public definition, and
 *   - a declaration in the originating file outranks one elsewhere (+1), so a
 *     click on a locally-declared helper resolves in place.
 * Regex-parsed, so ~80% accurate with zero new deps — a genuine miss (name not
 * found, or only a usage exists) returns null and the caller reports a graceful
 * 'not found'. On a score tie the FIRST (walk-order-earliest, deterministic)
 * candidate wins.
 *
 * @param {string} rootDir           Absolute workspace root (session cwd).
 * @param {string} symbolName        Exact declared identifier to resolve.
 * @param {object} [opts]
 * @param {string|null} [opts.fromFile]  Workspace-relative POSIX path the click
 *                                       came from; used only to break ranking ties.
 * @returns {Promise<{file: string, line: number}|null>}
 */
export async function resolveSymbol(rootDir, symbolName, opts = {}) {
  const name = typeof symbolName === 'string' ? symbolName.trim() : ''
  if (!name) return null
  const { fromFile = null } = opts
  // Route through the TTL cache (#6499) so a burst of clicks doesn't re-walk the
  // tree each time; ttlMs/now (if present) are forwarded for deterministic tests.
  const { symbols } = await getWorkspaceSymbolIndex(rootDir, opts)
  let best = null
  let bestScore = -1
  for (const s of symbols) {
    if (s.name !== name) continue
    const score = (s.exported ? 2 : 0) + (fromFile && s.file === fromFile ? 1 : 0)
    if (score > bestScore) {
      best = s
      bestScore = score
    }
  }
  return best ? { file: best.file, line: best.line } : null
}
