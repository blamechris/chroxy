/**
 * IDE content search (#6474, epic #6469) — find-in-project / codebase grep.
 *
 * A self-contained, dependency-free recursive content search over the session
 * workspace: case-insensitive substring match, returning file/line/column plus
 * the matched line as a preview. Powers the dashboard Cmd+Shift+F palette; it
 * also gives find-references (#6477) a reverse-lookup primitive.
 *
 * SECURITY — the walk mirrors collectWorkspaceSymbols (ide/symbols.js): the root
 * is realpath-resolved and an optional scope `path` is REAL-path confined to it
 * (a `..`-escape, an absolute path, or a symlink whose real target lands outside
 * is refused), ignored/dot dirs are skipped, and files are lstat'd so a symlink
 * is never followed. Keep the two confinement blocks in sync — both are the
 * attacker-reachable WS surface's boundary; the regression tests
 * (ide-search.test.js) assert the symlink-escape cases on both.
 */
import { readdir, readFile, stat, realpath, lstat } from 'fs/promises'
import { join, resolve, relative, extname, sep } from 'path'

// Directories never worth walking (mirrors symbols.js IGNORED_DIRS).
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.expo', '.turbo', '.cache', 'vendor', '__pycache__',
  '.venv', 'venv', '.tox', '.gradle', '.idea', '.vscode-test',
])

// Text file extensions we grep. Broader than symbols' EXT_LANG (which only
// parses js/py) — a codebase search should cover configs, docs, and other
// source languages — but still an allowlist so binaries/assets are skipped
// without a read.
const TEXT_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cc', '.cpp', '.hpp', '.cs', '.php', '.lua', '.sh', '.bash', '.zsh',
  '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.env', '.xml',
  '.html', '.htm', '.css', '.scss', '.less', '.svg', '.vue', '.svelte',
  '.md', '.mdx', '.txt', '.rst', '.sql', '.graphql', '.gql', '.proto',
])

// Extensionless / dotfile basenames worth grepping. Matched by FULL basename
// (lowercased) — `extname()` returns '' for a leading-dot file like `.env`, so
// these can't be caught by TEXT_EXT.
const TEXT_BASENAMES = new Set([
  '.env', '.gitignore', '.editorconfig', '.npmrc', '.nvmrc', '.babelrc',
  '.prettierrc', '.eslintrc', 'dockerfile', 'makefile', 'procfile', 'gemfile',
])

/**
 * Shared confined walk (#6474 search + #6477 find-references). Walks `rootDir`
 * (or a confined sub-path), reads each text file, and calls `matchLine(text)` per
 * line; `matchLine` returns an array of 1-indexed column positions where a match
 * starts. Each match becomes a `{file,line,column,text}` row, honouring the caps.
 *
 * SECURITY — this is the single confinement boundary for BOTH callers: the root
 * is realpath-resolved, an optional scope `path` is REAL-path confined (a
 * `..`-escape, an absolute path, or a symlink whose real target lands outside is
 * refused), ignored/dot dirs are skipped, and files are lstat'd so a symlink is
 * never followed. The regression tests in ide-search.test.js assert the
 * symlink-escape cases for both entry points.
 *
 * @param {string} rootDir            Absolute workspace root (session cwd).
 * @param {(line: string) => number[]} matchLine  Per-line matcher → 1-indexed columns.
 * @param {object} [opts]  path, maxFiles(2000), maxResults(500), maxFileSize(512KB),
 *                         maxDepth(12), maxLineLength(1000).
 * @returns {Promise<{results: Array<{file:string,line:number,column:number,text:string}>, truncated: boolean}>}
 */
async function collectMatches(rootDir, matchLine, opts = {}) {
  const {
    path = null,
    maxFiles = 2000,
    maxResults = 500,
    maxFileSize = 512 * 1024,
    maxDepth = 12,
    maxLineLength = 1000,
  } = opts

  // Realpath-confine the root (symlink-safe base) — see the security note above.
  let root
  try {
    root = await realpath(resolve(rootDir))
  } catch {
    return { results: [], truncated: false }
  }

  let target = root
  if (path) {
    let realTarget
    try {
      realTarget = await realpath(resolve(root, path))
    } catch {
      return { results: [], truncated: false }
    }
    const rel = relative(root, realTarget)
    if (rel === '..' || rel.startsWith('..' + sep) || resolve(root, rel) !== realTarget) {
      return { results: [], truncated: false }
    }
    if (rel.split(sep).some((s) => IGNORED_DIRS.has(s) || s.startsWith('.'))) {
      return { results: [], truncated: false }
    }
    target = realTarget
  }

  const results = []
  let filesRead = 0
  let truncated = false

  /** Grep one file into the accumulator, honouring the caps. */
  async function grepFile(absPath) {
    if (filesRead >= maxFiles) { truncated = true; return }
    const base = absPath.split(sep).pop().toLowerCase()
    const ext = extname(base)
    // Match by extension (foo.ts) OR by full basename for dotfiles / extensionless
    // well-known files (.env, .gitignore, Dockerfile, Makefile) — extname() is ''
    // for those, so the TEXT_EXT check alone would miss them.
    if (!TEXT_EXT.has(ext) && !TEXT_BASENAMES.has(base)) return
    let st
    try {
      // lstat (not stat) so a symlink is never followed — defence-in-depth; the
      // scoped target is realpath-confined and walk() skips symlink dirents.
      st = await lstat(absPath)
    } catch { return }
    if (!st.isFile()) return
    if (st.size > maxFileSize) return
    filesRead++
    let content
    try {
      content = await readFile(absPath, 'utf-8')
    } catch { return }
    // Skip a file that looks binary (a NUL in the first chunk) despite its ext.
    if (content.indexOf(String.fromCharCode(0)) !== -1) return
    const rel = relative(root, absPath).split(sep).join('/')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const cols = matchLine(lines[i])
      for (let c = 0; c < cols.length; c++) {
        if (results.length >= maxResults) { truncated = true; return }
        results.push({
          file: rel,
          line: i + 1,
          column: cols[c],
          text: lines[i].length > maxLineLength ? lines[i].slice(0, maxLineLength) : lines[i],
        })
      }
    }
  }

  /** Recursively walk a directory. */
  async function walk(dir, depth) {
    if (depth > maxDepth || filesRead >= maxFiles || results.length >= maxResults) {
      if (filesRead >= maxFiles || results.length >= maxResults) truncated = true
      return
    }
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch { return }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const ent of dirents) {
      if (filesRead >= maxFiles || results.length >= maxResults) { truncated = true; break }
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name) || ent.name.startsWith('.')) continue
        await walk(abs, depth + 1)
      } else if (ent.isFile()) {
        await grepFile(abs)
      }
    }
  }

  let tstat
  try {
    tstat = await stat(target)
  } catch {
    return { results, truncated }
  }
  if (tstat.isFile()) {
    await grepFile(target)
  } else if (tstat.isDirectory()) {
    await walk(target, 0)
  }

  return { results, truncated }
}

/**
 * Search the workspace (or a confined sub-path) for a case-insensitive substring
 * (#6474). One result per matching line (the first occurrence), matching the
 * find-in-project palette's expectation.
 *
 * @param {string} rootDir  Absolute workspace root (session cwd).
 * @param {string} query    Needle (min 2 chars after trim; else no-op).
 * @param {object} [opts]   See collectMatches.
 * @returns {Promise<{results: Array<{file:string,line:number,column:number,text:string}>, truncated: boolean}>}
 */
export async function searchContent(rootDir, query, opts = {}) {
  const needle = typeof query === 'string' ? query.trim() : ''
  // A 1-char search would match almost everything and swamp the result cap; the
  // dashboard also requires 2+ chars, so this is a cheap server-side guard too.
  if (needle.length < 2) return { results: [], truncated: false }
  const lowerNeedle = needle.toLowerCase()
  return collectMatches(rootDir, (line) => {
    const idx = line.toLowerCase().indexOf(lowerNeedle)
    return idx === -1 ? EMPTY_COLS : [idx + 1]
  }, opts)
}

const EMPTY_COLS = []

/**
 * Find all references to a symbol NAME (#6477) — reverse-lookup for the
 * find-all-references panel. Unlike searchContent this is a WORD-BOUNDARY,
 * case-SENSITIVE match (an identifier reference is exact + whole-word: `go`
 * matches `go()` but not `goHome` or `Cargo`), and it returns EVERY occurrence on
 * a line, not just the first. Regex-based over the same confined walk — ~80%
 * accurate with zero new deps (no scope/type analysis; a string literal or
 * comment mentioning the name is still a "reference").
 *
 * @param {string} rootDir  Absolute workspace root (session cwd).
 * @param {string} symbol   Identifier to find references to.
 * @param {object} [opts]   See collectMatches.
 * @returns {Promise<{results: Array<{file:string,line:number,column:number,text:string}>, truncated: boolean}>}
 */
export async function findReferences(rootDir, symbol, opts = {}) {
  const name = typeof symbol === 'string' ? symbol.trim() : ''
  // Only real identifiers — a non-identifier can't be word-boundary-matched
  // meaningfully and would risk a runaway regex.
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return { results: [], truncated: false }
  // Escape `$` (the only regex-special an identifier can contain) so a
  // `$`-prefixed name doesn't turn into an end-of-line anchor.
  const escaped = name.replace(/\$/g, '\\$&')
  // Explicit identifier boundaries — a plain `\b` is `\w`-relative and mishandles
  // `$`-names (`$` isn't a `\w` char): it MISSES a real `$store` and FALSE-matches
  // the `$store` tail inside `my$store`. `(?<![\w$])…(?![\w$])` treats `$` as part
  // of the identifier, so a reference must be flanked by non-identifier chars.
  const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g')
  return collectMatches(rootDir, (line) => {
    const cols = []
    re.lastIndex = 0
    let m
    while ((m = re.exec(line)) !== null) {
      cols.push(m.index + 1)
      if (m.index === re.lastIndex) re.lastIndex++ // zero-width guard (defensive)
    }
    return cols
  }, opts)
}
