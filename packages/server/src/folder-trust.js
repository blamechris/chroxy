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
 *     by a bounded walk that skips `.git` and `node_modules`.
 *   - in a linked git worktree, the main checkout's `.claude/skills`.
 *   - the user's own Claude config directory is skipped wherever it appears, and
 *     `.claude/settings.local.json` is never considered.
 *
 * Two kinds of incompleteness:
 *   - HARD: any error other than "absent", a non-regular file, a file over the
 *     per-file limit, or the total byte or file budget exceeded. The folder is
 *     untrusted and cannot be trusted.
 *   - SOFT: the nested walk hit its cap. The folder stays trustable and the summary
 *     says what is not covered.
 *
 * Each file is read ONCE, with `O_NONBLOCK` and an `fstat` that rejects anything
 * that is not a regular file; the digest and the summary come from the same bytes.
 * Nothing here throws.
 */

import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
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
/** Directories visited by the nested `.claude` search before it stops (SOFT). */
export const MAX_NESTED_DIRS = 5000
/** Directory entries examined by the nested search before it stops (SOFT). */
export const MAX_NESTED_ENTRIES = 50_000
/** Deepest level of the nested search (SOFT beyond). */
export const MAX_NESTED_DEPTH = 12
/** Largest config file parsed for the summary; a larger one is still hashed. */
export const MAX_PARSE_BYTES = 256 * 1024
/** Cache lifetime of a scan, for display-only callers. */
export const SCAN_CACHE_TTL_MS = 2000

const CONTENT_DIRS = ['agents', 'skills', 'commands']
const MAX_SUMMARY_ITEMS = 50
const MAX_SUMMARY_STRING = 500
const SKIP_NESTED = new Set(['.git', 'node_modules', '.claude'])
const O_READ = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0)

export function folderTrustStorePath() {
  return configPath('folder-trust.json')
}

const isAbsentCode = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR'
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

function realPathOf(p) {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/** Mutable state of one scan. */
function newScan(limits = {}) {
  return {
    limits: {
      maxFileBytes: limits.maxFileBytes ?? MAX_FILE_BYTES,
      maxTotalBytes: limits.maxTotalBytes ?? MAX_TOTAL_BYTES,
      maxFiles: limits.maxFiles ?? MAX_SCANNED_FILES,
      maxNestedDirs: limits.maxNestedDirs ?? MAX_NESTED_DIRS,
      maxNestedEntries: limits.maxNestedEntries ?? MAX_NESTED_ENTRIES,
    },
    bytes: 0,
    files: 0,
    hard: [],
    soft: [],
    entries: [],
    config: [],
    links: [],
    counts: { agents: 0, skills: 0, commands: 0 },
  }
}

const hard = (scan, path, why) => { scan.hard.push(`${path}: ${why}`) }

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
  let names
  try {
    names = readdirSync(dir).sort()
  } catch (err) {
    if (!isAbsentCode(err)) hard(scan, dir, err?.code || 'unreadable')
    return
  }
  for (const name of names) {
    const full = join(dir, name)
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
        const real = realPathOf(full)
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
      const real = realPathOf(full)
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

function scanContentLocation(dotClaude, scan) {
  for (const sub of CONTENT_DIRS) {
    const dir = join(dotClaude, sub)
    const real = realPathOf(dir)
    walkContent(dir, sub, scan, new Set([real]), new Set([real]), 0)
  }
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
    if (!m) return null
    const gitdir = resolve(dir, m[1])
    // <main>/.git/worktrees/<name>
    const worktrees = dirname(gitdir)
    const mainGit = dirname(worktrees)
    if (worktrees.endsWith('worktrees') && mainGit.endsWith('.git')) return join(dirname(mainGit), '.claude')
    return null
  }
  return null
}

/** Nested `.claude` directories below `root`, by a bounded walk. */
function findNestedDotClaude(root, scan) {
  const found = []
  const queue = [[root, 0]]
  let visited = 0
  let entriesSeen = 0
  let capped = false
  while (queue.length > 0) {
    const [dir, depth] = queue.shift()
    if (visited >= scan.limits.maxNestedDirs) {
      capped = true
      break
    }
    visited += 1
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (!isAbsentCode(err)) hard(scan, dir, err?.code || 'unreadable')
      continue
    }
    entriesSeen += dirents.length
    if (entriesSeen > scan.limits.maxNestedEntries) {
      capped = true
      break
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const d of dirents) {
      if (!d.isDirectory()) continue
      if (d.name === '.claude') {
        if (dir !== root) found.push(join(dir, '.claude'))
        continue
      }
      if (SKIP_NESTED.has(d.name)) continue
      if (depth + 1 > MAX_NESTED_DEPTH) {
        capped = true
        continue
      }
      queue.push([join(dir, d.name), depth + 1])
    }
  }
  if (capped) {
    scan.soft.push(`Folder tree too large to scan fully: nested skills beyond ${scan.limits.maxNestedDirs} directories are not covered`)
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
 * @param {object} [limits] - test seam: maxFileBytes, maxTotalBytes, maxFiles, maxNestedDirs
 * @returns {{
 *   realPath: string,
 *   files: { path: string, sha256: string }[],
 *   digest: string,
 *   summary: object,
 *   hasCommandBearingFiles: boolean,
 *   hardIncomplete: boolean,
 * }}
 */
export function scanFolderSettings(cwd, limits) {
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
      realPath = realPathOf(cwd)
      let userDir = null
      try { userDir = claudeConfigDir() } catch { userDir = null }
      const isUserDir = (dotClaude) => userDir !== null && realPathOf(dotClaude) === userDir
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
      for (const nested of findNestedDotClaude(realPath, scan)) location(nested)
      const main = mainCheckoutDotClaude(realPath, scan)
      if (main && !seen.has(main) && !isUserDir(main)) {
        seen.add(main)
        walkContent(join(main, 'skills'), 'skills', scan, new Set([realPathOf(join(main, 'skills'))]), new Set([realPathOf(join(main, 'skills'))]), 0)
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
  for (const w of scan.soft) summary.warnings.push(w)
  const hardIncomplete = scan.hard.length > 0
  if (hardIncomplete) {
    summary.untrustable = true
    for (const h of scan.hard.slice(0, 10)) summary.warnings.push(`Cannot review this folder: ${h}`)
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

function lockIsStale(lockPath) {
  try {
    const st = statSync(lockPath)
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return true
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').split('\n')[0], 10)
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
      } catch (err) {
        return err?.code === 'ESRCH'
      }
    }
    return false
  } catch {
    return false // absent or unreadable: let the next attempt decide
  }
}

/** Hold an `O_EXCL` lock file for the store (other daemon processes share ~/.chroxy). */
async function withInterprocessLock(storePath, fn) {
  const lockPath = `${storePath}.lock`
  const dir = dirname(lockPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      if (lockIsStale(lockPath)) {
        try { unlinkSync(lockPath) } catch { /* another process recovered it first */ }
        continue
      }
      if (Date.now() > deadline) throw new Error('folder trust store is locked by another process')
      await sleep(20)
    }
  }
  try {
    return await fn()
  } finally {
    try { unlinkSync(lockPath) } catch { /* already gone */ }
  }
}

function withStoreLock(storePath, fn) {
  return withTrustStoreLock(storePath, () => withInterprocessLock(storePath, fn))
}

// ── Cache (display only) ─────────────────────────────────────────────────

const scanCache = new Map()

/** Drop every cached scan. Called on any trust change so it takes effect at once. */
export function invalidateFolderTrustCache() {
  scanCache.clear()
}

function scanCached(cwd, useCache) {
  if (!useCache) return scanFolderSettings(cwd)
  const key = realPathOf(cwd)
  const hit = scanCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at <= SCAN_CACHE_TTL_MS) return hit.scan
  const scan = scanFolderSettings(cwd)
  scanCache.set(key, { at: now, scan })
  return scan
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
    const realPath = realPathOf(cwd)
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
 * The text of `<folder>/.claude/settings.json` if, and only if, the folder is
 * trusted and this file's content is exactly what the trust record holds. Read
 * once; the caller parses and acts on these same bytes. Never cached.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
export function readTrustedProjectSettings(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  const realPath = realPathOf(cwd)
  const record = loadFolderTrustRecords().find((r) => r.path === realPath)
  if (!record) return null
  const target = join(realPath, '.claude', 'settings.json')
  const want = record.files.find((f) => f.path === target)?.sha256
  if (!want) return null
  const r = readRegular(target, newScan())
  if (!r || r.hard) return null
  return sha256Buf(r.buf) === want ? r.buf.toString('utf8') : null
}
