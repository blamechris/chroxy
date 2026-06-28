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
import { readdir, readFile, stat } from 'fs/promises'
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
 * `rootDir`; it is resolved and CONFINED to `rootDir` (a `..`-escape or absolute
 * path that lands outside is rejected). `rootDir` itself is trusted (the handler
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

  const root = resolve(rootDir)

  // Resolve + confine the optional scope path to the workspace root.
  let target = root
  if (path) {
    target = resolve(root, path)
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith('..' + sep) || resolve(root, rel) !== target) {
      // Escapes the workspace — refuse rather than leak host files.
      return { symbols: [], truncated: false }
    }
  }

  const symbols = []
  let filesRead = 0
  let truncated = false

  /** Parse one file into the accumulator, honouring the caps. */
  async function parseFile(absPath) {
    if (filesRead >= maxFiles) { truncated = true; return }
    let st
    try {
      st = await stat(absPath)
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
