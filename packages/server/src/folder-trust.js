/**
 * Per-folder trust for project settings.
 *
 * Project settings (`.mcp.json`, `.claude/settings.json`, project `CLAUDE.md`,
 * skills, agents, commands) load ONLY after an explicit owner trust decision for
 * the folder. Every folder starts untrusted, including one with no command-bearing
 * files (trusting it loads its CLAUDE.md and other project settings).
 *
 * Trusting a folder trusts that repository: while trusted, Claude Code loads the
 * folder's project settings and picks up changes made to them during the session.
 * chroxy re-checks the files listed below at each launch and when the status line
 * runs, and asks again when they change. The digest is a change detector, not a
 * containment boundary.
 *
 * Files considered (absolute paths, hashed by full content):
 *   - `.mcp.json` and `.claude/settings.json` in the folder's real path and in every
 *     ancestor directory up to the filesystem root.
 *   - `.claude/skills`, `.claude/agents` and `.claude/commands` in the folder and in
 *     every ancestor (recursively, following symlinks with cycle detection).
 *   - the same three directories in every nested `.claude` below the folder, found
 *     by a bounded walk (symlinked directories followed, cycles refused) that skips
 *     `.git` and `node_modules`.
 *   - in a linked git worktree, the main checkout's `.claude/skills`.
 *   - the user's own Claude config directory is skipped wherever it appears, and
 *     `.claude/settings.local.json` is never considered.
 *
 * Incompleteness is always HARD and fails closed: any error other than "absent",
 * a non-regular file, a dangling or circular link, a file over the per-file limit,
 * or any budget exceeded (bytes, files, directories, entries, depth; a display scan
 * also has a wall-clock budget for the nested search, a launch scan does not, so its
 * answer does not depend on load). The folder is untrusted and cannot be
 * trusted. What is NOT covered by the digest: files that settings merely refer to
 * (hook scripts, for example), `CLAUDE.md` and rules. Trusting a folder trusts its code.
 *
 * Each file is read ONCE, with `O_NONBLOCK` and an `fstat` that rejects anything
 * that is not a regular file; the digest and the summary come from the same bytes.
 * Nothing here throws.
 */

import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync,
  readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Worker, SHARE_ENV } from 'node:worker_threads'
import { configPath } from './config-dir.js'
import { claudeConfigDir } from './utils/claude-config-dir.js'
import { canonicalJson, sha256Hex, withTrustStoreLock, writeFileAtomic0600 } from './byok-mcp-trust.js'
import { redactMcpUrl } from './byok-mcp-config.js'
import { createLogger } from './logger.js'

const log = createLogger('folder-trust')
/** On-disk record version. Other versions are dropped at load. */
export const FOLDER_TRUST_RECORD_VERSION = 2

/** Most files hashed in content directories before the scan is HARD-incomplete. */
export const MAX_SCANNED_FILES = 2000
/** Largest single file; a larger one is HARD. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024
/** Total bytes read across one scan; more is HARD. */
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024
/** Deepest directory level inside a content directory (HARD beyond). */
export const MAX_DEPTH = 16
/** Directories and entries read by all content traversals of one scan (HARD beyond). */
export const MAX_CONTENT_DIRS = 2000
export const MAX_CONTENT_ENTRIES = 20_000
/** Directories visited by the nested `.claude` search (HARD beyond). */
export const MAX_NESTED_DIRS = 20_000
/** Directory entries read by the nested search (HARD beyond). */
export const MAX_NESTED_ENTRIES = 200_000
/** Deepest level of the nested search (HARD beyond). */
export const MAX_NESTED_DEPTH = 32
/** Wall-clock budget of the nested search in a DISPLAY scan (HARD beyond). Launch scans have none. */
export const NESTED_BUDGET_MS = 1500
/** Limits of a display scan: the entry and depth bounds plus the wall-clock budget. */
const DISPLAY_LIMITS = Object.freeze({ nestedBudgetMs: NESTED_BUDGET_MS })
/** Largest config file parsed for the summary; a larger one is still hashed. */
export const MAX_PARSE_BYTES = 256 * 1024
/** Cache lifetime of a scan, for display and for the status line's folder-level check. */
export const SCAN_CACHE_TTL_MS = 2000

const CONTENT_DIRS = ['agents', 'skills', 'commands']
const MAX_SUMMARY_ITEMS = 50
const MAX_SUMMARY_STRING = 500
const SKIP_NESTED = new Set(['.git', 'node_modules'])
const O_READ = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0)

export function folderTrustStorePath() {
  return configPath('folder-trust.json')
}

const isAbsentCode = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR'
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/**
 * Real path of `p`. Only ENOENT falls back to the raw (resolved) path; any other
 * error is reported as `error` so the caller can refuse instead of guessing.
 * @returns {{ path: string, error?: string }}
 */
export function resolveRealPath(p) {
  try {
    return { path: realpathSync.native(p) }
  } catch (err) {
    if (err?.code === 'ENOENT') return { path: resolve(p) }
    return { path: resolve(p), error: err?.code || 'error' }
  }
}

/** Mutable state of one scan. */
function newScan(limits = {}) {
  return {
    limits: {
      maxFileBytes: limits.maxFileBytes ?? MAX_FILE_BYTES,
      maxTotalBytes: limits.maxTotalBytes ?? MAX_TOTAL_BYTES,
      maxFiles: limits.maxFiles ?? MAX_SCANNED_FILES,
      nestedBudgetMs: limits.nestedBudgetMs ?? Infinity,
    },
    // Directory-enumeration budgets: every directory and entry is counted as it is read.
    content: { dirs: 0, entries: 0, maxDirs: limits.maxContentDirs ?? MAX_CONTENT_DIRS, maxEntries: limits.maxContentEntries ?? MAX_CONTENT_ENTRIES },
    nested: { dirs: 0, entries: 0, maxDirs: limits.maxNestedDirs ?? MAX_NESTED_DIRS, maxEntries: limits.maxNestedEntries ?? MAX_NESTED_ENTRIES },
    bytes: 0,
    files: 0,
    hard: [],
    entries: [],
    config: [],
    counts: { agents: 0, skills: 0, commands: 0 },
  }
}

const hard = (scan, path, why) => { scan.hard.push(`${path}: ${why}`) }
/** A whole-scan refusal whose text stands alone. */
const hardNote = (scan, text) => { scan.hard.push(text) }

/** Real path inside a scan: any error but ENOENT is HARD. */
function realOf(p, scan) {
  const r = resolveRealPath(p)
  if (r.error) hard(scan, p, r.error)
  return r.path
}

/**
 * List one directory incrementally (`opendir`), counting each entry as it is read
 * and stopping at the budget BEFORE anything more is allocated.
 * @returns {{ absent: true } | { hard: string } | { entries: import('node:fs').Dirent[] }}
 */
function listDir(path, counter, deadline) {
  let dir
  try {
    dir = opendirSync(path)
  } catch (err) {
    return isAbsentCode(err) ? { absent: true } : { hard: err?.code || 'unreadable' }
  }
  const out = []
  try {
    counter.dirs += 1
    if (counter.dirs > counter.maxDirs) return { hard: `This folder is too large to review (more than ${counter.maxDirs} directories)` }
    for (;;) {
      const d = dir.readSync()
      if (!d) break
      counter.entries += 1
      if (counter.entries > counter.maxEntries) return { hard: `This folder is too large to review (more than ${counter.maxEntries} entries)` }
      if (deadline !== undefined && (counter.entries & 255) === 0 && Date.now() > deadline) {
        return { hard: 'This folder is too large to review (the search took too long)' }
      }
      out.push(d)
    }
  } catch (err) {
    return { hard: err?.code || 'unreadable' }
  } finally {
    try { dir.closeSync() } catch { /* nothing to do */ }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { entries: out }
}

/** Record a listDir refusal: budget notes stand alone, errors carry the path. */
function listingHard(scan, path, listing) {
  if (listing.hard.startsWith('This folder is too large')) hardNote(scan, listing.hard)
  else hard(scan, path, listing.hard)
}

/**
 * Read one file, once. Returns null when absent, `{ hard: true }` when it could not
 * be read faithfully (already recorded), else `{ buf, linkTarget }`. A symlink is
 * followed: the bytes are the target's.
 */
function readRegular(path, scan) {
  let lst
  try {
    lst = lstatSync(path)
  } catch (err) {
    if (isAbsentCode(err)) return null
    hard(scan, path, err?.code || 'unreadable')
    return { hard: true }
  }
  let linkTarget
  if (lst.isSymbolicLink()) {
    try { linkTarget = realpathSync.native(path) } catch { linkTarget = undefined }
  }
  let fd
  try {
    fd = openSync(path, O_READ)
  } catch (err) {
    // The path exists (lstat saw it), so ENOENT here is a dangling link.
    hard(scan, path, err?.code === 'ENOENT' ? 'dangling symlink' : (err?.code || 'unreadable'))
    return { hard: true }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) {
      hard(scan, path, 'not a regular file')
      return { hard: true }
    }
    if (st.size > scan.limits.maxFileBytes) {
      hard(scan, path, 'file too large to review')
      return { hard: true }
    }
    if (scan.bytes + st.size > scan.limits.maxTotalBytes) {
      hard(scan, path, 'too many bytes to review')
      return { hard: true }
    }
    const buf = Buffer.allocUnsafe(Math.min(st.size, scan.limits.maxFileBytes) + 1)
    let n = 0
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null)
      if (got === 0) break
      n += got
      if (n >= buf.length) break
    }
    if (n > scan.limits.maxFileBytes || n > st.size) {
      hard(scan, path, 'file changed while it was read')
      return { hard: true }
    }
    scan.bytes += n
    return { buf: buf.subarray(0, n), linkTarget }
  } catch (err) {
    hard(scan, path, err?.code || 'unreadable')
    return { hard: true }
  } finally {
    try { closeSync(fd) } catch { /* nothing to do */ }
  }
}

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex')

/** A settings-style file (`.mcp.json`, `settings.json`). */
function addConfigFile(path, kind, scan) {
  const r = readRegular(path, scan)
  if (!r || r.hard) return
  scan.entries.push({ path, sha256: sha256Buf(r.buf), ...(r.linkTarget ? { linkTarget: r.linkTarget } : {}) })
  scan.config.push({ path, kind, buf: r.buf })
}

/** Every file under one content directory. */
function walkContent(dir, sub, scan, stack, visited, depth) {
  const listing = listDir(dir, scan.content)
  if (listing.absent) return
  if (listing.hard) {
    listingHard(scan, dir, listing)
    return
  }
  for (const dirent of listing.entries) {
    const full = join(dir, dirent.name)
    let lst
    try {
      lst = lstatSync(full)
    } catch (err) {
      if (!isAbsentCode(err)) hard(scan, full, err?.code || 'unreadable')
      continue
    }
    let isDir = lst.isDirectory()
    let linkTarget
    if (lst.isSymbolicLink()) {
      let st
      try {
        st = statSync(full)
      } catch (err) {
        hard(scan, full, err?.code === 'ENOENT' ? 'dangling symlink' : (err?.code || 'unreadable'))
        continue
      }
      isDir = st.isDirectory()
      if (isDir) {
        const real = realOf(full, scan)
        if (stack.has(real)) {
          hard(scan, full, 'symlink cycle')
          continue
        }
        if (visited.has(real)) continue
        linkTarget = real
        scan.entries.push({ path: full, sha256: sha256Hex(`dirlink:${real}`), linkTarget })
      }
    }
    if (isDir) {
      if (depth >= MAX_DEPTH) {
        hard(scan, full, 'directory nesting too deep')
        continue
      }
      const real = realOf(full, scan)
      visited.add(real)
      stack.add(real)
      walkContent(full, sub, scan, stack, visited, depth + 1)
      stack.delete(real)
      continue
    }
    if (scan.files >= scan.limits.maxFiles) {
      hard(scan, dir, 'too many files to review')
      return
    }
    scan.files += 1
    const r = readRegular(full, scan)
    if (!r || r.hard) continue
    scan.counts[sub] += 1
    scan.entries.push({ path: full, sha256: sha256Buf(r.buf), ...(r.linkTarget ? { linkTarget: r.linkTarget } : {}) })
  }
}

/** One content root (`.claude/skills|agents|commands`): lstat it first, so a link to nowhere is HARD, not "absent". */
function scanContentRoot(dir, sub, scan) {
  let lst
  try {
    lst = lstatSync(dir)
  } catch (err) {
    if (!isAbsentCode(err)) hard(scan, dir, err?.code || 'unreadable')
    return
  }
  if (lst.isSymbolicLink()) {
    let st
    try {
      st = statSync(dir)
    } catch (err) {
      hard(scan, dir, err?.code === 'ENOENT' ? 'dangling symlink' : (err?.code || 'unreadable'))
      return
    }
    if (!st.isDirectory()) return
  } else if (!lst.isDirectory()) {
    return
  }
  const real = realOf(dir, scan)
  walkContent(dir, sub, scan, new Set([real]), new Set([real]), 0)
}

function scanContentLocation(dotClaude, scan) {
  for (const sub of CONTENT_DIRS) scanContentRoot(join(dotClaude, sub), sub, scan)
}

function ancestorsOf(realPath) {
  const dirs = []
  let current = realPath
  for (;;) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

/** `<main>/.claude` when `realPath` sits in a linked git worktree, else null. */
function mainCheckoutDotClaude(realPath, scan) {
  for (const dir of ancestorsOf(realPath)) {
    const git = join(dir, '.git')
    let lst
    try {
      lst = lstatSync(git)
    } catch (err) {
      if (!isAbsentCode(err)) hard(scan, git, err?.code || 'unreadable')
      continue
    }
    if (lst.isDirectory()) return null // the folder's own repository, not a linked worktree
    const r = readRegular(git, scan)
    if (!r || r.hard) return null
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(r.buf.toString('utf8'))
    if (!m) {
      hard(scan, git, 'unparsable .git file')
      return null
    }
    const gitdir = resolve(dir, m[1])
    // <main>/.git/worktrees/<name>
    const worktrees = dirname(gitdir)
    const mainGit = dirname(worktrees)
    if (worktrees.endsWith('worktrees') && mainGit.endsWith('.git')) return join(dirname(mainGit), '.claude')
    return null
  }
  return null
}

/**
 * Nested `.claude` directories below `root`, by a bounded breadth-first walk.
 * Symlinked directories are followed, with realpath cycle detection. Any budget
 * (directories, entries, depth, wall clock) running out is HARD.
 */
function findNestedDotClaude(root, rootReal, scan) {
  const found = []
  const queue = [[root, rootReal, 0]]
  const visited = new Set([rootReal])
  const deadline = Date.now() + scan.limits.nestedBudgetMs
  for (let head = 0; head < queue.length; head += 1) {
    const [dir, real, depth] = queue[head]
    if (Date.now() > deadline) {
      hardNote(scan, 'This folder is too large to review (the search took too long)')
      return found
    }
    const listing = listDir(dir, scan.nested, deadline)
    if (listing.absent) continue
    if (listing.hard) {
      listingHard(scan, dir, listing)
      if (listing.hard.startsWith('This folder is too large')) return found
      continue
    }
    for (const d of listing.entries) {
      const child = join(dir, d.name)
      let isDir = d.isDirectory()
      let childReal = join(real, d.name)
      if (d.isSymbolicLink()) {
        let st
        try {
          st = statSync(child)
        } catch (err) {
          hard(scan, child, err?.code === 'ENOENT' ? 'dangling symlink' : (err?.code || 'unreadable'))
          continue
        }
        isDir = st.isDirectory()
        if (!isDir) continue
        childReal = realOf(child, scan)
        if (real === childReal || real.startsWith(childReal.endsWith(sep) ? childReal : childReal + sep)) {
          hard(scan, child, 'symlink cycle')
          continue
        }
      }
      if (!isDir) continue
      if (d.name === '.claude') {
        if (dir !== root) found.push(child)
        continue
      }
      if (SKIP_NESTED.has(d.name)) continue
      if (visited.has(childReal)) continue
      visited.add(childReal)
      if (depth + 1 > MAX_NESTED_DEPTH) {
        hardNote(scan, `This folder is too large to review (more than ${MAX_NESTED_DEPTH} levels deep)`)
        return found
      }
      queue.push([child, childReal, depth + 1])
    }
  }
  return found
}

const clip = (value) => {
  const s = typeof value === 'string' ? value : String(value ?? '')
  return s.length > MAX_SUMMARY_STRING ? `${s.slice(0, MAX_SUMMARY_STRING)}…` : s
}

/** Take at most MAX_SUMMARY_ITEMS of `items`, noting what was left out. */
function capped(items, what, warnings) {
  if (items.length > MAX_SUMMARY_ITEMS) {
    warnings.push(`${items.length - MAX_SUMMARY_ITEMS} more ${what} not shown`)
    return items.slice(0, MAX_SUMMARY_ITEMS)
  }
  return items
}

function summarizeConfig(config, summary) {
  const { warnings } = summary
  let clipped = false
  const c = (v) => {
    const s = clip(v)
    if (s.length < String(v).length) clipped = true
    return s
  }
  for (const { path, kind, buf } of config) {
    if (buf.length > MAX_PARSE_BYTES) {
      warnings.push(`${path}: too large to summarize; it is still covered by the trust check`)
      continue
    }
    let doc
    try {
      doc = JSON.parse(buf.toString('utf8'))
    } catch {
      warnings.push(`${path}: not valid JSON`)
      continue
    }
    if (!doc || typeof doc !== 'object') continue
    if (kind === 'mcp') {
      const servers = doc.mcpServers
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue
      for (const name of capped(Object.keys(servers), 'MCP servers', warnings)) {
        const s = servers[name]
        if (!s || typeof s !== 'object') continue
        const item = { file: path, name: c(name) }
        if (typeof s.command === 'string') item.command = c(s.command)
        if (Array.isArray(s.args)) item.args = capped(s.args, 'arguments', warnings).map(c)
        if (typeof s.url === 'string') item.url = redactMcpUrl(s.url)
        if (typeof s.type === 'string') item.type = c(s.type)
        // Environment VALUES routinely hold credentials: only the keys are listed.
        if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) item.envKeys = capped(Object.keys(s.env), 'environment keys', warnings).map(c)
        summary.mcpServers.push(item)
      }
      continue
    }
    if (doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks)) {
      for (const event of capped(Object.keys(doc.hooks), 'hook events', warnings)) {
        const commands = []
        for (const group of Array.isArray(doc.hooks[event]) ? doc.hooks[event] : []) {
          for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
            if (typeof hook?.command === 'string') commands.push(hook.command)
          }
        }
        summary.hooks.push({ file: path, event: c(event), commands: capped(commands, 'hook commands', warnings).map(c) })
      }
    }
    const sl = doc.statusLine
    if (sl && typeof sl === 'object' && typeof sl.command === 'string') summary.statusLine.push({ file: path, command: c(sl.command) })
    if (doc.enabledPlugins && typeof doc.enabledPlugins === 'object' && !Array.isArray(doc.enabledPlugins)) {
      for (const key of capped(Object.keys(doc.enabledPlugins), 'plugins', warnings)) summary.enabledPlugins.push({ file: path, plugin: c(key) })
    }
  }
  if (clipped) warnings.push(`Some values longer than ${MAX_SUMMARY_STRING} characters were shortened`)
}

/**
 * Scan the command-bearing settings files that apply to `cwd`.
 *
 * @param {string} cwd
 * @param {object} [limits] - maxFileBytes, maxTotalBytes, maxFiles, maxNestedDirs, ...; `nestedBudgetMs`
 *   (wall clock of the nested search) is unset by default, so the result depends only on the folder
 * @returns {{
 *   realPath: string,
 *   files: { path: string, sha256: string }[],
 *   digest: string,
 *   summary: object,
 *   hasCommandBearingFiles: boolean,
 *   hardIncomplete: boolean,
 * }}
 */
let scanCount = 0
/** Test seam: how many scans have run in this process. */
export function scanCountForTest() {
  return scanCount
}

export function scanFolderSettings(cwd, limits) {
  scanCount += 1
  const scan = newScan(limits)
  const summary = {
    files: [],
    mcpServers: [],
    hooks: [],
    statusLine: [],
    enabledPlugins: [],
    counts: scan.counts,
    warnings: [],
    hasCommandBearingFiles: false,
    untrustable: false,
  }
  let realPath = ''
  if (typeof cwd === 'string' && cwd !== '') {
    try {
      const root = resolveRealPath(cwd)
      realPath = root.path
      if (root.error) hard(scan, realPath, root.error)
      // The user's own Claude dir, resolved once through any dotfile symlinks, so it
      // compares equal to the real path of a `.claude` found anywhere below.
      let userDir = null
      try {
        const u = resolveRealPath(claudeConfigDir())
        userDir = u.error ? null : u.path
        if (u.error) hard(scan, claudeConfigDir(), u.error)
      } catch { userDir = null }
      const isUserDir = (dotClaude) => {
        if (userDir === null) return false
        const r = resolveRealPath(dotClaude)
        if (r.error) {
          hard(scan, dotClaude, r.error)
          return false
        }
        return r.path === userDir
      }
      const seen = new Set()
      const location = (dotClaude) => {
        if (seen.has(dotClaude) || isUserDir(dotClaude)) return
        seen.add(dotClaude)
        scanContentLocation(dotClaude, scan)
      }

      for (const dir of ancestorsOf(realPath)) {
        addConfigFile(join(dir, '.mcp.json'), 'mcp', scan)
        const dotClaude = join(dir, '.claude')
        if (!isUserDir(dotClaude)) addConfigFile(join(dotClaude, 'settings.json'), 'settings', scan)
        location(dotClaude)
      }
      for (const nested of findNestedDotClaude(realPath, realPath, scan)) location(nested)
      const main = mainCheckoutDotClaude(realPath, scan)
      if (main && !seen.has(main) && !isUserDir(main)) {
        seen.add(main)
        scanContentRoot(join(main, 'skills'), 'skills', scan)
      }
    } catch (err) {
      // The scan must never throw into a launch path; an unfinished scan cannot be approved.
      hard(scan, realPath || String(cwd), err?.code || err?.message || 'scan failed')
    }
  } else {
    hard(scan, String(cwd), 'no folder')
  }

  const files = scan.entries.map(({ path, sha256 }) => ({ path, sha256 })).sort(byPath)
  summary.files = scan.entries.map(({ path, linkTarget }) => ({ path, ...(linkTarget ? { linkTarget } : {}) })).sort(byPath)
  summary.hasCommandBearingFiles = files.length > 0
  try {
    summarizeConfig(scan.config.sort(byPath), summary)
  } catch (err) {
    summary.warnings.push(`summary incomplete: ${err?.message || 'error'}`)
  }
  const hardIncomplete = scan.hard.length > 0
  if (hardIncomplete) {
    summary.untrustable = true
    for (const h of scan.hard.slice(0, 10)) summary.warnings.push(h.startsWith('This folder is too large') ? h : `Cannot review this folder: ${h}`)
    if (scan.hard.length > 10) summary.warnings.push(`${scan.hard.length - 10} more problems not shown`)
  }
  return {
    realPath: realPath || resolve(String(cwd ?? '')),
    files,
    digest: sha256Hex(canonicalJson(files)),
    summary,
    hasCommandBearingFiles: files.length > 0,
    hardIncomplete,
  }
}

// ── Store ────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/

function isRecord(r) {
  if (!r || typeof r !== 'object' || r.v !== FOLDER_TRUST_RECORD_VERSION) return false
  if (typeof r.path !== 'string' || r.path === '' || typeof r.trustedAt !== 'string') return false
  if (typeof r.digest !== 'string' || !HEX64.test(r.digest) || !Array.isArray(r.files)) return false
  if (!r.files.every((f) => f && typeof f.path === 'string' && typeof f.sha256 === 'string' && HEX64.test(f.sha256))) return false
  // The digest is a function of the file list; a record that disagrees was edited.
  const files = r.files.map(({ path, sha256 }) => ({ path, sha256 })).sort(byPath)
  return sha256Hex(canonicalJson(files)) === r.digest
}

/** Read the store; a missing, corrupt or other-version file yields no records. */
export function loadFolderTrustRecords(filePath = folderTrustStorePath()) {
  if (!existsSync(filePath)) return []
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    const list = Array.isArray(raw?.records) ? raw.records : []
    const seen = new Set()
    const records = []
    for (const r of list) {
      if (!isRecord(r) || seen.has(r.path)) continue
      seen.add(r.path)
      records.push({
        v: r.v,
        path: r.path,
        digest: r.digest,
        files: r.files.map(({ path, sha256 }) => ({ path, sha256 })),
        trustedAt: r.trustedAt,
      })
    }
    return records
  } catch (err) {
    log.warn(`folder trust store unreadable: ${err?.message || err}`)
    return []
  }
}

function saveFolderTrustRecords(records, filePath = folderTrustStorePath()) {
  writeFileAtomic0600(filePath, JSON.stringify({ records }, null, 2))
}

// ── Cross-process lock ───────────────────────────────────────────────────

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 10_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readLock = (lockPath) => {
  try {
    return readFileSync(lockPath, 'utf8')
  } catch {
    return null
  }
}

/**
 * A lock is stale only when its holder is gone: the recorded pid is not alive. A
 * live pid is never robbed because the lock is old. A lock whose holder cannot be
 * read (it died between creating the file and writing it) goes stale by age.
 */
function lockIsStale(lockPath, content) {
  if (content === null) return false
  const pid = Number.parseInt(content.split('\n')[0], 10)
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0)
      return false
    } catch (err) {
      return err?.code === 'ESRCH'
    }
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
  } catch {
    return false
  }
}

/** A `.reclaim` guard older than this is itself abandoned (a reclaim takes microseconds; waiters give up at LOCK_WAIT_MS). */
const RECLAIM_GUARD_STALE_MS = 5_000

/**
 * Remove a lock that was judged stale, without ever vacating a live one. Only one
 * process at a time reclaims: it holds a short-lived guard (`<lock>.reclaim`,
 * created `O_EXCL`), and under it re-reads the lock and removes it only if it is
 * still exactly the content that was judged. A lock somebody created since is left
 * alone. The caller then retries the normal `O_EXCL` claim.
 */
export function reclaimStale(lockPath, judged) {
  const guard = `${lockPath}.reclaim`
  try {
    writeFileSync(guard, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if (err?.code === 'EEXIST') {
      // Another process is reclaiming; only a guard that has been there for a long
      // time is treated as abandoned.
      try {
        if (Date.now() - statSync(guard).mtimeMs > RECLAIM_GUARD_STALE_MS) unlinkSync(guard)
      } catch { /* gone, or not ours to judge */ }
    }
    return
  }
  try {
    if (readLock(lockPath) === judged) {
      try { unlinkSync(lockPath) } catch { /* already gone */ }
    }
  } finally {
    try { unlinkSync(guard) } catch { /* nothing to do */ }
  }
}

/**
 * Hold an `O_EXCL` lock file for the store (other daemon processes share ~/.chroxy).
 * The file holds `pid`, then a token unique to this holder; after the claim the token
 * is read back, and release removes the file only if it still holds that token.
 */
export async function withInterprocessLock(storePath, fn) {
  const lockPath = `${storePath}.lock`
  const dir = dirname(lockPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`
  const body = `${process.pid}\n${token}\n${Date.now()}\n`
  const isOurs = (content) => content !== null && content.includes(`\n${token}\n`)
  for (;;) {
    try {
      writeFileSync(lockPath, body, { mode: 0o600, flag: 'wx' })
      if (isOurs(readLock(lockPath))) break
      // The file is not what was just written: it is not ours to run under or to remove.
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const content = readLock(lockPath)
      if (lockIsStale(lockPath, content)) {
        reclaimStale(lockPath, content)
        continue
      }
    }
    if (Date.now() > deadline) throw new Error('folder trust store is locked by another process')
    await sleep(20)
  }
  try {
    return await fn()
  } finally {
    if (isOurs(readLock(lockPath))) {
      try { unlinkSync(lockPath) } catch { /* already gone */ }
    }
  }
}

function withStoreLock(storePath, fn) {
  return withTrustStoreLock(storePath, () => withInterprocessLock(storePath, fn))
}

// ── Cache (display only) ─────────────────────────────────────────────────

const scanCache = new Map()
let cacheGeneration = 0

/** Drop every cached scan. Called on any trust change so it takes effect at once. */
export function invalidateFolderTrustCache() {
  cacheGeneration += 1
  inflight.clear()
  scanCache.clear()
}

const freshHit = (realPath) => {
  const hit = scanCache.get(realPath)
  return hit && Date.now() - hit.at <= SCAN_CACHE_TTL_MS ? hit.scan : null
}

function scanCached(cwd, useCache) {
  if (useCache) {
    const r = resolveRealPath(cwd)
    const hit = r.error ? null : freshHit(r.path)
    if (hit) return hit
  }
  // A launch decision never reads the cache; its scan does feed it for display callers.
  const scan = scanFolderSettings(cwd)
  scanCache.set(scan.realPath, { at: Date.now(), scan })
  return scan
}

// ── Off-thread scans ─────────────────────────────────────────────────────
//
// Two lanes, each with its own worker thread and one scan at a time: `display`
// (cacheable, shared per folder) and `launch` (a fresh scan per decision, never
// cached or shared). A scan that does not answer within WORKER_SCAN_TIMEOUT_MS has
// its worker terminated; the next request gets a fresh worker.

/** Longest one off-thread scan may run before its worker is terminated. */
export const WORKER_SCAN_TIMEOUT_MS = 5000

let workerUrl = new URL('./folder-trust-worker.js', import.meta.url)
let workerTimeoutMs = WORKER_SCAN_TIMEOUT_MS
/** Test seam: the worker script and the per-scan timeout. Call with no argument to restore. */
export function setWorkerForTest({ url, timeoutMs } = {}) {
  workerUrl = url ?? new URL('./folder-trust-worker.js', import.meta.url)
  workerTimeoutMs = timeoutMs ?? WORKER_SCAN_TIMEOUT_MS
  for (const lane of [displayLane, launchLane]) {
    const rec = lane.rec
    lane.rec = null
    if (rec) {
      rec.w.terminate().catch(() => {})
      settleActive(rec, new Error('scan worker replaced'))
    }
  }
}

const workerError = (code, message) => Object.assign(new Error(message), { code })

const newLane = () => ({ rec: null, queue: [] })
const displayLane = newLane()
const launchLane = newLane()

let workerScans = 0
/** Test seam: how many scans have been handed to a worker. */
export function workerScanCountForTest() {
  return workerScans
}

/** Settle the request a worker record is running, once. */
function settleActive(rec, err, scan) {
  const req = rec.active
  if (!req) return
  rec.active = null
  clearTimeout(req.timer)
  if (err) req.reject(err)
  else req.resolve(scan)
}

/**
 * A worker record has stopped (error, exit, timeout). It rejects ITS OWN request
 * only, and replaces the lane's worker only if it is still the lane's current one:
 * a late event from an older worker cannot touch its replacement.
 */
function retire(lane, rec, err) {
  if (lane.rec === rec) lane.rec = null
  settleActive(rec, err)
  pump(lane)
}

function startWorker(lane) {
  const w = new Worker(workerUrl, { env: SHARE_ENV })
  const rec = { w, active: null }
  w.on('message', ({ id, scan }) => {
    if (!rec.active || rec.active.id !== id) return
    if (lane.rec === rec) w.unref() // idle: never keeps the process alive
    settleActive(rec, scan ? null : workerError('WORKER_SCAN_FAILED', 'scan failed'), scan)
    pump(lane)
  })
  w.on('error', (err) => retire(lane, rec, err))
  w.on('exit', () => retire(lane, rec, new Error('scan worker exited')))
  // After the listeners: adding a 'message' listener would otherwise re-ref the worker's port.
  w.unref()
  lane.rec = rec
  return rec
}

let nextId = 1
/** Hand the next queued request to the lane's worker when it is idle. */
function pump(lane) {
  if (lane.queue.length === 0) return
  if (lane.rec?.active) return
  let rec = lane.rec
  const req = lane.queue.shift()
  try {
    rec ??= startWorker(lane)
  } catch (err) {
    req.reject(workerError('WORKER_UNAVAILABLE', err?.message || 'scan worker could not be created'))
    pump(lane)
    return
  }
  workerScans += 1
  rec.active = req
  req.id = nextId++
  req.timer = setTimeout(() => {
    // Only this worker is stopped; whatever is queued behind runs on a fresh one.
    rec.w.terminate().catch(() => {})
    retire(lane, rec, workerError('WORKER_TIMEOUT', 'scan timed out'))
  }, workerTimeoutMs)
  rec.w.ref() // a scan in flight keeps the process alive until it answers
  rec.w.postMessage({ id: req.id, cwd: req.cwd, limits: req.limits })
}

/**
 * Run one scan in the lane's worker. Rejects with `code` WORKER_TIMEOUT when it does
 * not answer in time, WORKER_SCAN_FAILED when the scan itself failed, otherwise (the
 * worker could not be created, or died) with a plain error.
 */
function scanInWorker(lane, cwd, limits) {
  return new Promise((resolve, reject) => {
    lane.queue.push({ cwd, limits, resolve, reject, id: 0, timer: null })
    pump(lane)
  })
}

/** What a display caller sees for a scan that timed out: not reviewable, never trusted. */
function incompleteScan(cwd, why) {
  const files = []
  return {
    realPath: resolveRealPath(cwd).path,
    files,
    digest: sha256Hex(canonicalJson(files)),
    summary: {
      files: [], mcpServers: [], hooks: [], statusLine: [], enabledPlugins: [],
      counts: { agents: 0, skills: 0, commands: 0 },
      warnings: [why], hasCommandBearingFiles: false, untrustable: true,
    },
    hasCommandBearingFiles: false,
    hardIncomplete: true,
  }
}

const inflight = new Map()

/**
 * Scan for DISPLAY without blocking the main thread: a fresh cached scan, else one
 * run in a worker thread (the in-thread scan only if the worker is unavailable or
 * died; a scan that TIMED OUT is shown as not reviewable, never re-run here).
 * Concurrent requests for one folder share one scan. Any result, an incomplete one
 * included, is cached for SCAN_CACHE_TTL_MS. Never used for a launch decision.
 */
async function scanForDisplay(cwd) {
  const r = resolveRealPath(cwd)
  const hit = r.error ? null : freshHit(r.path)
  if (hit) return hit
  let pendingScan = inflight.get(r.path)
  if (!pendingScan) {
    const generation = cacheGeneration
    const promise = scanInWorker(displayLane, cwd, DISPLAY_LIMITS)
      .catch((err) => (err?.code === 'WORKER_TIMEOUT'
        ? incompleteScan(cwd, 'This folder is too large to review (the search took too long)')
        : scanFolderSettings(cwd, DISPLAY_LIMITS)))
      .then((scan) => {
        // A trust change while this ran invalidated the cache: do not store a stale scan.
        if (generation === cacheGeneration) scanCache.set(scan.realPath, { at: Date.now(), scan })
        return scan
      })
      .finally(() => { if (inflight.get(r.path) === promise) inflight.delete(r.path) })
    pendingScan = promise
    inflight.set(r.path, promise)
  }
  return pendingScan
}

/**
 * The trust state of `cwd` for a LAUNCH decision, computed off the main thread: a
 * fresh scan started now, in the launch lane. It never reads or writes the display
 * cache and is never shared with another request. A timeout or a failed scan is
 * reported as `untrusted` (fail closed); the in-thread scan runs only when the
 * worker cannot be created or died.
 * @returns {Promise<{ status: 'trusted'|'untrusted', realPath: string, digest: string, summary: object }>}
 */
export async function getFolderTrustStateForLaunch(cwd) {
  let scan
  try {
    scan = await scanInWorker(launchLane, cwd, {})
  } catch (err) {
    if (err?.code === 'WORKER_TIMEOUT' || err?.code === 'WORKER_SCAN_FAILED') {
      scan = incompleteScan(cwd, 'This folder could not be reviewed in time')
    } else {
      scan = scanFolderSettings(cwd)
    }
  }
  return { status: statusOf(scan), realPath: scan.realPath, digest: scan.digest, summary: scan.summary }
}

/** The trust state of `cwd` for display, computed off-thread. Same shape as getFolderTrustState. */
export async function getFolderTrustStateForDisplay(cwd) {
  const scan = await scanForDisplay(cwd)
  return { status: statusOf(scan), realPath: scan.realPath, digest: scan.digest, summary: scan.summary }
}

/**
 * The state if a fresh scan is cached, else null (and a worker scan is started to
 * warm the cache). For emitters that must answer synchronously.
 */
export function getFolderTrustStateIfCached(cwd) {
  const r = resolveRealPath(cwd)
  const hit = r.error ? null : freshHit(r.path)
  if (hit) {
    return { status: statusOf(hit), realPath: hit.realPath, digest: hit.digest, summary: hit.summary }
  }
  scanForDisplay(cwd).catch(() => {})
  return null
}

function statusOf(scan) {
  // An incomplete scan never reads as trusted.
  if (scan.hardIncomplete) return 'untrusted'
  const record = loadFolderTrustRecords().find((r) => r.path === scan.realPath)
  return record && record.digest === scan.digest ? 'trusted' : 'untrusted'
}

/**
 * The trust state of `cwd`: `trusted` (a record matches the real path AND the
 * current digest) or `untrusted`. Nothing loads without `trusted`.
 *
 * @param {string} cwd
 * @param {{ cached?: boolean }} [opts] - `cached` reuses a scan up to 2 s old (display only)
 * @returns {{ status: 'trusted'|'untrusted', realPath: string, digest: string, summary: object }}
 */
export function getFolderTrustState(cwd, { cached = false } = {}) {
  const scan = scanCached(cwd, cached)
  return { status: statusOf(scan), realPath: scan.realPath, digest: scan.digest, summary: scan.summary }
}

/** True only when a record matches the current real path and digest. */
export function isFolderTrusted(cwd, opts) {
  if (typeof cwd !== 'string' || cwd === '') return false
  return getFolderTrustState(cwd, opts).status === 'trusted'
}

/**
 * Record trust for the folder's CURRENT settings, but only if they are still the
 * ones the owner reviewed (`expectedDigest`). Returns the new state, or
 * `{ ok: false, code, error }`.
 *
 * @param {string} cwd
 * @param {string} expectedDigest - the digest of the summary the owner saw
 */
export async function trustFolder(cwd, expectedDigest) {
  if (typeof cwd !== 'string' || cwd === '') return { ok: false, status: 'untrusted', code: 'FOLDER_TRUST_NOT_APPLIED', error: 'no folder' }
  return withStoreLock(folderTrustStorePath(), async () => {
    const scan = scanFolderSettings(cwd)
    const base = { realPath: scan.realPath, digest: scan.digest, summary: scan.summary }
    if (scan.hardIncomplete) {
      return { ok: false, status: 'untrusted', ...base, code: 'FOLDER_TRUST_UNTRUSTABLE', error: 'This folder could not be fully reviewed' }
    }
    if (typeof expectedDigest !== 'string' || expectedDigest !== scan.digest) {
      return { ok: false, status: statusOf(scan), ...base, code: 'FOLDER_TRUST_CHANGED', error: 'The folder changed since it was reviewed' }
    }
    const records = loadFolderTrustRecords().filter((r) => r.path !== scan.realPath)
    records.push({
      v: FOLDER_TRUST_RECORD_VERSION,
      path: scan.realPath,
      digest: scan.digest,
      files: scan.files,
      trustedAt: new Date().toISOString(),
    })
    try {
      saveFolderTrustRecords(records)
    } finally {
      invalidateFolderTrustCache()
    }
    return { ok: true, status: 'trusted', ...base }
  })
}

/** Remove any trust record for the folder. */
export async function untrustFolder(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return { ok: false, status: 'untrusted', code: 'FOLDER_TRUST_NOT_APPLIED', error: 'no folder' }
  return withStoreLock(folderTrustStorePath(), async () => {
    const rp = resolveRealPath(cwd)
    if (rp.error) return { ok: false, status: 'untrusted', code: 'FOLDER_TRUST_NOT_APPLIED', error: 'The folder could not be resolved' }
    const realPath = rp.path
    const before = loadFolderTrustRecords()
    const after = before.filter((r) => r.path !== realPath)
    try {
      if (after.length !== before.length) saveFolderTrustRecords(after)
    } finally {
      invalidateFolderTrustCache()
    }
    const state = getFolderTrustState(cwd)
    return { ok: true, status: state.status, realPath, digest: state.digest, summary: state.summary }
  })
}

/**
 * The text of `<folder>/.claude/settings.json` if, and only if, (1) the folder is
 * currently trusted (a record matches its real path and its CURRENT full digest, and
 * the scan is complete) and (2) this file's bytes hash to exactly what the record
 * holds. Read once; the caller parses and acts on these same bytes.
 *
 * The folder-level part (1) uses the scan cache, so after the owner stops trusting
 * a folder, or a file elsewhere in it changes, the status line can keep running a
 * file that still matches its record for up to SCAN_CACHE_TTL_MS (2 s). Trust and
 * untrust invalidate the cache at once. The file hash (2) is never cached.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
export function readTrustedProjectSettings(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  const rp = resolveRealPath(cwd)
  if (rp.error) return null
  const state = getFolderTrustState(cwd, { cached: true })
  if (state.status !== 'trusted') return null
  const record = loadFolderTrustRecords().find((r) => r.path === rp.path)
  if (!record) return null
  const target = join(rp.path, '.claude', 'settings.json')
  const want = record.files.find((f) => f.path === target)?.sha256
  if (!want) return null
  const r = readRegular(target, newScan())
  if (!r || r.hard) return null
  return sha256Buf(r.buf) === want ? r.buf.toString('utf8') : null
}
