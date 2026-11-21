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
 * has a wall-clock budget for the nested search, and so does every scan run in this
 * thread (the status line's, trust and untrust's), which an over-budget walk leaves
 * incomplete. Only a launch scan in the worker has none: its walk is bounded by entries
 * and depth, and the worker's overall timeout can still end it, which fails closed). The folder is untrusted and cannot be
 * trusted. What is NOT covered by the digest: files that settings merely refer to
 * (hook scripts, for example), `CLAUDE.md` and rules. Trusting a folder trusts its code.
 *
 * Each file is read ONCE, with `O_NONBLOCK` and an `fstat` that rejects anything
 * that is not a regular file; the digest and the summary come from the same bytes.
 * Nothing here throws.
 */

import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync,
  readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
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
/** Wall-clock budget of the nested search in every scan run in the daemon's own thread, and in display scans (HARD beyond). Worker launch scans have none. */
export const NESTED_BUDGET_MS = 1500
/** Limits of a display scan or an in-thread scan: the entry and depth bounds plus the wall-clock budget. */
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
 *   (wall clock of the nested search) is unset by default, so the walk is bounded by entries and depth only
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
let lockWaitMs = 10_000
/** Test seam: how long a caller waits for the store lock. Call with no argument to restore. */
export function setLockWaitForTest(ms) {
  lockWaitMs = ms ?? 10_000
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** `readLock` that tells an unreadable file (undefined) from an absent one (null). */
const readLockForOwnership = (lockPath) => {
  try {
    return readFileSync(lockPath, 'utf8')
  } catch (err) {
    return err?.code === 'ENOENT' ? null : undefined
  }
}

/** Test seam: replaces the read-back of a just-written lock, to make it fail. */
let lockReadBackHook = null
export function setLockReadBackHookForTest(fn) {
  lockReadBackHook = fn ?? null
}

const readLock = (lockPath) => {
  try {
    return readFileSync(lockPath, 'utf8')
  } catch {
    return null
  }
}

/** The read-back seam also covers the ownership reads of the acquire path, so a test can make every one of them fail. */
const ownershipRead = (lockPath) => (lockReadBackHook ? lockReadBackHook(lockPath, readLockForOwnership) : readLockForOwnership(lockPath))

/**
 * Random per process, written into every lock and guard this process creates. A pid alone does
 * not identify this process: another daemon sharing the directory from a different PID namespace,
 * or an earlier run that had the same pid, can carry it too.
 */
const PROCESS_NONCE = randomBytes(8).toString('hex')

/** The nonce in a lock body (its fourth line) or a guard body (its third), or null for the previous format. */
const nonceOf = (content, line) => {
  const n = content.split('\n')[line]
  return n && /^[0-9a-f]+$/.test(n) ? n : null
}

/**
 * The file identity of a lock-protocol file: inode, mtime (ns) and size. Used to tell a lock
 * that has no token apart from a later one with the same (empty) content.
 */
export function statLockIdentity(path) {
  try {
    const st = statSync(path, { bigint: true })
    return { ino: st.ino, mtimeNs: st.mtimeNs, size: st.size }
  } catch {
    return null
  }
}
/** A zero inode is what some Windows file systems report for every file: it identifies nothing. */
const identityReliable = (id) => id !== null && id !== undefined && id.ino !== 0n
const sameIdentity = (a, b) => identityReliable(a) && identityReliable(b) && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.size === b.size

/**
 * A lock is stale only when its holder is gone: the recorded pid is not alive. A
 * live pid is never robbed because the lock is old. A lock whose holder cannot be
 * read (it died between creating the file and writing it) goes stale by age.
 */
export function lockIsStale(lockPath, content) {
  if (content === null) return false
  const pid = Number.parseInt(content.split('\n')[0], 10)
  if (Number.isInteger(pid) && pid > 0) {
    // This process's own lock that none of its in-flight calls owns: a release that failed.
    // Only when the nonce is ours too; a lock with our pid and another (or no) nonce is judged by liveness.
    if (pid === process.pid && nonceOf(content, 3) === PROCESS_NONCE) return !liveTokens.has(content.split('\n')[1])
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

let unlinkImpl = unlinkSync
/** Test seam: replaces the unlink used to release lock-protocol files. No argument restores. */
export function setLockUnlinkForTest(fn) {
  unlinkImpl = fn ?? unlinkSync
}

/**
 * Remove a lock-protocol file we own. On Windows a reader that has it open makes the
 * unlink fail transiently, and leaving our own file behind would hold everyone else off
 * for as long as this process lives, so retry briefly. Gone already is success.
 */
function unlinkOwned(path, platform = process.platform) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      unlinkImpl(path)
      return true
    } catch (err) {
      if (err?.code === 'ENOENT') return true
      if (!isTransientLockError(err, platform) || err?.code === 'EEXIST') return false
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  return false
}

/** Tokens of the lock calls in flight in this process (waiting or holding). */
const liveTokens = new Set()
const RELEASE_RETRY_MAX_MS = 30_000

/**
 * The release unlink kept failing: keep trying in the background (backoff, up to the
 * stale window) without blocking the caller. Stops as soon as the file is gone or is
 * no longer ours.
 */
function releaseInBackground(lockPath, token, startedAt = Date.now(), delayMs = 50) {
  const timer = setTimeout(() => {
    const held = readLockForOwnership(lockPath)
    if (held === null) return
    if (held === undefined || !held.includes(`\n${token}\n`)) {
      // Unreadable now: ownership is unknown, so try again later. Anything readable that is not ours is not ours to remove.
      if (held === undefined && Date.now() - startedAt < RELEASE_RETRY_MAX_MS) releaseInBackground(lockPath, token, startedAt, Math.min(delayMs * 2, 2000))
      return
    }
    let removed = false
    try { unlinkImpl(lockPath); removed = true } catch (err) { removed = err?.code === 'ENOENT' }
    if (!removed && Date.now() - startedAt < RELEASE_RETRY_MAX_MS) {
      releaseInBackground(lockPath, token, startedAt, Math.min(delayMs * 2, 2000))
    }
  }, delayMs)
  timer.unref?.()
}

/** An unparsable reclaim guard (its holder died before writing it) is abandoned after this long. */
const RECLAIM_GUARD_UNPARSABLE_MS = 60_000
/** A guard left for a lock that is no longer the current one may be removed by anyone after this long. */
const RECLAIM_GUARD_GC_MS = 60_000
/** How many dead guards one reclaim will step over before giving up and waiting. */
const RECLAIM_MAX_DEPTH = 4

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code !== 'ESRCH'
  }
}

/** Tokens of the guards this process's reclaims hold right now. */
const heldGuardTokens = new Set()

/** A guard is abandoned only when its holder is gone, as for the lock; age decides only an unparsable one. */
function guardIsAbandoned(guard, content) {
  if (content === null) return false
  const pid = Number.parseInt(content.split('\n')[0], 10)
  if (Number.isInteger(pid) && pid > 0) {
    // Reclaiming is synchronous, so a guard of this process (pid and nonce) that no reclaim in
    // progress holds is a leftover of an earlier call. Another nonce, or none, is judged by liveness.
    if (pid === process.pid && nonceOf(content, 2) === PROCESS_NONCE) return !heldGuardTokens.has(content.split('\n')[1])
    return !pidAlive(pid)
  }
  try {
    return Date.now() - statSync(guard).mtimeMs > RECLAIM_GUARD_UNPARSABLE_MS
  } catch {
    return false
  }
}

/** The holder's token in a lock or guard body (its second line), or a stand-in derived from the content. */
const hasToken = (content) => {
  const t = content.split('\n')[1]
  return Boolean(t) && /^[\w.-]+$/.test(t) && !t.includes('-')
}
const tokenOf = (content) => (hasToken(content) ? content.split('\n')[1] : `u${sha256Hex(content).slice(0, 16)}`)
/**
 * What a guard is named for: the token of a lock that has one. A lock without a token (empty or
 * unparsable) shares its content hash with every other such lock, so its file identity is part of the name.
 */
const lockKey = (content, identity) => {
  if (hasToken(content)) return tokenOf(content)
  return identityReliable(identity) ? `${tokenOf(content)}i${identity.ino}m${identity.mtimeNs}s${identity.size}` : tokenOf(content)
}

/** Test seam: called while a reclaim holds its guard, before it re-reads the lock. */
let reclaimHook = null
export function setReclaimHookForTest(fn) {
  reclaimHook = fn ?? null
}

/** Remove guards left for a lock other than the current one. Their holders, if any are still alive, re-read the lock and find it changed. */
function collectGuards(lockPath, currentToken) {
  const dir = dirname(lockPath)
  const prefix = `${basename(lockPath)}.reclaim-`
  let names
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (!name.startsWith(prefix) || name.slice(prefix.length).split('-')[0] === currentToken) continue
    try {
      if (Date.now() - statSync(join(dir, name)).mtimeMs > RECLAIM_GUARD_GC_MS) unlinkSync(join(dir, name))
    } catch { /* gone, or not ours to judge */ }
  }
}

/**
 * Remove a lock that was judged stale (its holder is gone), without ever vacating a live
 * one. Reclaiming is guarded by a file named for the lock it is about
 * (`<lock>.reclaim-<token of the judged lock>`), created `O_EXCL` and holding its holder's
 * pid and a token. Under it the lock is re-read and removed only if it is still exactly the
 * judged content; the guard is then released only if it still holds this reclaim's token.
 *
 * No process deletes a guard another may hold. If a guard exists and its holder is dead, it
 * is left where it is and this reclaim escalates to a guard named after that dead guard's
 * token, to the same rule, to a bounded depth. Tokens are random and never reused, so a name
 * is only ever created once and removed by its own holder; the judged lock's holder is dead,
 * so nothing else can replace that lock between the re-read and the unlink. Leftover guards
 * for a lock that is no longer current are collected by age.
 *
 * A lock without a token is identified by its file identity as well (see `statLockIdentity`),
 * captured when it was judged and compared again under the guard. Without a reliable identity
 * such a lock is not reclaimed.
 * @returns {boolean} true when this call removed the lock
 */
export function reclaimStale(lockPath, judged, identity = null) {
  const tokenless = !hasToken(judged)
  if (tokenless && !identityReliable(identity)) return false
  collectGuards(lockPath, lockKey(readLock(lockPath) ?? '', statLockIdentity(lockPath)))
  let guard = `${lockPath}.reclaim-${lockKey(judged, identity)}`
  const guardToken = `${process.pid}.${randomBytes(8).toString('hex')}`
  const guardBody = `${process.pid}\n${guardToken}\n${PROCESS_NONCE}\n`
  for (let depth = 0; ; depth += 1) {
    try {
      writeFileSync(guard, guardBody, { mode: 0o600, flag: 'wx' })
      heldGuardTokens.add(guardToken)
      break
    } catch (err) {
      if (err?.code !== 'EEXIST' || depth >= RECLAIM_MAX_DEPTH) return false
      const held = readLock(guard)
      if (held === null || !guardIsAbandoned(guard, held)) return false
      guard = `${guard}-${tokenOf(held)}`
    }
  }
  let removed = false
  try {
    if (reclaimHook) reclaimHook()
    if (readLock(lockPath) === judged && (!tokenless || sameIdentity(statLockIdentity(lockPath), identity))) {
      try {
        unlinkSync(lockPath)
        removed = true
      } catch { /* already gone */ }
    }
  } finally {
    if (readLock(guard) === guardBody) unlinkOwned(guard)
    heldGuardTokens.delete(guardToken)
  }
  return removed
}

/**
 * On Windows, creating a file that another process is deleting, or has open, fails with
 * EPERM / EACCES / EBUSY instead of EEXIST. That is contention, not a fault: the caller
 * waits and retries within its deadline. Elsewhere those codes are real errors.
 */
export function isTransientLockError(err, platform = process.platform) {
  if (err?.code === 'EEXIST') return true
  return platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EBUSY')
}

export async function withInterprocessLock(storePath, fn) {
  const lockPath = `${storePath}.lock`
  const dir = dirname(lockPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + lockWaitMs
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`
  liveTokens.add(token)
  try {
    return await acquireAndRun(lockPath, token, deadline, fn)
  } finally {
    liveTokens.delete(token)
  }
}

async function acquireAndRun(lockPath, token, deadline, fn) {
  const body = `${process.pid}\n${token}\n${Date.now()}\n${PROCESS_NONCE}\n`
  const isOurs = (content) => typeof content === 'string' && content.includes(`\n${token}\n`)
  let wrote = false
  // Giving up: our file may still be on disk (a failed release, reads that kept failing), so keep
  // trying to remove it in the background rather than leave it to block everyone else.
  const timedOut = () => {
    if (wrote) releaseInBackground(lockPath, token)
    return new Error('folder trust store is locked by another process')
  }
  for (;;) {
    try {
      writeFileSync(lockPath, body, { mode: 0o600, flag: 'wx' })
      wrote = true
      // Read back what was written. A read that fails (a transient Windows error, a scanner
      // holding the file) is retried; if ownership still cannot be confirmed, our own
      // just-written file is removed (its token is known) rather than left to block us.
      let confirmed = false
      for (let attempt = 0; attempt < 5 && !confirmed; attempt += 1) {
        const back = ownershipRead(lockPath)
        // A bounded (10 ms, at most 5 times) synchronous pause: this retry sits between two
        // synchronous steps of the protocol and must not yield, and the bound keeps the event loop
        // from being held for more than about 50 ms.
        if (back === undefined) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue }
        if (isOurs(back)) confirmed = true
        break
      }
      if (confirmed) break
      // Only an absent or our own file is removed; an unreadable one is not known to be ours.
      const now = ownershipRead(lockPath)
      if (now === null || isOurs(now)) unlinkOwned(lockPath)
    } catch (err) {
      if (!isTransientLockError(err)) throw err
      // Stat before reading: a file replaced in between then fails the identity comparison under the guard.
      const identity = statLockIdentity(lockPath)
      const content = ownershipRead(lockPath) ?? null
      if (isOurs(content)) {
        // Our own file from an earlier pass whose read-back failed: ours to run under.
        break
      }
      if (lockIsStale(lockPath, content) && reclaimStale(lockPath, content, identity)) {
        // Progress was made; go round again, but never past the deadline.
        if (Date.now() > deadline) throw timedOut()
        continue
      }
    }
    if (Date.now() > deadline) throw timedOut()
    await sleep(20)
  }
  try {
    return await fn()
  } finally {
    if (isOurs(readLock(lockPath)) && !unlinkOwned(lockPath)) releaseInBackground(lockPath, token)
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
  const scan = scanFolderSettings(cwd, DISPLAY_LIMITS)
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
let workerFactory = null
/** Test seam: the worker script, the per-scan timeout (a number, or a function of the folder), and a factory standing in for `new Worker`. No argument restores. */
export function setWorkerForTest({ url, timeoutMs, factory } = {}) {
  workerUrl = url ?? new URL('./folder-trust-worker.js', import.meta.url)
  workerTimeoutMs = timeoutMs ?? WORKER_SCAN_TIMEOUT_MS
  workerFactory = factory ?? null
  for (const lane of [displayLane, launchLane]) {
    const rec = lane.rec
    lane.rec = null
    if (rec) {
      rec.w.terminate().catch(() => {})
      settleActive(rec, new Error('scan worker replaced'))
    }
  }
}

const START_FAILURES = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_WORKER_PATH', 'ERR_WORKER_INIT_FAILED', 'ERR_WORKER_UNSUPPORTED_OPERATION'])
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
  const w = workerFactory ? workerFactory() : new Worker(workerUrl, { env: SHARE_ENV })
  const rec = { w, active: null }
  w.on('message', ({ id, scan }) => {
    if (!rec.active || rec.active.id !== id) return
    if (lane.rec === rec) w.unref() // idle: never keeps the process alive
    settleActive(rec, scan ? null : workerError('WORKER_SCAN_FAILED', 'scan failed'), scan)
    pump(lane)
  })
  // A worker that could not even start (its script cannot be loaded) is "unavailable"; any other
  // error or exit, after it started, is a crash.
  w.on('error', (err) => retire(lane, rec, START_FAILURES.has(err?.code) ? workerError('WORKER_UNAVAILABLE', err.message) : err))
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
  const timeoutMs = typeof workerTimeoutMs === 'function' ? workerTimeoutMs(req.cwd) : workerTimeoutMs
  req.timer = setTimeout(() => {
    // Only this worker is stopped; whatever is queued behind runs on a fresh one.
    rec.w.terminate().catch(() => {})
    retire(lane, rec, workerError('WORKER_TIMEOUT', 'scan timed out'))
  }, timeoutMs)
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
function incompleteScan(cwd, why, timedOut = true) {
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
    // The scan did not answer in time: the folder was not reviewed, which says nothing
    // about whether it changed. Display only.
    timedOut,
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
 * cache and is never shared with another request. A timeout, a failed scan, or a worker
 * that errored or exited is reported as `untrusted` (fail closed); the in-thread scan
 * runs only when the worker cannot be created at all, and then with the display budget.
 * That budget bounds the nested walk, not every synchronous filesystem call: a limit we accept.
 * @returns {Promise<{ status: 'trusted'|'untrusted', realPath: string, digest: string, summary: object }>}
 */
export async function getFolderTrustStateForLaunch(cwd) {
  // A folder with no trust record is untrusted whatever a scan would find: no scan.
  const real = resolveRealPath(cwd)
  if (real.error || !loadFolderTrustRecords().some((r) => r.path === real.path)) {
    const none = incompleteScan(cwd, 'This folder is not trusted', false)
    return { status: 'untrusted', realPath: none.realPath, digest: none.digest, summary: none.summary }
  }
  let scan
  try {
    scan = await scanInWorker(launchLane, cwd, {})
  } catch (err) {
    if (err?.code === 'WORKER_UNAVAILABLE') {
      // The worker could not be created at all: scan here, with the display wall-clock
      // budget so a slow folder is incomplete (untrusted) rather than a stalled daemon.
      scan = scanFolderSettings(cwd, DISPLAY_LIMITS)
    } else {
      // A timeout, a failed scan, or a worker that errored or exited mid-scan: not allowed.
      scan = incompleteScan(cwd, 'This folder could not be reviewed')
    }
  }
  return { status: statusOf(scan), realPath: scan.realPath, digest: scan.digest, summary: scan.summary }
}

/** The trust state of `cwd` for display, computed off-thread. Same shape as getFolderTrustState. */
export async function getFolderTrustStateForDisplay(cwd) {
  const scan = await scanForDisplay(cwd)
  return {
    status: statusOf(scan), realPath: scan.realPath, digest: scan.digest, summary: scan.summary,
    ...(scan.timedOut ? { timedOut: true } : {}),
  }
}

/**
 * The state if a fresh scan is cached, else null (and a worker scan is started to
 * warm the cache). For emitters that must answer synchronously.
 */
export function getFolderTrustStateIfCached(cwd) {
  const r = resolveRealPath(cwd)
  const hit = r.error ? null : freshHit(r.path)
  if (hit) {
    return {
      status: statusOf(hit), realPath: hit.realPath, digest: hit.digest, summary: hit.summary,
      ...(hit.timedOut ? { timedOut: true } : {}),
    }
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
    const scan = scanFolderSettings(cwd, DISPLAY_LIMITS)
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
    // No record remains for this path, so it is untrusted without a scan; whoever needs the
    // folder's summary gets it from a display (worker) scan.
    return { ok: true, status: 'untrusted', realPath }
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

/**
 * The trust status and real path to report after a change failed. A folder with no
 * record is untrusted without a scan; a recorded one is read from a display (worker) scan.
 * @returns {Promise<{ status: 'trusted'|'untrusted', realPath: string }>}
 */
export async function getFolderTrustStatusForReply(cwd) {
  const r = resolveRealPath(cwd)
  if (r.error || !loadFolderTrustRecords().some((rec) => rec.path === r.path)) return { status: 'untrusted', realPath: r.path }
  const state = await getFolderTrustStateForDisplay(cwd)
  return { status: state.status, realPath: state.realPath }
}
