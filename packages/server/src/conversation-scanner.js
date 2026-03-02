import { readdir, stat, open } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'
import { decodeProjectPath } from './jsonl-reader.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PREVIEW_BYTES = 32 * 1024 // read first 32KB for preview extraction
const MIN_FILE_SIZE = 100       // skip tiny/empty files
const CONCURRENCY = 15          // max parallel file reads
const CACHE_TTL_MS = 5000       // cache results for 5 seconds

// Simple TTL cache keyed by projectsDir
let _cache = null
let _cacheKey = null
let _cacheTime = 0
let _pendingScan = null

/**
 * Clear the scan results cache. Useful for testing or forcing a fresh scan.
 */
export function clearScanCache() {
  _cache = null
  _cacheKey = null
  _cacheTime = 0
  _pendingScan = null
}

/**
 * Extract a preview (first user message text) and CWD from the beginning of a JSONL file.
 * Only reads the first 32KB to stay fast on large files.
 *
 * @returns {{ preview: string|null, cwd: string|null }}
 */
async function extractMetadata(filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const buf = Buffer.alloc(PREVIEW_BYTES)
    const { bytesRead } = await handle.read(buf, 0, PREVIEW_BYTES, 0)
    // Use TextDecoder with stream: true to avoid replacement characters
    // when the read boundary splits a multi-byte UTF-8 character
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const text = decoder.decode(buf.subarray(0, bytesRead), { stream: true })
    const lines = text.split('\n')

    let preview = null
    let cwd = null

    for (const line of lines) {
      if (!line) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }

      // Extract CWD from the first user entry that has it
      if (!cwd && entry.cwd) {
        cwd = entry.cwd
      }

      // Extract preview from first real user message
      if (!preview && entry.type === 'user') {
        const content = entry.message?.content

        // Handle string content (older format)
        if (typeof content === 'string') {
          preview = content.slice(0, 200)
        } else if (Array.isArray(content)) {
          const hasToolResult = content.some((b) => b.type === 'tool_result')
          if (!hasToolResult) {
            const textParts = content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')

            if (textParts) {
              preview = textParts.slice(0, 200)
            }
          }
        }
      }

      if (preview && cwd) break
    }

    return { preview, cwd }
  } catch {
    return { preview: null, cwd: null }
  } finally {
    if (handle) await handle.close()
  }
}

/**
 * Run async tasks with a concurrency limit.
 * @param {Array<() => Promise>} tasks - Array of thunks returning promises
 * @param {number} limit - Max concurrent tasks
 * @returns {Promise<Array>} Results in order
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      results[idx] = await tasks[idx]()
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
  await Promise.all(workers)
  return results
}

async function performScan(projectsDir) {
  let projectDirs
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  // Collect all file candidates across projects
  const candidates = []

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue

    const encodedName = dir.name
    const decodedPath = decodeProjectPath(encodedName)
    const projectName = decodedPath ? basename(decodedPath) : encodedName

    const dirPath = join(projectsDir, encodedName)
    let files
    try {
      files = await readdir(dirPath)
    } catch {
      continue
    }

    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))

    for (const file of jsonlFiles) {
      candidates.push({
        filePath: join(dirPath, file),
        conversationId: file.replace('.jsonl', ''),
        decodedPath,
        projectName,
      })
    }
  }

  // Process files in parallel with concurrency limit
  const tasks = candidates.map((c) => async () => {
    let fileStat
    try {
      fileStat = await stat(c.filePath)
    } catch {
      return null
    }

    if (fileStat.size < MIN_FILE_SIZE) return null

    const { preview, cwd } = await extractMetadata(c.filePath)

    return {
      conversationId: c.conversationId,
      project: cwd || c.decodedPath,
      projectName: cwd ? basename(cwd) : c.projectName,
      modifiedAt: fileStat.mtime.toISOString(),
      modifiedAtMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size,
      preview,
      cwd,
    }
  })

  const results = await runWithConcurrency(tasks, CONCURRENCY)
  const conversations = results.filter(Boolean)

  conversations.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
  return conversations
}

/**
 * Scan ~/.claude/projects/ for JSONL conversation files.
 * Returns metadata for each conversation, sorted by most recently modified.
 * Results are cached for 5 seconds to avoid redundant scans.
 *
 * @param {Object} [opts] - Options controlling the scan behavior.
 * @param {string} [opts.projectsDir] - Root directory to scan. Defaults to the Claude projects directory.
 * @param {number} [opts.maxResults] - Maximum number of conversations to return. If 0 or omitted, returns all conversations.
 * @returns {Promise<Array<{
 *   conversationId: string,
 *   project: string|null,
 *   projectName: string,
 *   modifiedAt: string,
 *   modifiedAtMs: number,
 *   sizeBytes: number,
 *   preview: string|null,
 *   cwd: string|null,
 * }>>}
 */
/**
 * Group conversations by their project path (repo).
 * Returns an array of unique repos sorted by most recent activity.
 *
 * @param {Array<{ project: string|null, projectName: string, modifiedAtMs: number }>} conversations
 * @returns {Array<{ path: string, name: string, lastActivityAt: number }>}
 */
export function groupConversationsByRepo(conversations) {
  const repoMap = new Map()

  for (const conv of conversations) {
    if (!conv.project) continue

    const existing = repoMap.get(conv.project)
    if (!existing || conv.modifiedAtMs > existing.lastActivityAt) {
      repoMap.set(conv.project, {
        path: conv.project,
        name: conv.projectName,
        lastActivityAt: conv.modifiedAtMs,
      })
    }
  }

  return [...repoMap.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}

export async function scanConversations(opts = {}) {
  const projectsDir = opts.projectsDir || PROJECTS_DIR
  const maxResults = Math.max(0, Math.floor(opts.maxResults || 0))

  // Check cache
  const now = Date.now()
  if (_cache && _cacheKey === projectsDir && (now - _cacheTime) < CACHE_TTL_MS) {
    return maxResults > 0 ? _cache.slice(0, maxResults) : [..._cache]
  }

  // Deduplicate concurrent scans — subsequent callers wait for the first scan
  if (_pendingScan) {
    const conversations = await _pendingScan
    return maxResults > 0 ? conversations.slice(0, maxResults) : [...conversations]
  }

  _pendingScan = performScan(projectsDir)
  let conversations
  try {
    conversations = await _pendingScan
  } finally {
    _pendingScan = null
  }

  // Update cache
  _cache = conversations
  _cacheKey = projectsDir
  _cacheTime = Date.now()

  return maxResults > 0 ? conversations.slice(0, maxResults) : [...conversations]
}
