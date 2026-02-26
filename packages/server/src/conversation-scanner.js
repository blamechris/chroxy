import { readdir, stat, open } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PREVIEW_BYTES = 32 * 1024 // read first 32KB for preview extraction
const MIN_FILE_SIZE = 100       // skip tiny/empty files

/**
 * Decode an encoded project directory name back to a filesystem path.
 * Claude Code encodes paths by replacing all `/` with `-`.
 * Falls back to null if the decoded path doesn't exist on disk.
 */
export function decodeProjectPath(encoded) {
  const decoded = encoded.replace(/-/g, '/')
  try {
    if (existsSync(decoded) && statSync(decoded).isDirectory()) return decoded
  } catch { /* path doesn't exist */ }
  return null
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
    const text = buf.toString('utf-8', 0, bytesRead)
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
          continue
        }

        if (!Array.isArray(content)) continue
        const hasToolResult = content.some((b) => b.type === 'tool_result')
        if (hasToolResult) continue

        const textParts = content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')

        if (textParts) {
          preview = textParts.slice(0, 200)
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
 * Scan ~/.claude/projects/ for JSONL conversation files.
 * Returns metadata for each conversation, sorted by most recently modified.
 *
 * @param {{ projectsDir?: string }} [opts] - Override projects dir (for testing)
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
export async function scanConversations(opts = {}) {
  const projectsDir = opts.projectsDir || PROJECTS_DIR

  let projectDirs
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const conversations = []

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
      const filePath = join(dirPath, file)
      const conversationId = file.replace('.jsonl', '')

      let fileStat
      try {
        fileStat = await stat(filePath)
      } catch {
        continue
      }

      if (fileStat.size < MIN_FILE_SIZE) continue

      const { preview, cwd } = await extractMetadata(filePath)

      conversations.push({
        conversationId,
        project: cwd || decodedPath,
        projectName: cwd ? basename(cwd) : projectName,
        modifiedAt: fileStat.mtime.toISOString(),
        modifiedAtMs: fileStat.mtimeMs,
        sizeBytes: fileStat.size,
        preview,
        cwd,
      })
    }
  }

  conversations.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
  return conversations
}
