import { statSync, existsSync } from 'fs'
import { readFile, stat, open } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

// Wire cap for a transcript read: the MOST RECENT 500 parsed messages. This is
// the JSONL path's OWN truncation, entirely separate from the ring buffer's
// (#7484) — a caller that reports `isHistoryTruncated()` alongside a JSONL slice
// is describing a collection it never sent. Exported so callers and tests name
// the same number instead of re-deriving it.
export const MAX_MESSAGES = 500

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
 *
 * Returns the parsed slice ALONGSIDE whether content was dropped to produce it
 * (#7484). Two independent things can drop content, and a caller cannot infer
 * either from the returned array: the `MAX_MESSAGES` message cap here, and the
 * `MAX_TRANSCRIPT_BYTES` tail read the caller may already have performed
 * (`byteTruncated`). Both mean "the client is not seeing the whole
 * conversation", which is exactly what `truncated` on the wire claims to say.
 *
 * @param {string} raw
 * @param {{ byteTruncated?: boolean }} [opts]
 * @returns {{ messages: Array<object>, truncated: boolean }}
 */
function parseJsonlContent(raw, { byteTruncated = false } = {}) {
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

  // Cap at MAX_MESSAGES most recent. The cap TRIPPING is the JSONL path's own
  // truncation signal — reported, never inferred: 500 returned messages is
  // equally the shape of a 500-message transcript that lost nothing.
  const capped = messages.length > MAX_MESSAGES
  return {
    messages: capped ? messages.slice(-MAX_MESSAGES) : messages,
    truncated: byteTruncated || capped,
  }
}

/**
 * The ONE transcript reader (#7484/#7520): returns { messages, truncated } so
 * a caller can report the slice's own truncation. The sync and array-returning
 * variants were removed in #7520 — the array shape structurally cannot report
 * truncation, which is the false-safety footgun this file used to carry.
 *
 * @param {string} filePath - Absolute path to the JSONL file
 * @param {number} [maxBytes]
 * @returns {Promise<{ messages: Array<object>, truncated: boolean }>}
 */
export async function readConversationHistoryWithMetaAsync(filePath, maxBytes = MAX_TRANSCRIPT_BYTES) {
  let raw
  let byteTruncated = false
  try {
    const { size } = await stat(filePath)
    byteTruncated = size > maxBytes
    raw = byteTruncated
      ? await readTailBytesAsync(filePath, maxBytes)
      : await readFile(filePath, 'utf-8')
  } catch {
    return { messages: [], truncated: false }
  }

  return parseJsonlContent(raw, { byteTruncated })
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
