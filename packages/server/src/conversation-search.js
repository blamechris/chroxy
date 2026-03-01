import { readdir, stat, readFile, open } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'
import { decodeProjectPath } from './jsonl-reader.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const MIN_FILE_SIZE = 100
const CONCURRENCY = 10
const MAX_FILE_READ = 512 * 1024 // read up to 512KB per file for search
const DEFAULT_MAX_RESULTS = 50

/**
 * Extract searchable text from a JSONL entry.
 * Returns a plain string combining all readable text content.
 */
export function extractSearchableText(entry) {
  if (!entry || !entry.type) return ''

  const parts = []

  if (entry.message?.content) {
    const content = entry.message.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text)
        }
      }
    }
  }

  return parts.join(' ')
}

/**
 * Search a single JSONL conversation file for a query string.
 * Returns null if no match, or a result object if found.
 */
async function searchFile(filePath, queryLower, conversationId, projectName, decodedPath) {
  let text
  try {
    const fileStat = await stat(filePath)
    if (fileStat.size < MIN_FILE_SIZE) return null

    // Read file content (capped at MAX_FILE_READ)
    if (fileStat.size <= MAX_FILE_READ) {
      text = await readFile(filePath, 'utf-8')
    } else {
      const buf = Buffer.alloc(MAX_FILE_READ)
      const handle = await open(filePath, 'r')
      try {
        const { bytesRead } = await handle.read(buf, 0, MAX_FILE_READ, 0)
        const decoder = new TextDecoder('utf-8', { fatal: false })
        text = decoder.decode(buf.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    }
  } catch {
    return null
  }

  const lines = text.split('\n')
  let matchCount = 0
  let firstSnippet = null
  let cwd = null
  let preview = null

  for (const line of lines) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    // Extract CWD from first entry that has it
    if (!cwd && entry.cwd) {
      cwd = entry.cwd
    }

    // Extract preview from first user message
    if (!preview && entry.type === 'user') {
      const content = entry.message?.content
      if (typeof content === 'string') {
        preview = content.slice(0, 200)
      } else if (Array.isArray(content)) {
        const hasToolResult = content.some((b) => b.type === 'tool_result')
        if (!hasToolResult) {
          const textParts = content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
          if (textParts) preview = textParts.slice(0, 200)
        }
      }
    }

    const searchable = extractSearchableText(entry)
    if (!searchable) continue

    const lower = searchable.toLowerCase()
    const idx = lower.indexOf(queryLower)
    if (idx === -1) continue

    matchCount++
    if (!firstSnippet) {
      // Extract snippet with context around the match
      const start = Math.max(0, idx - 40)
      const end = Math.min(searchable.length, idx + queryLower.length + 60)
      firstSnippet = (start > 0 ? '...' : '') +
        searchable.slice(start, end).trim() +
        (end < searchable.length ? '...' : '')
    }
  }

  if (matchCount === 0) return null

  return {
    conversationId,
    projectName: cwd ? basename(cwd) : projectName,
    project: cwd || decodedPath,
    cwd,
    preview,
    snippet: firstSnippet,
    matchCount,
  }
}

/**
 * Run async tasks with a concurrency limit.
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

/**
 * Search all conversation JSONL files for a query string.
 * Returns an array of results with conversation metadata and match snippets.
 *
 * @param {string} query - Search query (case-insensitive substring match)
 * @param {Object} [opts] - Options
 * @param {string} [opts.projectsDir] - Root directory to scan
 * @param {number} [opts.maxResults] - Maximum results to return (default 50)
 * @returns {Promise<Array<{
 *   conversationId: string,
 *   projectName: string,
 *   project: string|null,
 *   cwd: string|null,
 *   preview: string|null,
 *   snippet: string,
 *   matchCount: number,
 * }>>}
 */
export async function searchConversations(query, opts = {}) {
  const trimmed = (query || '').trim()
  if (!trimmed) return []

  const queryLower = trimmed.toLowerCase()
  const projectsDir = opts.projectsDir || PROJECTS_DIR
  const maxResults = opts.maxResults || DEFAULT_MAX_RESULTS

  // Collect all JSONL files across projects
  let projectDirs
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

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

    for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
      candidates.push({
        filePath: join(dirPath, file),
        conversationId: file.replace('.jsonl', ''),
        decodedPath,
        projectName,
      })
    }
  }

  // Search files in parallel
  const tasks = candidates.map((c) => () =>
    searchFile(c.filePath, queryLower, c.conversationId, c.projectName, c.decodedPath)
  )

  const results = await runWithConcurrency(tasks, CONCURRENCY)
  const matches = results.filter(Boolean)

  // Sort by match count descending, then by project name, then conversationId
  matches.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
    const nameCmp = a.projectName.localeCompare(b.projectName)
    if (nameCmp !== 0) return nameCmp
    return a.conversationId.localeCompare(b.conversationId)
  })

  return matches.slice(0, maxResults)
}
