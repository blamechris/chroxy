import { readFileSync, statSync, existsSync, openSync, readSync, closeSync, fstatSync } from 'fs'
import { readFile, stat, open } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const MAX_MESSAGES = 500

// Byte ceiling for a single transcript read. The wire replay is capped at
// MAX_MESSAGES frames, but the file read itself was previously unbounded — a
// caller (including a bound client via the read-only transcript endpoint, #6860)
// could trigger a full-file buffer of an arbitrarily large JSONL. Files larger
// than this are read from the TAIL only (most-recent activity), so the result is
// gracefully truncated to recent history rather than crashing or buffering the
// whole file. 25MB comfortably fits even long real transcripts while bounding
// worst-case memory. Overridable per-call for tests.
export const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024

/**
 * Encode a filesystem path the same way Claude Code does for its project directories.
 * Replaces all `/` with `-`.
 * e.g. '/Users/alice/projects/myrepo' -> '-Users-alice-projects-myrepo'
 */
export function encodeProjectPath(cwd) {
  return cwd.replace(/\//g, '-')
}

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
 * Resolve the JSONL file path for a conversation.
 * @param {string} cwd - Working directory the conversation was started in
 * @param {string} conversationId - UUID of the conversation
 * @returns {string} Absolute path to the JSONL file
 */
export function resolveJsonlPath(cwd, conversationId) {
  const encoded = encodeProjectPath(cwd)
  return join(homedir(), '.claude', 'projects', encoded, `${conversationId}.jsonl`)
}

/**
 * Get the modification time of a JSONL file.
 * @param {string} filePath - Absolute path to the JSONL file
 * @returns {number|null} mtime in ms since epoch, or null if file doesn't exist
 */
export function getJsonlMtime(filePath) {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

/**
 * Parse raw JSONL text into Chroxy message format.
 * Shared by both sync and async readers.
 */
function parseJsonlContent(raw) {
  const lines = raw.split('\n').filter(Boolean)
  const messages = []

  for (const line of lines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue // skip malformed lines
    }

    // Skip non-message entries
    if (entry.type === 'queue-operation' || entry.type === 'file-history-snapshot') {
      continue
    }

    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now()
    const messageId = entry.uuid || null

    if (entry.type === 'user') {
      // Extract text from user message content blocks
      const content = entry.message?.content
      if (!Array.isArray(content)) continue

      // Skip tool_result entries (they're part of tool flow, not user text)
      const hasToolResult = content.some(b => b.type === 'tool_result')
      if (hasToolResult) continue

      const textParts = content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')

      if (textParts) {
        messages.push({
          type: 'user_input',
          content: textParts,
          timestamp,
          messageId,
        })
      }
    } else if (entry.type === 'assistant') {
      const content = entry.message?.content
      if (!Array.isArray(content)) continue

      // Process each content block
      const textParts = []
      const toolUses = []

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolUses.push(block)
        }
      }

      // Emit text response if any
      if (textParts.length > 0) {
        messages.push({
          type: 'response',
          content: textParts.join('\n'),
          timestamp,
          messageId,
        })
      }

      // Emit tool uses
      for (const tool of toolUses) {
        messages.push({
          type: 'tool_use',
          tool: tool.name || 'unknown',
          content: tool.input ? JSON.stringify(tool.input) : '',
          timestamp,
          messageId: tool.id || messageId,
        })
      }
    }
  }

  // Cap at MAX_MESSAGES most recent
  if (messages.length > MAX_MESSAGES) {
    return messages.slice(-MAX_MESSAGES)
  }

  return messages
}

/**
 * Read a Claude Code conversation JSONL file and convert entries to Chroxy's message format.
 *
 * JSONL entry types:
 *   - type: "user" with message.content[].type === "text" -> { type: 'user_input', content }
 *   - type: "assistant" with text blocks -> { type: 'response', content }
 *   - type: "assistant" with tool_use blocks -> { type: 'tool_use', tool, content }
 *   - type: "queue-operation", "file-history-snapshot" -> skipped
 *   - type: "user" with tool_result content -> skipped (displayed as part of tool flow)
 *
 * @param {string} filePath - Absolute path to the JSONL file
 * @returns {Array<{ type: string, content: string, tool?: string, timestamp: number, messageId?: string }>}
 */
export function readConversationHistory(filePath, maxBytes = MAX_TRANSCRIPT_BYTES) {
  let raw
  try {
    const { size } = statSync(filePath)
    raw = size > maxBytes
      ? readTailBytesSync(filePath, maxBytes)
      : readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  return parseJsonlContent(raw)
}

/**
 * Read the last `maxBytes` of a file (sync). Used when a JSONL exceeds the
 * transcript byte ceiling so the read stays bounded. The window's first line is
 * usually a partial JSONL record; parseJsonlContent skips unparseable lines, so
 * the truncated head is dropped automatically.
 */
function readTailBytesSync(filePath, maxBytes) {
  const fd = openSync(filePath, 'r')
  try {
    const { size } = fstatSync(fd)
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, start)
    return new TextDecoder('utf-8', { fatal: false }).decode(buf)
  } finally {
    closeSync(fd)
  }
}

/**
 * Async variant of readConversationHistory.
 * Uses fs.promises.readFile to avoid blocking the event loop for large JSONL files.
 *
 * @param {string} filePath - Absolute path to the JSONL file
 * @returns {Promise<Array<{ type: string, content: string, tool?: string, timestamp: number, messageId?: string }>>}
 */
export async function readConversationHistoryAsync(filePath, maxBytes = MAX_TRANSCRIPT_BYTES) {
  let raw
  try {
    const { size } = await stat(filePath)
    raw = size > maxBytes
      ? await readTailBytesAsync(filePath, maxBytes)
      : await readFile(filePath, 'utf-8')
  } catch {
    return []
  }

  return parseJsonlContent(raw)
}

/**
 * Async variant of readTailBytesSync — read the last `maxBytes` of a file so an
 * oversized transcript read stays bounded (see MAX_TRANSCRIPT_BYTES).
 */
async function readTailBytesAsync(filePath, maxBytes) {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, start)
    return new TextDecoder('utf-8', { fatal: false }).decode(buf)
  } finally {
    await handle.close()
  }
}
