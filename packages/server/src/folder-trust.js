/**
 * Per-folder trust for project settings.
 *
 * A session folder may carry files that make a Claude process run commands:
 * `.mcp.json` (MCP servers), `.claude/settings.json` (hooks, status line,
 * plugins) and `.claude/{agents,skills,commands}/`. By default none of them is
 * loaded (claude-setting-sources.js). The owner can mark a folder trusted; the
 * decision is tied to the exact bytes of those files, so any change makes the
 * folder untrusted again until it is approved again.
 *
 * Files considered (absolute paths, all hashed):
 *   - `.mcp.json` and `.claude/settings.json` in the folder's real path and in
 *     every ancestor directory up to the filesystem root. An ancestor's
 *     `.claude/settings.json` is skipped when that `.claude` directory is the
 *     user's own Claude config directory (its settings are the user scope, not
 *     the project's).
 *   - every regular file under `.claude/agents`, `.claude/skills` and
 *     `.claude/commands` of the folder itself (bounded; symlinks are not
 *     followed and a symlink is hashed by its link text).
 *   - NEVER `.claude/settings.local.json`: the local scope is never loaded.
 *
 * Nothing here throws. An unreadable or invalid file becomes a warning and still
 * counts in the digest by its raw bytes (or by its error code when unreadable),
 * so it cannot hide a change.
 */

import { existsSync, lstatSync, openSync, closeSync, readSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { configPath } from './config-dir.js'
import { claudeConfigDir } from './utils/claude-config-dir.js'
import { canonicalJson, sha256Hex, withTrustStoreLock, writeFileAtomic0600 } from './byok-mcp-trust.js'
import { redactMcpUrl } from './byok-mcp-config.js'
import { createLogger } from './logger.js'

const log = createLogger('folder-trust')

/** On-disk record version. Unknown versions are dropped at load. */
export const FOLDER_TRUST_RECORD_VERSION = 1

/** Most files hashed under agents/skills/commands before the scan reports `truncated`. */
export const MAX_SCANNED_FILES = 2000
/** Largest file hashed by content; a larger one is hashed by size and mtime. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024
/** Total bytes read across one scan before the rest is hashed by size and mtime. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024
/** Deepest directory level walked under agents/skills/commands. */
export const MAX_DEPTH = 16
/** Cache lifetime of a scan, for callers that poll (the status line). */
export const SCAN_CACHE_TTL_MS = 2000

const CONTENT_DIRS = ['agents', 'skills', 'commands']
const MAX_SUMMARY_ITEMS = 50
const MAX_SUMMARY_STRING = 500

export function folderTrustStorePath() {
  return configPath('folder-trust.json')
}

function clip(value) {
  const s = typeof value === 'string' ? value : String(value ?? '')
  return s.length > MAX_SUMMARY_STRING ? `${s.slice(0, MAX_SUMMARY_STRING)}…` : s
}

function realPathOf(cwd) {
  try {
    return realpathSync.native(cwd)
  } catch {
    return resolve(cwd)
  }
}

function lstatOrNull(p) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** Hash a regular file's bytes in chunks, charging `budget`. */
function hashFile(path, size, budget, mtimeMs) {
  if (size > MAX_FILE_BYTES || budget.bytes + size > MAX_TOTAL_BYTES) {
    return sha256Hex(`stat:${size}:${mtimeMs}`)
  }
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(64 * 1024)
  let fd
  try {
    fd = openSync(path, 'r')
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
      budget.bytes += n
    }
  } catch (err) {
    return sha256Hex(`error:${err?.code || 'unreadable'}`)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* nothing to do */ }
    }
  }
  return hash.digest('hex')
}

/** Entry for a settings-style file (`.mcp.json`, `settings.json`) or null when absent. */
function configFileEntry(path, budget) {
  const st = lstatOrNull(path)
  if (!st) return null
  if (st.isSymbolicLink()) {
    // A symlinked config file is covered by its link text AND the bytes it
    // currently points at, so retargeting the link or editing the target both
    // change the digest.
    let linkText = ''
    try { linkText = readlinkSync(path) } catch { linkText = '' }
    let targetHash = 'unreadable'
    try {
      const target = readFileSync(path)
      targetHash = createHash('sha256').update(target).digest('hex')
    } catch { /* dangling or unreadable: covered by the link text */ }
    return { path, sha256: sha256Hex(`symlink:${linkText}\0${targetHash}`), kind: 'config' }
  }
  if (!st.isFile()) return { path, sha256: sha256Hex(`type:${st.mode & 0o170000}`), kind: 'config' }
  return { path, sha256: hashFile(path, st.size, budget, st.mtimeMs), kind: 'config' }
}

function readJsonFile(path, warnings) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    warnings.push(`${path}: unreadable (${err?.code || 'error'})`)
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    warnings.push(`${path}: not valid JSON`)
    return null
  }
}

/** Collect the files under `<dir>/.claude/<sub>` into `out`. Returns false when the bound was hit. */
function walkContentDir(root, out, budget, state, depth = 0) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return true
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const dirent of entries) {
    const full = join(root, dirent.name)
    if (state.count >= MAX_SCANNED_FILES) {
      state.truncated = true
      return false
    }
    if (dirent.isSymbolicLink()) {
      let text = ''
      try { text = readlinkSync(full) } catch { text = '' }
      state.count += 1
      out.push({ path: full, sha256: sha256Hex(`symlink:${text}`), kind: 'content' })
    } else if (dirent.isDirectory()) {
      if (depth >= MAX_DEPTH) {
        state.truncated = true
        continue
      }
      if (!walkContentDir(full, out, budget, state, depth + 1)) return false
    } else if (dirent.isFile()) {
      const st = lstatOrNull(full)
      if (!st) continue
      state.count += 1
      out.push({ path: full, sha256: hashFile(full, st.size, budget, st.mtimeMs), kind: 'content' })
    }
  }
  return true
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

function isUserClaudeDir(dotClaude, userDir) {
  if (!userDir) return false
  return realPathOf(dotClaude) === userDir
}

function summarizeMcpServers(file, doc, summary) {
  const servers = doc?.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return
  for (const name of Object.keys(servers).slice(0, MAX_SUMMARY_ITEMS)) {
    const s = servers[name]
    if (!s || typeof s !== 'object') continue
    const item = { file, name: clip(name) }
    if (typeof s.command === 'string') item.command = clip(s.command)
    if (Array.isArray(s.args)) item.args = s.args.slice(0, MAX_SUMMARY_ITEMS).map(clip)
    if (typeof s.url === 'string') item.url = redactMcpUrl(s.url)
    if (typeof s.type === 'string') item.type = clip(s.type)
    // Environment VALUES routinely hold credentials: only the keys are listed.
    if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) item.envKeys = Object.keys(s.env).slice(0, MAX_SUMMARY_ITEMS).map(clip)
    summary.mcpServers.push(item)
  }
}

function summarizeSettings(file, doc, summary) {
  if (doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks)) {
    for (const event of Object.keys(doc.hooks).slice(0, MAX_SUMMARY_ITEMS)) {
      const commands = []
      const groups = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : []
      for (const group of groups) {
        const hooks = Array.isArray(group?.hooks) ? group.hooks : []
        for (const hook of hooks) {
          if (typeof hook?.command === 'string' && commands.length < MAX_SUMMARY_ITEMS) commands.push(clip(hook.command))
        }
      }
      summary.hooks.push({ file, event: clip(event), commands })
    }
  }
  const sl = doc.statusLine
  if (sl && typeof sl === 'object' && typeof sl.command === 'string') {
    summary.statusLine.push({ file, command: clip(sl.command) })
  }
  if (doc.enabledPlugins && typeof doc.enabledPlugins === 'object' && !Array.isArray(doc.enabledPlugins)) {
    for (const key of Object.keys(doc.enabledPlugins).slice(0, MAX_SUMMARY_ITEMS)) {
      summary.enabledPlugins.push({ file, plugin: clip(key) })
    }
  }
}

/**
 * Scan the command-bearing settings files that apply to `cwd`.
 *
 * @param {string} cwd
 * @returns {{
 *   realPath: string,
 *   files: { path: string, sha256: string }[],
 *   digest: string,
 *   summary: object,
 *   hasCommandBearingFiles: boolean,
 *   truncated: boolean,
 * }}
 */
export function scanFolderSettings(cwd) {
  const warnings = []
  const summary = {
    files: [],
    mcpServers: [],
    hooks: [],
    statusLine: [],
    enabledPlugins: [],
    counts: { agents: 0, skills: 0, commands: 0 },
    warnings,
  }
  const empty = (realPath) => ({
    realPath,
    files: [],
    digest: sha256Hex(canonicalJson([])),
    summary,
    hasCommandBearingFiles: false,
    truncated: false,
  })
  if (typeof cwd !== 'string' || cwd === '') return empty('')

  let realPath
  const entries = []
  const state = { count: 0, truncated: false }
  try {
    realPath = realPathOf(cwd)
    const budget = { bytes: 0 }
    let userDir = null
    try { userDir = claudeConfigDir() } catch { userDir = null }

    const parsed = []
    for (const dir of ancestorsOf(realPath)) {
      const mcp = configFileEntry(join(dir, '.mcp.json'), budget)
      if (mcp) {
        entries.push(mcp)
        parsed.push({ entry: mcp, kind: 'mcp' })
      }
      const dotClaude = join(dir, '.claude')
      if (!isUserClaudeDir(dotClaude, userDir)) {
        const settings = configFileEntry(join(dotClaude, 'settings.json'), budget)
        if (settings) {
          entries.push(settings)
          parsed.push({ entry: settings, kind: 'settings' })
        }
      }
    }
    for (const sub of CONTENT_DIRS) {
      const found = []
      walkContentDir(join(realPath, '.claude', sub), found, budget, state)
      summary.counts[sub] = found.length
      entries.push(...found)
    }
    for (const { entry, kind } of parsed) {
      const doc = readJsonFile(entry.path, warnings)
      if (!doc) continue
      if (kind === 'mcp') summarizeMcpServers(entry.path, doc, summary)
      else summarizeSettings(entry.path, doc, summary)
    }
  } catch (err) {
    // The scan must never throw into a launch path. Report what was learned and
    // mark the result unusable for trust: an incomplete scan cannot be approved.
    warnings.push(`scan failed: ${err?.code || err?.message || 'error'}`)
    state.truncated = true
  }

  const files = entries.map(({ path, sha256 }) => ({ path, sha256 }))
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  summary.files = files.map((f) => f.path)
  return {
    realPath: realPath ?? resolve(cwd),
    files,
    digest: sha256Hex(canonicalJson(files)),
    summary,
    hasCommandBearingFiles: files.length > 0,
    truncated: state.truncated,
  }
}

// ── Store ────────────────────────────────────────────────────────────────

function isRecord(r) {
  return r && typeof r === 'object'
    && r.v === FOLDER_TRUST_RECORD_VERSION
    && typeof r.path === 'string' && r.path !== ''
    && typeof r.digest === 'string' && /^[0-9a-f]{64}$/.test(r.digest)
    && typeof r.trustedAt === 'string'
}

/** Read the store; a missing, corrupt or unknown-version file yields no records. */
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
      records.push({ v: r.v, path: r.path, digest: r.digest, trustedAt: r.trustedAt })
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

// ── Cache (the status line polls) ────────────────────────────────────────

const scanCache = new Map()

/** Drop every cached scan. Called on any trust change so it takes effect at once. */
export function invalidateFolderTrustCache() {
  scanCache.clear()
}

function scanCached(cwd, useCache) {
  const realPath = realPathOf(cwd)
  if (!useCache) return scanFolderSettings(cwd)
  const hit = scanCache.get(realPath)
  const now = Date.now()
  if (hit && now - hit.at <= SCAN_CACHE_TTL_MS) return hit.scan
  const scan = scanFolderSettings(cwd)
  scanCache.set(realPath, { at: now, scan })
  return scan
}

function stateFromScan(scan) {
  // An incomplete scan (too many files, or a scan error) can never be approved,
  // and never reads as "nothing to approve".
  if (scan.truncated) return { status: 'untrusted', scan }
  if (!scan.hasCommandBearingFiles) return { status: 'none', scan }
  const record = loadFolderTrustRecords().find((r) => r.path === scan.realPath)
  return { status: record && record.digest === scan.digest ? 'trusted' : 'untrusted', scan }
}

/**
 * The trust state of `cwd`: `none` (no command-bearing files), `trusted` (a
 * record matches the real path AND the current digest) or `untrusted`.
 *
 * @param {string} cwd
 * @param {{ cached?: boolean }} [opts] - `cached` reuses a scan up to 2 s old
 * @returns {{ status: 'none'|'trusted'|'untrusted', realPath: string, summary?: object }}
 */
export function getFolderTrustState(cwd, { cached = false } = {}) {
  const { status, scan } = stateFromScan(scanCached(cwd, cached))
  return {
    status,
    realPath: scan.realPath,
    ...(status === 'none' ? {} : { summary: scan.summary }),
  }
}

/**
 * True only when a record matches the current real path and digest.
 * @param {string} cwd
 * @param {{ cached?: boolean }} [opts]
 */
export function isFolderTrusted(cwd, { cached = false } = {}) {
  if (typeof cwd !== 'string' || cwd === '') return false
  return stateFromScan(scanCached(cwd, cached)).status === 'trusted'
}

/**
 * Record trust for the folder's CURRENT settings. Returns the new state, or
 * `{ ok: false, error }` when there is nothing to approve or the scan was
 * incomplete.
 *
 * @param {string} cwd
 * @returns {Promise<{ ok: boolean, status: string, realPath?: string, summary?: object, error?: string }>}
 */
export async function trustFolder(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return { ok: false, status: 'none', error: 'no folder' }
  const path = folderTrustStorePath()
  return withTrustStoreLock(path, async () => {
    const scan = scanFolderSettings(cwd)
    if (scan.truncated) {
      return { ok: false, status: 'untrusted', realPath: scan.realPath, summary: scan.summary, error: 'This folder could not be fully reviewed (too many files)' }
    }
    if (!scan.hasCommandBearingFiles) return { ok: true, status: 'none', realPath: scan.realPath }
    const records = loadFolderTrustRecords(path).filter((r) => r.path !== scan.realPath)
    records.push({ v: FOLDER_TRUST_RECORD_VERSION, path: scan.realPath, digest: scan.digest, trustedAt: new Date().toISOString() })
    try {
      saveFolderTrustRecords(records, path)
    } finally {
      invalidateFolderTrustCache()
    }
    return { ok: true, status: 'trusted', realPath: scan.realPath, summary: scan.summary }
  })
}

/**
 * Remove any trust record for the folder.
 * @param {string} cwd
 * @returns {Promise<{ ok: boolean, status: string, realPath?: string, summary?: object, error?: string }>}
 */
export async function untrustFolder(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return { ok: false, status: 'none', error: 'no folder' }
  const path = folderTrustStorePath()
  return withTrustStoreLock(path, async () => {
    const realPath = realPathOf(cwd)
    const before = loadFolderTrustRecords(path)
    const after = before.filter((r) => r.path !== realPath)
    try {
      if (after.length !== before.length) saveFolderTrustRecords(after, path)
    } finally {
      invalidateFolderTrustCache()
    }
    const { status, summary } = getFolderTrustState(cwd)
    return { ok: true, status, realPath, ...(summary ? { summary } : {}) }
  })
}
